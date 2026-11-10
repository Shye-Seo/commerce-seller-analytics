import { describe, expect, it } from "vitest";
import { MARKET_PRESETS, calculateMargin } from "./calculator";
import { compareMarkets, toMarketInput } from "./marketComparison";
import type { MarginInput } from "./types";

const baseInput: MarginInput = {
  marketId: "smartstore",
  costPrice: 12_800,
  sellingPrice: 27_900,
  commissionRate: 3.63,
  paymentRate: 0,
  shippingCost: 3_000,
  adCostPerUnit: 2_400,
  returnRate: 9,
  monthlyUnits: 380,
  monthlyFixedCost: 620_000,
};

describe("compareMarkets", () => {
  it("5개 마켓을 모두 비교한다", () => {
    const comparison = compareMarkets(baseInput);

    expect(comparison.rows).toHaveLength(5);
    expect(comparison.rows.map((row) => row.id)).toEqual([
      "smartstore",
      "coupang",
      "elevenst",
      "gmarket",
      "own",
    ]);
  });

  it("판매가·매출·판매량은 모든 마켓에서 동일하게 유지된다", () => {
    const comparison = compareMarkets(baseInput);
    const expectedRevenue = 27_900 * 380;

    expect(comparison.rows.every((row) => row.monthlyRevenue === expectedRevenue)).toBe(true);
  });

  it("마켓별 수수료는 프리셋 요율로 계산한다", () => {
    const comparison = compareMarkets(baseInput);
    const coupang = comparison.rows.find((row) => row.id === "coupang");
    const own = comparison.rows.find((row) => row.id === "own");

    expect(coupang?.feePerUnit).toBe(Math.round(27_900 * 0.108));
    expect(coupang?.totalFeeRate).toBe(10.8);
    // 자사몰은 중개 수수료 대신 PG 3.3%
    expect(own?.feePerUnit).toBe(Math.round(27_900 * 0.033));
    expect(own?.commissionRate).toBe(0);
    expect(own?.paymentRate).toBe(3.3);
  });

  it("건당 순이익은 마진 계산기와 같은 식을 쓴다", () => {
    const comparison = compareMarkets(baseInput);
    const coupang = comparison.rows.find((row) => row.id === "coupang");
    const expected = calculateMargin(toMarketInput(baseInput, "coupang"));

    expect(coupang?.netProfitPerUnit).toBe(expected.netProfitPerUnit);
    expect(coupang?.marginRate).toBeCloseTo(expected.marginRate, 10);
    expect(coupang?.monthlyNetProfit).toBe(expected.monthlyNetProfit);
  });

  it("최고 마진 채널에만 Best Margin 플래그가 붙는다", () => {
    const comparison = compareMarkets(baseInput);
    const maxProfit = Math.max(...comparison.rows.map((row) => row.netProfitPerUnit));
    const flagged = comparison.rows.filter((row) => row.isBestMargin);

    expect(flagged.length).toBeGreaterThanOrEqual(1);
    expect(flagged.every((row) => row.netProfitPerUnit === maxProfit)).toBe(true);
    expect(comparison.bestMargin.netProfitPerUnit).toBe(maxProfit);
    expect(comparison.bestMargin.gapFromBest).toBe(0);
  });

  it("가장 빠른 정산 채널은 자사몰(2일)이고 최대 1개 채널에만 플래그가 붙는다", () => {
    const comparison = compareMarkets(baseInput);
    const flagged = comparison.rows.filter((row) => row.isFastestSettlement);

    expect(comparison.fastestSettlement.id).toBe("own");
    expect(comparison.fastestSettlement.settlementDays).toBe(2);
    expect(flagged).toHaveLength(1);
  });

  it("순위는 1~5까지 중복 없이 매겨지고 순이익 내림차순이다", () => {
    const comparison = compareMarkets(baseInput);
    const ranks = comparison.rows.map((row) => row.rank).sort((a, b) => a - b);
    const sorted = [...comparison.rows].sort((a, b) => a.rank - b.rank);

    expect(ranks).toEqual([1, 2, 3, 4, 5]);
    for (let index = 1; index < sorted.length; index += 1) {
      expect(sorted[index].netProfitPerUnit).toBeLessThanOrEqual(
        sorted[index - 1].netProfitPerUnit,
      );
    }
  });

  it("1위와 최하위의 차이를 건당·월 단위로 제공한다", () => {
    const comparison = compareMarkets(baseInput);

    expect(comparison.perUnitSpread).toBe(
      comparison.bestMargin.netProfitPerUnit - comparison.worstMargin.netProfitPerUnit,
    );
    expect(comparison.monthlySpread).toBe(
      comparison.bestMargin.monthlyNetProfit - comparison.worstMargin.monthlyNetProfit,
    );
    expect(comparison.perUnitSpread).toBeGreaterThan(0);
  });

  it("현재 선택한 마켓을 표시한다", () => {
    const comparison = compareMarkets({ ...baseInput, marketId: "gmarket" });

    expect(comparison.selected.id).toBe("gmarket");
    expect(comparison.rows.filter((row) => row.isSelected)).toHaveLength(1);
  });

  it("모든 채널이 적자여도 최고 마진 채널을 결정한다", () => {
    const comparison = compareMarkets({ ...baseInput, sellingPrice: 15_000 });

    expect(comparison.rows.every((row) => row.netProfitPerUnit < 0)).toBe(true);
    expect(comparison.bestMargin.netProfitPerUnit).toBe(
      Math.max(...comparison.rows.map((row) => row.netProfitPerUnit)),
    );
    expect(comparison.monthlySpread).toBeGreaterThanOrEqual(0);
  });

  it("판매량이 0이어도 예외 없이 비교표를 만든다", () => {
    const comparison = compareMarkets({ ...baseInput, monthlyUnits: 0 });

    expect(comparison.rows).toHaveLength(5);
    expect(comparison.monthlySpread).toBe(0);
  });
});

describe("toMarketInput", () => {
  it("수수료율만 바꾸고 상품 고유 비용은 유지한다", () => {
    const converted = toMarketInput(baseInput, "coupang");

    expect(converted.marketId).toBe("coupang");
    expect(converted.commissionRate).toBe(MARKET_PRESETS.coupang.commissionRate);
    expect(converted.paymentRate).toBe(MARKET_PRESETS.coupang.paymentRate);
    expect(converted.costPrice).toBe(baseInput.costPrice);
    expect(converted.sellingPrice).toBe(baseInput.sellingPrice);
    expect(converted.shippingCost).toBe(baseInput.shippingCost);
    expect(converted.adCostPerUnit).toBe(baseInput.adCostPerUnit);
    expect(converted.returnRate).toBe(baseInput.returnRate);
    expect(converted.monthlyFixedCost).toBe(baseInput.monthlyFixedCost);
  });

  it("원본 입력을 변경하지 않는다", () => {
    toMarketInput(baseInput, "elevenst");

    expect(baseInput.marketId).toBe("smartstore");
    expect(baseInput.commissionRate).toBe(3.63);
  });
});
