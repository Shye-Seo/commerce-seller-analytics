<?php

declare(strict_types=1);

namespace SellerScope\Tests\Support;

use SellerScope\Support\HttpClient;
use SellerScope\Support\HttpRequest;
use SellerScope\Support\HttpResponse;

/**
 * 테스트용 HTTP 클라이언트.
 *
 * 큐에 넣은 응답을 순서대로 돌려주고, 실제로 나간 요청을 전부 기록한다.
 * 외부 API 테스트에서 중요한 것은 "응답을 잘 처리하는가"만이 아니라
 * "무엇을 보냈는가"(헤더·본문·서명)이므로 요청 기록을 남긴다.
 */
final class StubHttpClient implements HttpClient
{
    /** @var list<HttpRequest> */
    public array $requests = [];

    /** @var list<HttpResponse|\Throwable> */
    private array $queue = [];

    public function queueResponse(int $status, string $body, array $headers = []): self
    {
        $this->queue[] = new HttpResponse($status, $body, $headers);

        return $this;
    }

    public function queueJson(int $status, array $payload): self
    {
        return $this->queueResponse($status, json_encode($payload, JSON_UNESCAPED_UNICODE) ?: '{}');
    }

    public function queueThrowable(\Throwable $error): self
    {
        $this->queue[] = $error;

        return $this;
    }

    public function send(HttpRequest $request): HttpResponse
    {
        $this->requests[] = $request;

        if ($this->queue === []) {
            throw new \LogicException('StubHttpClient: 준비된 응답이 없습니다.');
        }

        $next = array_shift($this->queue);
        if ($next instanceof \Throwable) {
            throw $next;
        }

        return $next;
    }

    public function lastRequest(): ?HttpRequest
    {
        return $this->requests === [] ? null : $this->requests[array_key_last($this->requests)];
    }
}
