<?php

declare(strict_types=1);

namespace SellerScope\Domain\Promotion;

/**
 * 마진 가드레일 평가 결과.
 *
 * 금액을 전부 남기는 이유: 발급이 막혔을 때 운영자가 "왜 막혔는지"를 바로 알아야 한다.
 * "마진 미달"만 남기면, 운영자는 캠페인을 열어 두고 CS 문의를 받는다.
 * `explanation()`은 그대로 슬랙/알림톡에 붙여넣을 수 있는 한 문장이다.
 */
final class MarginAssessment
{
    public function __construct(
        public readonly int $orderAmount,
        public readonly int $discountAmount,
        public readonly int $netSettlement,
        public readonly int $projectedMargin,
        public readonly float $projectedMarginRate,
        public readonly float $minimumMarginRate,
        public readonly bool $evaluated,
    ) {
    }

    public static function notEvaluated(): self
    {
        return new self(0, 0, 0, 0, 0.0, 0.0, false);
    }

    /** 마진 하한을 지켰는가. 평가하지 않았으면(주문금액 없음) 차단하지 않는다. */
    public function passes(): bool
    {
        if (! $this->evaluated) {
            return true;
        }

        // 마이너스 마진은 하한과 무관하게 사고다.
        return $this->projectedMargin >= 0 && $this->projectedMarginRate >= $this->minimumMarginRate;
    }

    public function isLossMaking(): bool
    {
        return $this->evaluated && $this->projectedMargin < 0;
    }

    public function explanation(): string
    {
        if (! $this->evaluated) {
            return '마진 가드레일: 주문금액이 없어 평가하지 않았습니다.';
        }

        return sprintf(
            '주문 %s원 · 할인 %s원 · 정산 %s원 · 예상 마진 %s원(%.2f%%) / 하한 %.2f%%',
            number_format($this->orderAmount),
            number_format($this->discountAmount),
            number_format($this->netSettlement),
            number_format($this->projectedMargin),
            $this->projectedMarginRate,
            $this->minimumMarginRate,
        );
    }
}
