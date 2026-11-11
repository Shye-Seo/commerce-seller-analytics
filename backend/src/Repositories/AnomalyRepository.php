<?php

declare(strict_types=1);

namespace SellerScope\Repositories;

use SellerScope\Database\Connection;
use SellerScope\Domain\Anomaly;

/**
 * 이상 탐지 저장소.
 *
 * 멱등성 규칙이 이 저장소의 핵심이다. 유니크 키 (order_id, anomaly_type)로
 * `INSERT … ON DUPLICATE KEY UPDATE`를 쓰면
 *   · 같은 정산서 재처리 → 행이 늘지 않고 수치·문구만 갱신
 *   · 이미 'resolved'(환급 완료)로 닫은 이상이 재계산으로 'open'으로 되살아나지 않음
 *     (UPDATE 목록에 status를 넣지 않는 이유)
 * 이 두 성질이 없으면, 매일 밤 도는 배치가 지난달에 처리 끝낸 이의 제기를 다시 열어
 * 운영 큐를 무한히 부풀린다.
 */
final class AnomalyRepository
{
    private const CHUNK_SIZE = 200;

    public function __construct(private readonly Connection $connection)
    {
    }

    /**
     * 한 주문의 이상들을 저장한다.
     *
     * @param list<Anomaly> $anomalies
     * @return int 저장(또는 갱신)한 이상 건수
     */
    public function upsertForOrder(
        int $tenantId,
        int $storeId,
        string $batchId,
        int $orderId,
        array $anomalies,
        \DateTimeImmutable $now,
    ): int {
        if ($anomalies === []) {
            return 0;
        }

        $saved = 0;
        foreach (array_chunk($anomalies, self::CHUNK_SIZE) as $chunk) {
            $values = [];
            $params = [];
            foreach ($chunk as $anomaly) {
                $data = $anomaly->toArray();
                $values[] = '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
                array_push(
                    $params,
                    $tenantId,
                    $storeId,
                    $orderId,
                    $batchId,
                    $data['anomaly_type'],
                    $data['category'],
                    $data['severity'],
                    $data['expected_amount'],
                    $data['actual_amount'],
                    $data['loss_amount'],
                    $data['detail'],
                    'open',
                );
            }

            $sql = 'INSERT INTO reconciliation_anomalies
                      (tenant_id, store_id, order_id, batch_id, anomaly_type, category, severity,
                       expected_amount, actual_amount, loss_amount, detail, status)
                    VALUES ' . implode(', ', $values) . ' AS new
                    ON DUPLICATE KEY UPDATE
                      batch_id = new.batch_id,
                      severity = new.severity,
                      expected_amount = new.expected_amount,
                      actual_amount = new.actual_amount,
                      loss_amount = new.loss_amount,
                      detail = new.detail,
                      updated_at = ?';

            $params[] = $now->format('Y-m-d H:i:s.v');

            $stmt = $this->connection->pdo()->prepare($sql);
            $stmt->execute($params);
            // MySQL의 ON DUPLICATE KEY UPDATE는 갱신 시 affected rows를 2로 센다(insert 1 / update 2).
            // 그래서 rowCount()를 그대로 더하면 재실행 때 "12행"처럼 부풀려진다. 처리 건수를 센다.
            $saved += count($chunk);
        }

        return $saved;
    }

    /**
     * 운영 큐: 열린 이상을 심각도순으로.
     *
     * keyset pagination(id > cursor)을 쓴다. OFFSET은 status='open'이 수만 건일 때
     * 페이지마다 같은 행을 다시 세게 된다.
     *
     * @return list<array<string,mixed>>
     */
    public function findOpen(
        int $tenantId,
        ?string $severity = null,
        ?int $cursorId = null,
        int $limit = 50,
    ): array {
        $sql = 'SELECT id, store_id, order_id, batch_id, anomaly_type, category, severity,
                       expected_amount, actual_amount, loss_amount, detail, status, created_at
                FROM reconciliation_anomalies
                WHERE tenant_id = :tenant_id AND status = :status';
        $params = ['tenant_id' => $tenantId, 'status' => 'open'];
        if ($severity !== null) {
            $sql .= ' AND severity = :severity';
            $params['severity'] = $severity;
        }
        if ($cursorId !== null) {
            $sql .= ' AND id > :cursor_id';
            $params['cursor_id'] = $cursorId;
        }
        $sql .= " ORDER BY FIELD(severity, 'critical', 'warning', 'info'), id ASC LIMIT :limit_rows";

        $stmt = $this->connection->pdo()->prepare($sql);
        foreach ($params as $key => $value) {
            $stmt->bindValue(':' . $key, $value, is_int($value) ? \PDO::PARAM_INT : \PDO::PARAM_STR);
        }
        $stmt->bindValue(':limit_rows', $limit, \PDO::PARAM_INT);
        $stmt->execute();

        return $stmt->fetchAll();
    }

    /**
     * 스토어(마켓)별 원인 집계 — 마켓에 이의 제기할 때 쓰는 표.
     *
     * 인덱스 (store_id, anomaly_type)를 그대로 타도록 store_id를 선두 조건으로 둔다.
     *
     * @return list<array<string,mixed>>
     */
    public function countsByStore(int $tenantId): array
    {
        $stmt = $this->connection->pdo()->prepare(
            'SELECT s.channel, a.anomaly_type, a.severity, COUNT(*) AS cases,
                    COALESCE(SUM(a.loss_amount), 0) AS loss
             FROM reconciliation_anomalies a
             JOIN stores s ON s.id = a.store_id
             WHERE a.tenant_id = :tenant_id
             GROUP BY s.channel, a.anomaly_type, a.severity
             ORDER BY loss DESC'
        );
        $stmt->execute(['tenant_id' => $tenantId]);

        return array_map(static fn (array $row): array => [
            'channel' => (string) $row['channel'],
            'anomaly_type' => (string) $row['anomaly_type'],
            'severity' => (string) $row['severity'],
            'cases' => (int) $row['cases'],
            'loss' => (int) $row['loss'],
        ], $stmt->fetchAll());
    }

    /** 처리 상태 변경(운영자 액션). */
    public function markStatus(int $anomalyId, string $status, ?string $note, \DateTimeImmutable $now): bool
    {
        $allowed = ['open', 'acknowledged', 'disputed', 'resolved', 'ignored'];
        if (!in_array($status, $allowed, true)) {
            throw new \InvalidArgumentException("허용되지 않은 상태입니다: {$status}");
        }

        // 네이티브 prepared statement(EMULATE_PREPARES=false)에서는 같은 이름의
        // 플레이스홀더를 두 번 쓸 수 없다. 역할별로 이름을 나눈다.
        $stmt = $this->connection->pdo()->prepare(
            'UPDATE reconciliation_anomalies
             SET status = :status,
                 resolution_note = COALESCE(:note, resolution_note),
                 resolved_at = CASE WHEN :status_check IN (\'resolved\', \'ignored\') THEN :resolved_at ELSE resolved_at END
             WHERE id = :id'
        );
        $stmt->execute([
            'status' => $status,
            'note' => $note,
            'status_check' => $status,
            'resolved_at' => $now->format('Y-m-d H:i:s.v'),
            'id' => $anomalyId,
        ]);

        return $stmt->rowCount() > 0;
    }
}
