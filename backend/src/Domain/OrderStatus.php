<?php

declare(strict_types=1);

namespace SellerScope\Domain;

/**
 * 주문 상태(정산서 기준).
 *
 * 왜 한글 상태명을 enum case로 쓰지 않았나
 *   · DB와 API는 영문 코드(SHIPPED/RETURNED/CANCELED/EXCHANGED)로 고정하고,
 *     화면 문구는 label()이 만든다. 상태명이 바뀌어도(예: "배송완료" → "배송 완료")
 *     저장된 데이터와 과거 정산 이력이 흔들리지 않는다.
 */
enum OrderStatus: string
{
    case Shipped = 'SHIPPED';
    case Returned = 'RETURNED';
    case Canceled = 'CANCELED';
    case Exchanged = 'EXCHANGED';

    public function label(): string
    {
        return match ($this) {
            self::Shipped => '배송완료',
            self::Returned => '반품완료',
            self::Canceled => '취소',
            self::Exchanged => '교환완료',
        };
    }

    /** 매출이 인식되는가. 반품·취소는 환불이므로 매출 0으로 본다. */
    public function recognizesRevenue(): bool
    {
        return $this === self::Shipped || $this === self::Exchanged;
    }

    /** 반품 왕복 배송비가 정당하게 발생하는 상태인가. */
    public function expectsReturnFee(): bool
    {
        return $this === self::Returned || $this === self::Exchanged;
    }

    /** 정산서 CSV의 한글 표기를 코드로 되돌린다. */
    public static function fromKorean(string $label): self
    {
        return match (trim($label)) {
            '배송완료' => self::Shipped,
            '반품완료' => self::Returned,
            '취소' => self::Canceled,
            '교환완료' => self::Exchanged,
            default => self::from(strtoupper(trim($label))),
        };
    }
}
