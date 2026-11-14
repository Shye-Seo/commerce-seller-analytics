import { describe, expect, it } from "vitest";
import {
  FlashCouponEngine,
  discountFor,
  seededCodeGenerator,
  type CampaignSpec,
  type CouponTemplateSpec,
} from "./flashCouponEngine";
import {
  buildMarketingOrders,
  buildSettlementRowsForOrders,
  kstDate,
  matchCouponSettlement,
  summarizeCampaignLedger,
  summarizeCampaignPerformance,
} from "./campaignBridge";
import { reconcileSettlement } from "./reconciliationEngine";

const BASE_TIME = Date.parse("2026-11-20T20:30:00+09:00");

const CAMPAIGN: CampaignSpec = {
  id: 1,
  tenantId: 1,
  code: "toss-drop-2026-11",
  name: "무신사 스탠다드 시크릿 드롭",
  type: "TOSS_STYLE_DROP",
  partnerName: "무신사 스탠다드",
  rewardBudget: 9_000_000,
  tokenBudget: 3_000,
  minGuaranteedMargin: 12,
  marginGuardMode: "block",
  startsAt: BASE_TIME - 30 * 60_000,
  endsAt: BASE_TIME + 90 * 60_000,
  status: "live",
  expectedPeakTps: 3_500,
};

const TEMPLATES: CouponTemplateSpec[] = [
  {
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
  },
  {
    id: 2,
    campaignId: 1,
    code: "toss-10-percent",
    name: "10% 할인 (최대 5천원)",
    discountType: "PERCENT",
    discountAmount: 0,
    discountRate: 10,
    minOrderAmount: 20_000,
    maxDiscountAmount: 5_000,
    perUserLimit: 1,
    validityMinutes: 15,
    fundedBy: "PLATFORM",
    isActive: true,
  },
];

function createEngine(): FlashCouponEngine {
  return new FlashCouponEngine({
    campaigns: [CAMPAIGN],
    templates: TEMPLATES,
    inventories: [
      { templateId: 1, total: 60 },
      { templateId: 2, total: 60 },
    ],
    now: () => BASE_TIME,
    codeGenerator: seededCodeGenerator(20261120),
  });
}

/** 발급 → 주문 연결 → 사용 확정까지 실제 엔진 상태 머신을 통과시킨 픽스처 */
async function issueAndLink(engine: FlashCouponEngine) {
  for (let index = 0; index < 40; index += 1) {
    await engine.issue({
      campaignId: 1,
      templateId: index % 2 === 0 ? 1 : 2,
      userHash: `user-${index.toString(36).padStart(20, "0")}`,
      idempotencyKey: `key-${index}`,
    });
  }

  const orders = buildMarketingOrders(engine.ledger(), TEMPLATES, [CAMPAIGN], { redemptionRate: 0.8, seed: 7 });
  for (const order of orders) {
    const reserved = engine.reserve(order.entryId, { orderAmount: order.listAmount, orderId: order.orderId });
    expect(reserved.ok).toBe(true);
    expect(engine.redeem(order.entryId).ok).toBe(true);
  }

  return { ledger: engine.ledger(), orders };
}

describe("buildMarketingOrders", () => {
  it("같은 원장·같은 시드면 같은 주문 집합이 나온다", async () => {
    const first = await issueAndLink(createEngine());
    const second = await issueAndLink(createEngine());

    expect(first.orders.map((order) => order.orderId)).toEqual(second.orders.map((order) => order.orderId));
    expect(first.orders.length).toBeGreaterThan(0);
  });

  it("주문 금액은 최소주문금액을 지키고 할인액은 템플릿 규칙과 같다", async () => {
    const { orders } = await issueAndLink(createEngine());

    for (const order of orders) {
      const template = TEMPLATES.find((item) => item.id === order.templateId);
      expect(template).toBeDefined();
      expect(order.listAmount).toBeGreaterThanOrEqual(template!.minOrderAmount);
      expect(order.discountAmount).toBe(discountFor(template!, order.listAmount));
      expect(order.paidAmount).toBe(order.listAmount - order.discountAmount);
      expect(order.paidAmount).toBeGreaterThan(0);
    }
  });

  it("취소·만료된 쿠폰은 주문으로 이어지지 않는다", async () => {
    const engine = createEngine();
    await engine.issue({ campaignId: 1, templateId: 1, userHash: "u".repeat(20), idempotencyKey: "only" });
    const entry = engine.ledger()[0]!;
    engine.cancel(entry.id, "테스트 취소");

    const orders = buildMarketingOrders(engine.ledger(), TEMPLATES, [CAMPAIGN], { redemptionRate: 1 });
    expect(orders).toHaveLength(0);
  });

  it("주문번호는 채널·주문일·원장 id로 결정되고 KST 날짜를 쓴다", () => {
    expect(kstDate(Date.parse("2026-11-20T14:00:00Z"))).toEqual({ date: "2026-11-20", month: "2026-11" });
    expect(kstDate(Date.parse("2026-11-20T16:00:00Z"))).toEqual({ date: "2026-11-21", month: "2026-11" });
  });
});

describe("buildSettlementRowsForOrders", () => {
  it("계약 조건대로 정산된 정상 행을 만들고 대사 결과가 이상 없음으로 나온다", async () => {
    const { orders } = await issueAndLink(createEngine());
    const rows = buildSettlementRowsForOrders(orders);

    expect(rows).toHaveLength(orders.length);
    for (const row of rows) {
      expect(row.settledAmount).toBe(row.paidAmount - row.commission - row.shippingDeduction - row.returnFee);
      expect(row.status).toBe("배송완료");
    }

    const reconciled = reconcileSettlement(rows);
    expect(reconciled.summary.flaggedRows).toBe(0);
    expect(reconciled.summary.matchedRate).toBe(100);
    for (const item of reconciled.rows) {
      expect(item.netMargin).toBeGreaterThan(0);
    }
  });
});

describe("matchCouponSettlement", () => {
  it("정산서에서 역산한 할인액이 원장 할인액과 같으면 MATCHED", async () => {
    const { orders } = await issueAndLink(createEngine());
    const reconciled = reconcileSettlement(buildSettlementRowsForOrders(orders));
    const report = matchCouponSettlement(orders, reconciled.rows);

    expect(report.ordersLinked).toBe(orders.length);
    expect(report.matched).toBe(orders.length);
    expect(report.disputed).toBe(0);
    expect(report.missingSettlement).toBe(0);
    expect(report.recoverable).toBe(0);
    expect(report.settlementDeduction).toBe(report.ledgerDiscount);
  });

  it("마켓이 할인을 더 차감하면 셀러 회수 대상으로 분리한다", async () => {
    const { orders } = await issueAndLink(createEngine());
    const settlementRows = buildSettlementRowsForOrders(orders);
    const target = settlementRows[0]!;
    const overcharged = { ...target, paidAmount: target.paidAmount - 1_500, settledAmount: target.settledAmount - 1_500 };

    const reconciled = reconcileSettlement([overcharged, ...settlementRows.slice(1)]);
    const report = matchCouponSettlement(orders, reconciled.rows);
    const row = report.rows.find((item) => item.orderId === target.orderNo);

    expect(row?.status).toBe("DISPUTED");
    expect(row?.reason).toBe("SELLER_OVERBORNE");
    expect(row?.variance).toBe(1_500);
    expect(report.recoverable).toBe(1_500);
  });

  it("쿠폰 주문이 정산서에 없으면 누락으로 남기고 매출에 넣지 않는다", async () => {
    const { orders } = await issueAndLink(createEngine());
    const settlementRows = buildSettlementRowsForOrders(orders).slice(1);
    const reconciled = reconcileSettlement(settlementRows);
    const report = matchCouponSettlement(orders, reconciled.rows);

    expect(report.missingSettlement).toBe(1);
    const performance = summarizeCampaignPerformance({ orders, rows: reconciled.rows, campaigns: [CAMPAIGN] });
    expect(performance.campaigns[0]?.orders).toBe(orders.length - 1);
    expect(performance.campaigns[0]?.linkedOrders).toBe(orders.length);
  });
});

describe("summarizeCampaignPerformance", () => {
  it("쿠폰 비용 반영 전·후 마진 차이가 할인액과 일치한다", async () => {
    const { orders } = await issueAndLink(createEngine());
    const reconciled = reconcileSettlement(buildSettlementRowsForOrders(orders));
    const performance = summarizeCampaignPerformance({
      orders,
      rows: reconciled.rows,
      campaigns: [CAMPAIGN],
      campaignSpend: { 1: 1_500_000 },
    });

    const campaign = performance.campaigns[0]!;
    expect(campaign.netMarginBeforeCoupon - campaign.netMargin).toBe(campaign.couponDiscount);
    expect(campaign.mediaCost).toBe(campaign.ourCouponCost + campaign.adSpend);
    expect(campaign.roas).toBeCloseTo(Math.round((campaign.revenue / campaign.mediaCost) * 100) / 100, 5);
    expect(campaign.contributionAfterAdSpend).toBe(campaign.netMargin - campaign.adSpend);
  });

  it("제휴사 부담 쿠폰은 우리 비용에서 빼고 따로 센다", async () => {
    const { orders } = await issueAndLink(createEngine());
    const reconciled = reconcileSettlement(buildSettlementRowsForOrders(orders));
    const performance = summarizeCampaignPerformance({ orders, rows: reconciled.rows, campaigns: [CAMPAIGN] });

    const partnerOnly = orders.filter((order) => order.fundedBy === "PARTNER");
    const platformOnly = orders.filter((order) => order.fundedBy === "PLATFORM");

    expect(partnerOnly.length).toBeGreaterThan(0);
    expect(platformOnly.length).toBeGreaterThan(0);
    expect(performance.totals.partnerCost).toBe(partnerOnly.reduce((sum, order) => sum + order.discountAmount, 0));
    expect(performance.totals.ourCouponCost).toBe(platformOnly.reduce((sum, order) => sum + order.discountAmount, 0));
    // 광고비가 0이면 ROAS 분모는 우리 쿠폰 비용뿐이다
    expect(performance.totals.mediaCost).toBe(performance.totals.ourCouponCost);
  });

  it("매칭된 주문이 없으면 ROAS는 null이다(0으로 나눈 값을 0으로 적지 않는다)", () => {
    const performance = summarizeCampaignPerformance({ orders: [], rows: [], campaigns: [CAMPAIGN] });
    expect(performance.campaigns).toHaveLength(1);
    expect(performance.campaigns[0]?.roas).toBeNull();
    expect(performance.campaigns[0]?.netMargin).toBe(0);
  });
});

describe("summarizeCampaignLedger", () => {
  it("정산 전 원장 기준으로 발급·사용·할인·추정 ROAS를 낸다", async () => {
    const { ledger, orders } = await issueAndLink(createEngine());
    const summary = summarizeCampaignLedger({
      ledger,
      orders,
      campaigns: [CAMPAIGN],
      campaignSpend: { 1: 1_000_000 },
    });

    expect(summary.issued).toBe(ledger.length);
    expect(summary.used).toBe(orders.length);
    expect(summary.couponDiscount).toBe(orders.reduce((sum, order) => sum + order.discountAmount, 0));
    expect(summary.revenue).toBe(orders.reduce((sum, order) => sum + order.paidAmount, 0));
    expect(summary.estimatedRoas).not.toBeNull();
    expect(summary.estimatedRoas!).toBeGreaterThan(0);
  });
});
