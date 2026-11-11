#!/usr/bin/env php
<?php

declare(strict_types=1);

/**
 * 정산서 CSV 배치 대사 CLI.
 *
 * 사용
 *   php backend/bin/reconcile.php --tenant=1 --file=storage/coupang_2026-10.csv
 *   php backend/bin/reconcile.php --tenant=1 --file=… --dry-run          # 저장·발송 없이 결과만
 *   php backend/bin/reconcile.php --tenant=1 --file=… --phone=01012345678 # 심각 이상 알림톡 발송
 *   php backend/bin/reconcile.php --tenant=1 --file=… --verify            # 저장 후 DB 집계와 대조
 *
 * 왜 HTTP가 아니라 CLI도 두는가: 실제 정산서는 마켓에서 내려받은 10만 행 파일이다.
 * 이걸 브라우저 업로드로 처리하면 요청 타임아웃·메모리 상한에 먼저 걸린다. 운영에서는
 * cron/NCP Cloud Functions가 이 CLI를 부르고, 실행 로그가 그대로 감사 자료가 된다.
 */

require __DIR__ . '/../vendor/autoload.php';

use SellerScope\Database\Connection;
use SellerScope\Domain\AnomalyType;
use SellerScope\Domain\Money;
use SellerScope\Domain\SettlementRow;
use SellerScope\Repositories\AlimtalkLogRepository;
use SellerScope\Repositories\AnomalyRepository;
use SellerScope\Repositories\AuditLogRepository;
use SellerScope\Repositories\SettlementRepository;
use SellerScope\Services\NaverCloudSensService;
use SellerScope\Services\SettlementAlertComposer;
use SellerScope\Services\SettlementAlertNotifier;
use SellerScope\Services\SettlementReconciliationService;
use SellerScope\Support\CurlHttpClient;
use SellerScope\Support\Env;
use SellerScope\Support\SystemClock;

Env::load(__DIR__ . '/../.env');

$options = getopt('', ['tenant:', 'file:', 'phone::', 'batch::', 'tenant-name::', 'dry-run', 'verify', 'help']);

if (isset($options['help']) || !isset($options['tenant'], $options['file'])) {
    fwrite(STDOUT, <<<TXT
    사용법: php backend/bin/reconcile.php --tenant=<id> --file=<csv> [옵션]

      --phone=01012345678   심각(critical) 이상을 알림톡으로 발송
      --batch=<uuid>        배치 ID 직접 지정(기본: 랜덤 UUID)
      --tenant-name=…       알림 문구에 쓸 법인명
      --dry-run             계산만 하고 저장·발송하지 않음
      --verify              저장 후 DB 집계와 계산 결과를 대조

    CSV 헤더(순서 무관): order_no, channel, order_date, settlement_date, product_name, sku,
      quantity, paid_amount, commission, shipping_deduction, return_fee, settled_amount,
      order_status, contract_fee_rate, unit_cost, seller_shipping_cost

    TXT);
    exit(isset($options['help']) ? 0 : 1);
}

$tenantId = (int) $options['tenant'];
$file = (string) $options['file'];
$dryRun = isset($options['dry-run']);
$clock = new SystemClock(Env::get('DB_TIMEZONE', '+09:00') ?? '+09:00');

if (!is_readable($file)) {
    fwrite(STDERR, "CSV 파일을 읽을 수 없습니다: {$file}\n");
    exit(1);
}

$handle = fopen($file, 'rb');
if ($handle === false) {
    fwrite(STDERR, "파일 열기 실패: {$file}\n");
    exit(1);
}

$header = fgetcsv($handle, 0, ',', '"', '\\') ?: [];
$header = array_map(static fn ($h): string => strtolower(trim(str_replace("\u{FEFF}", '', (string) $h))), $header);

/** @var list<SettlementRow> $rows */
$rows = [];
$errors = [];
$lineNo = 1;
while (($data = fgetcsv($handle, 0, ',', '"', '\\')) !== false) {
    $lineNo++;
    if ($data === [null] || trim(implode('', $data)) === '') {
        continue;
    }
    $assoc = [];
    foreach ($header as $index => $key) {
        $assoc[$key] = $data[$index] ?? null;
    }
    try {
        $rows[] = SettlementRow::fromArray($assoc);
    } catch (\Throwable $e) {
        $errors[] = "line {$lineNo}: {$e->getMessage()}";
    }
}
fclose($handle);

fwrite(STDOUT, sprintf("읽은 행: %d (오류 %d)\n", count($rows) + count($errors), count($errors)));
if ($rows === []) {
    fwrite(STDERR, "유효한 행이 없습니다.\n");
    exit(1);
}

$service = new SettlementReconciliationService();
$startedAt = microtime(true);
$result = $service->reconcileAll($rows, parseErrorCount: count($errors), sourceRowCount: count($rows) + count($errors));
$elapsedMs = (int) round((microtime(true) - $startedAt) * 1000);

// 소요 시간은 계산이 끝난 뒤에야 알 수 있으므로 결과 봉투를 한 번 다시 만든다.
// (rows/s를 화면에 보여 주려면 elapsedMs가 채워져 있어야 한다.)
$result = new \SellerScope\Domain\ReconciliationResult(
    rows: $result->rows,
    summary: $result->summary,
    parseErrorCount: $result->parseErrorCount,
    sourceRowCount: $result->sourceRowCount,
    elapsedMs: $elapsedMs,
    customContract: $result->customContract,
);

$summary = $result->summary;
$top = $summary->biggestLeakCause();

fwrite(STDOUT, sprintf(
    "\n== 대사 결과 ==\n대상 %s건 · 정상 %s건 · 이상 %s건 (정상률 %.2f%%)\n결제 %s · 정산 %s · 기대 %s\n누수 %s · 초과입금 %s · 역마진 노출 %s\n",
    number_format($summary->totalRows),
    number_format($summary->matchedRows),
    number_format($summary->flaggedRows),
    $summary->matchedRate,
    Money::format($summary->totalPaidAmount),
    Money::format($summary->totalSettledAmount),
    Money::format($summary->expectedSettlement),
    Money::format($summary->totalLeak),
    Money::format($summary->totalSurplus),
    Money::format($summary->marginRiskExposure),
));
if ($top !== null) {
    fwrite(STDOUT, sprintf("최대 원인: %s %s\n", $top['label'], Money::format($top['amount'])));
}
fwrite(STDOUT, sprintf("계산 소요: %dms (%.0f rows/s)\n", $elapsedMs, $result->rowsPerSecond()));

// 원인별 요약 표
foreach (AnomalyType::cases() as $type) {
    $count = $summary->anomalyCounts[$type->value] ?? 0;
    if ($count === 0) {
        continue;
    }
    fwrite(STDOUT, sprintf("  %-24s %4d건  %s\n", $type->label(), $count, Money::format($summary->anomalyLoss[$type->value] ?? 0)));
}

if ($errors !== []) {
    fwrite(STDOUT, "\n파싱 오류(앞 5건):\n  " . implode("\n  ", array_slice($errors, 0, 5)) . "\n");
}

if ($dryRun) {
    fwrite(STDOUT, "\n--dry-run: 저장·발송하지 않았습니다.\n");
    exit(0);
}

$connection = Connection::fromEnv();
$settlements = new SettlementRepository($connection);
$anomalies = new AnomalyRepository($connection);
$alimtalkLogs = new AlimtalkLogRepository($connection);
$audit = new AuditLogRepository($connection);

$batchId = isset($options['batch']) ? (string) $options['batch'] : sprintf(
    '%08x-%04x-4%03x-9%03x-%012x',
    random_int(0, 0xffffffff),
    random_int(0, 0xffff),
    random_int(0, 0xfff),
    random_int(0, 0xfff),
    random_int(0, 0xffffffffffff),
);
$tenantName = isset($options['tenant-name']) ? (string) $options['tenant-name'] : "tenant#{$tenantId}";
$now = $clock->now();

$persisted = $connection->transaction(function () use ($tenantId, $batchId, $file, $result, $settlements, $anomalies, $now): array {
    $orderIds = $settlements->upsertReconciledRows($tenantId, $batchId, basename($file), $result->rows, $now);
    $storeIds = $settlements->storeIdsByChannel($tenantId);

    $anomalyCount = 0;
    foreach ($result->rows as $row) {
        if ($row->isReconciled()) {
            continue;
        }
        $orderId = $orderIds[$row->row->id()] ?? null;
        if ($orderId === null) {
            continue;
        }
        $anomalyCount += $anomalies->upsertForOrder(
            $tenantId,
            $storeIds[$row->row->channel->value],
            $batchId,
            $orderId,
            $row->anomalies,
            $now,
        );
    }

    return ['orders' => count($orderIds), 'anomalies' => $anomalyCount];
});

$audit->append(
    tenantId: $tenantId,
    actorId: 'cli:reconcile',
    actorRole: 'SETTLEMENT_MANAGER',
    action: 'RECONCILE_RUN',
    target: $batchId,
    detail: sprintf('%s · %d건 · 이상 %d건 · 누수 %s', basename($file), $summary->totalRows, $summary->flaggedRows, Money::format($summary->totalLeak)),
    outcome: 'allowed',
    ipAddress: null,
    occurredAt: $now,
);

fwrite(STDOUT, sprintf("\n저장 완료: 주문 %d행, 이상 %d행 (batch %s)\n", $persisted['orders'], $persisted['anomalies'], $batchId));

if (isset($options['phone'])) {
    try {
        $sens = NaverCloudSensService::fromEnv(new CurlHttpClient(), $clock);
        $notifier = new SettlementAlertNotifier(
            $sens,
            $alimtalkLogs,
            new SettlementAlertComposer(),
            new \SellerScope\Sens\SensConfig(
                accessKey: Env::required('SENS_ACCESS_KEY'),
                secretKey: Env::required('SENS_SECRET_KEY'),
                serviceId: Env::required('SENS_SERVICE_ID'),
                plusFriendId: Env::get('SENS_PLUS_FRIEND_ID', '@sellerscope') ?? '@sellerscope',
                anomalyTemplateCode: Env::get('SENS_TEMPLATE_ANOMALY', 'SS_ANOMALY_CRITICAL') ?? 'SS_ANOMALY_CRITICAL',
                summaryTemplateCode: Env::get('SENS_TEMPLATE_SUMMARY', 'SS_BATCH_SUMMARY') ?? 'SS_BATCH_SUMMARY',
                failoverFrom: Env::get('SENS_FAILOVER_FROM'),
            ),
            $clock,
        );
        $alerts = $notifier->notifyCriticalAnomalies($tenantId, $tenantName, $batchId, (string) $options['phone'], $result->rows);
        fwrite(STDOUT, sprintf(
            "알림톡: 발송 %d · 중복건너뜀 %d · 실패 %d\n",
            $alerts['sent'],
            $alerts['skipped'],
            $alerts['failed'],
        ));
        foreach ($alerts['errors'] as $error) {
            fwrite(STDERR, "  알림 오류: {$error}\n");
        }
    } catch (\Throwable $e) {
        // 알림 실패는 배치 성패와 분리한다(대사 결과는 이미 저장됐다).
        fwrite(STDERR, "알림톡 발송을 건너뜁니다: {$e->getMessage()}\n");
    }
}

if (isset($options['verify'])) {
    $period = $rows[0]->settlementDate ?? $rows[0]->orderDate;
    $dates = array_map(
        static fn (SettlementRow $r): int => ($r->settlementDate ?? $r->orderDate)->getTimestamp(),
        $rows,
    );
    $from = (new \DateTimeImmutable('@' . min($dates)))->setTimezone(new \DateTimeZone('Asia/Seoul'));
    $to = (new \DateTimeImmutable('@' . max($dates)))->setTimezone(new \DateTimeZone('Asia/Seoul'));

    $db = $settlements->aggregateByTenantAndPeriod($tenantId, $from, $to);
    $dbLoss = (int) ($db['totals']['total_loss'] ?? 0);
    $diff = $dbLoss - $summary->totalLeak;

    fwrite(STDOUT, sprintf(
        "\n[정합성] 계산 누수 %s / DB 누수 %s (차이 %s)\n",
        Money::format($summary->totalLeak),
        Money::format($dbLoss),
        Money::format($diff),
    ));
    if ($diff !== 0) {
        // 차이가 나는 정상적인 이유: 같은 기간에 다른 파일로 올린 행이 이미 DB에 있는 경우.
        fwrite(STDERR, "차이가 있습니다. 같은 기간에 다른 배치가 적재됐는지 확인하세요(배치 단위 검증은 batch_id로).\n");
        exit(2);
    }
    fwrite(STDOUT, "[정합성] 일치합니다.\n");
}
