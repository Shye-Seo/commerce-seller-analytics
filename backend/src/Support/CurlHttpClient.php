<?php

declare(strict_types=1);

namespace SellerScope\Support;

/**
 * curl 기반 실제 HTTP 클라이언트.
 *
 * 타임아웃을 두 단계(연결 5s / 전체 10s)로 나눈 이유: SENS는 정상일 때 200ms 안에 응답한다.
 * 연결이 안 되는 상황(NCP 리전 장애)에서 30초씩 기다리면 배치 하나가 300초를 잡아먹고,
 * 뒤에 줄 선 알림이 전부 늦는다. 실패는 빨리 실패하는 편이 낫다.
 *
 * CURLOPT_HEADER로 헤더를 분리 수집해 재시도 힌트(Retry-After)를 읽을 수 있게 한다.
 */
final class CurlHttpClient implements HttpClient
{
    public function send(HttpRequest $request): HttpResponse
    {
        $handle = curl_init();

        $headerLines = [];
        $headers = [];
        foreach ($request->headers as $name => $value) {
            $headers[] = "{$name}: {$value}";
        }

        curl_setopt_array($handle, [
            CURLOPT_URL => $request->url,
            CURLOPT_CUSTOMREQUEST => strtoupper($request->method),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HEADER => false,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_TIMEOUT => $request->timeoutSeconds,
            CURLOPT_CONNECTTIMEOUT => $request->connectTimeoutSeconds,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_SSL_VERIFYPEER => true,
            // 헤더를 별도 수집: 상태 코드/재시도 힌트를 본문과 분리해야 파싱이 안전하다.
            CURLOPT_HEADERFUNCTION => static function ($_, string $line) use (&$headerLines): int {
                $headerLines[] = trim($line);

                return strlen($line);
            },
        ]);

        if ($request->body !== null) {
            curl_setopt($handle, CURLOPT_POSTFIELDS, $request->body);
        }

        $body = curl_exec($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        $error = curl_error($handle);
        curl_close($handle);

        if ($body === false) {
            throw new \RuntimeException("HTTP 요청 실패({$request->method} {$request->url}): {$error}");
        }

        foreach ($headerLines as $line) {
            if (str_starts_with($line, 'HTTP/') || !str_contains($line, ':')) {
                continue;
            }
            [$name, $value] = explode(':', $line, 2);
            $headers[strtolower(trim($name))] = trim($value);
        }

        return new HttpResponse($status, (string) $body, $headers, $request->url);
    }
}
