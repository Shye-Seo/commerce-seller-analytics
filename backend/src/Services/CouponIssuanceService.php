<?php

declare(strict_types=1);

namespace SellerScope\Services;

use SellerScope\Domain\Promotion\Campaign;
use SellerScope\Domain\Promotion\Coupon;
use SellerScope\Domain\Promotion\CouponCodeGenerator;
use SellerScope\Domain\Promotion\CouponStatus;
use SellerScope\Domain\Promotion\CouponTemplate;
use SellerScope\Domain\Promotion\DiscountType;
use SellerScope\Domain\Promotion\IssueOutcome;
use SellerScope\Domain\Promotion\IssueRequest;
use SellerScope\Domain\Promotion\IssueResult;
use SellerScope\Domain\Promotion\MarginAssessment;
use SellerScope\Domain\Promotion\MarginGuard;
use SellerScope\Domain\Promotion\MarginInput;
use SellerScope\Repositories\CouponInventoryStore;
use SellerScope\Repositories\DuplicateCouponException;
use SellerScope\Repositories\IssuedCouponStore;
use SellerScope\Repositories\PromotionCatalog;
use SellerScope\Support\Clock;

/**
 * 고동시성 쿠폰 발급 서비스.
 *
 * 이 클래스가 푸는 문제는 두 가지다.
 *
 *   1) **오버이슈** — 재고 100장에 1,000명이 동시에 눌렀을 때 101장이 나가면 안 된다.
 *      해법은 "읽고-검사하고-쓰기"를 없애는 것이다. 재고 차감은 조건부 UPDATE 한 문장
 *      (`WHERE remaining_qty >= 1`)으로 원자화하고, 영향 행이 0이면 그 요청은 SOLD_OUT이다.
 *   2) **중복 발급** — 같은 사람이 두 번 눌렀거나, 응답을 못 받고 새로고침했을 때
 *      쿠폰이 두 장 나가면 안 된다. 해법은 두 겹이다. 애플리케이션은 멱등 키로 기존
 *      쿠폰을 찾아 돌려주고, DB는 `(template_id, user_hash)` UNIQUE로 동시 도착을 막는다.
 *      애플리케이션 검사만으로는 두 요청이 동시에 "없음"을 읽고 둘 다 INSERT한다.
 *
 * 발급 순서(바꾸면 안 되는 이유가 각 단계에 있다)
 *   ① 멱등 재전송 흡수  ② 캠페인/템플릿 유효성  ③ 중복 수령 차단  ④ 예산 상한
 *   ⑤ 마진 가드레일     ⑥ 재고 원자 차감        ⑦ 원장 INSERT    ⑧ 실패 시 재고 보상
 *
 * ⑤가 ⑥보다 앞인 이유: 마진이 깨지는 쿠폰은 아예 재고를 건드리지 않아야 한다.
 * 재고를 먼저 깎고 되돌리면, 그 사이 다른 사람이 SOLD_OUT을 받는다(유령 소진).
 *
 * ③이 ⑥보다 앞인 이유: 중복 요청이 재고를 깎으면 안 된다. 반대로 ③과 ⑦ 사이에는
 * 경합 창이 남으므로 ⑦의 UNIQUE가 최종 방어선이고, 실패하면 ⑧로 재고를 되돌린다.
 *
 * 상태 전이는 `CouponStatus::transitions()` 표를 따르고, 저장소 갱신은
 * `WHERE status = :from`(compare-and-set)으로 한다.
 */
final class CouponIssuanceService
{
    /** 낙관적 락 재시도 상한. 3회를 넘으면 경합이 비정상이므로 503으로 돌려준다. */
    private const MAX_OPTIMISTIC_RETRIES = 3;

    public function __construct(
        private readonly PromotionCatalog $catalog,
        private readonly CouponInventoryStore $inventories,
        private readonly IssuedCouponStore $coupons,
        private readonly CouponCodeGenerator $codes,
        private readonly Clock $clock,
        private readonly MarginGuard $marginGuard = new MarginGuard(),
        private readonly string $inventoryStrategy = 'atomic',
    ) {
    }

    /**
     * 쿠폰 발급(핫패스).
     */
    public function issue(IssueRequest $request): IssueResult
    {
        if (! $request->isValid()) {
            return IssueResult::rejected(IssueOutcome::InvalidRequest, '요청 값이 올바르지 않습니다(캠페인·템플릿·사용자 해시·멱등 키 확인).');
        }

        $now = $this->clock->now();

        // ① 멱등 재전송 흡수 — 같은 키면 같은 쿠폰을 돌려준다(원문 코드는 다시 보내지 않는다).
        $existing = $this->coupons->findByIdempotencyKey($request->idempotencyKey);
        if ($existing !== null) {
            return IssueResult::replay($existing, MarginAssessment::notEvaluated());
        }

        // ② 캠페인·템플릿 유효성
        $campaign = $this->catalog->campaign($request->campaignId);
        if ($campaign === null) {
            return IssueResult::rejected(IssueOutcome::CampaignClosed, '캠페인을 찾을 수 없습니다.');
        }

        $template = $this->catalog->template($request->templateId);
        if ($template === null || $template->campaignId !== $campaign->id) {
            return IssueResult::rejected(IssueOutcome::TemplateInactive, '캠페인에 속하지 않는 템플릿입니다.');
        }

        if (! $campaign->isOpenAt($now)) {
            return IssueResult::rejected(
                IssueOutcome::CampaignClosed,
                $campaign->status !== 'live'
                    ? "캠페인이 {$campaign->status} 상태입니다."
                    : '응모 가능 시간이 아닙니다.',
            );
        }

        if (! $template->isActive) {
            return IssueResult::rejected(IssueOutcome::TemplateInactive, '종료된 쿠폰 템플릿입니다.');
        }

        // ③ 중복 수령 차단(빠른 경로). 최종 방어선은 ⑦의 UNIQUE 제약이다.
        if ($this->coupons->findByTemplateAndUser($template->id, $request->userHash) !== null) {
            return IssueResult::rejected(IssueOutcome::DuplicateClaim, '이미 이 쿠폰을 받은 사용자입니다.');
        }

        // ④ 예산 상한(장수·금액 중 먼저 닿는 쪽)
        if ($campaign->isTokenBudgetExhausted($this->catalog->issuedCouponCount($campaign->id))
            || $campaign->isRewardBudgetExhausted($this->catalog->issuedDiscountTotal($campaign->id))) {
            return IssueResult::rejected(IssueOutcome::BudgetExhausted, '캠페인 발행 예산/장수 상한을 모두 사용했습니다.');
        }

        // ⑤ 마진 가드레일 — 이 템플릿으로 살 수 있는 가장 작은 장바구니(정률은 상한 도달 금액)로 평가
        $margin = $this->assessMargin($campaign, $template, $request->marginInput);
        if (! $margin->passes() && $campaign->blocksOnMarginViolation()) {
            return IssueResult::rejected(IssueOutcome::MarginGuardBlocked, $margin->explanation(), $margin);
        }

        // ⑥ 재고 원자 차감
        [$reserved, $attempts, $conflicted] = $this->reserveInventory($template->id);
        if (! $reserved) {
            return IssueResult::rejected(
                $conflicted ? IssueOutcome::InventoryConflict : IssueOutcome::SoldOut,
                $conflicted
                    ? '재고 경합이 심해 이번 요청을 처리하지 못했습니다. 같은 멱등 키로 다시 시도해 주세요.'
                    : '준비된 수량이 모두 소진되었습니다.',
                $margin,
                $this->inventories->snapshot($template->id),
                $attempts,
            );
        }

        // ⑦ 원장 INSERT
        $plainCode = $this->codes->generate();
        $coupon = new Coupon(
            id: 0,
            tenantId: $campaign->tenantId,
            campaignId: $campaign->id,
            templateId: $template->id,
            entryId: $request->entryId,
            userHash: $request->userHash,
            codeHash: hash('sha256', $plainCode),
            status: CouponStatus::Issued,
            discountAmount: $template->discountType === DiscountType::Fixed ? $template->discountAmount : 0,
            orderAmount: 0,
            orderId: null,
            idempotencyKey: $request->idempotencyKey,
            issuedAt: $now,
            expiresAt: $now->modify("+{$template->validityMinutes} minutes"),
            maskedCode: Coupon::mask($plainCode),
        );

        try {
            $id = $this->coupons->insert($coupon);
        } catch (DuplicateCouponException $e) {
            // ⑧ 보상 — 재고를 되돌리고, 왜 충돌했는지에 맞는 결과를 돌려준다.
            $this->inventories->release($template->id);

            $replay = $this->coupons->findByIdempotencyKey($request->idempotencyKey);
            if ($replay !== null) {
                return IssueResult::replay($replay, $margin);
            }

            if ($this->coupons->findByTemplateAndUser($template->id, $request->userHash) !== null) {
                return IssueResult::rejected(IssueOutcome::DuplicateClaim, '동시 요청으로 중복 발급이 감지되었습니다.', $margin, null, $attempts);
            }

            return IssueResult::rejected(
                IssueOutcome::InventoryConflict,
                '쿠폰 코드 충돌이 발생했습니다. 같은 멱등 키로 다시 시도해 주세요.',
                $margin,
                null,
                $attempts,
            );
        }

        $stored = $this->coupons->findById($id) ?? $coupon->with();

        return IssueResult::issued(
            coupon: $stored,
            plainCode: $plainCode,
            margin: $margin,
            inventory: $this->inventories->snapshot($template->id) ?? new \SellerScope\Domain\Promotion\InventorySnapshot(0, $template->id, 0, 0, 0, 0, 0),
            attempts: $attempts,
        );
    }

    /**
     * 주문에 쿠폰을 묶는다(ISSUED → RESERVED). 이 시점에 할인액이 확정된다.
     *
     * 정률 쿠폰의 할인액은 주문금액을 알아야 정해지므로 발급 시점에는 0이다.
     * 여기서 확정해 원장에 박고, 이후 주문이 바뀌어도 원장 금액은 바뀌지 않는다.
     * 마진 가드레일도 이 시점에 **실제 금액**으로 다시 평가한다(이중 검사).
     */
    public function reserve(int $couponId, MarginInput $input, string $orderId): IssueResult
    {
        $coupon = $this->coupons->findById($couponId);
        if ($coupon === null) {
            return IssueResult::rejected(IssueOutcome::NotFound, '쿠폰을 찾을 수 없습니다.');
        }

        if (! $coupon->status->canTransitionTo(CouponStatus::Reserved)) {
            return IssueResult::rejected(IssueOutcome::IllegalTransition, "{$coupon->status->value} 상태에서는 주문에 묶을 수 없습니다.");
        }

        $now = $this->clock->now();
        if ($coupon->isExpiredAt($now)) {
            $this->expire($couponId);

            return IssueResult::rejected(IssueOutcome::IllegalTransition, '만료된 쿠폰입니다.');
        }

        $template = $this->catalog->template($coupon->templateId);
        $campaign = $this->catalog->campaign($coupon->campaignId);
        if ($template === null || $campaign === null) {
            return IssueResult::rejected(IssueOutcome::NotFound, '쿠폰 템플릿/캠페인을 찾을 수 없습니다.');
        }

        $discount = $template->discountFor($input->orderAmount);
        if ($input->orderAmount > 0 && $discount === 0) {
            return IssueResult::rejected(
                IssueOutcome::InvalidRequest,
                sprintf('최소 주문금액(%s원)을 충족하지 않아 이 쿠폰을 쓸 수 없습니다.', number_format($template->minOrderAmount)),
            );
        }

        $margin = $this->assessMargin($campaign, $template, $input, $discount);
        if (! $margin->passes() && $campaign->blocksOnMarginViolation()) {
            return IssueResult::rejected(IssueOutcome::MarginGuardBlocked, $margin->explanation(), $margin);
        }

        $ok = $this->coupons->transition($couponId, CouponStatus::Issued, CouponStatus::Reserved, [
            'order_amount' => $input->orderAmount,
            'discount_amount' => $discount,
            'order_id' => $orderId,
            'reserved_at' => $now,
        ]);

        if (! $ok) {
            return IssueResult::rejected(IssueOutcome::IllegalTransition, '다른 요청이 먼저 상태를 변경했습니다.');
        }

        return IssueResult::changed(
            $this->coupons->findById($couponId),
            $margin,
            $this->inventories->snapshot($template->id),
        );
    }

    /** 사용 확정(RESERVED → REDEEMED). 재고를 consumed로 넘긴다. */
    public function redeem(int $couponId): IssueResult
    {
        $coupon = $this->coupons->findById($couponId);
        if ($coupon === null) {
            return IssueResult::rejected(IssueOutcome::NotFound, '쿠폰을 찾을 수 없습니다.');
        }

        if (! $coupon->status->canTransitionTo(CouponStatus::Redeemed)) {
            return IssueResult::rejected(IssueOutcome::IllegalTransition, "{$coupon->status->value} 상태에서는 사용 처리할 수 없습니다.");
        }

        $now = $this->clock->now();
        if ($coupon->isExpiredAt($now)) {
            $this->expire($couponId);

            return IssueResult::rejected(IssueOutcome::IllegalTransition, '만료된 쿠폰입니다.');
        }

        $ok = $this->coupons->transition($couponId, CouponStatus::Reserved, CouponStatus::Redeemed, ['redeemed_at' => $now]);
        if (! $ok) {
            return IssueResult::rejected(IssueOutcome::IllegalTransition, '다른 요청이 먼저 상태를 변경했습니다.');
        }

        $this->inventories->consume($coupon->templateId);

        return IssueResult::changed($this->coupons->findById($couponId));
    }

    /** 정산 반영(REDEEMED → SETTLED). 재고는 변하지 않는다(이미 consumed). */
    public function settle(int $couponId): IssueResult
    {
        $coupon = $this->coupons->findById($couponId);
        if ($coupon === null) {
            return IssueResult::rejected(IssueOutcome::NotFound, '쿠폰을 찾을 수 없습니다.');
        }

        if (! $coupon->status->canTransitionTo(CouponStatus::Settled)) {
            return IssueResult::rejected(IssueOutcome::IllegalTransition, "{$coupon->status->value} 상태에서는 정산할 수 없습니다.");
        }

        $ok = $this->coupons->transition($couponId, CouponStatus::Redeemed, CouponStatus::Settled, ['settled_at' => $this->clock->now()]);
        if (! $ok) {
            return IssueResult::rejected(IssueOutcome::IllegalTransition, '다른 요청이 먼저 상태를 변경했습니다.');
        }

        return IssueResult::changed($this->coupons->findById($couponId));
    }

    /** 취소(ISSUED/RESERVED → CANCELLED). 재고를 되돌린다. */
    public function cancel(int $couponId, string $reason): IssueResult
    {
        $coupon = $this->coupons->findById($couponId);
        if ($coupon === null) {
            return IssueResult::rejected(IssueOutcome::NotFound, '쿠폰을 찾을 수 없습니다.');
        }

        if (! $coupon->status->canTransitionTo(CouponStatus::Cancelled)) {
            return IssueResult::rejected(
                IssueOutcome::IllegalTransition,
                "{$coupon->status->value} 상태는 취소할 수 없습니다(사용·정산된 쿠폰은 정정 이력으로 남깁니다).",
            );
        }

        $from = $coupon->status;
        $ok = $this->coupons->transition($couponId, $from, CouponStatus::Cancelled, ['cancel_reason' => $reason]);
        if (! $ok) {
            return IssueResult::rejected(IssueOutcome::IllegalTransition, '다른 요청이 먼저 상태를 변경했습니다.');
        }

        if ($from->holdsInventory()) {
            $this->inventories->release($coupon->templateId);
        }

        return IssueResult::changed($this->coupons->findById($couponId));
    }

    /** 만료(ISSUED/RESERVED → EXPIRED). 만료 시각이 지난 것만 처리한다. */
    public function expire(int $couponId): IssueResult
    {
        $coupon = $this->coupons->findById($couponId);
        if ($coupon === null) {
            return IssueResult::rejected(IssueOutcome::NotFound, '쿠폰을 찾을 수 없습니다.');
        }

        if (! $coupon->status->canTransitionTo(CouponStatus::Expired)) {
            return IssueResult::rejected(IssueOutcome::IllegalTransition, "{$coupon->status->value} 상태는 만료 처리 대상이 아닙니다.");
        }

        if (! $coupon->isExpiredAt($this->clock->now())) {
            return IssueResult::rejected(IssueOutcome::IllegalTransition, '아직 만료 시각이 지나지 않았습니다.');
        }

        $ok = $this->coupons->transition($coupon->id, $coupon->status, CouponStatus::Expired);
        if (! $ok) {
            return IssueResult::rejected(IssueOutcome::IllegalTransition, '다른 요청이 먼저 상태를 변경했습니다.');
        }

        $this->inventories->release($coupon->templateId);

        return IssueResult::changed($this->coupons->findById($coupon->id));
    }

    /**
     * 만료 스윕 배치. 10초 주기로 돌리며, 한 번에 limit건만 처리한다.
     *
     * @return array{expired:int, failed:int, remaining:int}
     */
    public function sweepExpired(int $limit = 500): array
    {
        $expired = 0;
        $failed = 0;
        $due = $this->coupons->findExpiringBefore($this->clock->now(), $limit);

        foreach ($due as $coupon) {
            $result = $this->expire($coupon->id);
            if ($result->isSuccess()) {
                $expired++;
            } else {
                $failed++;
            }
        }

        return ['expired' => $expired, 'failed' => $failed, 'remaining' => count($due) === $limit ? 1 : 0];
    }

    /**
     * 재고 선점. 전략(atomic/optimistic)에 따라 다른 경로를 탄다.
     *
     * @return array{0: bool, 1: int, 2: bool} [선점 성공, 시도 횟수, 경합으로 실패했는가]
     */
    private function reserveInventory(int $templateId): array
    {
        if ($this->inventoryStrategy === 'atomic') {
            return [$this->inventories->reserveAtomically($templateId), 1, false];
        }

        for ($attempt = 1; $attempt <= self::MAX_OPTIMISTIC_RETRIES; $attempt++) {
            $snapshot = $this->inventories->snapshot($templateId);
            if ($snapshot === null || $snapshot->isSoldOut()) {
                return [false, $attempt, false];
            }

            if ($this->inventories->reserveOptimistically($templateId, $snapshot->version)) {
                return [true, $attempt, false];
            }
        }

        // 재시도를 다 써도 실패했다. 재고가 남아 있다면 소진이 아니라 경합이다(503, 재시도 가능).
        $snapshot = $this->inventories->snapshot($templateId);

        return [false, self::MAX_OPTIMISTIC_RETRIES, $snapshot !== null && ! $snapshot->isSoldOut()];
    }

    /**
     * 마진 평가. 원가가 0이면(원장 미입력) "평가 불가"로 두고 통과시킨다.
     *
     * 원가를 모르는 상태에서 마진을 0으로 계산하면 모든 발급이 차단되어
     * 캠페인이 열리지 않는다. 대신 `evaluated=false`로 남겨 콘솔이
     * "원가 미입력 N건"을 경고로 보여준다(1부 MISSING_LEDGER와 같은 태도).
     */
    private function assessMargin(
        Campaign $campaign,
        CouponTemplate $template,
        MarginInput $input,
        ?int $discountOverride = null,
    ): MarginAssessment {
        if ($input->productCost <= 0) {
            return MarginAssessment::notEvaluated();
        }

        $orderAmount = $input->isEvaluable() ? $input->orderAmount : $template->assumedOrderAmountForGuard();

        if ($discountOverride === null) {
            return $this->marginGuard->assess(
                $template,
                new MarginInput($orderAmount, $input->productCost, $input->shippingCost, $input->feeRatePct),
                $campaign->minGuaranteedMargin,
            );
        }

        // 할인액이 이미 확정된 경우(주문 묶기)는 템플릿 재계산 없이 그 금액으로 평가한다.
        $commission = (int) floor(($orderAmount * $input->feeRatePct) / 100 + 0.5);
        $net = $orderAmount - $commission - $input->shippingCost;
        $margin = $net - $discountOverride - $input->productCost;
        $rate = $orderAmount > 0 ? round($margin / $orderAmount * 100, 2) : 0.0;

        return new MarginAssessment(
            orderAmount: $orderAmount,
            discountAmount: $discountOverride,
            netSettlement: $net,
            projectedMargin: $margin,
            projectedMarginRate: $rate,
            minimumMarginRate: $campaign->minGuaranteedMargin,
            evaluated: true,
        );
    }
}
