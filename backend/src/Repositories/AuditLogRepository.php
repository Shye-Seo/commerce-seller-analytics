<?php

declare(strict_types=1);

namespace SellerScope\Repositories;

use SellerScope\Database\Connection;

/**
 * 해시체인 감사 로그 저장소.
 *
 * 체인 규칙
 *   · seq: 테넌트별 1, 2, 3 … (UNIQUE (tenant_id, seq))
 *   · prev_hash: 직전 행의 hash, 체인의 첫 행은 "genesis"
 *   · hash: SHA-256(canonical(payload) + prev_hash)
 * canonical(payload)는 필드 순서를 고정한 JSON이다. json_encode는 배열 순서를 보존하므로,
 * 같은 값을 같은 순서로 넣기만 하면 된다(정렬 옵션을 쓰면 중첩 배열에서 순서가 흔들린다).
 *
 * 동시성
 *   마지막 행을 `SELECT … FOR UPDATE`로 잠그고 seq를 계산한다. 같은 테넌트의 두 요청이
 *   동시에 append하면 하나는 잠금 대기 후 다음 번호를 받는다. UNIQUE (tenant_id, seq)가
 *   최후의 방어선이라, 잠금이 새더라도 중복 번호는 저장되지 않는다(그 요청은 실패하고
 *   Connection::transaction의 재시도로 다시 계산된다).
 *
 * 트레이드오프
 *   테넌트 단위 직렬화라 대량 반출(수천 건) 중에는 append가 줄을 선다. 감사 로그는
 *   사용자 행위(분당 수십 건)에 붙는 것이지 배치 결과에 붙는 것이 아니므로 허용한다.
 *   배치 자체는 "누가 언제 실행했는가" 1건으로 남긴다.
 */
final class AuditLogRepository
{
    public const GENESIS_HASH = 'genesis';

    public function __construct(private readonly Connection $connection)
    {
    }

    /**
     * @return array{seq:int, hash:string, prevHash:string}
     */
    public function append(
        int $tenantId,
        string $actorId,
        string $actorRole,
        string $action,
        string $target,
        string $detail,
        string $outcome,
        ?string $ipAddress,
        \DateTimeImmutable $occurredAt,
    ): array {
        if (!in_array($outcome, ['allowed', 'denied'], true)) {
            throw new \InvalidArgumentException("outcome은 allowed/denied만 가능합니다: {$outcome}");
        }

        return $this->connection->transaction(function (\PDO $pdo) use (
            $tenantId, $actorId, $actorRole, $action, $target, $detail, $outcome, $ipAddress, $occurredAt
        ): array {
            $last = $pdo->prepare(
                'SELECT seq, hash FROM audit_logs WHERE tenant_id = :tenant_id ORDER BY seq DESC LIMIT 1 FOR UPDATE'
            );
            $last->execute(['tenant_id' => $tenantId]);
            $previous = $last->fetch();

            $seq = $previous === false ? 1 : (int) $previous['seq'] + 1;
            $prevHash = $previous === false ? self::GENESIS_HASH : (string) $previous['hash'];

            $payload = [
                'tenant_id' => $tenantId,
                'seq' => $seq,
                'actor_id' => $actorId,
                'actor_role' => $actorRole,
                'action' => $action,
                'target' => $target,
                'detail' => $detail,
                'outcome' => $outcome,
                // 시각은 DB에 저장되는 문자열 그대로("Y-m-d H:i:s.v")를 해시에 넣는다.
                // ISO8601(+09:00)로 쓰면 MySQL DATETIME이 거부하고, 읽을 때 표기가 바뀌어
                // 체인 검증이 실패한다. "저장된 것과 같은 문자열"이 체인의 유일한 진실이다.
                'occurred_at' => $occurredAt->format('Y-m-d H:i:s.v'),
                'prev_hash' => $prevHash,
            ];
            $hash = hash('sha256', json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . '|' . $prevHash);

            $insert = $pdo->prepare(
                'INSERT INTO audit_logs
                    (tenant_id, seq, actor_id, actor_role, action, target, detail, outcome, ip_address, prev_hash, hash, occurred_at)
                 VALUES
                    (:tenant_id, :seq, :actor_id, :actor_role, :action, :target, :detail, :outcome, INET6_ATON(:ip), :prev_hash, :hash, :occurred_at)'
            );
            $insert->execute([
                'tenant_id' => $tenantId,
                'seq' => $seq,
                'actor_id' => $actorId,
                'actor_role' => $actorRole,
                'action' => $action,
                'target' => $target,
                'detail' => mb_substr($detail, 0, 500),
                'outcome' => $outcome,
                'ip' => $ipAddress,
                'prev_hash' => $prevHash,
                'hash' => $hash,
                'occurred_at' => $occurredAt->format('Y-m-d H:i:s.v'),
            ]);

            return ['seq' => $seq, 'hash' => $hash, 'prevHash' => $prevHash];
        });
    }

    /**
     * 체인 무결성 검증. 깨진 첫 seq를 돌려준다(프론트엔드 AuditTrail::verify와 같은 의미).
     *
     * @return array{valid:bool, brokenSeq:?int, verified:int}
     */
    public function verifyChain(int $tenantId): array
    {
        $stmt = $this->connection->pdo()->prepare(
            'SELECT seq, actor_id, actor_role, action, target, detail, outcome, prev_hash, hash, occurred_at
             FROM audit_logs WHERE tenant_id = :tenant_id ORDER BY seq ASC'
        );
        $stmt->execute(['tenant_id' => $tenantId]);

        $prevHash = self::GENESIS_HASH;
        $verified = 0;
        foreach ($stmt->fetchAll() as $row) {
            if ((string) $row['prev_hash'] !== $prevHash) {
                return ['valid' => false, 'brokenSeq' => (int) $row['seq'], 'verified' => $verified];
            }

            $payload = [
                'tenant_id' => $tenantId,
                'seq' => (int) $row['seq'],
                'actor_id' => (string) $row['actor_id'],
                'actor_role' => (string) $row['actor_role'],
                'action' => (string) $row['action'],
                'target' => (string) $row['target'],
                'detail' => (string) $row['detail'],
                'outcome' => (string) $row['outcome'],
                'occurred_at' => (string) $row['occurred_at'],
                'prev_hash' => $prevHash,
            ];
            $expected = hash('sha256', json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . '|' . $prevHash);
            if (!hash_equals($expected, (string) $row['hash'])) {
                return ['valid' => false, 'brokenSeq' => (int) $row['seq'], 'verified' => $verified];
            }

            $prevHash = (string) $row['hash'];
            $verified++;
        }

        return ['valid' => true, 'brokenSeq' => null, 'verified' => $verified];
    }

    /** @return list<array<string,mixed>> */
    public function recent(int $tenantId, int $limit = 20): array
    {
        $stmt = $this->connection->pdo()->prepare(
            'SELECT seq, actor_id, actor_role, action, target, outcome, occurred_at, hash
             FROM audit_logs WHERE tenant_id = :tenant_id ORDER BY seq DESC LIMIT :limit_rows'
        );
        $stmt->bindValue(':tenant_id', $tenantId, \PDO::PARAM_INT);
        $stmt->bindValue(':limit_rows', $limit, \PDO::PARAM_INT);
        $stmt->execute();

        return $stmt->fetchAll();
    }
}
