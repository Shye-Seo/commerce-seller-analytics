<?php

declare(strict_types=1);

namespace SellerScope\Domain\Promotion;

/**
 * 할인 유형.
 *
 * 정률(PERCENT)만 따로 enum으로 두는 이유는 다르게 해석해야 할 규칙이 있기 때문이다.
 *   · 정액: 최소 주문금액만 넘으면 그대로 할인.
 *   · 정률: 반드시 `max_discount_amount` 상한을 적용하고, 할인액이 주문금액을 넘지 않게 자른다.
 *     상한이 없으면 1,000만 원 주문에 200만 원이 깎이는 사고가 난다(스키마 CHECK가 강제).
 */
enum DiscountType: string
{
    case Fixed = 'FIXED';
    case Percent = 'PERCENT';
}
