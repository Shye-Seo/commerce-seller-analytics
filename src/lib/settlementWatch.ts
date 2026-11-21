import { MARKET_PRESETS } from "./calculator";
import { addBusinessDays, calendarDaysBetween } from "./alertRules";
import type { MarketChannel } from "./reconciliationEngine";

/**
 * 정산 누락·지연 감지기 (엔진)
 *
 * 정산 대사 콘솔이 "정산서에 찍힌 행과 계약이 맞는가"를 본다면, 이 모듈은 그 앞 단계를 본다.
 * **구매확정일과 마켓별 정산 기한만으로 "지금 들어와야 할 돈이 들어왔는가"를 판정**한다.
 * 정산서에 아예 등장하지 않는 주문은 대사 엔진이 잡을 수 없기 때문에, 누락은 별도로 감시해야 한다.
 *
 * 판정 규칙
 * ---------
 * 1. 정산 예정일 = 구매확정일 + 마켓 정산 기한(N영업일). 기한은 마켓 공개 정책을 쓴다.
 * 2. 기준일까지 정산 예정일이 지났는데 정산 내역이 없으면
 *      - 경과 3일 이상 → 위험(정산 누락 의심)
 *      - 경과 1~2일   → 경고
 * 3. 정산 내역이 "예정"으로만 잡혀 있고 기한이 지났으면 → 경고
 * 4. 정산 완료라도 금액이 예상치에 1% 넘게 모자라면 → 경고(부분 정산)
 * 5. 정산 완료라도 예정일보다 늦게 들어왔으면 → 경고(지연 정산) — 돈은 받았지만 회수 지연이다
 * 6. 그 외는 정상. 아직 기한 전이면 대기.
 *
 * 금액 해석
 * ---------
 * 예상 정산액은 결제금액에서 마켓 수수료·결제 수수료를 뺀 값이다. 카테고리별 요율까지는
 * 주문 단위로 확정할 수 없으므로 기본 요율을 쓰고, 화면에는 그 사실을 적는다.
 */

/** 감시 기준일. `new Date()`를 쓰면 빌드마다 결과가 달라지므로 고정한다. */
export const WATCH_SNAPSHOT_DATE = "2026-11-21";

/** 정산 내역이 없을 때 위험으로 올리는 경과일 */
export const RISK_AFTER_DAYS = 3;

/** 부분 정산으로 볼 금액 오차 허용 비율(%) */
export const SETTLEMENT_TOLERANCE_RATE = 1;

export type WatchStatus = "risk" | "warning" | "pending" | "ok";

export type SettlementState = "paid" | "scheduled";

/** 구매확정된 주문 (정산 대상) */
export interface WatchOrder {
  orderNo: string;
  channel: MarketChannel;
  productName: string;
  optionName?: string;
  /** 결제금액(원) */
  paidAmount: number;
  /** 구매확정일(YYYY-MM-DD). 정산 기한 기산일 */
  confirmedAt: string;
}

/** 마켓이 보내 준 정산 내역 한 줄 */
export interface SettlementRecord {
  orderNo: string;
  state: SettlementState;
  /** 정산 예정/완료 금액(원) */
  amount: number;
  /** 정산 완료일(YYYY-MM-DD). state가 scheduled면 없다 */
  paidAt?: string;
}

export interface WatchItem {
  orderNo: string;
  channel: MarketChannel;
  channelLabel: string;
  productName: string;
  optionName?: string;
  paidAmount: number;
  confirmedAt: string;
  /** 정산 예정일 */
  dueDate: string;
  /** 예상 정산액(수수료 차감 후) */
  expectedAmount: number;
  status: WatchStatus;
  /** 기한 경과일(달력일, 기한 전이면 0) */
  overdueDays: number;
  /** 정산 내역상 금액 */
  settledAmount: number | null;
  settlementState: "none" | SettlementState;
  /** 부족 금액(원). 부족하지 않으면 0 */
  shortfall: number;
  /** 판정 근거 한 줄 */
  reason: string;
  /** 정산 내역상 입금일 */
  paidAt: string | null;
}

export interface ChannelWatchStat {
  channel: MarketChannel;
  label: string;
  color: string;
  total: number;
  risk: number;
  warning: number;
  /** 위험+경고 금액(원) */
  amountAtRisk: number;
}

export interface SettlementWatchResult {
  snapshotDate: string;
  items: WatchItem[];
  /** 위험·경고만, 금액 큰 순서 */
  flagged: WatchItem[];
  counts: { total: number; risk: number; warning: number; pending: number; ok: number };
  amounts: {
    /** 위험 금액 — 아직 못 받은 돈 */
    atRisk: number;
    /** 경고 금액 — 지연·부분 정산으로 묶인 돈 */
    delayed: number;
    /** 기한 전 대기 금액 */
    pending: number;
    /** 정상 정산 금액 */
    settled: number;
  };
  byChannel: ChannelWatchStat[];
  /** 가장 오래 밀린 건의 경과일 */
  longestOverdueDays: number;
  /** 판정 대상 주문 수 */
  evaluatedOrders: number;
  /** 정산 내역이 없어 판정하지 못한 주문 수 */
  unrecordedOrders: number;
  assumptions: string[];
}

const CHANNEL_LABELS: Record<MarketChannel, string> = {
  smartstore: "스마트스토어",
  coupang: "쿠팡",
  elevenst: "11번가",
  gmarket: "G마켓",
};

function safeAmount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function won(value: number): number {
  return Math.round(value);
}

function monthDay(date: string): string {
  return date.slice(5).replace("-", "/");
}

/** 마켓 기본 요율(판매+결제)로 예상 정산액을 구한다. */
export function expectedSettlementAmount(paidAmount: number, channel: MarketChannel): number {
  const preset = MARKET_PRESETS[channel];
  if (!preset) return won(safeAmount(paidAmount));
  const feeRate = (preset.commissionRate + preset.paymentRate) / 100;
  return won(safeAmount(paidAmount) * (1 - feeRate));
}

/** 구매확정일 + 마켓 정산 기한(N영업일) */
export function settlementDueDate(confirmedAt: string, channel: MarketChannel): string {
  const preset = MARKET_PRESETS[channel];
  const days = preset ? preset.settlementDays : 3;
  return addBusinessDays(confirmedAt, days);
}

/**
 * 주문 한 건을 판정한다.
 * `record`는 마켓 정산 내역에서 찾은 행이며, 없으면 null이다.
 */
export function judgeOrder(
  order: WatchOrder,
  record: SettlementRecord | null,
  snapshotDate = WATCH_SNAPSHOT_DATE,
): WatchItem {
  const channel = order.channel;
  const dueDate = settlementDueDate(order.confirmedAt, channel);
  const expectedAmount = expectedSettlementAmount(order.paidAmount, channel);
  const overdueDays = calendarDaysBetween(dueDate, snapshotDate);
  const daysUntilDue = calendarDaysBetween(snapshotDate, dueDate);
  const base = {
    orderNo: order.orderNo,
    channel,
    channelLabel: CHANNEL_LABELS[channel] ?? channel,
    productName: order.productName,
    optionName: order.optionName,
    paidAmount: won(safeAmount(order.paidAmount)),
    confirmedAt: order.confirmedAt,
    dueDate,
    expectedAmount,
    overdueDays,
    paidAt: record?.paidAt ?? null,
    settledAmount: record ? won(safeAmount(record.amount)) : null,
    settlementState: record ? record.state : ("none" as const),
  };

  if (!record) {
    if (overdueDays >= RISK_AFTER_DAYS) {
      return {
        ...base,
        status: "risk",
        shortfall: expectedAmount,
        reason: `정산 기한 ${monthDay(dueDate)}에서 ${overdueDays}일 지났지만 정산 내역이 없습니다`,
      };
    }
    if (overdueDays > 0) {
      return {
        ...base,
        status: "warning",
        shortfall: expectedAmount,
        reason: `정산 기한이 ${overdueDays}일 지났지만 예정에도 잡히지 않았습니다`,
      };
    }
    return {
      ...base,
      status: "pending",
      shortfall: 0,
      reason: `정산 예정일까지 ${daysUntilDue}일 남았습니다`,
    };
  }

  if (record.state === "scheduled") {
    if (overdueDays > 0) {
      return {
        ...base,
        status: "warning",
        shortfall: expectedAmount,
        reason: `정산 예정으로만 잡혀 있고 기한에서 ${overdueDays}일 지났습니다`,
      };
    }
    return {
      ...base,
      status: "pending",
      shortfall: 0,
      reason: `정산 예정 ${monthDay(dueDate)} · ${daysUntilDue}일 남음`,
    };
  }

  const settledAmount = won(safeAmount(record.amount));
  const tolerance = (expectedAmount * SETTLEMENT_TOLERANCE_RATE) / 100;
  const shortfall = Math.max(0, won(expectedAmount - settledAmount));
  const paidLateDays = record.paidAt ? calendarDaysBetween(dueDate, record.paidAt) : 0;

  if (shortfall > tolerance && shortfall > 0) {
    return {
      ...base,
      status: "warning",
      shortfall,
      reason: `정산 완료 ${won(settledAmount).toLocaleString("ko-KR")}원 · 예상보다 ${shortfall.toLocaleString("ko-KR")}원 부족`,
    };
  }

  if (paidLateDays > 0) {
    return {
      ...base,
      status: "warning",
      shortfall: 0,
      reason: `예정일보다 ${paidLateDays}일 늦게 입금됐습니다`,
    };
  }

  return {
    ...base,
    status: "ok",
    shortfall: 0,
    reason: `${monthDay(record.paidAt ?? dueDate)} 정상 정산`,
  };
}

/** 정렬 우선순위: 위험 → 경고 → 대기 → 정상, 같은 상태면 경과일·금액 순 */
const STATUS_WEIGHT: Record<WatchStatus, number> = { risk: 0, warning: 1, pending: 2, ok: 3 };

export function computeSettlementWatch(
  orders: readonly WatchOrder[],
  records: readonly SettlementRecord[],
  snapshotDate = WATCH_SNAPSHOT_DATE,
): SettlementWatchResult {
  const recordByOrder = new Map<string, SettlementRecord>();
  for (const record of records) recordByOrder.set(record.orderNo, record);

  const items = orders
    .map((order) => judgeOrder(order, recordByOrder.get(order.orderNo) ?? null, snapshotDate))
    .sort(
      (a, b) =>
        STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status] ||
        b.overdueDays - a.overdueDays ||
        b.expectedAmount - a.expectedAmount ||
        a.orderNo.localeCompare(b.orderNo),
    );

  const counts = { total: items.length, risk: 0, warning: 0, pending: 0, ok: 0 };
  const amounts = { atRisk: 0, delayed: 0, pending: 0, settled: 0 };
  const channelMap = new Map<MarketChannel, ChannelWatchStat>();

  for (const item of items) {
    counts[item.status] += 1;
    if (item.status === "risk") amounts.atRisk += item.expectedAmount;
    if (item.status === "warning") amounts.delayed += item.expectedAmount;
    if (item.status === "pending") amounts.pending += item.expectedAmount;
    if (item.status === "ok") amounts.settled += item.expectedAmount;

    const stat = channelMap.get(item.channel) ?? {
      channel: item.channel,
      label: item.channelLabel,
      color: MARKET_PRESETS[item.channel]?.color ?? "#64748B",
      total: 0,
      risk: 0,
      warning: 0,
      amountAtRisk: 0,
    };
    stat.total += 1;
    if (item.status === "risk") {
      stat.risk += 1;
      stat.amountAtRisk += item.expectedAmount;
    }
    if (item.status === "warning") {
      stat.warning += 1;
      stat.amountAtRisk += item.expectedAmount;
    }
    channelMap.set(item.channel, stat);
  }

  const byChannel = [...channelMap.values()].sort((a, b) => b.amountAtRisk - a.amountAtRisk);
  const flagged = items.filter((item) => item.status === "risk" || item.status === "warning");

  return {
    snapshotDate,
    items,
    flagged,
    counts,
    amounts,
    byChannel,
    longestOverdueDays: items.reduce((max, item) => Math.max(max, item.overdueDays), 0),
    evaluatedOrders: orders.length,
    unrecordedOrders: items.filter((item) => item.settlementState === "none").length,
    assumptions: [
      "정산 예정일은 구매확정일 + 마켓 정산 기한(영업일)로 계산합니다(주말·공휴일 제외).",
      "예상 정산액은 마켓 기본 수수료율 기준이며, 카테고리·계약 조건에 따라 달라질 수 있습니다.",
      "정산 내역이 없는 주문은 금액을 받지 못한 것으로 보고 위험/경고로 분류합니다.",
    ],
  };
}

/** 화면 필터 */
export type WatchFilter = "flagged" | "risk" | "warning" | "all";

export function filterWatchItems(
  items: readonly WatchItem[],
  filter: WatchFilter,
  channel: MarketChannel | "all" = "all",
): WatchItem[] {
  return items.filter((item) => {
    if (channel !== "all" && item.channel !== channel) return false;
    if (filter === "all") return true;
    if (filter === "flagged") return item.status === "risk" || item.status === "warning";
    return item.status === filter;
  });
}

/**
 * 알림 문구.
 *
 * 룰 위반을 한 번에 보내는 운영 알림이므로, 건수와 금액, 가장 오래 밀린 건을 먼저 쓴다.
 * 상세 목록은 콘솔에서 확인하도록 링크 대신 화면 이름을 적는다.
 */
export function composeWatchDigest(
  result: SettlementWatchResult,
  tenantName = "셀러스코프",
): string {
  const { counts, amounts, snapshotDate } = result;
  if (counts.risk + counts.warning === 0) {
    return `[${tenantName}] 정산 점검 결과\n기준일 ${monthDay(snapshotDate)} · 이상 없음\n구매확정 ${counts.total}건 모두 정산 기한 안에 있습니다.`;
  }
  const worst = result.flagged[0];
  return [
    `[${tenantName}] 정산 누락·지연 점검`,
    `기준일 ${monthDay(snapshotDate)} · 구매확정 ${counts.total}건`,
    `· 위험 ${counts.risk}건 ${amounts.atRisk.toLocaleString("ko-KR")}원`,
    `· 경고 ${counts.warning}건 ${amounts.delayed.toLocaleString("ko-KR")}원`,
    worst
      ? `최장 경과 ${result.longestOverdueDays}일 · ${worst.channelLabel} ${worst.orderNo}`
      : "",
    `상세는 정산 감시 콘솔에서 확인하세요.`,
  ]
    .filter(Boolean)
    .join("\n");
}
