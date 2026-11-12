<?php

declare(strict_types=1);

namespace SellerScope\Repositories;

use SellerScope\Domain\Promotion\Coupon;
use SellerScope\Domain\Promotion\CouponStatus;

/**
 * 쿠폰 원장 저장소 계약.
 *
 * `transition()`은 반드시 `WHERE status = :from` 조건으로 갱신한다(compare-and-set).
 * 같은 쿠폰에 두 요청이 동시에 다른 상태를 밀어 넣으면 한 쪽만 성공해야 하며,
 * 실패한 쪽은 최신 상태를 다시 읽어 판단해야 한다. 이 규칙이 없으면
 * "사용 확정"과 "취소"가 동시에 성공해 재고가 두 번 복원된다.
 */
interface IssuedCouponStore
{
    public function findByIdempotencyKey(string $idempotencyKey): ?Coupon;

    public function findByTemplateAndUser(int $templateId, string $userHash): ?Coupon;

    public function findById(int $id): ?Coupon;

    /**
     * 원장 INSERT. 같은 (template_id, user_hash) 또는 같은 멱등 키가 이미 있으면
     * DuplicateCouponException을 던진다 — 애플리케이션 검사와 DB 유니크를 이중으로 건다.
     */
    public function insert(Coupon $coupon): int;

    /**
     * 상태 전이(compare-and-set). 성공하면 true.
     *
     * @param array<string, mixed> $stamps 상태별 시각·사유(redeemed_at, settled_at, cancel_reason)
     */
    public function transition(int $couponId, CouponStatus $from, CouponStatus $to, array $stamps = []): bool;

    /**
     * 만료 스윕 대상(ISSUED/RESERVED 이면서 expires_at이 지난 행).
     *
     * LIMIT을 두는 이유: 만료가 한꺼번에 10만 건 터지는 날, 한 트랜잭션으로 다 잡으면
     * 락 대기로 발급이 멈춘다. 500건씩 끊어 처리하고 다음 주기에 이어서 잡는다.
     *
     * @return list<Coupon>
     */
    public function findExpiringBefore(\DateTimeImmutable $now, int $limit): array;
}
