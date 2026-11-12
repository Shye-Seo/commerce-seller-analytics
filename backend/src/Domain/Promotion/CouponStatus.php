<?php

declare(strict_types=1);

namespace SellerScope\Domain\Promotion;

/**
 * 쿠폰 원장 상태와 전이 규칙.
 *
 * 상태를 문자열 상수로 흩어 놓지 않고 enum + 전이표로 들고 있는 이유:
 * 쿠폰은 **부채**다. "사용된 쿠폰"을 "발급됨"으로 되돌리면 매출이 두 번 잡히고,
 * "정산된 쿠폰"을 "취소"로 바꾸면 이미 정산서에 반영된 금액이 사라진다.
 * 그래서 허용 전이를 한 곳(transitions())에 표로 고정하고, 저장소 갱신도
 * `WHERE status = :from`으로 낙관적으로 검사한다(동시에 두 요청이 같은 쿠폰을
 * 다른 상태로 밀어 넣는 것을 DB가 거부).
 *
 * ISSUED ──▶ RESERVED ──▶ REDEEMED ──▶ SETTLED
 *   │           │
 *   └───────────┴──▶ CANCELLED
 *   │           │
 *   └───────────┴──▶ EXPIRED
 */
enum CouponStatus: string
{
    case Issued = 'ISSUED';
    case Reserved = 'RESERVED';
    case Redeemed = 'REDEEMED';
    case Settled = 'SETTLED';
    case Cancelled = 'CANCELLED';
    case Expired = 'EXPIRED';

    /**
     * 허용 전이표. 키는 현재 상태, 값은 갈 수 있는 상태 목록이다.
     *
     * @return array<string, list<string>>
     */
    public static function transitions(): array
    {
        return [
            self::Issued->value => [self::Reserved->value, self::Cancelled->value, self::Expired->value],
            self::Reserved->value => [self::Redeemed->value, self::Cancelled->value, self::Expired->value],
            self::Redeemed->value => [self::Settled->value],
            self::Settled->value => [],
            self::Cancelled->value => [],
            self::Expired->value => [],
        ];
    }

    public function canTransitionTo(self $target): bool
    {
        return in_array($target->value, self::transitions()[$this->value] ?? [], true);
    }

    /** 더 이상 전이할 수 없는 상태(정산 확정·취소·만료). */
    public function isTerminal(): bool
    {
        return (self::transitions()[$this->value] ?? []) === [];
    }

    /** 재고를 되돌려야 하는 상태인가(발급/예약 → 취소·만료). */
    public function holdsInventory(): bool
    {
        return $this === self::Issued || $this === self::Reserved;
    }

    /** 주문에 묶여 결제를 기다리는 상태. 만료 스윕의 1차 대상. */
    public function isOutstanding(): bool
    {
        return $this->holdsInventory();
    }
}
