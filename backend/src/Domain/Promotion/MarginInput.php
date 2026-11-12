<?php

declare(strict_types=1);

namespace SellerScope\Domain\Promotion;

/**
 * 마진 가드레일의 입력.
 *
 * 쿠폰 발급 시점에 알 수 있는 값만 담는다. 주문이 아직 없으므로 `orderAmount`는
 * "가정 장바구니 금액"(템플릿의 최소주문금액 또는 정률 상한 도달 금액)이다.
 * 주문이 생기면(RESERVED) 실제 금액으로 다시 평가한다 — 이중 검사다.
 *
 * feeRatePct는 마켓 계약 수수료율(%), shippingCost는 셀러가 부담하는 배송원가(원)다.
 * 1부의 `stores` 계약 조건과 같은 값을 쓰며, 여기서는 호출자가 채워 넣는다.
 */
final class MarginInput
{
    public function __construct(
        public readonly int $orderAmount,
        public readonly int $productCost,
        public readonly int $shippingCost = 0,
        public readonly float $feeRatePct = 0.0,
    ) {
    }

    public static function none(): self
    {
        return new self(0, 0, 0, 0.0);
    }

    public function isEvaluable(): bool
    {
        return $this->orderAmount > 0;
    }
}
