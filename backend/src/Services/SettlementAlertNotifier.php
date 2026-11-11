<?php

declare(strict_types=1);

namespace SellerScope\Services;

use SellerScope\Domain\Anomaly;
use SellerScope\Domain\ReconciledRow;
use SellerScope\Domain\ReconciliationSummary;
use SellerScope\Repositories\AlimtalkLogStore;
use SellerScope\Sens\AlimtalkMessage;
use SellerScope\Sens\SensConfig;
use SellerScope\Sens\SensException;
use SellerScope\Support\Clock;

/**
 * 이상 탐지 → 알림톡 발송 오케스트레이션.
 *
 * 설계 원칙: **알림 실패가 대사를 실패시키지 않는다.**
 *   정산 대사는 돈이 걸린 배치다. 알림톡 서버가 죽었다고 배치를 롤백하면, 셀러는 그날
 *   정산 결과를 아예 못 본다. 그래서 알림은 "부가 효과"로 분리하고, 실패는 알림 이력에
 *   남겨 재시도 큐(status='failed')로 넘긴다.
 *
 * 흐름(건별)
 *   1. dedupe_key로 이미 보낸 알림인지 확인 → 보냈으면 skip (배치 재실행 안전)
 *   2. queued 상태로 이력을 먼저 적재 → 발송 전에 죽어도 "보내려 했다"가 남는다
 *   3. SENS 발송 → accepted(202)로 갱신, request_id/message_id 저장
 *   4. 실패하면 failed + error_message. 재시도 대상이면 retryable 표시
 */
final class SettlementAlertNotifier
{
    /** 한 주문에서 보내는 알림 상한. 한 행에 원인이 5개 붙으면 문자가 5통 오는 셈이라 자른다. */
    private const MAX_ALERTS_PER_ORDER = 2;

    public function __construct(
        private readonly NaverCloudSensService $sens,
        private readonly AlimtalkLogStore $logs,
        private readonly SettlementAlertComposer $composer,
        private readonly SensConfig $config,
        private readonly Clock $clock,
    ) {
    }

    /**
     * 심각(critical) 이상만 골라 발송한다.
     *
     * @param list<ReconciledRow> $rows
     * @return array{sent:int,skipped:int,failed:int,errors:list<string>}
     */
    public function notifyCriticalAnomalies(
        int $tenantId,
        string $tenantName,
        string $batchId,
        string $recipientPhone,
        array $rows,
    ): array {
        $sent = 0;
        $skipped = 0;
        $failed = 0;
        $errors = [];

        foreach ($rows as $row) {
            if ($row->isReconciled()) {
                continue;
            }
            foreach (array_slice($row->criticalAnomalies(), 0, self::MAX_ALERTS_PER_ORDER) as $anomaly) {
                $dedupeKey = $this->composer->dedupeKeyForAnomaly($tenantId, $row, $anomaly->type);

                $logId = $this->logs->claim(
                    tenantId: $tenantId,
                    dedupeKey: $dedupeKey,
                    templateCode: $this->config->anomalyTemplateCode,
                    plusFriendId: $this->config->plusFriendId,
                    recipientPhone: $recipientPhone,
                    batchId: $batchId,
                    payload: ['orderNo' => $row->row->orderNo, 'anomalyType' => $anomaly->type->value],
                    now: $this->clock->now(),
                );

                if ($logId === null) {
                    $skipped++; // 이미 보낸 알림
                    continue;
                }

                try {
                    $message = new AlimtalkMessage(
                        to: $recipientPhone,
                        content: $this->composer->contentForAnomaly($tenantName, $row, $anomaly),
                        templateCode: $this->config->anomalyTemplateCode,
                        plusFriendId: $this->config->plusFriendId,
                        failoverFrom: $this->config->failoverFrom,
                        useSmsFailover: $this->config->failoverFrom !== null,
                    );

                    $result = $this->sens->send($message);
                    $this->logs->markAccepted($logId, $result, $message, $this->clock->now());
                    $sent++;
                } catch (SensException $e) {
                    $failed++;
                    $errors[] = $e->getMessage() . ' — ' . $e->hint;
                    $this->logs->markFailed($logId, $e->getMessage() . ' ' . $e->hint, $this->clock->now());
                } catch (\Throwable $e) {
                    $failed++;
                    $errors[] = $e->getMessage();
                    $this->logs->markFailed($logId, $e->getMessage(), $this->clock->now());
                }
            }
        }

        return ['sent' => $sent, 'skipped' => $skipped, 'failed' => $failed, 'errors' => $errors];
    }

    /** 배치 1회 요약 알림(하루 1통). */
    public function notifyBatchSummary(
        int $tenantId,
        string $tenantName,
        string $batchId,
        string $recipientPhone,
        ReconciliationSummary $summary,
        string $batchLabel,
    ): bool {
        $dedupeKey = $this->composer->dedupeKeyForSummary($tenantId, $batchId);
        $logId = $this->logs->claim(
            tenantId: $tenantId,
            dedupeKey: $dedupeKey,
            templateCode: $this->config->summaryTemplateCode,
            plusFriendId: $this->config->plusFriendId,
            recipientPhone: $recipientPhone,
            batchId: $batchId,
            payload: ['totalRows' => $summary->totalRows, 'flaggedRows' => $summary->flaggedRows],
            now: $this->clock->now(),
        );
        if ($logId === null) {
            return false;
        }

        try {
            $message = new AlimtalkMessage(
                to: $recipientPhone,
                content: $this->composer->contentForSummary($tenantName, $summary, $batchLabel),
                templateCode: $this->config->summaryTemplateCode,
                plusFriendId: $this->config->plusFriendId,
            );
            $result = $this->sens->send($message);
            $this->logs->markAccepted($logId, $result, $message, $this->clock->now());

            return true;
        } catch (\Throwable $e) {
            $this->logs->markFailed($logId, $e->getMessage(), $this->clock->now());

            return false;
        }
    }
}
