<?php

declare(strict_types=1);

namespace SellerScope\Domain\Promotion;

/**
 * 응모 1건의 유입 정보.
 *
 * 전부 "이미 해시된" 값 또는 원문 IP만 받는다. 해싱은 게이트웨이(엣지)에서 한다.
 * 이유: 원문 전화번호가 애플리케이션 메모리에 오래 머물면 로그·에러 리포트에 남는다.
 *
 * `receivedAt`은 게이트웨이가 요청을 받은 시각이다. 응답 직전까지의 지연(latency_ms)을
 * 재는 데만 쓰고, 캠페인 오픈 판정은 서버 시계(Clock)로 한다 — 클라이언트·엣지 시계를
 * 믿으면 종료된 캠페인에 응모할 수 있다.
 */
final class EventEntryRequest
{
    public function __construct(
        public readonly int $campaignId,
        public readonly string $userHash,
        public readonly string $idempotencyKey,
        public readonly ?string $phoneHash = null,
        public readonly ?string $deviceFingerprint = null,
        public readonly ?string $clientIp = null,
        public readonly ?string $userAgentHash = null,
        public readonly ?string $utmSource = null,
        public readonly ?string $utmMedium = null,
        public readonly ?string $utmCampaign = null,
        public readonly ?\DateTimeImmutable $receivedAt = null,
    ) {
    }
}
