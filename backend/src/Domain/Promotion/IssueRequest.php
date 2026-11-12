<?php

declare(strict_types=1);

namespace SellerScope\Domain\Promotion;

/**
 * 발급 요청.
 *
 * `idempotencyKey`는 클라이언트가 만든다(버튼 한 번 = 키 하나). 서버가 만들면
 * 재전송마다 새 키가 생겨 멱등이 성립하지 않는다.
 *
 * `userHash`는 이미 해시된 값이어야 한다. 원문 식별자(전화번호·회원ID)를 이 계층까지
 * 들고 오면 로그·예외 메시지에 남을 수 있다. 해싱은 게이트웨이가 솔트와 함께 한다.
 */
final class IssueRequest
{
    public function __construct(
        public readonly int $campaignId,
        public readonly int $templateId,
        public readonly int $tenantId,
        public readonly string $userHash,
        public readonly string $idempotencyKey,
        public readonly ?int $entryId = null,
        public readonly MarginInput $marginInput = new MarginInput(0, 0),
    ) {
    }

    public function isValid(): bool
    {
        return $this->campaignId > 0
            && $this->templateId > 0
            && $this->tenantId > 0
            && strlen($this->userHash) >= 16
            && $this->idempotencyKey !== '';
    }
}
