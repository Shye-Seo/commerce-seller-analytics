<?php

declare(strict_types=1);

namespace SellerScope\Domain;

/**
 * 원인 하나에 귀속된 손실(불변 값 객체).
 *
 * loss는 "이 원인이 실제로 야기한 돈"이며, 부족분(shortfall)을 나눠 갖는 구조라
 * 같은 행의 loss 합계는 shortfall을 넘지 않는다. 넘으면 그건 두 번 센 것이다.
 */
final readonly class Anomaly
{
    public function __construct(
        public AnomalyType $type,
        public int $expected,
        public int $actual,
        public int $loss,
        public string $detail,
    ) {
        if ($loss < 0) {
            throw new \InvalidArgumentException('귀속 손실은 음수일 수 없습니다.');
        }
    }

    /** DB 저장용(anomaly_type, category, severity 포함). */
    public function toArray(): array
    {
        return [
            'anomaly_type' => $this->type->value,
            'category' => $this->type->category(),
            'severity' => $this->type->severity(),
            'expected_amount' => $this->expected,
            'actual_amount' => $this->actual,
            'loss_amount' => $this->loss,
            'detail' => $this->detail,
        ];
    }

    /** API 응답용(프론트엔드 RowAnomaly 타입과 동일 키). */
    public function toApiArray(): array
    {
        return [
            'code' => $this->type->value,
            'label' => $this->type->label(),
            'severity' => $this->type->severity(),
            'category' => $this->type->category(),
            'detail' => $this->detail,
            'expected' => $this->expected,
            'actual' => $this->actual,
            'loss' => $this->loss,
        ];
    }
}
