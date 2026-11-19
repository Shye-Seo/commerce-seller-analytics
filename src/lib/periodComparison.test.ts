import { describe, expect, it } from "vitest";
import {
  ANOMALY_META,
  type AnomalyCode,
  type ChannelSummary,
  type MarketChannel,
  type ReconciliationSummary,
} from "./reconciliationEngine";
import {
  CHANNEL_LABELS,
  comparePeriods,
  describeComparison,
  isValidMonth,
  monthGap,
  monthIndex,
  monthOf,
  percentChange,
  PeriodComparisonError,
  shiftMonth,
  toSnapshotSummary,
  type SnapshotSummary,
} from "./periodComparison";

function emptyCauseRecord(): Record<AnomalyCode, number> {
  const record = {} as Record<AnomalyCode, number>;
  for (const code of Object.keys(ANOMALY_META) as AnomalyCode[]) record[code] = 0;
  return record;
}

interface SummaryInput {
  totalRows?: number;
  flaggedRows?: number;
  matchedRate?: number;
  totalLeak?: number;
  loss?: Partial<Record<AnomalyCode, number>>;
  counts?: Partial<Record<AnomalyCode, number>>;
  channels?: Partial<Record<MarketChannel, { rows: number; leak: number }>>;
}

function summary(input: SummaryInput = {}): SnapshotSummary {
  const anomalyLoss = emptyCauseRecord();
  const anomalyCounts = emptyCauseRecord();
  for (const [code, amount] of Object.entries(input.loss ?? {})) {
    anomalyLoss[code as AnomalyCode] = amount ?? 0;
  }
  for (const [code, count] of Object.entries(input.counts ?? {})) {
    anomalyCounts[code as AnomalyCode] = count ?? 0;
  }
  const byChannel: ChannelSummary[] = (Object.entries(input.channels ?? {}) as [
    MarketChannel,
    { rows: number; leak: number },
  ][]).map(([channel, value]) => ({
    channel,
    rows: value.rows,
    paidAmount: value.rows * 10_000,
    settledAmount: value.rows * 9_000,
    leak: value.leak,
    flaggedRows: Math.round(value.rows / 10),
  }));

  return {
    totalRows: input.totalRows ?? 1_000,
    matchedRows: Math.round((input.totalRows ?? 1_000) * ((input.matchedRate ?? 80) / 100)),
    flaggedRows: input.flaggedRows ?? 200,
    matchedRate: input.matchedRate ?? 80,
    totalPaidAmount: 10_000_000,
    totalSettledAmount: 9_000_000,
    expectedSettlement: 9_100_000,
    totalLeak: input.totalLeak ?? 100_000,
    totalSurplus: 0,
    marginRiskExposure: 0,
    negativeMarginRows: 0,
    worstMarginRate: -4.2,
    anomalyCounts,
    anomalyLoss,
    byChannel,
  };
}

function fullSummary(input: SummaryInput = {}): ReconciliationSummary {
  return {
    ...summary(input),
    totalCommission: 500_000,
    topSkusByLoss: [{ sku: "SKU-1", productName: "테스트 상품", rows: 3, loss: 12_000 }],
  };
}

describe("월 문자열 유틸", () => {
  it("YYYY-MM 형식만 통과시킨다", () => {
    expect(isValidMonth("2026-11")).toBe(true);
    expect(isValidMonth("2026-13")).toBe(false);
    expect(isValidMonth("2026-1")).toBe(false);
    expect(isValidMonth("11-2026")).toBe(false);
    expect(isValidMonth("")).toBe(false);
  });

  it("연 경계를 넘어 월을 이동한다", () => {
    expect(shiftMonth("2026-11", -1)).toBe("2026-10");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-11", -14)).toBe("2025-09");
  });

  it("월 인덱스와 간격이 연속된 달을 1로 센다", () => {
    expect(monthIndex("2026-11") - monthIndex("2026-10")).toBe(1);
    expect(monthIndex("2027-01") - monthIndex("2026-12")).toBe(1);
    expect(monthGap("2026-09", "2026-11")).toBe(2);
    expect(monthGap("2026-11", "2026-09")).toBe(-2);
  });

  it("날짜에서 월을 뽑고, 해석할 수 없으면 오류를 낸다", () => {
    expect(monthOf("2026-11-19T10:00:00Z")).toBe("2026-11");
    expect(monthOf(new Date(2026, 0, 5))).toBe("2026-01");
    expect(() => monthOf("not-a-date")).toThrow(PeriodComparisonError);
  });
});

describe("요약 스냅숏", () => {
  it("비교에 필요한 값만 남기고 사본을 만든다", () => {
    const snapshot = toSnapshotSummary(fullSummary({ loss: { FEE_OVERCHARGE: 4_000 } }));
    expect(snapshot.totalLeak).toBe(100_000);
    expect(snapshot.anomalyLoss.FEE_OVERCHARGE).toBe(4_000);
    expect(Object.keys(snapshot)).not.toContain("topSkusByLoss");

    // 사본이므로 원본을 바꿔도 스냅숏은 그대로다
    const source = fullSummary();
    const copy = toSnapshotSummary(source);
    source.totalLeak = 1;
    expect(copy.totalLeak).toBe(100_000);
  });
});

describe("두 달 비교", () => {
  it("누수·정상 대사율·건수의 증감을 계산한다", () => {
    const previous = {
      month: "2026-10",
      summary: summary({ totalLeak: 400_000, matchedRate: 74.5, totalRows: 1_200, flaggedRows: 300 }),
    };
    const current = {
      month: "2026-11",
      summary: summary({ totalLeak: 300_000, matchedRate: 82.6, totalRows: 1_000, flaggedRows: 174 }),
    };

    const result = comparePeriods(previous, current, { tenantId: "tn-hq" });
    expect(result.previousMonth).toBe("2026-10");
    expect(result.currentMonth).toBe("2026-11");
    expect(result.monthGap).toBe(1);
    expect(result.consecutive).toBe(true);
    expect(result.tenantId).toBe("tn-hq");
    expect(result.leak.delta).toBe(-100_000);
    expect(result.leak.deltaPct).toBe(-25);
    expect(result.leak.sign).toBe(-1);
    expect(result.matchedRate.delta).toBe(8.1);
    expect(result.rows.delta).toBe(-200);
    expect(result.flagged.delta).toBe(-126);
  });

  it("이전 값이 0이면 증감률을 만들지 않는다", () => {
    const previous = { month: "2026-10", summary: summary({ totalLeak: 0 }) };
    const current = { month: "2026-11", summary: summary({ totalLeak: 50_000 }) };
    const result = comparePeriods(previous, current);
    expect(result.leak.delta).toBe(50_000);
    expect(result.leak.deltaPct).toBeNull();
    expect(percentChange(0, 10)).toBeNull();
    expect(percentChange(200, 50)).toBe(25);
  });

  it("두 달 모두 누수가 0이면 변화 없음(0)으로 둔다", () => {
    const same = { month: "2026-10", summary: summary({ totalLeak: 0 }) };
    const current = { month: "2026-11", summary: summary({ totalLeak: 0 }) };
    const result = comparePeriods(same, current);
    expect(result.leak.sign).toBe(0);
    expect(result.driver).toBeNull();
    expect(describeComparison(result)).toContain("두 달 모두");
  });

  it("원인별 상태를 신규·해소·악화·개선·변화 없음으로 나눈다", () => {
    const previous = {
      month: "2026-10",
      summary: summary({
        loss: {
          FEE_OVERCHARGE: 20_000,
          RETURN_FEE_DOUBLE_CHARGED: 30_000,
          SHIPPING_OVERCHARGE: 5_000,
          ROUNDING_LEAK: 1_000,
        },
        counts: {
          FEE_OVERCHARGE: 8,
          RETURN_FEE_DOUBLE_CHARGED: 6,
          SHIPPING_OVERCHARGE: 2,
          ROUNDING_LEAK: 3,
        },
      }),
    };
    const current = {
      month: "2026-11",
      summary: summary({
        loss: {
          FEE_OVERCHARGE: 45_000,
          SHIPPING_OVERCHARGE: 9_000,
          ROUNDING_LEAK: 1_000,
          SETTLEMENT_SHORTFALL: 7_500,
        },
        counts: {
          FEE_OVERCHARGE: 14,
          SHIPPING_OVERCHARGE: 3,
          ROUNDING_LEAK: 3,
          SETTLEMENT_SHORTFALL: 2,
        },
      }),
    };

    const result = comparePeriods(previous, current);
    const byCode = new Map(result.causes.map((cause) => [cause.code, cause]));

    expect(byCode.get("FEE_OVERCHARGE")?.status).toBe("worse");
    expect(byCode.get("FEE_OVERCHARGE")?.deltaLoss).toBe(25_000);
    expect(byCode.get("FEE_OVERCHARGE")?.deltaCount).toBe(6);
    expect(byCode.get("RETURN_FEE_DOUBLE_CHARGED")?.status).toBe("resolved");
    expect(byCode.get("RETURN_FEE_DOUBLE_CHARGED")?.deltaPct).toBe(-100);
    expect(byCode.get("SETTLEMENT_SHORTFALL")?.status).toBe("new");
    expect(byCode.get("SETTLEMENT_SHORTFALL")?.deltaPct).toBeNull();
    expect(byCode.get("ROUNDING_LEAK")?.status).toBe("flat");

    expect(result.newCauses.map((cause) => cause.code)).toEqual(["SETTLEMENT_SHORTFALL"]);
    expect(result.resolvedCauses.map((cause) => cause.code)).toEqual(["RETURN_FEE_DOUBLE_CHARGED"]);
    // 움직임이 큰 순서: 반품비 중복(-30,000) → 수수료 초과(+25,000) → 배송비(+4,000) → 신규(+7,500)
    expect(result.causes[0]?.code).toBe("RETURN_FEE_DOUBLE_CHARGED");
    expect(result.causes[1]?.code).toBe("FEE_OVERCHARGE");
    expect(result.driver?.code).toBe("RETURN_FEE_DOUBLE_CHARGED");
  });

  it("양쪽 모두 0인 원인은 표에서 뺀다", () => {
    const previous = { month: "2026-10", summary: summary({ loss: { FEE_OVERCHARGE: 1_000 } }) };
    const current = { month: "2026-11", summary: summary({ loss: { FEE_OVERCHARGE: 2_000 } }) };
    const result = comparePeriods(previous, current);
    expect(result.causes).toHaveLength(1);
    expect(result.causes[0]?.code).toBe("FEE_OVERCHARGE");
  });

  it("같은 값이면 항상 같은 순서가 나온다", () => {
    const previous = {
      month: "2026-10",
      summary: summary({ loss: { FEE_OVERCHARGE: 10_000, SHIPPING_OVERCHARGE: 10_000 } }),
    };
    const current = {
      month: "2026-11",
      summary: summary({ loss: { FEE_OVERCHARGE: 10_000, SHIPPING_OVERCHARGE: 10_000 } }),
    };
    const first = comparePeriods(previous, current).causes.map((cause) => cause.code);
    const second = comparePeriods(previous, current).causes.map((cause) => cause.code);
    expect(first).toEqual(second);
    // 증감이 같으면 현재 금액 → 코드 알파벳 순으로 결정된다
    expect(first).toEqual(["FEE_OVERCHARGE", "SHIPPING_OVERCHARGE"]);
  });

  it("채널 비교는 네 채널을 항상 같은 순서로 보여 준다", () => {
    const previous = {
      month: "2026-10",
      summary: summary({ channels: { smartstore: { rows: 100, leak: 10_000 }, coupang: { rows: 50, leak: 5_000 } } }),
    };
    const current = {
      month: "2026-11",
      summary: summary({ channels: { smartstore: { rows: 120, leak: 4_000 }, gmarket: { rows: 10, leak: 1_000 } } }),
    };
    const result = comparePeriods(previous, current);
    expect(result.channels.map((entry) => entry.channel)).toEqual([
      "smartstore",
      "coupang",
      "elevenst",
      "gmarket",
    ]);
    const smartstore = result.channels[0];
    expect(smartstore?.label).toBe(CHANNEL_LABELS.smartstore);
    expect(smartstore?.deltaLeak).toBe(-6_000);
    expect(result.channels[1]?.deltaLeak).toBe(-5_000);
    expect(result.channels[2]?.deltaLeak).toBe(0);
    expect(result.channels[3]?.deltaLeak).toBe(1_000);
  });

  it("연속되지 않은 달도 비교하되 간격을 표시한다", () => {
    const previous = { month: "2026-08", summary: summary({ totalLeak: 200_000 }) };
    const current = { month: "2026-11", summary: summary({ totalLeak: 100_000 }) };
    const result = comparePeriods(previous, current);
    expect(result.monthGap).toBe(3);
    expect(result.consecutive).toBe(false);
  });

  it("같은 달이나 뒤집힌 순서는 계산하지 않고 오류를 낸다", () => {
    const october = { month: "2026-10", summary: summary() };
    const november = { month: "2026-11", summary: summary() };
    expect(() => comparePeriods(october, october)).toThrow(PeriodComparisonError);
    expect(() => comparePeriods(november, october)).toThrow(PeriodComparisonError);
    try {
      comparePeriods(november, october);
    } catch (error) {
      expect((error as PeriodComparisonError).code).toBe("MONTH_ORDER");
    }
  });

  it("금액 증감은 원 단위 정수로 떨어진다", () => {
    const previous = { month: "2026-10", summary: summary({ totalLeak: 10_000.4 }) };
    const current = { month: "2026-11", summary: summary({ totalLeak: 10_000.9 }) };
    const result = comparePeriods(previous, current);
    expect(Number.isInteger(result.leak.delta)).toBe(true);
    expect(result.leak.delta).toBe(1);
  });
});

describe("한 줄 요약", () => {
  it("증가·감소와 가장 크게 움직인 원인을 문장으로 만든다", () => {
    const previous = {
      month: "2026-10",
      summary: summary({ totalLeak: 200_000, loss: { FEE_OVERCHARGE: 50_000 } }),
    };
    const current = {
      month: "2026-11",
      summary: summary({ totalLeak: 250_000, loss: { FEE_OVERCHARGE: 90_000 } }),
    };
    const text = describeComparison(comparePeriods(previous, current));
    expect(text).toContain("2026-10 대비");
    expect(text).toContain("증가");
    expect(text).toContain("25.0%");
    expect(text).toContain("수수료 초과");
    expect(text).not.toContain("혁신");
  });

  it("변화가 없으면 증감률 없이 같은 값이라고 말한다", () => {
    const previous = { month: "2026-10", summary: summary({ totalLeak: 100_000 }) };
    const current = { month: "2026-11", summary: summary({ totalLeak: 100_000 }) };
    expect(describeComparison(comparePeriods(previous, current))).toContain("같습니다");
  });
});
