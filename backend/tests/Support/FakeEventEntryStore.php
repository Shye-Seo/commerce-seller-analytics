<?php

declare(strict_types=1);

namespace SellerScope\Tests\Support;

use SellerScope\Domain\Promotion\EventEntryRequest;
use SellerScope\Repositories\EventEntryStore;

/**
 * 응모 로그 저장소 스텁.
 *
 * 신호(기기 클러스터·IP 폭주·전화 재사용·UA)를 숫자로 직접 세팅해, 어뷰징 점수식이
 * 경계값에서 어떻게 판정하는지를 결정적으로 확인한다.
 */
final class FakeEventEntryStore implements EventEntryStore
{
    public int $deviceUsers = 0;

    public int $ipCount = 0;

    public int $phoneUsers = 1;

    public int $uaCount = 0;

    /** 멱등 키 또는 사용자 중복으로 INSERT를 실패시킨다. */
    public bool $rejectInsertAsDuplicate = false;

    /** @var list<array{request: EventEntryRequest, verdict: array<string,mixed>}> */
    public array $inserted = [];

    public function insert(EventEntryRequest $request, array $verdict): ?int
    {
        if ($this->rejectInsertAsDuplicate) {
            return null;
        }

        $this->inserted[] = ['request' => $request, 'verdict' => $verdict];
        if ($request->deviceFingerprint !== null) {
            $this->deviceUsers++;
        }
        if ($request->clientIp !== null) {
            $this->ipCount++;
        }
        if ($request->userAgentHash !== null) {
            $this->uaCount++;
        }

        return count($this->inserted);
    }

    public function distinctUsersByDevice(int $campaignId, string $deviceFingerprint, \DateTimeImmutable $since): int
    {
        return $this->deviceUsers;
    }

    public function recentCountByIp(string $clientIp, \DateTimeImmutable $since): int
    {
        return $this->ipCount;
    }

    public function distinctUsersByPhone(string $phoneHash): int
    {
        return $this->phoneUsers;
    }

    public function recentCountByUserAgent(string $userAgentHash, \DateTimeImmutable $since): int
    {
        return $this->uaCount;
    }
}
