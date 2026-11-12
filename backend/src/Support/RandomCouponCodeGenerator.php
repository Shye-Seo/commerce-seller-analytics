<?php

declare(strict_types=1);

namespace SellerScope\Support;

use SellerScope\Domain\Promotion\CouponCodeGenerator;

/**
 * 운영용 쿠폰 코드 생성기.
 *
 * alphabet에서 0/O/1/I를 뺀 이유: 고객이 전화로 불러주거나 손으로 입력하는 코드다.
 * 0과 O를 헷갈려 입력하면 "쿠폰이 유효하지 않습니다" CS가 하루 수십 건 들어온다.
 *
 * `random_bytes`는 OS CSPRNG다. `mt_rand`/`uniqid`는 예측 가능하고, 쿠폰 코드는
 * 곧 돈이므로 예측 가능한 난수는 취약점이다. 32^16 = 2^80 공간.
 */
final class RandomCouponCodeGenerator implements CouponCodeGenerator
{
    private const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

    public function generate(): string
    {
        $code = '';
        $max = strlen(self::ALPHABET) - 1;

        for ($i = 0; $i < 16; $i++) {
            $code .= self::ALPHABET[random_int(0, $max)];
        }

        return $code;
    }

    public static function hash(string $plainCode): string
    {
        return hash('sha256', $plainCode);
    }
}
