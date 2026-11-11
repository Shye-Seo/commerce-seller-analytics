<?php

declare(strict_types=1);

namespace SellerScope\Http;

/**
 * 최소 HTTP 요청 객체.
 *
 * 프레임워크를 쓰지 않은 이유는 이 백엔드의 계약이 세 엔드포인트뿐이기 때문이다.
 * 라우터를 직접 만들면 의존성이 0이 되고, 면접에서 "무엇이 어떻게 동작하는지"를
 * 프레임워크 지식 없이 설명할 수 있다. 대신 경계(입력 검증·에러 응답)는 명시적으로 둔다.
 */
final readonly class Request
{
    /**
     * @param array<string,string> $headers 소문자 키
     * @param array<string,string> $query
     * @param array<string,mixed>  $json  파싱된 JSON 본문(없으면 빈 배열)
     */
    public function __construct(
        public string $method,
        public string $path,
        public array $headers,
        public array $query,
        public array $json,
        public string $rawBody,
        public ?string $clientIp = null,
    ) {
    }

    public static function fromGlobals(): self
    {
        $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
        $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

        $headers = [];
        foreach ($_SERVER as $key => $value) {
            if (str_starts_with($key, 'HTTP_')) {
                $headers[strtolower(str_replace('_', '-', substr($key, 5)))] = (string) $value;
            }
        }
        // Authorization·Content-Type은 HTTP_ 접두어가 아닌 경우가 있다.
        if (isset($_SERVER['CONTENT_TYPE'])) {
            $headers['content-type'] = (string) $_SERVER['CONTENT_TYPE'];
        }

        $raw = file_get_contents('php://input') ?: '';
        $json = [];
        if (trim($raw) !== '' && str_contains($headers['content-type'] ?? '', 'json')) {
            $decoded = json_decode($raw, true);
            if (!is_array($decoded)) {
                throw new BadRequestException('JSON 본문을 해석할 수 없습니다.');
            }
            $json = $decoded;
        }

        return new self(
            method: $method,
            path: rtrim($path, '/') ?: '/',
            headers: $headers,
            query: array_map('strval', $_GET),
            json: $json,
            rawBody: $raw,
            clientIp: $_SERVER['REMOTE_ADDR'] ?? null,
        );
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    public function queryString(string $key): ?string
    {
        $value = $this->query[$key] ?? null;

        return $value === null || $value === '' ? null : $value;
    }
}
