<?php

declare(strict_types=1);

namespace SellerScope\Tests\Services;

use PHPUnit\Framework\TestCase;
use SellerScope\Domain\MarketChannel;
use SellerScope\Domain\OrderStatus;
use SellerScope\Domain\SettlementRow;
use SellerScope\Sens\SensConfig;
use SellerScope\Services\NaverCloudSensService;
use SellerScope\Services\SettlementAlertComposer;
use SellerScope\Services\SettlementAlertNotifier;
use SellerScope\Services\SettlementReconciliationService;
use SellerScope\Tests\Support\FakeAlimtalkLogStore;
use SellerScope\Tests\Support\FixedClock;
use SellerScope\Tests\Support\StubHttpClient;

/**
 * 알림 오케스트레이션 테스트.
 *
 * 지키려는 세 가지 성질
 *   1) 같은 이상은 두 번 알리지 않는다 (dedupe)
 *   2) 심각(critical)만 보낸다 (info/warning은 콘솔에서 본다)
 *   3) 알림 실패가 대사 결과를 망치지 않는다 (예외를 밖으로 던지지 않는다)
 */
final class SettlementAlertNotifierTest extends TestCase
{
    private FixedClock $clock;
    private SettlementReconciliationService $engine;

    protected function setUp(): void
    {
        $this->clock = FixedClock::at('2026-11-11T09:30:00+09:00');
        $this->engine = new SettlementReconciliationService();
    }

    private function config(): SensConfig
    {
        return new SensConfig(
            accessKey: 'ACCESSKEY123',
            secretKey: 'SECRETKEY456',
            serviceId: 'ncp:kkobizmsg:kr:1234567890:sens',
            plusFriendId: '@sellerscope',
            anomalyTemplateCode: 'SS_ANOMALY_CRITICAL',
            summaryTemplateCode: 'SS_BATCH_SUMMARY',
        );
    }

    private function notifier(StubHttpClient $http, FakeAlimtalkLogStore $store): SettlementAlertNotifier
    {
        return new SettlementAlertNotifier(
            new NaverCloudSensService($http, $this->config(), $this->clock),
            $store,
            new SettlementAlertComposer(),
            $this->config(),
            $this->clock,
        );
    }

    private function overcharged(string $orderNo): \SellerScope\Domain\ReconciledRow
    {
        return $this->engine->reconcileRow(new SettlementRow(
            orderNo: $orderNo,
            channel: MarketChannel::SmartStore,
            orderDate: new \DateTimeImmutable('2026-10-03'),
            productName: '원목 미니 서랍',
            sku: 'SKU-DRW-03',
            quantity: 2,
            paidAmount: 50_000,
            commission: 3_300,
            shippingDeduction: 3_000,
            returnFee: 0,
            settledAmount: 43_700,
            status: OrderStatus::Shipped,
            unitCost: 15_000,
            sellerShippingCost: 2_600,
        ));
    }

    public function testCriticalAnomalyIsSentOnce(): void
    {
        $http = (new StubHttpClient())->queueJson(202, ['requestId' => 'R1', 'statusCode' => '202', 'statusName' => 'accepted']);
        $store = new FakeAlimtalkLogStore();

        $outcome = $this->notifier($http, $store)->notifyCriticalAnomalies(
            1,
            '숭구리커머스',
            'batch-1',
            '01012345678',
            [$this->overcharged('A-1')],
        );

        self::assertSame(1, $outcome['sent']);
        self::assertSame(0, $outcome['failed']);
        self::assertCount(1, $http->requests);
        self::assertCount(1, $store->accepted);
    }

    public function testAlreadySentAnomalyIsSkippedWithoutCallingTheApi(): void
    {
        $http = new StubHttpClient(); // 응답을 준비하지 않는다 → 호출되면 예외
        $store = new FakeAlimtalkLogStore([
            'anomaly:1:smartstore:A-1:FEE_OVERCHARGE',
        ]);

        $outcome = $this->notifier($http, $store)->notifyCriticalAnomalies(
            1,
            '숭구리커머스',
            'batch-2',
            '01012345678',
            [$this->overcharged('A-1')],
        );

        self::assertSame(0, $outcome['sent']);
        self::assertSame(1, $outcome['skipped']);
        self::assertSame([], $http->requests);
    }

    public function testInformationLevelAnomaliesAreNotSentByKakao(): void
    {
        // 초과 입금(info)만 있는 행 — 알림 대상이 아니다.
        $row = $this->engine->reconcileRow(new SettlementRow(
            orderNo: 'A-2',
            channel: MarketChannel::SmartStore,
            orderDate: new \DateTimeImmutable('2026-10-03'),
            productName: '정상 상품',
            sku: 'SKU-OK',
            quantity: 1,
            paidAmount: 20_000,
            commission: 726,
            shippingDeduction: 3_000,
            returnFee: 0,
            settledAmount: 17_000,
            status: OrderStatus::Shipped,
            unitCost: 8_000,
            sellerShippingCost: 2_600,
        ));

        $http = new StubHttpClient();
        $outcome = $this->notifier($http, new FakeAlimtalkLogStore())->notifyCriticalAnomalies(
            1,
            '숭구리커머스',
            'batch-3',
            '01012345678',
            [$row],
        );

        self::assertSame(0, $outcome['sent']);
        self::assertSame([], $http->requests);
    }

    public function testApiFailureIsRecordedButDoesNotAbortTheBatch(): void
    {
        $http = (new StubHttpClient())->queueResponse(500, 'internal error');
        $store = new FakeAlimtalkLogStore();

        $outcome = $this->notifier($http, $store)->notifyCriticalAnomalies(
            1,
            '숭구리커머스',
            'batch-4',
            '01012345678',
            [$this->overcharged('A-3')],
        );

        self::assertSame(0, $outcome['sent']);
        self::assertSame(1, $outcome['failed']);
        self::assertCount(1, $store->failures);
        self::assertStringContainsString('SENS API 호출 실패', $store->failures[0]['error']);
    }

    public function testNetworkExceptionIsAlsoContained(): void
    {
        $http = (new StubHttpClient())->queueThrowable(new \RuntimeException('connection reset'));
        $store = new FakeAlimtalkLogStore();

        $outcome = $this->notifier($http, $store)->notifyCriticalAnomalies(
            1,
            '숭구리커머스',
            'batch-5',
            '01012345678',
            [$this->overcharged('A-4')],
        );

        self::assertSame(1, $outcome['failed']);
        self::assertCount(1, $store->failures);
    }

    public function testBatchSummaryIsSentOncePerBatch(): void
    {
        $http = (new StubHttpClient())->queueJson(202, ['requestId' => 'S1', 'statusCode' => '202', 'statusName' => 'accepted']);
        $store = new FakeAlimtalkLogStore();
        $summary = $this->engine->summarize([$this->overcharged('A-5')]);

        $notifier = $this->notifier($http, $store);

        self::assertTrue($notifier->notifyBatchSummary(1, '숭구리커머스', 'batch-6', '01012345678', $summary, '2026-10 배치'));
        // 같은 배치를 다시 알리지 않는다 (이미 준비된 응답이 소진되면 Stub이 예외를 던진다).
        self::assertFalse($notifier->notifyBatchSummary(1, '숭구리커머스', 'batch-6', '01012345678', $summary, '2026-10 배치'));
        self::assertCount(1, $http->requests);
    }
}
