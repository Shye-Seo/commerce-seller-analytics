<?php

declare(strict_types=1);

namespace SellerScope\Domain\Promotion;

/**
 * 응모 판정 결과.
 *
 * `reasons`는 문자열 배열이고 그대로 JSON 컬럼(risk_reasons)에 저장된다.
 * 점수만 저장하면 사후에 "왜 72점이었나"를 설명할 수 없어, 이의 제기 대응이 불가능하다.
 * 사유 코드는 안정적인 상수(DEVICE_CLUSTER, PHONE_REUSE, IP_VELOCITY, UA_ANOMALY,
 * RATE_LIMIT_EXCEEDED, BURST)를 쓰고, 문구는 콘솔에서 번역한다.
 */
final class EntryDecision
{
    /**
     * @param list<string> $reasons
     */
    public function __construct(
        public readonly EntryStatus $status,
        public readonly int $abuseScore,
        public readonly array $reasons,
        public readonly string $entryRef,
        public readonly int $latencyMs,
        public readonly bool $persisted,
    ) {
    }

    public function isAccepted(): bool
    {
        return $this->status->isAccepted();
    }

    public function isAbusing(): bool
    {
        return $this->status === EntryStatus::RejectedAbuse;
    }
}
