import { describe, expect, it } from "vitest";
import {
  DEFAULT_NET_PAYOUT_INPUT,
  FEE_CATEGORIES,
  calculateNetPayout,
  resolveCategoryFee,
  roasForTargetNetCash,
  simulateRoas,
  type NetPayoutInput,
} from "./netPayout";
import { MARKET_PRESETS } from "./calculator";

const base: NetPayoutInput = {
  marketId: "smartstore",
  categoryId: "living",
  monthlyRevenue: 42_600_000,
  settlementAmount: 0,
  commissionRate: resolveCategoryFee("smartstore", "living"),
  paymentRate: MARKET_PRESETS.smartstore.paymentRate,
  cogsRate: 38,
  roas: 4.2,
  returnRate: 7.5,
  exchangeRate: 3.5,
  returnShippingFee: 3_000,
  exchangeShippingFee: 2_800,
  averageOrderValue: 32_000,
  monthlyFixedCost: 1_850_000,
};

describe("마켓·카테고리 수수료표", () => {
  it("카테고리별 요율은 마켓마다 다르고, 자사몰은 중개 수수료가 없다", () => {
    expect(resolveCategoryFee("smartstore", "digital")).toBe(3.63);
    expect(resolveCategoryFee("coupang", "digital")).toBe(8);
    expect(resolveCategoryFee("own", "fashion")).toBe(0);

    // 카테고리가 같아도 마켓이 바뀌면 요율이 달라진다 — 이 프로젝트의 핵심 차이다.
    expect(resolveCategoryFee("coupang", "fashion")).toBeGreaterThan(
      resolveCategoryFee("smartstore", "fashion"),
    );
  });

  it("표에 없는 마켓은 프리셋 기본 요율로 대체한다", () => {
    // 모든 카테고리에 5개 마켓 요율이 정의되어 있는지 먼저 고정한다.
    for (const category of FEE_CATEGORIES) {
      expect(Object.keys(category.rates)).toHaveLength(5);
    }
    expect(resolveCategoryFee("smartstore", "pet")).toBe(5);
  });
});

describe("실수령 순수익 계산", () => {
  it("정산금과 통장 순수익을 순서대로 차감해 계산한다", () => {
    const result = calculateNetPayout(base);

    const keptRevenue = base.monthlyRevenue * (1 - base.returnRate / 100);
    expect(result.keptRevenue).toBe(Math.round(keptRevenue));

    const commission = Math.round(keptRevenue * (base.commissionRate / 100));
    expect(result.commission).toBe(commission);

    // 반품 회수 배송비는 왕복이다.
    const returns = (base.monthlyRevenue / base.averageOrderValue) * (base.returnRate / 100);
    expect(result.returnShippingLoss).toBe(Math.round(returns * base.returnShippingFee * 2));

    expect(result.expectedSettlement).toBe(
      Math.round(keptRevenue - commission - result.paymentFee - result.returnShippingLoss),
    );

    // 통장 = 정산금 - 교환 배송비 - 원가 - 고정비 - 광고비
    expect(result.netCash).toBe(
      Math.round(
        result.settlementBase -
          result.exchangeShippingLoss -
          result.cogs -
          result.fixedCost -
          result.adSpend,
      ),
    );

    // 광고비를 더한 값이 광고 전 공헌이익이다.
    expect(result.contributionBeforeAd).toBe(result.netCash + result.adSpend);
  });

  it("정산서 금액을 넣으면 예상 정산금과의 차액을 보여 준다", () => {
    const expected = calculateNetPayout(base).expectedSettlement;
    const underpaid = calculateNetPayout({ ...base, settlementAmount: expected - 240_000 });

    expect(underpaid.confirmedSettlement).toBe(expected - 240_000);
    expect(underpaid.settlementGap).toBe(-240_000);
    expect(underpaid.netCash).toBe(calculateNetPayout(base).netCash - 240_000);
  });

  it("정산서 금액이 없으면 예상 정산금을 시작점으로 쓰고 차액은 null이다", () => {
    const result = calculateNetPayout({ ...base, settlementAmount: 0 });
    expect(result.confirmedSettlement).toBeNull();
    expect(result.settlementGap).toBeNull();
    expect(result.settlementBase).toBe(result.expectedSettlement);
  });

  it("광고를 끄면 광고비가 0이고 순수익이 공헌이익과 같아진다", () => {
    const result = calculateNetPayout({ ...base, roas: 0 });
    expect(result.adSpend).toBe(0);
    expect(result.netCash).toBe(result.contributionBeforeAd);
  });

  it("반품률과 교환률을 올리면 순수익이 줄어든다", () => {
    const normal = calculateNetPayout(base);
    const risky = calculateNetPayout({ ...base, returnRate: 18, exchangeRate: 9 });
    expect(risky.netCash).toBeLessThan(normal.netCash);
    expect(risky.returnShippingLoss).toBeGreaterThan(normal.returnShippingLoss);
    expect(risky.exchangeShippingLoss).toBeGreaterThan(normal.exchangeShippingLoss);
  });
});

describe("손익분기 ROAS", () => {
  it("손익분기 ROAS에서는 순수익이 0에 가깝고, 그보다 낮으면 적자다", () => {
    const result = calculateNetPayout(base);
    expect(Number.isFinite(result.breakEvenRoas)).toBe(true);

    const atBreakEven = calculateNetPayout({ ...base, roas: result.breakEvenRoas });
    expect(Math.abs(atBreakEven.netCash)).toBeLessThanOrEqual(2);

    const below = calculateNetPayout({ ...base, roas: result.breakEvenRoas * 0.9 });
    expect(below.netCash).toBeLessThan(0);

    const above = calculateNetPayout({ ...base, roas: result.breakEvenRoas * 1.2 });
    expect(above.netCash).toBeGreaterThan(0);
  });

  it("광고 전 공헌이익이 0 이하면 어떤 ROAS로도 흑자가 될 수 없다", () => {
    const impossible = calculateNetPayout({ ...base, cogsRate: 96, monthlyFixedCost: 6_000_000 });
    expect(impossible.contributionBeforeAd).toBeLessThanOrEqual(0);
    expect(impossible.breakEvenRoas).toBe(Number.POSITIVE_INFINITY);
    expect(impossible.roasHeadroom).toBeNull();
  });

  it("현재 ROAS가 손익분기보다 높으면 여유율이 양수다", () => {
    const result = calculateNetPayout(base);
    expect(result.roasHeadroom).not.toBeNull();
    expect(result.roasHeadroom as number).toBeGreaterThan(0);
  });
});

describe("시뮬레이션", () => {
  it("ROAS를 올릴수록 순수익이 단조 증가한다", () => {
    const rows = simulateRoas(base, [1, 2, 3, 4, 6, 8]);
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index].netCash).toBeGreaterThanOrEqual(rows[index - 1].netCash);
      expect(rows[index].adSpend).toBeLessThanOrEqual(rows[index - 1].adSpend);
    }

    // ROAS 0은 "광고 미집행"이며, 스케일의 끝점이 아니라 별도 상태다(광고비 0 → 순수익 최대).
    const [off] = simulateRoas(base, [0]);
    expect(off.adSpend).toBe(0);
    expect(off.netCash).toBeGreaterThan(rows[rows.length - 1].netCash);
  });

  it("목표 순수익을 만족하는 ROAS를 역산할 수 있다", () => {
    const target = 2_000_000;
    const roas = roasForTargetNetCash(base, target);
    expect(Number.isFinite(roas)).toBe(true);
    const result = calculateNetPayout({ ...base, roas });
    expect(Math.abs(result.netCash - target)).toBeLessThanOrEqual(2);

    // 목표가 공헌이익보다 크면 도달 불가
    const impossibleTarget = calculateNetPayout(base).contributionBeforeAd + 1_000_000;
    expect(roasForTargetNetCash(base, impossibleTarget)).toBe(Number.POSITIVE_INFINITY);
  });

  it("카테고리 시나리오는 지금 조건과 같은 값을 포함하고, 요율이 같으면 순수익도 같다", () => {
    const result = calculateNetPayout(base);
    const current = result.categoryScenarios.find((row) => row.categoryId === base.categoryId);
    expect(current?.commissionRate).toBe(base.commissionRate);
    expect(current?.netCash).toBe(result.netCash);
    expect(current?.delta).toBe(0);

    for (const row of result.categoryScenarios) {
      expect(row.delta).toBe(row.netCash - result.netCash);
      // 수수료율이 높을수록 순수익이 낮다(다른 조건이 같으므로).
      if (row.commissionRate > base.commissionRate) expect(row.netCash).toBeLessThan(result.netCash);
    }
  });

  it("마켓 시나리오는 결제 수수료까지 반영하고 현재 마켓의 차액은 0이다", () => {
    const result = calculateNetPayout(base);
    const current = result.marketScenarios.find((row) => row.marketId === base.marketId);
    expect(current?.delta).toBe(0);

    const own = result.marketScenarios.find((row) => row.marketId === "own");
    expect(own?.commissionRate).toBe(0);
    // 자사몰은 중개 수수료가 없어 스마트스토어보다 많이 남는다(결제 수수료 3.3%만 부담).
    expect(own?.netCash as number).toBeGreaterThan(result.netCash);
  });
});

describe("입력 방어", () => {
  it("음수·NaN·범위 밖 율이 들어와도 결과가 NaN이 되지 않는다", () => {
    const broken: NetPayoutInput = {
      ...base,
      monthlyRevenue: Number.NaN,
      settlementAmount: Number.NaN,
      commissionRate: Number.NaN,
      paymentRate: -5,
      cogsRate: 300,
      roas: -2,
      returnRate: Number.NaN,
      exchangeRate: 200,
      averageOrderValue: 0,
      monthlyFixedCost: -100,
    };
    const result = calculateNetPayout(broken);

    const numbers = [
      result.revenue,
      result.commission,
      result.paymentFee,
      result.cogs,
      result.adSpend,
      result.returnShippingLoss,
      result.exchangeShippingLoss,
      result.expectedSettlement,
      result.netCash,
      result.netMarginRate,
      result.netPerOrder,
    ];
    for (const value of numbers) expect(Number.isNaN(value)).toBe(false);

    expect(result.revenue).toBe(0);
    expect(result.adSpend).toBe(0);
    expect(result.fixedCost).toBe(0);
    // 반품률이 NaN이면 0으로 보정되어 매출이 유지된다.
    expect(result.keptRevenue).toBe(0);
    // 수수료율이 NaN이면 마켓·카테고리 표의 요율로 되돌아간다(입력란을 비웠을 때의 동작).
    expect(result.commissionRate).toBe(resolveCategoryFee(base.marketId, base.categoryId));
  });

  it("기본 입력값은 그대로 계산된다", () => {
    const result = calculateNetPayout(DEFAULT_NET_PAYOUT_INPUT);
    expect(result.netCash).toBeLessThan(result.expectedSettlement);
    expect(result.netMarginRate).toBeGreaterThan(-100);
  });
});
