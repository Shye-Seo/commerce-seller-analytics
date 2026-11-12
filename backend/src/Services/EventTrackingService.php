<?php

declare(strict_types=1);

namespace SellerScope\Services;

use SellerScope\Domain\Promotion\AbuseScorer;
use SellerScope\Domain\Promotion\EntryDecision;
use SellerScope\Domain\Promotion\EntryStatus;
use SellerScope\Domain\Promotion\EventEntryRequest;
use SellerScope\Domain\Promotion\TokenBucketLimiter;
use SellerScope\Repositories\EventEntryStore;
use SellerScope\Support\Clock;

/**
 * 실시간 응모 트래킹 서비스.
 *
 * 순서가 곧 방어선이다.
 *   ① 레이트 리밋(토큰 버킷) — 스크립트 연타를 DB 앞에서 자른다.
 *   ② 신호 수집 — 기기 클러스터·전화번호 재사용·IP 폭주·UA 이상.
 *   ③ 점수화 → 차단 판정(AbuseScorer).
 *   ④ 저장 — 멱등 키/사용자 유니크로 두 번째 요청을 흡수한다.
 *
 * ①이 ②보다 앞인 이유: 신호 수집은 쿼리 4번이다. 리밋에 걸린 요청에 쿼리 4번을
 * 써 주면 그게 곧 DoS 증폭기가 된다. 반대로 리밋만 믿으면 안 된다 — 공격자는
 * 회전 프록시로 리밋을 우회하므로, 기기 핑거프린트가 마지막 방어선이다.
 *
 * 이 서비스는 "거절도 저장"한다. 단, 유니크 충돌(이미 같은 응모가 있음)일 때는
 * 저장할 수 없으므로 판정만 돌려준다(DB에 두 행을 만들면 안 된다).
 */
final class EventTrackingService
{
    /** 신호 집계 윈도우(초). 10초는 "오픈 순간의 폭주"를 잡는 구간이다. */
    private const SIGNAL_WINDOW_SECONDS = 10;

    public function __construct(
        private readonly EventEntryStore $entries,
        private readonly Clock $clock,
        private readonly TokenBucketLimiter $limiter = new TokenBucketLimiter(6, 2.0),
        private readonly AbuseScorer $scorer = new AbuseScorer(),
    ) {
    }

    public function record(EventEntryRequest $request): EntryDecision
    {
        $now = $this->clock->now();
        $since = $now->modify('-' . self::SIGNAL_WINDOW_SECONDS . ' seconds');

        // ① 레이트 리밋 — 키는 IP 우선, 없으면 기기 핑거프린트, 둘 다 없으면 사용자 해시.
        $limitKey = $request->clientIp ?? $request->deviceFingerprint ?? $request->userHash;
        $rateLimited = ! $this->limiter->attempt($limitKey, $now);

        // ② 신호 수집
        $signals = [
            'deviceUsers' => $request->deviceFingerprint !== null
                ? $this->entries->distinctUsersByDevice($request->campaignId, $request->deviceFingerprint, $since)
                : 0,
            'ipCount' => $request->clientIp !== null
                ? $this->entries->recentCountByIp($request->clientIp, $since)
                : 0,
            'phoneUsers' => $request->phoneHash !== null
                ? $this->entries->distinctUsersByPhone($request->phoneHash)
                : 0,
            'uaCount' => $request->userAgentHash !== null
                ? $this->entries->recentCountByUserAgent($request->userAgentHash, $since)
                : 0,
            'hasUserAgent' => $request->userAgentHash !== null && $request->userAgentHash !== '',
            'rateLimited' => $rateLimited,
        ];

        // ③ 점수화
        $scored = $this->scorer->score($signals);
        $status = match (true) {
            $scored['score'] >= AbuseScorer::BLOCK_THRESHOLD => EntryStatus::RejectedAbuse,
            $rateLimited => EntryStatus::RejectedRateLimit,
            default => EntryStatus::Accepted,
        };

        $entryRef = self::uuidV4($request->userHash . '|' . $request->idempotencyKey);
        $latencyMs = $request->receivedAt !== null
            ? max(0, (int) floor(((float) $now->format('U.u') - (float) $request->receivedAt->format('U.u')) * 1000))
            : 0;

        // ④ 저장 — 유니크 충돌이면 판정만 돌려준다.
        $id = $this->entries->insert($request, [
            'score' => $scored['score'],
            'reasons' => $scored['reasons'],
            'status' => $status->value,
            'entryRef' => $entryRef,
            'latencyMs' => $latencyMs,
        ]);

        if ($id === null) {
            return new EntryDecision(
                status: EntryStatus::RejectedDuplicate,
                abuseScore: $scored['score'],
                reasons: array_values(array_unique([...$scored['reasons'], 'DUPLICATE_ENTRY'])),
                entryRef: $entryRef,
                latencyMs: $latencyMs,
                persisted: false,
            );
        }

        return new EntryDecision($status, $scored['score'], $scored['reasons'], $entryRef, $latencyMs, true);
    }

    /**
     * 캠페인 오픈 구간 판정(서버 시계 기준).
     *
     * 응모 서비스와 분리해 둔 이유: 오픈 전 프리뷰 화면도 이 판정을 써야 하고,
     * 테스트에서 "구간 전/중/후"를 시계만 바꿔 확인할 수 있어야 한다.
     */
    public function isWithinWindow(\DateTimeImmutable $start, \DateTimeImmutable $end): bool
    {
        $now = $this->clock->now();

        return $now >= $start && $now < $end;
    }

    /**
     * 결정적 응모 UUID. 외부에 노출되는 식별자이며 PK를 노출하지 않기 위한 장치다.
     * (hash 기반이므로 같은 요청은 같은 UUID — 재전송 응답이 흔들리지 않는다.)
     */
    public static function uuidV4(string $seed): string
    {
        $hash = hash('sha256', $seed, true);
        $hash[6] = chr((ord($hash[6]) & 0x0f) | 0x40);
        $hash[8] = chr((ord($hash[8]) & 0x3f) | 0x80);
        $hex = bin2hex(substr($hash, 0, 16));

        return sprintf(
            '%s-%s-%s-%s-%s',
            substr($hex, 0, 8),
            substr($hex, 8, 4),
            substr($hex, 12, 4),
            substr($hex, 16, 4),
            substr($hex, 20, 12),
        );
    }
}
