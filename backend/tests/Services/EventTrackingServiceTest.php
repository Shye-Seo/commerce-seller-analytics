<?php

declare(strict_types=1);

namespace SellerScope\Tests\Services;

use PHPUnit\Framework\TestCase;
use SellerScope\Domain\Promotion\AbuseScorer;
use SellerScope\Domain\Promotion\EntryStatus;
use SellerScope\Domain\Promotion\EventEntryRequest;
use SellerScope\Domain\Promotion\TokenBucketLimiter;
use SellerScope\Services\EventTrackingService;
use SellerScope\Tests\Support\FakeEventEntryStore;
use SellerScope\Tests\Support\MutableClock;

/**
 * 응모 트래킹 서비스 계약 테스트.
 *
 * 어뷰징 판정은 "점수가 몇 점인가"보다 **어떤 신호가 겹쳤을 때 차단되는가**가 중요하다.
 * 그래서 각 테스트는 신호를 하나씩 세팅하고, 기대 점수와 사유 코드까지 고정한다.
 * 점수식이 조용히 바뀌면 방어선이 사라지므로, 경계값(49/50)도 함께 지킨다.
 */
final class EventTrackingServiceTest extends TestCase
{
    private FakeEventEntryStore $store;

    private MutableClock $clock;

    protected function setUp(): void
    {
        $this->store = new FakeEventEntryStore();
        $this->clock = MutableClock::at('2026-11-20T20:00:01+09:00');
    }

    private function service(?TokenBucketLimiter $limiter = null): EventTrackingService
    {
        return new EventTrackingService(
            $this->store,
            $this->clock,
            $limiter ?? new TokenBucketLimiter(6, 2.0),
        );
    }

    private function request(
        string $user = 'user-clean',
        string $key = 'entry-1',
        bool $withDevice = true,
        bool $withIp = true,
        bool $withUserAgent = true,
        ?string $phoneHash = null,
        ?\DateTimeImmutable $receivedAt = null,
    ): EventEntryRequest {
        return new EventEntryRequest(
            campaignId: 1,
            userHash: hash('sha256', $user),
            idempotencyKey: $key,
            phoneHash: $phoneHash,
            deviceFingerprint: $withDevice ? hash('sha256', 'device-1') : null,
            clientIp: $withIp ? '203.0.113.10' : null,
            userAgentHash: $withUserAgent ? hash('sha256', 'ua-1') : null,
            utmSource: 'instagram',
            utmMedium: 'social',
            utmCampaign: 'toss-drop-2026-11',
            receivedAt: $receivedAt,
        );
    }

    // ─────────────────────────────────────────────────────────────
    // 1. 정상 유입
    // ─────────────────────────────────────────────────────────────

    public function testCleanEntryIsAcceptedAndPersisted(): void
    {
        $decision = $this->service()->record($this->request());

        self::assertTrue($decision->isAccepted());
        self::assertSame(EntryStatus::Accepted, $decision->status);
        self::assertSame(0, $decision->abuseScore);
        self::assertSame([], $decision->reasons);
        self::assertTrue($decision->persisted);
        self::assertCount(1, $this->store->inserted);
    }

    public function testUtmSourceIsStoredWithTheEntry(): void
    {
        $this->service()->record($this->request());

        self::assertSame('instagram', $this->store->inserted[0]['request']->utmSource);
        self::assertSame('toss-drop-2026-11', $this->store->inserted[0]['request']->utmCampaign);
    }

    // ─────────────────────────────────────────────────────────────
    // 2. 어뷰징 신호
    // ─────────────────────────────────────────────────────────────

    public function testThreeAccountsOnOneDeviceAreBlocked(): void
    {
        $this->store->deviceUsers = 3;

        $decision = $this->service()->record($this->request());

        self::assertSame(EntryStatus::RejectedAbuse, $decision->status);
        self::assertSame(50, $decision->abuseScore);
        self::assertContains(AbuseScorer::DEVICE_CLUSTER, $decision->reasons);
        self::assertTrue($decision->isAbusing());
    }

    public function testTwoAccountsOnOneDeviceAreFlaggedButNotBlocked(): void
    {
        $this->store->deviceUsers = 2;

        $decision = $this->service()->record($this->request());

        self::assertSame(EntryStatus::Accepted, $decision->status);
        self::assertSame(20, $decision->abuseScore, '가족이 한 기기를 쓰는 정상 사례를 막지 않기 위해 20점에 둔다.');
        self::assertContains(AbuseScorer::DEVICE_PAIR, $decision->reasons);
    }

    public function testPhoneReuseIsFlaggedButNotBlockedAlone(): void
    {
        $this->store->phoneUsers = 2;

        $decision = $this->service()->record($this->request(phoneHash: hash('sha256', '010-1000-0000')));

        self::assertSame(EntryStatus::Accepted, $decision->status);
        self::assertSame(30, $decision->abuseScore);
        self::assertContains(AbuseScorer::PHONE_REUSE, $decision->reasons);
    }

    public function testPhoneReusePlusDevicePairReachesBlockThreshold(): void
    {
        $this->store->phoneUsers = 2;
        $this->store->deviceUsers = 2;

        $decision = $this->service()->record($this->request(phoneHash: hash('sha256', '010-1000-0000')));

        self::assertSame(EntryStatus::RejectedAbuse, $decision->status);
        self::assertSame(50, $decision->abuseScore);
        self::assertCount(2, $decision->reasons);
    }

    public function testIpFloodIsFlagged(): void
    {
        $this->store->ipCount = 51;

        $decision = $this->service()->record($this->request());

        self::assertSame(40, $decision->abuseScore);
        self::assertContains(AbuseScorer::IP_FLOOD, $decision->reasons);
        self::assertSame(EntryStatus::Accepted, $decision->status, '단독으로는 40점이라 통과 — UA 이상이 겹쳐야 차단된다.');
    }

    public function testIpBurstUsesTheLowerWeight(): void
    {
        $this->store->ipCount = 21;

        $decision = $this->service()->record($this->request());

        self::assertSame(25, $decision->abuseScore);
        self::assertContains(AbuseScorer::IP_BURST, $decision->reasons);
        self::assertNotContains(AbuseScorer::IP_FLOOD, $decision->reasons);
    }

    public function testIpFloodPlusMissingUserAgentBlocks(): void
    {
        $this->store->ipCount = 51;

        $decision = $this->service()->record($this->request(withUserAgent: false));

        self::assertSame(50, $decision->abuseScore);
        self::assertSame(EntryStatus::RejectedAbuse, $decision->status);
        self::assertContains(AbuseScorer::UA_ANOMALY, $decision->reasons);
    }

    public function testMissingUserAgentAloneIsOnlyTenPoints(): void
    {
        $decision = $this->service()->record($this->request(withUserAgent: false));

        self::assertSame(10, $decision->abuseScore);
        self::assertSame(EntryStatus::Accepted, $decision->status);
    }

    public function testScoreIsCappedAtHundred(): void
    {
        $this->store->deviceUsers = 5;
        $this->store->phoneUsers = 3;
        $this->store->ipCount = 100;

        $decision = $this->service()->record($this->request(withUserAgent: false, phoneHash: hash('sha256', '010')));

        self::assertSame(100, $decision->abuseScore);
    }

    public function testBlockedVerdictAlwaysCarriesScoreOfAtLeastFifty(): void
    {
        // 스키마 CHECK(is_abusing = 0 OR abuse_score >= 50)와 코드가 어긋나면 INSERT가 터진다.
        $this->store->deviceUsers = 3;
        $this->service()->record($this->request());

        $verdict = $this->store->inserted[0]['verdict'];
        self::assertSame(EntryStatus::RejectedAbuse->value, $verdict['status']);
        self::assertGreaterThanOrEqual(50, $verdict['score']);
        self::assertContains(AbuseScorer::DEVICE_CLUSTER, $verdict['reasons']);
    }

    // ─────────────────────────────────────────────────────────────
    // 3. 레이트 리밋
    // ─────────────────────────────────────────────────────────────

    public function testRateLimitRejectsAfterBucketIsExhausted(): void
    {
        $service = $this->service(new TokenBucketLimiter(2, 0.1));

        $first = $service->record($this->request(key: 'e1'));
        $second = $service->record($this->request(user: 'user-2', key: 'e2'));
        // 앞선 두 건이 같은 기기였더라도, 이 케이스는 "레이트 리밋만"의 효과를 본다.
        $this->store->deviceUsers = 0;
        $third = $service->record($this->request(user: 'user-3', key: 'e3'));

        self::assertTrue($first->isAccepted());
        self::assertTrue($second->isAccepted());
        self::assertSame(EntryStatus::RejectedRateLimit, $third->status);
        self::assertContains(AbuseScorer::RATE_LIMIT, $third->reasons);
        self::assertTrue($third->persisted, '리밋 거절도 기록해야 어뷰징 분포가 보인다.');
    }

    public function testRateLimitPlusDeviceClusterBlocksAsAbuse(): void
    {
        $service = $this->service(new TokenBucketLimiter(1, 0.01));
        $service->record($this->request(key: 'e1'));

        $this->store->deviceUsers = 2; // 20점
        $decision = $service->record($this->request(user: 'user-2', key: 'e2'));

        self::assertSame(55, $decision->abuseScore);
        self::assertSame(EntryStatus::RejectedAbuse, $decision->status);
    }

    public function testTokenBucketRefillsOverTime(): void
    {
        $limiter = new TokenBucketLimiter(1, 1.0);

        self::assertTrue($limiter->attempt('ip', $this->clock->now()));
        self::assertFalse($limiter->attempt('ip', $this->clock->now()));

        $this->clock->advanceSeconds(1);
        self::assertTrue($limiter->attempt('ip', $this->clock->now()), '1초 뒤 토큰 1개가 보충되어야 합니다.');
    }

    // ─────────────────────────────────────────────────────────────
    // 4. 중복 응모
    // ─────────────────────────────────────────────────────────────

    public function testDuplicateEntryIsReportedWithoutPersistingASecondRow(): void
    {
        $this->store->rejectInsertAsDuplicate = true;

        $decision = $this->service()->record($this->request());

        self::assertSame(EntryStatus::RejectedDuplicate, $decision->status);
        self::assertFalse($decision->persisted);
        self::assertContains('DUPLICATE_ENTRY', $decision->reasons);
        self::assertCount(0, $this->store->inserted);
    }

    // ─────────────────────────────────────────────────────────────
    // 5. 식별자·지연·구간
    // ─────────────────────────────────────────────────────────────

    public function testEntryRefIsStableUuidV4(): void
    {
        $a = EventTrackingService::uuidV4('seed-1');
        $b = EventTrackingService::uuidV4('seed-1');
        $c = EventTrackingService::uuidV4('seed-2');

        self::assertSame($a, $b, '같은 요청은 같은 응모 ID를 가져야 재전송 응답이 흔들리지 않습니다.');
        self::assertNotSame($a, $c);
        self::assertMatchesRegularExpression('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/', $a);
    }

    public function testLatencyIsComputedFromGatewayReceipt(): void
    {
        $received = new \DateTimeImmutable('2026-11-20T20:00:00.850+09:00');
        $this->clock = MutableClock::at('2026-11-20T20:00:01+09:00');

        $decision = $this->service()->record($this->request(receivedAt: $received));

        self::assertSame(150, $decision->latencyMs);
    }

    public function testWindowUsesServerClockOnly(): void
    {
        $service = $this->service();
        $start = new \DateTimeImmutable('2026-11-20T20:00:00+09:00');
        $end = new \DateTimeImmutable('2026-11-20T22:00:00+09:00');

        self::assertTrue($service->isWithinWindow($start, $end));

        $this->clock->set('2026-11-20T22:00:00+09:00');
        self::assertFalse($service->isWithinWindow($start, $end), '구간은 [start, end) — 종료 시각은 이미 밖입니다.');
    }

    public function testReasonsAreExplainedInKorean(): void
    {
        $scorer = new AbuseScorer();

        self::assertSame('특이 신호 없음', $scorer->explain([]));
        self::assertSame(
            '같은 기기에서 3명 이상 응모 · IP당 요청 폭주(50건/10초 초과)',
            $scorer->explain([AbuseScorer::DEVICE_CLUSTER, AbuseScorer::IP_FLOOD]),
        );
    }

    public function testScorerThresholdMatchesDatabaseConstraint(): void
    {
        $scorer = new AbuseScorer();

        self::assertFalse($scorer->isBlocked(49));
        self::assertTrue($scorer->isBlocked(50));
        self::assertSame(50, AbuseScorer::BLOCK_THRESHOLD);
    }
}
