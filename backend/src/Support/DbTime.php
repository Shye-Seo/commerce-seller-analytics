<?php

declare(strict_types=1);

namespace SellerScope\Support;

/**
 * DB DATETIME(3) ↔ PHP 시각 변환.
 *
 * MySQL의 DATETIME은 타임존을 저장하지 않는다. 이 프로젝트는 커넥션에서
 * `SET time_zone = '+09:00'`으로 KST를 고정하므로, DB에서 읽은 문자열은 **KST**다.
 *
 * 문제는 PHP가 그 문자열을 해석할 때다. `new DateTimeImmutable('2026-11-20 20:00:00')`은
 * PHP 기본 타임존(대개 UTC)으로 해석하므로, KST 기준 20시가 UTC 20시가 되어 캠페인
 * 오픈 판정이 9시간 어긋난다. 실제로 이 버그는 부하 테스트에서 "CAMPAIGN_CLOSED"로
 * 드러났다(캠페인은 live인데 시간이 안 맞는다고 거절).
 *
 * 그래서 DB에서 읽은 값은 **반드시 이 헬퍼로** 해석한다. 쓰기는 `format()`을 쓴다.
 */
final class DbTime
{
    public static function parse(?string $value): ?\DateTimeImmutable
    {
        if ($value === null || $value === '') {
            return null;
        }

        return new \DateTimeImmutable($value, self::timezone());
    }

    public static function format(\DateTimeImmutable $value): string
    {
        return $value->setTimezone(self::timezone())->format('Y-m-d H:i:s.v');
    }

    public static function timezone(): \DateTimeZone
    {
        return new \DateTimeZone(Env::get('DB_TIMEZONE', '+09:00') ?? '+09:00');
    }
}
