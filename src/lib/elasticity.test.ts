import { describe, expect, it } from "vitest";
import { MARKET_LIST, RETURN_HANDLING_RATE } from "./calculator";
import {
  breakEvenPrice,
  computeElasticity,
  computeMarketCurve,
  netProfitAtPrice,
} from "./elasticity";
import type { MarginInput } from "./types";

const input: MarginInput = {
  marketId: "smartstore",
  costPrice: 12_800,
  sellingPrice: 27_900,
  commissionRate: 3.63,
  paymentRate: 0,
  shippingCost: 3_000,
  adCostPerUnit: 0,
  returnRate: 9,
  monthlyUnits: 380,
  monthlyFixedCost: 620_000,
};

const config = { listPrice: 27_900, discountRate: 10, roas: 4 };

/** 같은 식을 테스트에서 직접 계산해 엔진과 대조한다(상수를 손으로 적지 않는다). */
function expectedFixedCost(margin: MarginInput): number {
  const returnLoss =
    (margin.returnRate / 100) * (margin.shippingCost * 2 + margin.costPrice * RETURN_HANDLING_RATE);
  return margin.costPrice + margin.shippingCost + returnLoss;
}

describe("netProfitAtPrice", () => {
  it("수수료와 ROAS가 판매가에 비례한다고 보고 순이익을 계산한다", () => {
    // 20,000 × (1 - 0.108 - 0.25) - 15,800 = -2,960
    expect(netProfitAtPrice(20_000, 0.108, 15_800, 4)).toBeCloseTo(-2_960, 6);
    // ROAS가 0이면 광고비 항을 빼고 계산한다.
    expect(netProfitAtPrice(20_000, 0.108, 15_800, 0)).toBeCloseTo(2_040, 6);
  });

  it("수수료율+광고비율이 100%를 넘으면 판매가가 커질수록 손실도 커진다", () => {
    expect(netProfitAtPrice(20_000, 0.6, 0, 1)).toBeLessThan(netProfitAtPrice(10_000, 0.6, 0, 1));
  });
});

describe("breakEvenPrice", () => {
  it("고정비성 원가를 수수료·광고비 기여도로 나눠 100원 단위로 올림한다", () => {
    // 15,800 / (1 - 0.108 - 0.25) = 24,610.9… → 24,700
    expect(breakEvenPrice(0.108, 15_800, 4)).toBe(24_700);
  });

  it("계수 합이 0 이하이면 도달 불가(Infinity)를 반환한다", () => {
    expect(breakEvenPrice(0.5, 10_000, 2)).toBe(Number.POSITIVE_INFINITY);
    expect(breakEvenPrice(0.1, 10_000, 0)).toBeGreaterThan(0);
  });

  it("손익분기 판매가에서는 순이익이 0에 수렴한다", () => {
    const feeRate = 0.0363;
    const fixed = expectedFixedCost(input);
    const be = breakEvenPrice(feeRate, fixed, 0);

    // 100원 단위 올림이므로 오차는 기여도(1 - 수수료율) × 100원을 넘지 않는다.
    expect(Math.abs(netProfitAtPrice(be, feeRate, fixed, 0))).toBeLessThanOrEqual(100);
  });
});

describe("computeElasticity", () => {
  it("5개 마켓을 MARKET_LIST 순서대로 계산한다", () => {
    const result = computeElasticity(input, config);

    expect(result.curves).toHaveLength(5);
    expect(result.curves.map((curve) => curve.marketId)).toEqual(
      MARKET_LIST.map((market) => market.id),
    );
  });

  it("정가·할인율로 실제 판매가와 건당 광고비를 도출한다", () => {
    const result = computeElasticity(input, { listPrice: 30_000, discountRate: 20, roas: 5 });

    expect(result.config.paidPrice).toBe(24_000);
    expect(result.config.adCostPerUnit).toBe(4_800);
    expect(result.config.fixedCostPerUnit).toBeCloseTo(expectedFixedCost(input), 5);
  });

  it("할인율이 올라가면 모든 마켓의 마진이 나빠진다", () => {
    const none = computeElasticity(input, { ...config, discountRate: 0 });
    const heavy = computeElasticity(input, { ...config, discountRate: 25 });

    for (let index = 0; index < none.curves.length; index += 1) {
      expect((heavy.curves[index] as { netPerUnit: number }).netPerUnit).toBeLessThan(
        (none.curves[index] as { netPerUnit: number }).netPerUnit,
      );
    }
  });

  it("ROAS가 낮아지면 손익분기 판매가가 올라간다", () => {
    const efficient = computeElasticity(input, { ...config, roas: 6 });
    const expensive = computeElasticity(input, { ...config, roas: 2.5 });

    expect(expensive.curves[1]!.breakEvenPrice).toBeGreaterThan(
      efficient.curves[1]!.breakEvenPrice,
    );
    // 2.5 ROAS는 광고비가 판매가의 40%라, 수수료가 낮은 자사몰에서도 손익분기가 크게 오른다.
    expect(expensive.curves[4]!.breakEvenPrice).toBeGreaterThan(
      efficient.curves[4]!.breakEvenPrice,
    );
  });

  it("현재 판매가에서 마진이 가장 큰 마켓을 고르고, 자사몰이 유리한 조건을 반영한다", () => {
    const result = computeElasticity(input, { listPrice: 27_900, discountRate: 0, roas: 4 });

    expect(result.best?.marketId).toBe("own");
    expect(result.lowestBreakEven?.marketId).toBe("own");
  });

  it("마진율 곡선은 판매가가 오를수록 단조 증가한다(계수 합이 양수일 때)", () => {
    const curve = computeMarketCurve(input, MARKET_LIST[0]!, config);

    expect(curve.series).toHaveLength(25);
    for (let index = 1; index < curve.series.length; index += 1) {
      expect(curve.series[index]!.marginRate).toBeGreaterThan(curve.series[index - 1]!.marginRate);
      expect(curve.series[index]!.price).toBeGreaterThan(curve.series[index - 1]!.price);
    }
  });

  it("광고비율이 100%를 넘으면 손익분기 판매가를 Infinity로 둔다", () => {
    const result = computeElasticity(input, { ...config, roas: 1 });

    expect(result.curves.every((curve) => curve.breakEvenPrice === Number.POSITIVE_INFINITY)).toBe(
      true,
    );
    expect(result.lowestBreakEven).toBeNull();
  });

  it("월 순이익은 판매량·고정비를 반영한다", () => {
    const result = computeElasticity(input, { listPrice: 27_900, discountRate: 0, roas: 4 });
    const curve = result.curves.find((item) => item.marketId === "smartstore")!;

    expect(curve.monthlyNetProfit).toBe(curve.netPerUnit * input.monthlyUnits - input.monthlyFixedCost);
  });

  it("차트 y축은 0선을 포함하고 비정상 입력을 보정한다", () => {
    const result = computeElasticity(input, { listPrice: 0, discountRate: 300, roas: -3 });

    expect(result.config.listPrice).toBeGreaterThan(0);
    expect(result.config.discountRate).toBe(90);
    expect(result.config.roas).toBe(0);
    expect(result.chart.minMarginRate).toBeLessThanOrEqual(0);
    expect(result.chart.maxMarginRate).toBeGreaterThanOrEqual(0);
  });

  it("같은 입력이면 같은 결과가 나온다", () => {
    expect(JSON.stringify(computeElasticity(input, config))).toBe(
      JSON.stringify(computeElasticity(input, config)),
    );
  });
});
