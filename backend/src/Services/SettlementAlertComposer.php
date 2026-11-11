<?php

declare(strict_types=1);

namespace SellerScope\Services;

use SellerScope\Domain\Anomaly;
use SellerScope\Domain\AnomalyType;
use SellerScope\Domain\Money;
use SellerScope\Domain\ReconciledRow;
use SellerScope\Domain\ReconciliationSummary;

/**
 * 알림톡 본문 합성.
 *
 * 카카오 알림톡은 "자유 문장 발송"이 아니라 "검수된 템플릿 + 변수 치환"이다. 그래서 이
 * 클래스는 문장을 창작하지 않고, 템플릿에 약속된 변수만 채운다.
 *
 * 등록해야 하는 두 템플릿(콘솔 > 채널 > 알림톡 템플릿)
 *
 *   SS_ANOMALY_CRITICAL
 *     [#{tenant_name}] 정산 이상 감지 - #{anomaly_label}
 *     주문 #{order_no} · #{product_name}
 *     기대 #{expected_amount} / 정산 #{actual_amount}
 *     추정 손실 #{loss_amount}
 *     #{detail}
 *     정산 담당자 확인이 필요합니다.
 *
 *   SS_BATCH_SUMMARY
 *     [#{tenant_name}] 정산 대사 완료
 *     대상 #{total_rows}건 · 이상 #{flagged_rows}건
 *     추정 손실 #{total_leak}
 *     최대 원인 #{top_cause}
 *     상세 #{console_url}
 *
 * 변수 값에 개행을 넣지 않는다(알림톡 본문이 깨지고, 템플릿 대조에서 어긋난다).
 * 본문 상한은 1,000자이며, 초과 시 AlimtalkMessage가 생성 단계에서 거부한다.
 */
final class SettlementAlertComposer
{
    public function __construct(
        private readonly string $consoleUrl = 'https://sellerscope.example.com/reconciliation',
    ) {
    }

    public function contentForAnomaly(string $tenantName, ReconciledRow $row, Anomaly $anomaly): string
    {
        $content = sprintf(
            "[%s] 정산 이상 감지 - %s\n주문 %s · %s\n기대 %s / 정산 %s\n추정 손실 %s\n%s\n정산 담당자 확인이 필요합니다.",
            $this->line($tenantName),
            $anomaly->type->shortLabel(),
            $this->line($row->row->orderNo),
            $this->line($row->row->productName, 40),
            Money::format($anomaly->expected),
            Money::format($anomaly->actual),
            Money::format($anomaly->loss),
            $this->line($anomaly->detail, 160),
        );

        return mb_substr($content, 0, 1000);
    }

    public function contentForSummary(
        string $tenantName,
        ReconciliationSummary $summary,
        string $batchLabel,
        ?string $recipientRole = null,
    ): string {
        $top = $summary->biggestLeakCause();
        $topText = $top === null
            ? '없음'
            : sprintf('%s %s', $top['label'], Money::format($top['amount']));

        $content = sprintf(
            "[%s] 정산 대사 완료(%s)\n대상 %s건 · 이상 %s건\n추정 손실 %s\n최대 원인 %s\n상세 %s",
            $this->line($tenantName),
            $this->line($batchLabel, 24),
            number_format($summary->totalRows),
            number_format($summary->flaggedRows),
            Money::format($summary->totalLeak),
            $topText,
            $this->consoleUrl,
        );

        return mb_substr($content, 0, 1000);
    }

    /**
     * 알림 중복 방지 키.
     *
     * 같은 정산서를 두 번 올리거나 배치가 재시도돼도, 같은 주문·같은 원인으로는 한 번만
     * 알린다. 정산 담당자에게 같은 알림이 세 번 오면 그 알림은 곧 무시된다.
     * (배치 요약은 배치 단위로 1회.)
     */
    public function dedupeKeyForAnomaly(int $tenantId, ReconciledRow $row, AnomalyType $type): string
    {
        return sprintf('anomaly:%d:%s:%s', $tenantId, $row->row->id(), $type->value);
    }

    public function dedupeKeyForSummary(int $tenantId, string $batchId): string
    {
        return sprintf('summary:%d:%s', $tenantId, $batchId);
    }

    /** 변수에는 한 줄만 들어가야 한다(개행·연속 공백 제거). */
    private function line(string $value, int $maxLength = 60): string
    {
        $clean = preg_replace('/\s+/u', ' ', trim($value)) ?? '';

        return mb_strlen($clean) > $maxLength ? mb_substr($clean, 0, $maxLength - 1) . '…' : $clean;
    }
}
