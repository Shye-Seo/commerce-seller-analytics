<?php

declare(strict_types=1);

namespace SellerScope\Tests\Support;

use SellerScope\Domain\Promotion\CouponCodeGenerator;

/**
 * 결정적 코드 생성기.
 *
 * 16자리 난수를 테스트에서 재현할 수 없으므로 순번을 채운다.
 * `hash()`는 실제 구현과 같은 SHA-256을 쓰므로, "원문은 응답에만, 해시는 원장에"라는
 * 계약을 그대로 검증할 수 있다.
 */
final class SequenceCouponCodeGenerator implements CouponCodeGenerator
{
    private int $counter = 0;

    public function generate(): string
    {
        $this->counter++;

        return str_pad((string) $this->counter, 16, 'A', STR_PAD_LEFT);
    }

    public static function hash(string $plainCode): string
    {
        return hash('sha256', $plainCode);
    }
}
