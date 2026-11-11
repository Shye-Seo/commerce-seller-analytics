<?php

declare(strict_types=1);

namespace SellerScope\Domain;

/**
 * 대사가 끝난 행(불변).
 *
 * "정산서 원본(row)"과 "계약 기준 재계산값(expected*)"과 "차액(variance)"을 함께 들고 있다.
 * 이 세 개가 한 객체에 있어야 "이 3,400원이 어디서 나왔는지"를 화면·알림톡·CS 답변에서
 * 같은 숫자로 말할 수 있다.
 */
final readonly class ReconciledRow
{
    /**
     * @param list<Anomaly> $anomalies
     */
    public function __construct(
        public SettlementRow $row,
        public ContractTerms $contract,
        public int $expectedCommission,
        public int $expectedShippingDeduction,
        public int $expectedReturnFee,
        public int $expectedSettlement,
        public int $actualSettlement,
        public int $variance,
        public int $shortfall,
        public int $surplus,
        public float $effectiveFeeRate,
        public int $netMargin,
        public float $marginRate,
        public array $anomalies,
        public int $loss,
    ) {
    }

    public function isReconciled(): bool
    {
        return $this->anomalies === [];
    }

    /** 심각도별 개수(알림 대상 판단용). */
    public function criticalAnomalies(): array
    {
        return array_values(array_filter(
            $this->anomalies,
            static fn (Anomaly $a): bool => $a->type->isCritical(),
        ));
    }

    public function toApiArray(): array
    {
        return [
            'id' => $this->row->id(),
            'row' => $this->row->toArray(),
            'contract' => $this->contract->toArray(),
            'expectedCommission' => $this->expectedCommission,
            'expectedShippingDeduction' => $this->expectedShippingDeduction,
            'expectedReturnFee' => $this->expectedReturnFee,
            'expectedSettlement' => $this->expectedSettlement,
            'actualSettlement' => $this->actualSettlement,
            'variance' => $this->variance,
            'shortfall' => $this->shortfall,
            'surplus' => $this->surplus,
            'effectiveFeeRate' => $this->effectiveFeeRate,
            'netMargin' => $this->netMargin,
            'marginRate' => $this->marginRate,
            'anomalies' => array_map(static fn (Anomaly $a): array => $a->toApiArray(), $this->anomalies),
            'loss' => $this->loss,
            'reconciled' => $this->isReconciled(),
        ];
    }
}
