"use client";

/**
 * 월별 재대사 · 전월 대비 패널
 *
 * 정산 대사 콘솔이 이번 달 숫자를 다 계산하고 나면, 셀러가 다음으로 묻는 것은 "지난달보다
 * 나아졌나"다. 이 패널은 저장된 지난 달 요약과 이번 달 대사 결과를 `periodComparison`으로
 * 비교해 **누수 증감과 원인별 증감**을 보여 준다.
 *
 * 화면은 계산하지 않는다. 비교는 `periodComparison`, 저장은 `settlementHistory`가 하고,
 * 이 컴포넌트는 무엇을 저장할지(이번 달 스냅숏)와 무엇을 비교할지(선택한 지난 달)만 정한다.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ANOMALY_META, type ReconciliationSummary } from "@/lib/reconciliationEngine";
import { formatCount, formatPercent, formatSignedWon, formatWon } from "@/lib/format";
import { can, maskAmount, ROLES, type RoleId } from "@/lib/multiTenantRbac";
import { buildDemoHistory } from "@/lib/demoMonthHistory";
import {
  comparePeriods,
  describeComparison,
  toSnapshotSummary,
  type CauseMovement,
  type PeriodComparison,
  type SnapshotSummary,
} from "@/lib/periodComparison";
import {
  createSnapshot,
  readHistory,
  saveSnapshot,
  saveSnapshots,
  snapshotsForTenant,
  type SettlementMonthSnapshot,
  type SnapshotSource,
} from "@/lib/settlementHistory";

type Notice = { tone: "info" | "warn" | "error" | "success"; text: string };

interface Props {
  tenantId: string;
  role: RoleId;
  /** 이번 달(YYYY-MM). 대사 원장의 기준일에서 온다. */
  month: string;
  summary: ReconciliationSummary | null;
  source: SnapshotSource;
  datasetLabel?: string;
  onAudit?: (target: string, detail: string, outcome?: "allowed" | "denied") => void;
  onNotice?: (notice: Notice) => void;
}

function toneClass(tone: "default" | "good" | "warn" | "danger"): string {
  if (tone === "good") return "text-emerald-300";
  if (tone === "warn") return "text-amber-300";
  if (tone === "danger") return "text-rose-300";
  return "text-white";
}

function StatusChip({ status }: { status: CauseMovement["status"] }) {
  const map: Record<CauseMovement["status"], { label: string; className: string }> = {
    new: { label: "신규", className: "border-rose-400/30 bg-rose-400/10 text-rose-200" },
    resolved: { label: "해소", className: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200" },
    worse: { label: "악화", className: "border-amber-400/30 bg-amber-400/10 text-amber-200" },
    better: { label: "개선", className: "border-emerald-400/25 bg-emerald-400/[0.07] text-emerald-200/90" },
    flat: { label: "변화 없음", className: "border-white/[0.08] bg-white/[0.03] text-slate-400" },
  };
  const chip = map[status];
  return <span className={`rounded-full border px-1.5 py-0.5 text-[9.5px] ${chip.className}`}>{chip.label}</span>;
}

export default function PeriodComparisonPanel({
  tenantId,
  role,
  month,
  summary,
  source,
  datasetLabel,
  onAudit,
  onNotice,
}: Props) {
  const [snapshots, setSnapshots] = useState<SettlementMonthSnapshot[]>([]);
  const [selectedMonth, setSelectedMonth] = useState<string>("");
  const [hydrated, setHydrated] = useState(false);

  const maskLevel = ROLES[role].amountMask;
  const mask = useCallback(
    (value: number): string => (maskLevel === "none" ? formatWon(value) : maskAmount(value, maskLevel)),
    [maskLevel],
  );
  const maskSigned = useCallback(
    (value: number): string => {
      if (maskLevel === "none") return formatSignedWon(value);
      const prefix = value > 0 ? "+" : value < 0 ? "−" : "";
      return `${prefix}${maskAmount(Math.abs(value), maskLevel)}`;
    },
    [maskLevel],
  );

  // localStorage는 브라우저에서만 읽는다(서버 렌더와 하이드레이션이 어긋나지 않게).
  useEffect(() => {
    setSnapshots(readHistory());
    setHydrated(true);
  }, []);

  const previousOptions = useMemo(
    () => snapshotsForTenant(snapshots, tenantId).filter((entry) => entry.month < month),
    [snapshots, tenantId, month],
  );

  useEffect(() => {
    if (!hydrated) return;
    if (previousOptions.length === 0) {
      if (selectedMonth !== "") setSelectedMonth("");
      return;
    }
    if (!previousOptions.some((entry) => entry.month === selectedMonth)) {
      setSelectedMonth(previousOptions[0]?.month ?? "");
    }
  }, [hydrated, previousOptions, selectedMonth]);

  const comparison = useMemo<PeriodComparison | null>(() => {
    if (!summary) return null;
    const previous = previousOptions.find((entry) => entry.month === selectedMonth);
    if (!previous) return null;
    try {
      return comparePeriods(
        { month: previous.month, summary: previous.summary },
        { month, summary: toSnapshotSummary(summary) },
        { tenantId },
      );
    } catch {
      return null;
    }
  }, [summary, previousOptions, selectedMonth, month, tenantId]);

  const currentSummary: SnapshotSummary | null = useMemo(
    () => (summary ? toSnapshotSummary(summary) : null),
    [summary],
  );

  const permissive = can(role, "reconcile.run");

  const handleSave = useCallback(() => {
    if (!summary) return;
    if (!permissive) {
      onNotice?.({ tone: "error", text: "이 역할에는 대사 실행·저장 권한이 없습니다." });
      onAudit?.(`${month} 정산 요약 저장`, "권한 없는 역할의 저장 시도", "denied");
      return;
    }
    const snapshot = createSnapshot({
      tenantId,
      month,
      summary,
      source,
      label: datasetLabel ?? "",
    });
    const outcome = saveSnapshot(snapshot);
    if (outcome.ok) {
      setSnapshots(outcome.snapshots);
      onNotice?.({
        tone: "success",
        text: outcome.replaced
          ? `${month} 요약을 다시 저장했습니다(같은 달 기록을 덮어씀).`
          : `${month} 요약을 저장했습니다. 다음 달 대사에서 전월 대비로 비교됩니다.`,
      });
      onAudit?.(`${month} 정산 요약 저장`, `누수 ${formatWon(snapshot.summary.totalLeak)} · 입력 ${source}`, "allowed");
    } else {
      const reason =
        outcome.reason === "unavailable"
          ? "이 브라우저에서는 저장소를 쓸 수 없습니다(프라이빗 모드 또는 서버 렌더)."
          : outcome.reason === "quota"
            ? "브라우저 저장 공간이 가득 찼습니다. 오래된 달을 지우고 다시 시도하세요."
            : "저장에 실패했습니다.";
      onNotice?.({ tone: "error", text: reason });
    }
  }, [summary, permissive, month, tenantId, source, datasetLabel, onNotice, onAudit]);

  const handleSeedDemo = useCallback(() => {
    if (!permissive) {
      onNotice?.({ tone: "error", text: "이 역할에는 대사 실행 권한이 없습니다." });
      return;
    }
    // 이번 달 원장과 같은 건수로 만든다. 건수가 다르면 "누수 증가"가 원인 변화가 아니라
    // 표본 크기 차이를 말하게 된다.
    const rows = Math.min(20_000, Math.max(600, summary?.totalRows ?? 600));
    const demo = buildDemoHistory(tenantId, month, { rows }).filter(
      (entry) =>
        !snapshots.some(
          (saved) => saved.tenantId === entry.tenantId && saved.month === entry.month,
        ),
    );
    if (demo.length === 0) {
      onNotice?.({ tone: "info", text: "지난 두 달 기록이 이미 있습니다." });
      return;
    }
    const outcome = saveSnapshots(demo);
    if (outcome.ok) {
      setSnapshots(outcome.snapshots);
      onNotice?.({
        tone: "info",
        text: `지난 2개월 이력(${demo.map((entry) => entry.month).join(", ")})을 불러왔습니다.`,
      });
      onAudit?.(`${month} 전월 이력 생성`, `${demo.length}개월 이력`, "allowed");
    } else {
      onNotice?.({ tone: "error", text: "지난 2개월 이력을 저장하지 못했습니다(저장 공간 또는 브라우저 설정)." });
    }
  }, [permissive, tenantId, month, snapshots, summary, onNotice, onAudit]);

  const topCauses = comparison ? comparison.causes.slice(0, 5) : [];
  const maxDelta = comparison
    ? comparison.causes.reduce((max, cause) => Math.max(max, Math.abs(cause.deltaLoss)), 0)
    : 0;

  return (
    <section className="card p-4" data-testid="period-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-slate-500">Month over month</p>
          <h2 className="mt-1 text-[13.5px] font-semibold text-white">월별 재대사 · 전월 대비 차액</h2>
          <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-slate-500">
            이번 달 대사 요약을 저장해 두면, 다음 달에 <strong className="font-medium text-slate-300">원인별로 얼마가 늘고 줄었는지</strong>를
            바로 비교합니다. 마켓에 이의를 제기할 때 &ldquo;지난달보다 수수료 초과 청구가 얼마 늘었다&rdquo;까지 말할 수 있어야 합니다.
            이력은 이 브라우저에만 보관됩니다.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[10px] text-slate-400"
            data-testid="period-month-chip"
          >
            대상월 {month}
          </span>
          <button
            type="button"
            onClick={handleSave}
            disabled={!summary || !permissive}
            data-testid="period-save"
            className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-2 text-[11px] font-medium text-emerald-200 transition enabled:hover:border-emerald-400/60 enabled:hover:text-white disabled:opacity-40"
          >
            이번 달 요약 저장
          </button>
          <button
            type="button"
            onClick={handleSeedDemo}
            disabled={!permissive}
            data-testid="period-seed-demo"
            className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-2 text-[11px] text-slate-300 transition enabled:hover:border-white/20 enabled:hover:text-white disabled:opacity-40"
          >
            지난 2개월 이력
          </button>
        </div>
      </div>

      {!summary ? (
        <div className="mt-3 rounded-xl border border-dashed border-white/[0.08] px-4 py-6 text-center text-[12px] text-slate-500" data-testid="period-empty">
          대사 결과가 준비되면 비교할 수 있습니다.
        </div>
      ) : previousOptions.length === 0 ? (
        <div className="mt-3 rounded-xl border border-dashed border-white/[0.08] px-4 py-6 text-center" data-testid="period-empty">
          <p className="text-[12px] text-slate-400">
            비교할 지난달 기록이 없습니다. <span className="text-slate-300">이번 달 요약 저장</span>을 누르면 다음 달부터 비교되고,
            지금 바로 보려면 <span className="text-slate-300">지난 2개월 이력</span>로 화면을 채울 수 있습니다.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label htmlFor="period-previous-select" className="text-[10.5px] text-slate-500">
              비교 기준월
            </label>
            <select
              id="period-previous-select"
              value={selectedMonth}
              onChange={(event) => setSelectedMonth(event.target.value)}
              data-testid="period-previous-select"
              className="rounded-lg border border-white/[0.08] bg-ink-900 px-2 py-1 text-[11px] text-slate-200"
            >
              {previousOptions.map((entry) => (
                <option key={`${entry.tenantId}-${entry.month}`} value={entry.month}>
                  {entry.month} · 누수 {formatWon(entry.summary.totalLeak)}
                </option>
              ))}
            </select>
            {(() => {
              const active = previousOptions.find((entry) => entry.month === selectedMonth);
              if (!active) return null;
              return (
                <span
                  className={`rounded-full border px-2 py-0.5 text-[9.5px] ${
                    active.source === "demo"
                      ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
                      : "border-white/[0.08] bg-white/[0.03] text-slate-400"
                  }`}
                  data-testid="period-previous-source"
                >
                  {active.source === "demo" ? "이력" : `저장됨 · ${active.savedAt.slice(0, 10)}`}
                </span>
              );
            })()}
            {comparison && !comparison.consecutive && (
              <span className="rounded-full border border-white/[0.08] bg-white/[0.02] px-2 py-0.5 text-[9.5px] text-slate-500">
                {comparison.monthGap}개월 간격
              </span>
            )}
          </div>

          {comparison === null ? (
            <div className="mt-3 rounded-xl border border-dashed border-white/[0.08] px-4 py-4 text-center text-[11.5px] text-slate-500" data-testid="period-empty">
              선택한 달과 이번 달을 비교할 수 없습니다. 비교 기준월은 이번 달보다 앞서야 합니다.
            </div>
          ) : (
            <div data-testid="period-comparison">
              <p className="mt-2 text-[12px] leading-relaxed text-slate-300" data-testid="period-verdict">
                {describeComparison(comparison)}
              </p>

              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                  <p className="text-[10.5px] text-slate-500">누수 추정 손실액</p>
                  <p
                    className={`mt-1 text-[17px] font-semibold leading-tight tabular-nums ${toneClass(
                      comparison.leak.sign > 0 ? "danger" : comparison.leak.sign < 0 ? "good" : "default",
                    )}`}
                    data-testid="period-leak-delta"
                  >
                    {maskSigned(comparison.leak.delta)}
                  </p>
                  <p className="mt-0.5 text-[10px] tabular-nums text-slate-600">
                    {mask(comparison.leak.previous)} → {mask(comparison.leak.current)}
                    {comparison.leak.deltaPct === null ? " · 비교 불가" : ` · ${comparison.leak.deltaPct > 0 ? "+" : ""}${comparison.leak.deltaPct.toFixed(1)}%`}
                  </p>
                </div>
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                  <p className="text-[10.5px] text-slate-500">정상 대사율</p>
                  <p
                    className={`mt-1 text-[17px] font-semibold leading-tight tabular-nums ${toneClass(
                      comparison.matchedRate.delta > 0 ? "good" : comparison.matchedRate.delta < 0 ? "danger" : "default",
                    )}`}
                  >
                    {comparison.matchedRate.delta > 0 ? "+" : ""}
                    {comparison.matchedRate.delta.toFixed(1)}%p
                  </p>
                  <p className="mt-0.5 text-[10px] tabular-nums text-slate-600">
                    {formatPercent(comparison.matchedRate.previous, 1)} → {formatPercent(comparison.matchedRate.current, 1)}
                  </p>
                </div>
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                  <p className="text-[10.5px] text-slate-500">이상 행 수</p>
                  <p
                    className={`mt-1 text-[17px] font-semibold leading-tight tabular-nums ${toneClass(
                      comparison.flagged.delta > 0 ? "danger" : comparison.flagged.delta < 0 ? "good" : "default",
                    )}`}
                  >
                    {comparison.flagged.delta > 0 ? "+" : ""}
                    {formatCount(comparison.flagged.delta)}
                  </p>
                  <p className="mt-0.5 text-[10px] tabular-nums text-slate-600">
                    {formatCount(comparison.flagged.previous)} → {formatCount(comparison.flagged.current)} · 대사 {formatCount(comparison.rows.current)}
                  </p>
                </div>
              </div>

              <div className="mt-3 overflow-hidden rounded-xl border border-white/[0.06]">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-white/[0.02] text-[10px] uppercase tracking-[0.12em] text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">원인</th>
                      <th className="px-3 py-2 text-right font-medium">지난달</th>
                      <th className="px-3 py-2 text-right font-medium">이번 달</th>
                      <th className="px-3 py-2 text-right font-medium">증감</th>
                      <th className="w-[28%] px-3 py-2 font-medium">변화 폭</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {topCauses.map((cause) => {
                      const share = maxDelta === 0 ? 0 : Math.round((Math.abs(cause.deltaLoss) / maxDelta) * 100);
                      return (
                        <tr key={cause.code} data-testid={`period-cause-${cause.code}`}>
                          <td className="px-3 py-2">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <span className="text-slate-200">{cause.label}</span>
                              <StatusChip status={cause.status} />
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-500">{mask(cause.previousLoss)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-300">{mask(cause.currentLoss)}</td>
                          <td
                            className={`px-3 py-2 text-right tabular-nums ${
                              cause.deltaLoss > 0 ? "text-rose-300" : cause.deltaLoss < 0 ? "text-emerald-300" : "text-slate-500"
                            }`}
                          >
                            {maskSigned(cause.deltaLoss)}
                          </td>
                          <td className="px-3 py-2">
                            <span className="block h-1 w-full overflow-hidden rounded-full bg-white/[0.05]">
                              <span
                                className={`block h-full ${
                                  cause.deltaLoss > 0 ? "bg-rose-400/70" : cause.deltaLoss < 0 ? "bg-emerald-400/70" : "bg-slate-500/40"
                                }`}
                                style={{ width: `${Math.max(3, Math.min(100, share))}%` }}
                              />
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
                {comparison.causes.length > topCauses.length && <span>외 {comparison.causes.length - topCauses.length}개 원인</span>}
                {comparison.newCauses.length > 0 && (
                  <span className="rounded-full border border-rose-400/25 bg-rose-400/[0.07] px-2 py-0.5 text-rose-200" data-testid="period-new-causes">
                    신규 원인 {comparison.newCauses.map((cause) => ANOMALY_META[cause.code].label).join(", ")}
                  </span>
                )}
                {comparison.resolvedCauses.length > 0 && (
                  <span className="rounded-full border border-emerald-400/25 bg-emerald-400/[0.07] px-2 py-0.5 text-emerald-200" data-testid="period-resolved-causes">
                    해소된 원인 {comparison.resolvedCauses.map((cause) => ANOMALY_META[cause.code].label).join(", ")}
                  </span>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
