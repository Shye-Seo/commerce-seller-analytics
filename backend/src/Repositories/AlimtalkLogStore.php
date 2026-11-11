<?php

declare(strict_types=1);

namespace SellerScope\Repositories;

use SellerScope\Sens\AlimtalkMessage;
use SellerScope\Sens\AlimtalkSendResult;

/**
 * 알림 발송 이력 저장소의 계약.
 *
 * 알림 오케스트레이션(SettlementAlertNotifier)이 이 인터페이스에만 의존하기 때문에,
 * 테스트에서는 DB 없이 "이미 보낸 알림"과 "발송 실패"를 결정적으로 재현할 수 있다.
 * (MySQL이 필요한 건 실제 저장소의 몫이고, 중복 차단 규칙의 검증은 DB의 UNIQUE 제약이 한다.)
 */
interface AlimtalkLogStore
{
    /**
     * 발송 권한 선점. 이미 같은 dedupeKey가 있으면 null을 돌려준다.
     *
     * @param array<string,mixed> $payload
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
    ): ?int;

    public function markAccepted(
        int $id,
        AlimtalkSendResult $result,
        AlimtalkMessage $message,
        \DateTimeImmutable $now,
    ): void;

    public function markFailed(int $id, string $error, \DateTimeImmutable $now): void;
}
