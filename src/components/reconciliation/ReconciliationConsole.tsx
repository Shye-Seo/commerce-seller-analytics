"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  ANOMALY_META,
  biggestLeakCause,
  reconcileSettlementInBatches,
  type AnomalyCode,
  type MarketChannel,
  type ReconciledRow,
  type ReconciliationSummary,
} from "@/lib/reconciliationEngine";
import { generateSettlementCsv, generateSettlementRows } from "@/lib/settlementFixtures";
import { formatThroughput, SettlementCsvSchemaError } from "@/lib/csvStreamParser";
import { parseSettlementFile } from "@/lib/settlementFileParser";
import TenantSwitchConsole from "./TenantSwitchConsole";
import ReconciliationVirtualTable, { matchesFilter, type RowFilterId } from "./ReconciliationVirtualTable";
import SettlementDetailDrawer from "./SettlementDetailDrawer";
import {
  AuditTrail,
  authorize,
  can,
  DEMO_TENANTS,
  maskAmount,
  ROLES,
  type AuditAction,
  type RoleId,
} from "@/lib/multiTenantRbac";
import { formatPercent, formatWon } from "@/lib/format";

/**
 * 정산 대사 콘솔 (클라이언트 셸)
 *
 * 이 컴포넌트가 오케스트레이션하는 것
 *  1. 테넌트/역할 컨텍스트와 RBAC 판정 (거부도 감사 로그에 남긴다)
 *  2. 데이터 유입: 데모 원장 생성 또는 CSV 업로드(Web Worker → 폴백)
 *  3. 배치 대사 + 진행률 + 처리량 계측
 *  4. 필터·검색·가상화 테이블·상세 드로어
 *  5. CSV 반출(권한 검사 후)
 *
 * 금액 계산은 전부 `reconciliationEngine`이 한다. 화면은 계산하지 않고 보여 주기만 한다.
 */

const DEMO_ROW_COUNT = 20_000;
const STRESS_ROW_COUNT = 100_000;
const BATCH_SIZE = 5_000;

type Phase = "idle" | "generating" | "parsing" | "reconciling" | "ready" | "error";

interface ProgressState {
  phase: Phase;
  percent: number;
  label: string;
}

interface DatasetInfo {
  source: "generated" | "upload";
  label: string;
  rowCount: number;
  engine: "generated" | "worker" | "main-thread";
  fallbackReason?: string;
  parseErrorCount: number;
  elapsedMs: number;
  rowsPerSecond: number;
  bytes: number;
}

const CHANNEL_LABEL: Record<MarketChannel, string> = {
  smartstore: "스마트스토어",
  coupang: "쿠팡",
  elevenst: "11번가",
  gmarket: "G마켓",
};

/** 테넌트마다 다른 정산 원장을 갖도록 시드를 파생한다 */
function seedForTenant(tenantId: string): number {
  let sum = 20261111;
  for (let index = 0; index < tenantId.length; index += 1) sum = (sum * 31 + tenantId.charCodeAt(index)) >>> 0;
  return sum;
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") {
      resolve();
      return;
    }
    window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
  });
}

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function KpiCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "default" | "danger" | "warn" | "good";
}) {
  const toneClass =
    tone === "danger"
      ? "text-rose-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "good"
          ? "text-emerald-300"
          : "text-white";
  return (
    <div className="card px-3.5 py-3">
      <p className="text-[10.5px] font-medium text-slate-500">{label}</p>
      <p className={`mt-1 text-[19px] font-semibold leading-tight tabular-nums ${toneClass}`}>{value}</p>
      <p className="mt-1 text-[10px] leading-snug text-slate-600">{hint}</p>
    </div>
  );
}

export default function ReconciliationConsole() {
  const [role, setRole] = useState<RoleId>("MASTER_ADMIN");
  const [tenantId, setTenantId] = useState<string>(DEMO_TENANTS[0]?.id ?? "tn-hq");
  const [rows, setRows] = useState<ReconciledRow[]>([]);
  const [summary, setSummary] = useState<ReconciliationSummary | null>(null);
  const [dataset, setDataset] = useState<DatasetInfo | null>(null);
  const [progress, setProgress] = useState<ProgressState>({ phase: "idle", percent: 0, label: "대기 중" });
  const [notice, setNotice] = useState<{ tone: "info" | "warn" | "error" | "success"; text: string } | null>(null);
  const [filter, setFilter] = useState<RowFilterId>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReconciledRow | null>(null);
  const [auditVersion, setAuditVersion] = useState(0);
  const [chainValid, setChainValid] = useState(true);

  const auditRef = useRef(new AuditTrail());
  const startedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const deferredQuery = useDeferredValue(query);

  const activeTenant = DEMO_TENANTS.find((tenant) => tenant.id === tenantId) ?? DEMO_TENANTS[0];
  const roleDefinition = ROLES[role];

  useEffect(() => {
    const result = auditRef.current.verify();
    setChainValid(result.valid);
  }, [auditVersion]);

  const log = useCallback(
    (
      action: AuditAction,
      target: string,
      detail?: string,
      outcome: "allowed" | "denied" = "allowed",
      context?: { role?: RoleId; tenantId?: string },
    ) => {
      auditRef.current.append({
        at: Date.now(),
        role: context?.role ?? role,
        tenantId: context?.tenantId ?? tenantId,
        action,
        target,
        detail,
        outcome,
      });
      setAuditVersion((value) => value + 1);
    },
    [role, tenantId],
  );

  const mask = useCallback(
    (value: number): string => {
      const level = roleDefinition.amountMask;
      return level === "none" ? formatWon(value) : maskAmount(value, level);
    },
    [roleDefinition.amountMask],
  );

  /** 데모 원장 생성 → 배치 대사 */
  const loadGenerated = useCallback(
    async (count: number, targetTenantId: string) => {
      setNotice(null);
      setProgress({ phase: "generating", percent: 4, label: `${count.toLocaleString("ko-KR")}건 정산 원장 생성 중` });
      await nextPaint();

      const raw = generateSettlementRows({ count, seed: seedForTenant(targetTenantId) });
      setProgress({ phase: "reconciling", percent: 12, label: "계약 조건으로 기대 정산액 재계산 중" });
      await nextPaint();

      const startedAt = Date.now();
      const result = await reconcileSettlementInBatches(raw, {
        batchSize: BATCH_SIZE,
        onProgress: (value) =>
          setProgress({
            phase: "reconciling",
            percent: 12 + Math.round(value.percent * 0.88),
            label: `${value.processed.toLocaleString("ko-KR")} / ${count.toLocaleString("ko-KR")}건 대사 · ${formatThroughput(value.rowsPerSecond)}`,
          }),
      });
      const elapsedMs = Date.now() - startedAt;

      setRows(result.rows);
      setSummary(result.summary);
      setDataset({
        source: "generated",
        label: `${count.toLocaleString("ko-KR")}건 데모 정산서 · ${new Date().toISOString().slice(0, 10)}`,
        rowCount: result.rows.length,
        engine: "generated",
        parseErrorCount: 0,
        elapsedMs,
        rowsPerSecond: Math.round((result.rows.length / Math.max(1, elapsedMs)) * 1000),
        bytes: 0,
      });
      setProgress({ phase: "ready", percent: 100, label: "대사 완료" });
      log("RECONCILE_RUN", `${count.toLocaleString("ko-KR")}건 데모 원장`, `이상 ${result.summary.flaggedRows.toLocaleString("ko-KR")}건 · 누수 ${formatWon(result.summary.totalLeak)}`, "allowed", { tenantId: targetTenantId });
    },
    [log],
  );

  // 최초 1회: 데모 원장 로드 (StrictMode의 effect 2회 호출 방지)
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void loadGenerated(DEMO_ROW_COUNT, DEMO_TENANTS[0]?.id ?? "tn-hq");
  }, [loadGenerated]);

  /** CSV 업로드 → 파싱(워커) → 대사 */
  const handleFile = useCallback(
    async (file: File) => {
      setNotice(null);
      setProgress({ phase: "parsing", percent: 2, label: `${file.name} 파싱 준비` });
      await nextPaint();

      try {
        const parsed = await parseSettlementFile(file, {
          onProgress: (value) =>
            setProgress({
              phase: "parsing",
              percent: Math.min(60, Math.round(value.percent * 0.6)),
              label: `${value.engine === "worker" ? "Web Worker" : "메인 스레드"} 파싱 · ${value.processedRows.toLocaleString("ko-KR")}행 · ${formatThroughput(value.rowsPerSecond)}`,
            }),
        });

        if (parsed.rows.length === 0) {
          setProgress({ phase: "error", percent: 0, label: "정산 행을 찾지 못했습니다" });
          setNotice({
            tone: "error",
            text:
              parsed.errorCount > 0
                ? `정산 행을 읽지 못했습니다. 오류 ${parsed.errorCount}건. 첫 오류: ${parsed.errors[0]?.message ?? "알 수 없음"}`
                : "파일에 정산 행이 없습니다. 헤더만 있거나 빈 파일인지 확인해 주세요.",
          });
          return;
        }

        setProgress({ phase: "reconciling", percent: 62, label: "계약 조건으로 기대 정산액 재계산 중" });
        await nextPaint();

        const startedAt = Date.now();
        const result = await reconcileSettlementInBatches(parsed.rows, {
          batchSize: BATCH_SIZE,
          parseErrorCount: parsed.errorCount,
          sourceRowCount: parsed.totalLines,
          onProgress: (value) =>
            setProgress({
              phase: "reconciling",
              percent: 62 + Math.round(value.percent * 0.38),
              label: `${value.processed.toLocaleString("ko-KR")} / ${parsed.rows.length.toLocaleString("ko-KR")}건 대사`,
            }),
        });
        const elapsedMs = Date.now() - startedAt;

        setRows(result.rows);
        setSummary(result.summary);
        setDataset({
          source: "upload",
          label: file.name,
          rowCount: result.rows.length,
          engine: parsed.meta.engine,
          fallbackReason: parsed.meta.engineFallbackReason,
          parseErrorCount: parsed.errorCount,
          elapsedMs: parsed.meta.elapsedMs + elapsedMs,
          rowsPerSecond: parsed.meta.rowsPerSecond,
          bytes: parsed.meta.bytesRead,
        });
        setProgress({ phase: "ready", percent: 100, label: "대사 완료" });
        setNotice({
          tone: parsed.errorCount > 0 ? "warn" : "success",
          text:
            parsed.errorCount > 0
              ? `${result.rows.length.toLocaleString("ko-KR")}건 대사 완료. 오류 ${parsed.errorCount}건은 격리하고 나머지로 계속 계산했습니다.`
              : `${result.rows.length.toLocaleString("ko-KR")}건 대사 완료. 누수 ${formatWon(result.summary.totalLeak)}를 찾았습니다.`,
        });
        log(
          "RECONCILE_RUN",
          file.name,
          `${parsed.meta.engine} · ${result.rows.length.toLocaleString("ko-KR")}건 · 오류 ${parsed.errorCount}건`,
        );
      } catch (error) {
        const message =
          error instanceof SettlementCsvSchemaError
            ? `${error.message} (필수 열을 확인해 주세요)`
            : error instanceof Error
              ? error.message
              : "알 수 없는 오류";
        setProgress({ phase: "error", percent: 0, label: "업로드 실패" });
        setNotice({ tone: "error", text: message });
      }
    },
    [log],
  );

  const handleTenantChange = (nextTenantId: string): void => {
    if (nextTenantId === tenantId) return;
    if (busy) {
      setNotice({ tone: "info", text: "대사가 진행 중입니다. 완료된 뒤에 법인을 전환해 주세요." });
      return;
    }
    const decision = authorize({ role, activeTenantId: tenantId, targetTenantId: nextTenantId, action: "tenant.switch" });
    if (!decision.allowed) {
      log("TENANT_SWITCH", nextTenantId, decision.reason, "denied");
      setNotice({ tone: "warn", text: decision.reason });
      return;
    }
    setTenantId(nextTenantId);
    setSelected(null);
    log("TENANT_SWITCH", nextTenantId, "법인 전환");
    void loadGenerated(dataset?.rowCount ?? DEMO_ROW_COUNT, nextTenantId);
  };

  const handleRoleChange = (nextRole: RoleId): void => {
    if (nextRole === role) return;
    setRole(nextRole);
    auditRef.current.append({
      at: Date.now(),
      role: nextRole,
      tenantId,
      action: "ROLE_CHANGE",
      target: ROLES[nextRole].label,
      detail: `${ROLES[role].label} → ${ROLES[nextRole].label}`,
    });
    setAuditVersion((value) => value + 1);
  };

  const handleSelect = (item: ReconciledRow): void => {
    setSelected(item);
    log("VIEW_ROW", item.row.orderNo, `${item.anomalies.length}건 이상`);
  };

  const handleExport = (): void => {
    const decision = authorize({ role, activeTenantId: tenantId, action: "export.csv" });
    if (!decision.allowed) {
      log("EXPORT_CSV", "이상 내역", decision.reason, "denied");
      setNotice({ tone: "warn", text: `반출이 거부되었습니다. ${decision.reason}` });
      return;
    }
    if (!summary) return;

    const header = "주문번호,채널,주문일,상품명,SKU,실정산액,기대정산액,차액,원인,귀속손실";
    const lines = rows
      .filter((item) => item.anomalies.length > 0)
      .map((item) =>
        [
          item.row.orderNo,
          item.row.channel,
          item.row.orderDate,
          `"${item.row.productName.replace(/"/g, '""')}"`,
          item.row.sku,
          item.actualSettlement,
          item.expectedSettlement,
          item.variance,
          `"${item.anomalies.map((anomaly) => anomaly.label).join(" / ")}"`,
          item.loss,
        ].join(","),
      );

    downloadText(`정산대사_이상내역_${new Date().toISOString().slice(0, 10)}.csv`, [header, ...lines].join("\n"));
    log("EXPORT_CSV", `이상 ${lines.length.toLocaleString("ko-KR")}건`, "권한 확인 후 반출");
    setNotice({ tone: "success", text: `이상 ${lines.length.toLocaleString("ko-KR")}건을 CSV로 내보냈습니다.` });
  };

  const handleExportAudit = (): void => {
    const decision = authorize({ role, activeTenantId: tenantId, action: "audit.read" });
    if (!decision.allowed) {
      log("AUDIT_VIEW", "감사 로그", decision.reason, "denied");
      setNotice({ tone: "warn", text: decision.reason });
      return;
    }
    try {
      downloadText(`감사로그_${new Date().toISOString().slice(0, 10)}.csv`, auditRef.current.toCsv(role));
      log("AUDIT_VIEW", `${auditRef.current.size}건`, "감사 로그 반출");
      setNotice({ tone: "success", text: "감사 로그를 CSV로 내보냈습니다." });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "반출 실패" });
    }
  };

  const downloadSample = (): void => {
    const sample = generateSettlementRows({ count: 500, seed: seedForTenant(tenantId) });
    downloadText(`정산서_샘플_500건.csv`, generateSettlementCsv(sample));
    log("EXPORT_CSV", "샘플 정산서 500건", "템플릿 다운로드");
  };

  const searchedRows = useMemo(() => {
    const keyword = deferredQuery.trim().toLowerCase();
    if (!keyword) return rows;
    return rows.filter(
      (item) =>
        item.row.orderNo.toLowerCase().includes(keyword) ||
        item.row.productName.toLowerCase().includes(keyword) ||
        item.row.sku.toLowerCase().includes(keyword),
    );
  }, [rows, deferredQuery]);

  const counts = useMemo(() => {
    const record: Record<RowFilterId, number> = { all: searchedRows.length, negative: 0, fee: 0, return: 0, shortfall: 0 };
    for (const id of ["negative", "fee", "return", "shortfall"] as RowFilterId[]) {
      record[id] = searchedRows.reduce((sum, item) => (matchesFilter(item, id) ? sum + 1 : sum), 0);
    }
    return record;
  }, [searchedRows]);

  const filteredRows = useMemo(
    () => (filter === "all" ? searchedRows : searchedRows.filter((item) => matchesFilter(item, filter))),
    [searchedRows, filter],
  );

  const lossBreakdown = useMemo(() => {
    if (!summary) return [];
    const total = summary.totalLeak || 1;
    return (Object.keys(summary.anomalyLoss) as AnomalyCode[])
      .map((code) => ({ code, amount: summary.anomalyLoss[code], meta: ANOMALY_META[code] }))
      .filter((entry) => entry.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 4)
      .map((entry) => ({ ...entry, share: (entry.amount / total) * 100 }));
  }, [summary]);

  const biggest = summary ? biggestLeakCause(summary) : null;
  const busy = progress.phase === "generating" || progress.phase === "parsing" || progress.phase === "reconciling";

  return (
    <div className="min-h-screen">
      <main className="mx-auto w-full max-w-[1440px] px-4 py-8 sm:px-6 lg:px-8">
        <section className="mb-6">
          <span className="chip">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
            B2B 정산 대사 · 이상 탐지 콘솔
          </span>
          <h1 className="mt-4 max-w-3xl text-[26px] font-semibold leading-[1.32] tracking-tight text-white sm:text-[32px]">
            정산서와 판매 원장이 어긋나는 순간을,
            <br className="hidden sm:block" /> <span className="text-emerald-300">계약 조건으로 다시 계산해</span> 찾아냅니다.
          </h1>
          <p className="mt-3 max-w-3xl text-[13.5px] leading-relaxed text-slate-400">
            10만 행 정산서를 Web Worker로 파싱하고, 계약 수수료율·배송비·반품비 기준의 기대 정산액과 실제 입금액을
            대사합니다. 차액은 수수료 초과·반품비 중복·정산 부족으로 <strong className="font-semibold text-slate-200">원인별 귀속</strong>되며,
            같은 돈을 두 번 세지 않습니다.
          </p>
          <div className="mt-4 flex flex-wrap gap-1.5">
            {["Web Worker 스트리밍 파서", "10만 행 가상화", "멀티 테넌트 RBAC", "해시체인 감사 로그", "배치 대사 엔진"].map((badge) => (
              <span key={badge} className="rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[10.5px] font-medium text-slate-400">
                {badge}
              </span>
            ))}
          </div>
        </section>

        {notice && (
          <div
            className={`mb-4 flex items-start justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-[12px] leading-relaxed ${
              notice.tone === "error"
                ? "border-rose-400/25 bg-rose-400/[0.07] text-rose-200"
                : notice.tone === "warn"
                  ? "border-amber-400/25 bg-amber-400/[0.07] text-amber-200"
                  : notice.tone === "success"
                    ? "border-emerald-400/25 bg-emerald-400/[0.07] text-emerald-200"
                    : "border-white/[0.08] bg-white/[0.03] text-slate-300"
            }`}
            role="status"
          >
            <span>{notice.text}</span>
            <button type="button" onClick={() => setNotice(null)} className="shrink-0 text-[11px] opacity-70 transition hover:opacity-100">
              닫기
            </button>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[286px_minmax(0,1fr)]">
          <div className="order-2 lg:order-1">
            <TenantSwitchConsole
              tenants={DEMO_TENANTS}
              activeTenantId={tenantId}
              role={role}
              onTenantChange={handleTenantChange}
              onRoleChange={handleRoleChange}
              auditEvents={[...auditRef.current.list()].reverse().slice(0, 6)}
              chainValid={chainValid}
              onExportAudit={handleExportAudit}
            />
          </div>

          <div className="order-1 space-y-4 lg:order-2">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-5">
              <KpiCard
                label="총 정산액"
                value={summary ? mask(summary.totalSettledAmount) : "—"}
                hint={`${activeTenant?.name.split(" ")[0] ?? "본사"} · 결제 ${summary ? mask(summary.totalPaidAmount) : "—"}`}
              />
              <KpiCard
                label="정상 대사율"
                value={summary ? formatPercent(summary.matchedRate, 1) : "—"}
                hint={summary ? `이상 ${summary.flaggedRows.toLocaleString("ko-KR")}건 / ${summary.totalRows.toLocaleString("ko-KR")}건` : "대기 중"}
                tone={summary ? (summary.matchedRate >= 80 ? "good" : summary.matchedRate >= 60 ? "warn" : "danger") : "default"}
              />
              <KpiCard
                label="누수 추정 손실액"
                value={summary ? mask(summary.totalLeak) : "—"}
                hint={biggest ? `최대 원인 · ${ANOMALY_META[biggest.code].label}` : "이상 없음"}
                tone="danger"
              />
              <KpiCard
                label="역마진 노출액"
                value={summary ? mask(summary.marginRiskExposure) : "—"}
                hint={summary ? `역마진 ${summary.negativeMarginRows.toLocaleString("ko-KR")}건 · 최저 ${formatPercent(summary.worstMarginRate, 1)}` : "대기 중"}
                tone="warn"
              />
              <KpiCard
                label="처리 성능"
                value={dataset ? formatThroughput(dataset.rowsPerSecond) : "—"}
                hint={dataset ? `${(dataset.elapsedMs / 1000).toFixed(2)}초 · 오류 ${dataset.parseErrorCount}건` : "대기 중"}
                tone="good"
              />
            </div>

            <section className="card p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400/80">Data pipeline</p>
                  <p className="mt-1 text-[12.5px] text-slate-300">
                    {dataset ? dataset.label : "데모 정산 원장을 준비하고 있습니다."}
                  </p>
                  <p className="mt-0.5 text-[10.5px] text-slate-500">
                    {dataset
                      ? `실행 경로 ${dataset.engine === "generated" ? "생성기" : dataset.engine === "worker" ? "Web Worker" : "메인 스레드 폴백"}${dataset.fallbackReason ? ` (${dataset.fallbackReason})` : ""} · 배치 ${BATCH_SIZE.toLocaleString("ko-KR")}건 단위`
                      : "계약 프리셋 · 스마트스토어 3.63% / 쿠팡 10.8% / 11번가 9% / G마켓 8.5%"}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void loadGenerated(DEMO_ROW_COUNT, tenantId)}
                    disabled={busy}
                    className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-medium text-slate-300 transition enabled:hover:border-white/20 enabled:hover:text-white disabled:opacity-40"
                  >
                    데모 2만 건
                  </button>
                  <button
                    type="button"
                    onClick={() => void loadGenerated(STRESS_ROW_COUNT, tenantId)}
                    disabled={busy}
                    className="rounded-lg border border-indigo-400/25 bg-indigo-400/10 px-2.5 py-1.5 text-[11px] font-medium text-indigo-200 transition enabled:hover:border-indigo-400/50 disabled:opacity-40"
                  >
                    10만 건 스트레스
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={busy}
                    className="rounded-lg bg-emerald-400 px-2.5 py-1.5 text-[11px] font-semibold text-ink-950 transition enabled:hover:bg-emerald-300 disabled:opacity-40"
                  >
                    CSV 업로드
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,text/csv"
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void handleFile(file);
                      event.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    onClick={handleExport}
                    disabled={!summary || busy}
                    className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-medium text-slate-300 transition enabled:hover:border-white/20 enabled:hover:text-white disabled:opacity-40"
                  >
                    이상 내역 CSV
                  </button>
                  <button
                    type="button"
                    onClick={downloadSample}
                    className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 text-[11px] text-slate-400 transition hover:border-white/15 hover:text-slate-200"
                  >
                    샘플 양식
                  </button>
                </div>
              </div>

              <div className="mt-3">
                <div className="flex items-center justify-between text-[10.5px] text-slate-500">
                  <span className="tabular-nums">{progress.label}</span>
                  <span className="tabular-nums">{progress.percent}%</span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className={`h-full rounded-full transition-[width] duration-300 ${
                      progress.phase === "error" ? "bg-rose-400" : busy ? "bg-emerald-400/80" : "bg-emerald-400"
                    }`}
                    style={{ width: `${Math.max(2, progress.percent)}%` }}
                    role="progressbar"
                    aria-valuenow={progress.percent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="대사 진행률"
                  />
                </div>
              </div>

              {lossBreakdown.length > 0 && (
                <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
                  {lossBreakdown.map((entry) => (
                    <div key={entry.code} className="rounded-lg border border-white/[0.05] bg-white/[0.015] px-2.5 py-1.5">
                      <div className="flex items-center justify-between text-[10.5px]">
                        <span className="text-slate-300">{entry.meta.label}</span>
                        <span className="tabular-nums text-slate-400">{mask(entry.amount)}</span>
                      </div>
                      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/[0.05]">
                        <div
                          className={`h-full rounded-full ${entry.meta.severity === "critical" ? "bg-rose-400/70" : "bg-amber-400/70"}`}
                          style={{ width: `${Math.max(3, Math.min(100, entry.share))}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <ReconciliationVirtualTable
              rows={filteredRows}
              role={role}
              filter={filter}
              onFilterChange={setFilter}
              counts={counts}
              query={query}
              onQueryChange={setQuery}
              onSelect={handleSelect}
              activeId={selected?.id}
              totalRows={rows.length}
            />

            {summary && (
              <section className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
                {summary.byChannel.map((channel) => (
                  <div key={channel.channel} className="card px-3.5 py-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] font-semibold text-slate-200">{CHANNEL_LABEL[channel.channel]}</span>
                      <span className="text-[10px] tabular-nums text-slate-500">{channel.rows.toLocaleString("ko-KR")}건</span>
                    </div>
                    <p className="mt-1 text-[15px] font-semibold tabular-nums text-white">{mask(channel.settledAmount)}</p>
                    <p className="mt-0.5 text-[10.5px] tabular-nums text-slate-500">
                      이상 {channel.flaggedRows.toLocaleString("ko-KR")}건 · 누수{" "}
                      <span className={channel.leak > 0 ? "text-rose-300" : "text-slate-500"}>{mask(channel.leak)}</span>
                    </p>
                  </div>
                ))}
              </section>
            )}

            <section className="card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400/80">Anomaly rules</p>
                <p className="text-[10px] text-slate-500">
                  {can(role, "settlement.amount") ? "정산액 열람 가능" : "정산액 부분 마스킹"} · {can(role, "cost.read") ? "원가 열람 가능" : "원가 차단"}
                </p>
              </div>
              <div className="mt-2 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                {(Object.keys(ANOMALY_META) as AnomalyCode[]).map((code) => {
                  const meta = ANOMALY_META[code];
                  const count = summary?.anomalyCounts[code] ?? 0;
                  const loss = summary?.anomalyLoss[code] ?? 0;
                  const active = code === biggest?.code;
                  return (
                    <div
                      key={code}
                      className={`rounded-lg border px-2.5 py-2 ${
                        active ? "border-rose-400/30 bg-rose-400/[0.06]" : "border-white/[0.05] bg-white/[0.015]"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[11px] font-medium text-slate-200">{meta.label}</span>
                        <span className="shrink-0 tabular-nums text-[10px] text-slate-500">{count.toLocaleString("ko-KR")}건</span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-slate-500">{meta.description}</p>
                      {loss > 0 && (
                        <p className="mt-1 text-[10px] tabular-nums text-rose-300/90">귀속 {mask(loss)}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>

            <p className="pb-6 text-[10.5px] leading-relaxed text-slate-600">
              계약 프리셋은 공개된 수수료 정책을 참고한 데모 값이며, 실제 계약서 값과 다를 수 있습니다. 데모 원장은 고정 시드로
              생성해 같은 조건이면 같은 결과가 나옵니다. 마스킹은 화면 표시에만 적용되고 원본 데이터는 변경되지 않습니다.
            </p>
          </div>
        </div>
      </main>

      <SettlementDetailDrawer item={selected} role={role} onClose={() => setSelected(null)} />

      <footer className="border-t border-white/[0.06] bg-ink-900/40">
        <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-2 px-4 py-6 text-[11px] text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <span> 서승혜 · Commerce SaaS Engineer · 정산 대사 &amp; 이상 탐지 플랫폼</span>
          <span className="flex flex-wrap gap-3">
            <a href="/" className="transition hover:text-slate-200">마진 분석 대시보드</a>
            <a href="https://github.com/Shye-Seo/commerce-seller-analytics" target="_blank" rel="noreferrer noopener" className="transition hover:text-slate-200">
              GitHub
            </a>
          </span>
        </div>
      </footer>
    </div>
  );
}
