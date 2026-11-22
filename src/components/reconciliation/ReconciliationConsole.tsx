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
import { generateSettlementCsv, generateSettlementRows, SETTLEMENT_SNAPSHOT_DATE } from "@/lib/settlementFixtures";
import { formatThroughput } from "@/lib/csvStreamParser";
import type { FileParseResult } from "@/lib/settlementFileParser";
import ReconciliationFileUploader from "./ReconciliationFileUploader";
import MarketApiSyncConsole from "./MarketApiSyncConsole";
import type { IntakeResult } from "@/lib/marketApiConnector";
import ReconciliationClaimPanel from "./ReconciliationClaimPanel";
import TenantSwitchConsole from "./TenantSwitchConsole";
import ReconciliationVirtualTable, { matchesFilter, type RowFilterId } from "./ReconciliationVirtualTable";
import SettlementDetailDrawer from "./SettlementDetailDrawer";
import AlertRuleBuilderPanel from "./AlertRuleBuilderPanel";
import CampaignAttributionPanel from "./CampaignAttributionPanel";
import PeriodComparisonPanel from "./PeriodComparisonPanel";
import AlimtalkConsole from "./AlimtalkConsole";
import {
  buildSettlementRowsForOrders,
  matchCouponSettlement,
  summarizeCampaignPerformance,
} from "@/lib/campaignBridge";
import {
  buildSettlementReceipts,
  defaultAlertRules,
  evaluateAlertRules,
  type AlertRuleConfig,
} from "@/lib/alertRules";
import { resetPromotionStore, promotionStore, setCampaignSpend, usePromotionSnapshot } from "@/lib/promotionStore";
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
import { monthOf } from "@/lib/periodComparison";
import { DEMO_ROW_COUNT, seedForTenant } from "@/lib/demoLedger";
import Drawer from "@/components/ui/Drawer";
import KpiStrip, { type KpiItem } from "@/components/ui/KpiStrip";
import { Panel } from "@/components/ui/KpiStrip";

/**
 * 정산 대사 콘솔 (클라이언트 셸)
 *
 * 이 컴포넌트가 오케스트레이션하는 것
 *  1. 테넌트/역할 컨텍스트와 RBAC 판정 (거부도 감사 로그에 남긴다)
 *  2. 데이터 유입: 데모 원장 생성 · 파일 업로드(`ReconciliationFileUploader`) · 마켓 API 수집
 *     (`MarketApiSyncConsole`) 세 경로. 셋 다 **같은 대사 엔진**으로 들어간다
 *  3. 배치 대사 + 진행률 + 처리량 계측
 *  4. 필터·검색·가상화 테이블·상세 드로어
 *  5. 반출: 이상 내역 CSV · 마켓 소명 리포트(`ReconciliationClaimPanel`) · 감사 로그
 *
 * 금액 계산은 전부 `reconciliationEngine`이 한다. 화면은 계산하지 않고 보여 주기만 한다.
 */

const STRESS_ROW_COUNT = 100_000;
const BATCH_SIZE = 5_000;

type Phase = "idle" | "generating" | "parsing" | "reconciling" | "ready" | "error";

interface ProgressState {
  phase: Phase;
  percent: number;
  label: string;
}

type IntakeMode = "file" | "api";

interface DatasetInfo {
  source: "generated" | "upload" | "api";
  label: string;
  rowCount: number;
  engine: "generated" | "worker" | "main-thread" | "api";
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

export type ReconSection = "overview" | "rows" | "intake" | "export" | "trend";

export default function ReconciliationConsole({ section = "overview" }: { section?: ReconSection } = {}) {
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
  // 경보 룰은 화면 상태다. 룰을 바꾸면 아래 useMemo가 같은 행 집합을 다시 평가한다.
  const [alertRules, setAlertRules] = useState<AlertRuleConfig[]>(defaultAlertRules);
  const [chainValid, setChainValid] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const auditRef = useRef(new AuditTrail());
  const startedRef = useRef(false);
  const deferredQuery = useDeferredValue(query);
  const [uploading, setUploading] = useState(false);
  const [intakeMode, setIntakeMode] = useState<IntakeMode>("file");

  // 쿠폰 콘솔에서 저장한 공유 원장. 대사 행과 주문번호로 맞춰 쿠폰 비용·ROAS를 낸다.
  const promotion = usePromotionSnapshot();

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

      // 쿠폰 사용 주문은 별도 원장이 아니라 "정산서에 함께 들어온 행"으로 취급한다.
      // 그래야 대사·필터·반출이 한 파이프라인으로 돌고, 쿠폰 비용도 같은 기준으로 계산된다.
      // 원장은 훅이 아니라 스토어에서 직접 읽는다. 이 함수는 첫 마운트 이펙트에서 돌기 때문에,
      // 하이드레이션 직전의 빈 서버 스냅숏을 문 상태로 계산하면 쿠폰 주문을 통과버리게 된다.
      const couponRows = buildSettlementRowsForOrders(promotionStore().read().orders);
      const raw = [...couponRows, ...generateSettlementRows({ count, seed: seedForTenant(targetTenantId) })];
      setProgress({ phase: "reconciling", percent: 12, label: "계약 조건으로 기대 정산액 재계산 중" });
      await nextPaint();

      const startedAt = Date.now();
      const result = await reconcileSettlementInBatches(raw, {
        batchSize: BATCH_SIZE,
        onProgress: (value) =>
          setProgress({
            phase: "reconciling",
            percent: 12 + Math.round(value.percent * 0.88),
            label: `${value.processed.toLocaleString("ko-KR")} / ${raw.length.toLocaleString("ko-KR")}건 대사 · ${formatThroughput(value.rowsPerSecond)}`,
          }),
      });
      const elapsedMs = Date.now() - startedAt;

      setRows(result.rows);
      setSummary(result.summary);
      setDataset({
        source: "generated",
        label: `${count.toLocaleString("ko-KR")}건 정산서${couponRows.length > 0 ? ` + 쿠폰 주문 ${couponRows.length.toLocaleString("ko-KR")}건` : ""} · ${new Date().toISOString().slice(0, 10)}`,
        rowCount: result.rows.length,
        engine: "generated",
        parseErrorCount: 0,
        elapsedMs,
        rowsPerSecond: Math.round((result.rows.length / Math.max(1, elapsedMs)) * 1000),
        bytes: 0,
      });
      setProgress({ phase: "ready", percent: 100, label: "대사 완료" });
      log("RECONCILE_RUN", `${count.toLocaleString("ko-KR")}건 정산 원장`, `이상 ${result.summary.flaggedRows.toLocaleString("ko-KR")}건 · 누수 ${formatWon(result.summary.totalLeak)}`, "allowed", { tenantId: targetTenantId });
    },
    [log],
  );

  // 최초 1회: 데모 원장 로드 (StrictMode의 effect 2회 호출 방지)
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void loadGenerated(DEMO_ROW_COUNT, DEMO_TENANTS[0]?.id ?? "tn-hq");
  }, [loadGenerated]);

  /**
   * 파싱된 파일 → 대사 실행.
   * 파일 검증과 파싱은 업로더 컴포넌트가 끝내고 결과만 넘긴다. 여기서는 대사에만 집중한다.
   */
  const handleParsed = useCallback(
    async (parsed: FileParseResult, file: File) => {
      setNotice(null);

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

      try {
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
        setSelected(null);
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
          `${parsed.meta.engine} · ${result.rows.length.toLocaleString("ko-KR")}건 · 오류 ${parsed.errorCount}건 · 누수 ${formatWon(result.summary.totalLeak)}`,
        );
      } catch (error) {
        setProgress({ phase: "error", percent: 0, label: "대사 실패" });
        setNotice({ tone: "error", text: error instanceof Error ? error.message : "알 수 없는 오류" });
      }
    },
    [log],
  );

  /**
   * 마켓 API 수집 결과 → 화면 반영.
   * 수집·원장 결합·대사는 `MarketApiSyncConsole`이 끝내고 넘긴다. 여기서는 파일 업로드와 같은
   * 화면 상태(rows/summary/dataset)·감사 기록만 맞춘다. 두 경로의 결과 모양이 같아야 하므로
   * 엔진 호출을 여기서 다시 하지 않는다.
   */
  const handleApiCollected = useCallback(
    (result: IntakeResult) => {
      setRows(result.reconciled.rows);
      setSummary(result.reconciled.summary);
      setSelected(null);
      setDataset({
        source: "api",
        label: `${result.provider === "coupang" ? "쿠팡" : "스마트스토어"} API · ${result.month}`,
        rowCount: result.reconciled.rows.length,
        engine: "api",
        parseErrorCount: result.meta.droppedRecords,
        elapsedMs: result.meta.elapsedMs,
        rowsPerSecond: Math.round((result.reconciled.rows.length / Math.max(1, result.meta.elapsedMs)) * 1000),
        bytes: 0,
      });
      setProgress({ phase: "ready", percent: 100, label: "API 수집 · 대사 완료" });
      log(
        "RECONCILE_RUN",
        `${result.provider} API ${result.month}`,
        `${result.records.length.toLocaleString("ko-KR")}건 · 원장 누락 ${result.meta.ledgerMisses}건 · 누수 ${formatWon(result.reconciled.summary.totalLeak)}`,
        "allowed",
        { tenantId },
      );
    },
    [log, tenantId],
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
    downloadText(`정산서_양식_500건.csv`, generateSettlementCsv(sample));
    log("EXPORT_CSV", "정산서 양식 500건", "템플릿 다운로드");
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
  // 월별 재대사 기준월. 데모 원장은 고정 기준일을 쓰고, 업로드·수집은 오늘 기준으로 본다.
  // 서버 프리렌더와 클라이언트 첫 렌더가 같은 값을 내도록 오늘 날짜는 마운트 뒤에만 반영한다.
  const [clockMonth, setClockMonth] = useState<string>(() => monthOf(SETTLEMENT_SNAPSHOT_DATE));
  useEffect(() => {
    setClockMonth(monthOf(new Date()));
  }, []);
  const settlementMonth = dataset?.source === "generated" ? monthOf(SETTLEMENT_SNAPSHOT_DATE) : clockMonth;
  const busy = progress.phase === "generating" || progress.phase === "parsing" || progress.phase === "reconciling" || uploading;

  // 쿠폰 원장 × 대사 행 → 쿠폰 비용 매칭 · 캠페인 ROAS. 화면은 계산하지 않고 이 값만 그린다.
  const campaignPerformance = useMemo(
    () =>
      summarizeCampaignPerformance({
        orders: promotion.orders,
        rows,
        campaigns: promotion.campaigns,
        campaignSpend: promotion.campaignSpend,
      }),
    [promotion, rows],
  );

  // 대사 배치 식별자 — 알림톡 중복 차단(dedupe_key)의 기준이다.
  const batchId = useMemo(() => `batch-${dataset?.source ?? "init"}-${dataset?.rowCount ?? 0}`, [dataset]);

  /**
   * 경보 룰 평가.
   *
   * 정산 입금일은 데모 원장에서만 시뮬레이션한다(정산서 CSV에 없는 열이라서). 업로드·API 수집
   * 데이터에는 만들어 넣지 않고, 정산 지연 룰은 "평가 불가"로 남긴다.
   */
  const receipts = useMemo(
    () => (dataset?.source === "generated" ? buildSettlementReceipts(rows, SETTLEMENT_SNAPSHOT_DATE) : null),
    [rows, dataset?.source],
  );

  const couponCosts = useMemo(() => {
    const map = new Map<string, { ourCost: number; paidAmount: number }>();
    if (promotion.orders.length === 0) return map;
    const report = matchCouponSettlement(promotion.orders, rows);
    for (const match of report.rows) {
      const ourCost = Math.max(0, match.sellerBorne + match.overborne);
      if (ourCost <= 0) continue;
      map.set(match.orderId, { ourCost, paidAmount: match.paidAmount });
    }
    return map;
  }, [promotion.orders, rows]);

  const alertEvaluation = useMemo(
    () =>
      evaluateAlertRules({
        rows,
        rules: alertRules,
        receipts,
        couponCosts,
        snapshotDate: SETTLEMENT_SNAPSHOT_DATE,
      }),
    [rows, alertRules, receipts, couponCosts],
  );

  const kpis: KpiItem[] = [
    {
      label: "총 정산액",
      value: summary ? mask(summary.totalSettledAmount) : "—",
      hint: summary ? `결제 ${mask(summary.totalPaidAmount)} · ${activeTenant?.name.split(" ")[0] ?? "본사"}` : "대기 중",
    },
    {
      label: "정상 대사율",
      testId: "kpi-matched-rate",
      value: summary ? formatPercent(summary.matchedRate, 1) : "—",
      hint: summary
        ? `이상 ${summary.flaggedRows.toLocaleString("ko-KR")}건 / ${summary.totalRows.toLocaleString("ko-KR")}건`
        : "대기 중",
      tone: summary ? (summary.matchedRate >= 80 ? "good" : summary.matchedRate >= 60 ? "warn" : "bad") : "default",
      status: summary ? (summary.matchedRate >= 80 ? "정상" : summary.matchedRate >= 60 ? "주의" : "위험") : undefined,
    },
    {
      label: "누수 추정 손실액",
      value: summary ? mask(summary.totalLeak) : "—",
      hint: biggest ? `최대 원인 · ${ANOMALY_META[biggest.code].label}` : "이상 없음",
      tone: "bad",
      status: summary && summary.totalLeak > 0 ? "회수 대상" : undefined,
    },
    {
      label: "역마진 노출액",
      value: summary ? mask(summary.marginRiskExposure) : "—",
      hint: summary
        ? `역마진 ${summary.negativeMarginRows.toLocaleString("ko-KR")}건 · 정산액이 원가·수수료에 못 미치는 주문`
        : "대기 중",
      tone: "warn",
    },
  ];

  return (
    <div>
      {/* 법인·역할 바: 지금 어떤 법인의 어떤 권한으로 보고 있는지 항상 한 줄로 보인다 */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.07] bg-white/[0.015] px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
          <span>
            법인 <strong className="font-semibold text-slate-200">{activeTenant?.name ?? "본사"}</strong>
          </span>
          <span>
            역할 <strong className="font-semibold text-slate-200">{roleDefinition.label}</strong>
          </span>
          <span className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${chainValid ? "bg-emerald-400" : "bg-rose-400"}`} aria-hidden />
            감사 로그 {chainValid ? "정상" : "점검 필요"}
          </span>
          <span className="hidden tabular-nums text-slate-600 sm:inline">기록 {auditRef.current.size}건</span>
        </div>
        <button type="button" onClick={() => setDrawerOpen(true)} className="btn" data-testid="open-tenant-drawer">
          법인·권한·감사
        </button>
      </div>

      {notice && (
        <div
          className={`mt-2 flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-[11.5px] leading-relaxed ${
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
          <button type="button" onClick={() => setNotice(null)} className="shrink-0 text-[10.5px] opacity-70 transition hover:opacity-100">
            닫기
          </button>
        </div>
      )}

      <KpiStrip items={kpis} className="mt-3" />

      {/* 정산 처리 상태: 어느 탭에서 보든 남아 있는 한 줄 상태 띠 */}
      <div className="mt-3 rounded-xl border border-white/[0.07] bg-white/[0.015] px-4 py-2">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">정산 처리 상태</p>
            <p className="truncate text-[12px] font-medium text-slate-200" data-testid="dataset-label">
              {dataset ? dataset.label : "정산 원장을 준비하고 있습니다."}
            </p>
            <p className="mt-0.5 truncate text-[10px] text-slate-600">
              {dataset
                ? `원장 ${dataset.rowCount.toLocaleString("ko-KR")}건 · ${dataset.parseErrorCount}건 격리 · ${
                    Number.isFinite(dataset.rowsPerSecond) && dataset.rowsPerSecond > 0 ? formatThroughput(dataset.rowsPerSecond) : "—"
                  } · ${(dataset.elapsedMs / 1000).toFixed(2)}초`
                : "법인별 정산 원장을 불러오면 계약 조건으로 기대 정산액을 다시 계산합니다."}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => void loadGenerated(DEMO_ROW_COUNT, tenantId)} disabled={busy} className="btn">
              원장 2만 건
            </button>
            <button type="button" onClick={() => void loadGenerated(STRESS_ROW_COUNT, tenantId)} disabled={busy} className="btn">
              10만 건 검증
            </button>
            <button type="button" onClick={handleExport} disabled={!summary || busy} className="btn">
              이상 내역 CSV
            </button>
            <button type="button" onClick={downloadSample} className="btn">
              정산서 양식
            </button>
          </div>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
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
          <span className="shrink-0 tabular-nums text-[10px] text-slate-500" data-testid="recon-progress-label">
            {progress.label} · {progress.percent}%
          </span>
        </div>
      </div>

      <div className="mt-4">
        {section === "overview" ? (
          <div className="space-y-3">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <Panel title="손실 원인" hint="귀속 금액 상위">
                {lossBreakdown.length === 0 ? (
                  <p className="py-6 text-center text-[11.5px] text-slate-600">아직 대사 결과가 없습니다.</p>
                ) : (
                  <ul className="space-y-2">
                    {lossBreakdown.map((entry) => (
                      <li key={entry.code}>
                        <div className="flex items-baseline justify-between gap-2 text-[11px]">
                          <span className="truncate text-slate-300">{entry.meta.label}</span>
                          <span className="shrink-0 tabular-nums text-slate-400">{mask(entry.amount)}</span>
                        </div>
                        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/[0.05]">
                          <div
                            className={`h-full rounded-full ${entry.meta.severity === "critical" ? "bg-rose-400/70" : "bg-amber-400/70"}`}
                            style={{ width: `${Math.max(3, Math.min(100, entry.share))}%` }}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              <Panel title="채널별 정산" hint={summary ? `${summary.totalRows.toLocaleString("ko-KR")}건 기준` : undefined}>
                {summary ? (
                  <ul className="divide-y divide-white/[0.05]">
                    {summary.byChannel.map((channel) => (
                      <li key={channel.channel} className="flex items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
                        <div className="min-w-0">
                          <p className="text-[12px] font-medium text-slate-200">{CHANNEL_LABEL[channel.channel]}</p>
                          <p className="text-[10px] tabular-nums text-slate-600">
                            {channel.rows.toLocaleString("ko-KR")}건 · 이상 {channel.flaggedRows.toLocaleString("ko-KR")}건
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-[12.5px] font-semibold tabular-nums text-white">{mask(channel.settledAmount)}</p>
                          <p className={`text-[10px] tabular-nums ${channel.leak > 0 ? "text-rose-300" : "text-slate-600"}`}>
                            누수 {mask(channel.leak)}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="py-6 text-center text-[11.5px] text-slate-600">대사 중입니다.</p>
                )}
              </Panel>
            </div>

            {/* 쿠폰 원장 → 정산 매칭 → 순마진·ROAS. 대사가 끝난 행과 주문번호로 이어진다 */}
            <div id="campaign-attribution" className="scroll-mt-24">
              <CampaignAttributionPanel
                performance={campaignPerformance}
                issuedCoupons={promotion.ledger.length}
                simulation={promotion.simulation}
                campaignSpend={promotion.campaignSpend}
                onSpendChange={(campaignId, amount) => setCampaignSpend(campaignId, amount)}
                onReset={() => {
                  resetPromotionStore();
                  setNotice({ tone: "info", text: "쿠폰 원장을 비웠습니다. 다음 원장부터 쿠폰 주문이 빠집니다." });
                }}
                onReload={() => void loadGenerated(DEMO_ROW_COUNT, tenantId)}
              />
            </div>
          </div>
        ) : null}

        {section === "rows" ? (
          <div className="space-y-3">
            {/* 룰 빌더의 결과가 바로 아래 표의 행 하이라이트로 이어진다 */}
            <AlertRuleBuilderPanel
              rules={alertRules}
              onRulesChange={(next) => {
                setAlertRules(next);
                log("RECONCILE_RUN", "alert-rule", `경보 룰 변경: ${next.map((rule) => `${rule.id}:${rule.enabled ? "on" : "off"}(${rule.threshold})`).join(", ")}`);
              }}
              evaluation={alertEvaluation}
              rows={rows}
              tenantName={activeTenant?.name ?? "셀러"}
              onSelect={handleSelect}
              dataNote={
                dataset?.source === "generated"
                  ? undefined
                  : "업로드·API 수집 정산서에는 입금일 열이 없어 '정산 지연' 룰은 평가하지 않습니다. 수수료율·쿠폰 부담률 룰은 같은 기준으로 평가됩니다."
              }
            />

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
              alertRowIndex={alertEvaluation.rowIndex}
            />

            <Panel title="이상 유형" hint={can(role, "settlement.amount") ? "정산액 열람 가능" : "정산액 부분 마스킹"}>
              <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                {(Object.keys(ANOMALY_META) as AnomalyCode[]).map((code) => {
                  const meta = ANOMALY_META[code];
                  const count = summary?.anomalyCounts[code] ?? 0;
                  const loss = summary?.anomalyLoss[code] ?? 0;
                  const active = code === biggest?.code;
                  return (
                    <div
                      key={code}
                      title={meta.description}
                      className={`flex items-center justify-between gap-2 rounded-lg border px-2 py-2 ${
                        active ? "border-rose-400/30 bg-rose-400/[0.06]" : "border-white/[0.05] bg-white/[0.015]"
                      }`}
                    >
                      <span className="truncate text-[11px] text-slate-300">{meta.label}</span>
                      <span className="shrink-0 text-[10px] tabular-nums text-slate-500">
                        {count.toLocaleString("ko-KR")}건{loss > 0 ? ` · ${mask(loss)}` : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Panel>
          </div>
        ) : null}

        {section === "intake" ? (
          <div className="space-y-3">
            {/* 데이터 입구를 두 탭으로 분리한다. 파일은 파싱, API는 수집이 앞단이고 이후 대사는 공통이다 */}
            <div className="flex items-center gap-1.5" role="tablist" aria-label="정산 데이터 입구">
              {(
                [
                  { id: "file", label: "정산서 파일", hint: "CSV · TSV · XLSX" },
                  { id: "api", label: "API 자동 수집", hint: "스마트스토어 · 쿠팡" },
                ] as { id: IntakeMode; label: string; hint: string }[]
              ).map((tab) => {
                const active = intakeMode === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setIntakeMode(tab.id)}
                    data-testid={`intake-tab-${tab.id}`}
                    className={`rounded-lg border px-3 py-2 text-left transition ${
                      active
                        ? "border-emerald-400/40 bg-emerald-400/[0.08] text-emerald-100"
                        : "border-white/[0.07] bg-white/[0.02] text-slate-400 hover:border-white/20 hover:text-slate-200"
                    }`}
                  >
                    <span className="block text-[11.5px] font-medium">{tab.label}</span>
                    <span className="block text-[9.5px] opacity-60">{tab.hint}</span>
                  </button>
                );
              })}
            </div>

            {intakeMode === "file" ? (
              <ReconciliationFileUploader
                disabled={busy}
                onParsed={handleParsed}
                onBusyChange={setUploading}
                onNotice={(next) => setNotice(next)}
              />
            ) : (
              <MarketApiSyncConsole
                role={role}
                tenantId={tenantId}
                disabled={busy}
                onCollected={handleApiCollected}
                onBusyChange={setUploading}
                onNotice={(next) => setNotice(next)}
                onAudit={(target, detail, outcome) => log("RECONCILE_RUN", target, detail, outcome)}
              />
            )}
          </div>
        ) : null}

        {section === "export" ? (
          <div className="space-y-3">
            {/* 대사 결과 → 마켓 접수 문서(CSV·PDF). 반출 권한·감사 기록은 콘솔이 관리한다 */}
            <ReconciliationClaimPanel
              rows={rows}
              role={role}
              tenantName={activeTenant?.name ?? "셀러"}
              businessNo={activeTenant?.businessNo}
              period={dataset?.source === "upload" ? undefined : dataset?.source === "api" ? dataset.label : "정산 원장"}
              sourceFileName={dataset?.source === "upload" ? dataset.label : undefined}
              disabled={busy}
              onAudit={(target, detail, outcome) => log("EXPORT_CSV", target, detail, outcome)}
              onNotice={(next) => setNotice(next)}
            />

            {/* 이상 탐지 → 알림톡 발송. 실제 SENS 호출은 자격 증명이 없어 시뮬레이션으로만 동작한다 */}
            <AlimtalkConsole rows={rows} summary={summary} batchId={batchId} datasetLabel={dataset?.label ?? "정산 원장"} />
          </div>
        ) : null}

        {section === "trend" ? (
          <div className="space-y-3">
            {/* 이번 달 대사 요약 ↔ 저장된 지난 달. 장기 추세와 원인별 증감은 이 패널이 담당한다 */}
            <PeriodComparisonPanel
              tenantId={tenantId}
              role={role}
              month={settlementMonth}
              summary={summary}
              source={dataset?.source ?? "generated"}
              datasetLabel={dataset?.label}
              onAudit={(target, detail, outcome) => log("RECONCILE_RUN", target, detail, outcome)}
              onNotice={(next) => setNotice(next)}
            />
            <p className="text-[10px] leading-relaxed text-slate-600">
              계약 프리셋은 공개된 수수료 정책을 참고한 기준값이며, 실제 계약서 값과 다를 수 있습니다. 같은 조건이면 같은 결과가
              나오도록 계산 기준일을 고정해 두었습니다. 마스킹은 화면 표시에만 적용되고 원본 데이터는 변경되지 않습니다.
            </p>
          </div>
        ) : null}
      </div>

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="법인 · 권한 · 감사"
        description="지금 보고 있는 법인과 역할에 따라 금액 마스킹과 반출 권한이 달라집니다."
        testId="tenant-drawer"
      >
        <TenantSwitchConsole
          tenants={DEMO_TENANTS}
          activeTenantId={tenantId}
          role={role}
          onTenantChange={(next) => {
            handleTenantChange(next);
          }}
          onRoleChange={handleRoleChange}
          auditEvents={[...auditRef.current.list()].reverse().slice(0, 10)}
          chainValid={chainValid}
          onExportAudit={handleExportAudit}
        />
      </Drawer>

      <SettlementDetailDrawer item={selected} role={role} onClose={() => setSelected(null)} />
    </div>
  );
}
