/**
 * 월별 재대사 · 전월 대비 차액 추적 (Period comparison)
 *
 * 왜 이 모듈이 필요한가
 * ---------------------
 * 대사 엔진은 "이번 달 정산서에 얼마가 새었는지"를 원인별로 계산한다. 하지만 셀러가 실제로
 * 판단해야 하는 것은 **지난달보다 나아졌는지**다. 마켓에 이의를 제기할 근거도 "이번 달 32만원"이
 * 아니라 "지난달보다 수수료 초과 청구가 18만원 늘었다"일 때 훨씬 구체적이다.
 *
 * 이 모듈은 두 달의 **요약 스냅숏**을 받아 다음을 낸다.
 *   - 누수·정상 대사율·건수의 월간 증감
 *   - 원인(이상 코드)별 증감과 상태(신규 / 해소 / 악화 / 개선 / 변화 없음)
 *   - 채널별 증감
 *   - 이번 달 누수 변화를 가장 크게 만든 원인(driver)
 *
 * 설계 원칙
 * ---------
 * - **순수 함수**: 저장소·시계·화면에 의존하지 않는다. 두 스냅숏이 같으면 결과도 같다.
 * - **정수 원**: 금액 증감은 `roundWon(현재 − 이전)`으로 계산해 부동소수점 잔재가 남지 않게 한다.
 * - **비율은 말할 수 있을 때만**: 이전 값이 0이면 증감률을 만들지 않고 `null`로 둔다.
 *   `0%`와 `비교 불가`는 다른 뜻이고, 화면이 둘을 섞으면 지표를 잘못 읽는다.
 * - **정렬은 결정적**: 증감 절대값 → 현재 금액 → 코드 순으로 고정해, 같은 입력이면 항상 같은
 *   순서가 나온다(스냅숏 테스트·E2E가 순서에 의존해도 깨지지 않는다).
 */

import {
  ANOMALY_META,
  roundWon,
  type AnomalyCode,
  type ChannelSummary,
  type MarketChannel,
  type ReconciliationSummary,
} from "./reconciliationEngine";

/** 채널 표기. 화면과 리포트가 같은 문구를 쓰도록 한 곳에 둔다. */
export const CHANNEL_LABELS: Record<MarketChannel, string> = {
  smartstore: "스마트스토어",
  coupang: "쿠팡",
  elevenst: "11번가",
  gmarket: "G마켓",
};

/** 채널 비교 순서(계약 프리셋 순서와 같다) */
export const CHANNEL_ORDER: MarketChannel[] = ["smartstore", "coupang", "elevenst", "gmarket"];

/** 비교에 쓰는 요약. 대사 결과에서 필요한 값만 남긴다. */
export interface SnapshotSummary {
  totalRows: number;
  matchedRows: number;
  flaggedRows: number;
  matchedRate: number;
  totalPaidAmount: number;
  totalSettledAmount: number;
  expectedSettlement: number;
  totalLeak: number;
  totalSurplus: number;
  marginRiskExposure: number;
  negativeMarginRows: number;
  worstMarginRate: number;
  anomalyCounts: Record<AnomalyCode, number>;
  anomalyLoss: Record<AnomalyCode, number>;
  byChannel: ChannelSummary[];
}

export interface MonthlySnapshot {
  month: string;
  summary: SnapshotSummary;
}

export type CauseStatus = "new" | "resolved" | "worse" | "better" | "flat";

export interface CauseMovement {
  code: AnomalyCode;
  label: string;
  category: (typeof ANOMALY_META)[AnomalyCode]["category"];
  severity: (typeof ANOMALY_META)[AnomalyCode]["severity"];
  previousLoss: number;
  currentLoss: number;
  /** 현재 − 이전 (원). 양수면 손실이 늘었다 */
  deltaLoss: number;
  previousCount: number;
  currentCount: number;
  deltaCount: number;
  /** 이전 손실이 0이면 증감률을 만들지 않는다(비교 불가) */
  deltaPct: number | null;
  status: CauseStatus;
}

export interface ChannelMovement {
  channel: MarketChannel;
  label: string;
  previousRows: number;
  currentRows: number;
  previousLeak: number;
  currentLeak: number;
  deltaLeak: number;
  deltaPct: number | null;
}

export interface Direction {
  /** 증감 부호. 0이면 변화 없음 */
  sign: -1 | 0 | 1;
  delta: number;
  deltaPct: number | null;
}

export interface PeriodComparison {
  tenantId: string | null;
  previousMonth: string;
  currentMonth: string;
  /** 두 달 사이 간격(개월). 1이면 연속된 달 */
  monthGap: number;
  consecutive: boolean;
  leak: Direction & { previous: number; current: number };
  matchedRate: { previous: number; current: number; delta: number };
  rows: { previous: number; current: number; delta: number };
  flagged: { previous: number; current: number; delta: number };
  /** 증감 절대값이 큰 순서 */
  causes: CauseMovement[];
  channels: ChannelMovement[];
  newCauses: CauseMovement[];
  resolvedCauses: CauseMovement[];
  /** 누수 변화를 가장 크게 만든 원인(절대값 기준). 변화가 없으면 null */
  driver: CauseMovement | null;
}

export type PeriodComparisonErrorCode = "MONTH_FORMAT" | "MONTH_ORDER" | "SAME_TENANT_ONLY";

export class PeriodComparisonError extends Error {
  readonly code: PeriodComparisonErrorCode;

  constructor(code: PeriodComparisonErrorCode, message: string) {
    super(message);
    this.name = "PeriodComparisonError";
    this.code = code;
  }
}

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isValidMonth(month: string): boolean {
  return MONTH_PATTERN.test(month);
}

/** 0부터 시작하는 월 인덱스. 정렬·간격 계산에 쓴다. */
export function monthIndex(month: string): number {
  const match = MONTH_PATTERN.exec(month);
  if (!match) {
    throw new PeriodComparisonError("MONTH_FORMAT", `월 형식은 YYYY-MM 입니다: ${month}`);
  }
  return Number(match[1]) * 12 + (Number(match[2]) - 1);
}

/** 기준 월에서 n개월 이동한 월 문자열 */
export function shiftMonth(month: string, offset: number): string {
  const index = monthIndex(month) + Math.trunc(offset);
  const year = Math.floor(index / 12);
  const monthOfYear = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(monthOfYear).padStart(2, "0")}`;
}

/** 두 달 사이의 개월 간격. `current`가 더 과거면 음수 */
export function monthGap(previous: string, current: string): number {
  return monthIndex(current) - monthIndex(previous);
}

/** ISO 날짜 또는 Date → "YYYY-MM" */
export function monthOf(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new PeriodComparisonError("MONTH_FORMAT", `날짜를 해석할 수 없습니다: ${String(value)}`);
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** 대사 요약 → 비교용 스냅숏 요약. 필요 없는 값(상위 SKU 등)은 저장하지 않는다. */
export function toSnapshotSummary(summary: ReconciliationSummary): SnapshotSummary {
  return {
    totalRows: summary.totalRows,
    matchedRows: summary.matchedRows,
    flaggedRows: summary.flaggedRows,
    matchedRate: summary.matchedRate,
    totalPaidAmount: summary.totalPaidAmount,
    totalSettledAmount: summary.totalSettledAmount,
    expectedSettlement: summary.expectedSettlement,
    totalLeak: summary.totalLeak,
    totalSurplus: summary.totalSurplus,
    marginRiskExposure: summary.marginRiskExposure,
    negativeMarginRows: summary.negativeMarginRows,
    worstMarginRate: summary.worstMarginRate,
    anomalyCounts: { ...summary.anomalyCounts },
    anomalyLoss: { ...summary.anomalyLoss },
    byChannel: summary.byChannel.map((channel) => ({ ...channel })),
  };
}

function roundPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}

/** 금액 증감률(%). 이전 값이 0 이하이면 null */
export function percentChange(previous: number, delta: number): number | null {
  if (!Number.isFinite(previous) || previous <= 0) return null;
  return roundPercent((delta / previous) * 100);
}

function directionOf(previous: number, current: number): Direction {
  const delta = roundWon(current - previous);
  return { sign: delta > 0 ? 1 : delta < 0 ? -1 : 0, delta, deltaPct: percentChange(previous, delta) };
}

function emptyChannelSummary(channel: MarketChannel): ChannelSummary {
  return { channel, rows: 0, paidAmount: 0, settledAmount: 0, leak: 0, flaggedRows: 0 };
}

function channelMap(summary: SnapshotSummary): Map<MarketChannel, ChannelSummary> {
  const map = new Map<MarketChannel, ChannelSummary>();
  for (const channel of CHANNEL_ORDER) map.set(channel, emptyChannelSummary(channel));
  for (const entry of summary.byChannel) {
    if (!map.has(entry.channel)) continue;
    map.set(entry.channel, entry);
  }
  return map;
}

function statusOf(previousLoss: number, currentLoss: number): CauseStatus {
  if (previousLoss <= 0 && currentLoss > 0) return "new";
  if (previousLoss > 0 && currentLoss <= 0) return "resolved";
  const delta = roundWon(currentLoss - previousLoss);
  if (delta > 0) return "worse";
  if (delta < 0) return "better";
  return "flat";
}

const CAUSE_CODES = Object.keys(ANOMALY_META) as AnomalyCode[];

function causeMovements(previous: SnapshotSummary, current: SnapshotSummary): CauseMovement[] {
  const movements: CauseMovement[] = [];
  for (const code of CAUSE_CODES) {
    const previousLoss = roundWon(previous.anomalyLoss[code] ?? 0);
    const currentLoss = roundWon(current.anomalyLoss[code] ?? 0);
    const previousCount = previous.anomalyCounts[code] ?? 0;
    const currentCount = current.anomalyCounts[code] ?? 0;
    // 양쪽 다 0이면 표에 넣지 않는다. 원인 표는 "움직인 것"을 보여 주는 자리다.
    if (previousLoss === 0 && currentLoss === 0 && previousCount === 0 && currentCount === 0) continue;
    const deltaLoss = roundWon(currentLoss - previousLoss);
    const meta = ANOMALY_META[code];
    movements.push({
      code,
      label: meta.label,
      category: meta.category,
      severity: meta.severity,
      previousLoss,
      currentLoss,
      deltaLoss,
      previousCount,
      currentCount,
      deltaCount: currentCount - previousCount,
      deltaPct: percentChange(previousLoss, deltaLoss),
      status: statusOf(previousLoss, currentLoss),
    });
  }

  return movements.sort((left, right) => {
    const byDelta = Math.abs(right.deltaLoss) - Math.abs(left.deltaLoss);
    if (byDelta !== 0) return byDelta;
    const byCurrent = right.currentLoss - left.currentLoss;
    if (byCurrent !== 0) return byCurrent;
    return left.code.localeCompare(right.code);
  });
}

function channelMovements(previous: SnapshotSummary, current: SnapshotSummary): ChannelMovement[] {
  const before = channelMap(previous);
  const after = channelMap(current);
  return CHANNEL_ORDER.map((channel) => {
    const from = before.get(channel) ?? emptyChannelSummary(channel);
    const to = after.get(channel) ?? emptyChannelSummary(channel);
    const deltaLeak = roundWon(to.leak - from.leak);
    return {
      channel,
      label: CHANNEL_LABELS[channel],
      previousRows: from.rows,
      currentRows: to.rows,
      previousLeak: roundWon(from.leak),
      currentLeak: roundWon(to.leak),
      deltaLeak,
      deltaPct: percentChange(from.leak, deltaLeak),
    };
  });
}

/**
 * 두 달 비교.
 *
 * `previous.month`는 `current.month`보다 앞서야 한다. 같은 달을 두 번 비교하거나 순서를 뒤집으면
 * 증감의 부호가 뒤집혀 화면이 반대말을 하게 되므로, 조용히 계산하지 않고 오류로 멈춘다.
 */
export function comparePeriods(
  previous: MonthlySnapshot,
  current: MonthlySnapshot,
  options: { tenantId?: string | null } = {},
): PeriodComparison {
  const gap = monthGap(previous.month, current.month);
  if (gap === 0) {
    throw new PeriodComparisonError("MONTH_ORDER", "같은 달끼리는 비교할 수 없습니다.");
  }
  if (gap < 0) {
    throw new PeriodComparisonError(
      "MONTH_ORDER",
      `비교 기준월(${previous.month})이 대상월(${current.month})보다 과거여야 합니다.`,
    );
  }

  const causes = causeMovements(previous.summary, current.summary);
  const leak = directionOf(previous.summary.totalLeak, current.summary.totalLeak);
  const driver = causes.find((cause) => cause.deltaLoss !== 0) ?? null;

  return {
    tenantId: options.tenantId ?? null,
    previousMonth: previous.month,
    currentMonth: current.month,
    monthGap: gap,
    consecutive: gap === 1,
    leak: {
      previous: roundWon(previous.summary.totalLeak),
      current: roundWon(current.summary.totalLeak),
      ...leak,
    },
    matchedRate: {
      previous: roundPercent(previous.summary.matchedRate),
      current: roundPercent(current.summary.matchedRate),
      delta: roundPercent(current.summary.matchedRate - previous.summary.matchedRate),
    },
    rows: {
      previous: previous.summary.totalRows,
      current: current.summary.totalRows,
      delta: current.summary.totalRows - previous.summary.totalRows,
    },
    flagged: {
      previous: previous.summary.flaggedRows,
      current: current.summary.flaggedRows,
      delta: current.summary.flaggedRows - previous.summary.flaggedRows,
    },
    causes,
    channels: channelMovements(previous.summary, current.summary),
    newCauses: causes.filter((cause) => cause.status === "new"),
    resolvedCauses: causes.filter((cause) => cause.status === "resolved"),
    driver,
  };
}

/**
 * 한 줄 요약. 화면·리포트가 같은 문장을 쓰도록 여기서 만든다.
 * 금액 표기는 화면 규칙(원 단위 콤마)을 따르되, 문자열 조립은 이 함수 하나로 끝낸다.
 */
export function describeComparison(comparison: PeriodComparison): string {
  const won = (value: number): string => `${Math.abs(Math.round(value)).toLocaleString("ko-KR")}원`;
  if (comparison.leak.previous === 0 && comparison.leak.current === 0) {
    return `${comparison.previousMonth} 대비 누수가 두 달 모두 없습니다.`;
  }
  if (comparison.leak.delta === 0) {
    return `${comparison.previousMonth} 대비 누수는 ${won(comparison.leak.current)}으로 같습니다.`;
  }
  const movement = comparison.leak.delta > 0 ? "증가" : "감소";
  const rate = comparison.leak.deltaPct === null ? "" : ` (${Math.abs(comparison.leak.deltaPct).toFixed(1)}%)`;
  const driver = comparison.driver;
  const cause =
    driver === null
      ? ""
      : ` · 가장 크게 움직인 원인은 ${driver.label} ${driver.deltaLoss > 0 ? "+" : "−"}${won(driver.deltaLoss)}`;
  return `${comparison.previousMonth} 대비 누수 ${won(comparison.leak.delta)} ${movement}${rate}${cause}`;
}
