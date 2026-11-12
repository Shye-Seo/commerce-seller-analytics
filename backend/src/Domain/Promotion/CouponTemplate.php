<?php

declare(strict_types=1);

namespace SellerScope\Domain\Promotion;

/**
 * 쿠폰 템플릿(할인 규칙).
 *
 * 이 객체의 유일한 계산 책임은 `discountFor($orderAmount)`다. 쿠폰 할인액은
 * "템플릿"과 "주문금액" 두 값으로만 결정되므로 순수 함수로 두고, 서버·프론트엔드가
 * 같은 규칙을 쓰도록 테스트로 금액을 고정한다.
 *
 * 경계 규칙(테스트가 지키는 것)
 *   · 주문금액 < 최소주문금액  → 0원(쿠폰 사용 불가). 예외를 던지지 않고 0을 돌려주는 이유:
 *     화면이 "이 쿠폰은 조건 미달"을 표시해야 하고, 발급 단계에서는 아직 주문이 없다.
 *   · 정액 할인액 > 주문금액  → 주문금액까지만(음수 결제 방지).
 *   · 정률 할인액 > 최대할인액 → 최대할인액.
 */
final class CouponTemplate
{
    public function __construct(
        public readonly int $id,
        public readonly int $campaignId,
        public readonly string $code,
        public readonly string $name,
        public readonly DiscountType $discountType,
        public readonly int $discountAmount,
        public readonly float $discountRate,
        public readonly int $minOrderAmount,
        public readonly int $maxDiscountAmount,
        public readonly int $perUserLimit,
        public readonly int $validityMinutes,
        public readonly string $fundedBy,
        public readonly bool $isActive,
    ) {
    }

    /** 주어진 주문금액에서 실제로 깎이는 금액(원). */
    public function discountFor(int $orderAmount): int
    {
        if ($orderAmount <= 0 || $orderAmount < $this->minOrderAmount) {
            return 0;
        }

        if ($this->discountType === DiscountType::Fixed) {
            return min($this->discountAmount, $orderAmount);
        }

        $raw = (int) floor(($orderAmount * $this->discountRate) / 100 + 0.5);
        $capped = $this->maxDiscountAmount > 0 ? min($raw, $this->maxDiscountAmount) : $raw;

        return max(0, min($capped, $orderAmount));
    }

    /**
     * 가드레일을 평가할 때 쓰는 "가정 주문금액".
     *
     * 발급 시점에는 아직 주문이 없다. 그래서 이 템플릿으로 살 수 있는 **가장 작은 장바구니**
     * (최소 주문금액)를 기준으로 마진을 본다. 최소 장바구니에서도 마진이 지켜지면,
     * 더 큰 장바구니에서는 (정액 쿠폰 기준) 마진율이 올라간다.
     * 정률 쿠폰은 반대다 — 주문이 커질수록 할인액도 커지므로, 최대할인 상한에 닿는
     * 주문금액(상한/할인율)을 가정해야 최악을 본다.
     */
    public function assumedOrderAmountForGuard(): int
    {
        $minimum = max(1, $this->minOrderAmount);

        if ($this->discountType === DiscountType::Percent && $this->discountRate > 0 && $this->maxDiscountAmount > 0) {
            $capReachedAt = (int) ceil(($this->maxDiscountAmount * 100) / $this->discountRate);

            return max($minimum, $capReachedAt);
        }

        return $minimum;
    }
}
