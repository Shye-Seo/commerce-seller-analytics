<?php

declare(strict_types=1);

namespace SellerScope\Tests\Support;

use SellerScope\Domain\Promotion\InventorySnapshot;
use SellerScope\Repositories\CouponInventoryStore;

/**
 * 재고 페이크 — 실제 저장소와 **같은 불변식**을 지킨다.
 *
 * 페이크가 진짜 저장소보다 관대하면 테스트는 통과하지만 운영은 터진다. 그래서 여기서도
 *   · remaining_qty >= 0
 *   · release는 reserved_qty >= 1일 때만 복원
 *   · 조건부 차감은 "잔여 확인 + 차감"을 한 동작으로 처리
 * 를 그대로 구현한다. `forcedConflicts`는 낙관적 락 경합을 결정적으로 재현하기 위한 장치다.
 */
final class FakeCouponInventoryStore implements CouponInventoryStore
{
    private int $remaining;

    private int $reserved = 0;

    private int $consumed = 0;

    private int $version = 0;

    /** 다음 N번의 낙관적 락 시도를 강제로 실패시킨다(다른 요청이 먼저 가져간 상황). */
    public int $forcedConflicts = 0;

    public int $atomicAttempts = 0;

    public int $optimisticAttempts = 0;

    private readonly int $total;

    public function __construct(private readonly int $templateId = 1, int $total = 100)
    {
        $this->remaining = $total;
        $this->total = $total;
    }

    public function snapshot(int $templateId): ?InventorySnapshot
    {
        if ($templateId !== $this->templateId) {
            return null;
        }

        return new InventorySnapshot(
            id: 1,
            templateId: $this->templateId,
            totalQty: $this->total,
            remainingQty: $this->remaining,
            reservedQty: $this->reserved,
            consumedQty: $this->consumed,
            version: $this->version,
        );
    }

    public function reserveAtomically(int $templateId): bool
    {
        $this->atomicAttempts++;

        if ($templateId !== $this->templateId || $this->remaining < 1) {
            return false;
        }

        $this->remaining--;
        $this->reserved++;
        $this->version++;

        return true;
    }

    public function reserveOptimistically(int $templateId, int $expectedVersion): bool
    {
        $this->optimisticAttempts++;

        if ($this->forcedConflicts > 0) {
            $this->forcedConflicts--;
            // 경합이 일어나면 다른 요청이 version을 올려 놓는다.
            $this->version++;

            return false;
        }

        if ($templateId !== $this->templateId || $expectedVersion !== $this->version || $this->remaining < 1) {
            return false;
        }

        $this->remaining--;
        $this->reserved++;
        $this->version++;

        return true;
    }

    public function release(int $templateId): void
    {
        if ($templateId !== $this->templateId || $this->reserved < 1) {
            return;
        }

        $this->reserved--;
        $this->remaining++;
        $this->version++;
    }

    public function consume(int $templateId): void
    {
        if ($templateId !== $this->templateId || $this->reserved < 1) {
            return;
        }

        $this->reserved--;
        $this->consumed++;
        $this->version++;
    }

    public function remaining(): int
    {
        return $this->remaining;
    }

    public function reserved(): int
    {
        return $this->reserved;
    }

    public function consumed(): int
    {
        return $this->consumed;
    }

    /** 보존식이 깨졌는지(테스트가 매번 확인한다). */
    public function isBalanced(): bool
    {
        return $this->remaining + $this->reserved + $this->consumed === $this->total;
    }
}
