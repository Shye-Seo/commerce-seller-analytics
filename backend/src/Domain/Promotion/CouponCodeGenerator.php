<?php

declare(strict_types=1);

namespace SellerScope\Domain\Promotion;

/**
 * 쿠폰 코드 생성기.
 *
 * 왜 인터페이스인가: 16자리 암호학적 난수는 테스트에서 재현할 수 없다. 테스트는
 * 결정적 생성기(`SequentialCouponCodeGenerator`)를 주입하고, 운영은
 * `RandomCouponCodeGenerator`(random_bytes 기반)를 쓴다.
 *
 * 코드 공간: 알파벳 32자(혼동 문자 0/O/1/I 제외) × 길이 16 = 2^80.
 * 같은 코드가 두 번 나올 확률은 무시할 수 있지만, 그래도 `coupon_hash UNIQUE`가
 * 최종 방어선이다(충돌 시 INSERT가 실패하고 서비스가 재발급한다).
 */
interface CouponCodeGenerator
{
    /** 16자리 대문자·숫자 코드. */
    public function generate(): string;
}
