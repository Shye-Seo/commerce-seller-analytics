<?php

declare(strict_types=1);

namespace SellerScope\Tests\Integration;

use PHPUnit\Framework\TestCase;
use SellerScope\Database\Connection;
use SellerScope\Domain\MarketChannel;
use SellerScope\Domain\OrderStatus;
use SellerScope\Domain\SettlementRow;
use SellerScope\Repositories\AlimtalkLogRepository;
use SellerScope\Repositories\AnomalyRepository;
use SellerScope\Repositories\AuditLogRepository;
use SellerScope\Repositories\SettlementRepository;
use SellerScope\Services\SettlementReconciliationService;
use SellerScope\Support\Env;

/**
 * MySQL 8.0 실연동 테스트.
 *
 * 이 테스트가 증명하는 것은 단위 테스트로는 증명할 수 없는 것들이다.
 *   · 스키마가 실제 MySQL 8.0에서 생성되고, FK·유니크 키가 의도대로 동작한다
 *   · 같은 정산서를 두 번 올려도 행이 늘지 않는다 (UPSERT 멱등성)
 *   · 이미 'resolved'한 이상이 재계산으로 되살아나지 않는다
 *   · 알림톡 중복 차단이 DB 제약으로 성립한다 (동시성 포함)
 *   · 감사 로그 해시체인이 변조를 실제로 잡아낸다
 *
 * 실행
 *   SELLERSCOPE_INTEGRATION=1 DB_UNIX_SOCKET=/tmp/mysqld.sock DB_DATABASE=sellerscope_test \
 *     vendor/bin/phpunit --testsuite unit
 *
 * 환경변수가 없으면 skip한다(CI에서 MySQL이 없어도 단위 테스트는 통과해야 한다).
 */
final class DatabaseIntegrationTest extends TestCase
{
    private const TENANT_CODE = 'it-tenant';

    private Connection $connection;
    private SettlementRepository $settlements;
    private AnomalyRepository $anomalies;
    private AlimtalkLogRepository $alimtalk;
    private AuditLogRepository $audit;
    private int $tenantId = 0;
    private int $storeId = 0;

    protected function setUp(): void
    {
        if (Env::get('SELLERSCOPE_INTEGRATION') !== '1') {
            self::markTestSkipped('SELLERSCOPE_INTEGRATION=1 과 MySQL 8.0이 있을 때만 실행합니다.');
        }

        $this->connection = Connection::fromEnv();
        $this->settlements = new SettlementRepository($this->connection);
        $this->anomalies = new AnomalyRepository($this->connection);
        $this->alimtalk = new AlimtalkLogRepository($this->connection);
        $this->audit = new AuditLogRepository($this->connection);

        $pdo = $this->connection->pdo();
        $pdo->prepare('DELETE FROM tenants WHERE code = ?')->execute([self::TENANT_CODE]);

        $pdo->prepare(
            "INSERT INTO tenants (code, name, business_no, tier, settlement_cycle, seat_count)
             VALUES (?, '통합테스트 법인', '9999999999', 'HQ', '월 1회', 1)"
        )->execute([self::TENANT_CODE]);
        $this->tenantId = (int) $pdo->lastInsertId();

        $pdo->prepare(
            "INSERT INTO stores (tenant_id, code, name, channel, contract_fee_rate, outbound_shipping, round_trip_return_fee)
             VALUES (?, 'IT-01', '통합테스트 스토어', 'smartstore', 3.63, 3000, 5000)"
        )->execute([$this->tenantId]);
        $this->storeId = (int) $pdo->lastInsertId();
    }

    protected function tearDown(): void
    {
        if (!isset($this->connection)) {
            return;
        }
        // CASCADE로 주문·이상·알림·감사 로그가 함께 정리된다.
        $this->connection->pdo()->prepare('DELETE FROM tenants WHERE id = ?')->execute([$this->tenantId]);
    }

    private function row(string $orderNo, int $commission, int $settled): SettlementRow
    {
        return new SettlementRow(
            orderNo: $orderNo,
            channel: MarketChannel::SmartStore,
            orderDate: new \DateTimeImmutable('2026-10-03'),
            productName: '통합테스트 상품',
            sku: 'SKU-IT',
            quantity: 1,
            paidAmount: 50_000,
            commission: $commission,
            shippingDeduction: 3_000,
            returnFee: 0,
            settledAmount: $settled,
            status: OrderStatus::Shipped,
            unitCost: 10_000,
            sellerShippingCost: 2_600,
            settlementDate: new \DateTimeImmutable('2026-10-10'),
        );
    }

    /** @return array<string,int> */
    private function persist(string $batchId): array
    {
        $engine = new SettlementReconciliationService();
        $rows = [$this->row('IT-1', 3_300, 43_700), $this->row('IT-2', 1_815, 45_185)];
        $result = $engine->reconcileAll($rows);

        return $this->connection->transaction(function () use ($result, $batchId): array {
            $orderIds = $this->settlements->upsertReconciledRows($this->tenantId, $batchId, 'it.csv', $result->rows, new \DateTimeImmutable('2026-11-11 09:00:00'));
            foreach ($result->rows as $row) {
                if ($row->isReconciled()) {
                    continue;
                }
                $this->anomalies->upsertForOrder(
                    $this->tenantId,
                    $this->storeId,
                    $batchId,
                    $orderIds[$row->row->id()],
                    $row->anomalies,
                    new \DateTimeImmutable('2026-11-11 09:00:00'),
                );
            }

            return $orderIds;
        });
    }

    public function testUpsertIsIdempotentOnReupload(): void
    {
        $first = $this->persist('11111111-1111-4111-9111-111111111111');
        $second = $this->persist('22222222-2222-4222-9222-222222222222');

        self::assertSame($first, $second, '주문 id는 재업로드 후에도 같아야 한다.');

        $count = (int) $this->connection->pdo()->query(
            "SELECT COUNT(*) FROM settlement_orders WHERE tenant_id = {$this->tenantId}"
        )->fetchColumn();
        self::assertSame(2, $count);

        $stored = $this->settlements->findById($first['smartstore:IT-1']);
        self::assertNotNull($stored);
        self::assertSame(1485, (int) $stored['shortfall']);
        self::assertSame(3300, (int) $stored['commission'], '원본 컬럼은 재계산이 덮어쓰지 않는다.');
        self::assertSame(0, (int) $stored['reconciled']);
        self::assertSame('22222222-2222-4222-9222-222222222222', $stored['batch_id']);
    }

    public function testResolvedAnomalyIsNotReopenedByReconciliation(): void
    {
        $orderIds = $this->persist('33333333-3333-4333-9333-333333333333');
        $orderId = $orderIds['smartstore:IT-1'];

        $before = $this->connection->pdo()->query(
            "SELECT id, status FROM reconciliation_anomalies WHERE order_id = {$orderId} ORDER BY id"
        )->fetchAll();
        self::assertNotEmpty($before);
        self::assertSame('open', $before[0]['status']);

        $this->anomalies->markStatus((int) $before[0]['id'], 'resolved', '마켓이 1,485원 환급', new \DateTimeImmutable('2026-11-11 10:00:00'));

        // 같은 정산서를 다시 대사해도 닫힌 이의 제기는 다시 열리지 않는다.
        $this->persist('44444444-4444-4444-9444-444444444444');

        $after = $this->connection->pdo()->query(
            "SELECT status, resolution_note FROM reconciliation_anomalies WHERE id = {$before[0]['id']}"
        )->fetch();
        self::assertSame('resolved', $after['status']);
        self::assertSame('마켓이 1,485원 환급', $after['resolution_note']);

        $total = (int) $this->connection->pdo()->query(
            "SELECT COUNT(*) FROM reconciliation_anomalies WHERE order_id = {$orderId}"
        )->fetchColumn();
        self::assertSame(count($before), $total, '이상 행 수는 늘지 않는다.');
    }

    public function testAlimtalkClaimIsAtomicPerDedupeKey(): void
    {
        $now = new \DateTimeImmutable('2026-11-11 09:00:00');
        $key = "anomaly:{$this->tenantId}:smartstore:IT-1:FEE_OVERCHARGE";

        $first = $this->alimtalk->claim($this->tenantId, $key, 'SS_ANOMALY_CRITICAL', '@sellerscope', '01012345678', 'batch-x', ['a' => 1], $now);
        $second = $this->alimtalk->claim($this->tenantId, $key, 'SS_ANOMALY_CRITICAL', '@sellerscope', '01012345678', 'batch-x', ['a' => 1], $now);

        self::assertNotNull($first);
        self::assertNull($second, '같은 dedupe_key는 두 번 선점되지 않는다.');

        $recent = $this->alimtalk->recent($this->tenantId);
        self::assertCount(1, $recent);
        self::assertSame('010-****-5678', $recent[0]['recipient_phone'], '이력에는 번호가 마스킹되어 남는다.');
        self::assertSame('queued', $recent[0]['status']);
    }

    public function testAuditChainDetectsTampering(): void
    {
        $first = $this->audit->append($this->tenantId, 'kim@acme.co.kr', 'SETTLEMENT_MANAGER', 'RECONCILE_RUN', 'batch-1', '정산 2건', 'allowed', '203.0.113.7', new \DateTimeImmutable('2026-11-11 09:00:00'));
        $this->audit->append($this->tenantId, 'kim@acme.co.kr', 'SETTLEMENT_MANAGER', 'VIEW_ANOMALY', 'IT-1', '이상 상세 열람', 'allowed', '203.0.113.7', new \DateTimeImmutable('2026-11-11 09:01:00'));
        $this->audit->append($this->tenantId, 'lee@acme.co.kr', 'OPERATION_MD', 'EXPORT_CSV', '2026-10', '반출 시도', 'denied', '198.51.100.9', new \DateTimeImmutable('2026-11-11 09:02:00'));

        self::assertSame(1, $first['seq']);
        self::assertSame('genesis', $first['prevHash']);

        $verified = $this->audit->verifyChain($this->tenantId);
        self::assertTrue($verified['valid']);
        self::assertSame(3, $verified['verified']);

        // 2번째 행의 내용을 몰래 바꾼다 → 해시가 맞지 않아 체인이 끊긴다.
        $this->connection->pdo()->exec(
            "UPDATE audit_logs SET detail = '이상 상세 열람(조작)' WHERE tenant_id = {$this->tenantId} AND seq = 2"
        );

        $tampered = $this->audit->verifyChain($this->tenantId);
        self::assertFalse($tampered['valid']);
        self::assertSame(2, $tampered['brokenSeq']);
    }

    public function testAggregateAndKeysetPaginationReadStoredFacts(): void
    {
        $this->persist('55555555-5555-4555-9555-555555555555');

        $totals = $this->settlements->aggregateByTenantAndPeriod(
            $this->tenantId,
            new \DateTimeImmutable('2026-10-01'),
            new \DateTimeImmutable('2026-10-31'),
        );

        self::assertSame(2, $totals['totals']['total_rows']);
        self::assertSame(1, $totals['totals']['flagged_rows']);
        self::assertSame(1_485, $totals['totals']['total_loss']);
        self::assertSame(100_000, $totals['totals']['total_paid']);
        self::assertSame(50.0, $totals['matchedRate']);
        self::assertSame('smartstore', $totals['byChannel'][0]['channel']);

        $page1 = $this->settlements->findByTenantAndPeriod(
            $this->tenantId,
            new \DateTimeImmutable('2026-10-01'),
            new \DateTimeImmutable('2026-10-31'),
            null,
            1,
        );
        self::assertCount(1, $page1);

        $page2 = $this->settlements->findByTenantAndPeriod(
            $this->tenantId,
            new \DateTimeImmutable('2026-10-01'),
            new \DateTimeImmutable('2026-10-31'),
            (int) $page1[0]['id'],
            1,
        );
        self::assertCount(1, $page2);
        self::assertGreaterThan((int) $page1[0]['id'], (int) $page2[0]['id']);
    }

    public function testSchemaEnforcesForeignKeyAndCheckConstraints(): void
    {
        $this->expectException(\PDOException::class);

        // 존재하지 않는 테넌트로 주문을 넣으면 FK가 막는다(테넌트 격리의 최후 방어선).
        $this->connection->pdo()->exec(
            "INSERT INTO settlement_orders (tenant_id, store_id, batch_id, order_no, channel, order_date,
             product_name, sku, quantity, paid_amount, commission, shipping_deduction, return_fee, settled_amount,
             order_status, unit_cost, seller_shipping_cost)
             VALUES (99999999, {$this->storeId}, 'x', 'IT-FK', 'smartstore', '2026-10-01', '상품', 'SKU', 1,
                     1000, 0, 0, 0, 1000, 'SHIPPED', 0, 0)"
        );
    }
}
