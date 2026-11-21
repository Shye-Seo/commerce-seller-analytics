import { describe, expect, it } from "vitest";
import {
  RISK_AFTER_DAYS,
  WATCH_SNAPSHOT_DATE,
  composeWatchDigest,
  computeSettlementWatch,
  expectedSettlementAmount,
  filterWatchItems,
  judgeOrder,
  settlementDueDate,
  type SettlementRecord,
  type WatchOrder,
} from "./settlementWatch";
import { generateWatchLedger } from "./settlementWatchData";
import { MARKET_PRESETS } from "./calculator";

const order: WatchOrder = {
  orderNo: "SS-20261110-1001",
  channel: "smartstore",
  productName: "울 블렌드 케이프 코트",
  optionName: "차콜 / FREE",
  paidAmount: 128_000,
  confirmedAt: "2026-11-10",
};

describe("정산 기한 계산", () => {
  it("마켓 정산 기한은 영업일 기준이다(주말 제외)", () => {
    // 2026-11-20은 금요일. 스마트스토어 D+3이면 월(23)·화(24)·수(25).
    expect(MARKET_PRESETS.smartstore.settlementDays).toBe(3);
    expect(settlementDueDate("2026-11-20", "smartstore")).toBe("2026-11-25");
    // 쿠팡은 D+7 영업일이다.
    expect(settlementDueDate("2026-11-20", "coupang")).toBe("2026-12-01");
  });

  it("예상 정산액은 마켓 수수료·결제 수수료를 뺀 값이다", () => {
    const preset = MARKET_PRESETS.coupang;
    const expected = expectedSettlementAmount(100_000, "coupang");
    expect(expected).toBe(Math.round(100_000 * (1 - (preset.commissionRate + preset.paymentRate) / 100)));
    expect(expected).toBeLessThan(100_000);
  });
});

describe("주문 판정", () => {
  it("기한이 3일 이상 지났는데 정산 내역이 없으면 위험이다", () => {
    const item = judgeOrder(order, null, "2026-11-21");
    // 11-10(화) + 3영업일 = 11-13(금) → 21일까지 8일 경과
    expect(item.dueDate).toBe("2026-11-13");
    expect(item.overdueDays).toBe(8);
    expect(item.status).toBe("risk");
    expect(item.shortfall).toBe(item.expectedAmount);
    expect(item.reason).toContain("정산 내역이 없습니다");
  });

  it("기한이 1~2일 지난 누락은 경고, 아직 기한 전이면 대기다", () => {
    const warning = judgeOrder(order, null, "2026-11-14");
    expect(warning.status).toBe("warning");
    expect(warning.overdueDays).toBe(1);

    const pending = judgeOrder({ ...order, confirmedAt: "2026-11-19" }, null, "2026-11-21");
    expect(pending.status).toBe("pending");
    expect(pending.overdueDays).toBe(0);
    expect(pending.reason).toContain("남았습니다");
  });

  it("예정으로만 잡혀 있고 기한이 지나면 경고다", () => {
    const record: SettlementRecord = {
      orderNo: order.orderNo,
      state: "scheduled",
      amount: expectedSettlementAmount(order.paidAmount, "smartstore"),
    };
    const item = judgeOrder(order, record, "2026-11-21");
    expect(item.status).toBe("warning");
    expect(item.settlementState).toBe("scheduled");
  });

  it("정산 금액이 예상보다 부족하면 경고와 부족액을 남긴다", () => {
    const expected = expectedSettlementAmount(order.paidAmount, "smartstore");
    const record: SettlementRecord = {
      orderNo: order.orderNo,
      state: "paid",
      amount: expected - 15_000,
      paidAt: "2026-11-13",
    };
    const item = judgeOrder(order, record, "2026-11-21");
    expect(item.status).toBe("warning");
    expect(item.shortfall).toBe(15_000);
    expect(item.reason).toContain("부족");
  });

  it("금액이 맞아도 예정일보다 늦게 들어오면 지연 경고다", () => {
    const expected = expectedSettlementAmount(order.paidAmount, "smartstore");
    const record: SettlementRecord = {
      orderNo: order.orderNo,
      state: "paid",
      amount: expected,
      paidAt: "2026-11-17",
    };
    const item = judgeOrder(order, record, "2026-11-21");
    expect(item.status).toBe("warning");
    expect(item.shortfall).toBe(0);
    expect(item.reason).toContain("늦게 입금");
  });

  it("기한 안에 정확히 들어오면 정상이다", () => {
    const expected = expectedSettlementAmount(order.paidAmount, "smartstore");
    const record: SettlementRecord = {
      orderNo: order.orderNo,
      state: "paid",
      amount: expected,
      paidAt: "2026-11-13",
    };
    const item = judgeOrder(order, record, "2026-11-21");
    expect(item.status).toBe("ok");
    expect(item.overdueDays).toBe(8);
    expect(item.reason).toContain("정상 정산");
  });

  it("금액 오차 1% 이내는 반올림 오차로 보고 정상 처리한다", () => {
    const expected = expectedSettlementAmount(order.paidAmount, "smartstore");
    const record: SettlementRecord = {
      orderNo: order.orderNo,
      state: "paid",
      amount: expected - Math.floor(expected * 0.005),
      paidAt: "2026-11-13",
    };
    expect(judgeOrder(order, record, "2026-11-21").status).toBe("ok");
  });
});

describe("감시 집계", () => {
  const orders: WatchOrder[] = [
    order, // 위험 (기한 8일 경과, 내역 없음)
    { ...order, orderNo: "SS-20261119-1002", confirmedAt: "2026-11-19" }, // 대기
    { ...order, orderNo: "CP-20261105-1003", channel: "coupang", paidAmount: 89_000, confirmedAt: "2026-11-05" },
    { ...order, orderNo: "EL-20261112-1004", channel: "elevenst", paidAmount: 54_000, confirmedAt: "2026-11-12" },
  ];
  const records: SettlementRecord[] = [
    {
      orderNo: "CP-20261105-1003",
      state: "paid",
      amount: expectedSettlementAmount(89_000, "coupang"),
      paidAt: "2026-11-16",
    },
    {
      orderNo: "EL-20261112-1004",
      state: "scheduled",
      amount: expectedSettlementAmount(54_000, "elevenst"),
    },
  ];

  it("상태별 건수·금액을 집계하고 위험을 먼저 정렬한다", () => {
    const result = computeSettlementWatch(orders, records, WATCH_SNAPSHOT_DATE);
    expect(result.counts.total).toBe(4);
    expect(result.counts.risk).toBe(1);
    expect(result.counts.warning).toBe(1);
    expect(result.counts.pending).toBe(1);
    expect(result.counts.ok).toBe(1);

    expect(result.flagged).toHaveLength(2);
    expect(result.flagged[0].status).toBe("risk");
    expect(result.amounts.atRisk).toBe(expectedSettlementAmount(128_000, "smartstore"));
    expect(result.unrecordedOrders).toBe(2);
    // 가장 오래 밀린 건은 스마트스토어 8일이다.
    expect(result.longestOverdueDays).toBe(8);
  });

  it("채널별로 위험·경고 금액을 합산한다", () => {
    const result = computeSettlementWatch(orders, records, WATCH_SNAPSHOT_DATE);
    const smartstore = result.byChannel.find((row) => row.channel === "smartstore");
    expect(smartstore?.risk).toBe(1);
    expect(smartstore?.amountAtRisk).toBe(expectedSettlementAmount(128_000, "smartstore"));
    expect(result.byChannel[0].amountAtRisk).toBeGreaterThanOrEqual(
      result.byChannel[result.byChannel.length - 1].amountAtRisk,
    );
  });

  it("필터는 위험/경고/전체와 채널을 함께 적용한다", () => {
    const result = computeSettlementWatch(orders, records, WATCH_SNAPSHOT_DATE);
    expect(filterWatchItems(result.items, "flagged")).toHaveLength(2);
    expect(filterWatchItems(result.items, "risk")).toHaveLength(1);
    expect(filterWatchItems(result.items, "warning")).toHaveLength(1);
    expect(filterWatchItems(result.items, "all")).toHaveLength(4);
    expect(filterWatchItems(result.items, "all", "coupang")).toHaveLength(1);
  });

  it("위험 기준일 상수를 규칙에 그대로 쓴다", () => {
    // 경과 2일은 경고, 3일은 위험 — 상수를 바꾸면 이 경계도 함께 바뀐다.
    const twoDays = judgeOrder(order, null, "2026-11-15");
    expect(twoDays.status).toBe(RISK_AFTER_DAYS > 2 ? "warning" : "risk");
  });
});

describe("알림 문구", () => {
  it("위험·경고가 있으면 건수·금액·최장 경과를 적는다", () => {
    const result = computeSettlementWatch(
      [order],
      [],
      WATCH_SNAPSHOT_DATE,
    );
    const text = composeWatchDigest(result);
    expect(text).toContain("정산 누락·지연");
    expect(text).toContain("위험 1건");
    expect(text).toContain("최장 경과 8일");
    expect(text).toContain("SS-20261110-1001");
  });

  it("이상이 없으면 이상 없음 문구를 쓴다", () => {
    const result = computeSettlementWatch(
      [{ ...order, confirmedAt: "2026-11-19" }],
      [],
      WATCH_SNAPSHOT_DATE,
    );
    expect(result.counts.risk + result.counts.warning).toBe(0);
    expect(composeWatchDigest(result)).toContain("이상 없음");
  });
});

describe("데모 원장", () => {
  it("같은 시드면 같은 원장이 나온다", () => {
    const a = generateWatchLedger({ count: 40, seed: 7 });
    const b = generateWatchLedger({ count: 40, seed: 7 });
    expect(a.orders).toEqual(b.orders);
    expect(a.records).toEqual(b.records);
    expect(a.orders).toHaveLength(40);
    // 정산 내역이 없는 주문이 일부 섞여 있어야 한다.
    expect(a.records.length).toBeLessThan(40);
  });

  it("고정 원장에는 위험·경고·대기·정상이 모두 나타난다", () => {
    const ledger = generateWatchLedger();
    const result = computeSettlementWatch(ledger.orders, ledger.records, ledger.snapshotDate);
    expect(result.counts.risk).toBeGreaterThan(0);
    expect(result.counts.warning).toBeGreaterThan(0);
    expect(result.counts.pending).toBeGreaterThan(0);
    expect(result.counts.ok).toBeGreaterThan(0);
    expect(result.counts.total).toBe(140);
    expect(result.amounts.atRisk).toBeGreaterThan(0);
    expect(result.longestOverdueDays).toBeGreaterThanOrEqual(RISK_AFTER_DAYS);
  });

  it("기준일을 바꾸면 기한 경과 판정도 함께 움직인다", () => {
    const ledger = generateWatchLedger({ count: 60, seed: 11 });
    const later = computeSettlementWatch(ledger.orders, ledger.records, "2027-01-15");
    const early = computeSettlementWatch(ledger.orders, ledger.records, ledger.snapshotDate);
    expect(later.longestOverdueDays).toBeGreaterThan(early.longestOverdueDays);
  });
});
