<?php

declare(strict_types=1);

namespace SellerScope\Services;

use SellerScope\Sens\AlimtalkDeliveryResult;
use SellerScope\Sens\AlimtalkMessage;
use SellerScope\Sens\AlimtalkSendResult;
use SellerScope\Sens\SensConfig;
use SellerScope\Sens\SensException;
use SellerScope\Support\Clock;
use SellerScope\Support\Env;
use SellerScope\Support\HttpClient;
use SellerScope\Support\HttpRequest;

/**
 * 네이버클라우드 플랫폼 SENS · 카카오 알림톡 연동
 *
 * 연동의 본질은 "서명"이다. NCP API Gateway는 요청 본문을 보지 않고 아래 문자열만
 * HMAC-SHA256으로 검증한다.
 *
 *     method + " " + URI(쿼리 포함) + "\n" + timestamp(ms) + "\n" + accessKey
 *
 * 여기서 실무에서 가장 자주 터지는 세 가지를 코드가 미리 막는다.
 *   1) URI에 **쿼리스트링까지** 넣어야 한다. path만 서명하면 401이 나고, 원인이
 *      "키가 틀렸다"처럼 보여서 한참 헤맨다.
 *   2) 서명에 쓴 timestamp 문자열을 헤더에 **그대로** 넣어야 한다(재계산 금지).
 *   3) 서버 시각이 5분 이상 어긋나면 401이다. 컨테이너의 시계를 신뢰하지 말고
 *      배포 환경에서 NTP 동기화를 확인해야 한다.
 *
 * 알림톡은 템플릿 기반이다. 카카오가 검수한 본문과 다른 문구를 보내면 3016
 * (NoMatchedTemplate)로 거절되므로, 본문은 반드시 템플릿 변수 치환으로만 만든다.
 * (SettlementAlertComposer 참고)
 */
final class NaverCloudSensService
{
    /** SENS 메시지 발송 API의 1회 최대 건수(공식 문서 기준). */
    public const MAX_MESSAGES_PER_REQUEST = 100;

    public function __construct(
        private readonly HttpClient $http,
        private readonly SensConfig $config,
        private readonly Clock $clock,
    ) {
    }

    public static function fromEnv(HttpClient $http, Clock $clock): self
    {
        return new self($http, new SensConfig(
            accessKey: Env::required('SENS_ACCESS_KEY'),
            secretKey: Env::required('SENS_SECRET_KEY'),
            serviceId: Env::required('SENS_SERVICE_ID'),
            plusFriendId: Env::get('SENS_PLUS_FRIEND_ID', '@sellerscope') ?? '@sellerscope',
            anomalyTemplateCode: Env::get('SENS_TEMPLATE_ANOMALY', 'SS_ANOMALY_CRITICAL') ?? 'SS_ANOMALY_CRITICAL',
            summaryTemplateCode: Env::get('SENS_TEMPLATE_SUMMARY', 'SS_BATCH_SUMMARY') ?? 'SS_BATCH_SUMMARY',
            failoverFrom: Env::get('SENS_FAILOVER_FROM'),
            baseUrl: Env::get('SENS_BASE_URL', 'https://sens.apigw.ntruss.com') ?? 'https://sens.apigw.ntruss.com',
        ), $clock);
    }

    /**
     * 서명 생성(순수 함수).
     *
     * 테스트에서 고정 벡터로 검증할 수 있도록 설정 객체에 의존하지 않는 정적 메서드로 둔다.
     * 같은 입력이면 언제나 같은 서명이 나와야 하고, 그 성질이 곧 회귀 테스트의 기반이다.
     */
    public static function sign(
        string $method,
        string $uriPath,
        string $timestamp,
        string $accessKey,
        string $secretKey,
    ): string {
        $message = strtoupper($method) . ' ' . $uriPath . "\n" . $timestamp . "\n" . $accessKey;

        return base64_encode(hash_hmac('sha256', $message, $secretKey, true));
    }

    public function signatureFor(string $method, string $uriPath, string $timestamp): string
    {
        return self::sign($method, $uriPath, $timestamp, $this->config->accessKey, $this->config->secretKey);
    }

    /**
     * 한 건 발송.
     */
    public function send(AlimtalkMessage $message, ?\DateTimeImmutable $reserveAt = null): AlimtalkSendResult
    {
        $results = $this->sendBatch([$message], $reserveAt);

        return $results[0];
    }

    /**
     * 여러 건 발송.
     *
     * 템플릿 코드·채널·예약 시각이 다른 메시지는 **한 요청에 섞을 수 없다**. SENS는
     * 요청 단위로 templateCode를 하나만 받기 때문이다. 그래서 그룹핑 후 그룹마다
     * 100건씩 잘라 보내고, 그룹별 결과를 순서대로 돌려준다.
     *
     * @param list<AlimtalkMessage> $messages
     * @return list<AlimtalkSendResult>
     */
    public function sendBatch(array $messages, ?\DateTimeImmutable $reserveAt = null): array
    {
        if ($messages === []) {
            return [];
        }

        $groups = [];
        foreach ($messages as $message) {
            $groupKey = $message->templateCode . '|' . $message->plusFriendId;
            $groups[$groupKey][] = $message;
        }

        $results = [];
        foreach ($groups as $group) {
            foreach (array_chunk($group, self::MAX_MESSAGES_PER_REQUEST) as $chunk) {
                $results[] = $this->dispatch($chunk, $reserveAt);
            }
        }

        return $results;
    }

    /**
     * 건별 도달 결과 조회. 알림을 보낸 뒤 최소 수 초~수십 초 지나야 확정된다.
     */
    public function fetchDelivery(string $messageId): AlimtalkDeliveryResult
    {
        $uriPath = sprintf(
            '/alimtalk/v2/services/%s/messages/%s',
            $this->serviceIdPath(),
            rawurlencode($messageId),
        );

        $response = $this->http->send(new HttpRequest(
            method: 'GET',
            url: $this->config->baseUrl . $uriPath,
            headers: $this->buildHeaders('GET', $uriPath, null),
            timeoutSeconds: $this->config->timeoutSeconds,
        ));

        if (!$response->isSuccess()) {
            throw SensException::fromHttpStatus($response->status, $response->body, $uriPath);
        }

        return AlimtalkDeliveryResult::fromResponse($response->json());
    }

    /**
     * @param list<AlimtalkMessage> $chunk
     */
    private function dispatch(array $chunk, ?\DateTimeImmutable $reserveAt): AlimtalkSendResult
    {
        $first = $chunk[0];
        $uriPath = sprintf('/alimtalk/v2/services/%s/messages', $this->serviceIdPath());

        $body = [
            'plusFriendId' => $first->plusFriendId,
            'templateCode' => $first->templateCode,
            'messages' => array_map(static fn (AlimtalkMessage $m): array => $m->toPayload(), $chunk),
        ];
        if ($reserveAt !== null) {
            $body['reserveTime'] = $reserveAt->format('Y-m-d H:i');
            $body['reserveTimeZone'] = 'Asia/Seoul';
        }

        $payload = json_encode($body, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);

        $response = $this->http->send(new HttpRequest(
            method: 'POST',
            url: $this->config->baseUrl . $uriPath,
            headers: $this->buildHeaders('POST', $uriPath, $payload),
            body: $payload,
            timeoutSeconds: $this->config->timeoutSeconds,
        ));

        if (!$response->isSuccess()) {
            throw SensException::fromHttpStatus($response->status, $response->body, $uriPath);
        }

        $result = AlimtalkSendResult::fromResponse($response->json());
        if (!$result->isAccepted()) {
            throw new SensException(
                'SENS가 발송을 접수하지 않았습니다: ' . $result->statusName,
                httpStatus: $response->status,
                responseBody: $response->body,
                hint: 'requestId/statusCode를 로그에서 확인하고, 템플릿 코드가 검수 완료 상태인지 보세요.',
            );
        }

        return $result;
    }

    /**
     * @return array<string,string>
     */
    /**
     * 서비스 ID는 `ncp:kkobizmsg:kr:{번호}:sens` 처럼 콜론을 포함한다.
     * rawurlencode로 %3A로 바꾸면 실제 요청 경로와 서명 문자열이 달라져 401이 난다.
     * 설정값(환경변수)이므로 허용 문자만 남겨 경로 주입을 막는다.
     */
    private function serviceIdPath(): string
    {
        $safe = preg_replace('/[^A-Za-z0-9:\-_.]/', '', $this->config->serviceId) ?? '';

        return $safe !== '' ? $safe : $this->config->serviceId;
    }

    private function buildHeaders(string $method, string $uriPath, ?string $body): array
    {
        // 서명과 헤더가 같은 timestamp를 쓰도록 한 번만 만든다.
        $timestamp = $this->clock->epochMillisAsString();

        $headers = [
            'x-ncp-apigw-timestamp' => $timestamp,
            'x-ncp-iam-access-key' => $this->config->accessKey,
            'x-ncp-apigw-signature-v2' => $this->signatureFor($method, $uriPath, $timestamp),
        ];
        if ($body !== null) {
            $headers['Content-Type'] = 'application/json; charset=utf-8';
        }

        return $headers;
    }
}
