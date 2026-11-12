#!/usr/bin/env php
<?php

declare(strict_types=1);

/**
 * 실시간 선착순 드롭 부하 재현기(로컬 MySQL 8.0).
 *
 * 사용
 *   php backend/bin/flash-drop-simulate.php --stock=100 --workers=8 --per-worker=50
 *   php backend/bin/flash-drop-simulate.php --stock=1000 --workers=16 --per-worker=120 --keep
 *
 * 이 스크립트가 하는 일
 *   1) 임시 캠페인·템플릿·재고(stock)를 만든다.
 *   2) worker 프로세스 N개를 **동시에** 띄운다(proc_open). 각 worker는 서로 다른
 *      사용자 해시로 per-worker번 발급을 시도한다.
 *   3) 끝나면 DB에서 다음을 센다.
 *        · 발급 성공(issued_coupons 행 수)
 *        · 재고 보존식(remaining + reserved + consumed = total)
 *        · 상태 분포
 *   4) 초당 처리량(TPS)과 오버이슈 여부를 출력한다.
 *
 * 왜 스크립트인가: PHPUnit은 한 프로세스 안에서 돌기 때문에 진짜 동시성을 만들지 못한다.
 * 커넥션 2개로 번갈아 호출하면 "동시"가 아니라 "순차"이고, 그 테스트는 오버이슈를
 * 절대 잡지 못한다. 운영에서 오버이슈를 만드는 것은 **여러 프로세스가 동시에 같은 행을
 * UPDATE하는 상황**이므로, 프로세스를 실제로 여러 개 띄워야 같은 조건이 된다.
 *
 * 전제: `php backend/bin/migrate.php --fresh` 로 스키마가 적용된 DB.
 * 환경변수는 백엔드와 동일(DB_HOST/DB_PORT/DB_UNIX_SOCKET/DB_DATABASE/DB_USERNAME/DB_PASSWORD).
 */

require __DIR__ . '/../vendor/autoload.php';

use SellerScope\Database\Connection;
use SellerScope\Domain\Promotion\IssueOutcome;
use SellerScope\Domain\Promotion\IssueRequest;
use SellerScope\Domain\Promotion\MarginInput;
use SellerScope\Repositories\PdoCouponInventoryStore;
use SellerScope\Repositories\PdoIssuedCouponStore;
use SellerScope\Repositories\PdoPromotionCatalog;
use SellerScope\Services\CouponIssuanceService;
use SellerScope\Support\Env;
use SellerScope\Support\RandomCouponCodeGenerator;
use SellerScope\Support\SystemClock;

Env::load(__DIR__ . '/../.env');

$options = getopt('', [
    'stock::', 'workers::', 'per-worker::',
    'worker', 'campaign::', 'template::', 'start::', 'count::', 'tag::', 'keep',
]);

if (isset($options['worker'])) {
    exit(runWorker($options));
}

exit(runCoordinator($options));

/**
 * @param array<string, mixed> $options
 */
function runCoordinator(array $options): int
{
    $stock = (int) ($options['stock'] ?? 100);
    $workers = max(1, (int) ($options['workers'] ?? 8));
    $perWorker = max(1, (int) ($options['per-worker'] ?? 50));

    $connection = Connection::fromEnv();
    $pdo = $connection->pdo();

    // 이전 실행 잔여물 정리.
    // 주의: issued_coupons → promotional_campaigns FK가 RESTRICT라서 캠페인을 바로 지울 수 없다.
    // 원장은 회계 데이터이므로 CASCADE로 지워지지 않게 설계했고(스키마 주석 참조),
    // 부하 테스트 정리만 원장 행을 명시적으로 지운다.
    cleanupLoadtest($pdo);

    $tenantId = ensureTenant($pdo);
    $campaignId = createCampaign($pdo, $tenantId, $stock);
    $templateId = createTemplate($pdo, $campaignId);
    createInventory($pdo, $campaignId, $templateId, $stock);

    printf("=== 실시간 선착순 드롭 부하 재현 ===\n");
    printf("재고 %d장 · 워커 %d개 · 워커당 %d회 시도 (총 %d회)\n\n", $stock, $workers, $perWorker, $stock === 0 ? 0 : $workers * $perWorker);

    $startedAt = microtime(true);
    $processes = [];
    $commands = [];

    for ($i = 0; $i < $workers; $i++) {
        $command = [
            PHP_BINARY,
            __FILE__,
            '--worker',
            '--campaign=' . $campaignId,
            '--template=' . $templateId,
            '--start=' . ($i * $perWorker),
            '--count=' . $perWorker,
            '--tag=w' . $i,
        ];

        $descriptor = [1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
        $process = proc_open($command, $descriptor, $pipes);

        if (! is_resource($process)) {
            fwrite(STDERR, "워커 {$i} 실행 실패\n");

            return 1;
        }

        $processes[] = ['proc' => $process, 'pipes' => $pipes];
        $commands[] = implode(' ', $command);
    }

    $outcomes = [];
    $errors = [];

    foreach ($processes as $index => $worker) {
        $stdout = stream_get_contents($worker['pipes'][1]);
        $stderr = stream_get_contents($worker['pipes'][2]);
        fclose($worker['pipes'][1]);
        fclose($worker['pipes'][2]);
        $exitCode = proc_close($worker['proc']);

        if ($exitCode !== 0) {
            $errors[] = "워커 {$index} 종료코드 {$exitCode}: " . trim($stderr);
        }

        foreach (array_filter(explode("\n", (string) $stdout)) as $line) {
            $decoded = json_decode($line, true);
            if (is_array($decoded) && isset($decoded['issued'])) {
                $outcomes[] = $decoded;
            }
        }
    }

    $elapsed = microtime(true) - $startedAt;

    $issued = array_sum(array_column($outcomes, 'issued'));
    $soldOut = array_sum(array_column($outcomes, 'soldOut'));
    $duplicate = array_sum(array_column($outcomes, 'duplicate'));
    $conflict = array_sum(array_column($outcomes, 'conflict'));
    $attempts = array_sum(array_column($outcomes, 'attempts'));

    $dbIssued = (int) $pdo->query("SELECT COUNT(*) FROM issued_coupons WHERE campaign_id = {$campaignId}")->fetchColumn();
    $inventory = $pdo->query(
        "SELECT total_qty, remaining_qty, reserved_qty, consumed_qty, version
           FROM coupon_inventories WHERE coupon_template_id = {$templateId}",
    )->fetch(PDO::FETCH_ASSOC);

    $statuses = $pdo->query(
        "SELECT status, COUNT(*) c FROM issued_coupons WHERE campaign_id = {$campaignId} GROUP BY status",
    )->fetchAll(PDO::FETCH_KEY_PAIR);

    $balanced = (int) $inventory['remaining_qty'] + (int) $inventory['reserved_qty'] + (int) $inventory['consumed_qty'] === (int) $inventory['total_qty'];
    $oversell = $dbIssued > $stock;

    printf("소요 %.2fs · 처리량 %.0f req/s\n", $elapsed, $attempts / max(0.001, $elapsed));
    printf("성공 %d · 품절 %d · 중복 %d · 재시도필요 %d (총 시도 %d)\n", $issued, $soldOut, $duplicate, $conflict, $attempts);
    printf("DB 발급 행 %d / 재고 %d → %s\n", $dbIssued, $stock, $oversell ? '오버이슈 발생!' : '오버이슈 0건');
    printf("재고 잔여 %d · 예약 %d · 사용 %d (보존식 %s)\n",
        $inventory['remaining_qty'], $inventory['reserved_qty'], $inventory['consumed_qty'], $balanced ? 'OK' : '깨짐');
    printf("원장 상태 분포: %s\n", json_encode($statuses, JSON_UNESCAPED_UNICODE));

    foreach ($errors as $error) {
        fwrite(STDERR, "[worker] {$error}\n");
    }

    $ok = ! $oversell && $balanced && $dbIssued === $issued && $issued <= $stock;

    if (! isset($options['keep'])) {
        cleanupLoadtest($pdo, $campaignId);
        echo "임시 데이터 정리 완료(--keep 으로 보존)\n";
    }

    printf("\n판정: %s\n", $ok ? 'PASS — 오버이슈 0건, 보존식 유지, 프로세스 합계와 DB 일치' : 'FAIL');

    return $ok ? 0 : 2;
}

/**
 * @param array<string, mixed> $options
 */
function runWorker(array $options): int
{
    $campaignId = (int) $options['campaign'];
    $templateId = (int) $options['template'];
    $start = (int) ($options['start'] ?? 0);
    $count = (int) ($options['count'] ?? 10);
    $tag = (string) ($options['tag'] ?? 'w');

    $connection = Connection::fromEnv();
    $service = new CouponIssuanceService(
        new PdoPromotionCatalog($connection),
        new PdoCouponInventoryStore($connection),
        new PdoIssuedCouponStore($connection),
        new RandomCouponCodeGenerator(),
        new SystemClock(),
    );

    $result = ['issued' => 0, 'soldOut' => 0, 'duplicate' => 0, 'conflict' => 0, 'attempts' => 0, 'other' => 0];

    for ($i = 0; $i < $count; $i++) {
        $sequence = $start + $i;
        $request = new IssueRequest(
            campaignId: $campaignId,
            templateId: $templateId,
            tenantId: 1,
            userHash: hash('sha256', "{$tag}-user-{$sequence}"),
            idempotencyKey: "{$tag}-idem-{$sequence}",
            marginInput: new MarginInput(0, 0),
        );

        $issue = $service->issue($request);
        $result['attempts']++;

        match ($issue->outcome) {
            IssueOutcome::Issued => $result['issued']++,
            IssueOutcome::SoldOut => $result['soldOut']++,
            IssueOutcome::DuplicateClaim => $result['duplicate']++,
            IssueOutcome::InventoryConflict => $result['conflict']++,
            default => $result['other']++,
        };
    }

    echo json_encode($result), PHP_EOL;

    return 0;
}

/**
 * 부하 테스트가 만든 데이터를 지운다. campaignId가 null이면 loadtest-* 전체.
 */
function cleanupLoadtest(PDO $pdo, ?int $campaignId = null): void
{
    $ids = $campaignId !== null
        ? [$campaignId]
        : array_map('intval', $pdo->query("SELECT id FROM promotional_campaigns WHERE code LIKE 'loadtest-%'")->fetchAll(PDO::FETCH_COLUMN));

    foreach ($ids as $id) {
        // 쿠폰 대사 → 쿠폰 원장 → 응모 → 캠페인 순서(RESTRICT FK를 존중)
        $pdo->exec("DELETE FROM issued_coupons WHERE campaign_id = {$id}");
        $pdo->exec("DELETE FROM event_entries WHERE campaign_id = {$id}");
        $pdo->exec("DELETE FROM promotional_campaigns WHERE id = {$id}");
    }
}

function ensureTenant(PDO $pdo): int
{
    $stmt = $pdo->prepare("SELECT id FROM tenants WHERE code = 'loadtest-tenant'");
    $stmt->execute();
    $id = $stmt->fetchColumn();

    if ($id !== false) {
        return (int) $id;
    }

    $pdo->prepare(
        "INSERT INTO tenants (code, name, business_no, tier, settlement_cycle, seat_count)
         VALUES ('loadtest-tenant', '부하테스트 법인', '9999999999', 'HQ', '월 1회', 1)",
    )->execute();

    return (int) $pdo->lastInsertId();
}

function createCampaign(PDO $pdo, int $tenantId, int $stock): int
{
    $code = 'loadtest-' . date('YmdHis') . '-' . bin2hex(random_bytes(3));

    $stmt = $pdo->prepare(
        "INSERT INTO promotional_campaigns
           (tenant_id, code, name, campaign_type, partner_name, reward_budget, token_budget,
            min_guaranteed_margin, margin_guard_mode, expected_peak_tps, starts_at, ends_at, status)
         VALUES
           (:tenant, :code, '부하테스트 드롭', 'TOSS_STYLE_DROP', 'loadtest', 0, :stock,
            0.00, 'block', 5000, NOW() - INTERVAL 1 HOUR, NOW() + INTERVAL 1 HOUR, 'live')",
    );
    $stmt->execute(['tenant' => $tenantId, 'code' => $code, 'stock' => $stock]);

    return (int) $pdo->lastInsertId();
}

function createTemplate(PDO $pdo, int $campaignId): int
{
    $stmt = $pdo->prepare(
        "INSERT INTO coupon_templates
           (campaign_id, code, name, discount_type, discount_amount, discount_rate,
            min_order_amount, max_discount_amount, per_user_limit, validity_minutes, funded_by, issued_budget, is_active)
         VALUES (:campaign, 'loadtest-3000', '부하테스트 3,000원', 'FIXED', 3000, 0.00, 0, 0, 1, 15, 'PARTNER', 0, 1)",
    );
    $stmt->execute(['campaign' => $campaignId]);

    return (int) $pdo->lastInsertId();
}

function createInventory(PDO $pdo, int $campaignId, int $templateId, int $stock): void
{
    $stmt = $pdo->prepare(
        'INSERT INTO coupon_inventories (campaign_id, coupon_template_id, total_qty, remaining_qty)
         VALUES (:campaign, :template, :total, :remaining)',
    );
    $stmt->execute([
        'campaign' => $campaignId,
        'template' => $templateId,
        'total' => $stock,
        'remaining' => $stock,
    ]);
}
