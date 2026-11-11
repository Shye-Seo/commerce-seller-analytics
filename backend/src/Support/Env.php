<?php

declare(strict_types=1);

namespace SellerScope\Support;

/**
 * .env 로더(의존성 없는 최소 구현).
 *
 * 왜 vlucas/phpdotenv를 쓰지 않았나: 이 백엔드는 "컨테이너 하나와 MySQL 하나"로 뜨는
 * 것을 목표로 한다. 배포 환경(예: NCP Container Registry + Cloud Functions)에서는
 * 환경변수를 런타임이 주입하므로 .env 파서가 필요 없고, 로컬 개발에서만 쓰는 기능에
 * 패키지를 하나 더 다는 대신 40줄로 끝냈다.
 *
 * 규칙: 이미 설정된 실제 환경변수를 .env가 덮어쓰지 않는다(배포 환경 우선).
 */
final class Env
{
    private static bool $loaded = false;

    public static function load(string $path): void
    {
        if (self::$loaded || !is_readable($path)) {
            return;
        }
        self::$loaded = true;

        $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '' || str_starts_with($line, '#')) {
                continue;
            }
            if (!str_contains($line, '=')) {
                continue;
            }
            [$key, $value] = explode('=', $line, 2);
            $key = trim($key);
            $value = trim($value);
            if ($value !== '' && ($value[0] === '"' || $value[0] === "'")) {
                $value = substr($value, 1, -1);
            }
            if ($key === '' || getenv($key) !== false) {
                continue;
            }
            putenv("{$key}={$value}");
            $_ENV[$key] = $value;
        }
    }

    public static function get(string $key, ?string $default = null): ?string
    {
        $value = getenv($key);

        return ($value === false || $value === '') ? $default : $value;
    }

    public static function required(string $key): string
    {
        $value = self::get($key);
        if ($value === null) {
            throw new \RuntimeException("환경 변수 {$key} 가 설정되지 않았습니다. backend/.env.example 을 참고하세요.");
        }

        return $value;
    }

    public static function int(string $key, int $default = 0): int
    {
        $value = self::get($key);

        return $value === null ? $default : (int) $value;
    }

    public static function bool(string $key, bool $default = false): bool
    {
        $value = self::get($key);
        if ($value === null) {
            return $default;
        }

        return in_array(strtolower($value), ['1', 'true', 'yes', 'on'], true);
    }
}
