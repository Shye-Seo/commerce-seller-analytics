<?php

declare(strict_types=1);

namespace SellerScope\Domain\Promotion;

/**
 * 재고 스냅샷.
 *
 * 보존식 `remaining + reserved + consumed = total`이 이 객체의 불변식이다.
 * 어긋난 스냅샷을 만나면 그건 이미 오버이슈이거나 회계 오류이므로, 서비스는
 * 발급을 계속하지 않고 예외를 던진다(조용히 진행하면 손실이 커진다).
 *
 * version은 낙관적 락의 근거다. 읽은 시점의 version을 그대로 UPDATE 조건에 넣어,
 * 그 사이 다른 요청이 재고를 바꿨다면 갱신이 0행이 되게 한다.
 */
final class InventorySnapshot
{
    public function __construct(
        public readonly int $id,
        public readonly int $templateId,
        public readonly int $totalQty,
        public readonly int $remainingQty,
        public readonly int $reservedQty,
        public readonly int $consumedQty,
        public readonly int $version,
    ) {
    }

    public function isSoldOut(): bool
    {
        return $this->remainingQty <= 0;
    }

    public function isBalanced(): bool
    {
        return $this->remainingQty + $this->reservedQty + $this->consumedQty <= $this->totalQty;
    }

    /** 소진율(%). 대시보드 게이지 값. */
    public function consumptionRate(): float
    {
        if ($this->totalQty <= 0) {
            return 0.0;
        }

        return round((($this->totalQty - $this->remainingQty) / $this->totalQty) * 100, 2);
    }
}
