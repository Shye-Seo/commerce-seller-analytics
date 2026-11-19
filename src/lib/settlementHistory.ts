/**
 * 정산 이력 저장소 (Settlement history store)
 *
 * 매월 대사 결과를 남겨 두면 "지난달보다 나아졌는가"를 다음 달에 바로 비교할 수 있다. 서버 세션이
 * 없는 데모이므로 브라우저 localStorage에 보관하고, 화면은 이 모듈을 통해서만 읽고 쓴다.
 *
 * 설계 원칙
 * ---------
 * - **스키마 버전이 다르면 읽지 않는다.** 대사 요약의 필드 이름이 바뀐 뒤 옛 레코드를 그대로 읽으면
 *   화면이 조용히 틀린 숫자를 비교한다. 버전이 다르면 빈 이력으로 시작한다.
 * - **읽은 값은 다시 검증한다.** localStorage는 사용자가 직접 고칠 수 있는 저장소다. 숫자가 아닌
 *   값이 하나라도 섞인 레코드는 통째로 버리고, 비교에 필요한 필드만 추려 새 객체로 만든다.
 * - **저장 공간이 없어도 죽지 않는다.** Safari 프라이빗 모드·SSR·용량 초과에서는 쓰기가 예외를
 *   던진다. `saveSnapshot`은 `{ok:false}`를 돌려주고 화면은 안내 문구만 띄운다.
 * - **오래된 달은 버린다.** 테넌트당 24개월, 전체 120레코드까지만 남긴다. 정산 비교에 2년 전
 *   숫자는 필요 없고, 용량 초과로 저장 자체가 실패하는 편이 더 나쁘다.
 */

import {
  ANOMALY_META,
  type AnomalyCode,
  type ChannelSummary,
  type MarketChannel,
  type ReconciliationSummary,
} from "./reconciliationEngine";
import { isValidMonth, toSnapshotSummary, type SnapshotSummary } from "./periodComparison";

export const HISTORY_STORAGE_KEY = "sellerscope.settlement-history.v1";
export const HISTORY_SCHEMA_VERSION = 1;
export const HISTORY_MAX_MONTHS_PER_TENANT = 24;
export const HISTORY_MAX_RECORDS = 120;

export type SnapshotSource = "generated" | "upload" | "api" | "demo";

const SOURCES: SnapshotSource[] = ["generated", "upload", "api", "demo"];
const CHANNELS: MarketChannel[] = ["smartstore", "coupang", "elevenst", "gmarket"];
const ANOMALY_CODES = Object.keys(ANOMALY_META) as AnomalyCode[];

export interface SettlementMonthSnapshot {
  version: number;
  tenantId: string;
  /** YYYY-MM */
  month: string;
  /** 저장 시각(ISO) */
  savedAt: string;
  source: SnapshotSource;
  /** 화면에 그대로 보여 줄 데이터 출처 설명 */
  label: string;
  summary: SnapshotSummary;
}

/** localStorage와 메모리 저장소를 같은 시그니처로 다룬다(테스트에서 메모리를 넣는다) */
export interface HistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/* ------------------------------------------------------------------ */
/* 값 검증                                                             */
/* ------------------------------------------------------------------ */

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function integer(value: unknown, fallback = 0): number {
  return Math.round(finiteNumber(value, fallback));
}

function normalizeChannels(value: unknown): ChannelSummary[] {
  if (!Array.isArray(value)) return [];
  const byChannel = new Map<MarketChannel, ChannelSummary>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const channel = record.channel;
    if (typeof channel !== "string" || !CHANNELS.includes(channel as MarketChannel)) continue;
    if (byChannel.has(channel as MarketChannel)) continue;
    byChannel.set(channel as MarketChannel, {
      channel: channel as MarketChannel,
      rows: integer(record.rows),
      paidAmount: integer(record.paidAmount),
      settledAmount: integer(record.settledAmount),
      leak: integer(record.leak),
      flaggedRows: integer(record.flaggedRows),
    });
  }
  return CHANNELS.map((channel) => byChannel.get(channel)).filter(
    (entry): entry is ChannelSummary => entry !== undefined,
  );
}

function normalizeCauseRecord(value: unknown): Record<AnomalyCode, number> {
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const normalized = {} as Record<AnomalyCode, number>;
  for (const code of ANOMALY_CODES) normalized[code] = integer(source[code]);
  return normalized;
}

/** 저장된 요약을 비교에 필요한 필드만 남겨 새 객체로 만든다. 형식이 어긋나면 null */
export function normalizeSnapshotSummary(value: unknown): SnapshotSummary | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.byChannel)) return null;
  if (typeof record.anomalyLoss !== "object" || record.anomalyLoss === null) return null;
  if (typeof record.anomalyCounts !== "object" || record.anomalyCounts === null) return null;

  return {
    totalRows: integer(record.totalRows),
    matchedRows: integer(record.matchedRows),
    flaggedRows: integer(record.flaggedRows),
    matchedRate: finiteNumber(record.matchedRate),
    totalPaidAmount: integer(record.totalPaidAmount),
    totalSettledAmount: integer(record.totalSettledAmount),
    expectedSettlement: integer(record.expectedSettlement),
    totalLeak: integer(record.totalLeak),
    totalSurplus: integer(record.totalSurplus),
    marginRiskExposure: integer(record.marginRiskExposure),
    negativeMarginRows: integer(record.negativeMarginRows),
    worstMarginRate: finiteNumber(record.worstMarginRate),
    anomalyCounts: normalizeCauseRecord(record.anomalyCounts),
    anomalyLoss: normalizeCauseRecord(record.anomalyLoss),
    byChannel: normalizeChannels(record.byChannel),
  };
}

function normalizeSnapshot(value: unknown): SettlementMonthSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== HISTORY_SCHEMA_VERSION) return null;
  if (typeof record.tenantId !== "string" || record.tenantId.trim() === "") return null;
  if (typeof record.month !== "string" || !isValidMonth(record.month)) return null;
  const savedAt = typeof record.savedAt === "string" ? record.savedAt : "";
  if (Number.isNaN(Date.parse(savedAt))) return null;
  const source = SOURCES.includes(record.source as SnapshotSource)
    ? (record.source as SnapshotSource)
    : "generated";
  const summary = normalizeSnapshotSummary(record.summary);
  if (summary === null) return null;

  return {
    version: HISTORY_SCHEMA_VERSION,
    tenantId: record.tenantId,
    month: record.month,
    savedAt,
    source,
    label: typeof record.label === "string" ? record.label.slice(0, 160) : "",
    summary,
  };
}

/* ------------------------------------------------------------------ */
/* 직렬화                                                              */
/* ------------------------------------------------------------------ */

/** 한 달치 스냅숏 생성. 대사 요약에서 필요한 값만 추린다. */
export function createSnapshot(input: {
  tenantId: string;
  month: string;
  summary: ReconciliationSummary;
  source?: SnapshotSource;
  label?: string;
  savedAt?: Date | string;
}): SettlementMonthSnapshot {
  if (!isValidMonth(input.month)) {
    throw new RangeError(`월 형식은 YYYY-MM 입니다: ${input.month}`);
  }
  const savedAt =
    input.savedAt instanceof Date
      ? input.savedAt.toISOString()
      : typeof input.savedAt === "string"
        ? new Date(input.savedAt).toISOString()
        : new Date().toISOString();
  return {
    version: HISTORY_SCHEMA_VERSION,
    tenantId: input.tenantId,
    month: input.month,
    savedAt,
    source: input.source ?? "generated",
    label: input.label ?? "",
    summary: toSnapshotSummary(input.summary),
  };
}

/** 저장 문자열 → 이력. 깨진 레코드는 버리고 나머지로 계속 간다. */
export function parseHistory(raw: string | null): SettlementMonthSnapshot[] {
  if (!raw) return [];
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null && Array.isArray((payload as { snapshots?: unknown }).snapshots)
      ? (payload as { snapshots: unknown[] }).snapshots
      : [];
  const snapshots: SettlementMonthSnapshot[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const snapshot = normalizeSnapshot(entry);
    if (snapshot === null) continue;
    const key = `${snapshot.tenantId}::${snapshot.month}`;
    if (seen.has(key)) continue;
    seen.add(key);
    snapshots.push(snapshot);
  }
  return trimHistory(sortSnapshots(snapshots));
}

export function serializeHistory(snapshots: readonly SettlementMonthSnapshot[]): string {
  return JSON.stringify({ version: HISTORY_SCHEMA_VERSION, snapshots });
}

function sortSnapshots(snapshots: SettlementMonthSnapshot[]): SettlementMonthSnapshot[] {
  return [...snapshots].sort((left, right) => {
    if (left.month !== right.month) return left.month < right.month ? 1 : -1;
    if (left.tenantId !== right.tenantId) return left.tenantId < right.tenantId ? -1 : 1;
    return left.savedAt < right.savedAt ? 1 : -1;
  });
}

/** 테넌트당 24개월 + 전체 120레코드까지만 남긴다(최신 우선). */
function trimHistory(snapshots: SettlementMonthSnapshot[]): SettlementMonthSnapshot[] {
  const perTenant = new Map<string, number>();
  const kept: SettlementMonthSnapshot[] = [];
  for (const snapshot of snapshots) {
    const count = perTenant.get(snapshot.tenantId) ?? 0;
    if (count >= HISTORY_MAX_MONTHS_PER_TENANT) continue;
    if (kept.length >= HISTORY_MAX_RECORDS) break;
    perTenant.set(snapshot.tenantId, count + 1);
    kept.push(snapshot);
  }
  return kept;
}

/** 같은 테넌트·같은 달은 덮어쓴다. 한 달을 여러 번 저장해도 레코드가 늘지 않는다. */
export function upsertSnapshot(
  snapshots: readonly SettlementMonthSnapshot[],
  snapshot: SettlementMonthSnapshot,
): { snapshots: SettlementMonthSnapshot[]; replaced: boolean } {
  const replaced = snapshots.some(
    (entry) => entry.tenantId === snapshot.tenantId && entry.month === snapshot.month,
  );
  const next = snapshots.filter(
    (entry) => !(entry.tenantId === snapshot.tenantId && entry.month === snapshot.month),
  );
  next.push(snapshot);
  return { snapshots: trimHistory(sortSnapshots(next)), replaced };
}

export function snapshotsForTenant(
  snapshots: readonly SettlementMonthSnapshot[],
  tenantId: string,
): SettlementMonthSnapshot[] {
  return sortSnapshots(snapshots.filter((entry) => entry.tenantId === tenantId));
}

/** 해당 월보다 앞선 가장 가까운 달. 없으면 null */
export function findPreviousSnapshot(
  snapshots: readonly SettlementMonthSnapshot[],
  tenantId: string,
  month: string,
): SettlementMonthSnapshot | null {
  const candidates = snapshotsForTenant(snapshots, tenantId).filter((entry) => entry.month < month);
  return candidates[0] ?? null;
}

export function removeSnapshot(
  snapshots: readonly SettlementMonthSnapshot[],
  tenantId: string,
  month: string,
): SettlementMonthSnapshot[] {
  return snapshots.filter((entry) => !(entry.tenantId === tenantId && entry.month === month));
}

/* ------------------------------------------------------------------ */
/* 저장소                                                              */
/* ------------------------------------------------------------------ */

/** 테스트·SSR용 메모리 저장소 */
export function createMemoryStorage(initial: Record<string, string> = {}): HistoryStorage & { dump(): Record<string, string> } {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    dump: () => Object.fromEntries(map.entries()),
  };
}

/** 브라우저 저장소. 접근이 막힌 환경(Safari 프라이빗, SSR)에서는 null */
export function resolveStorage(): HistoryStorage | null {
  try {
    if (typeof window === "undefined") return null;
    const storage = window.localStorage;
    const probe = "sellerscope.probe";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

export function readHistory(storage: HistoryStorage | null = resolveStorage()): SettlementMonthSnapshot[] {
  if (storage === null) return [];
  try {
    return parseHistory(storage.getItem(HISTORY_STORAGE_KEY));
  } catch {
    return [];
  }
}

export type SaveOutcome =
  | { ok: true; snapshots: SettlementMonthSnapshot[]; replaced: boolean }
  | { ok: false; reason: "unavailable" | "quota" | "unknown"; snapshots: SettlementMonthSnapshot[] };

export function saveSnapshot(
  snapshot: SettlementMonthSnapshot,
  storage: HistoryStorage | null = resolveStorage(),
): SaveOutcome {
  const current = readHistory(storage);
  const { snapshots, replaced } = upsertSnapshot(current, snapshot);
  if (storage === null) return { ok: false, reason: "unavailable", snapshots };
  try {
    storage.setItem(HISTORY_STORAGE_KEY, serializeHistory(snapshots));
    return { ok: true, snapshots, replaced };
  } catch (error) {
    const quota = error instanceof Error && /quota|exceed/i.test(`${error.name} ${error.message}`);
    return { ok: false, reason: quota ? "quota" : "unknown", snapshots: current };
  }
}

export function saveSnapshots(
  incoming: readonly SettlementMonthSnapshot[],
  storage: HistoryStorage | null = resolveStorage(),
): SaveOutcome {
  let merged = readHistory(storage);
  for (const snapshot of incoming) merged = upsertSnapshot(merged, snapshot).snapshots;
  if (storage === null) return { ok: false, reason: "unavailable", snapshots: merged };
  try {
    storage.setItem(HISTORY_STORAGE_KEY, serializeHistory(merged));
    return { ok: true, snapshots: merged, replaced: false };
  } catch (error) {
    const quota = error instanceof Error && /quota|exceed/i.test(`${error.name} ${error.message}`);
    return { ok: false, reason: quota ? "quota" : "unknown", snapshots: readHistory(storage) };
  }
}
