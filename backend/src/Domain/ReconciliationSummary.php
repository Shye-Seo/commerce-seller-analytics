<?php

declare(strict_types=1);

namespace SellerScope\Domain;

/**
 * 대사 결과 집계.
 *
 * 필드 이름은 프론트엔드 `ReconciliationSummary`와 같다(camelCase). 서버가 계산한 요약을
 * Next.js 콘솔이 변환 없이 그대로 그릴 수 있어야 "화면 숫자와 저장 숫자가 다르다"는
 * 문의가 구조적으로 생기지 않는다.
 *
 * totalLeak은 "원인별 귀속 손실의 합"이고 shortfall 합계와는 다를 수 있다. 차이가 나면
 * 그만큼 설명되지 않는 부족분(SETTLEMENT_SHORTFALL) 또는 반올림 누수가 있다는 뜻이며,
 * 두 숫자를 같이 보여 주는 것이 이 도구의 신뢰를 만든다.
 */
final readonly class ReconciliationSummary
{
    /**
     * @param array<string,int> $anomalyCounts  원인 코드 => 건수
     * @param array<string,int> $anomalyLoss    원인 코드 => 귀속 손실액
     * @param list<array<string,mixed>> $byChannel
     * @param list<array<string,mixed>> $topSkusByLoss
     */
    public function __construct(
        public int $totalRows,
        public int $matchedRows,
        public int $flaggedRows,
        public float $matchedRate,
        public int $totalPaidAmount,
        public int $totalCommission,
        public int $totalSettledAmount,
        public int $expectedSettlement,
        public int $totalLeak,
        public int $totalSurplus,
        public int $marginRiskExposure,
        public int $negativeMarginRows,
        public array $anomalyCounts,
        public array $anomalyLoss,
        public array $byChannel,
        public array $topSkusByLoss,
        public float $worstMarginRate,
    ) {
    }

    public static function empty(): self
    {
        $counts = [];
        $loss = [];
        foreach (AnomalyType::cases() as $type) {
            $counts[$type->value] = 0;
            $loss[$type->value] = 0;
        }

        return new self(0, 0, 0, 0.0, 0, 0, 0, 0, 0, 0, 0, 0, $counts, $loss, [], [], 0.0);
    }

    /** 가장 돈이 새는 원인 한 가지(없으면 null). */
    public function biggestLeakCause(): ?array
    {
        $best = null;
        foreach ($this->anomalyLoss as $code => $amount) {
            if ($amount > 0 && ($best === null || $amount > $best['amount'])) {
                $best = ['code' => $code, 'amount' => $amount, 'label' => AnomalyType::from($code)->label()];
            }
        }

        return $best;
    }

    public function toArray(): array
    {
        return [
            'totalRows' => $this->totalRows,
            'matchedRows' => $this->matchedRows,
            'flaggedRows' => $this->flaggedRows,
            'matchedRate' => $this->matchedRate,
            'totalPaidAmount' => $this->totalPaidAmount,
            'totalCommission' => $this->totalCommission,
            'totalSettledAmount' => $this->totalSettledAmount,
            'expectedSettlement' => $this->expectedSettlement,
            'totalLeak' => $this->totalLeak,
            'totalSurplus' => $this->totalSurplus,
            'marginRiskExposure' => $this->marginRiskExposure,
            'negativeMarginRows' => $this->negativeMarginRows,
            'anomalyCounts' => $this->anomalyCounts,
            'anomalyLoss' => $this->anomalyLoss,
            'byChannel' => $this->byChannel,
            'topSkusByLoss' => $this->topSkusByLoss,
            'worstMarginRate' => $this->worstMarginRate,
            'biggestLeakCause' => $this->biggestLeakCause(),
        ];
    }
}
