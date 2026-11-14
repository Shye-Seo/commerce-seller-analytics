/**
 * 네이버클라우드 SENS 알림톡 발송 시뮬레이터 & 발송 이력 타임라인
 *
 * 백엔드(`backend/src/Services/SettlementAlertNotifier.php`, `SettlementAlertComposer.php`)에
 * 구현된 "정산 이상 감지 → 알림톡" 로직을 브라우저에서 같은 규칙으로 돌려 본다. 실제 발송은
 * SENS 액세스 키·서비스 ID·검수된 템플릿이 있어야 하므로, 이 데모는 **발송하지 않는다**.
 * 대신 다음을 실제로 계산·기록한다.
 *
 *   1. 템플릿 변수 치환 — 카카오 알림톡은 자유 문장이 아니라 검수된 템플릿 + 변수다.
 *      변수에 개행을 넣으면 안 되고(본문이 깨진다), 본문 상한은 1,000자다.
 *   2. 중복 차단 — `dedupe_key`가 같은 알림은 두 번 보내지 않는다. 배치를 다시 돌려도 마찬가지다.
 *   3. 주문당 알림 상한 — 한 주문에 원인이 5개 붙으면 문자 5통이 간다. 2통으로 자른다.
 *   4. 상태 전이 — queued → accepted(202) → delivered(0000) / failed. 실패는 attempts<3까지 재시도한다.
 *   5. 성공이 불확실한 경우(3005 AckTimeout)는 성공도 실패도 아닌 `sent`로 남긴다.
 *
 * 시뮬레이터가 내는 오류 코드는 SENS 문서의 실제 코드다(3016 NoMatchedTemplate, 401 서명 오류 등).
 * 실제 서버 호출이 아니라는 사실은 화면 배지와 각 로그 행에 표시한다.
 */

import type { AnomalyCode, ReconciledRow } from "./reconciliationEngine";
import { ANOMALY_META } from "./reconciliationEngine";

/* ─────────────────────────────────────────────────────────────
 * 1. 템플릿과 본문 합성 (PHP SettlementAlertComposer와 같은 규칙)
 * ───────────────────────────────────────────────────────────── */

export type AlimtalkTemplateCode = "SS_ANOMALY_CRITICAL" | "SS_BATCH_SUMMARY";

export interface AlimtalkTemplateMeta {
  code: AlimtalkTemplateCode;
  label: string;
  description: string;
  /** 검수 요청 본문(변수 자리 포함) */
  body: string;
  variables: string[];
}

export const ALIMTALK_TEMPLATES: Record<AlimtalkTemplateCode, AlimtalkTemplateMeta> = {
  SS_ANOMALY_CRITICAL: {
    code: "SS_ANOMALY_CRITICAL",
    label: "정산 이상 감지",
    description: "심각(critical) 이상이 탐지되면 주문 단위로 발송합니다.",
    body: "[#{tenant_name}] 정산 이상 감지 - #{anomaly_label}\n주문 #{order_no} · #{product_name}\n기대 #{expected_amount} / 정산 #{actual_amount}\n추정 손실 #{loss_amount}\n#{detail}\n정산 담당자 확인이 필요합니다.",
    variables: ["tenant_name", "anomaly_label", "order_no", "product_name", "expected_amount", "actual_amount", "loss_amount", "detail"],
  },
  SS_BATCH_SUMMARY: {
    code: "SS_BATCH_SUMMARY",
    label: "정산 대사 완료 요약",
    description: "배치 한 번에 한 통. 대상 건수·이상 건수·최대 원인을 요약합니다.",
    body: "[#{tenant_name}] 정산 대사 완료(#{batch_label})\n대상 #{total_rows}건 · 이상 #{flagged_rows}건\n추정 손실 #{total_leak}\n최대 원인 #{top_cause}\n상세 #{console_url}",
    variables: ["tenant_name", "batch_label", "total_rows", "flagged_rows", "total_leak", "top_cause", "console_url"],
  },
};

/** 알림톡 본문 상한(SENS 문서 기준). */
export const ALIMTALK_MAX_CONTENT_LENGTH = 1_000;

/** 한 주문에서 보내는 알림 상한 — PHP `MAX_ALERTS_PER_ORDER`와 같은 값 */
export const MAX_ALERTS_PER_ORDER = 2;

/** 재시도 상한 — DB의 `attempts < 3` 조건과 맞춘다 */
export const MAX_SEND_ATTEMPTS = 3;

export function formatWon(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return `${sign}${Math.abs(Math.round(amount)).toLocaleString("ko-KR")}원`;
}

/** 변수에는 한 줄만. 개행·연속 공백을 지우고 길면 자른다. */
export function templateLine(value: string, maxLength = 60): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

export interface AnomalyAlertInput {
  tenantName: string;
  orderNo: string;
  productName: string;
  anomalyCode: AnomalyCode;
  anomalyLabel: string;
  expected: number;
  actual: number;
  loss: number;
  detail: string;
}

/** `SS_ANOMALY_CRITICAL` 본문 생성. PHP composer와 문자 단위로 같은 형식이다. */
export function composeAnomalyContent(input: AnomalyAlertInput): string {
  const content = `[${templateLine(input.tenantName)}] 정산 이상 감지 - ${templateLine(input.anomalyLabel)}\n주문 ${templateLine(input.orderNo)} · ${templateLine(input.productName, 40)}\n기대 ${formatWon(input.expected)} / 정산 ${formatWon(input.actual)}\n추정 손실 ${formatWon(input.loss)}\n${templateLine(input.detail, 160)}\n정산 담당자 확인이 필요합니다.`;

  return content.slice(0, ALIMTALK_MAX_CONTENT_LENGTH);
}

export interface SummaryAlertInput {
  tenantName: string;
  batchLabel: string;
  totalRows: number;
  flaggedRows: number;
  totalLeak: number;
  topCause: string | null;
  consoleUrl?: string;
}

/** `SS_BATCH_SUMMARY` 본문 생성. */
export function composeSummaryContent(input: SummaryAlertInput): string {
  const top = input.topCause ?? "없음";
  const content = `[${templateLine(input.tenantName)}] 정산 대사 완료(${templateLine(input.batchLabel, 24)})\n대상 ${input.totalRows.toLocaleString("ko-KR")}건 · 이상 ${input.flaggedRows.toLocaleString("ko-KR")}건\n추정 손실 ${formatWon(input.totalLeak)}\n최대 원인 ${top}\n상세 ${input.consoleUrl ?? "https://sellerscope.example.com/reconciliation"}`;

  return content.slice(0, ALIMTALK_MAX_CONTENT_LENGTH);
}

export function dedupeKeyForAnomaly(tenantId: number, orderNo: string, code: AnomalyCode): string {
  return `anomaly:${tenantId}:${orderNo}:${code}`;
}

export function dedupeKeyForSummary(tenantId: number, batchId: string): string {
  return `summary:${tenantId}:${batchId}`;
}

/* ─────────────────────────────────────────────────────────────
 * 2. 수신 번호 정규화 (PHP RecipientPhone과 같은 규칙)
 * ───────────────────────────────────────────────────────────── */

export interface NormalizedPhone {
  digits: string;
  masked: string;
}

/**
 * SENS는 `to`에 숫자만 받는다. +82 표기도 국내 형식으로 되돌린다.
 * 형식이 아니면 예외 — 알림이 잘못된 번호로 나가는 것보다 즉시 실패하는 편이 낫다.
 */
export function normalizeRecipientPhone(raw: string): NormalizedPhone {
  let digits = raw.replace(/\D+/g, "");

  if (digits.startsWith("0082")) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith("82") && digits.length === 12) digits = `0${digits.slice(2)}`;
  else if (raw.trim().startsWith("+82")) {
    digits = `0${digits.replace(/^8+/, "")}`;
    digits = digits.replace(/^0+/, "0");
  }

  if (!/^01[016789][0-9]{7,8}$/.test(digits)) {
    throw new Error(`국내 휴대폰 번호 형식이 아닙니다: ${raw}`);
  }

  return { digits, masked: `${digits.slice(0, 3)}-****-${digits.slice(-4)}` };
}

/* ─────────────────────────────────────────────────────────────
 * 3. 발송 시뮬레이터
 * ───────────────────────────────────────────────────────────── */

export type AlimtalkStatus = "queued" | "accepted" | "sent" | "delivered" | "failed" | "fallback_sent";

export type SendScenario =
  | "success"
  | "ack-timeout"
  | "template-mismatch"
  | "auth-failure"
  | "rate-limit"
  | "sms-failover";

export interface SensScenarioMeta {
  id: SendScenario;
  label: string;
  hint: string;
}

export const SEND_SCENARIOS: SensScenarioMeta[] = [
  { id: "success", label: "정상 수락 (202)", hint: "request_id·message_id를 받고 accepted로 기록" },
  { id: "ack-timeout", label: "수신 결과 불확실 (3005)", hint: "성공도 실패도 아닌 sent 상태로 남김" },
  { id: "template-mismatch", label: "템플릿 불일치 (3016)", hint: "검수된 본문과 다르면 거절 — 재시도해도 실패" },
  { id: "auth-failure", label: "서명 오류 (401)", hint: "액세스 키·서명·서버 시각 문제" },
  { id: "rate-limit", label: "호출 한도 초과 (429)", hint: "재시도하면 성공하는 일시 오류" },
  { id: "sms-failover", label: "카톡 미가입 → SMS 대체", hint: "fallback_sent로 남고 문자로 발송" },
];

/** SENS가 실제로 돌려주는 코드·문구. 시뮬레이터도 같은 코드를 쓴다. */
export const SENS_ERRORS: Record<Exclude<SendScenario, "success" | "ack-timeout" | "sms-failover">, { code: string; message: string; retryable: boolean }> = {
  "template-mismatch": { code: "3016", message: "NoMatchedTemplate: 템플릿 본문이 검수본과 일치하지 않습니다.", retryable: false },
  "auth-failure": { code: "401", message: "Signature mismatch: 서명이 유효하지 않습니다(액세스 키·timestamp 확인).", retryable: false },
  "rate-limit": { code: "429", message: "Too many requests: 호출 한도를 초과했습니다.", retryable: true },
};

export interface SensSendSuccess {
  scenario: SendScenario;
  /** SENS 응답의 묶음 요청 아이디 */
  requestId: string;
  /** 건별 메시지 아이디 — 수신 결과 조회 키 */
  messageId: string;
  /** 수신 결과 코드 (0000=정상, 3005=성공 불확실) */
  statusCode: string;
  statusDesc: string;
  status: Extract<AlimtalkStatus, "accepted" | "sent" | "fallback_sent" | "delivered">;
  /** 실제로는 보내지 않았다는 표시 */
  simulated: true;
}

export class SensSimulatedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SensSimulatedError";
  }
}

function pseudoId(prefix: string, seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let index = 0; index < seed.length; index += 1) {
    const code = seed.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
  }
  return `${prefix}-${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

export interface SensGatewayOptions {
  scenario?: SendScenario;
  /** 같은 입력이면 같은 응답이 나오도록 하는 시드 */
  seed?: string;
}

/**
 * SENS 발송 게이트웨이 시뮬레이터.
 *
 * 네트워크를 타지 않는다. 시나리오에 따라 SENS가 돌려줄 응답(코드·요청/메시지 아이디)을
 * 결정적으로 만들고, 실패 시에는 실제 오류 코드를 담은 예외를 던진다.
 */
export class SensSimulator {
  constructor(private options: SensGatewayOptions = {}) {}

  setScenario(scenario: SendScenario): void {
    this.options = { ...this.options, scenario };
  }

  get scenario(): SendScenario {
    return this.options.scenario ?? "success";
  }

  send(message: { to: string; content: string; templateCode: AlimtalkTemplateCode; plusFriendId: string }): SensSendSuccess {
    if (message.content.trim() === "") {
      throw new SensSimulatedError("4000", "알림톡 본문이 비어 있습니다.", false);
    }
    if (message.content.length > ALIMTALK_MAX_CONTENT_LENGTH) {
      throw new SensSimulatedError("4001", `알림톡 본문은 1,000자를 넘을 수 없습니다: ${message.content.length}자`, false);
    }

    const scenario = this.scenario;
    const seed = this.options.seed ?? `${message.templateCode}:${message.to}`;
    const requestId = pseudoId("req", seed);
    const messageId = pseudoId("msg", `${seed}:${message.content.length}`);

    if (scenario === "template-mismatch" || scenario === "auth-failure" || scenario === "rate-limit") {
      const error = SENS_ERRORS[scenario];
      // 오류 메시지에 코드를 같이 남긴다 — DB error_message를 보고 원인을 바로 알기 위해서다.
      throw new SensSimulatedError(error.code, `${error.code} ${error.message}`, error.retryable);
    }

    if (scenario === "ack-timeout") {
      return {
        scenario,
        requestId,
        messageId,
        statusCode: "3005",
        statusDesc: "AckTimeout: 수신 결과를 확정하지 못했습니다.",
        status: "sent",
        simulated: true,
      };
    }

    if (scenario === "sms-failover") {
      return {
        scenario,
        requestId,
        messageId,
        statusCode: "0000",
        statusDesc: "카카오톡 미가입 수신자 — SMS 대체 발송",
        status: "fallback_sent",
        simulated: true,
      };
    }

    return {
      scenario: "success",
      requestId,
      messageId,
      statusCode: "0000",
      statusDesc: "정상 수락",
      status: "accepted",
      simulated: true,
    };
  }
}

/* ─────────────────────────────────────────────────────────────
 * 4. 발송 이력 (로그)
 * ───────────────────────────────────────────────────────────── */

export interface AlimtalkLogEntry {
  id: string;
  dedupeKey: string;
  tenantId: number;
  tenantName: string;
  batchId: string;
  templateCode: AlimtalkTemplateCode;
  plusFriendId: string;
  recipientDigits: string;
  recipientMasked: string;
  orderNo?: string;
  anomalyCode?: AnomalyCode;
  content: string;
  status: AlimtalkStatus;
  attempts: number;
  requestId?: string;
  messageId?: string;
  statusCode?: string;
  statusDesc?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  /** 시뮬레이션 발송임을 행 단위로도 남긴다 */
  simulated: true;
}

export interface DispatchConfig {
  tenantId: number;
  plusFriendId: string;
  consoleUrl?: string;
}

export interface DispatchResult {
  sent: number;
  skipped: number;
  failed: number;
  errors: string[];
  logs: AlimtalkLogEntry[];
}

function nextId(logs: readonly AlimtalkLogEntry[]): string {
  const max = logs.reduce((acc, entry) => {
    const numeric = Number(entry.id.replace(/\D/g, ""));
    return Number.isFinite(numeric) ? Math.max(acc, numeric) : acc;
  }, 0);
  return `alt-${String(max + 1).padStart(5, "0")}`;
}

/** 대사 결과에서 이상 알림 후보를 만든다(심각도 critical만, 주문당 최대 2건). */
export function collectCriticalAlerts(rows: readonly ReconciledRow[]): AnomalyAlertInput[] {
  const alerts: AnomalyAlertInput[] = [];
  const perOrder = new Map<string, number>();

  for (const row of rows) {
    if (row.reconciled) continue;
    for (const anomaly of row.anomalies) {
      if (anomaly.severity !== "critical") continue;
      const used = perOrder.get(row.row.orderNo) ?? 0;
      if (used >= MAX_ALERTS_PER_ORDER) break;
      perOrder.set(row.row.orderNo, used + 1);

      alerts.push({
        tenantName: "셀러스코프 데모",
        orderNo: row.row.orderNo,
        productName: row.row.productName,
        anomalyCode: anomaly.code,
        anomalyLabel: ANOMALY_META[anomaly.code]?.label ?? anomaly.label,
        expected: anomaly.expected,
        actual: anomaly.actual,
        loss: anomaly.loss,
        detail: anomaly.detail,
      });
    }
  }

  return alerts;
}

/**
 * 이상 알림 발송 (PHP `SettlementAlertNotifier::notifyCriticalAnomalies`와 같은 순서)
 *
 *   1. dedupe_key 확인 → 이미 있으면 skip
 *   2. queued로 선적재 (발송 전에 죽어도 "보내려 했다"가 남는다)
 *   3. 발송 → 성공이면 accepted/sent/fallback_sent, 실패면 failed + error
 *   4. 실패는 재시도 가능 여부를 남긴다(429는 재시도, 3016·401은 사람이 고쳐야 한다)
 */
export function dispatchAnomalyAlerts(params: {
  logs: readonly AlimtalkLogEntry[];
  alerts: readonly AnomalyAlertInput[];
  to: NormalizedPhone;
  config: DispatchConfig;
  gateway: SensSimulator;
  now: number;
  batchId: string;
}): DispatchResult {
  const logs = params.logs.map((entry) => ({ ...entry }));
  const seen = new Set(logs.map((entry) => entry.dedupeKey));
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const alert of params.alerts) {
    const dedupeKey = dedupeKeyForAnomaly(params.config.tenantId, alert.orderNo, alert.anomalyCode);
    if (seen.has(dedupeKey)) {
      skipped += 1;
      continue;
    }

    const content = composeAnomalyContent(alert);
    const entry: AlimtalkLogEntry = {
      id: nextId(logs),
      dedupeKey,
      tenantId: params.config.tenantId,
      tenantName: alert.tenantName,
      batchId: params.batchId,
      templateCode: "SS_ANOMALY_CRITICAL",
      plusFriendId: params.config.plusFriendId,
      recipientDigits: params.to.digits,
      recipientMasked: params.to.masked,
      orderNo: alert.orderNo,
      anomalyCode: alert.anomalyCode,
      content,
      status: "queued",
      attempts: 0,
      createdAt: params.now,
      updatedAt: params.now,
      simulated: true,
    };

    seen.add(dedupeKey);

    try {
      entry.attempts = 1;
      const result = params.gateway.send({
        to: params.to.digits,
        content,
        templateCode: "SS_ANOMALY_CRITICAL",
        plusFriendId: params.config.plusFriendId,
      });
      entry.status = result.status;
      entry.requestId = result.requestId;
      entry.messageId = result.messageId;
      entry.statusCode = result.statusCode;
      entry.statusDesc = result.statusDesc;
      sent += 1;
    } catch (error) {
      entry.status = "failed";
      entry.error = error instanceof Error ? error.message : "알 수 없는 오류";
      entry.statusCode = error instanceof SensSimulatedError ? error.code : undefined;
      failed += 1;
      errors.push(entry.error);
    }

    logs.push({ ...entry, updatedAt: params.now });
  }

  return { sent, skipped, failed, errors, logs };
}

/** 배치 요약 알림(배치당 1통). */
export function dispatchBatchSummary(params: {
  logs: readonly AlimtalkLogEntry[];
  summary: { totalRows: number; flaggedRows: number; totalLeak: number; topCause: string | null };
  to: NormalizedPhone;
  config: DispatchConfig;
  gateway: SensSimulator;
  now: number;
  batchId: string;
  batchLabel: string;
}): DispatchResult {
  const logs = params.logs.map((entry) => ({ ...entry }));
  const dedupeKey = dedupeKeyForSummary(params.config.tenantId, params.batchId);

  if (logs.some((entry) => entry.dedupeKey === dedupeKey)) {
    return { sent: 0, skipped: 1, failed: 0, errors: [], logs };
  }

  const content = composeSummaryContent({
    tenantName: "셀러스코프 데모",
    batchLabel: params.batchLabel,
    totalRows: params.summary.totalRows,
    flaggedRows: params.summary.flaggedRows,
    totalLeak: params.summary.totalLeak,
    topCause: params.summary.topCause,
    consoleUrl: params.config.consoleUrl,
  });

  const entry: AlimtalkLogEntry = {
    id: nextId(logs),
    dedupeKey,
    tenantId: params.config.tenantId,
    tenantName: "셀러스코프 데모",
    batchId: params.batchId,
    templateCode: "SS_BATCH_SUMMARY",
    plusFriendId: params.config.plusFriendId,
    recipientDigits: params.to.digits,
    recipientMasked: params.to.masked,
    content,
    status: "queued",
    attempts: 0,
    createdAt: params.now,
    updatedAt: params.now,
    simulated: true,
  };

  try {
    entry.attempts = 1;
    const result = params.gateway.send({
      to: params.to.digits,
      content,
      templateCode: "SS_BATCH_SUMMARY",
      plusFriendId: params.config.plusFriendId,
    });
    entry.status = result.status;
    entry.requestId = result.requestId;
    entry.messageId = result.messageId;
    entry.statusCode = result.statusCode;
    entry.statusDesc = result.statusDesc;
    logs.push({ ...entry, updatedAt: params.now });
    return { sent: 1, skipped: 0, failed: 0, errors: [], logs };
  } catch (error) {
    entry.status = "failed";
    entry.error = error instanceof Error ? error.message : "알 수 없는 오류";
    entry.statusCode = error instanceof SensSimulatedError ? error.code : undefined;
    logs.push({ ...entry, updatedAt: params.now });
    return { sent: 0, skipped: 0, failed: 1, errors: [entry.error], logs };
  }
}

/**
 * 실패 건 재시도.
 *
 * 재시도 워커의 조건(DB: `status IN ('queued','failed') AND attempts < 3`)을 그대로 쓴다.
 * 3회를 넘기면 더 시도하지 않고, 실패 사유를 남긴 채 목록에 남긴다 — 무한 재시도는
 * 카카오 채널 평판을 떨어뜨린다.
 */
export function retryAlimtalk(params: {
  logs: readonly AlimtalkLogEntry[];
  logId: string;
  gateway: SensSimulator;
  now: number;
}): { log: AlimtalkLogEntry | null; logs: AlimtalkLogEntry[]; reason?: string } {
  const logs = params.logs.map((entry) => ({ ...entry }));
  const target = logs.find((entry) => entry.id === params.logId);
  if (!target) return { log: null, logs, reason: "발송 이력을 찾을 수 없습니다." };
  if (target.attempts >= MAX_SEND_ATTEMPTS) {
    return { log: target, logs, reason: `재시도 상한(${MAX_SEND_ATTEMPTS}회)에 도달했습니다.` };
  }
  if (target.status === "accepted" || target.status === "delivered" || target.status === "fallback_sent" || target.status === "sent") {
    return { log: target, logs, reason: "이미 발송이 끝난 건입니다." };
  }

  target.attempts += 1;
  target.updatedAt = params.now;

  try {
    const result = params.gateway.send({
      to: target.recipientDigits,
      content: target.content,
      templateCode: target.templateCode,
      plusFriendId: target.plusFriendId,
    });
    target.status = result.status;
    target.requestId = result.requestId;
    target.messageId = result.messageId;
    target.statusCode = result.statusCode;
    target.statusDesc = result.statusDesc;
    target.error = undefined;
  } catch (error) {
    target.status = "failed";
    target.error = error instanceof Error ? error.message : "알 수 없는 오류";
    target.statusCode = error instanceof SensSimulatedError ? error.code : undefined;
  }

  return { log: target, logs };
}

/** 이력 통계 — 성공률은 accepted/delivered/fallback_sent만 성공으로 센다(sent는 불확실). */
export function summarizeAlimtalkLogs(logs: readonly AlimtalkLogEntry[]): {
  total: number;
  accepted: number;
  failed: number;
  queued: number;
  uncertain: number;
  successRate: number;
} {
  const accepted = logs.filter((entry) => entry.status === "accepted" || entry.status === "delivered" || entry.status === "fallback_sent").length;
  const failed = logs.filter((entry) => entry.status === "failed").length;
  const queued = logs.filter((entry) => entry.status === "queued").length;
  const uncertain = logs.filter((entry) => entry.status === "sent").length;
  const attempted = accepted + failed + uncertain;

  return {
    total: logs.length,
    accepted,
    failed,
    queued,
    uncertain,
    successRate: attempted === 0 ? 0 : Math.round((accepted / attempted) * 1000) / 10,
  };
}
