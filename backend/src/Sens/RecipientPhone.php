<?php

declare(strict_types=1);

namespace SellerScope\Sens;

/**
 * 알림톡 수신 번호.
 *
 * SENS는 `to`에 숫자만 받는다(하이픈 불가). 실무에서는 셀러가 "010-1234-5678"로
 * 입력하고 API는 "01012345678"을 요구하므로, 정규화를 한 곳에서만 한다.
 * +82 표기(해외 저장)도 국내 형식으로 되돌린다: +821012345678 → 01012345678.
 */
final readonly class RecipientPhone
{
    private function __construct(
        public string $digits,
        public string $countryCode,
    ) {
    }

    public static function fromString(string $raw): self
    {
        $digits = preg_replace('/\D+/', '', $raw) ?? '';

        if (str_starts_with($digits, '0082')) {
            $digits = '0' . substr($digits, 4);
        } elseif (str_starts_with($digits, '82') && strlen($digits) === 12) {
            $digits = '0' . substr($digits, 2);
        } elseif (str_starts_with($raw, '+82')) {
            $digits = '0' . ltrim($digits, '8'); // +82 10 … → 0 10 …
            $digits = preg_replace('/^0+/', '0', $digits) ?? $digits;
        }

        if (preg_match('/^01[016789][0-9]{7,8}$/', $digits) !== 1) {
            throw new \InvalidArgumentException("국내 휴대폰 번호 형식이 아닙니다: {$raw}");
        }

        return new self($digits, '82');
    }

    /** 마스킹 표기(로그·화면용): 010-****-5678 */
    public function masked(): string
    {
        $tail = substr($this->digits, -4);

        return substr($this->digits, 0, 3) . '-****-' . $tail;
    }
}
