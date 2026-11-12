<?php

declare(strict_types=1);

namespace SellerScope\Domain\Promotion;

/**
 * 발급 결과.
 *
 * `plainCode`는 **발급 순간에만** 채워진다. 이후 조회(멱등 재전송, 원장 조회)에서는
 * null이고 `coupon->codeHash`만 남는다. 원문을 응답에 다시 실어 보내면 그 응답이
 * 프록시 로그에 남아 쿠폰이 유출된다.
 *
 * `attempts`는 낙관적 락 재시도 횟수다. 이 숫자가 커지면 "지금 경합이 심하다"는
 * 신호이고, 운영 콘솔의 락 경합 방어율 지표가 된다.
 */
final class IssueResult
{
    private function __construct(
        public readonly IssueOutcome $outcome,
        public readonly ?Coupon $coupon = null,
        public readonly ?string $plainCode = null,
        public readonly ?MarginAssessment $margin = null,
        public readonly ?InventorySnapshot $inventory = null,
        public readonly string $reason = '',
        public readonly int $attempts = 1,
    ) {
    }

    public static function issued(
        Coupon $coupon,
        string $plainCode,
        MarginAssessment $margin,
        InventorySnapshot $inventory,
        int $attempts = 1,
    ): self {
        return new self(IssueOutcome::Issued, $coupon, $plainCode, $margin, $inventory, '', $attempts);
    }

    /** 상태 전이(예약·사용·정산·취소·만료) 성공 결과. */
    public static function changed(
        ?Coupon $coupon,
        ?MarginAssessment $margin = null,
        ?InventorySnapshot $inventory = null,
    ): self {
        return new self(IssueOutcome::Issued, $coupon, null, $margin, $inventory);
    }

    public static function replay(Coupon $coupon, MarginAssessment $margin): self
    {
        return new self(IssueOutcome::IdempotentReplay, $coupon, null, $margin, null, '같은 멱등 키의 재전송 — 기존 쿠폰을 반환했습니다.');
    }

    public static function rejected(
        IssueOutcome $outcome,
        string $reason,
        ?MarginAssessment $margin = null,
        ?InventorySnapshot $inventory = null,
        int $attempts = 1,
    ): self {
        return new self($outcome, null, null, $margin, $inventory, $reason, $attempts);
    }

    public function isSuccess(): bool
    {
        return $this->outcome === IssueOutcome::Issued || $this->outcome === IssueOutcome::IdempotentReplay;
    }

    /** HTTP 상태 코드 매핑(컨트롤러가 그대로 쓴다). */
    public function httpStatus(): int
    {
        return match ($this->outcome) {
            IssueOutcome::Issued => 201,
            IssueOutcome::IdempotentReplay => 200,
            IssueOutcome::DuplicateClaim, IssueOutcome::InvalidRequest => 409,
            IssueOutcome::IllegalTransition => 409,
            IssueOutcome::NotFound => 404,
            IssueOutcome::CampaignClosed, IssueOutcome::TemplateInactive => 410,
            IssueOutcome::MarginGuardBlocked => 422,
            IssueOutcome::SoldOut, IssueOutcome::BudgetExhausted => 429,
            IssueOutcome::InventoryConflict => 503,
        };
    }
}
