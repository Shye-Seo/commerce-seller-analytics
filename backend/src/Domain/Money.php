<?php

declare(strict_types=1);

namespace SellerScope\Domain;

/**
 * 금액·비율 반올림 규칙.
 *
 * 프론트엔드(reconciliationEngine.ts)의 `roundWon`/`toRate`와 **같은 결과**를 내야 한다.
 * 대사 결과는 화면에서 본 숫자와 서버가 저장한 숫자가 같아야 하고, 다르면 셀러가
 * 마켓에 제시하는 금액의 근거가 흔들린다.
 *
 * JavaScript의 Math.round는 `floor(x + 0.5)`와 같다. 즉 -0.5 → 0, -1.5 → -1로
 * "항상 +∞ 방향"이다. PHP의 round() 기본값은 0에서 먼 쪽(HALF_UP)이라 -0.5 → -1이
 * 되므로, 그대로 쓰면 두 구현이 1원씩 어긋난다. 그래서 여기서는 JS와 같은 식을 쓴다.
 */
final class Money
{
    /** 원 단위 정수로 반올림한다(JS Math.round와 동일). */
    public static function round(float|int $value): int
    {
        $float = (float) $value;
        if (!is_finite($float)) {
            return 0;
        }

        return (int) floor($float + 0.5);
    }

    /**
     * 비율(%) 계산. 분모가 0이면 0을 돌려준다(0으로 나눈 결과를 화면에 쓰지 않는다).
     */
    public static function rate(int|float $numerator, int|float $denominator, int $digits = 2): float
    {
        if ((float) $denominator === 0.0) {
            return 0.0;
        }

        $factor = 10 ** $digits;
        $scaled = ((float) $numerator / (float) $denominator) * 100 * $factor;

        return floor($scaled + 0.5) / $factor;
    }

    /** 화면·알림톡 문구용 금액 표기(1,900원). */
    public static function format(int $amount): string
    {
        $sign = $amount < 0 ? '-' : '';

        return $sign . number_format(abs($amount)) . '원';
    }
}
