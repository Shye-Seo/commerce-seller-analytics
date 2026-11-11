<?php

declare(strict_types=1);

namespace SellerScope\Tests\Domain;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use SellerScope\Domain\Money;

final class MoneyTest extends TestCase
{
    /**
     * @return array<string, array{float|int, int}>
     */
    public static function roundingCases(): array
    {
        return [
            '내림' => [0.4, 0],
            '올림 경계' => [0.5, 1],
            '1.5' => [1.5, 2],
            '2.5' => [2.5, 3],
            '실제 수수료 1633.5' => [1633.5, 1634],
            '실제 수수료 2323.2' => [2323.2, 2323],
            '음수 -.4' => [-0.4, 0],
            // JS Math.round(-0.5) === -0 → 0. PHP round() 기본값이면 -1이 나온다(불일치 지점).
            '음수 -.5' => [-0.5, 0],
            '음수 -1.5' => [-1.5, -1],
            '큰 금액' => [128_400.49, 128_400],
        ];
    }

    #[DataProvider('roundingCases')]
    public function testRoundMatchesJavaScriptMathRound(float|int $input, int $expected): void
    {
        self::assertSame($expected, Money::round($input));
    }

    public function testRateUsesTwoDecimalsByDefault(): void
    {
        self::assertSame(1.95, Money::rate(1_900, 97_500));
        self::assertSame(3.63, Money::rate(1_815, 50_000));
        self::assertSame(0.0, Money::rate(1_000, 0));
    }

    public function testRateRoundsHalfUpLikeJavaScript(): void
    {
        // 12.5% 정확히 절반인 경우: 1/8 = 12.5 → 소수 첫째 자리에서 반올림
        self::assertSame(12.5, Money::rate(1, 8, 1));
    }

    public function testFormatUsesKoreanWonNotation(): void
    {
        self::assertSame('1,900원', Money::format(1_900));
        self::assertSame('-3,400원', Money::format(-3_400));
        self::assertSame('0원', Money::format(0));
    }
}
