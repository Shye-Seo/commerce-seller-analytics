<?php

declare(strict_types=1);

namespace SellerScope\Repositories;

use SellerScope\Database\Connection;
use SellerScope\Domain\Promotion\EventEntryRequest;

/**
 * 응모 로그 PDO 구현.
 *
 * 쓰기 경로의 원칙: 한 행 INSERT에 문장 하나. 초당 수천 건이면 트리거·서브쿼리·
 * 다중 문장이 곧 지연이다. 판정(점수)은 이미 서비스에서 끝났고 여기서는 적재만 한다.
 *
 * 집계 경로의 원칙: 최근 10초 구간으로 자른다. 인덱스가 `(device, created_at)`,
 * `(client_ip, created_at)`이므로 "같은 기기 최근 10초"는 범위 스캔으로 끝난다.
 * 기간을 넓히면(예: 하루) 이 쿼리가 오픈 순간의 병목이 된다 — 그때는 Redis 카운터로
 * 옮기는 것이 맞고, 그 판단을 위해 인터페이스로 분리해 두었다.
 */
final class PdoEventEntryStore implements EventEntryStore
{
    public function __construct(private readonly Connection $connection)
    {
    }

    public function insert(EventEntryRequest $request, array $verdict): ?int
    {
        $sql = 'INSERT INTO event_entries
                  (campaign_id, entry_ref, user_hash, phone_hash, device_fingerprint_sha256, client_ip,
                   user_agent_hash, utm_source, utm_medium, utm_campaign, is_abusing, abuse_score,
                   risk_reasons, status, idempotency_key, latency_ms)
                VALUES
                  (:campaign, :ref, :user, :phone, :device, INET6_ATON(:ip),
                   :ua, :utm_source, :utm_medium, :utm_campaign, :abusing, :score,
                   CAST(:reasons AS JSON), :status, :idem, :latency)';

        try {
            $stmt = $this->connection->pdo()->prepare($sql);
            $stmt->execute([
                'campaign' => $request->campaignId,
                'ref' => $verdict['entryRef'],
                'user' => $request->userHash,
                'phone' => $request->phoneHash,
                'device' => $request->deviceFingerprint,
                'ip' => $request->clientIp,
                'ua' => $request->userAgentHash,
                'utm_source' => $request->utmSource,
                'utm_medium' => $request->utmMedium,
                'utm_campaign' => $request->utmCampaign,
                'abusing' => $verdict['score'] >= 50 ? 1 : 0,
                'score' => $verdict['score'],
                'reasons' => $verdict['reasons'] === [] ? null : json_encode($verdict['reasons'], JSON_UNESCAPED_UNICODE),
                'status' => $verdict['status'],
                'idem' => $request->idempotencyKey,
                'latency' => $verdict['latencyMs'],
            ]);
        } catch (\PDOException $e) {
            if ((int) ($e->errorInfo[1] ?? 0) === 1062) {
                return null;
            }

            throw $e;
        }

        return (int) $this->connection->pdo()->lastInsertId();
    }

    public function distinctUsersByDevice(int $campaignId, string $deviceFingerprint, \DateTimeImmutable $since): int
    {
        $stmt = $this->connection->pdo()->prepare(
            'SELECT COUNT(DISTINCT user_hash) FROM event_entries
              WHERE campaign_id = :campaign AND device_fingerprint_sha256 = :device AND created_at >= :since',
        );
        $stmt->execute([
            'campaign' => $campaignId,
            'device' => $deviceFingerprint,
            'since' => $since->format('Y-m-d H:i:s.v'),
        ]);

        return (int) $stmt->fetchColumn();
    }

    public function recentCountByIp(string $clientIp, \DateTimeImmutable $since): int
    {
        $stmt = $this->connection->pdo()->prepare(
            'SELECT COUNT(*) FROM event_entries WHERE client_ip = INET6_ATON(:ip) AND created_at >= :since',
        );
        $stmt->execute(['ip' => $clientIp, 'since' => $since->format('Y-m-d H:i:s.v')]);

        return (int) $stmt->fetchColumn();
    }

    public function distinctUsersByPhone(string $phoneHash): int
    {
        $stmt = $this->connection->pdo()->prepare(
            'SELECT COUNT(DISTINCT user_hash) FROM event_entries WHERE phone_hash = :phone',
        );
        $stmt->execute(['phone' => $phoneHash]);

        return (int) $stmt->fetchColumn();
    }

    public function recentCountByUserAgent(string $userAgentHash, \DateTimeImmutable $since): int
    {
        $stmt = $this->connection->pdo()->prepare(
            'SELECT COUNT(*) FROM event_entries WHERE user_agent_hash = :ua AND created_at >= :since',
        );
        $stmt->execute(['ua' => $userAgentHash, 'since' => $since->format('Y-m-d H:i:s.v')]);

        return (int) $stmt->fetchColumn();
    }
}
