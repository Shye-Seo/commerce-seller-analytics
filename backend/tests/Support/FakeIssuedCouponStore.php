<?php

declare(strict_types=1);

namespace SellerScope\Tests\Support;

use SellerScope\Domain\Promotion\Coupon;
use SellerScope\Domain\Promotion\CouponStatus;
use SellerScope\Repositories\DuplicateCouponException;
use SellerScope\Repositories\IssuedCouponStore;

/**
 * 쿠폰 원장 페이크(유니크 제약까지 재현).
 *
 * 이 페이크의 목적은 "동시 더블클릭"을 결정적으로 재현하는 것이다.
 * `failNextInsertWith('idempotency_key')`를 켜 두면, 서비스가 애플리케이션 검사를
 * 통과한 뒤 INSERT에서 유니크 위반을 만난 상황을 그대로 만들 수 있다.
 * 실제 MySQL에서는 두 요청이 동시에 "없음"을 읽을 때 이 상황이 발생한다.
 */
final class FakeIssuedCouponStore implements IssuedCouponStore
{
    /** @var array<int, Coupon> */
    private array $coupons = [];

    private int $nextId = 1;

    /** 다음 INSERT를 이 제약으로 실패시킨다(idempotency_key | template_user). */
    public ?string $failNextInsertWith = null;

    public function findByIdempotencyKey(string $idempotencyKey): ?Coupon
    {
        foreach ($this->coupons as $coupon) {
            if ($coupon->idempotencyKey === $idempotencyKey) {
                return $coupon;
            }
        }

        return null;
    }

    public function findByTemplateAndUser(int $templateId, string $userHash): ?Coupon
    {
        foreach ($this->coupons as $coupon) {
            if ($coupon->templateId === $templateId && $coupon->userHash === $userHash) {
                return $coupon;
            }
        }

        return null;
    }

    public function findById(int $id): ?Coupon
    {
        return $this->coupons[$id] ?? null;
    }

    public function insert(Coupon $coupon): int
    {
        if ($this->failNextInsertWith !== null) {
            $constraint = $this->failNextInsertWith;
            $this->failNextInsertWith = null;

            // 실제 경합을 재현한다: 다른 요청이 먼저 커밋되어 같은 키/같은 사용자의 행이 이미 있다.
            if ($constraint === 'template_user') {
                // 같은 사용자의 동시 클릭: 같은 (template, user) 행이 먼저 커밋됐다.
                $this->storeGhost($coupon, userHash: $coupon->userHash, idempotencyKey: $coupon->idempotencyKey . ':winner');
            } elseif ($constraint === 'idempotency_key') {
                // 같은 멱등 키의 재전송이 다른 사용자 컨텍스트로 먼저 커밋됐다.
                $this->storeGhost($coupon, userHash: 'ghost-winner', idempotencyKey: $coupon->idempotencyKey);
            }

            throw new DuplicateCouponException($constraint);
        }

        if ($this->findByIdempotencyKey($coupon->idempotencyKey) !== null) {
            throw new DuplicateCouponException('idempotency_key');
        }

        if ($this->findByTemplateAndUser($coupon->templateId, $coupon->userHash) !== null) {
            throw new DuplicateCouponException('template_user');
        }

        $id = $this->nextId++;
        $this->coupons[$id] = new Coupon(
            id: $id,
            tenantId: $coupon->tenantId,
            campaignId: $coupon->campaignId,
            templateId: $coupon->templateId,
            entryId: $coupon->entryId,
            userHash: $coupon->userHash,
            codeHash: $coupon->codeHash,
            status: $coupon->status,
            discountAmount: $coupon->discountAmount,
            orderAmount: $coupon->orderAmount,
            orderId: $coupon->orderId,
            idempotencyKey: $coupon->idempotencyKey,
            issuedAt: $coupon->issuedAt,
            expiresAt: $coupon->expiresAt,
            maskedCode: $coupon->maskedCode,
        );

        return $id;
    }

    public function transition(int $couponId, CouponStatus $from, CouponStatus $to, array $stamps = []): bool
    {
        $coupon = $this->coupons[$couponId] ?? null;
        if ($coupon === null || $coupon->status !== $from) {
            return false;
        }

        $this->coupons[$couponId] = $coupon->with(
            status: $to,
            orderAmount: isset($stamps['order_amount']) ? (int) $stamps['order_amount'] : null,
            discountAmount: isset($stamps['discount_amount']) ? (int) $stamps['discount_amount'] : null,
            orderId: isset($stamps['order_id']) ? (string) $stamps['order_id'] : null,
            redeemedAt: $stamps['redeemed_at'] ?? null,
            settledAt: $stamps['settled_at'] ?? null,
            cancelReason: isset($stamps['cancel_reason']) ? (string) $stamps['cancel_reason'] : null,
        );

        return true;
    }

    /**
     * @return list<Coupon>
     */
    public function findExpiringBefore(\DateTimeImmutable $now, int $limit): array
    {
        $due = [];
        foreach ($this->coupons as $coupon) {
            if ($coupon->status->isOutstanding() && $coupon->isExpiredAt($now)) {
                $due[] = $coupon;
            }
        }

        return array_slice($due, 0, $limit);
    }

    private function storeGhost(Coupon $template, string $userHash, string $idempotencyKey): void
    {
        $id = $this->nextId++;
        $this->coupons[$id] = new Coupon(
            id: $id,
            tenantId: $template->tenantId,
            campaignId: $template->campaignId,
            templateId: $template->templateId,
            entryId: null,
            userHash: $userHash,
            codeHash: hash('sha256', 'ghost-' . $id),
            status: CouponStatus::Issued,
            discountAmount: $template->discountAmount,
            orderAmount: 0,
            orderId: null,
            idempotencyKey: $idempotencyKey,
            issuedAt: $template->issuedAt,
            expiresAt: $template->expiresAt,
        );
    }

    public function all(): array
    {
        return array_values($this->coupons);
    }

    /** 테스트 편의: 상태별 장수. */
    public function countByStatus(): array
    {
        $counts = [];
        foreach ($this->coupons as $coupon) {
            $counts[$coupon->status->value] = ($counts[$coupon->status->value] ?? 0) + 1;
        }

        return $counts;
    }
}
