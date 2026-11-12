<?php

declare(strict_types=1);

namespace SellerScope\Domain\Promotion;

/**
 * 응모 결과 상태(DB ENUM과 1:1).
 *
 * 거절도 기록한다. 이유는 두 가지다.
 *   1) 고객 문의("왜 안 됐나요?")에 응모 ID로 바로 답할 수 있다.
 *   2) 어뷰징은 거절 로그의 분포에서 보인다. 성공 로그만 남기면
 *      "같은 IP에서 3,000번 시도했다"는 사실이 사라진다.
 */
enum EntryStatus: string
{
    case Accepted = 'ACCEPTED';
    case RejectedStock = 'REJECTED_STOCK';
    case RejectedDuplicate = 'REJECTED_DUPLICATE';
    case RejectedAbuse = 'REJECTED_ABUSE';
    case RejectedRateLimit = 'REJECTED_RATE_LIMIT';
    case RejectedWindow = 'REJECTED_WINDOW';

    public function isAccepted(): bool
    {
        return $this === self::Accepted;
    }
}
