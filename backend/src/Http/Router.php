<?php

declare(strict_types=1);

namespace SellerScope\Http;

/**
 * 라우터.
 *
 * 경로 파라미터가 필요한 만큼만 구현한다(`/api/v1/anomalies/{id}`). 정규식으로
 * 세그먼트를 잡고, 매칭되면 핸들러에 파라미터 배열을 넘긴다.
 */
final class Router
{
    /** @var list<array{method:string, pattern:string, handler:callable}> */
    private array $routes = [];

    public function add(string $method, string $pattern, callable $handler): void
    {
        $this->routes[] = ['method' => strtoupper($method), 'pattern' => $pattern, 'handler' => $handler];
    }

    public function get(string $pattern, callable $handler): void
    {
        $this->add('GET', $pattern, $handler);
    }

    public function post(string $pattern, callable $handler): void
    {
        $this->add('POST', $pattern, $handler);
    }

    /**
     * @return array{handler:callable, params:array<string,string>}|null
     */
    public function match(string $method, string $path): ?array
    {
        foreach ($this->routes as $route) {
            if ($route['method'] !== strtoupper($method)) {
                continue;
            }
            $regex = '#^' . preg_replace('/\{([a-zA-Z_]+)\}/', '(?P<$1>[^/]+)', $route['pattern']) . '$#';
            if (preg_match($regex, $path, $matches) === 1) {
                $params = array_filter($matches, static fn ($key): bool => is_string($key), ARRAY_FILTER_USE_KEY);

                return ['handler' => $route['handler'], 'params' => $params];
            }
        }

        return null;
    }
}
