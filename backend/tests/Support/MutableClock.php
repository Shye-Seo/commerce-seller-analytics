<?php

declare(strict_types=1);

namespace SellerScope\Tests\Support;

use SellerScope\Support\Clock;

/**
 * 테스트 중에 시간을 흘릴 수 있는 시계.
 *
 * 쿠폰 도메인은 "15분 TTL"과 "오픈 구간"처럼 시각에 따라 결과가 달라진다.
 * 서비스에 시계를 주입해 두었으므로, 테스트는 sleep 없이 20:30 → 20:46으로 건너뛴다.
 * (sleep으로 15분을 기다리는 테스트는 아무도 돌리지 않는다.)
 */
final class MutableClock implements Clock
{
    public function __construct(private \DateTimeImmutable $at)
    {
    }

    public static function at(string $iso = '2026-11-20T20:30:00+09:00'): self
    {
        return new self(new \DateTimeImmutable($iso));
    }

    public function set(string $iso): void
    {
        $this->at = new \DateTimeImmutable($iso);
    }

    public function advanceSeconds(int $seconds): void
    {
        $this->at = $this->at->modify("+{$seconds} seconds");
    }

    public function now(): \DateTimeImmutable
    {
        return $this->at;
    }

    public function epochMillisAsString(): string
    {
        return (string) ($this->at->getTimestamp() * 1000);
    }
}
