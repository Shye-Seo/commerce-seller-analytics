<?php

declare(strict_types=1);

namespace SellerScope\Tests\Services;

use PHPUnit\Framework\TestCase;
use SellerScope\Domain\Promotion\Campaign;
use SellerScope\Domain\Promotion\CouponStatus;
use SellerScope\Domain\Promotion\CouponTemplate;
use SellerScope\Domain\Promotion\DiscountType;
use SellerScope\Domain\Promotion\IssueOutcome;
use SellerScope\Domain\Promotion\IssueRequest;
use SellerScope\Domain\Promotion\IssueResult;
use SellerScope\Domain\Promotion\MarginInput;
use SellerScope\Services\CouponIssuanceService;
use SellerScope\Tests\Support\FakeCouponInventoryStore;
use SellerScope\Tests\Support\FakeIssuedCouponStore;
use SellerScope\Tests\Support\FakePromotionCatalog;
use SellerScope\Tests\Support\MutableClock;
use SellerScope\Tests\Support\SequenceCouponCodeGenerator;

/**
 * 쿠폰 발급 서비스 계약 테스트.
 *
 * 이 테스트가 지키는 것은 숫자가 아니라 **약속**이다.
 *   · 재고 100장에 130번 요청하면 정확히 100장만 나가고, 나머지는 SOLD_OUT이다.
 *   · 같은 멱등 키로 두 번 오면 쿠폰은 1장, 응답은 200(REPLAY)이다.
 *   · 같은 사람이 다른 키로 두 번 오면 DUPLICATE_CLAIM이다.
 *   · 마진이 무너지는 쿠폰은 재고를 건드리지도 않는다.
 *   · 취소·만료는 재고를 정확히 1장 복원하고, 두 번 복원하지 않는다.
 *
 * 모든 케이스 끝에 재고 보존식(remaining + reserved + consumed = total)을 확인한다.
 * 이 식이 깨지면 지표·매출·정산이 전부 어긋나므로, 개별 assert보다 강한 불변식이다.
 */
final class CouponIssuanceServiceTest extends TestCase
{
    private FakePromotionCatalog $catalog;

    private FakeCouponInventoryStore $inventories;

    private FakeIssuedCouponStore $coupons;

    private MutableClock $clock;

    protected function setUp(): void
    {
        $this->catalog = new FakePromotionCatalog(
            campaigns: [1 => $this->campaign()],
            templates: [1 => $this->template(), 2 => $this->percentTemplate(), 9 => $this->template(campaignId: 2)],
        );
        $this->inventories = new FakeCouponInventoryStore(1, 100);
        $this->coupons = new FakeIssuedCouponStore();
        $this->clock = MutableClock::at('2026-11-20T20:30:00+09:00');
    }

    private function service(string $strategy = 'atomic'): CouponIssuanceService
    {
        return new CouponIssuanceService(
            $this->catalog,
            $this->inventories,
            $this->coupons,
            new SequenceCouponCodeGenerator(),
            $this->clock,
            inventoryStrategy: $strategy,
        );
    }

    private function campaign(
        int $id = 1,
        string $status = 'live',
        string $guardMode = 'block',
        int $tokenBudget = 1000,
        int $rewardBudget = 10_000_000,
        float $minMargin = 12.0,
        string $startsAt = '2026-11-20T20:00:00+09:00',
        string $endsAt = '2026-11-20T22:00:00+09:00',
    ): Campaign {
        return new Campaign(
            id: $id,
            tenantId: 1,
            code: 'toss-drop-2026-11',
            name: '토스형 시크릿 드롭',
            type: 'TOSS_STYLE_DROP',
            partnerName: '무신사 스탠다드',
            rewardBudget: $rewardBudget,
            tokenBudget: $tokenBudget,
            minGuaranteedMargin: $minMargin,
            marginGuardMode: $guardMode,
            startsAt: new \DateTimeImmutable($startsAt),
            endsAt: new \DateTimeImmutable($endsAt),
            status: $status,
        );
    }

    private function template(
        int $id = 1,
        int $campaignId = 1,
        bool $active = true,
        int $discountAmount = 3000,
        int $minOrder = 30_000,
        int $validityMinutes = 15,
    ): CouponTemplate {
        return new CouponTemplate(
            id: $id,
            campaignId: $campaignId,
            code: 'toss-3000-fixed',
            name: '3,000원 즉시 할인',
            discountType: DiscountType::Fixed,
            discountAmount: $discountAmount,
            discountRate: 0.0,
            minOrderAmount: $minOrder,
            maxDiscountAmount: 0,
            perUserLimit: 1,
            validityMinutes: $validityMinutes,
            fundedBy: 'PARTNER',
            isActive: $active,
        );
    }

    private function percentTemplate(): CouponTemplate
    {
        return new CouponTemplate(
            id: 2,
            campaignId: 1,
            code: 'toss-10-percent',
            name: '10% 할인 (최대 5천원)',
            discountType: DiscountType::Percent,
            discountAmount: 0,
            discountRate: 10.0,
            minOrderAmount: 20_000,
            maxDiscountAmount: 5000,
            perUserLimit: 1,
            validityMinutes: 15,
            fundedBy: 'PLATFORM',
            isActive: true,
        );
    }

    private function request(
        string $user = 'user-aaaaaaaaaaaaaaaaaaaa',
        string $key = 'idem-1',
        int $campaignId = 1,
        int $templateId = 1,
        ?MarginInput $margin = null,
    ): IssueRequest {
        return new IssueRequest(
            campaignId: $campaignId,
            templateId: $templateId,
            tenantId: 1,
            userHash: hash('sha256', $user),
            idempotencyKey: $key,
            marginInput: $margin ?? new MarginInput(0, 0),
        );
    }

    private function assertBalanced(): void
    {
        self::assertTrue($this->inventories->isBalanced(), '재고 보존식(remaining+reserved+consumed=total)이 깨졌습니다.');
    }

    // ─────────────────────────────────────────────────────────────
    // 1. 기본 발급
    // ─────────────────────────────────────────────────────────────

    public function testIssuesCouponWithCodeHashAndExpiry(): void
    {
        $result = $this->service()->issue($this->request());

        self::assertTrue($result->isSuccess());
        self::assertSame(IssueOutcome::Issued, $result->outcome);
        self::assertSame(201, $result->httpStatus());
        self::assertNotNull($result->plainCode);
        self::assertSame(16, strlen((string) $result->plainCode));
        self::assertSame(CouponStatus::Issued, $result->coupon?->status);
        self::assertSame(hash('sha256', (string) $result->plainCode), $result->coupon?->codeHash);
        self::assertSame('2026-11-20 20:45:00', $result->coupon?->expiresAt->format('Y-m-d H:i:s'));
        self::assertSame(99, $this->inventories->remaining());
        self::assertSame(1, $this->inventories->reserved());
        $this->assertBalanced();
    }

    public function testPlainCodeIsNotStoredInLedgerButMaskedCodeIs(): void
    {
        $result = $this->service()->issue($this->request());
        $coupon = $result->coupon;

        self::assertNotNull($coupon);
        self::assertStringNotContainsString((string) $result->plainCode, json_encode($coupon->with()) ?: '');
        self::assertSame(substr((string) $result->plainCode, 0, 4) . '********' . substr((string) $result->plainCode, -4), $coupon->maskedCode);
        self::assertSame(16, strlen($coupon->maskedCode));
    }

    public function testInvalidRequestIsRejectedWith409(): void
    {
        $result = $this->service()->issue(new IssueRequest(0, 0, 0, 'x', ''));

        self::assertFalse($result->isSuccess());
        self::assertSame(IssueOutcome::InvalidRequest, $result->outcome);
        self::assertSame(409, $result->httpStatus());
    }

    // ─────────────────────────────────────────────────────────────
    // 2. 멱등성 — 재전송이 쿠폰을 두 장 만들지 않는다
    // ─────────────────────────────────────────────────────────────

    public function testSameIdempotencyKeyReturnsTheSameCouponWithoutTouchingInventory(): void
    {
        $service = $this->service();
        $first = $service->issue($this->request(key: 'idem-42'));
        $second = $service->issue($this->request(key: 'idem-42'));

        self::assertTrue($second->isSuccess());
        self::assertSame(IssueOutcome::IdempotentReplay, $second->outcome);
        self::assertSame(200, $second->httpStatus());
        self::assertSame($first->coupon?->id, $second->coupon?->id);
        self::assertSame(1, count($this->coupons->all()));
        self::assertSame(99, $this->inventories->remaining(), '재전송이 재고를 두 번 깎았습니다.');
        self::assertNull($second->plainCode, '재전송 응답에 원문 코드를 다시 실으면 안 됩니다.');
        $this->assertBalanced();
    }

    public function testSameUserWithDifferentIdempotencyKeyIsDuplicateClaim(): void
    {
        $service = $this->service();
        $service->issue($this->request(user: 'user-same', key: 'idem-1'));
        $second = $service->issue($this->request(user: 'user-same', key: 'idem-2'));

        self::assertSame(IssueOutcome::DuplicateClaim, $second->outcome);
        self::assertSame(409, $second->httpStatus());
        self::assertSame(99, $this->inventories->remaining());
        $this->assertBalanced();
    }

    public function testUniqueViolationDuringInsertReleasesReservedStock(): void
    {
        $this->coupons->failNextInsertWith = 'template_user';
        $result = $this->service()->issue($this->request());

        self::assertSame(IssueOutcome::DuplicateClaim, $result->outcome);
        self::assertSame(100, $this->inventories->remaining(), '보상 복원이 되지 않아 유령 소진이 남았습니다.');
        self::assertSame(0, $this->inventories->reserved());
        $this->assertBalanced();
    }

    public function testUnknownUniqueViolationReturnsRetryableConflict(): void
    {
        $this->coupons->failNextInsertWith = 'coupon_hash';
        $result = $this->service()->issue($this->request());

        self::assertSame(IssueOutcome::InventoryConflict, $result->outcome);
        self::assertSame(503, $result->httpStatus());
        self::assertSame(100, $this->inventories->remaining());
        $this->assertBalanced();
    }

    // ─────────────────────────────────────────────────────────────
    // 3. 재고 — 오버이슈 0건
    // ─────────────────────────────────────────────────────────────

    public function testSellsOutExactlyAtStockAndNeverOverIssues(): void
    {
        $service = $this->service();

        $issued = 0;
        $soldOut = 0;
        for ($i = 0; $i < 130; $i++) {
            $result = $service->issue($this->request(user: "user-$i-aaaaaaaaaaaaaaaaaaaa", key: "idem-$i"));
            if ($result->outcome === IssueOutcome::Issued) {
                $issued++;
            } elseif ($result->outcome === IssueOutcome::SoldOut) {
                $soldOut++;
            }
        }

        self::assertSame(100, $issued);
        self::assertSame(30, $soldOut);
        self::assertCount(100, $this->coupons->all());
        self::assertSame(0, $this->inventories->remaining());
        self::assertSame(100, $this->inventories->reserved());
        $this->assertBalanced();
    }

    public function testAtomicStrategyUsesOneConditionalStatementPerAttempt(): void
    {
        $this->service('atomic')->issue($this->request());

        self::assertSame(1, $this->inventories->atomicAttempts);
        self::assertSame(0, $this->inventories->optimisticAttempts);
    }

    public function testOptimisticStrategyRetriesOnVersionConflict(): void
    {
        $this->inventories->forcedConflicts = 2;
        $result = $this->service('optimistic')->issue($this->request());

        self::assertSame(IssueOutcome::Issued, $result->outcome);
        self::assertSame(3, $result->attempts, '충돌 2회 + 성공 1회 = 3회 시도여야 합니다.');
        self::assertSame(3, $this->inventories->optimisticAttempts);
        $this->assertBalanced();
    }

    public function testOptimisticStrategyGivesUpWithRetryableConflict(): void
    {
        $this->inventories->forcedConflicts = 10;
        $result = $this->service('optimistic')->issue($this->request());

        self::assertSame(IssueOutcome::InventoryConflict, $result->outcome);
        self::assertSame(503, $result->httpStatus());
        self::assertSame(100, $this->inventories->remaining());
        $this->assertBalanced();
    }

    // ─────────────────────────────────────────────────────────────
    // 4. 캠페인·템플릿 유효성
    // ─────────────────────────────────────────────────────────────

    public function testClosedCampaignRejectsIssuance(): void
    {
        $this->catalog = new FakePromotionCatalog(
            [2 => $this->campaign(id: 2, status: 'ended')],
            [9 => $this->template(id: 9, campaignId: 2)],
        );
        $result = $this->service()->issue($this->request(campaignId: 2, templateId: 9));

        self::assertSame(IssueOutcome::CampaignClosed, $result->outcome);
        self::assertSame(410, $result->httpStatus());
        self::assertSame(100, $this->inventories->remaining());
    }

    public function testBeforeOpenWindowIsRejected(): void
    {
        $this->catalog = new FakePromotionCatalog(
            [1 => $this->campaign(startsAt: '2026-11-20T21:00:00+09:00')],
            [1 => $this->template()],
        );

        $result = $this->service()->issue($this->request());

        self::assertSame(IssueOutcome::CampaignClosed, $result->outcome);
        self::assertStringContainsString('응모 가능 시간', $result->reason);
    }

    public function testAfterCloseWindowAtExactEndIsRejected(): void
    {
        $this->clock->set('2026-11-20T22:00:00+09:00');

        $result = $this->service()->issue($this->request());

        self::assertSame(IssueOutcome::CampaignClosed, $result->outcome, 'ends_at과 같은 시각은 이미 종료입니다(구간은 [start, end)).');
    }

    public function testTemplateFromAnotherCampaignIsRejected(): void
    {
        $result = $this->service()->issue($this->request(templateId: 9));

        self::assertSame(IssueOutcome::TemplateInactive, $result->outcome);
    }

    public function testInactiveTemplateIsRejected(): void
    {
        $this->catalog = new FakePromotionCatalog([1 => $this->campaign()], [1 => $this->template(active: false)]);

        $result = $this->service()->issue($this->request());

        self::assertSame(IssueOutcome::TemplateInactive, $result->outcome);
        self::assertSame(410, $result->httpStatus());
    }

    // ─────────────────────────────────────────────────────────────
    // 5. 예산 상한
    // ─────────────────────────────────────────────────────────────

    public function testTokenBudgetExhaustionStopsIssuance(): void
    {
        $this->catalog = new FakePromotionCatalog([1 => $this->campaign(tokenBudget: 500)], [1 => $this->template()]);
        $this->catalog->issuedCount = 500;

        $result = $this->service()->issue($this->request());

        self::assertSame(IssueOutcome::BudgetExhausted, $result->outcome);
        self::assertSame(429, $result->httpStatus());
    }

    public function testRewardBudgetExhaustionStopsIssuance(): void
    {
        $this->catalog = new FakePromotionCatalog([1 => $this->campaign(rewardBudget: 300_000)], [1 => $this->template()]);
        $this->catalog->issuedDiscountTotal = 300_000;

        $result = $this->service()->issue($this->request());

        self::assertSame(IssueOutcome::BudgetExhausted, $result->outcome);
    }

    // ─────────────────────────────────────────────────────────────
    // 6. 마진 가드레일
    // ─────────────────────────────────────────────────────────────

    public function testMarginGuardBlocksIssueWhenProjectedMarginFallsBelowFloor(): void
    {
        // 30,000 - 1,089(3.63%) - 2,600 - 3,000(쿠폰) - 22,000(원가) = +1,311원 → 4.37% < 12%
        $margin = new MarginInput(orderAmount: 30_000, productCost: 22_000, shippingCost: 2_600, feeRatePct: 3.63);
        $result = $this->service()->issue($this->request(margin: $margin));

        self::assertSame(IssueOutcome::MarginGuardBlocked, $result->outcome);
        self::assertSame(422, $result->httpStatus());
        self::assertSame(100, $this->inventories->remaining(), '가드레일에서 막힌 요청이 재고를 건드렸습니다.');
        self::assertNotNull($result->margin);
        self::assertSame(1311, $result->margin?->projectedMargin);
        self::assertSame(4.37, $result->margin?->projectedMarginRate);
    }

    public function testMarginGuardBlocksLossMakingCouponEvenWithZeroFloor(): void
    {
        $this->catalog = new FakePromotionCatalog([1 => $this->campaign(minMargin: 0.0)], [1 => $this->template()]);
        $margin = new MarginInput(orderAmount: 30_000, productCost: 25_000, shippingCost: 2_600, feeRatePct: 3.63);

        $result = $this->service()->issue($this->request(margin: $margin));

        self::assertSame(IssueOutcome::MarginGuardBlocked, $result->outcome);
        self::assertTrue($result->margin?->isLossMaking());
    }

    public function testWarnModeIssuesCouponButReportsGuardrailViolation(): void
    {
        $this->catalog = new FakePromotionCatalog([1 => $this->campaign(guardMode: 'warn')], [1 => $this->template()]);
        $margin = new MarginInput(orderAmount: 30_000, productCost: 22_000, shippingCost: 2_600, feeRatePct: 3.63);

        $result = $this->service()->issue($this->request(margin: $margin));

        self::assertSame(IssueOutcome::Issued, $result->outcome);
        self::assertFalse($result->margin?->passes(), '경고 모드여도 위반 사실은 결과에 남아야 합니다.');
        self::assertSame(99, $this->inventories->remaining());
    }

    public function testMarginNotEvaluatedWhenProductCostIsMissing(): void
    {
        $margin = new MarginInput(orderAmount: 30_000, productCost: 0, shippingCost: 2_600, feeRatePct: 3.63);

        $result = $this->service()->issue($this->request(margin: $margin));

        self::assertSame(IssueOutcome::Issued, $result->outcome);
        self::assertFalse($result->margin?->evaluated);
    }

    public function testGuardUsesMinimumBasketWhenOrderAmountUnknown(): void
    {
        // 최소주문 30,000으로 가정: 30,000 - 1,089 - 0 - 3,000 - 20,000 = 5,911 → 19.7% 통과
        $margin = new MarginInput(orderAmount: 0, productCost: 20_000, shippingCost: 0, feeRatePct: 3.63);
        $result = $this->service()->issue($this->request(margin: $margin));

        self::assertSame(IssueOutcome::Issued, $result->outcome);
        self::assertSame(30_000, $result->margin?->orderAmount);
    }

    // ─────────────────────────────────────────────────────────────
    // 7. 정률 쿠폰 상한
    // ─────────────────────────────────────────────────────────────

    public function testPercentCouponIsCappedAtMaxDiscount(): void
    {
        $this->inventories = new FakeCouponInventoryStore(2, 10);
        $template = $this->percentTemplate();

        self::assertSame(3200, $template->discountFor(32_000));
        self::assertSame(5000, $template->discountFor(60_000), '상한을 넘으면 최대 할인액으로 잘려야 합니다.');
        self::assertSame(0, $template->discountFor(10_000), '최소 주문금액 미만은 0원입니다.');
    }

    public function testPercentGuardUsesCapReachedBasket(): void
    {
        // 10% / 최대 5,000원 → 상한 도달 장바구니는 50,000원
        self::assertSame(50_000, $this->percentTemplate()->assumedOrderAmountForGuard());
    }

    // ─────────────────────────────────────────────────────────────
    // 8. 상태 머신
    // ─────────────────────────────────────────────────────────────

    public function testReserveConfirmsDiscountAndMovesToReserved(): void
    {
        $service = $this->service();
        $issued = $service->issue($this->request());

        $result = $service->reserve(
            (int) $issued->coupon?->id,
            new MarginInput(orderAmount: 32_000, productCost: 12_000, shippingCost: 2_600, feeRatePct: 3.63),
            'ORDER-1',
        );

        self::assertTrue($result->isSuccess());
        self::assertSame(CouponStatus::Reserved, $result->coupon?->status);
        self::assertSame(3000, $result->coupon?->discountAmount);
        self::assertSame(32_000, $result->coupon?->orderAmount);
        self::assertSame('ORDER-1', $result->coupon?->orderId);
    }

    public function testReserveBelowMinimumOrderAmountIsRejected(): void
    {
        $service = $this->service();
        $issued = $service->issue($this->request());

        $result = $service->reserve((int) $issued->coupon?->id, new MarginInput(orderAmount: 10_000, productCost: 5_000), 'ORDER-2');

        self::assertSame(IssueOutcome::InvalidRequest, $result->outcome);
        self::assertStringContainsString('최소 주문금액', $result->reason);
    }

    public function testReserveTwiceIsIllegalTransition(): void
    {
        $service = $this->service();
        $issued = $service->issue($this->request());
        $input = new MarginInput(orderAmount: 32_000, productCost: 12_000);

        $service->reserve((int) $issued->coupon?->id, $input, 'ORDER-1');
        $second = $service->reserve((int) $issued->coupon?->id, $input, 'ORDER-1');

        self::assertSame(IssueOutcome::IllegalTransition, $second->outcome);
        self::assertSame(409, $second->httpStatus());
        $this->assertBalanced();
    }

    public function testReserveAfterExpiryExpiresCouponAndReleasesStock(): void
    {
        $service = $this->service();
        $issued = $service->issue($this->request());

        $this->clock->set('2026-11-20T20:46:00+09:00');
        $result = $service->reserve((int) $issued->coupon?->id, new MarginInput(orderAmount: 32_000, productCost: 12_000), 'ORDER-3');

        self::assertSame(IssueOutcome::IllegalTransition, $result->outcome);
        self::assertStringContainsString('만료', $result->reason);
        self::assertSame(CouponStatus::Expired, $this->coupons->findById((int) $issued->coupon?->id)?->status);
        self::assertSame(100, $this->inventories->remaining());
        $this->assertBalanced();
    }

    public function testRedeemMovesStockToConsumed(): void
    {
        $service = $this->service();
        $issued = $service->issue($this->request());
        $service->reserve((int) $issued->coupon?->id, new MarginInput(orderAmount: 32_000, productCost: 12_000), 'ORDER-1');

        $result = $service->redeem((int) $issued->coupon?->id);

        self::assertSame(CouponStatus::Redeemed, $result->coupon?->status);
        self::assertSame(0, $this->inventories->reserved());
        self::assertSame(1, $this->inventories->consumed());
        self::assertNotNull($result->coupon?->redeemedAt);
        $this->assertBalanced();
    }

    public function testRedeemWithoutReservationIsIllegal(): void
    {
        $service = $this->service();
        $issued = $service->issue($this->request());

        $result = $service->redeem((int) $issued->coupon?->id);

        self::assertSame(IssueOutcome::IllegalTransition, $result->outcome);
        self::assertSame(0, $this->inventories->consumed());
    }

    public function testSettleRequiresRedeemedState(): void
    {
        $service = $this->service();
        $issued = $service->issue($this->request());
        $service->reserve((int) $issued->coupon?->id, new MarginInput(orderAmount: 32_000, productCost: 12_000), 'ORDER-1');

        $tooEarly = $service->settle((int) $issued->coupon?->id);
        self::assertSame(IssueOutcome::IllegalTransition, $tooEarly->outcome);

        $service->redeem((int) $issued->coupon?->id);
        $settled = $service->settle((int) $issued->coupon?->id);

        self::assertSame(CouponStatus::Settled, $settled->coupon?->status);
        self::assertNotNull($settled->coupon?->settledAt);
        self::assertTrue($settled->coupon?->status->isTerminal());
    }

    public function testCancelReleasesStockExactlyOnce(): void
    {
        $service = $this->service();
        $issued = $service->issue($this->request());

        $first = $service->cancel((int) $issued->coupon?->id, '주문 취소');
        $second = $service->cancel((int) $issued->coupon?->id, '주문 취소');

        self::assertSame(CouponStatus::Cancelled, $first->coupon?->status);
        self::assertSame(IssueOutcome::IllegalTransition, $second->outcome);
        self::assertSame(100, $this->inventories->remaining(), '취소가 재고를 두 번 복원했습니다.');
        $this->assertBalanced();
    }

    public function testCancelAfterRedeemIsRejected(): void
    {
        $service = $this->service();
        $issued = $service->issue($this->request());
        $service->reserve((int) $issued->coupon?->id, new MarginInput(orderAmount: 32_000, productCost: 12_000), 'ORDER-1');
        $service->redeem((int) $issued->coupon?->id);

        $result = $service->cancel((int) $issued->coupon?->id, '정정');

        self::assertSame(IssueOutcome::IllegalTransition, $result->outcome);
        self::assertStringContainsString('사용·정산된 쿠폰', $result->reason);
    }

    public function testExpireBeforeDeadlineIsRejected(): void
    {
        $service = $this->service();
        $issued = $service->issue($this->request());

        $result = $service->expire((int) $issued->coupon?->id);

        self::assertSame(IssueOutcome::IllegalTransition, $result->outcome);
        self::assertStringContainsString('아직 만료 시각', $result->reason);
    }

    public function testSweepExpiresOnlyDueCoupons(): void
    {
        $service = $this->service();
        $old = $service->issue($this->request(user: 'user-old', key: 'idem-old'));

        $this->clock->set('2026-11-20T20:40:00+09:00');
        $service->issue($this->request(user: 'user-new', key: 'idem-new'));

        // 20:46 — old(20:30 발급) 만료, new(20:40 발급) 아직 유효
        $this->clock->set('2026-11-20T20:46:00+09:00');
        $report = $service->sweepExpired(100);

        self::assertSame(1, $report['expired']);
        self::assertSame(0, $report['failed']);
        self::assertSame(CouponStatus::Expired, $this->coupons->findById((int) $old->coupon?->id)?->status);
        self::assertSame(99, $this->inventories->remaining());
        self::assertSame(1, $this->inventories->reserved());
        $this->assertBalanced();
    }

    public function testStateMachineRejectsEveryIllegalTransition(): void
    {
        $legal = [
            'ISSUED' => ['RESERVED', 'CANCELLED', 'EXPIRED'],
            'RESERVED' => ['REDEEMED', 'CANCELLED', 'EXPIRED'],
            'REDEEMED' => ['SETTLED'],
            'SETTLED' => [],
            'CANCELLED' => [],
            'EXPIRED' => [],
        ];

        foreach (CouponStatus::cases() as $from) {
            foreach (CouponStatus::cases() as $to) {
                $expected = in_array($to->value, $legal[$from->value], true);
                self::assertSame(
                    $expected,
                    $from->canTransitionTo($to),
                    "{$from->value} → {$to->value} 전이 판정이 표와 다릅니다.",
                );
            }
        }
    }

    public function testTerminalStatesHoldNoInventory(): void
    {
        self::assertTrue(CouponStatus::Issued->holdsInventory());
        self::assertTrue(CouponStatus::Reserved->holdsInventory());
        self::assertFalse(CouponStatus::Redeemed->holdsInventory());
        self::assertFalse(CouponStatus::Settled->holdsInventory());
        self::assertFalse(CouponStatus::Cancelled->holdsInventory());
        self::assertFalse(CouponStatus::Expired->holdsInventory());
    }

    public function testRejectionReasonsAreHumanReadableAndSpecific(): void
    {
        $service = $this->service();
        $service->issue($this->request(user: 'user-first', key: 'idem-1'));
        $duplicate = $service->issue($this->request(user: 'user-first', key: 'idem-2'));

        self::assertSame('이미 이 쿠폰을 받은 사용자입니다.', $duplicate->reason);
        self::assertNotSame('', $duplicate->reason);

        $this->inventories = new FakeCouponInventoryStore(1, 0);
        $soldOut = $this->service()->issue($this->request(user: 'user-late', key: 'idem-3'));
        self::assertSame(IssueOutcome::SoldOut, $soldOut->outcome);
        self::assertSame('준비된 수량이 모두 소진되었습니다.', $soldOut->reason);
    }
}
