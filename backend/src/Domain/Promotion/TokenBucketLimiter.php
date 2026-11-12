<?php

declare(strict_types=1);

namespace SellerScope\Domain\Promotion;

/**
 * 토큰 버킷 레이트 리미터.
 *
 * 왜 "초당 N회" 고정 창(fixed window)이 아니라 토큰 버킷인가:
 * 고정 창은 경계에서 2배가 통과한다. 1초 창이면 0.99초에 30번, 1.01초에 30번 = 0.02초에
 * 60번이 통과해 오픈 순간 버스트가 그대로 DB에 꽂힌다. 토큰 버킷은 용량(capacity)까지만
 * 버스트를 허용하고 이후 일정 속도로만 보충하므로, "사람이 연속 클릭하는 정도"는 통과하고
 * "스크립트가 초당 수백 번"은 걸러진다.
 *
 * 저장 위치: 운영에서는 Redis(원자적 INCR/EXPIRE 또는 Lua)지만, 여기 구현은 프로세스
 * 메모리다. 단일 인스턴스에서의 판정 규칙을 결정적으로 테스트하는 것이 목적이고,
 * 분산 환경에서는 같은 규칙을 Redis Lua로 옮긴다(ERD_SPEC §13).
 *
 * 시간은 전부 주입된 Clock에서 온다(테스트에서 초를 마음대로 흘리기 위해).
 */
final class TokenBucketLimiter
{
    /** @var array<string, array{tokens: float, updatedAt: float}> */
    private array $buckets = [];

    /**
     * @param int   $capacity    버킷 크기(순간 허용량)
     * @param float $refillPerSec 초당 보충 토큰 수
     */
    public function __construct(
        private readonly int $capacity = 5,
        private readonly float $refillPerSec = 1.0,
    ) {
    }

    /**
     * 토큰 1개를 소비할 수 있으면 true.
     */
    public function attempt(string $key, \DateTimeImmutable $now): bool
    {
        $nowMs = (float) $now->format('U.u');
        $bucket = $this->buckets[$key] ?? ['tokens' => (float) $this->capacity, 'updatedAt' => $nowMs];

        $elapsedSec = max(0.0, $nowMs - $bucket['updatedAt']);
        $tokens = min((float) $this->capacity, $bucket['tokens'] + $elapsedSec * $this->refillPerSec);

        if ($tokens < 1.0) {
            $this->buckets[$key] = ['tokens' => $tokens, 'updatedAt' => $nowMs];

            return false;
        }

        $this->buckets[$key] = ['tokens' => $tokens - 1.0, 'updatedAt' => $nowMs];

        return true;
    }

    /** 현재 남은 토큰(모니터링·테스트용). */
    public function tokensFor(string $key, \DateTimeImmutable $now): float
    {
        $bucket = $this->buckets[$key] ?? null;
        if ($bucket === null) {
            return (float) $this->capacity;
        }

        $elapsedSec = max(0.0, (float) $now->format('U.u') - $bucket['updatedAt']);

        return min((float) $this->capacity, $bucket['tokens'] + $elapsedSec * $this->refillPerSec);
    }

    public function reset(): void
    {
        $this->buckets = [];
    }
}
