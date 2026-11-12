#!/usr/bin/env php
<?php

declare(strict_types=1);

/**
 * 쿠폰 원장 10만 건 벤치마크(로컬 MySQL 8.0).
 *
 * 사용
 *   php backend/bin/coupon-ledger-bench.php --rows=100000
 *
 * 이 스크립트가 답하는 질문
 *   1) 원장 10만 건을 실제로 넣을 수 있는가(제약·인덱스가 버티는가)
 *   2) 대시보드가 쓰는 집계 쿼리(상태별 건수·캠페인 소진율)가 인덱스만 타는가
 *   3) 멱등 키 조회·만료 스윕 조회가 10만 건에서 몇 ms인가
 *
 * 왜 필요한가: "10만 건을 다룰 수 있다"는 말은 숫자를 넣어 봐야 증명된다. 단위 테스트는
 * 로직을 고정하지만 행 수에 따른 인덱스 동작은 보여주지 못한다.
 */

require __DIR__ . '/../vendor/autoload.php';

use SellerScope\Database\Connection;
use SellerScope\Support\Env;

Env::load(__DIR__ . '/../.env');

$options = getopt('', ['rows::', 'keep']);
$rows = (int) ($options['rows'] ?? 100_000);
$connection = Connection::fromEnv();
$pdo = $connection->pdo();

$pdo->exec("DELETE FROM promotional_campaigns WHERE code LIKE 'bench-%'");
$tenantId = (int) ($pdo->query("SELECT id FROM tenants ORDER BY id LIMIT 1")->fetchColumn() ?: 0);
if ($tenantId === 0) {
    $pdo->exec("INSERT INTO tenants (code, name, tier) VALUES ('bench-tenant', '벤치 법인', 'HQ')");
    $tenantId = (int) $pdo->lastInsertId();
}

$code = 'bench-' . date('YmdHis');
$pdo->prepare(
    "INSERT INTO promotional_campaigns
       (tenant_id, code, name, campaign_type, partner_name, reward_budget, token_budget,
        min_guaranteed_margin, expected_peak_tps, starts_at, ends_at, status)
     VALUES (:t, :c, '원장 벤치', 'TOSS_STYLE_DROP', 'bench', 0, :rows, 0, 5000,
             NOW() - INTERVAL 1 HOUR, NOW() + INTERVAL 1 HOUR, 'live')",
)->execute(['t' => $tenantId, 'c' => $code, 'rows' => $rows]);
$campaignId = (int) $pdo->lastInsertId();

$pdo->prepare(
    "INSERT INTO coupon_templates
       (campaign_id, code, name, discount_type, discount_amount, min_order_amount, funded_by, is_active)
     VALUES (:c, 'bench-3000', '벤치 3,000원', 'FIXED', 3000, 30000, 'PARTNER', 1)",
)->execute(['c' => $campaignId]);
$templateId = (int) $pdo->lastInsertId();

$pdo->prepare(
    'INSERT INTO coupon_inventories (campaign_id, coupon_template_id, total_qty, remaining_qty)
     VALUES (:c, :t, :rows, :remaining)',
)->execute(['c' => $campaignId, 't' => $templateId, 'rows' => $rows, 'remaining' => $rows]);

// RECURSIVE CTE 기본 상한은 1,000행이다. 배치 크기만큼 올려 준다(세션 한정).
$pdo->exec('SET SESSION cte_max_recursion_depth = 10000');

// 배치 INSERT: 한 문장에 5,000행씩. 행마다 INSERT하면 10만 RTT가 걸린다.
$startedAt = microtime(true);
$batch = 5_000;
for ($offset = 0; $offset < $rows; $offset += $batch) {
    $pdo->exec(
        "INSERT INTO issued_coupons
           (tenant_id, campaign_id, coupon_template_id, user_hash, coupon_code, coupon_hash,
            status, discount_amount, order_amount, idempotency_key, issued_at, expires_at,
            reserved_at, redeemed_at, settled_at)
         WITH RECURSIVE seq AS (SELECT 0 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < " . ($batch - 1) . ")
         SELECT {$tenantId}, {$campaignId}, {$templateId},
                SHA2(CONCAT('bench-user-', {$offset} + n), 256),
                CONCAT(SUBSTR(MD5(CONCAT('bench-', {$offset} + n)), 1, 4), '********',
                       SUBSTR(MD5(CONCAT('bench-', {$offset} + n)), 29, 4)),
                SHA2(CONCAT('bench-code-', {$offset} + n), 256),
                CASE WHEN n % 10 = 0 THEN 'SETTLED'
                     WHEN n % 5 = 0 THEN 'REDEEMED'
                     WHEN n % 17 = 0 THEN 'CANCELLED'
                     ELSE 'ISSUED' END,
                3000,
                CASE WHEN n % 5 = 0 THEN 32000 ELSE 0 END,
                CONCAT('bench-idem-', {$offset} + n),
                NOW(3) - INTERVAL n SECOND,
                NOW(3) + INTERVAL 15 MINUTE,
                CASE WHEN n % 17 <> 0 THEN NOW(3) - INTERVAL n SECOND + INTERVAL 1 MINUTE END,
                CASE WHEN n % 5 = 0 THEN NOW(3) - INTERVAL n SECOND + INTERVAL 3 MINUTE END,
                CASE WHEN n % 10 = 0 THEN NOW(3) - INTERVAL n SECOND + INTERVAL 5 MINUTE END
         FROM seq",
    );
}

$insertSeconds = microtime(true) - $startedAt;
printf("원장 %s행 삽입: %.2fs (%.0f rows/s, 배치 %d)\n", number_format($rows), $insertSeconds, $rows / $insertSeconds, $batch);

/** 한 쿼리의 실행 시간(ms)과 실행 계획 요약. */
function bench(PDO $pdo, string $label, string $sql, array $params = []): void
{
    $started = microtime(true);
    $statement = $pdo->prepare($sql);
    $statement->execute($params);
    $rows = count($statement->fetchAll());
    $ms = (microtime(true) - $started) * 1000;

    $plan = $pdo->prepare('EXPLAIN ' . $sql);
    $plan->execute($params);
    $access = implode(' | ', array_map(
        static fn (array $row): string => ($row['key'] ?? 'NULL') . ' (' . ($row['type'] ?? '?') . ')',
        $plan->fetchAll(),
    ));

    printf("%-34s %8.2f ms · %7d행 · %s\n", $label, $ms, $rows, $access);
}

bench($pdo, '상태별 건수(캠페인)', 'SELECT status, COUNT(*) c FROM issued_coupons WHERE campaign_id = :c GROUP BY status', ['c' => $campaignId]);
bench($pdo, '소진율 집계', "SELECT COUNT(*) FROM issued_coupons WHERE campaign_id = :c AND status NOT IN ('CANCELLED','EXPIRED')", ['c' => $campaignId]);
bench($pdo, '멱등 키 조회', 'SELECT * FROM issued_coupons WHERE idempotency_key = :k', ['k' => 'bench-idem-' . (int) ($rows / 2)]);
bench($pdo, '해시 조회(코드 검증)', 'SELECT * FROM issued_coupons WHERE coupon_hash = :h', ['h' => hash('sha256', 'bench-code-' . (int) ($rows / 3))]);
bench($pdo, '만료 스윕(10초 주기)', "SELECT id FROM issued_coupons WHERE status IN ('ISSUED','RESERVED') AND expires_at < :now LIMIT 500", ['now' => (new DateTimeImmutable('+30 minutes'))->format('Y-m-d H:i:s.v')]);
bench($pdo, '법인+상태 타임라인', 'SELECT COUNT(*) FROM issued_coupons WHERE tenant_id = :t AND status = :s AND issued_at >= :since', ['t' => $tenantId, 's' => 'SETTLED', 'since' => (new DateTimeImmutable('-1 day'))->format('Y-m-d H:i:s.v')]);

$total = (int) $pdo->query("SELECT COUNT(*) FROM issued_coupons WHERE campaign_id = {$campaignId}")->fetchColumn();
$inventory = $pdo->query("SELECT remaining_qty, reserved_qty, consumed_qty, total_qty FROM coupon_inventories WHERE coupon_template_id = {$templateId}")->fetch(PDO::FETCH_ASSOC);
printf("\n검증: 원장 %s행 · 재고 보존식 %d+%d+%d=%d (total %d)\n",
    number_format($total),
    $inventory['remaining_qty'], $inventory['reserved_qty'], $inventory['consumed_qty'],
    (int) $inventory['remaining_qty'] + (int) $inventory['reserved_qty'] + (int) $inventory['consumed_qty'],
    $inventory['total_qty'],
);

if (! isset($options['keep'])) {
    $pdo->exec("DELETE FROM issued_coupons WHERE campaign_id = {$campaignId}");
    $pdo->exec("DELETE FROM promotional_campaigns WHERE id = {$campaignId}");
    echo "벤치 데이터 정리 완료(--keep 으로 보존)\n";
}
