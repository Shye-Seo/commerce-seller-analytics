import { describe, expect, it } from "vitest";
import {
  calculateFees,
  calculateMargin,
  computeBreakEvenPrice,
  recommendSellingPrice,
  scoreKeyword,
  scoreKeywords,
} from "./calculator";
import { formatCompactNumber, formatPercent, formatWon } from "./format";
import type { KeywordRow, MarginInput } from "./types";

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

const keywordRow: KeywordRow = {
  id: "test-1",
  keyword: "테스트 키워드",
  market: "naver",
  monthlyVolume: 30_000,
  competition: 40,
  purchaseIntent: 75,
  averagePrice: 25_000,
  category: "테스트",
};

describe("calculateFees", () => {
  it("판매 수수료와 결제 수수료를 각각 계산해 합산한다", () => {
    const fees = calculateFees(10_000, 10, 3.3);

    expect(fees.commission).toBe(1_000);
    expect(fees.paymentFee).toBe(330);
    expect(fees.total).toBe(1_330);
  });

  it("수수료율이 범위를 벗어나면 0~100%로 보정한다", () => {
    expect(calculateFees(10_000, 150, -5).total).toBe(10_000);
    expect(calculateFees(10_000, Number.NaN, 0).total).toBe(0);
  });
});

describe("calculateMargin", () => {
  it("기본 입력값에 대해 건당 순이익과 마진율을 계산한다", () => {
    const result = calculateMargin(baseInput);

    // 27,900 - (12,800 + 1,013 + 3,000 + 2,400 + 655) = 8,032
    expect(result.commission).toBe(1_013);
    expect(result.paymentFee).toBe(0);
    expect(result.expectedReturnLoss).toBe(655);
    expect(result.totalDeduction).toBe(19_868);
    expect(result.netProfitPerUnit).toBe(8_032);
    expect(result.marginRate).toBeCloseTo(28.79, 1);
  });

  it("반품률이 0이면 반품 손실도 0이다", () => {
    const result = calculateMargin({ ...baseInput, returnRate: 0 });

    expect(result.expectedReturnLoss).toBe(0);
    expect(result.netProfitPerUnit).toBe(baseInput.sellingPrice - result.totalDeduction);
  });

  it("월 매출과 월 순이익은 수량·고정비를 반영한다", () => {
    const result = calculateMargin(baseInput);

    expect(result.monthlyRevenue).toBe(10_602_000);
    expect(result.monthlyNetProfit).toBe(8_032 * 380 - 620_000);
    expect(result.monthlyMarginRate).toBeCloseTo(
      ((8_032 * 380 - 620_000) / 10_602_000) * 100,
      5,
    );
  });

  it("판매가가 0이면 마진율을 0으로 두고 0으로 나누지 않는다", () => {
    const result = calculateMargin({ ...baseInput, sellingPrice: 0 });

    expect(result.marginRate).toBe(0);
    expect(result.effectiveFeeRate).toBe(0);
    expect(result.monthlyRevenue).toBe(0);
    expect(result.netProfitPerUnit).toBeLessThan(0);
  });

  it("음수 입력은 0으로, 100%를 넘는 율은 100%로 보정한다", () => {
    const result = calculateMargin({
      ...baseInput,
      costPrice: -1_000,
      shippingCost: -500,
      adCostPerUnit: -100,
      returnRate: -20,
      commissionRate: 130,
      paymentRate: 120,
    });

    expect(result.productCost).toBe(0);
    expect(result.shippingCost).toBe(0);
    expect(result.adCost).toBe(0);
    expect(result.expectedReturnLoss).toBe(0);
    expect(result.commission).toBe(baseInput.sellingPrice);
    expect(result.paymentFee).toBe(baseInput.sellingPrice);
  });

  it("적자 조건에서는 월 순이익이 음수다", () => {
    const result = calculateMargin({ ...baseInput, sellingPrice: 15_000 });

    expect(result.netProfitPerUnit).toBeLessThan(0);
    expect(result.monthlyNetProfit).toBeLessThan(0);
  });
});

describe("손익분기점", () => {
  it("손익분기 판매가는 실제 적자 전환 지점과 원 단위 오차 안에서 일치한다", () => {
    const breakEven = calculateMargin(baseInput).breakEvenPrice;
    const atBreakEven = calculateMargin({ ...baseInput, sellingPrice: breakEven });

    expect(Number.isFinite(breakEven)).toBe(true);
    expect(atBreakEven.netProfitPerUnit).toBeGreaterThanOrEqual(0);

    // 수수료를 원 단위로 반올림하기 때문에, 이익이 처음 발생하는 가격은 BEP와 1~2원 차이날 수 있다.
    let firstProfitable = 0;
    for (let price = 0; price <= breakEven; price += 1) {
      if (calculateMargin({ ...baseInput, sellingPrice: price }).netProfitPerUnit >= 0) {
        firstProfitable = price;
        break;
      }
    }

    expect(breakEven - firstProfitable).toBeLessThanOrEqual(2);
    expect(
      calculateMargin({ ...baseInput, sellingPrice: firstProfitable - 1 }).netProfitPerUnit,
    ).toBeLessThan(0);
  });

  it("수수료율 합이 100%를 넘으면 손익분기 판매가는 Infinity다", () => {
    expect(computeBreakEvenPrice(10_000, 60, 55)).toBe(Number.POSITIVE_INFINITY);
    const result = calculateMargin({ ...baseInput, commissionRate: 60, paymentRate: 55 });

    expect(result.breakEvenPrice).toBe(Number.POSITIVE_INFINITY);
  });

  it("건당 이익이 0 이하이면 손익분기 판매량은 Infinity다", () => {
    const result = calculateMargin({ ...baseInput, sellingPrice: 10_000 });

    expect(result.breakEvenUnits).toBe(Number.POSITIVE_INFINITY);
  });

  it("고정비가 없으면 손익분기 판매량은 0건이다", () => {
    const result = calculateMargin({ ...baseInput, monthlyFixedCost: 0 });

    expect(result.breakEvenUnits).toBe(0);
  });

  it("손익분기 판매량을 팔면 월 순이익이 0 이상이 된다", () => {
    const result = calculateMargin(baseInput);
    const exactly = baseInput.monthlyFixedCost / result.netProfitPerUnit;

    expect(result.breakEvenUnits).toBe(Math.ceil(exactly));
    expect(result.breakEvenUnits * result.netProfitPerUnit).toBeGreaterThanOrEqual(
      baseInput.monthlyFixedCost,
    );
  });
});

describe("recommendSellingPrice", () => {
  it("권장 판매가에서는 목표 마진율을 확보한다", () => {
    const recommended = recommendSellingPrice(baseInput, 25);
    const result = calculateMargin({ ...baseInput, sellingPrice: recommended });

    expect(result.marginRate).toBeGreaterThanOrEqual(25);
    expect(result.marginRate).toBeLessThan(26.5);
  });

  it("목표 마진율이 수수료율과 합쳐 100%를 넘으면 Infinity다", () => {
    expect(recommendSellingPrice({ ...baseInput, commissionRate: 80 }, 30)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe("scoreKeyword", () => {
  it("기회 지수는 0~100 범위다", () => {
    const score = scoreKeyword(keywordRow).opportunityScore;

    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("경쟁이 낮고 구매 의도가 높을수록 점수가 높다", () => {
    const easy = scoreKeyword({ ...keywordRow, competition: 10, purchaseIntent: 95 });
    const hard = scoreKeyword({ ...keywordRow, competition: 95, purchaseIntent: 20 });

    expect(easy.opportunityScore).toBeGreaterThan(hard.opportunityScore);
    expect(easy.grade).toBe("진입 추천");
  });

  it("등급은 점수 구간에 따라 결정된다", () => {
    const grade = scoreKeyword(keywordRow).grade;

    expect(["진입 추천", "관찰", "회피"]).toContain(grade);
    expect(scoreKeyword({ ...keywordRow, monthlyVolume: 0, competition: 100, purchaseIntent: 0 }).grade).toBe(
      "회피",
    );
  });

  it("scoreKeywords는 기회 지수 내림차순으로 정렬한다", () => {
    const scored = scoreKeywords([
      { ...keywordRow, id: "a", competition: 90, purchaseIntent: 10 },
      { ...keywordRow, id: "b", competition: 10, purchaseIntent: 90 },
      { ...keywordRow, id: "c", competition: 50, purchaseIntent: 50 },
    ]);

    expect(scored.map((row) => row.id)).toEqual(["b", "c", "a"]);
  });
});

describe("표시 포맷", () => {
  it("원 단위 금액은 3자리 콤마로 표시한다", () => {
    expect(formatWon(27_900)).toBe("27,900원");
    expect(formatWon(-1_234)).toBe("-1,234원");
    expect(formatWon(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("큰 숫자는 만·억 단위로 축약한다", () => {
    expect(formatCompactNumber(9_500)).toBe("9,500");
    expect(formatCompactNumber(48_000)).toBe("4.8만");
    expect(formatCompactNumber(120_000)).toBe("12만");
    expect(formatCompactNumber(120_000_000)).toBe("1.2억");
  });

  it("율은 지정한 자릿수로 반올림한다", () => {
    expect(formatPercent(28.7885)).toBe("28.8%");
    expect(formatPercent(3.63, 2)).toBe("3.63%");
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe("—");
  });
});
