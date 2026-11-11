<?php

declare(strict_types=1);

/**
 * HTTP 진입점(front controller).
 *
 * 실행: php -S 127.0.0.1:8080 -t backend/public
 *
 * 여기서 하는 일은 세 가지뿐이다.
 *   1) 의존성 조립(환경변수 → Connection → 저장소 → 서비스 → 컨트롤러)
 *   2) 라우팅
 *   3) 오류를 JSON으로 정규화 (4xx=입력 문제, 5xx=서버 문제)
 *
 * SENS 설정이 없으면 알림 기능만 비활성화된다. 알림은 부가 기능이므로, 키를 아직 넣지
 * 않은 개발 환경에서도 대사 API는 그대로 동작해야 한다.
 */

require __DIR__ . '/../vendor/autoload.php';

use SellerScope\Controllers\ReconciliationController;
use SellerScope\Database\Connection;
use SellerScope\Http\BadRequestException;
use SellerScope\Http\JsonResponse;
use SellerScope\Http\Request;
use SellerScope\Http\Router;
use SellerScope\Repositories\AlimtalkLogRepository;
use SellerScope\Repositories\AnomalyRepository;
use SellerScope\Repositories\AuditLogRepository;
use SellerScope\Repositories\SettlementRepository;
use SellerScope\Sens\SensConfig;
use SellerScope\Services\NaverCloudSensService;
use SellerScope\Services\SettlementAlertComposer;
use SellerScope\Services\SettlementAlertNotifier;
use SellerScope\Services\SettlementReconciliationService;
use SellerScope\Support\CurlHttpClient;
use SellerScope\Support\Env;
use SellerScope\Support\SystemClock;

Env::load(__DIR__ . '/../.env');

$debug = Env::bool('APP_DEBUG', false);

try {
    $clock = new SystemClock(Env::get('DB_TIMEZONE', '+09:00') ?? '+09:00');
    $connection = Connection::fromEnv();

    $settlements = new SettlementRepository($connection);
    $anomalies = new AnomalyRepository($connection);
    $alimtalkLogs = new AlimtalkLogRepository($connection);
    $audit = new AuditLogRepository($connection);

    $notifier = null;
    $sensKeysConfigured = Env::get('SENS_ACCESS_KEY') !== null
        && Env::get('SENS_SECRET_KEY') !== null
        && Env::get('SENS_SERVICE_ID') !== null;

    if ($sensKeysConfigured) {
        $sensConfig = new SensConfig(
            accessKey: Env::required('SENS_ACCESS_KEY'),
            secretKey: Env::required('SENS_SECRET_KEY'),
            serviceId: Env::required('SENS_SERVICE_ID'),
            plusFriendId: Env::get('SENS_PLUS_FRIEND_ID', '@sellerscope') ?? '@sellerscope',
            anomalyTemplateCode: Env::get('SENS_TEMPLATE_ANOMALY', 'SS_ANOMALY_CRITICAL') ?? 'SS_ANOMALY_CRITICAL',
            summaryTemplateCode: Env::get('SENS_TEMPLATE_SUMMARY', 'SS_BATCH_SUMMARY') ?? 'SS_BATCH_SUMMARY',
            failoverFrom: Env::get('SENS_FAILOVER_FROM'),
        );
        $notifier = new SettlementAlertNotifier(
            new NaverCloudSensService(new CurlHttpClient(), $sensConfig, $clock),
            $alimtalkLogs,
            new SettlementAlertComposer(),
            $sensConfig,
            $clock,
        );
    }

    $controller = new ReconciliationController(
        new SettlementReconciliationService(),
        $settlements,
        $anomalies,
        $alimtalkLogs,
        $audit,
        $connection,
        $clock,
        $notifier,
    );

    $router = new Router();
    $router->get('/health', static fn (): array => [
        'status' => 'ok',
        'service' => 'sellerscope-backend',
        'time' => (new \DateTimeImmutable())->format(\DateTimeInterface::ATOM),
        'alimtalk' => $sensKeysConfigured ? 'enabled' : 'disabled(no SENS credentials)',
    ]);
    $router->post('/api/v1/reconciliations', static fn (Request $r): array => $controller->store($r));
    $router->get('/api/v1/reconciliations/summary', static fn (Request $r): array => $controller->summary($r));
    $router->get('/api/v1/reconciliations/rows', static fn (Request $r): array => $controller->rows($r));
    $router->get('/api/v1/anomalies', static fn (Request $r): array => $controller->anomalies($r));

    $request = Request::fromGlobals();
    $match = $router->match($request->method, $request->path);

    if ($match === null) {
        JsonResponse::error('not_found', "등록되지 않은 경로입니다: {$request->method} {$request->path}", 404);
        exit;
    }

    $payload = ($match['handler'])($request, $match['params']);
    $status = ($request->method === 'POST' && $request->path === '/api/v1/reconciliations') ? 201 : 200;
    JsonResponse::send($payload, $status);
} catch (BadRequestException $e) {
    JsonResponse::error('invalid_request', $e->getMessage(), 400, $e->details());
} catch (\Throwable $e) {
    error_log(sprintf('[sellerscope] %s: %s in %s:%d', get_class($e), $e->getMessage(), $e->getFile(), $e->getLine()));
    JsonResponse::error(
        'internal_error',
        $debug ? $e->getMessage() : '서버 오류가 발생했습니다. 잠시 후 다시 시도하세요.',
        500,
        $debug ? ['trace' => explode("\n", $e->getTraceAsString())] : [],
    );
}
