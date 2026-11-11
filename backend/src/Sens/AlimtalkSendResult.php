<?php

declare(strict_types=1);

namespace SellerScope\Sens;

/**
 * SENS 발송 접수 결과.
 *
 * 주의: 202 Accepted는 "접수됐다"이지 "도달했다"가 아니다. 도달은 messageId로 결과를
 * 조회해 messageStatusCode='0000'을 확인해야 한다. 이 구분을 흐리면 "알림 보냈어요"라고
 * 답했다가 실제로는 카톡 미가입으로 실패한 경우를 놓친다.
 */
final readonly class AlimtalkSendResult
{
    /**
     * @param array<string,mixed> $raw
     */
    public function __construct(
        public string $requestId,
        public string $requestTime,
        public string $statusCode,
        public string $statusName,
        public array $raw,
    ) {
    }

    public function isAccepted(): bool
    {
        return $this->statusCode === '202' || strtolower($this->statusName) === 'accepted';
    }

    public static function fromResponse(array $body): self
    {
        return new self(
            (string) ($body['requestId'] ?? ''),
            (string) ($body['requestTime'] ?? ''),
            (string) ($body['statusCode'] ?? ''),
            (string) ($body['statusName'] ?? ''),
            $body,
        );
    }
}
