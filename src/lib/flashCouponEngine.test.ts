import { describe, expect, it } from "vitest";
import {
  FlashCouponEngine,
  type CampaignSpec,
  type CouponTemplateSpec,
  type MarginInput,
  type SettlementLine,
  assessMargin,
  assumedOrderAmountForGuard,
  canTransition,
  couponCodeHash,
  discountFor,
  holdsInventory,
  isTerminal,
  marginPasses,
  maskCouponCode,
  roundWon,
  seededCodeGenerator,
  splitBorne,
  toRate,
} from "./flashCouponEngine";

/**
 * 실시간 선착순 쿠폰 엔진 계약 테스트.
 *
 * 이 파일이 증명하려는 것은 화면이 아니라 **돈이 틀어지지 않는 조건**이다.
 *   · 1,000건 동시 요청에도 재고보다 많이 나가지 않는다(오버이슈 0건)
 *   · 같은 요청의 재전송이 쿠폰을 두 장 만들지 않는다
 *   · 마진이 무너지는 쿠폰은 재고를 건드리지도 않는다
 *   · 취소·만료는 재고를 정확히 1장 복원하고, 두 번 복원하지 않는다
 *   · 쇼핑몰 정산서의 쿠폰 차감액이 원장과 다르면, 그 차액이 누구 부담인지 말할 수 있다
 */

const NOW = Date.parse("2026-11-20T20:30:00+09:00");

function campaign(overrides: Partial<CampaignSpec> = {}): CampaignSpec {
  return {
    id: 1,
    tenantId: 1,
    code: "toss-drop-2026-11",
    name: "토스형 시크릿 드롭",
    type: "TOSS_STYLE_DROP",
    partnerName: "무신사 스탠다드",
    rewardBudget: 9_000_000,
    tokenBudget: 1_000,
    minGuaranteedMargin: 12,
    marginGuardMode: "block",
    startsAt: NOW - 30 * 60_000,
    endsAt: NOW + 90 * 60_000,
    status: "live",
    expectedPeakTps: 3_500,
    ...overrides,
  };
}

function template(overrides: Partial<CouponTemplateSpec> = {}): CouponTemplateSpec {
  return {
    id: 1,
    campaignId: 1,
    code: "toss-3000-fixed",
    name: "3,000원 즉시 할인",
    discountType: "FIXED",
    discountAmount: 3_000,
    discountRate: 0,
    minOrderAmount: 30_000,
    maxDiscountAmount: 0,
    perUserLimit: 1,
    validityMinutes: 15,
    fundedBy: "PARTNER",
    isActive: true,
    ...overrides,
  };
}

function percentTemplate(overrides: Partial<CouponTemplateSpec> = {}): CouponTemplateSpec {
  return template({
    id: 2,
    code: "toss-10-percent",
    name: "10% 할인 (최대 5천원)",
    discountType: "PERCENT",
    discountAmount: 0,
    discountRate: 10,
    minOrderAmount: 20_000,
    maxDiscountAmount: 5_000,
    fundedBy: "PLATFORM",
    ...overrides,
  });
}

interface EngineFixture {
  engine: FlashCouponEngine;
  clock: { now: number };
}

function makeEngine(options: {
  stock?: number;
  campaigns?: CampaignSpec[];
  templates?: CouponTemplateSpec[];
  yieldInsideCriticalSection?: boolean;
} = {}): EngineFixture {
  const clock = { now: NOW };
  const engine = new FlashCouponEngine({
    campaigns: options.campaigns ?? [campaign()],
    templates: options.templates ?? [template(), percentTemplate()],
    inventories: [
      { templateId: 1, total: options.stock ?? 100 },
      { templateId: 2, total: 500 },
    ],
    now: () => clock.now,
    codeGenerator: seededCodeGenerator(20261120),
    yieldInsideCriticalSection: options.yieldInsideCriticalSection ?? true,
  });

  return { engine, clock };
}

function req(overrides: Partial<Parameters<FlashCouponEngine["issue"]>[0]> = {}) {
  return {
    campaignId: 1,
    templateId: 1,
    userHash: "user-aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    idempotencyKey: "idem-default",
    ...overrides,
  };
}

const margin = (overrides: Partial<MarginInput> = {}): MarginInput => ({
  orderAmount: 30_000,
  productCost: 12_000,
  shippingCost: 2_600,
  feeRatePct: 3.63,
  ...overrides,
});

describe("금액 계산(순수 함수)", () => {
  it("원 단위 반올림은 JS Math.round와 같다", () => {
    expect(roundWon(0.5)).toBe(1);
    expect(roundWon(1.49)).toBe(1);
    expect(roundWon(-0.5)).toBe(0);
    expect(roundWon(-1.5)).toBe(-1);
    expect(roundWon(Number.NaN)).toBe(0);
  });

  it("마진율은 소수 둘째 자리까지 반올림한다", () => {
    expect(toRate(1_311, 30_000)).toBe(4.37);
    expect(toRate(10, 0)).toBe(0);
  });

  it("정액 쿠폰은 최소 주문금액 미만에서 0원이다", () => {
    expect(discountFor(template(), 29_999)).toBe(0);
    expect(discountFor(template(), 30_000)).toBe(3_000);
  });

  it("정액 쿠폰 할인액이 주문금액을 넘으면 주문금액까지만 깎는다", () => {
    expect(discountFor(template({ discountAmount: 5_000, minOrderAmount: 0 }), 3_000)).toBe(3_000);
  });

  it("정률 쿠폰은 원 단위로 반올림한다", () => {
    expect(discountFor(percentTemplate(), 32_000)).toBe(3_200);
    expect(discountFor(percentTemplate(), 33_333)).toBe(3_333);
  });

  it("정률 쿠폰은 최대 할인액에서 잘린다", () => {
    expect(discountFor(percentTemplate(), 60_000)).toBe(5_000);
    expect(discountFor(percentTemplate(), 100_000)).toBe(5_000);
  });

  it("정률 쿠폰도 최소 주문금액 미만이면 0원이다", () => {
    expect(discountFor(percentTemplate(), 19_999)).toBe(0);
  });

  it("정률 가드레일은 할인 상한에 도달하는 장바구니로 평가한다", () => {
    expect(assumedOrderAmountForGuard(percentTemplate())).toBe(50_000);
    expect(assumedOrderAmountForGuard(template())).toBe(30_000);
  });

  it("마진 평가는 수수료·배송·쿠폰·원가를 모두 반영한다", () => {
    const result = assessMargin(template(), margin(), 12);
    expect(result.orderAmount).toBe(30_000);
    expect(result.discountAmount).toBe(3_000);
    expect(result.netSettlement).toBe(26_311); // 30,000 - 1,089(3.63%) - 2,600
    expect(result.projectedMargin).toBe(11_311); // - 3,000 - 12,000
    expect(result.projectedMarginRate).toBe(37.7);
    expect(marginPasses(result)).toBe(true);
  });

  it("원가가 없으면 마진은 평가하지 않고 통과시킨다", () => {
    const result = assessMargin(template(), { orderAmount: 30_000, productCost: 0 }, 12);
    expect(result.evaluated).toBe(false);
    expect(marginPasses(result)).toBe(true);
  });

  it("마이너스 마진은 하한 0%에서도 통과하지 못한다", () => {
    const result = assessMargin(template(), margin({ productCost: 25_000 }), 0);
    expect(result.projectedMargin).toBeLessThan(0);
    expect(marginPasses(result)).toBe(false);
  });

  it("부담 주체 3분할은 합이 할인액과 같다", () => {
    expect(splitBorne("SELLER", 3_000)).toEqual({ seller: 3_000, platform: 0, partner: 0 });
    expect(splitBorne("PLATFORM", 3_000)).toEqual({ seller: 0, platform: 3_000, partner: 0 });
    expect(splitBorne("PARTNER", 3_000)).toEqual({ seller: 0, platform: 0, partner: 3_000 });
  });
});

describe("원장 상태 머신", () => {
  it("허용된 전이만 통과한다", () => {
    expect(canTransition("ISSUED", "RESERVED")).toBe(true);
    expect(canTransition("RESERVED", "REDEEMED")).toBe(true);
    expect(canTransition("REDEEMED", "SETTLED")).toBe(true);
    expect(canTransition("ISSUED", "CANCELLED")).toBe(true);
    expect(canTransition("RESERVED", "EXPIRED")).toBe(true);
  });

  it("되돌리는 전이는 모두 거부한다", () => {
    const statuses = ["ISSUED", "RESERVED", "REDEEMED", "SETTLED", "CANCELLED", "EXPIRED"] as const;
    const illegal = [
      ["RESERVED", "ISSUED"],
      ["REDEEMED", "RESERVED"],
      ["SETTLED", "REDEEMED"],
      ["CANCELLED", "ISSUED"],
      ["EXPIRED", "RESERVED"],
    ] as const;

    illegal.forEach(([from, to]) => expect(canTransition(from, to)).toBe(false));
    statuses.forEach((status) => {
      if (status === "SETTLED" || status === "CANCELLED" || status === "EXPIRED") {
        expect(isTerminal(status)).toBe(true);
      }
    });
  });

  it("재고를 붙잡고 있는 상태는 ISSUED와 RESERVED뿐이다", () => {
    expect(holdsInventory("ISSUED")).toBe(true);
    expect(holdsInventory("RESERVED")).toBe(true);
    ["REDEEMED", "SETTLED", "CANCELLED", "EXPIRED"].forEach((status) =>
      expect(holdsInventory(status as "REDEEMED")).toBe(false),
    );
  });

  it("쿠폰 코드는 16자리 마스킹으로 저장된다", () => {
    expect(maskCouponCode("AB12CD34EF56GH78")).toBe("AB12********GH78");
    expect(maskCouponCode("AB12CD34EF56GH78")).toHaveLength(16);
    expect(couponCodeHash("AB12CD34EF56GH78")).toHaveLength(64);
    expect(couponCodeHash("AB12CD34EF56GH78")).not.toBe(couponCodeHash("AB12CD34EF56GH79"));
  });
});

describe("쿠폰 발급 — 기본 경로", () => {
  it("발급 성공 시 원문 코드와 마스킹 코드, 만료 시각을 만든다", async () => {
    const { engine } = makeEngine();
    const response = await engine.issue(req());

    expect(response.outcome).toBe("ISSUED");
    expect(response.plainCode).toHaveLength(16);
    expect(response.entry?.maskedCode).toHaveLength(16);
    expect(response.entry?.status).toBe("ISSUED");
    expect(response.entry?.expiresAt).toBe(NOW + 15 * 60_000);
    expect(response.entry?.codeHash).toHaveLength(64);
    expect(engine.inventory(1)).toMatchObject({ total: 100, remaining: 99, reserved: 1, consumed: 0 });
  });

  it("발급 결과에 원문 코드를 원장에 남기지 않는다", async () => {
    const { engine } = makeEngine();
    const response = await engine.issue(req());
    const entry = engine.ledger()[0];

    expect(JSON.stringify(entry)).not.toContain(response.plainCode);
    expect(entry?.maskedCode).toBe(maskCouponCode(response.plainCode ?? ""));
  });

  it("같은 멱등 키의 재전송은 같은 쿠폰을 돌려주고 재고를 더 깎지 않는다", async () => {
    const { engine } = makeEngine();
    const first = await engine.issue(req({ idempotencyKey: "click-1" }));
    const second = await engine.issue(req({ idempotencyKey: "click-1" }));

    expect(second.outcome).toBe("IDEMPOTENT_REPLAY");
    expect(second.entry?.id).toBe(first.entry?.id);
    expect(second.plainCode).toBeUndefined();
    expect(engine.inventory(1)?.remaining).toBe(99);
    expect(engine.ledger()).toHaveLength(1);
  });

  it("같은 사용자가 다른 키로 다시 요청하면 중복 수령이다", async () => {
    const { engine } = makeEngine();
    await engine.issue(req({ idempotencyKey: "click-1" }));
    const second = await engine.issue(req({ idempotencyKey: "click-2" }));

    expect(second.outcome).toBe("DUPLICATE_CLAIM");
    expect(engine.inventory(1)?.remaining).toBe(99);
  });

  it("요청 값이 잘못되면 INVALID_REQUEST로 거절한다", async () => {
    const { engine } = makeEngine();
    const response = await engine.issue(req({ userHash: "short" }));

    expect(response.outcome).toBe("INVALID_REQUEST");
    expect(engine.inventory(1)?.remaining).toBe(100);
  });
});

describe("쿠폰 발급 — 재고와 동시성", () => {
  it("재고가 정확히 소진되면 이후 요청은 모두 SOLD_OUT이다", async () => {
    const { engine } = makeEngine({ stock: 5 });

    const responses = [];
    for (let i = 0; i < 8; i++) {
      responses.push(await engine.issue(req({ userHash: `user-${i}-aaaaaaaaaaaaaaaa`, idempotencyKey: `k-${i}` })));
    }

    expect(responses.filter((r) => r.outcome === "ISSUED")).toHaveLength(5);
    expect(responses.filter((r) => r.outcome === "SOLD_OUT")).toHaveLength(3);
    expect(engine.inventory(1)).toMatchObject({ remaining: 0, reserved: 5, total: 5 });
  });

  it("1,000건 동시 요청에도 오버이슈가 0건이다", async () => {
    const { engine } = makeEngine({ stock: 100 });

    const responses = await Promise.all(
      Array.from({ length: 1_000 }, (_, i) =>
        engine.issue(req({ userHash: `user-${i.toString().padStart(24, "0")}`, idempotencyKey: `burst-${i}` })),
      ),
    );

    const issued = responses.filter((r) => r.outcome === "ISSUED").length;
    const soldOut = responses.filter((r) => r.outcome === "SOLD_OUT").length;
    const inventory = engine.inventory(1);

    expect(issued).toBe(100);
    expect(soldOut).toBe(900);
    expect(inventory?.remaining).toBe(0);
    expect(inventory?.reserved).toBe(100);
    expect((inventory?.remaining ?? 0) >= 0).toBe(true);
    expect((inventory?.remaining ?? 0) + (inventory?.reserved ?? 0) + (inventory?.consumed ?? 0)).toBe(100);
    expect(engine.ledger()).toHaveLength(100);
  });

  it("동시 요청에서도 사용자별 중복 발급이 생기지 않는다", async () => {
    const { engine } = makeEngine({ stock: 50 });

    // 200건을 40명이 5번씩 동시에 눌렀다.
    const requests = Array.from({ length: 200 }, (_, i) =>
      engine.issue(req({
        userHash: `user-${(i % 40).toString().padStart(24, "0")}`,
        idempotencyKey: `dup-${i}`,
      })),
    );
    const responses = await Promise.all(requests);

    const issued = responses.filter((r) => r.outcome === "ISSUED").length;
    const uniqueUsers = new Set(engine.ledger().map((entry) => entry.userHash));

    expect(issued).toBe(40);
    expect(uniqueUsers.size).toBe(40);
    expect(responses.filter((r) => r.outcome === "DUPLICATE_CLAIM")).toHaveLength(160);
  });

  it("임계 구역 양보를 켜도 재고 불변식이 유지된다(뮤텍스가 직렬화한다)", async () => {
    const { engine } = makeEngine({ stock: 30, yieldInsideCriticalSection: true });

    await Promise.all(
      Array.from({ length: 300 }, (_, i) =>
        engine.issue(req({ userHash: `user-${i.toString().padStart(24, "0")}`, idempotencyKey: `y-${i}` })),
      ),
    );

    const inventory = engine.inventory(1);
    expect(inventory?.remaining).toBe(0);
    expect(inventory?.reserved).toBe(30);
  });

  it("시뮬레이터는 요청 수·TPS·오버이슈를 집계한다", async () => {
    const { engine } = makeEngine({ stock: 120 });
    const report = await engine.simulateTraffic({ requests: 1_000, concurrency: 128, abuseRate: 0.1, seed: 7 });

    expect(report.requests).toBe(1_000);
    expect(report.abuseBlocked).toBeGreaterThan(0);
    expect(report.issued).toBe(120);
    expect(report.soldOut).toBe(1_000 - 120 - report.abuseBlocked - report.duplicate - report.other);
    expect(report.oversell).toBe(0);
    expect(report.balanced).toBe(true);
    expect(report.tps).toBeGreaterThan(0);
  });
});

describe("쿠폰 발급 — 캠페인·예산·마진", () => {
  it("오픈 전에는 CAMPAIGN_CLOSED다", async () => {
    const { engine, clock } = makeEngine();
    clock.now = NOW - 60 * 60_000;

    const response = await engine.issue(req());

    expect(response.outcome).toBe("CAMPAIGN_CLOSED");
    expect(response.reason).toContain("응모 가능 시간");
  });

  it("종료 시각과 같은 순간도 닫힌 것으로 본다(구간은 [start, end))", async () => {
    const { engine, clock } = makeEngine();
    clock.now = NOW + 90 * 60_000;

    const response = await engine.issue(req());
    expect(response.outcome).toBe("CAMPAIGN_CLOSED");
  });

  it("일시정지된 캠페인은 상태 사유를 알려준다", async () => {
    const { engine } = makeEngine({ campaigns: [campaign({ status: "paused" })] });

    const response = await engine.issue(req());
    expect(response.outcome).toBe("CAMPAIGN_CLOSED");
    expect(response.reason).toContain("paused");
  });

  it("다른 캠페인의 템플릿은 사용할 수 없다", async () => {
    const { engine } = makeEngine({ templates: [template({ campaignId: 9 })] });

    const response = await engine.issue(req());
    expect(response.outcome).toBe("TEMPLATE_INACTIVE");
  });

  it("장수 상한을 넘으면 BUDGET_EXHAUSTED다", async () => {
    const { engine } = makeEngine({ campaigns: [campaign({ tokenBudget: 2 })] });

    await engine.issue(req({ userHash: "user-1-aaaaaaaaaaaaaaaaaaaa", idempotencyKey: "b1" }));
    await engine.issue(req({ userHash: "user-2-aaaaaaaaaaaaaaaaaaaa", idempotencyKey: "b2" }));
    const third = await engine.issue(req({ userHash: "user-3-aaaaaaaaaaaaaaaaaaaa", idempotencyKey: "b3" }));

    expect(third.outcome).toBe("BUDGET_EXHAUSTED");
    expect(third.reason).toContain("예산");
  });

  it("마진 가드레일이 막으면 재고를 건드리지 않는다", async () => {
    const { engine } = makeEngine();
    // 30,000 - 1,089 - 2,600 - 3,000 - 22,000 = 1,311 (4.37% < 12%)
    const response = await engine.issue(req({ margin: margin({ productCost: 22_000 }) }));

    expect(response.outcome).toBe("MARGIN_GUARD_BLOCKED");
    expect(response.margin.projectedMargin).toBe(1_311);
    expect(engine.inventory(1)?.remaining).toBe(100);
    expect(engine.ledger()).toHaveLength(0);
  });

  it("경고 모드에서는 발급하되 위반 사실을 결과에 남긴다", async () => {
    const { engine } = makeEngine({ campaigns: [campaign({ marginGuardMode: "warn" })] });
    const response = await engine.issue(req({ margin: margin({ productCost: 22_000 }) }));

    expect(response.outcome).toBe("ISSUED");
    expect(marginPasses(response.margin)).toBe(false);
    expect(engine.inventory(1)?.remaining).toBe(99);
  });

  it("주문금액이 없으면 최소 장바구니로 가드레일을 평가한다", async () => {
    const { engine } = makeEngine();
    const response = await engine.issue(req({ margin: { orderAmount: 0, productCost: 20_000 } }));

    expect(response.outcome).toBe("ISSUED");
    expect(response.margin.orderAmount).toBe(30_000);
  });
});

describe("원장 전이", () => {
  it("예약 시 할인액과 주문번호가 확정된다", async () => {
    const { engine } = makeEngine();
    const issued = await engine.issue(req());
    const result = engine.reserve(issued.entry!.id, { orderAmount: 32_000, orderId: "ORDER-1" });

    expect(result.ok).toBe(true);
    expect(result.entry?.status).toBe("RESERVED");
    expect(result.entry?.discountAmount).toBe(3_000);
    expect(result.entry?.orderAmount).toBe(32_000);
    expect(result.entry?.orderId).toBe("ORDER-1");
  });

  it("최소 주문금액 미달 주문에는 쿠폰을 묶을 수 없다", async () => {
    const { engine } = makeEngine();
    const issued = await engine.issue(req());
    const result = engine.reserve(issued.entry!.id, { orderAmount: 10_000, orderId: "ORDER-2" });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("최소 주문금액");
  });

  it("두 번 예약할 수 없다", async () => {
    const { engine } = makeEngine();
    const issued = await engine.issue(req());

    engine.reserve(issued.entry!.id, { orderAmount: 32_000, orderId: "ORDER-1" });
    const second = engine.reserve(issued.entry!.id, { orderAmount: 32_000, orderId: "ORDER-1" });

    expect(second.ok).toBe(false);
    expect(second.reason).toContain("RESERVED");
  });

  it("만료된 쿠폰은 예약 시 만료 처리되고 재고가 복원된다", async () => {
    const { engine, clock } = makeEngine();
    const issued = await engine.issue(req());

    clock.now = NOW + 16 * 60_000;
    const result = engine.reserve(issued.entry!.id, { orderAmount: 32_000, orderId: "ORDER-3" });

    expect(result.ok).toBe(false);
    expect(engine.findEntry(issued.entry!.id)?.status).toBe("EXPIRED");
    expect(engine.inventory(1)).toMatchObject({ remaining: 100, reserved: 0 });
  });

  it("사용 확정은 예약 재고를 사용 재고로 옮긴다", async () => {
    const { engine } = makeEngine();
    const issued = await engine.issue(req());
    engine.reserve(issued.entry!.id, { orderAmount: 32_000, orderId: "ORDER-1" });

    const result = engine.redeem(issued.entry!.id);

    expect(result.ok).toBe(true);
    expect(result.entry?.status).toBe("REDEEMED");
    expect(engine.inventory(1)).toMatchObject({ reserved: 0, consumed: 1, remaining: 99 });
  });

  it("예약 없이 사용할 수 없다", async () => {
    const { engine } = makeEngine();
    const issued = await engine.issue(req());
    const result = engine.redeem(issued.entry!.id);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ISSUED");
  });

  it("정산은 사용 확정 뒤에만 가능하다", async () => {
    const { engine } = makeEngine();
    const issued = await engine.issue(req());
    engine.reserve(issued.entry!.id, { orderAmount: 32_000, orderId: "ORDER-1" });

    expect(engine.settle(issued.entry!.id).ok).toBe(false);
    engine.redeem(issued.entry!.id);
    const settled = engine.settle(issued.entry!.id);

    expect(settled.ok).toBe(true);
    expect(settled.entry?.status).toBe("SETTLED");
    expect(settled.entry?.settledAt).toBeGreaterThan(0);
  });

  it("취소는 재고를 한 번만 복원한다", async () => {
    const { engine } = makeEngine();
    const issued = await engine.issue(req());

    const first = engine.cancel(issued.entry!.id, "주문 취소");
    const second = engine.cancel(issued.entry!.id, "주문 취소");

    expect(first.ok).toBe(true);
    expect(first.entry?.status).toBe("CANCELLED");
    expect(second.ok).toBe(false);
    expect(engine.inventory(1)).toMatchObject({ remaining: 100, reserved: 0 });
  });

  it("사용·정산된 쿠폰은 취소할 수 없다", async () => {
    const { engine } = makeEngine();
    const issued = await engine.issue(req());
    engine.reserve(issued.entry!.id, { orderAmount: 32_000, orderId: "ORDER-1" });
    engine.redeem(issued.entry!.id);

    const result = engine.cancel(issued.entry!.id, "정정");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("사용·정산");
  });

  it("만료 전에는 만료 처리되지 않는다", async () => {
    const { engine } = makeEngine();
    const issued = await engine.issue(req());

    const result = engine.expire(issued.entry!.id);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("아직 만료 시각");
  });

  it("만료 스윕은 만료된 것만 처리한다", async () => {
    const { engine, clock } = makeEngine();
    const old = await engine.issue(req({ userHash: "user-old-aaaaaaaaaaaaaaaaaa", idempotencyKey: "old" }));

    clock.now = NOW + 10 * 60_000;
    const fresh = await engine.issue(req({ userHash: "user-new-aaaaaaaaaaaaaaaaaa", idempotencyKey: "new" }));

    clock.now = NOW + 16 * 60_000;
    const report = engine.sweepExpired();

    expect(report.expired).toBe(1);
    expect(report.failed).toBe(0);
    expect(engine.findEntry(old.entry!.id)?.status).toBe("EXPIRED");
    expect(engine.findEntry(fresh.entry!.id)?.status).toBe("ISSUED");
  });
});

describe("쇼핑몰 정산 대사", () => {
  async function settleOne(engine: FlashCouponEngine, orderAmount: number) {
    const issued = await engine.issue(req());
    engine.reserve(issued.entry!.id, { orderAmount, orderId: "ORDER-1" });
    engine.redeem(issued.entry!.id);
    engine.settle(issued.entry!.id);
    return issued.entry!;
  }

  const line = (entryCodeHash: string, amount: number, overrides: Partial<SettlementLine> = {}): SettlementLine => ({
    couponRef: entryCodeHash,
    mallDiscountAmount: amount,
    settlementMonth: "2026-11",
    mallSettlementRef: "SS-SETTLE-202611-0001",
    storeId: 1,
    ...overrides,
  });

  it("차감액이 원장과 같으면 MATCHED이고 부담 주체가 3분할된다", async () => {
    const { engine } = makeEngine();
    const entry = await settleOne(engine, 32_000);

    const report = engine.reconcile([line(entry.codeHash, 3_000)]);

    expect(report.matched).toBe(1);
    expect(report.disputed).toBe(0);
    expect(report.rows[0]).toMatchObject({ status: "MATCHED", sellerBorne: 0, partnerBorne: 3_000, variance: 0 });
  });

  it("제휴 부담 쿠폰을 셀러에게 더 차감하면 SELLER_OVERBORNE으로 이의 제기 대상이 된다", async () => {
    const { engine } = makeEngine();
    const entry = await settleOne(engine, 32_000);

    const report = engine.reconcile([line(entry.codeHash, 4_500)]);

    expect(report.disputed).toBe(1);
    expect(report.sellerRecoverable).toBe(1_500);
    expect(report.rows[0]?.reason).toBe("SELLER_OVERBORNE");
    expect(report.rows[0]?.detail).toContain("1,500");
  });

  it("차감액이 원장보다 적으면 우리(플랫폼)가 부담한 금액으로 잡는다", async () => {
    const { engine } = makeEngine();
    const entry = await settleOne(engine, 32_000);

    const report = engine.reconcile([line(entry.codeHash, 2_000)]);

    expect(report.rows[0]?.reason).toBe("PLATFORM_OVERBORNE");
    expect(report.platformOverborne).toBe(1_000);
  });

  it("원장에 없는 쿠폰 코드는 UNKNOWN_COUPON으로 분리한다", async () => {
    const { engine } = makeEngine();

    const report = engine.reconcile([line("unknown-hash", 3_000)]);

    expect(report.unknown).toBe(1);
    expect(report.rows[0]?.reason).toBe("UNKNOWN_COUPON");
    expect(report.disputed).toBe(1);
  });

  it("같은 쿠폰이 두 번 차감되면 DUPLICATE_DISCOUNT로 잡아낸다", async () => {
    const { engine } = makeEngine();
    const entry = await settleOne(engine, 32_000);

    const report = engine.reconcile([line(entry.codeHash, 3_000), line(entry.codeHash, 3_000)]);

    expect(report.matched).toBe(1);
    expect(report.rows[1]?.reason).toBe("DUPLICATE_DISCOUNT");
  });

  it("대사 결과는 정산 월 단위로 다시 계산해도 같은 판정을 낸다(멱등)", async () => {
    const { engine } = makeEngine();
    const entry = await settleOne(engine, 32_000);
    const lines = [line(entry.codeHash, 3_000)];

    const first = engine.reconcile(lines);
    const second = engine.reconcile(lines);

    expect(first.rows).toEqual(second.rows);
  });
});

describe("운영 지표", () => {
  it("발급 결과별 카운터와 지연 통계를 남긴다", async () => {
    const { engine } = makeEngine({ stock: 2 });

    await engine.issue(req({ userHash: "user-1-aaaaaaaaaaaaaaaaaaaa", idempotencyKey: "m1" }));
    await engine.issue(req({ userHash: "user-1-aaaaaaaaaaaaaaaaaaaa", idempotencyKey: "m1" }));
    await engine.issue(req({ userHash: "user-2-aaaaaaaaaaaaaaaaaaaa", idempotencyKey: "m2" }));
    await engine.issue(req({ userHash: "user-3-aaaaaaaaaaaaaaaaaaaa", idempotencyKey: "m3" }));

    const metrics = engine.metricsSnapshot();
    expect(metrics.attempts).toBe(4);
    expect(metrics.issued).toBe(2);
    expect(metrics.replayed).toBe(1);
    expect(metrics.soldOut).toBe(1);
    expect(metrics.maxLatencyMs).toBeGreaterThanOrEqual(metrics.avgLatencyMs);
  });

  it("쿠폰 코드는 16자리이며 서로 겹치지 않는다", async () => {
    const { engine } = makeEngine({ stock: 2_000 });
    const codes = new Set<string>();

    await Promise.all(
      Array.from({ length: 1_000 }, (_, i) =>
        engine.issue(req({ userHash: `code-${i.toString().padStart(24, "0")}`, idempotencyKey: `c-${i}` })),
      ),
    );

    engine.ledger().forEach((entry) => {
      expect(entry.maskedCode).toHaveLength(16);
      expect(entry.codeHash).toHaveLength(64);
      codes.add(entry.codeHash);
    });
    expect(codes.size).toBe(1_000);
  });
});
