<?php

declare(strict_types=1);

namespace SellerScope\Domain\Promotion;

/**
 * 프로모션 캠페인(마스터).
 *
 * 캠페인이 들고 있는 정책 3종이 발급 서비스의 입력이 된다.
 *   1) 오픈 구간(starts_at ~ ends_at) — 구간 밖 요청은 REJECTED_WINDOW
 *   2) 최소 보장 마진율(min_guaranteed_margin) — 쿠폰 적용 후 마진이 이보다 낮으면
 *      margin_guard_mode에 따라 block/warn
 *   3) 예산(reward_budget)과 장수 상한(token_budget) — 둘 중 먼저 닿는 쪽에서 멈춘다
 *
 * 시각 비교는 서버 시각(Clock)으로만 한다. 클라이언트가 보낸 시각을 믿으면
 * 기기 시계를 10분 되돌려 종료된 캠페인에 응모할 수 있다.
 */
final class Campaign
{
    public function __construct(
        public readonly int $id,
        public readonly int $tenantId,
        public readonly string $code,
        public readonly string $name,
        public readonly string $type,
        public readonly ?string $partnerName,
        public readonly int $rewardBudget,
        public readonly int $tokenBudget,
        public readonly float $minGuaranteedMargin,
        public readonly string $marginGuardMode,
        public readonly \DateTimeImmutable $startsAt,
        public readonly \DateTimeImmutable $endsAt,
        public readonly string $status,
    ) {
    }

    /** 응모를 받을 수 있는 상태인가(구간 + 상태). */
    public function isOpenAt(\DateTimeImmutable $now): bool
    {
        return $this->status === 'live'
            && $now >= $this->startsAt
            && $now < $this->endsAt;
    }

    /** 발급된 쿠폰 장수가 장수 상한을 넘었는가. */
    public function isTokenBudgetExhausted(int $issuedCount): bool
    {
        return $this->tokenBudget > 0 && $issuedCount >= $this->tokenBudget;
    }

    /** 누적 할인액이 예산을 넘었는가. */
    public function isRewardBudgetExhausted(int $issuedDiscountTotal): bool
    {
        return $this->rewardBudget > 0 && $issuedDiscountTotal >= $this->rewardBudget;
    }

    public function blocksOnMarginViolation(): bool
    {
        return $this->marginGuardMode === 'block';
    }
}
