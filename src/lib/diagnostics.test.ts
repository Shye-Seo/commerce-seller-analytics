import { describe, expect, it } from "vitest";
import { calculateMargin, recommendSellingPrice } from "./calculator";
import {
  CPS_CEILING_RATE,
  diagnoseMargin,
  RECOMMENDED_RETURN_RATE,
  TARGET_MARGIN_RATE,
} from "./diagnostics";
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

/** 입력값에서 특정 액션만 꺼내는 헬퍼 */
function action(diagnosis: ReturnType<typeof diagnoseMargin>, id: string) {
  const found = diagnosis.actions.find((item) => item.id === id);
  if (!found) throw new Error(`action ${id} not found`);
  return found;
}

describe("diagnoseMargin · 종합 점수", () => {
  it("점수는 0~100 범위이고 기본 조건은 우수 등급이다", () => {
    const diagnosis = diagnoseMargin(baseInput);

    expect(diagnosis.score).toBeGreaterThanOrEqual(0);
    expect(diagnosis.score).toBeLessThanOrEqual(100);
    expect(diagnosis.score).toBeGreaterThanOrEqual(80);
    expect(diagnosis.grade).toBe("우수");
  });

  it("점수는 가중치 합 100으로 구성되고 네 축을 모두 평가한다", () => {
    const diagnosis = diagnoseMargin(baseInput);

    expect(diagnosis.scoreBreakdown).toHaveLength(4);
    expect(diagnosis.scoreBreakdown.reduce((sum, item) => sum + item.weight, 0)).toBe(100);
    expect(diagnosis.scoreBreakdown.map((item) => item.key)).toEqual([
      "margin",
      "ads",
      "returns",
      "coverage",
    ]);
  });

  it("적자 조건은 위험 등급이고 헤드라인이 손해를 알린다", () => {
    const diagnosis = diagnoseMargin({ ...baseInput, sellingPrice: 15_000 });

    expect(diagnosis.grade).toBe("위험");
    expect(diagnosis.headline).toContain("손해");
    expect(diagnosis.summary).toContain("적자");
  });

  it("마진율이 낮아질수록 점수도 낮아진다", () => {
    const good = diagnoseMargin(baseInput).score;
    const bad = diagnoseMargin({ ...baseInput, sellingPrice: 22_000 }).score;

    expect(bad).toBeLessThan(good);
  });

  it("NaN·음수·범위 초과 입력에도 예외 없이 0~100 점수를 만든다", () => {
    const diagnosis = diagnoseMargin({
      ...baseInput,
      costPrice: Number.NaN,
      sellingPrice: -1_000,
      adCostPerUnit: -300,
      returnRate: 400,
      monthlyUnits: Number.NaN,
      monthlyFixedCost: -50_000,
      commissionRate: 150,
    });

    expect(Number.isFinite(diagnosis.score)).toBe(true);
    expect(diagnosis.score).toBeGreaterThanOrEqual(0);
    expect(diagnosis.score).toBeLessThanOrEqual(100);
    expect(diagnosis.actions).toHaveLength(4);
  });
});

describe("diagnoseMargin · 비용 구조 비율", () => {
  it("여섯 개 비용 항목의 판매가 대비 비율을 계산한다", () => {
    const diagnosis = diagnoseMargin(baseInput);
    const costRatio = Object.fromEntries(
      diagnosis.costRatios.map((item) => [item.key, item.ratio]),
    );

    expect(diagnosis.costRatios).toHaveLength(6);
    expect(costRatio.productCost).toBeCloseTo((12_800 / 27_900) * 100, 5);
    expect(costRatio.adCost).toBeCloseTo((2_400 / 27_900) * 100, 5);
    expect(costRatio.shippingCost).toBeCloseTo((3_000 / 27_900) * 100, 5);
  });

  it("권장 상한을 넘으면 상태가 watch/over로 바뀐다", () => {
    const diagnosis = diagnoseMargin({ ...baseInput, adCostPerUnit: 4_500 });
    const ad = diagnosis.costRatios.find((item) => item.key === "adCost");

    expect(ad?.ratio).toBeGreaterThan(CPS_CEILING_RATE);
    expect(ad?.status).not.toBe("ok");
  });

  it("판매가가 0이면 비율을 0으로 두고 0으로 나누지 않는다", () => {
    const diagnosis = diagnoseMargin({ ...baseInput, sellingPrice: 0 });

    expect(diagnosis.costRatios.every((item) => item.ratio === 0)).toBe(true);
  });
});

describe("diagnoseMargin · 액션 플랜", () => {
  it("항상 네 개의 액션을 CPS → 가격 → 손익분기 → 반품 순서로 만든다", () => {
    const diagnosis = diagnoseMargin(baseInput);

    expect(diagnosis.actions.map((item) => item.id)).toEqual([
      "cps",
      "pricing",
      "breakeven",
      "returns",
    ]);
  });

  it("CPS가 판매가의 10%를 넘으면 광고비 절감 처방과 금액을 제시한다", () => {
    const adCostPerUnit = 3_348; // 판매가 27,900의 12%
    const diagnosis = diagnoseMargin({ ...baseInput, adCostPerUnit });
    const cps = action(diagnosis, "cps");
    const expectedSaving = Math.round((adCostPerUnit - 27_900 * 0.1) * 380);

    expect(cps.impactKind).toBe("saving");
    expect(cps.impactMonthly).toBe(expectedSaving);
    expect(cps.detail).toContain("키워드");
    expect(cps.metric).toContain("12.0%");
  });

  it("판매가가 0원이면 CPS 비중을 계산하지 않고 입력을 요청한다", () => {
    const cps = action(diagnoseMargin({ ...baseInput, sellingPrice: 0 }), "cps");

    expect(cps.metric).toBe("CPS —");
    expect(cps.impactMonthly).toBe(0);
  });

  it("CPS가 상한을 크게 넘으면 즉시(critical) 액션으로 분류한다", () => {
    const diagnosis = diagnoseMargin({ ...baseInput, adCostPerUnit: 5_580 }); // 20%

    expect(action(diagnosis, "cps").priority).toBe("critical");
  });

  it("CPS가 상한 이내면 유지 액션과 광고 확대 여력을 보여 준다", () => {
    const cps = action(diagnoseMargin(baseInput), "cps");

    expect(cps.priority).toBe("maintain");
    expect(cps.impactKind).toBe("headroom");
    expect(cps.impactMonthly).toBe(Math.round((2_790 - 2_400) * 380));
  });

  it("목표 마진 판매가는 recommendSellingPrice와 같은 값을 쓴다", () => {
    const diagnosis = diagnoseMargin(baseInput);

    expect(diagnosis.targetPrice).toBe(recommendSellingPrice(baseInput, TARGET_MARGIN_RATE));
    expect(diagnosis.targetPrice).toBe(26_500);
  });

  it("현재 판매가가 목표가보다 낮으면 인상 처방과 월 추가 이익을 계산한다", () => {
    const input: MarginInput = { ...baseInput, sellingPrice: 24_000 };
    const diagnosis = diagnoseMargin(input);
    const pricing = action(diagnosis, "pricing");

    expect(diagnosis.targetPrice).toBeGreaterThan(24_000);
    expect(pricing.impactKind).toBe("upside");
    expect(pricing.impactMonthly).toBeGreaterThan(0);
    expect(pricing.title).toContain("인상");
  });

  it("이미 목표 마진을 넘겼으면 가격 인하 여력을 안내하고 금액 효과는 0이다", () => {
    const pricing = action(diagnoseMargin(baseInput), "pricing");

    expect(pricing.priority).toBe("maintain");
    expect(pricing.impactMonthly).toBe(0);
    expect(pricing.title).toContain("달성");
  });

  it("판매량이 손익분기 미만이면 부족분을 일평균으로 환산한다", () => {
    const diagnosis = diagnoseMargin({ ...baseInput, monthlyUnits: 40 });
    const breakeven = action(diagnosis, "breakeven");

    expect(breakeven.priority).toBe("critical");
    expect(breakeven.title).toContain("부족");
    expect(breakeven.detail).toContain("일평균");
  });

  it("판매량이 손익분기 이상이면 여력 배수와 회수 후 이익을 보여 준다", () => {
    const diagnosis = diagnoseMargin(baseInput);
    const breakeven = action(diagnosis, "breakeven");
    const breakEvenUnits = calculateMargin(baseInput).breakEvenUnits;
    const expected = (380 - breakEvenUnits) * 8_032;

    expect(breakeven.priority).toBe("maintain");
    expect(breakeven.impactKind).toBe("headroom");
    expect(breakeven.impactMonthly).toBe(expected);
  });

  it("반품률 1%p 개선 금액은 왕복 배송비와 원가 손실로 계산한다", () => {
    const diagnosis = diagnoseMargin(baseInput);
    const returns = action(diagnosis, "returns");
    // 0.01 × (3,000 × 2 + 12,800 × 0.1) × 380 = 0.01 × 7,280 × 380
    const expected = Math.round(0.01 * (6_000 + 1_280) * 380);

    expect(diagnosis.returnUpliftPerPoint).toBe(expected);
    expect(returns.impactMonthly).toBe(expected);
    expect(returns.impactKind).toBe("saving");
  });

  it("반품률이 권장선을 넘으면 권장 액션으로 올라간다", () => {
    expect(action(diagnoseMargin(baseInput), "returns").priority).toBe("recommended");
    expect(action(diagnoseMargin({ ...baseInput, returnRate: 20 }), "returns").priority).toBe(
      "critical",
    );
    expect(RECOMMENDED_RETURN_RATE).toBe(5);
  });

  it("반품률이 0이면 반품 손실 없음으로 안내한다", () => {
    const diagnosis = diagnoseMargin({ ...baseInput, returnRate: 0 });

    expect(action(diagnosis, "returns").impactMonthly).toBe(0);
    expect(action(diagnosis, "returns").impactKind).toBe("neutral");
  });

  it("월 판매량이 0이면 금액 효과는 0이지만 예외 없이 처방을 만든다", () => {
    const diagnosis = diagnoseMargin({ ...baseInput, monthlyUnits: 0 });

    expect(diagnosis.actions).toHaveLength(4);
    expect(diagnosis.actions.every((item) => Number.isFinite(item.impactMonthly))).toBe(true);
  });
});
