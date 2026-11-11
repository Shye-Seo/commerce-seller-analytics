<?php

declare(strict_types=1);

namespace SellerScope\Controllers;

use SellerScope\Database\Connection;
use SellerScope\Domain\ReconciledRow;
use SellerScope\Domain\SettlementRow;
use SellerScope\Http\BadRequestException;
use SellerScope\Http\Request;
use SellerScope\Repositories\AlimtalkLogRepository;
use SellerScope\Repositories\AnomalyRepository;
use SellerScope\Repositories\AuditLogRepository;
use SellerScope\Repositories\SettlementRepository;
use SellerScope\Services\SettlementAlertNotifier;
use SellerScope\Services\SettlementReconciliationService;
use SellerScope\Support\Clock;

/**
 * 정산 대사 API 컨트롤러
 *
 * 엔드포인트
 *   POST /api/v1/reconciliations           정산 배치 수신 + 대사 + 저장 (+ 알림톡)
 *   GET  /api/v1/reconciliations/summary   기간 요약(DB에 저장된 값 기준)
 *   GET  /api/v1/reconciliations/rows      정산 행 목록(keyset pagination)
 *   GET  /api/v1/anomalies                 열린 이상 목록(심각도순)
 *
 * 컨트롤러의 책임은 "입력 검증 + 트랜잭션 경계 + 응답 코드"다. 계산은 서비스, SQL은
 * 저장소가 맡는다. 이 경계를 지키면 대사 규칙이 바뀌어도 컨트롤러는 그대로다.
 *
 * 멱등성: 배치는 batch_id(UUID)를 갖는다. 같은 파일을 다시 올려도 UPSERT와
 * anomalies의 유니크 키 덕분에 행이 늘지 않고, 알림톡은 dedupe_key로 한 번만 나간다.
 */
final class ReconciliationController
{
    public function __construct(
        private readonly SettlementReconciliationService $service,
        private readonly SettlementRepository $settlements,
        private readonly AnomalyRepository $anomalies,
        private readonly AlimtalkLogRepository $alimtalkLogs,
        private readonly AuditLogRepository $audit,
        private readonly Connection $connection,
        private readonly Clock $clock,
        private readonly ?SettlementAlertNotifier $notifier = null,
    ) {
    }

    /**
     * POST /api/v1/reconciliations
     *
     * 요청 예시
     * {
     *   "tenant_id": 1,
     *   "batch_id": "0f8c…-uuid",
     *   "source_file": "coupang_settlement_2026-10.csv",
     *   "notify_phone": "010-1234-5678",
     *   "actor": {"id": "kim@acme.co.kr", "role": "SETTLEMENT_MANAGER", "ip": "203.0.113.7"},
     *   "rows": [ { "order_no": "…", "channel": "coupang", … } ]
     * }
     */
    public function store(Request $request): array
    {
        $tenantId = (int) ($request->json['tenant_id'] ?? 0);
        if ($tenantId <= 0) {
            throw new BadRequestException('tenant_id는 1 이상의 정수여야 합니다.');
        }

        $rawRows = $request->json['rows'] ?? null;
        if (!is_array($rawRows) || $rawRows === []) {
            throw new BadRequestException('rows 배열이 필요합니다.');
        }
        if (count($rawRows) > 5000) {
            // 5,000행 초과는 파일 업로드 경로(bin/reconcile.php --file)로 보낸다.
            // HTTP 본문으로 10만 행을 받으면 메모리·타임아웃이 먼저 터진다.
            throw new BadRequestException('한 요청에 최대 5,000행까지 처리합니다. 대용량은 CSV 업로드 경로를 사용하세요.');
        }

        $batchId = (string) ($request->json['batch_id'] ?? self::newBatchId());
        $sourceFile = isset($request->json['source_file']) ? (string) $request->json['source_file'] : null;

        /** @var list<SettlementRow> $rows */
        $rows = [];
        $parseErrors = [];
        foreach ($rawRows as $index => $raw) {
            try {
                $rows[] = SettlementRow::fromArray((array) $raw);
            } catch (\Throwable $e) {
                $parseErrors[] = ['index' => $index, 'reason' => $e->getMessage()];
            }
        }
        if ($rows === []) {
            throw new BadRequestException('유효한 정산 행이 없습니다.', ['parseErrors' => $parseErrors]);
        }

        $startedAt = microtime(true);
        $result = $this->service->reconcileAll(
            $rows,
            parseErrorCount: count($parseErrors),
            sourceRowCount: count($rawRows),
        );
        $elapsedMs = (int) round((microtime(true) - $startedAt) * 1000);

        $node = $this->clock->now();

        $persisted = $this->connection->transaction(function () use ($tenantId, $batchId, $sourceFile, $result, $node): array {
            $orderIds = $this->settlements->upsertReconciledRows($tenantId, $batchId, $sourceFile, $result->rows, $node);
            $storeIds = $this->settlements->storeIdsByChannel($tenantId);

            $anomalyCount = 0;
            foreach ($result->rows as $row) {
                if ($row->isReconciled()) {
                    continue;
                }
                $orderId = $orderIds[$row->row->id()] ?? null;
                if ($orderId === null) {
                    continue;
                }
                $anomalyCount += $this->anomalies->upsertForOrder(
                    $tenantId,
                    $storeIds[$row->row->channel->value],
                    $batchId,
                    $orderId,
                    $row->anomalies,
                    $node,
                );
            }

            return ['orders' => count($orderIds), 'anomalies' => $anomalyCount];
        });

        $this->audit->append(
            tenantId: $tenantId,
            actorId: (string) ($request->json['actor']['id'] ?? 'api'),
            actorRole: (string) ($request->json['actor']['role'] ?? 'SETTLEMENT_MANAGER'),
            action: 'RECONCILE_RUN',
            target: $batchId,
            detail: sprintf('정산 %d건 대사, 이상 %d건 탐지', count($result->rows), $result->summary->flaggedRows),
            outcome: 'allowed',
            ipAddress: $request->json['actor']['ip'] ?? $request->clientIp,
            occurredAt: $node,
        );

        $alerts = null;
        $phone = isset($request->json['notify_phone']) ? (string) $request->json['notify_phone'] : null;
        if ($phone !== null && $this->notifier !== null) {
            $alerts = $this->notifier->notifyCriticalAnomalies(
                tenantId: $tenantId,
                tenantName: (string) ($request->json['tenant_name'] ?? "tenant#{$tenantId}"),
                batchId: $batchId,
                recipientPhone: $phone,
                rows: $result->rows,
            );
        }

        return [
            'batch_id' => $batchId,
            'tenant_id' => $tenantId,
            'persisted' => $persisted,
            'summary' => $result->summary->toArray(),
            'meta' => [
                'sourceRowCount' => count($rawRows),
                'parsedRows' => count($rows),
                'parseErrors' => $parseErrors,
                'computeElapsedMs' => $elapsedMs,
                'totalElapsedMs' => $elapsedMs,
            ],
            'alerts' => $alerts,
        ];
    }

    /**
     * GET /api/v1/reconciliations/summary?tenant_id=1&from=2026-10-01&to=2026-10-31
     *
     * 저장된 값으로 집계한다(계산값이 아니라 "사실").
     */
    public function summary(Request $request): array
    {
        $tenantId = (int) ($request->queryString('tenant_id') ?? 0);
        if ($tenantId <= 0) {
            throw new BadRequestException('tenant_id 쿼리 파라미터가 필요합니다.');
        }
        [$from, $to] = $this->period($request);

        $totals = $this->settlements->aggregateByTenantAndPeriod($tenantId, $from, $to);

        return [
            'tenant_id' => $tenantId,
            'period' => ['from' => $from->format('Y-m-d'), 'to' => $to->format('Y-m-d')],
            'totals' => $totals['totals'],
            'matchedRate' => $totals['matchedRate'],
            'byChannel' => $totals['byChannel'],
            'topSkusByLoss' => $this->settlements->topSkuLosses($tenantId, $from, $to),
            'alimtalkSuccessRate24h' => $this->alimtalkLogs->successRate24h($tenantId),
            'auditChain' => $this->audit->verifyChain($tenantId),
        ];
    }

    /**
     * GET /api/v1/reconciliations/rows?tenant_id=1&from=…&to=…&cursor=…
     */
    public function rows(Request $request): array
    {
        $tenantId = (int) ($request->queryString('tenant_id') ?? 0);
        if ($tenantId <= 0) {
            throw new BadRequestException('tenant_id 쿼리 파라미터가 필요합니다.');
        }
        [$from, $to] = $this->period($request);
        $cursor = $request->queryString('cursor');
        $limit = min(500, max(1, (int) ($request->queryString('limit') ?? 100)));

        $rows = $this->settlements->findByTenantAndPeriod(
            $tenantId,
            $from,
            $to,
            $cursor === null ? null : (int) $cursor,
            $limit,
            $request->queryString('flagged') === '1',
        );

        return [
            'data' => $rows,
            'next_cursor' => $rows === [] ? null : (int) $rows[array_key_last($rows)]['id'],
            'limit' => $limit,
        ];
    }

    /**
     * GET /api/v1/anomalies?tenant_id=1&severity=critical&cursor=…
     */
    public function anomalies(Request $request): array
    {
        $tenantId = (int) ($request->queryString('tenant_id') ?? 0);
        if ($tenantId <= 0) {
            throw new BadRequestException('tenant_id 쿼리 파라미터가 필요합니다.');
        }
        $severity = $request->queryString('severity');
        if ($severity !== null && !in_array($severity, ['critical', 'warning', 'info'], true)) {
            throw new BadRequestException('severity는 critical/warning/info 중 하나여야 합니다.');
        }
        $cursor = $request->queryString('cursor');
        $limit = min(200, max(1, (int) ($request->queryString('limit') ?? 50)));

        $rows = $this->anomalies->findOpen($tenantId, $severity, $cursor === null ? null : (int) $cursor, $limit);

        return [
            'data' => $rows,
            'next_cursor' => $rows === [] ? null : (int) $rows[array_key_last($rows)]['id'],
            'store_breakdown' => $this->anomalies->countsByStore($tenantId),
        ];
    }

    /**
     * @return array{0:\DateTimeImmutable, 1:\DateTimeImmutable}
     */
    private function period(Request $request): array
    {
        $fromRaw = $request->queryString('from');
        $toRaw = $request->queryString('to');

        try {
            $to = $toRaw !== null ? new \DateTimeImmutable($toRaw) : new \DateTimeImmutable('today');
            $from = $fromRaw !== null ? new \DateTimeImmutable($fromRaw) : $to->modify('-30 days');
        } catch (\Exception) {
            throw new BadRequestException('기간 형식은 YYYY-MM-DD 입니다.');
        }

        if ($from > $to) {
            throw new BadRequestException('from이 to보다 늦습니다.');
        }
        if ($from->diff($to)->days > 400) {
            throw new BadRequestException('한 번에 최대 400일까지 조회할 수 있습니다.');
        }

        return [$from, $to];
    }

    private static function newBatchId(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}
