<?php

declare(strict_types=1);

namespace SellerScope\Tests\Services;

use PHPUnit\Framework\TestCase;
use SellerScope\Domain\AnomalyType;
use SellerScope\Domain\MarketChannel;
use SellerScope\Domain\Money;
use SellerScope\Domain\OrderStatus;
use SellerScope\Domain\SettlementRow;
use SellerScope\Services\SettlementReconciliationService;

/**
 * 대사 엔진의 골든 케이스.
 *
 * 각 케이스는 "마켓이 이렇게 정산했다면, 우리는 얼마를 어떤 원인으로 말해야 하는가"를
 * 금액까지 고정한다. 이 숫자들이 프론트엔드 픽스처와 같은 값이어야 하며, 엔진 로직을
 * 손볼 때 가장 먼저 깨지는 곳이 여기다.
 */
final class SettlementReconciliationServiceTest extends TestCase
{
    private SettlementReconciliationService $service;

    protected function setUp(): void
    {
        $this->service = new SettlementReconciliationService();
    }

    private function row(
        string $orderNo,
        int $paidAmount,
        int $commission,
        int $shippingDeduction,
        int $returnFee,
        int $settledAmount,
        OrderStatus $status = OrderStatus::Shipped,
        int $unitCost = 10_000,
        int $sellerShippingCost = 2_600,
        MarketChannel $channel = MarketChannel::SmartStore,
        ?float $contractFeeRate = null,
        int $quantity = 1,
    ): SettlementRow {
        return new SettlementRow(
            orderNo: $orderNo,
            channel: $channel,
            orderDate: new \DateTimeImmutable('2026-10-01'),
            productName: '테스트 상품',
            sku: 'SKU-TEST',
            quantity: $quantity,
            paidAmount: $paidAmount,
            commission: $commission,
            shippingDeduction: $shippingDeduction,
            returnFee: $returnFee,
            settledAmount: $settledAmount,
            status: $status,
            contractFeeRate: $contractFeeRate,
            unitCost: $unitCost,
            sellerShippingCost: $sellerShippingCost,
            settlementDate: new \DateTimeImmutable('2026-10-10'),
        );
    }

    public function testFullyMatchedRowIsReconciledWithoutAnomalies(): void
    {
        // 29,900 - 1,085(3.63%) - 3,000 = 25,815
        $result = $this->service->reconcileRow($this->row('A-1', 29_900, 1_085, 3_000, 0, 25_815));

        self::assertSame(1_085, $result->expectedCommission);
        self::assertSame(25_815, $result->expectedSettlement);
        self::assertSame(25_815, $result->actualSettlement);
        self::assertSame(0, $result->variance);
        self::assertSame(0, $result->shortfall);
        self::assertSame([], $result->anomalies);
        self::assertTrue($result->isReconciled());
    }

    public function testFeeOverchargeIsAttributedToTheFeeCause(): void
    {
        // 계약 3.63%면 1,815원인데 3,300원 청구 → 1,485원 초과
        $result = $this->service->reconcileRow($this->row('A-2', 50_000, 3_300, 3_000, 0, 43_700, quantity: 2));

        self::assertSame(1_815, $result->expectedCommission);
        self::assertSame(45_185, $result->expectedSettlement);
        self::assertSame(-1_485, $result->variance);
        self::assertSame(1_485, $result->shortfall);
        self::assertSame(1_485, $result->loss);

        $overcharge = $this->find($result->anomalies, AnomalyType::FeeOvercharge);
        self::assertNotNull($overcharge);
        self::assertSame(1_485, $overcharge->loss);
        self::assertSame('critical', $overcharge->type->severity());
        self::assertStringContainsString('계약 3.63% 기준 1,815원', $overcharge->detail);
    }

    public function testCanceledOrderFeeIsCountedOnceEvenThoughTwoCausesMatch(): void
    {
        // 취소 주문인데 수수료 2,310원 청구. "수수료 초과"와 "취소건 수수료"가 동시에 성립하지만
        // 실제로 잃은 돈은 2,310원 하나다.
        $result = $this->service->reconcileRow(
            $this->row('A-3', 21_000, 2_310, 0, 0, -2_310, OrderStatus::Canceled),
        );

        self::assertSame(0, $result->expectedSettlement);
        self::assertSame(-2_310, $result->variance);
        self::assertSame(2_310, $result->shortfall);

        self::assertSame(2_310, $this->find($result->anomalies, AnomalyType::FeeOnCanceledOrder)?->loss);
        self::assertSame(0, $this->find($result->anomalies, AnomalyType::FeeOvercharge)?->loss);

        $attributed = array_sum(array_map(static fn ($a): int => $a->loss, $result->anomalies));
        self::assertSame(
            $result->shortfall,
            $attributed,
            '원인별 귀속 합계는 부족분과 같아야 한다(같은 돈을 두 번 세지 않는다).',
        );
    }

    public function testReturnFeeDoubleChargeIsDetected(): void
    {
        // 반품 왕복 5,000원이 계약인데 10,000원 차감 → 5,000원 중복
        $result = $this->service->reconcileRow(
            $this->row('A-4', 38_000, 0, 0, 10_000, -10_000, OrderStatus::Returned, 15_000, 5_200),
        );

        self::assertSame(-5_000, $result->expectedSettlement); // 매출 0 - 반품비 5,000
        self::assertSame(-10_000, $result->actualSettlement);
        self::assertSame(5_000, $result->shortfall);

        $double = $this->find($result->anomalies, AnomalyType::ReturnFeeDoubleCharged);
        self::assertNotNull($double);
        self::assertSame(5_000, $double->loss);
        self::assertSame(5_000, $double->expected);
        self::assertSame(10_000, $double->actual);
    }

    public function testReturnFeeOnShippedOrderIsDetected(): void
    {
        $result = $this->service->reconcileRow($this->row('A-5', 30_000, 1_089, 3_000, 5_000, 20_911));

        self::assertSame(25_911, $result->expectedSettlement);
        self::assertSame(5_000, $result->shortfall);
        self::assertSame(5_000, $this->find($result->anomalies, AnomalyType::ReturnFeeOnShippedOrder)?->loss);
    }

    public function testUnexplainedShortfallIsSeparatedFromAttributedCauses(): void
    {
        // 20,000 - 726 - 3,000 = 16,274 기대, 실제 16,000 → 274원은 어떤 원인으로도 설명되지 않는다.
        $result = $this->service->reconcileRow($this->row('A-6', 20_000, 726, 3_000, 0, 16_000));

        self::assertSame(16_274, $result->expectedSettlement);
        self::assertSame(274, $result->shortfall);

        $shortfall = $this->find($result->anomalies, AnomalyType::SettlementShortfall);
        self::assertNotNull($shortfall);
        self::assertSame(274, $shortfall->loss);
        self::assertStringContainsString('설명되지 않는 274원', $shortfall->detail);
    }

    public function testSmallDifferenceIsClassifiedAsRoundingLeak(): void
    {
        $result = $this->service->reconcileRow($this->row('A-7', 20_000, 726, 3_000, 0, 16_265));

        self::assertSame(9, $result->shortfall);
        self::assertSame(9, $this->find($result->anomalies, AnomalyType::RoundingLeak)?->loss);
        self::assertNull($this->find($result->anomalies, AnomalyType::SettlementShortfall));
    }

    public function testSurplusIsFlaggedButNotCountedAsLoss(): void
    {
        // 기대보다 많이 들어온 돈은 손실이 아니다(다음 정산에서 차감될 수 있어 알리기만 한다).
        $result = $this->service->reconcileRow($this->row('A-8', 20_000, 726, 3_000, 0, 17_000));

        self::assertSame(726, $result->surplus);
        self::assertSame(0, $result->shortfall);
        self::assertSame(0, $result->loss);
        self::assertSame(0, $this->find($result->anomalies, AnomalyType::SettlementSurplus)?->loss);
        self::assertFalse($result->isReconciled());
    }

    public function testMissingUnitCostIsReportedAsLedgerGap(): void
    {
        $result = $this->service->reconcileRow($this->row('A-9', 29_900, 1_085, 3_000, 0, 25_815, unitCost: 0));

        self::assertNotNull($this->find($result->anomalies, AnomalyType::MissingLedger));
        self::assertNull($this->find($result->anomalies, AnomalyType::NegativeMargin));
    }

    public function testNegativeMarginIsReportedForShippedOrder(): void
    {
        // 정산 10,704 - 원가 9,500 - 배송 2,900 = -1,696
        $result = $this->service->reconcileRow(
            $this->row('A-10', 12_000, 1_296, 0, 0, 10_704, unitCost: 9_500, sellerShippingCost: 2_900, channel: MarketChannel::Coupang),
        );

        self::assertSame(10_704, $result->expectedSettlement);
        self::assertSame(-1_696, $result->netMargin);
        $negative = $this->find($result->anomalies, AnomalyType::NegativeMargin);
        self::assertNotNull($negative);
        self::assertSame(0, $negative->loss, '역마진 손실은 부족분으로 이미 집계되므로 중복 계산하지 않는다.');
    }

    public function testContractRateSnapshotOverridesCurrentContract(): void
    {
        // 행에 박힌 3월 계약(5.00%)이 지금 계약(3.63%)보다 우선한다.
        $result = $this->service->reconcileRow($this->row('A-11', 50_000, 2_500, 3_000, 0, 44_500, contractFeeRate: 5.0));

        self::assertSame(5.0, $result->contract->feeRate);
        self::assertSame(2_500, $result->expectedCommission);
        self::assertTrue($result->isReconciled());
    }

    public function testSummaryAggregatesByChannelSkuAndCause(): void
    {
        $rows = [
            $this->row('B-1', 29_900, 1_085, 3_000, 0, 25_815),
            $this->row('B-2', 50_000, 3_300, 3_000, 0, 43_700, quantity: 2),
            $this->row('B-3', 30_000, 3_240, 0, 0, 26_760, channel: MarketChannel::Coupang), // 10.8% 정확
        ];
        $reconciled = array_map(fn (SettlementRow $r) => $this->service->reconcileRow($r), $rows);
        $summary = $this->service->summarize($reconciled);

        self::assertSame(3, $summary->totalRows);
        self::assertSame(2, $summary->matchedRows);
        self::assertSame(1, $summary->flaggedRows);
        self::assertSame(66.67, $summary->matchedRate);
        self::assertSame(109_900, $summary->totalPaidAmount);
        self::assertSame(1_485, $summary->totalLeak);
        self::assertSame(1, $summary->anomalyCounts[AnomalyType::FeeOvercharge->value]);
        self::assertSame(1_485, $summary->anomalyLoss[AnomalyType::FeeOvercharge->value]);

        self::assertCount(2, $summary->byChannel);
        self::assertSame('smartstore', $summary->byChannel[0]['channel']); // 결제액 큰 채널이 먼저
        self::assertSame(79_900, $summary->byChannel[0]['paidAmount']);

        self::assertSame(['code' => AnomalyType::FeeOvercharge->value, 'amount' => 1_485, 'label' => '수수료 초과 청구'], $summary->biggestLeakCause());
    }

    public function testSummaryOfEmptyResultIsZeroFilled(): void
    {
        $summary = SettlementReconciliationService::presetContracts();
        self::assertCount(5, $summary);

        $empty = (new SettlementReconciliationService())->summarize([]);
        self::assertSame(0, $empty->totalRows);
        self::assertSame(0.0, $empty->matchedRate);
        self::assertArrayHasKey(AnomalyType::MissingLedger->value, $empty->anomalyCounts);
        self::assertNull($empty->biggestLeakCause());
    }

    public function testReconcileAllProducesResultEnvelopeWithMeta(): void
    {
        $result = $this->service->reconcileAll(
            [$this->row('C-1', 29_900, 1_085, 3_000, 0, 25_815)],
            parseErrorCount: 2,
            sourceRowCount: 3,
            elapsedMs: 12,
        );

        self::assertCount(1, $result->rows);
        self::assertSame(2, $result->parseErrorCount);
        self::assertSame(3, $result->sourceRowCount);
        // 1행 / 12ms = 83.3 rows/s
        self::assertSame(83, $result->rowsPerSecond());
        self::assertSame('preset', $result->toArray()['meta']['contractSource']);
    }

    public function testRowRejectsInvalidQuantity(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->row('D-1', 10_000, 0, 0, 0, 10_000, quantity: 0);
    }

    public function testRowFromArrayParsesKoreanStatusAndNumbers(): void
    {
        $row = SettlementRow::fromArray([
            'order_no' => ' 20261001-0000001 ',
            'channel' => 'coupang',
            'order_date' => '2026-10-01',
            'settlement_date' => '2026-10-20',
            'product_name' => '무선 미니 가습기',
            'sku' => 'SKU-HUM-06',
            'quantity' => '1',
            'paid_amount' => '32000',
            'commission' => '3456',
            'shipping_deduction' => '0',
            'return_fee' => '0',
            'settled_amount' => '28544',
            'order_status' => '배송완료',
            'unit_cost' => '14500',
            'seller_shipping_cost' => '2900',
        ]);

        self::assertSame('20261001-0000001', $row->orderNo);
        self::assertSame(MarketChannel::Coupang, $row->channel);
        self::assertSame(OrderStatus::Shipped, $row->status);
        self::assertSame(28_544, $row->settledAmount);
        self::assertSame('coupang:20261001-0000001', $row->id());
        self::assertSame(32_000, $row->recognizedRevenue());
    }

    public function testRowFromArrayFailsFastWhenAmountIsMissing(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('필수 값이 없습니다: paid_amount');

        SettlementRow::fromArray([
            'order_no' => 'X-1',
            'channel' => 'smartstore',
            'order_date' => '2026-10-01',
            'product_name' => '테스트',
            'sku' => 'SKU',
            'quantity' => 1,
            'commission' => 0,
            'shipping_deduction' => 0,
            'return_fee' => 0,
            'settled_amount' => 0,
            'order_status' => 'SHIPPED',
        ]);
    }

    public function testMoneyFormattingIsUsedInAnomalyDetails(): void
    {
        $result = $this->service->reconcileRow($this->row('E-1', 50_000, 3_300, 3_000, 0, 43_700, quantity: 2));

        self::assertStringContainsString(Money::format(3_300), (string) $this->find($result->anomalies, AnomalyType::FeeOvercharge)?->detail);
    }

    /**
     * @param list<\SellerScope\Domain\Anomaly> $anomalies
     */
    private function find(array $anomalies, AnomalyType $type): ?\SellerScope\Domain\Anomaly
    {
        foreach ($anomalies as $anomaly) {
            if ($anomaly->type === $type) {
                return $anomaly;
            }
        }

        return null;
    }
}
