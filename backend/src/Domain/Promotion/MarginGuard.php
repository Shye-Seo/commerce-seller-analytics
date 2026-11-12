<?php

declare(strict_types=1);

namespace SellerScope\Domain\Promotion;

use SellerScope\Domain\Money;

/**
 * 마진 가드레일 계산.
 *
 * 프로모션의 목적은 매출 증대이지 손실 확정이 아니다. 쿠폰 한 장이 만들어내는
 * 손익은 다음 순서로 계산한다(모두 원 단위 정수, JS Math.round와 동일 규칙).
 *
 *   정산예정액 = 주문금액 - 마켓수수료(주문금액 × 요율) - 셀러부담 배송원가
 *   예상마진   = 정산예정액 - 쿠폰할인 - 상품원가
 *   마진율     = 예상마진 / 주문금액 × 100
 *
 * 주의: 마진율의 분모를 "정산예정액"이 아니라 "주문금액"으로 둔다. 셀러가 보는
 * 마진율은 매출 대비 마진이고, 분모를 정산액으로 두면 수수료가 클수록 마진율이
 * 커 보이는 착시가 생긴다(1부의 net_margin/margin_rate와 같은 규칙).
 */
final class MarginGuard
{
    public function assess(
        CouponTemplate $template,
        MarginInput $input,
        float $minimumMarginRate,
    ): MarginAssessment {
        if (! $input->isEvaluable()) {
            return MarginAssessment::notEvaluated();
        }

        $orderAmount = $input->orderAmount;
        $commission = Money::round(($orderAmount * $input->feeRatePct) / 100);
        $netSettlement = $orderAmount - $commission - $input->shippingCost;
        $discount = $template->discountFor($orderAmount);
        $margin = $netSettlement - $discount - $input->productCost;
        $rate = $orderAmount > 0 ? Money::rate($margin, $orderAmount, 2) : 0.0;

        return new MarginAssessment(
            orderAmount: $orderAmount,
            discountAmount: $discount,
            netSettlement: $netSettlement,
            projectedMargin: $margin,
            projectedMarginRate: $rate,
            minimumMarginRate: $minimumMarginRate,
            evaluated: true,
        );
    }
}
