import { describe, expect, it } from "vitest";
import { buildDemoHistory, monthEndDate } from "./demoMonthHistory";
import { comparePeriods, toSnapshotSummary } from "./periodComparison";
import { reconcileSettlement } from "./reconciliationEngine";
import { generateSettlementRows } from "./settlementFixtures";

describe("데모 지난 2개월", () => {
  it("이번 달 기준 두 달 전·지난달을 만든다", () => {
    const history = buildDemoHistory("tn-hq", "2026-11", { rows: 200 });
    expect(history.map((entry) => entry.month)).toEqual(["2026-09", "2026-10"]);
    expect(history.every((entry) => entry.source === "demo")).toBe(true);
    expect(history.every((entry) => entry.tenantId === "tn-hq")).toBe(true);
    expect(history[0]?.label).toContain("데모 샘플");
  });

  it("같은 입력이면 같은 요약이 나온다(고정 시드)", () => {
    const first = buildDemoHistory("tn-hq", "2026-11", { rows: 200 });
    const second = buildDemoHistory("tn-hq", "2026-11", { rows: 200 });
    expect(first.map((entry) => entry.summary.totalLeak)).toEqual(second.map((entry) => entry.summary.totalLeak));
  });

  it("테넌트가 다르면 다른 원장이 나온다", () => {
    const hq = buildDemoHistory("tn-hq", "2026-11", { rows: 200 });
    const busan = buildDemoHistory("tn-busan", "2026-11", { rows: 200 });
    expect(hq[0]?.summary.totalLeak).not.toBe(busan[0]?.summary.totalLeak);
  });

  it("두 달 모두 실제 대사 엔진을 통과한 값이다", () => {
    const rows = 200;
    const history = buildDemoHistory("tn-hq", "2026-11", { rows });
    for (const entry of history) {
      expect(entry.summary.totalRows).toBeGreaterThan(0);
      expect(entry.summary.totalRows).toBeLessThanOrEqual(rows);
      expect(entry.summary.totalLeak).toBeGreaterThan(0);
      expect(entry.summary.flaggedRows).toBeGreaterThan(0);
    }
  });

  it("두 달 전 → 지난달 비교가 계산된다(반품비 중복은 줄고 수수료 초과는 는다)", () => {
    const history = buildDemoHistory("tn-hq", "2026-11", { rows: 600 });
    const twoAgo = history.find((entry) => entry.month === "2026-09");
    const lastMonth = history.find((entry) => entry.month === "2026-10");
    expect(twoAgo && lastMonth).toBeTruthy();
    if (!twoAgo || !lastMonth) return;

    const comparison = comparePeriods(
      { month: twoAgo.month, summary: twoAgo.summary },
      { month: lastMonth.month, summary: lastMonth.summary },
    );
    expect(comparison.consecutive).toBe(true);
    const byCode = new Map(comparison.causes.map((cause) => [cause.code, cause]));
    expect(byCode.get("RETURN_FEE_DOUBLE_CHARGED")?.deltaLoss).toBeLessThan(0);
    expect(byCode.get("FEE_OVERCHARGE")?.deltaLoss).toBeGreaterThan(0);
  });

  it("말일 계산이 윤년·월말을 맞춘다", () => {
    expect(monthEndDate("2026-02")).toBe("2026-02-28");
    expect(monthEndDate("2024-02")).toBe("2024-02-29");
    expect(monthEndDate("2026-11")).toBe("2026-11-30");
  });
});

describe("실제 대사 결과와 비교", () => {
  it("이번 달 실데이터 스냅숏과 지난달 샘플을 비교할 수 있다", () => {
    const history = buildDemoHistory("tn-hq", "2026-11", { rows: 300 });
    const lastMonth = history[1];
    expect(lastMonth).toBeTruthy();
    if (!lastMonth) return;

    const currentRows = generateSettlementRows({ count: 300, seed: 20261119, snapshotDate: "2026-11-30", windowDays: 30 });
    const current = reconcileSettlement(currentRows);
    const comparison = comparePeriods(
      { month: lastMonth.month, summary: lastMonth.summary },
      { month: "2026-11", summary: toSnapshotSummary(current.summary) },
    );
    expect(comparison.monthGap).toBe(1);
    expect(Number.isInteger(comparison.leak.delta)).toBe(true);
  });
});
