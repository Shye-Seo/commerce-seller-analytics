<?php

declare(strict_types=1);

namespace SellerScope\Tests\Services;

use PHPUnit\Framework\TestCase;
use SellerScope\Sens\AlimtalkMessage;
use SellerScope\Sens\RecipientPhone;
use SellerScope\Sens\SensConfig;
use SellerScope\Sens\SensException;
use SellerScope\Services\NaverCloudSensService;
use SellerScope\Tests\Support\FixedClock;
use SellerScope\Tests\Support\StubHttpClient;

/**
 * SENS 연동 테스트.
 *
 * 서명 벡터는 PHP로 만든 값을 PHP로 확인하는 순환이 되지 않도록,
 * 독립 구현(Python hmac + base64)으로 미리 계산한 값을 상수로 박아 두었다.
 * 이 값이 틀리면 실제 NCP API에서 401이 나므로, 테스트가 곧 실패 재현 장치다.
 */
final class NaverCloudSensServiceTest extends TestCase
{
    private const SERVICE_ID = 'ncp:kkobizmsg:kr:1234567890:sens';
    private const ACCESS_KEY = 'ACCESSKEY123';
    private const SECRET_KEY = 'SECRETKEY456';
    private const TIMESTAMP = '1760000000000';

    private function config(): SensConfig
    {
        return new SensConfig(
            accessKey: self::ACCESS_KEY,
            secretKey: self::SECRET_KEY,
            serviceId: self::SERVICE_ID,
            plusFriendId: '@sellerscope',
            anomalyTemplateCode: 'SS_ANOMALY_CRITICAL',
            summaryTemplateCode: 'SS_BATCH_SUMMARY',
        );
    }

    private function service(StubHttpClient $http): NaverCloudSensService
    {
        // 2026-11-11 09:00:00 +09:00 = 1794355200000ms
        return new NaverCloudSensService($http, $this->config(), FixedClock::at('2026-11-11T09:00:00+09:00'));
    }

    private function message(string $to = '010-1234-5678', string $content = '테스트 알림톡 본문입니다.'): AlimtalkMessage
    {
        return new AlimtalkMessage(
            to: $to,
            content: $content,
            templateCode: 'SS_ANOMALY_CRITICAL',
            plusFriendId: '@sellerscope',
        );
    }

    public function testSignatureMatchesIndependentImplementationForPost(): void
    {
        $signature = NaverCloudSensService::sign(
            'POST',
            '/alimtalk/v2/services/' . self::SERVICE_ID . '/messages',
            self::TIMESTAMP,
            self::ACCESS_KEY,
            self::SECRET_KEY,
        );

        self::assertSame('9qqF+lSWmkCQJ6Ud6Ksb4Yj65WgQ1q9sulIhCp5UVZA=', $signature);
    }

    public function testSignatureMatchesIndependentImplementationForGetWithPathParam(): void
    {
        $signature = NaverCloudSensService::sign(
            'get', // 메서드는 대문자로 정규화된다
            '/alimtalk/v2/services/' . self::SERVICE_ID . '/messages/aa724ca6-1111-2222-3333-66dfc1a700e7',
            self::TIMESTAMP,
            self::ACCESS_KEY,
            self::SECRET_KEY,
        );

        self::assertSame('eu8NaknI4f8AD/ZnJnZx06pSvImMHHa7mYOQ1QwIUNA=', $signature);
    }

    public function testSendRequiresSignatureHeadersBuiltFromTheSameTimestamp(): void
    {
        $http = (new StubHttpClient())->queueJson(202, [
            'requestId' => 'REQ-1',
            'requestTime' => '2026-11-11T09:00:00.100',
            'statusCode' => '202',
            'statusName' => 'accepted',
        ]);

        $this->service($http)->send($this->message());

        $request = $http->lastRequest();
        self::assertNotNull($request);
        self::assertSame('POST', $request->method);
        self::assertSame('https://sens.apigw.ntruss.com/alimtalk/v2/services/' . self::SERVICE_ID . '/messages', $request->url);

        $timestamp = $request->headers['x-ncp-apigw-timestamp'];
        self::assertSame('1794355200000', $timestamp);
        self::assertSame(self::ACCESS_KEY, $request->headers['x-ncp-iam-access-key']);
        // 헤더의 timestamp로 다시 계산한 서명과 실제 서명이 같아야 한다.
        self::assertSame(
            NaverCloudSensService::sign('POST', '/alimtalk/v2/services/' . self::SERVICE_ID . '/messages', $timestamp, self::ACCESS_KEY, self::SECRET_KEY),
            $request->headers['x-ncp-apigw-signature-v2'],
        );
        self::assertSame('application/json; charset=utf-8', $request->headers['Content-Type']);
    }

    public function testSendBuildsOfficialRequestBodyShape(): void
    {
        $http = (new StubHttpClient())->queueJson(202, ['requestId' => 'REQ-1', 'statusCode' => '202', 'statusName' => 'accepted']);

        $this->service($http)->send($this->message('010-9876-5432', '주문 20261001-1 반품비 중복 5,000원'));

        $body = json_decode((string) $http->lastRequest()?->body, true);
        self::assertSame('@sellerscope', $body['plusFriendId']);
        self::assertSame('SS_ANOMALY_CRITICAL', $body['templateCode']);
        self::assertSame('82', $body['messages'][0]['countryCode']);
        self::assertSame('01098765432', $body['messages'][0]['to']);
        self::assertSame('주문 20261001-1 반품비 중복 5,000원', $body['messages'][0]['content']);
        self::assertArrayNotHasKey('useSmsFailover', $body['messages'][0]);
    }

    public function testFailoverConfigIsAddedOnlyWhenSenderNumberIsRegistered(): void
    {
        $http = (new StubHttpClient())->queueJson(202, ['requestId' => 'REQ-2', 'statusCode' => '202', 'statusName' => 'accepted']);

        $message = new AlimtalkMessage(
            to: '01012345678',
            content: str_repeat('가', 120), // 90자 초과 → LMS
            templateCode: 'SS_ANOMALY_CRITICAL',
            plusFriendId: '@sellerscope',
            failoverFrom: '0212345678',
            useSmsFailover: true,
        );

        $this->service($http)->send($message);

        $body = json_decode((string) $http->lastRequest()?->body, true);
        self::assertTrue($body['messages'][0]['useSmsFailover']);
        self::assertSame('LMS', $body['messages'][0]['failoverConfig']['type']);
        self::assertSame('0212345678', $body['messages'][0]['failoverConfig']['from']);
    }

    public function testBatchIsGroupedByTemplateAndChunkedAtOneHundred(): void
    {
        $http = new StubHttpClient();
        $http->queueJson(202, ['requestId' => 'A-1', 'statusCode' => '202', 'statusName' => 'accepted']);
        $http->queueJson(202, ['requestId' => 'A-2', 'statusCode' => '202', 'statusName' => 'accepted']);
        $http->queueJson(202, ['requestId' => 'B-1', 'statusCode' => '202', 'statusName' => 'accepted']);

        $messages = [];
        for ($i = 0; $i < 150; $i++) {
            $messages[] = new AlimtalkMessage('01012345678', "본문 {$i}", 'SS_ANOMALY_CRITICAL', '@sellerscope');
        }
        for ($i = 0; $i < 3; $i++) {
            $messages[] = new AlimtalkMessage('01012345678', "요약 {$i}", 'SS_BATCH_SUMMARY', '@sellerscope');
        }

        $results = $this->service($http)->sendBatch($messages);

        self::assertCount(3, $results);
        self::assertCount(3, $http->requests);

        $counts = array_map(
            static fn ($request): int => count(json_decode((string) $request->body, true)['messages']),
            $http->requests,
        );
        self::assertSame([100, 50, 3], $counts);
    }

    public function testEmptyBatchMakesNoRequest(): void
    {
        $http = new StubHttpClient();
        self::assertSame([], $this->service($http)->sendBatch([]));
        self::assertSame([], $http->requests);
    }

    public function testUnauthorizedIsNotRetryableAndExplainsClockOrKeys(): void
    {
        $http = (new StubHttpClient())->queueJson(401, ['error' => ['errorCode' => '200', 'message' => 'Authentication failed']]);

        try {
            $this->service($http)->send($this->message());
            self::fail('SensException이 발생해야 합니다.');
        } catch (SensException $e) {
            self::assertSame(401, $e->httpStatus);
            self::assertStringContainsString('서명 검증 실패', $e->hint);
            self::assertFalse($e->isRetryable());
        }
    }

    public function testTooManyRequestsIsRetryable(): void
    {
        $http = (new StubHttpClient())->queueResponse(429, '');

        try {
            $this->service($http)->send($this->message());
            self::fail('SensException이 발생해야 합니다.');
        } catch (SensException $e) {
            self::assertTrue($e->isRetryable());
            self::assertStringContainsString('한도', $e->hint);
        }
    }

    public function testNotAcceptedResponseIsRejectedEvenWith2xxStatus(): void
    {
        // 200이지만 접수 상태가 아닌 응답(방어적 처리).
        $http = (new StubHttpClient())->queueJson(200, ['statusCode' => '400', 'statusName' => 'bad_request']);

        $this->expectException(SensException::class);
        $this->service($http)->send($this->message());
    }

    public function testDeliveryResultDistinguishesDeliveredFromUncertain(): void
    {
        $http = new StubHttpClient();
        $http->queueJson(200, [
            'requestId' => 'R1', 'messageId' => 'M1', 'requestStatusCode' => 'A000',
            'messageStatusCode' => '0000', 'messageStatusName' => 'success', 'messageStatusDesc' => '정상 발송',
        ]);
        $http->queueJson(200, [
            'requestId' => 'R2', 'messageId' => 'M2', 'requestStatusCode' => 'A000',
            'messageStatusCode' => '3005', 'messageStatusName' => 'fail', 'messageStatusDesc' => 'AckTimeout',
        ]);

        $service = $this->service($http);

        $delivered = $service->fetchDelivery('M1');
        self::assertTrue($delivered->isDelivered());
        self::assertFalse($delivered->isUncertain());

        $uncertain = $service->fetchDelivery('M2');
        self::assertFalse($uncertain->isDelivered());
        self::assertTrue($uncertain->isUncertain());
    }

    public function testPhoneNumbersAreNormalizedToDomesticDigits(): void
    {
        self::assertSame('01012345678', RecipientPhone::fromString('010-1234-5678')->digits);
        self::assertSame('01012345678', RecipientPhone::fromString('+82 10-1234-5678')->digits);
        self::assertSame('01012345678', RecipientPhone::fromString('+821012345678')->digits);
        self::assertSame('010-****-5678', RecipientPhone::fromString('01012345678')->masked());
    }

    public function testLandlineIsRejectedBecauseAlimtalkGoesToMobile(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        RecipientPhone::fromString('02-123-4567');
    }

    public function testMessageLongerThanOneThousandCharactersIsRejectedBeforeSending(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new AlimtalkMessage('01012345678', str_repeat('가', 1001), 'SS_ANOMALY_CRITICAL', '@sellerscope');
    }

    public function testAuditPayloadMasksRecipientNumber(): void
    {
        $message = $this->message('01012345678');
        self::assertSame('010-****-5678', $message->toAuditArray()['to']);
    }

    public function testConfigRejectsChannelIdWithoutAtSign(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new SensConfig('AK', 'SK', self::SERVICE_ID, 'sellerscope', 'T1', 'T2');
    }
}
