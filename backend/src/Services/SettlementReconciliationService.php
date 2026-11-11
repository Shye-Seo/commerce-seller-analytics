<?php

declare(strict_types=1);

namespace SellerScope\Services;

use SellerScope\Domain\Anomaly;
use SellerScope\Domain\AnomalyType;
use SellerScope\Domain\ContractTerms;
use SellerScope\Domain\MarketChannel;
use SellerScope\Domain\Money;
use SellerScope\Domain\OrderStatus;
use SellerScope\Domain\ReconciledRow;
use SellerScope\Domain\ReconciliationResult;
use SellerScope\Domain\ReconciliationSummary;
use SellerScope\Domain\SettlementRow;

/**
 * 정산 대사 · 이상 탐지 엔진 (서버 구현)
 *
 * 프론트엔드의 reconciliationEngine.ts와 **같은 규칙**을 PHP로 옮긴 것이다.
 * 왜 서버에 한 번 더 구현했나
 *   · 화면 대사는 "내가 올린 파일"만 본다. 운영에서는 매일 밤 마켓 4~5곳의 정산서가
 *     자동으로 들어오고, 100만 행을 배치로 다시 계산해 결과를 DB에 남겨야 한다.
 *     브라우저 탭이 닫히면 사라지는 계산은 감사 대상이 될 수 없다.
 *   · 파싱(브라우저)과 판정(서버)을 분리하면, 같은 규칙을 두 언어로 유지해야 한다는
 *     부담이 생긴다. 그래서 판정 규칙을 문서(ERD_SPEC.md §5)와 테스트 케이스로 고정하고,
 *     두 구현이 같은 픽스처에 대해 같은 금액을 내는지를 회귀 테스트로 지킨다.
 *
 * 손실 귀속 알고리즘(프론트와 동일)
 *   1. 계약 기준 기대 정산액을 재계산한다.
 *   2. shortfall = max(0, 기대 - 실제). 그 행에서 잃은 돈의 상한.
 *   3. 원인별 후보 금액(취소건 수수료·반품비 중복·수수료 초과·배송비 초과)을 계산한다.
 *   4. 우선순위대로 shortfall에서 차감 배정한다. 배정 합계는 shortfall을 넘지 않는다.
 *   5. 남은 금액이 10원을 넘으면 SETTLEMENT_SHORTFALL, 10원 이하면 ROUNDING_LEAK.
 * 이 순서 덕분에 원인별 금액의 합이 부족분과 맞아떨어지고, 같은 돈을 두 번 세지 않는다.
 */
final class SettlementReconciliationService
{
    private const ROUNDING_TOLERANCE = 10;

    /** @var array<string, ContractTerms> */
    private array $contracts;

    private readonly bool $customContracts;

    /**
     * @param array<string, ContractTerms>|null $contracts 채널 => 계약. null이면 프리셋 사용
     */
    public function __construct(?array $contracts = null)
    {
        $this->customContracts = $contracts !== null;
        $this->contracts = $contracts ?? self::presetContracts();
    }

    /** @return array<string, ContractTerms> */
    public static function presetContracts(): array
    {
        $map = [];
        foreach (MarketChannel::cases() as $channel) {
            $map[$channel->value] = $channel->presetContract();
        }

        return $map;
    }

    /**
     * 한 행을 대사한다.
     *
     * 계약 해석 순서: 생성자 주입 계약 → 채널 프리셋, 그 위에 행에 박힌 계약 요율 스냅샷을
     * 덮어쓴다(재계약 후 과거 정산서를 다시 대사해도 결과가 흔들리지 않게).
     */
    public function reconcileRow(SettlementRow $row): ReconciledRow
    {
        $base = $this->contracts[$row->channel->value] ?? $row->channel->presetContract();
        $contract = $base->withFeeRateSnapshot($row->contractFeeRate);

        $quantity = max(1, $row->quantity);
        $revenue = $row->recognizedRevenue();

        $expectedCommission = Money::round(($revenue * $contract->feeRate) / 100);
        $expectedShippingDeduction = $revenue === 0 ? 0 : $contract->outboundShipping;
        $expectedReturnFee = $row->status->expectsReturnFee() ? $contract->roundTripReturnFee : 0;

        $expectedSettlement = $revenue - $expectedCommission - $expectedShippingDeduction - $expectedReturnFee;
        $actualSettlement = Money::round($row->settledAmount);

        $variance = $actualSettlement - $expectedSettlement;
        $shortfall = $variance < 0 ? -$variance : 0;
        $surplus = $variance > 0 ? $variance : 0;

        /** @var list<Anomaly> $anomalies */
        $anomalies = [];
        /** @var list<array{type:AnomalyType,amount:int,expected:int,actual:int,detail:string}> $candidates */
        $candidates = [];

        // 1) 수수료: 계약 요율 대비 청구액. 1%(최소 100원)는 반올림·프로모션 오차로 인정한다.
        $commissionTolerance = max(100, Money::round($expectedCommission * 0.01));
        $commissionDiff = Money::round($row->commission) - $expectedCommission;

        if ($commissionDiff > $commissionTolerance) {
            $candidates[] = [
                'type' => AnomalyType::FeeOvercharge,
                'amount' => $commissionDiff,
                'expected' => $expectedCommission,
                'actual' => Money::round($row->commission),
                'detail' => sprintf(
                    '계약 %s%% 기준 %s이어야 하는데 %s이 청구됐습니다(실효 %s%%).',
                    self::trimRate($contract->feeRate),
                    Money::format($expectedCommission),
                    Money::format(Money::round($row->commission)),
                    self::trimRate(Money::rate($row->commission, $revenue > 0 ? $revenue : max(1, $row->paidAmount))),
                ),
            ];
        } elseif ($commissionDiff < -$commissionTolerance) {
            $anomalies[] = new Anomaly(
                AnomalyType::FeeUndercharge,
                $expectedCommission,
                Money::round($row->commission),
                0,
                sprintf(
                    '계약 수수료보다 %s 적게 청구됐습니다. 소급 청구 가능성이 있습니다.',
                    Money::format(abs($commissionDiff)),
                ),
            );
        }

        // 2) 취소 건에 수수료가 붙은 경우 — 근거가 가장 명백한 부당 청구.
        if ($row->status === OrderStatus::Canceled && Money::round($row->commission) > 0) {
            $candidates[] = [
                'type' => AnomalyType::FeeOnCanceledOrder,
                'amount' => Money::round($row->commission),
                'expected' => 0,
                'actual' => Money::round($row->commission),
                'detail' => sprintf('취소 주문인데 수수료 %s이 청구됐습니다.', Money::format(Money::round($row->commission))),
            ];
        }

        // 3) 배송비 초과 차감(매출이 인식된 주문만)
        if ($revenue > 0) {
            $shippingOver = Money::round($row->shippingDeduction) - $expectedShippingDeduction;
            if ($shippingOver > 0) {
                $candidates[] = [
                    'type' => AnomalyType::ShippingOvercharge,
                    'amount' => $shippingOver,
                    'expected' => $expectedShippingDeduction,
                    'actual' => Money::round($row->shippingDeduction),
                    'detail' => sprintf(
                        '계약 배송비 %s보다 %s 더 차감됐습니다.',
                        Money::format($expectedShippingDeduction),
                        Money::format($shippingOver),
                    ),
                ];
            }
        }

        // 4) 반품비 중복 차감 / 배송완료 건 반품비
        $actualReturnFee = Money::round($row->returnFee);
        if ($row->status === OrderStatus::Returned && $actualReturnFee > $contract->roundTripReturnFee) {
            $over = $actualReturnFee - $contract->roundTripReturnFee;
            $candidates[] = [
                'type' => AnomalyType::ReturnFeeDoubleCharged,
                'amount' => $over,
                'expected' => $contract->roundTripReturnFee,
                'actual' => $actualReturnFee,
                'detail' => sprintf(
                    '반품 왕복 배송비 기준 %s인데 %s이 차감됐습니다(중복 차감 %s).',
                    Money::format($contract->roundTripReturnFee),
                    Money::format($actualReturnFee),
                    Money::format($over),
                ),
            ];
        }
        if ($row->status === OrderStatus::Shipped && $actualReturnFee > 0) {
            $candidates[] = [
                'type' => AnomalyType::ReturnFeeOnShippedOrder,
                'amount' => $actualReturnFee,
                'expected' => 0,
                'actual' => $actualReturnFee,
                'detail' => sprintf(
                    '반품되지 않은 배송완료 주문에 반품비 %s이 차감됐습니다.',
                    Money::format($actualReturnFee),
                ),
            ];
        }

        // 5) shortfall에 원인별 금액을 우선순위대로 배정한다.
        $remaining = $shortfall;
        usort(
            $candidates,
            static fn (array $a, array $b): int => $a['type']->priority() <=> $b['type']->priority(),
        );

        foreach ($candidates as $candidate) {
            $attributed = min($candidate['amount'], $remaining);
            $remaining -= $attributed;
            $anomalies[] = new Anomaly(
                $candidate['type'],
                $candidate['expected'],
                $candidate['actual'],
                $attributed,
                $candidate['detail'],
            );
        }

        // 6) 남은 차액: 10원 초과는 설명 불가 부족, 이하는 반올림 누수
        if ($remaining > self::ROUNDING_TOLERANCE) {
            $anomalies[] = new Anomaly(
                AnomalyType::SettlementShortfall,
                $expectedSettlement,
                $actualSettlement,
                $remaining,
                sprintf(
                    '수수료·배송·반품 항목으로 설명되지 않는 %s이 부족합니다.',
                    Money::format($remaining),
                ),
            );
        } elseif ($remaining > 0) {
            $anomalies[] = new Anomaly(
                AnomalyType::RoundingLeak,
                $expectedSettlement,
                $actualSettlement,
                $remaining,
                sprintf('반올림 차이 %s이 발생했습니다.', Money::format($remaining)),
            );
        }
        if ($surplus > self::ROUNDING_TOLERANCE) {
            $anomalies[] = new Anomaly(
                AnomalyType::SettlementSurplus,
                $expectedSettlement,
                $actualSettlement,
                0,
                sprintf(
                    '기대 정산액보다 %s 많이 입금됐습니다. 다음 정산에서 차감될 수 있습니다.',
                    Money::format($surplus),
                ),
            );
        }

        // 7) 실효 마진 — 원가·실배송원가를 뺀 실제 남는 돈
        $netMargin = Money::round($actualSettlement - $row->unitCost * $quantity - $row->sellerShippingCost);
        $marginRate = Money::rate($netMargin, max(1, $row->paidAmount));

        if ($row->unitCost <= 0) {
            $anomalies[] = new Anomaly(
                AnomalyType::MissingLedger,
                1,
                0,
                0,
                '매입원가가 0으로 기록돼 마진을 검증할 수 없습니다.',
            );
        } elseif ($row->status === OrderStatus::Shipped && $netMargin < 0) {
            $anomalies[] = new Anomaly(
                AnomalyType::NegativeMargin,
                0,
                $netMargin,
                0, // 손실은 이미 shortfall로 집계되므로 중복 계산하지 않는다.
                sprintf(
                    '정산액 %s - 원가·배송 %s = %s(마진율 %s%%).',
                    Money::format($actualSettlement),
                    Money::format($row->unitCost * $quantity + $row->sellerShippingCost),
                    Money::format($netMargin),
                    self::trimRate($marginRate),
                ),
            );
        }

        return new ReconciledRow(
            row: $row,
            contract: $contract,
            expectedCommission: $expectedCommission,
            expectedShippingDeduction: $expectedShippingDeduction,
            expectedReturnFee: $expectedReturnFee,
            expectedSettlement: $expectedSettlement,
            actualSettlement: $actualSettlement,
            variance: $variance,
            shortfall: $shortfall,
            surplus: $surplus,
            effectiveFeeRate: Money::rate($row->commission, max(1, $row->paidAmount)),
            netMargin: $netMargin,
            marginRate: $marginRate,
            anomalies: $anomalies,
            loss: $shortfall,
        );
    }

    /**
     * @param iterable<SettlementRow> $rows
     */
    public function reconcileAll(
        iterable $rows,
        int $parseErrorCount = 0,
        ?int $sourceRowCount = null,
        int $elapsedMs = 0,
    ): ReconciliationResult {
        $reconciled = [];
        $count = 0;
        foreach ($rows as $row) {
            $reconciled[] = $this->reconcileRow($row);
            $count++;
        }

        return new ReconciliationResult(
            rows: $reconciled,
            summary: $this->summarize($reconciled),
            parseErrorCount: $parseErrorCount,
            sourceRowCount: $sourceRowCount ?? $count,
            elapsedMs: $elapsedMs,
            customContract: $this->customContracts,
        );
    }

    /**
     * @param list<ReconciledRow> $rows
     */
    public function summarize(array $rows): ReconciliationSummary
    {
        $counts = [];
        $losses = [];
        foreach (AnomalyType::cases() as $type) {
            $counts[$type->value] = 0;
            $losses[$type->value] = 0;
        }

        $channels = [];
        $skus = [];
        $totalPaid = 0;
        $totalCommission = 0;
        $totalSettled = 0;
        $totalExpected = 0;
        $totalLeak = 0;
        $totalSurplus = 0;
        $marginRisk = 0;
        $negativeMarginRows = 0;
        $matchedRows = 0;
        $worstMarginRate = 0.0;

        foreach ($rows as $item) {
            $row = $item->row;
            $totalPaid += $row->paidAmount;
            $totalCommission += $row->commission;
            $totalSettled += $item->actualSettlement;
            $totalExpected += $item->expectedSettlement;
            $totalLeak += $item->loss;
            $totalSurplus += $item->surplus;

            if ($item->isReconciled()) {
                $matchedRows++;
            }
            foreach ($item->anomalies as $anomaly) {
                $counts[$anomaly->type->value]++;
                $losses[$anomaly->type->value] += $anomaly->loss;
            }

            if ($row->status === OrderStatus::Shipped && $row->unitCost > 0 && $item->netMargin < 0) {
                $negativeMarginRows++;
                $marginRisk += -$item->netMargin;
                if ($item->marginRate < $worstMarginRate) {
                    $worstMarginRate = $item->marginRate;
                }
            }

            $channelKey = $row->channel->value;
            if (!isset($channels[$channelKey])) {
                $channels[$channelKey] = [
                    'channel' => $channelKey,
                    'rows' => 0,
                    'paidAmount' => 0,
                    'settledAmount' => 0,
                    'leak' => 0,
                    'flaggedRows' => 0,
                ];
            }
            $channels[$channelKey]['rows']++;
            $channels[$channelKey]['paidAmount'] += $row->paidAmount;
            $channels[$channelKey]['settledAmount'] += $item->actualSettlement;
            $channels[$channelKey]['leak'] += $item->loss;
            if (!$item->isReconciled()) {
                $channels[$channelKey]['flaggedRows']++;
            }

            if (!$item->isReconciled()) {
                $skuKey = $row->sku;
                if (!isset($skus[$skuKey])) {
                    $skus[$skuKey] = ['sku' => $row->sku, 'productName' => $row->productName, 'rows' => 0, 'loss' => 0];
                }
                $skus[$skuKey]['rows']++;
                $skus[$skuKey]['loss'] += $item->loss;
            }
        }

        $channelList = array_values($channels);
        usort($channelList, static fn (array $a, array $b): int => $b['paidAmount'] <=> $a['paidAmount']);

        $skuList = array_values($skus);
        usort($skuList, static fn (array $a, array $b): int => $b['loss'] <=> $a['loss']);
        $skuList = array_slice($skuList, 0, 5);

        $totalRows = count($rows);

        return new ReconciliationSummary(
            totalRows: $totalRows,
            matchedRows: $matchedRows,
            flaggedRows: $totalRows - $matchedRows,
            matchedRate: Money::rate($matchedRows, max(1, $totalRows)),
            totalPaidAmount: $totalPaid,
            totalCommission: $totalCommission,
            totalSettledAmount: $totalSettled,
            expectedSettlement: $totalExpected,
            totalLeak: $totalLeak,
            totalSurplus: $totalSurplus,
            marginRiskExposure: $marginRisk,
            negativeMarginRows: $negativeMarginRows,
            anomalyCounts: $counts,
            anomalyLoss: $losses,
            byChannel: $channelList,
            topSkusByLoss: $skuList,
            worstMarginRate: $worstMarginRate,
        );
    }

    /** 3.63 → "3.63", 9.0 → "9" (문구에 불필요한 .0을 남기지 않는다) */
    private static function trimRate(float $rate): string
    {
        $formatted = number_format($rate, 2, '.', '');

        return rtrim(rtrim($formatted, '0'), '.') ?: '0';
    }
}
