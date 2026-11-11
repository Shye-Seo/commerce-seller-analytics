<?php

declare(strict_types=1);

namespace SellerScope\Http;

/**
 * JSON 응답.
 *
 * 상태 코드 규칙을 한 곳에 고정한다.
 *   200 조회 성공 / 201 배치 적재 성공 / 400 입력 오류 / 404 없음
 *   409 멱등 키 충돌(같은 배치 재전송) / 500 서버 오류
 * 4xx 응답에는 항상 `error.code`를 넣는다. 클라이언트(콘솔)가 문구가 아니라 코드로 분기한다.
 */
final class JsonResponse
{
    public static function send(array $payload, int $status = 200): void
    {
        if (!headers_sent()) {
            http_response_code($status);
            header('Content-Type: application/json; charset=utf-8');
            header('Cache-Control: no-store');
        }
        echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }

    public static function error(string $code, string $message, int $status = 400, array $details = []): void
    {
        self::send([
            'error' => [
                'code' => $code,
                'message' => $message,
                'details' => $details,
            ],
        ], $status);
    }
}
