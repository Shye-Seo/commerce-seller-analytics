<?php

declare(strict_types=1);

namespace SellerScope\Tests\Http;

use PHPUnit\Framework\TestCase;
use SellerScope\Http\BadRequestException;
use SellerScope\Http\Router;

final class RouterTest extends TestCase
{
    public function testMatchesStaticRoute(): void
    {
        $router = new Router();
        $router->get('/health', static fn (): string => 'ok');

        self::assertNotNull($router->match('GET', '/health'));
        self::assertNull($router->match('POST', '/health'));
    }

    public function testMatchesPathParameters(): void
    {
        $router = new Router();
        $router->get('/api/v1/anomalies/{id}', static fn (): string => 'detail');

        $match = $router->match('GET', '/api/v1/anomalies/42');

        self::assertNotNull($match);
        self::assertSame(['id' => '42'], $match['params']);
    }

    public function testUnknownPathReturnsNull(): void
    {
        $router = new Router();
        $router->get('/health', static fn (): string => 'ok');

        self::assertNull($router->match('GET', '/unknown'));
    }

    public function testBadRequestCarriesDetails(): void
    {
        $exception = new BadRequestException('잘못된 요청', ['field' => 'rows']);

        self::assertSame(['field' => 'rows'], $exception->details());
        self::assertSame('잘못된 요청', $exception->getMessage());
    }
}
