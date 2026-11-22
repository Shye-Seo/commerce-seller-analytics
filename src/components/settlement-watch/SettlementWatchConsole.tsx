"use client";

import { useMemo, useState } from "react";
import {
  composeWatchDigest,
  computeSettlementWatch,
  filterWatchItems,
  type WatchFilter,
  type WatchItem,
  type WatchStatus,
} from "@/lib/settlementWatch";
import { WATCH_LEDGER } from "@/lib/settlementWatchData";
import { formatWon } from "@/lib/format";
import { MARKET_PRESETS } from "@/lib/calculator";
import type { MarketChannel } from "@/lib/reconciliationEngine";

/**
 * 정산 누락·지연 감시 (화면)
 *
 * 구매확정 원장과 마켓 정산 내역을 같은 기준일로 판정해, **돈이 들어와야 하는데 안 들어온 건**을
 * 위로 올린다. 표의 행은 판정 결과만 그린다(`judgeOrder`).
 *
 * 필터의 기본값을 "위험·경고"로 두는 이유: 이 화면을 여는 순간 알고 싶은 것은 정상 건이 아니라
 * 확인해야 할 건이기 때문이다. 전체 건수는 KPI에 남겨 둔다.
 */

const STATUS_META: Record<WatchStatus, { label: string; className: string; dot: string }> = {
  risk: {
    label: "위험",
    className: "border-rose-400/30 bg-rose-400/10 text-rose-200",
    dot: "bg-rose-400",
  },
  warning: {
    label: "경고",
    className: "border-amber-400/30 bg-amber-400/10 text-amber-200",
    dot: "bg-amber-400",
  },
  pending: {
    label: "대기",
    className: "border-white/[0.12] bg-white/[0.04] text-slate-300",
    dot: "bg-slate-400",
  },
  ok: {
    label: "정상",
    className: "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-200",
    dot: "bg-emerald-400",
  },
};

const FILTERS: { id: WatchFilter; label: string }[] = [
  { id: "flagged", label: "위험·경고" },
  { id: "risk", label: "위험만" },
  { id: "warning", label: "경고만" },
  { id: "all", label: "전체" },
];

const CHANNELS: MarketChannel[] = ["smartstore", "coupang", "elevenst", "gmarket"];

function StatusBadge({ status }: { status: WatchStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${meta.className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden />
      {meta.label}
    </span>
  );
}

export default function SettlementWatchConsole() {
  const result = useMemo(
    () => computeSettlementWatch(WATCH_LEDGER.orders, WATCH_LEDGER.records, WATCH_LEDGER.snapshotDate),
    [],
  );
  const [filter, setFilter] = useState<WatchFilter>("flagged");
  const [channel, setChannel] = useState<MarketChannel | "all">("all");

  const rows = useMemo(() => filterWatchItems(result.items, filter, channel), [result, filter, channel]);
  const digest = useMemo(() => composeWatchDigest(result), [result]);

  const totalOpen = result.counts.risk + result.counts.warning;
  const maxChannel = Math.max(1, ...result.byChannel.map((row) => row.amountAtRisk));

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-slate-100">
          구매확정일과 정산 기한만으로, 아직 안 들어온 돈을 찾습니다
        </h2>
        <p className="text-[10.5px] text-slate-600">
          정산서에 등장하지 않는 주문은 대사로도 잡히지 않습니다 · 구매확정일 + 마켓 정산 기한 비교
        </p>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card border-rose-400/20 px-4 py-3">
          <p className="text-[10.5px] text-slate-500">위험 · 정산 누락 의심</p>
          <p className="mt-1 text-[20px] font-semibold leading-tight tabular-nums text-rose-300" data-testid="watch-risk-count">
            {result.counts.risk}건
          </p>
          <p className="mt-1 text-[10.5px] tabular-nums text-slate-500" data-testid="watch-risk-amount">
            {formatWon(result.amounts.atRisk)} 미수
          </p>
        </div>

        <div className="card border-amber-400/20 px-4 py-3">
          <p className="text-[10.5px] text-slate-500">경고 · 지연·부분 정산</p>
          <p className="mt-1 text-[20px] font-semibold leading-tight tabular-nums text-amber-200" data-testid="watch-warning-count">
            {result.counts.warning}건
          </p>
          <p className="mt-1 text-[10.5px] tabular-nums text-slate-500">{formatWon(result.amounts.delayed)}</p>
        </div>

        <div className="card px-4 py-3">
          <p className="text-[10.5px] text-slate-500">감시 대상 구매확정</p>
          <p className="mt-1 text-[20px] font-semibold leading-tight tabular-nums text-white" data-testid="watch-total-count">
            {result.counts.total}건
          </p>
          <p className="mt-1 text-[10.5px] text-slate-500">
            정상 {result.counts.ok} · 대기 {result.counts.pending} · 내역 없음 {result.unrecordedOrders}
          </p>
        </div>

        <div className="card px-4 py-3">
          <p className="text-[10.5px] text-slate-500">최장 경과</p>
          <p className="mt-1 text-[20px] font-semibold leading-tight tabular-nums text-white">
            {result.longestOverdueDays}일
          </p>
          <p className="mt-1 text-[10.5px] text-slate-500">
            기준일 {result.snapshotDate.slice(5).replace("-", "/")} · 확인 대상 {totalOpen}건
          </p>
        </div>
      </section>

      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
        <section className="card overflow-hidden" aria-label="정산 감시 목록">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {FILTERS.map((item) => {
                const active = filter === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={active}
                    data-testid={`watch-filter-${item.id}`}
                    onClick={() => setFilter(item.id)}
                    className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium transition ${
                      active
                        ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-100"
                        : "border-white/[0.07] bg-white/[0.02] text-slate-400 hover:border-white/20"
                    }`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <select
                value={channel}
                aria-label="채널 필터"
                data-testid="watch-channel-select"
                onChange={(event) => setChannel(event.target.value as MarketChannel | "all")}
                className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[11px] text-slate-300 outline-none focus:border-emerald-400/50"
              >
                <option value="all" className="bg-ink-900">
                  전체 채널
                </option>
                {CHANNELS.map((id) => (
                  <option key={id} value={id} className="bg-ink-900">
                    {MARKET_PRESETS[id].shortLabel}
                  </option>
                ))}
              </select>
              <span className="text-[10.5px] tabular-nums text-slate-500" data-testid="watch-row-count">
                {rows.length}건
              </span>
            </div>
          </div>

          <div className="max-h-[620px] overflow-auto thin-scrollbar">
            <table className="w-full border-collapse text-[11.5px]">
              <thead className="sticky top-0 z-10 bg-ink-950">
                <tr className="text-[10px] text-slate-500">
                  <th className="px-3 py-2 text-left font-semibold">상태</th>
                  <th className="px-2 py-2 text-left font-semibold">주문 · 상품</th>
                  <th className="px-2 py-2 text-left font-semibold">채널</th>
                  <th className="px-2 py-2 text-right font-semibold">구매확정</th>
                  <th className="px-2 py-2 text-right font-semibold">정산 기한</th>
                  <th className="px-2 py-2 text-right font-semibold">경과</th>
                  <th className="px-3 py-2 text-right font-semibold">예상 정산액</th>
                  <th className="px-3 py-2 text-right font-semibold">부족</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {rows.map((item: WatchItem) => (
                  <tr
                    key={item.orderNo}
                    data-testid="watch-row"
                    className={item.status === "risk" ? "bg-rose-400/[0.03]" : undefined}
                  >
                    <td className="px-3 py-2">
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="max-w-[260px] px-2 py-2">
                      <p className="truncate text-slate-200">
                        {item.productName}
                        {item.optionName ? <span className="text-slate-500"> · {item.optionName}</span> : null}
                      </p>
                      <p className="font-mono text-[9.5px] text-slate-500">{item.orderNo}</p>
                      <p className="text-[9.5px] leading-snug text-slate-600">{item.reason}</p>
                    </td>
                    <td className="px-2 py-2 text-slate-400">{item.channelLabel}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-slate-400">{item.confirmedAt.slice(5).replace("-", "/")}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-slate-300">{item.dueDate.slice(5).replace("-", "/")}</td>
                    <td
                      className={`px-2 py-2 text-right tabular-nums ${
                        item.overdueDays >= 3 ? "text-rose-300" : item.overdueDays > 0 ? "text-amber-300" : "text-slate-500"
                      }`}
                    >
                      {item.overdueDays > 0 ? `+${item.overdueDays}일` : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-100">{formatWon(item.expectedAmount)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${item.shortfall > 0 ? "text-rose-300" : "text-slate-600"}`}>
                      {item.shortfall > 0 ? formatWon(item.shortfall) : "—"}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-[12px] text-slate-500">
                      이 조건에 해당하는 주문이 없습니다. 필터를 넓히면 전체 구매확정 건을 볼 수 있습니다.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <p className="border-t border-white/[0.06] px-4 py-2 text-[10px] leading-relaxed text-slate-600">
            {result.assumptions.join(" ")}
          </p>
        </section>

        <div className="space-y-4">
          <section className="card p-4" aria-label="운영 알림">
            <div className="flex items-center justify-between">
              <h2 className="text-[13px] font-semibold text-white">운영 알림</h2>
              <span className="rounded border border-white/[0.08] px-1.5 py-0.5 text-[9px] text-slate-500">
                정산 점검
              </span>
            </div>
            <div className="mt-2 rounded-xl rounded-tl-sm border border-white/[0.08] bg-[#1b1d21] px-3 py-2">
              <p className="whitespace-pre-line text-[11px] leading-relaxed text-slate-200" data-testid="watch-alert-preview">
                {digest}
              </p>
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
              위험·경고가 생겼을 때 담당자에게 보내는 문구입니다. 상세 목록은 이 화면에서 확인합니다.
            </p>
          </section>

          <section className="card p-4" aria-label="채널별 노출">
            <h2 className="text-[13px] font-semibold text-white">채널별 노출 금액</h2>
            <p className="mt-0.5 text-[10.5px] text-slate-500">위험·경고에 묶인 금액입니다.</p>
            <ul className="mt-3 space-y-2">
              {result.byChannel.map((row) => (
                <li key={row.channel}>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="flex items-center gap-1.5 text-slate-300">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: row.color }} aria-hidden />
                      {row.label}
                    </span>
                    <span className="tabular-nums text-slate-400">
                      {row.risk + row.warning}건 · {formatWon(row.amountAtRisk)}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${(row.amountAtRisk / maxChannel) * 100}%`, backgroundColor: row.color }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="card p-4" aria-label="판정 기준">
            <h2 className="text-[13px] font-semibold text-white">판정 기준</h2>
            <ul className="mt-2 space-y-1.5 text-[10.5px] leading-relaxed text-slate-500">
              <li>· 정산 기한 = 구매확정일 + 마켓 정산 기한(영업일)</li>
              <li>· 위험: 기한 경과 3일 이상인데 정산 내역 없음</li>
              <li>· 경고: 기한 경과 1~2일 누락, 예정으로만 잡힌 지연, 1% 초과 부분 정산, 지연 입금</li>
              <li>· 대기: 아직 기한 전</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
