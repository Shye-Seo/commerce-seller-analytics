<?php

declare(strict_types=1);

namespace SellerScope\Repositories;

use RuntimeException;

/**
 * 쿠폰 원장 유니크 충돌.
 *
 * "이미 있다"를 예외로 올리는 이유: 이 상황은 정상 흐름의 일부이고(동시 더블클릭),
 * 서비스가 잡아서 사용자에게 `DUPLICATE_CLAIM`으로 응답해야 한다. bool을 돌려주면
 * "왜 실패했는지"(멱등 키 충돌인지, 사용자 중복인지)를 구분할 수 없다.
 */
final class DuplicateCouponException extends RuntimeException
{
    public function __construct(public readonly string $constraint = 'unknown')
    {
        parent::__construct("쿠폰 원장 유니크 충돌: {$constraint}");
    }
}
