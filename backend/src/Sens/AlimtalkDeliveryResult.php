<?php

declare(strict_types=1);

namespace SellerScope\Sens;

/**
 * 건별 도달 결과(메시지 발송 결과 조회 API 응답).
 *
 * SENS의 결과 코드는 두 층이다.
 *   · requestStatusCode 'A000' : 요청이 정상 접수됨
 *   · messageStatusCode '0000' : 카카오가 실제로 전달함
 * '3005'(AckTimeout)는 "보냈지만 수신 확인 안 됨"이라 성공/실패 어느 쪽으로도 단정할 수
 * 없다. 그래서 isUncertain()을 따로 두고, 재발송 대신 운영자 확인 대상으로 남긴다.
 */
final readonly class AlimtalkDeliveryResult
{
    /**
     * @param array<string,mixed> $raw
     */
    public function __construct(
        public string $requestId,
        public string $messageId,
        public string $requestStatusCode,
        public string $messageStatusCode,
        public string $messageStatusName,
        public string $messageStatusDesc,
        public bool $fallbackUsed,
        public array $raw,
    ) {
    }

    public function isDelivered(): bool
    {
        return $this->requestStatusCode === 'A000' && $this->messageStatusCode === '0000';
    }

    public function isUncertain(): bool
    {
        return $this->messageStatusCode === '3005';
    }

    public function isFallback(): bool
    {
        return $this->fallbackUsed || $this->messageStatusName === 'fail' && isset($this->raw['failover']);
    }

    public static function fromResponse(array $body): self
    {
        return new self(
            (string) ($body['requestId'] ?? ''),
            (string) ($body['messageId'] ?? ''),
            (string) ($body['requestStatusCode'] ?? ''),
            (string) ($body['messageStatusCode'] ?? ''),
            (string) ($body['messageStatusName'] ?? ''),
            (string) ($body['messageStatusDesc'] ?? ''),
            isset($body['failover']),
            $body,
        );
    }
}
