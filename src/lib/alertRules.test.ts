import { describe, expect, it } from "vitest";
import {
  ALERT_RULE_LIST,
  addBusinessDays,
  buildSettlementReceipts,
  calendarDaysBetween,
  composeRuleAlertPreview,
  defaultAlertRules,
  evaluateAlertRules,
  normalizeAlertRule,
  type AlertRuleConfig,
  type CouponCost,
} from "./alertRules";
import { reconcileRow, type SettlementRow } from "./reconciliationEngine";

function row(overrides: Partial<SettlementRow> = {}) {
  const base: SettlementRow = {
    orderNo: "SS0001",
    channel: "smartstore",
    orderDate: "2026-11-02",
    productName: "소이 캔들 200g · 우드윅",
    sku: "SG-CANDLE-01",
    quantity: 1,
    paidAmount: 27_900,
    commission: 1_013,
    shippingDeduction: 3_000,
    returnFee: 0,
    settledAmount: 23_887,
    contractFeeRate: 3.63,
    unitCost: 12_800,
    sellerShippingCost: 2_800,
    status: "배송완료",
  };
  return reconcileRow({ ...base, ...overrides });
}

const SNAPSHOT = "2026-11-20";

function withThreshold(
  id: AlertRuleConfig["id"],
  threshold: number,
  enabled = true,
): AlertRuleConfig {
  return { id, enabled, threshold };
}

function rules(...items: AlertRuleConfig[]): AlertRuleConfig[] {
  return ALERT_RULE_LIST.map((meta) => {
    const override = items.find((item) => item.id === meta.id);
    return override ?? { id: meta.id, enabled: false, threshold: meta.defaultThreshold };
  });
}

describe("영업일 · 달력일", () => {
  it("토·일을 건너뛰고 D+n 영업일을 계산한다", () => {
    // 2026-11-06(금) + 3영업일 → 11-11(수)
    expect(addBusinessDays("2026-11-06", 3)).toBe("2026-11-11");
    // 주말 기산은 다음 영업일부터 센다: 2026-11-07(토) + 1 → 11-09(월)
    expect(addBusinessDays("2026-11-07", 1)).toBe("2026-11-09");
    expect(addBusinessDays("2026-11-02", 0)).toBe("2026-11-02");
  });

  it("지연일은 달력일로 센다", () => {
    expect(calendarDaysBetween("2026-11-13", "2026-11-18")).toBe(5);
    expect(calendarDaysBetween("2026-11-18", "2026-11-13")).toBe(0);
    expect(calendarDaysBetween("잘못된 날짜", "2026-11-18")).toBe(0);
  });
});

describe("buildSettlementReceipts", () => {
  it("같은 정산서면 항상 같은 입금일을 만든다", () => {
    const rows = [row({ orderNo: "SS-A" }), row({ orderNo: "CP-B", channel: "coupang" })];
    const first = buildSettlementReceipts(rows, SNAPSHOT);
    const second = buildSettlementReceipts(rows, SNAPSHOT);

    expect(second).toEqual(first);
    expect(first).toHaveLength(2);
  });

  it("정산 예정일은 마켓 주기(영업일)를 따르고, 미래 입금은 미입금으로 둔다", () => {
    const receipts = buildSettlementReceipts(
      [row({ orderNo: "SS-1", orderDate: "2026-11-02", channel: "smartstore" })],
      SNAPSHOT,
    );
    const receipt = receipts[0]!;

    // 스마트스토어 D+3 영업일: 11-02(월) → 11-05(목)
    expect(receipt.dueDate).toBe("2026-11-05");
    if (receipt.receivedDate) {
      expect(receipt.receivedDate >= receipt.dueDate).toBe(true);
      expect(receipt.receivedDate <= SNAPSHOT).toBe(true);
    } else {
      expect(receipt.delayDays).toBe(calendarDaysBetween(receipt.dueDate, SNAPSHOT));
    }
  });

  it("입금일이 기준일을 넘으면 미입금으로 계산한다", () => {
    const receipts = buildSettlementReceipts(
      [row({ orderNo: "SS-LATE", orderDate: "2026-11-19" })],
      SNAPSHOT,
    );
    expect(receipts[0]!.receivedDate).toBeNull();
  });
});

describe("evaluateAlertRules · 수수료율", () => {
  it("계약보다 임계값 이상 높은 실효 수수료율만 잡는다", () => {
    const clean = row({ orderNo: "SS-CLEAN" });
    const over = row({ orderNo: "SS-OVER", commission: 1_700, settledAmount: 23_200 });

    const kept = evaluateAlertRules({
      rows: [clean, over],
      rules: rules(withThreshold("fee-step", 1)),
      snapshotDate: SNAPSHOT,
    });
    const fee = kept.results.find((result) => result.id === "fee-step")!;

    expect(fee.rowsAffected).toBe(1);
    expect(fee.hits[0]!.orderNo).toBe("SS-OVER");
    expect(fee.hits[0]!.metric).toBeCloseTo(2.46, 2);
    expect(fee.hits[0]!.amountAtRisk).toBeGreaterThan(0);
  });

  it("임계값을 올리면 같은 데이터에서 위반이 줄어든다", () => {
    const rows = [
      row({ orderNo: "SS-1", commission: 1_300, settledAmount: 23_600 }),
      row({ orderNo: "SS-2", commission: 1_700, settledAmount: 23_200 }),
    ];
    const low = evaluateAlertRules({ rows, rules: rules(withThreshold("fee-step", 0.5)), snapshotDate: SNAPSHOT });
    const high = evaluateAlertRules({ rows, rules: rules(withThreshold("fee-step", 3.5)), snapshotDate: SNAPSHOT });

    expect(low.results.find((result) => result.id === "fee-step")!.rowsAffected).toBe(2);
    expect(high.results.find((result) => result.id === "fee-step")!.rowsAffected).toBe(0);
  });

  it("룰을 끄면 위반이 0건이 되고 행 인덱스에서도 빠진다", () => {
    const rows = [row({ commission: 1_700, settledAmount: 23_200 })];
    const off = evaluateAlertRules({
      rows,
      rules: rules(withThreshold("fee-step", 1, false)),
      snapshotDate: SNAPSHOT,
    });

    expect(off.results.find((result) => result.id === "fee-step")!.enabled).toBe(false);
    expect(off.hits).toHaveLength(0);
    expect(off.rowIndex).toEqual({});
  });
});

describe("evaluateAlertRules · 정산 지연", () => {
  it("입금일이 없으면 평가하지 않고 사유를 남긴다", () => {
    const result = evaluateAlertRules({
      rows: [row()],
      rules: rules(withThreshold("settlement-delay", 3)),
      receipts: null,
      snapshotDate: SNAPSHOT,
    });
    const delay = result.results.find((item) => item.id === "settlement-delay")!;

    expect(delay.rowsAffected).toBe(0);
    expect(delay.skippedReason).toContain("정산 입금일");
  });

  it("예정일에서 임계값 이상 밀린 건만 잡고, 미입금은 금액 전체를 노출로 센다", () => {
    const rows = [row({ orderNo: "SS-DELAY" }), row({ orderNo: "SS-OK" })];
    const receipts = [
      { orderNo: "SS-DELAY", channel: "smartstore" as const, dueDate: "2026-11-05", receivedDate: "2026-11-09", delayDays: 4 },
      { orderNo: "SS-OK", channel: "smartstore" as const, dueDate: "2026-11-05", receivedDate: "2026-11-06", delayDays: 1 },
    ];
    const result = evaluateAlertRules({
      rows,
      rules: rules(withThreshold("settlement-delay", 3)),
      receipts,
      snapshotDate: SNAPSHOT,
    });
    const delay = result.results.find((item) => item.id === "settlement-delay")!;

    expect(delay.rowsAffected).toBe(1);
    expect(delay.hits[0]!.orderNo).toBe("SS-DELAY");
    expect(delay.hits[0]!.detail).toContain("11-05");
    expect(delay.hits[0]!.amountAtRisk).toBe(0);
  });

  it("미입금 건은 정산액을 노출 금액으로 잡는다", () => {
    const rows = [row({ orderNo: "SS-PENDING" })];
    const receipts = [
      { orderNo: "SS-PENDING", channel: "smartstore" as const, dueDate: "2026-11-05", receivedDate: null, delayDays: 15 },
    ];
    const result = evaluateAlertRules({
      rows,
      rules: rules(withThreshold("settlement-delay", 3)),
      receipts,
      snapshotDate: SNAPSHOT,
    });
    const hit = result.results.find((item) => item.id === "settlement-delay")!.hits[0]!;

    expect(hit.actual).toBe(0);
    expect(hit.amountAtRisk).toBe(23_887);
    expect(hit.detail).toContain("미입금");
  });
});

describe("evaluateAlertRules · 쿠폰 부담률", () => {
  it("우리 부담 쿠폰 비용이 결제금액 대비 임계값을 넘는 주문만 잡는다", () => {
    const rows = [row({ orderNo: "SS-COUPON", paidAmount: 20_000, commission: 726, settledAmount: 16_274 })];
    const costs = new Map<string, CouponCost>([
      ["SS-COUPON", { ourCost: 3_000, paidAmount: 20_000 }],
    ]);
    const result = evaluateAlertRules({
      rows,
      rules: rules(withThreshold("coupon-burden", 8)),
      couponCosts: costs,
      snapshotDate: SNAPSHOT,
    });
    const coupon = result.results.find((item) => item.id === "coupon-burden")!;

    expect(coupon.rowsAffected).toBe(1);
    expect(coupon.hits[0]!.metric).toBe(15);
    expect(coupon.hits[0]!.amountAtRisk).toBe(1_400); // 3,000 - 허용 1,600
  });

  it("쿠폰 원장이 없으면 0건이고 위반이 생기지 않는다", () => {
    const result = evaluateAlertRules({
      rows: [row()],
      rules: rules(withThreshold("coupon-burden", 8)),
      couponCosts: new Map(),
      snapshotDate: SNAPSHOT,
    });
    expect(result.results.find((item) => item.id === "coupon-burden")!.rowsAffected).toBe(0);
  });
});

describe("evaluateAlertRules · 공통", () => {
  it("행 인덱스에 걸린 룰을 모으고 위험 금액 내림차순으로 정렬한다", () => {
    const rows = [
      row({ orderNo: "SS-1", commission: 1_700, settledAmount: 23_200 }),
      row({ orderNo: "SS-2", commission: 2_600, settledAmount: 22_300 }),
    ];
    const result = evaluateAlertRules({
      rows,
      rules: rules(withThreshold("fee-step", 1)),
      snapshotDate: SNAPSHOT,
    });

    expect(Object.keys(result.rowIndex)).toHaveLength(2);
    expect(Object.values(result.rowIndex).every((ids) => ids.includes("fee-step"))).toBe(true);
    expect(result.hits[0]!.amountAtRisk).toBeGreaterThanOrEqual(result.hits[1]!.amountAtRisk);
    expect(result.enabledCount).toBe(1);
    expect(result.results).toHaveLength(3);
  });

  it("임계값을 메타 범위로 보정하고 기본값은 메타 기본값을 쓴다", () => {
    expect(normalizeAlertRule({ id: "fee-step", enabled: true, threshold: 99 })).toEqual({
      id: "fee-step",
      enabled: true,
      threshold: 10,
    });
    expect(normalizeAlertRule({ id: "fee-step", enabled: true, threshold: Number.NaN }).threshold).toBe(1);
    expect(defaultAlertRules()).toHaveLength(3);
    expect(defaultAlertRules().every((rule) => rule.enabled)).toBe(true);
  });
});

describe("composeRuleAlertPreview", () => {
  it("기존 알림톡 템플릿 형식에 룰 이름과 주문 근거를 채운다", () => {
    const result = evaluateAlertRules({
      rows: [row({ orderNo: "SS-OVER", commission: 1_700, settledAmount: 23_200 })],
      rules: rules(withThreshold("fee-step", 1)),
      snapshotDate: SNAPSHOT,
    });
    const preview = composeRuleAlertPreview(result.hits[0]!);

    expect(preview).toContain("정산 이상 감지");
    expect(preview).toContain("SS-OVER");
    expect(preview).toContain("수수료율 +1%p 초과");
    expect(preview.length).toBeLessThanOrEqual(1_000);
  });
});
