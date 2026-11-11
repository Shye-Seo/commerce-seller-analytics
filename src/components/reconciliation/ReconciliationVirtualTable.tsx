"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnomalyCode, MarketChannel, ReconciledRow } from "@/lib/reconciliationEngine";
import { maskAmount, resolveFieldMask, type RoleId } from "@/lib/multiTenantRbac";
import { computeVirtualWindow, estimateDomNodes } from "@/lib/virtualization";
import { formatPercent, formatWon } from "@/lib/format";

/**
 * 10만 행 가상화 테이블
 *
 * 이 컴포넌트는 "표"가 아니라 **렌더 예산 관리기**다. 10만 행을 다 그리면 DOM 노드가 90만 개가 되어
 * 스크롤이 죽는다. 그래서 뷰포트에 걸친 행 + overscan만 DOM에 올리고, 나머지는 위/아래 spacer 높이로
 * 대신한다. 스크롤 이벤트는 rAF로 묶어 프레임당 한 번만 상태를 갱신한다.
 */

const ROW_HEIGHT = 44;
const OVERSCAN = 8;
const DEFAULT_VIEWPORT = 520;

export type RowFilterId = "all" | "negative" | "fee" | "return" | "shortfall";

const FEE_CODES: AnomalyCode[] = ["FEE_OVERCHARGE", "FEE_ON_CANCELED_ORDER"];
const RETURN_CODES: AnomalyCode[] = ["RETURN_FEE_DOUBLE_CHARGED", "RETURN_FEE_ON_SHIPPED_ORDER", "SHIPPING_OVERCHARGE"];
const SHORTFALL_CODES: AnomalyCode[] = ["SETTLEMENT_SHORTFALL", "ROUNDING_LEAK"];

export const ROW_FILTERS: { id: RowFilterId; label: string }[] = [
  { id: "all", label: "전체" },
  { id: "negative", label: "역마진" },
  { id: "fee", label: "수수료 오류" },
  { id: "return", label: "반품·배송" },
  { id: "shortfall", label: "정산 차액" },
];

/** 필터 조건. 순수 함수로 두어 테스트·재사용이 가능하다. */
export function matchesFilter(row: ReconciledRow, filter: RowFilterId): boolean {
  switch (filter) {
    case "all":
      return true;
    case "negative":
      return row.anomalies.some((anomaly) => anomaly.code === "NEGATIVE_MARGIN");
    case "fee":
      return row.anomalies.some((anomaly) => FEE_CODES.includes(anomaly.code));
    case "return":
      return row.anomalies.some((anomaly) => RETURN_CODES.includes(anomaly.code));
    case "shortfall":
      return row.anomalies.some((anomaly) => SHORTFALL_CODES.includes(anomaly.code));
    default:
      return true;
  }
}

const CHANNEL_LABEL: Record<MarketChannel, string> = {
  smartstore: "스마트스토어",
  coupang: "쿠팡",
  elevenst: "11번가",
  gmarket: "G마켓",
};

const CHANNEL_COLOR: Record<MarketChannel, string> = {
  smartstore: "#03C75A",
  coupang: "#F1682A",
  elevenst: "#FF0038",
  gmarket: "#00A05B",
};

const SEVERITY_STYLE: Record<string, string> = {
  critical: "border-rose-400/30 bg-rose-400/10 text-rose-300",
  warning: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  info: "border-slate-400/25 bg-slate-400/10 text-slate-300",
};

function money(value: number, role: RoleId, field: "settledAmount" | "netMargin" | "unitCost" = "settledAmount"): string {
  const level = resolveFieldMask(role, field);
  return level === "none" ? formatWon(value) : maskAmount(value, level);
}

export default function ReconciliationVirtualTable({
  rows,
  role,
  filter,
  onFilterChange,
  counts,
  query,
  onQueryChange,
  onSelect,
  activeId,
  totalRows,
}: {
  rows: ReconciledRow[];
  role: RoleId;
  filter: RowFilterId;
  onFilterChange: (filter: RowFilterId) => void;
  counts: Record<RowFilterId, number>;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (row: ReconciledRow) => void;
  activeId?: string;
  totalRows: number;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef(0);
  const scrollTopRef = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [renderMs, setRenderMs] = useState(0);

  // 뷰포트 높이는 컨테이너 크기에 따라 달라진다(모바일/데스크톱). ResizeObserver로 실측한다.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height ?? 0;
      if (height > 0) setViewportHeight(height);
    });
    observer.observe(element);
    setViewportHeight(element.clientHeight || DEFAULT_VIEWPORT);
    return () => observer.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    scrollTopRef.current = element.scrollTop;
    if (rafRef.current) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = 0;
      const measureStart = performance.now();
      setScrollTop(scrollTopRef.current);
      setRenderMs(performance.now() - measureStart);
    });
  }, []);

  useEffect(() => () => {
    if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
  }, []);

  const window_ = computeVirtualWindow({
    scrollTop,
    viewportHeight,
    rowHeight: ROW_HEIGHT,
    rowCount: rows.length,
    overscan: OVERSCAN,
  });

  const visibleRows = useMemo(
    () => rows.slice(window_.startIndex, window_.endIndex),
    [rows, window_.startIndex, window_.endIndex],
  );

  const dom = estimateDomNodes(rows.length, window_.renderedCount, 13);

  const moveActive = (direction: 1 | -1): void => {
    if (rows.length === 0) return;
    const next = Math.min(rows.length - 1, Math.max(0, activeIndex + direction));
    setActiveIndex(next);
    const element = scrollRef.current;
    if (element) {
      const top = next * ROW_HEIGHT;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
        element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
      }
    }
  };

  return (
    <section className="card overflow-hidden" aria-label="정산 대사 결과 테이블" data-testid="reconciliation-table">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {ROW_FILTERS.map((item) => {
            const active = item.id === filter;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onFilterChange(item.id)}
                aria-pressed={active}
                data-testid={`vtable-filter-${item.id}`}
                className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium transition ${
                  active
                    ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
                    : "border-white/[0.07] bg-white/[0.02] text-slate-400 hover:border-white/20 hover:text-slate-200"
                }`}
              >
                {item.label}
                <span className="ml-1 tabular-nums text-[10px] opacity-70">{counts[item.id].toLocaleString("ko-KR")}</span>
              </button>
            );
          })}
        </div>

        <label className="flex items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1">
          <span className="sr-only">주문번호·상품명 검색</span>
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-slate-500" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="주문번호 · 상품명 · SKU"
            className="w-44 bg-transparent text-[11.5px] text-slate-200 outline-none placeholder:text-slate-600"
          />
        </label>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            moveActive(1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            moveActive(-1);
          } else if (event.key === "Enter" && rows[activeIndex]) {
            event.preventDefault();
            onSelect(rows[activeIndex] as ReconciledRow);
          }
        }}
        className="thin-scrollbar max-h-[520px] min-h-[320px] overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/30"
        aria-rowcount={rows.length}
        data-testid="vtable-scroll"
        data-row-count={rows.length}
      >
        <table className="w-full min-w-[1120px] border-collapse text-[11.5px]">
          <thead>
            <tr className="sticky top-0 z-10 bg-[#0B1020] text-slate-500">
              {[
                ["상태", "w-[132px]"],
                ["주문일", "w-[86px]"],
                ["채널", "w-[92px]"],
                ["주문번호", "w-[132px]"],
                ["상품 · SKU", ""],
                ["결제금액", "w-[92px] text-right"],
                ["수수료(실효)", "w-[104px] text-right"],
                ["반품비", "w-[80px] text-right"],
                ["실정산액", "w-[104px] text-right"],
                ["기대 정산", "w-[104px] text-right"],
                ["차액", "w-[92px] text-right"],
                ["마진율", "w-[76px] text-right"],
              ].map(([label, className]) => (
                <th
                  key={label}
                  className={`border-b border-white/[0.08] px-2.5 py-2 text-[10.5px] font-semibold ${
                    className.includes("text-right") ? "text-right" : "text-left"
                  } ${className}`}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {window_.paddingTop > 0 && (
              <tr aria-hidden style={{ height: window_.paddingTop }}>
                <td colSpan={12} />
              </tr>
            )}

            {visibleRows.map((item, offset) => {
              const index = window_.startIndex + offset;
              const primary = item.anomalies[0];
              const isActive = item.id === activeId || index === activeIndex;
              const marginMask = resolveFieldMask(role, "netMargin");
              return (
                <tr
                  key={item.id}
                  onClick={() => onSelect(item)}
                  style={{ height: ROW_HEIGHT }}
                  className={`cursor-pointer border-b border-white/[0.035] transition-colors ${
                    isActive ? "bg-emerald-400/[0.07]" : index % 2 === 0 ? "bg-transparent" : "bg-white/[0.012]"
                  } hover:bg-white/[0.04]`}
                >
                  <td className="px-2.5">
                    {primary ? (
                      <span className={`inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${SEVERITY_STYLE[primary.severity]}`}>
                        <span className="truncate">{primary.label}</span>
                        {item.anomalies.length > 1 && <span className="opacity-70">+{item.anomalies.length - 1}</span>}
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-md border border-emerald-400/20 bg-emerald-400/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-emerald-300/90">
                        정상
                      </span>
                    )}
                  </td>
                  <td className="px-2.5 tabular-nums text-slate-400">{item.row.orderDate.slice(5)}</td>
                  <td className="px-2.5">
                    <span className="inline-flex items-center gap-1.5 text-slate-300">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: CHANNEL_COLOR[item.row.channel] }} aria-hidden />
                      {CHANNEL_LABEL[item.row.channel]}
                    </span>
                  </td>
                  <td className="px-2.5 font-mono text-[10.5px] text-slate-400">{item.row.orderNo}</td>
                  <td className="max-w-[220px] px-2.5">
                    <div className="truncate text-slate-200">{item.row.productName}</div>
                    <div className="truncate font-mono text-[9.5px] text-slate-600">{item.row.sku} · {item.row.quantity}개</div>
                  </td>
                  <td className="px-2.5 text-right tabular-nums text-slate-300">{formatWon(item.row.paidAmount)}</td>
                  <td className="px-2.5 text-right tabular-nums text-slate-400">
                    {formatPercent(item.effectiveFeeRate, 2)}
                    <span className="ml-1 text-[9.5px] text-slate-600">({money(item.row.commission, role)})</span>
                  </td>
                  <td className={`px-2.5 text-right tabular-nums ${item.row.returnFee > 0 ? "text-amber-300/90" : "text-slate-600"}`}>
                    {item.row.returnFee > 0 ? formatWon(item.row.returnFee) : "—"}
                  </td>
                  <td className="px-2.5 text-right tabular-nums text-slate-200">{money(item.actualSettlement, role)}</td>
                  <td className="px-2.5 text-right tabular-nums text-slate-500">{money(item.expectedSettlement, role)}</td>
                  <td className={`px-2.5 text-right tabular-nums ${item.variance < -10 ? "text-rose-300" : item.variance > 10 ? "text-sky-300" : "text-slate-600"}`}>
                    {item.variance === 0 ? "—" : `${item.variance > 0 ? "+" : ""}${money(item.variance, role)}`}
                  </td>
                  <td className={`px-2.5 text-right tabular-nums ${item.marginRate < 0 ? "font-semibold text-rose-300" : "text-slate-300"}`}>
                    {marginMask === "none" ? formatPercent(item.marginRate, 1) : marginMask === "partial" ? "●●%" : "—"}
                  </td>
                </tr>
              );
            })}

            {window_.paddingBottom > 0 && (
              <tr aria-hidden style={{ height: window_.paddingBottom }}>
                <td colSpan={12} />
              </tr>
            )}
          </tbody>
        </table>

        {rows.length === 0 && (
          <div className="flex h-[260px] flex-col items-center justify-center gap-2 text-center">
            <p className="text-[13px] font-medium text-slate-400">조건에 맞는 행이 없습니다.</p>
            <p className="text-[11px] text-slate-600">필터를 바꾸거나 검색어를 지워 보세요.</p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] px-4 py-2.5 text-[10.5px] text-slate-500">
        <span className="tabular-nums">
          {rows.length === 0
            ? "0행"
            : `${(window_.startIndex + 1).toLocaleString("ko-KR")}–${Math.min(window_.endIndex, rows.length).toLocaleString("ko-KR")} / ${rows.length.toLocaleString("ko-KR")}행 표시`}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
          <span data-testid="vtable-total">총 {rows.length.toLocaleString("ko-KR")}행</span>
          <span>렌더 행 {window_.renderedCount}개</span>
          <span>DOM 셀 {dom.virtual.toLocaleString("ko-KR")}개 (전체 {dom.full.toLocaleString("ko-KR")}개 대비 {dom.ratio.toLocaleString("ko-KR")}배 절감)</span>
          <span className="text-slate-600">rAF {renderMs < 1 ? "<1" : renderMs.toFixed(1)}ms</span>
        </span>
      </div>
    </section>
  );
}
