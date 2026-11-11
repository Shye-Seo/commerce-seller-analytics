<?php

declare(strict_types=1);

namespace SellerScope\Repositories;

use SellerScope\Database\Connection;
use SellerScope\Sens\AlimtalkDeliveryResult;
use SellerScope\Sens\AlimtalkMessage;
use SellerScope\Sens\AlimtalkSendResult;
use SellerScope\Sens\RecipientPhone;

/**
 * 알림톡 발송 이력 저장소.
 *
 * claim()이 이 클래스의 핵심이다. "중복 확인 → 적재"를 두 문장으로 나누면, 두 워커가
 * 동시에 같은 알림을 보내는 경합이 생긴다(확인 시점엔 없었으니까). 그래서 확인과 적재를
 * UNIQUE 제약 위의 `INSERT IGNORE` 한 문장으로 합친다. 영향 행이 0이면 "이미 있다"이고,
 * 그 판정은 DB가 원자적으로 해 준다.
 *
 * 상태 전이: queued → accepted(202) → delivered(0000) / failed / fallback_sent
 */
final class AlimtalkLogRepository implements AlimtalkLogStore
{
    public function __construct(private readonly Connection $connection)
    {
    }

    /**
     * 발송 권한을 원자적으로 선점한다. 이미 같은 dedupe_key가 있으면 null.
     */
    public function claim(
        int $tenantId,
        string $dedupeKey,
        string $templateCode,
        string $plusFriendId,
        string $recipientPhone,
        ?string $batchId,
        array $payload,
        \DateTimeImmutable $now,
    ): ?int {
        // 번호는 마스킹해서 남긴다. 로그 테이블이 개인정보 원본 보관소가 되면 안 된다.
        $masked = RecipientPhone::fromString($recipientPhone)->masked();

        $stmt = $this->connection->pdo()->prepare(
            "INSERT IGNORE INTO alimtalk_logs
                (tenant_id, batch_id, template_code, plus_friend_id, recipient_phone, dedupe_key,
                 status, request_payload, created_at)
             VALUES (:tenant_id, :batch_id, :template_code, :plus_friend_id, :recipient_phone, :dedupe_key,
                     'queued', :payload, :created_at)"
        );
        $stmt->execute([
            'tenant_id' => $tenantId,
            'batch_id' => $batchId,
            'template_code' => $templateCode,
            'plus_friend_id' => $plusFriendId,
            'recipient_phone' => $masked,
            'dedupe_key' => $dedupeKey,
            'payload' => json_encode($payload, JSON_UNESCAPED_UNICODE),
            'created_at' => $now->format('Y-m-d H:i:s.v'),
        ]);

        if ($stmt->rowCount() === 0) {
            return null;
        }

        return (int) $this->connection->pdo()->lastInsertId();
    }

    public function markAccepted(
        int $id,
        AlimtalkSendResult $result,
        AlimtalkMessage $message,
        \DateTimeImmutable $now,
    ): void {
        $stmt = $this->connection->pdo()->prepare(
            "UPDATE alimtalk_logs
             SET status = 'accepted', request_id = :request_id, sent_at = :sent_at,
                 attempts = attempts + 1,
                 request_payload = :request_payload, response_payload = :response_payload,
                 error_message = NULL
             WHERE id = :id"
        );
        $stmt->execute([
            'request_id' => $result->requestId,
            'sent_at' => $now->format('Y-m-d H:i:s.v'),
            'request_payload' => json_encode($message->toAuditArray(), JSON_UNESCAPED_UNICODE),
            'response_payload' => json_encode($result->raw, JSON_UNESCAPED_UNICODE),
            'id' => $id,
        ]);
    }

    public function markFailed(int $id, string $error, \DateTimeImmutable $now): void
    {
        $stmt = $this->connection->pdo()->prepare(
            "UPDATE alimtalk_logs
             SET status = 'failed', attempts = attempts + 1, error_message = :error, updated_at = :updated_at
             WHERE id = :id"
        );
        $stmt->execute([
            'error' => mb_substr($error, 0, 500),
            'updated_at' => $now->format('Y-m-d H:i:s.v'),
            'id' => $id,
        ]);
    }

    /**
     * 결과 조회 반영.
     *
     * 3005(AckTimeout)는 delivered도 failed도 아니다. 이때 상태를 'sent'로 두고
     * message_status_code만 남겨, 운영자가 "성공 불확실"을 구분해 볼 수 있게 한다.
     */
    public function markDelivery(int $id, AlimtalkDeliveryResult $result, \DateTimeImmutable $now): void
    {
        $status = match (true) {
            $result->isDelivered() => 'delivered',
            $result->isFallback() => 'fallback_sent',
            $result->isUncertain() => 'sent',
            default => 'failed',
        };

        $stmt = $this->connection->pdo()->prepare(
            'UPDATE alimtalk_logs
             SET status = :status, message_id = COALESCE(NULLIF(:message_id, \'\'), message_id),
                 message_status_code = :code, message_status_desc = :desc,
                 delivered_at = :delivered_at, response_payload = :raw, updated_at = :updated_at
             WHERE id = :id'
        );
        $stmt->execute([
            'status' => $status,
            'message_id' => $result->messageId,
            'code' => $result->messageStatusCode,
            'desc' => mb_substr($result->messageStatusDesc, 0, 200),
            'delivered_at' => $now->format('Y-m-d H:i:s.v'),
            'raw' => json_encode($result->raw, JSON_UNESCAPED_UNICODE),
            'updated_at' => $now->format('Y-m-d H:i:s.v'),
            'id' => $id,
        ]);
    }

    /**
     * 재시도 대상: queued에 머문 행(프로세스가 죽은 경우)과 failed(재시도 가능 오류).
     * 3회 이상 시도한 행은 제외한다 — 같은 오류로 계속 두드리면 SENS 한도만 태운다.
     *
     * @return list<array<string,mixed>>
     */
    public function findRetryable(int $limit = 50): array
    {
        $stmt = $this->connection->pdo()->prepare(
            "SELECT id, tenant_id, template_code, plus_friend_id, recipient_phone, batch_id, attempts
             FROM alimtalk_logs
             WHERE status IN ('queued', 'failed') AND attempts < 3
               AND created_at >= (NOW() - INTERVAL 24 HOUR)
             ORDER BY id ASC
             LIMIT :limit_rows"
        );
        $stmt->bindValue(':limit_rows', $limit, \PDO::PARAM_INT);
        $stmt->execute();

        return $stmt->fetchAll();
    }

    /** 최근 발송 이력(운영 화면·CS 대응). */
    public function recent(int $tenantId, int $limit = 20): array
    {
        $stmt = $this->connection->pdo()->prepare(
            'SELECT id, template_code, recipient_phone, status, message_status_code, error_message, sent_at, created_at
             FROM alimtalk_logs
             WHERE tenant_id = :tenant_id
             ORDER BY id DESC
             LIMIT :limit_rows'
        );
        $stmt->bindValue(':tenant_id', $tenantId, \PDO::PARAM_INT);
        $stmt->bindValue(':limit_rows', $limit, \PDO::PARAM_INT);
        $stmt->execute();

        return $stmt->fetchAll();
    }

    /** 발송 성공률(최근 24시간) — 운영 대시보드 지표. */
    public function successRate24h(int $tenantId): float
    {
        $stmt = $this->connection->pdo()->prepare(
            "SELECT COUNT(*) AS total,
                    COALESCE(SUM(status IN ('accepted', 'delivered', 'fallback_sent')), 0) AS ok
             FROM alimtalk_logs
             WHERE tenant_id = :tenant_id AND created_at >= (NOW() - INTERVAL 24 HOUR)"
        );
        $stmt->execute(['tenant_id' => $tenantId]);
        $row = $stmt->fetch() ?: ['total' => 0, 'ok' => 0];
        $total = (int) $row['total'];

        return $total === 0 ? 1.0 : round((int) $row['ok'] / $total, 4);
    }
}
