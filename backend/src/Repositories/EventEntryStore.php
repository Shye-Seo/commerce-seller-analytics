<?php

declare(strict_types=1);

namespace SellerScope\Repositories;

use SellerScope\Domain\Promotion\EventEntryRequest;

/**
 * 응모 로그 저장소 계약.
 *
 * 탐지용 집계 쿼리 4종을 인터페이스로 노출한 이유: 어뷰징 판정은 "같은 기기에서 몇 명"처럼
 * **쓰기 직전의 최근 구간 집계**에 의존한다. 이 집계는 읽기 부하가 크므로(인덱스 스캔)
 * 실제 구현에서는 Redis 카운터나 근사 집계로 대체할 수 있어야 하고, 그러려면
 * 서비스가 SQL에 직접 의존하지 않아야 한다.
 */
interface EventEntryStore
{
    /**
     * 응모 1건 저장. 멱등 키 또는 (campaign_id, user_hash) 유니크 충돌이면 null.
     *
     * @param array{score:int, reasons:list<string>, status:string, entryRef:string, latencyMs:int} $verdict
     */
    public function insert(EventEntryRequest $request, array $verdict): ?int;

    /** 같은 디바이스 핑거프린트로 최근 구간에 응모한 서로 다른 사용자 수. */
    public function distinctUsersByDevice(int $campaignId, string $deviceFingerprint, \DateTimeImmutable $since): int;

    /** 같은 IP의 최근 구간 응모 건수. */
    public function recentCountByIp(string $clientIp, \DateTimeImmutable $since): int;

    /** 같은 전화번호 해시를 쓴 서로 다른 사용자 수. */
    public function distinctUsersByPhone(string $phoneHash): int;

    /** 같은 User-Agent 해시의 최근 구간 응모 건수. */
    public function recentCountByUserAgent(string $userAgentHash, \DateTimeImmutable $since): int;
}
