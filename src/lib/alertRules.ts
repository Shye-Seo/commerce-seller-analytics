import { MARKET_PRESETS } from "./calculator";
import { composeAnomalyContent } from "./alimtalkSimulator";
import {
  roundWon,
  type AnomalyCode,
  type MarketChannel,
  type ReconciledRow,
} from "./reconciliationEngine";

/**
 * 정산 이상징후 경보 룰 빌더 (엔진)
 *
 * 대사 엔진은 "계약과 정산서가 어긋난 행"을 찾는다. 하지만 운영자는 그 전에 자기 기준으로
 * 선을 긋고 싶어 한다. "수수료가 계약보다 1%p 넘게 청구되면 알려라", "정산이 예정일에서
 * 3일 넘게 밀리면 알려라", "쿠폰 부담률이 8%를 넘는 주문은 따로 보자" 같은 기준이다.
 *
 * 이 모듈은 그 기준을 **데이터에서 매번 다시 평가**한다. 룰을 켜고 끄거나 임계값을 바꾸면
 * 같은 정산 데이터에서 위반 건이 즉시 다시 계산되고, 화면은 그 결과로 행을 표시한다.
 *
 * 데이터 출처를 섞지 않는다
 * -------------------------
 * - 수수료율·쿠폰 부담률은 정산서 행과 쿠폰 원장에서 그대로 계산할 수 있다.
 * - 정산 입금일은 정산서 CSV에 없는 값이다. 데모 원장에서는 마켓 정산 주기(D+n 영업일)로
 *   **시뮬레이션한 입금일**을 만들고, 업로드·API 수집 데이터에는 만들지 않는다.
 *   없는 값을 지어내지 않고, 룰을 "평가할 수 없음"으로 표시하는 쪽을 택했다.
 */

export type AlertRuleId = "fee-step" | "settlement-delay" | "coupon-burden";

export interface AlertRuleMeta {
  id: AlertRuleId;
  label: string;
  /** 화면 도움말 한 줄 */
  description: string;
  /** 임계값 단위 */
  unit: "%p" | "일" | "%";
  defaultThreshold: number;
  min: number;
  max: number;
  step: number;
  severity: "critical" | "warning";
  /** 이 룰이 요구하는 데이터 */
  requires: "settlement" | "receipt" | "coupon";
}

export const ALERT_RULE_LIST: AlertRuleMeta[] = [
  {
    id: "fee-step",
    label: "수수료율 +1%p 초과",
    description: "실효 수수료율이 계약 수수료율보다 임계값 이상 높은 주문입니다.",
    unit: "%p",
    defaultThreshold: 1,
    min: 0.1,
    max: 10,
    step: 0.1,
    severity: "warning",
    requires: "settlement",
  },
  {
    id: "settlement-delay",
    label: "정산 지연 3일 이상",
    description: "마켓 정산 예정일(D+n 영업일)에서 임계값 이상 늦게 입금됐거나 아직 입금되지 않은 건입니다.",
    unit: "일",
    defaultThreshold: 3,
    min: 1,
    max: 30,
    step: 1,
    severity: "critical",
    requires: "receipt",
  },
  {
    id: "coupon-burden",
    label: "쿠폰 부담률 임계치 초과",
    description: "우리가 부담한 쿠폰 비용이 결제금액에서 차지하는 비율이 임계값을 넘는 주문입니다.",
    unit: "%",
    defaultThreshold: 8,
    min: 1,
    max: 50,
    step: 0.5,
    severity: "warning",
    requires: "coupon",
  },
];

export const ALERT_RULE_BY_ID: Record<AlertRuleId, AlertRuleMeta> = ALERT_RULE_LIST.reduce(
  (map, rule) => ({ ...map, [rule.id]: rule }),
  {} as Record<AlertRuleId, AlertRuleMeta>,
);

export interface AlertRuleConfig {
  id: AlertRuleId;
  enabled: boolean;
  threshold: number;
}

/** 기본값: 세 룰 모두 켜고 메타의 기본 임계값을 쓴다. */
export function defaultAlertRules(): AlertRuleConfig[] {
  return ALERT_RULE_LIST.map((rule) => ({
    id: rule.id,
    enabled: true,
    threshold: rule.defaultThreshold,
  }));
}

/** 룰 설정을 메타 범위 안으로 보정한다(입력창에서 빈 값·소수점이 흘러들어올 수 있다). */
export function normalizeAlertRule(config: AlertRuleConfig): AlertRuleConfig {
  const meta = ALERT_RULE_BY_ID[config.id];
  const threshold = Number.isFinite(config.threshold)
    ? Math.min(meta.max, Math.max(meta.min, config.threshold))
    : meta.defaultThreshold;
  return { id: config.id, enabled: Boolean(config.enabled), threshold };
}

/* ─────────────────────────────────────────────────────────────
 * 1. 날짜 계산 — 영업일(D+n)과 달력일(지연일)을 구분한다
 * ───────────────────────────────────────────────────────────── */

const DAY_MS = 24 * 60 * 60 * 1000;

function parseUtc(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!match) return Number.NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 마켓 정산 주기는 영업일 기준이다. 토·일을 건너뛰고 n영업일 뒤 날짜를 구한다. */
export function addBusinessDays(date: string, days: number): string {
  const start = parseUtc(date);
  if (!Number.isFinite(start)) return date;
  let cursor = start;
  let remaining = Math.max(0, Math.round(days));
  while (remaining > 0) {
    cursor += DAY_MS;
    const weekday = new Date(cursor).getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  // 주문일이 주말이면 정산 기산일은 다음 영업일로 민다.
  if (remaining === 0 && days === 0) {
    while ([0, 6].includes(new Date(cursor).getUTCDay())) cursor += DAY_MS;
  }
  return toIso(cursor);
}

/** 달력일 차이(지연일). to가 from보다 이르면 0. */
export function calendarDaysBetween(from: string, to: string): number {
  const start = parseUtc(from);
  const end = parseUtc(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / DAY_MS));
}

/* ─────────────────────────────────────────────────────────────
 * 2. 정산 입금일 (데모 시뮬레이션)
 * ───────────────────────────────────────────────────────────── */

export interface SettlementReceipt {
  orderNo: string;
  channel: MarketChannel;
  /** 마켓 정산 예정일 */
  dueDate: string;
  /** 실제 입금일. 아직 입금 전이면 null */
  receivedDate: string | null;
  /** 예정일 대비 지연일(달력일). 입금 전이면 기준일까지의 경과일 */
  delayDays: number;
}

/** 주문번호 → 0~999 결정적 해시(FNV-1a). 같은 데이터면 항상 같은 정산 달력이 나온다. */
function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 1_000;
}

/** 지연 분포: 대부분 예정일에 들어오고, 일부만 밀린다. 입금 전(pending)도 1.5% 남긴다. */
function simulatedDelayDays(bucket: number): number | null {
  if (bucket < 620) return 0;
  if (bucket < 760) return 1;
  if (bucket < 860) return 2;
  if (bucket < 920) return 3;
  if (bucket < 968) return 4 + (bucket % 3);
  if (bucket < 985) return 7 + (bucket % 4);
  return null;
}

/**
 * 데모 정산 달력.
 *
 * 정산서 CSV에는 "입금일" 열이 없다(마켓별 정산 주기를 우리가 알고 계산하는 값이다).
 * 그래서 데모 원장에서만 주문번호 해시로 입금일을 만들고, 기준일(snapshotDate)보다 뒤면
 * "아직 입금 전"으로 둔다. 업로드·API 수집 데이터에는 이 함수를 쓰지 않는다.
 */
export function buildSettlementReceipts(
  rows: readonly ReconciledRow[],
  snapshotDate: string,
): SettlementReceipt[] {
  const snapshot = parseUtc(snapshotDate);
  const receipts: SettlementReceipt[] = [];

  for (const row of rows) {
    const preset = MARKET_PRESETS[row.row.channel];
    if (!preset) continue;
    const dueDate = addBusinessDays(row.row.orderDate, preset.settlementDays);
    const delay = simulatedDelayDays(hashOf(row.row.orderNo));
    const dueMs = parseUtc(dueDate);
    if (!Number.isFinite(dueMs)) continue;

    if (delay === null) {
      receipts.push({
        orderNo: row.row.orderNo,
        channel: row.row.channel,
        dueDate,
        receivedDate: null,
        delayDays: Number.isFinite(snapshot) ? calendarDaysBetween(dueDate, toIso(snapshot)) : 0,
      });
      continue;
    }

    const receivedMs = dueMs + delay * DAY_MS;
    if (Number.isFinite(snapshot) && receivedMs > snapshot) {
      receipts.push({
        orderNo: row.row.orderNo,
        channel: row.row.channel,
        dueDate,
        receivedDate: null,
        delayDays: calendarDaysBetween(dueDate, toIso(snapshot)),
      });
      continue;
    }

    receipts.push({
      orderNo: row.row.orderNo,
      channel: row.row.channel,
      dueDate,
      receivedDate: toIso(receivedMs),
      delayDays: delay,
    });
  }

  return receipts;
}

/* ─────────────────────────────────────────────────────────────
 * 3. 룰 평가
 * ───────────────────────────────────────────────────────────── */

/** 쿠폰 사용 주문의 우리 부담액(원장에서 계산해 넘긴다) */
export interface CouponCost {
  /** 우리가 실제로 부담한 금액(셀러 부담 + 대신 부담) */
  ourCost: number;
  /** 소비자 결제금액 */
  paidAmount: number;
}

export interface AlertHit {
  ruleId: AlertRuleId;
  ruleLabel: string;
  severity: AlertRuleMeta["severity"];
  rowId: string;
  orderNo: string;
  channel: MarketChannel;
  productName: string;
  /** 룰별 지표 값(%p, 일, %) */
  metric: number;
  threshold: number;
  unit: AlertRuleMeta["unit"];
  /** 사람이 읽는 한 줄 근거 */
  detail: string;
  /** 계약·기준 기대값(원) */
  expected: number;
  /** 실제 값(원) */
  actual: number;
  /** 이 건으로 노출된 금액(원) */
  amountAtRisk: number;
}

export interface AlertRuleResult {
  id: AlertRuleId;
  label: string;
  enabled: boolean;
  threshold: number;
  unit: AlertRuleMeta["unit"];
  hits: AlertHit[];
  rowsAffected: number;
  amountAtRisk: number;
  /** 룰을 평가한 행 수 */
  evaluatedRows: number;
  /** 평가할 수 없을 때의 사유(데이터 없음) */
  skippedReason?: string;
}

export interface AlertEvaluation {
  results: AlertRuleResult[];
  /** 금액 큰 순서 */
  hits: AlertHit[];
  /** 행 id → 걸린 룰 목록. 테이블 하이라이트가 이 값을 쓴다 */
  rowIndex: Record<string, AlertRuleId[]>;
  totalAmountAtRisk: number;
  enabledCount: number;
}

export interface AlertEvaluationInput {
  rows: readonly ReconciledRow[];
  rules: readonly AlertRuleConfig[];
  /** 정산 입금일. 없으면 정산 지연 룰을 평가할 수 없다 */
  receipts?: readonly SettlementReceipt[] | null;
  /** 주문번호 → 쿠폰 부담액. 없으면 쿠폰 룰은 0건 */
  couponCosts?: ReadonlyMap<string, CouponCost> | null;
  /** 지연일 계산 기준일(YYYY-MM-DD) */
  snapshotDate: string;
}

const CHANNEL_LABEL: Record<MarketChannel, string> = {
  smartstore: "스마트스토어",
  coupang: "쿠팡",
  elevenst: "11번가",
  gmarket: "G마켓",
};

function formatDate(value: string | null): string {
  return value ? value.slice(5) : "미입금";
}

function pushHit(
  bucket: AlertHit[],
  rowIndex: Record<string, AlertRuleId[]>,
  hit: AlertHit,
): void {
  bucket.push(hit);
  const existing = rowIndex[hit.rowId];
  if (existing) {
    if (!existing.includes(hit.ruleId)) existing.push(hit.ruleId);
  } else {
    rowIndex[hit.rowId] = [hit.ruleId];
  }
}

export function evaluateAlertRules(input: AlertEvaluationInput): AlertEvaluation {
  const { rows, rules, receipts, couponCosts, snapshotDate } = input;
  const receiptByOrder = new Map<string, SettlementReceipt>();
  if (receipts) {
    for (const receipt of receipts) receiptByOrder.set(receipt.orderNo, receipt);
  }

  const rowIndex: Record<string, AlertRuleId[]> = {};
  const results: AlertRuleResult[] = [];

  for (const config of rules.map(normalizeAlertRule)) {
    const meta = ALERT_RULE_BY_ID[config.id];
    const hits: AlertHit[] = [];
    let evaluatedRows = 0;
    let skippedReason: string | undefined;

    if (!config.enabled) {
      results.push({
        id: config.id,
        label: meta.label,
        enabled: false,
        threshold: config.threshold,
        unit: meta.unit,
        hits,
        rowsAffected: 0,
        amountAtRisk: 0,
        evaluatedRows: 0,
      });
      continue;
    }

    if (config.id === "settlement-delay" && !receipts) {
      skippedReason = "정산 입금일이 없어 이 룰은 평가하지 않았습니다(입금일이 있는 정산서에서만 평가).";
    }

    for (const item of rows) {
      if (skippedReason) break;

      if (config.id === "fee-step") {
        if (item.row.paidAmount <= 0) continue;
        evaluatedRows += 1;
        const contractRate = item.contract.feeRate;
        const gap = item.effectiveFeeRate - contractRate;
        if (gap < config.threshold) continue;
        const overpaid = roundWon((gap / 100) * item.row.paidAmount);
        pushHit(hits, rowIndex, {
          ruleId: config.id,
          ruleLabel: meta.label,
          severity: meta.severity,
          rowId: item.id,
          orderNo: item.row.orderNo,
          channel: item.row.channel,
          productName: item.row.productName,
          metric: Math.round(gap * 100) / 100,
          threshold: config.threshold,
          unit: meta.unit,
          detail: `${CHANNEL_LABEL[item.row.channel]} 계약 ${contractRate}% → 실효 ${item.effectiveFeeRate.toFixed(2)}% (${formatDate(item.row.orderDate)})`,
          expected: roundWon((contractRate / 100) * item.row.paidAmount),
          actual: item.row.commission,
          amountAtRisk: overpaid,
        });
        continue;
      }

      if (config.id === "settlement-delay") {
        const receipt = receiptByOrder.get(item.row.orderNo);
        if (!receipt) continue;
        evaluatedRows += 1;
        if (receipt.delayDays < config.threshold) continue;
        const settled = Math.max(0, item.actualSettlement);
        pushHit(hits, rowIndex, {
          ruleId: config.id,
          ruleLabel: meta.label,
          severity: meta.severity,
          rowId: item.id,
          orderNo: item.row.orderNo,
          channel: item.row.channel,
          productName: item.row.productName,
          metric: receipt.delayDays,
          threshold: config.threshold,
          unit: meta.unit,
          detail: `예정 ${formatDate(receipt.dueDate)} → ${receipt.receivedDate ? `입금 ${formatDate(receipt.receivedDate)}` : `기준일 ${formatDate(snapshotDate)}까지 미입금`}`,
          expected: settled,
          actual: receipt.receivedDate ? settled : 0,
          amountAtRisk: receipt.receivedDate ? 0 : settled,
        });
        continue;
      }

      // coupon-burden
      const cost = couponCosts?.get(item.row.orderNo);
      if (!cost || cost.paidAmount <= 0) continue;
      evaluatedRows += 1;
      const burden = (cost.ourCost / cost.paidAmount) * 100;
      if (burden < config.threshold) continue;
      const allowed = roundWon((config.threshold / 100) * cost.paidAmount);
      pushHit(hits, rowIndex, {
        ruleId: config.id,
        ruleLabel: meta.label,
        severity: meta.severity,
        rowId: item.id,
        orderNo: item.row.orderNo,
        channel: item.row.channel,
        productName: item.row.productName,
        metric: Math.round(burden * 10) / 10,
        threshold: config.threshold,
        unit: meta.unit,
        detail: `결제 ${cost.paidAmount.toLocaleString("ko-KR")}원 중 우리 부담 ${cost.ourCost.toLocaleString("ko-KR")}원`,
        expected: allowed,
        actual: cost.ourCost,
        amountAtRisk: Math.max(0, cost.ourCost - allowed),
      });
    }

    hits.sort((a, b) => b.amountAtRisk - a.amountAtRisk || a.orderNo.localeCompare(b.orderNo));
    results.push({
      id: config.id,
      label: meta.label,
      enabled: true,
      threshold: config.threshold,
      unit: meta.unit,
      hits,
      rowsAffected: hits.length,
      amountAtRisk: hits.reduce((sum, hit) => sum + hit.amountAtRisk, 0),
      evaluatedRows,
      skippedReason,
    });
  }

  const allHits = results
    .flatMap((result) => result.hits)
    .sort((a, b) => b.amountAtRisk - a.amountAtRisk || a.orderNo.localeCompare(b.orderNo));

  return {
    results,
    hits: allHits,
    rowIndex,
    totalAmountAtRisk: allHits.reduce((sum, hit) => sum + hit.amountAtRisk, 0),
    enabledCount: results.filter((result) => result.enabled).length,
  };
}

/* ─────────────────────────────────────────────────────────────
 * 4. SENS 알림톡 미리보기
 * ───────────────────────────────────────────────────────────── */

/**
 * 경보 룰 위반을 기존 알림톡 템플릿(SS_ANOMALY_CRITICAL) 본문으로 합성한다.
 *
 * 룰마다 새 템플릿을 만들면 카카오 검수를 다시 받아야 하므로, 이미 검수된 템플릿의
 * 변수에 룰 이름과 근거를 넣는 방식이 실제 운영과 같다. 발송은 알림톡 콘솔이 담당한다.
 */
const PREVIEW_CODE: Record<AlertRuleId, AnomalyCode> = {
  "fee-step": "FEE_OVERCHARGE",
  "settlement-delay": "SETTLEMENT_SHORTFALL",
  "coupon-burden": "NEGATIVE_MARGIN",
};

export function composeRuleAlertPreview(hit: AlertHit, tenantName = "셀러스코프"): string {
  return composeAnomalyContent({
    tenantName,
    orderNo: hit.orderNo,
    productName: hit.productName,
    anomalyCode: PREVIEW_CODE[hit.ruleId],
    anomalyLabel: `${hit.ruleLabel}`,
    expected: hit.expected,
    actual: hit.actual,
    loss: hit.amountAtRisk,
    detail: hit.detail,
  });
}
