<?php

declare(strict_types=1);

namespace SellerScope\Support;

/** 외부 API 응답(불변). 상태 코드와 원문 본문을 그대로 보존한다. */
final readonly class HttpResponse
{
    /**
     * @param array<string,string> $headers 소문자 키
     */
    public function __construct(
        public int $status,
        public string $body,
        public array $headers = [],
        public string $url = '',
    ) {
    }

    public function isSuccess(): bool
    {
        return $this->status >= 200 && $this->status < 300;
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    /** @return array<string,mixed> */
    public function json(): array
    {
        $decoded = json_decode($this->body, true);
        if (!is_array($decoded)) {
            throw new \RuntimeException('JSON 응답을 해석할 수 없습니다: ' . mb_substr($this->body, 0, 200));
        }

        return $decoded;
    }

    public function summary(): string
    {
        return sprintf('HTTP %d %s', $this->status, mb_substr(trim($this->body), 0, 300));
    }
}
