<?php

declare(strict_types=1);

namespace SellerScope\Tests\Services;

use PHPUnit\Framework\TestCase;
use SellerScope\Domain\AnomalyType;
use SellerScope\Domain\OrderStatus;
use SellerScope\Domain\SettlementRow;
use SellerScope\Services\SettlementAlertComposer;
use SellerScope\Services\SettlementReconciliationService;

final class SettlementAlertComposerTest extends TestCase
{
    private SettlementAlertComposer $composer;
    private SettlementReconciliationService $engine;

    protected function setUp(): void
    {
        $this->composer = new SettlementAlertComposer('https://sellerscope.example.com/reconciliation');
        $this->engine = new SettlementReconciliationService();
    }

    private function overchargedRow(string $orderNo = '20261001-0000003'): \SellerScope\Domain\ReconciledRow
    {
        return $this->engine->reconcileRow(new SettlementRow(
            orderNo: $orderNo,
            channel: \SellerScope\Domain\MarketChannel::SmartStore,
            orderDate: new \DateTimeImmutable('2026-10-03'),
            productName: '원목 미니 서랍 (월넛)',
            sku: 'SKU-DRW-03',
            quantity: 2,
            paidAmount: 50_000,
            commission: 3_300,
            shippingDeduction: 3_000,
            returnFee: 0,
            settledAmount: 43_700,
            status: OrderStatus::Shipped,
            unitCost: 21_000,
            sellerShippingCost: 2_600,
        ));
    }

    public function testAnomalyContentFollowsRegisteredTemplateVariables(): void
    {
        $row = $this->overchargedRow();
        $anomaly = $row->anomalies[0];

        $content = $this->composer->contentForAnomaly('숭구리커머스', $row, $anomaly);

        self::assertStringContainsString('[숭구리커머스] 정산 이상 감지 - 수수료 과다청구', $content);
        self::assertStringContainsString('주문 20261001-0000003', $content);
        self::assertStringContainsString('기대 1,815원 / 정산 3,300원', $content);
        self::assertStringContainsString('추정 손실 1,485원', $content);
        self::assertStringContainsString('정산 담당자 확인이 필요합니다.', $content);
        self::assertLessThanOrEqual(1000, mb_strlen($content));
    }

    public function testVariableValuesAreFlattenedToOneLine(): void
    {
        $row = $this->engine->reconcileRow(new SettlementRow(
            orderNo: '20261001-0000004',
            channel: \SellerScope\Domain\MarketChannel::Coupang,
            orderDate: new \DateTimeImmutable('2026-10-04'),
            productName: "멀티\n라인   상품명",
            sku: 'SKU-MULTI',
            quantity: 1,
            paidAmount: 20_000,
            commission: 2_700,
            shippingDeduction: 0,
            returnFee: 0,
            settledAmount: 16_000,
            status: OrderStatus::Shipped,
            unitCost: 5_000,
            sellerShippingCost: 2_900,
        ));

        $content = $this->composer->contentForAnomaly('쿠팡셀러', $row, $row->anomalies[0]);

        self::assertStringContainsString('멀티 라인 상품명', $content);
        // 변수 안에 개행이 남으면 알림톡 템플릿 대조에서 어긋난다.
        self::assertStringNotContainsString('멀티' . "\n" . '라인', $content);
    }

    public function testLongTextIsTruncatedWithEllipsis(): void
    {
        $row = $this->engine->reconcileRow(new SettlementRow(
            orderNo: '20261001-0000005',
            channel: \SellerScope\Domain\MarketChannel::SmartStore,
            orderDate: new \DateTimeImmutable('2026-10-04'),
            productName: str_repeat('아주 긴 상품명 ', 12),
            sku: 'SKU-LONG',
            quantity: 1,
            paidAmount: 30_000,
            commission: 2_500,
            shippingDeduction: 3_000,
            returnFee: 0,
            settledAmount: 24_500,
            status: OrderStatus::Shipped,
            unitCost: 10_000,
            sellerShippingCost: 2_600,
        ));

        $content = $this->composer->contentForAnomaly('숭구리', $row, $row->anomalies[0]);

        self::assertStringContainsString('…', $content);
        self::assertLessThanOrEqual(1000, mb_strlen($content));
    }

    public function testSummaryContentIncludesTotalsAndTopCause(): void
    {
        $reconciled = [$this->overchargedRow('A-1'), $this->overchargedRow('A-2')];
        $summary = $this->engine->summarize($reconciled);

        $content = $this->composer->contentForSummary('숭구리커머스', $summary, '2026-10 배치');

        self::assertStringContainsString('[숭구리커머스] 정산 대사 완료(2026-10 배치)', $content);
        self::assertStringContainsString('대상 2건 · 이상 2건', $content);
        self::assertStringContainsString('추정 손실 2,970원', $content);
        self::assertStringContainsString('최대 원인 수수료 초과 청구 2,970원', $content);
        self::assertStringContainsString('https://sellerscope.example.com/reconciliation', $content);
    }

    public function testSummaryWithoutAnyLossSaysNone(): void
    {
        $row = $this->engine->reconcileRow(new SettlementRow(
            orderNo: 'B-1',
            channel: \SellerScope\Domain\MarketChannel::SmartStore,
            orderDate: new \DateTimeImmutable('2026-10-01'),
            productName: '정상 상품',
            sku: 'SKU-OK',
            quantity: 1,
            paidAmount: 29_900,
            commission: 1_085,
            shippingDeduction: 3_000,
            returnFee: 0,
            settledAmount: 25_815,
            status: OrderStatus::Shipped,
            unitCost: 10_000,
            sellerShippingCost: 2_600,
        ));

        $content = $this->composer->contentForSummary('숭구리', $this->engine->summarize([$row]), '2026-10 배치');

        self::assertStringContainsString('최대 원인 없음', $content);
        self::assertStringContainsString('이상 0건', $content);
    }

    public function testDedupeKeyIsStableAndScopedToTenantAndOrder(): void
    {
        $row = $this->overchargedRow();

        $first = $this->composer->dedupeKeyForAnomaly(7, $row, AnomalyType::FeeOvercharge);
        $second = $this->composer->dedupeKeyForAnomaly(7, $row, AnomalyType::FeeOvercharge);
        $otherTenant = $this->composer->dedupeKeyForAnomaly(8, $row, AnomalyType::FeeOvercharge);

        self::assertSame($first, $second);
        self::assertNotSame($first, $otherTenant);
        self::assertSame('anomaly:7:smartstore:20261001-0000003:FEE_OVERCHARGE', $first);
    }

    public function testSummaryDedupeKeyIsPerBatch(): void
    {
        self::assertSame('summary:7:batch-1', $this->composer->dedupeKeyForSummary(7, 'batch-1'));
    }
}
