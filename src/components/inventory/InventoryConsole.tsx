"use client";

import { useMemo, useState } from "react";
import {
  INVENTORY_SNAPSHOT_DATE,
  buildPurchaseOrderCsv,
  composeReorderNotice,
  computeInventoryPlan,
  filterInventoryLines,
  type InventoryFilter,
  type InventoryLine,
  type StockLevel,
  type StockSku,
} from "@/lib/inventory";
import { STOCK_SKUS } from "@/lib/inventoryData";
import { formatWon } from "@/lib/format";

/**
 * 품절 임박 & 발주량 (화면)
 *
 * SKU별 최근 7일 판매 이력으로 일평균·품절일·발주 마감일·권장 발주량을 계산한다.
 * 여기에 두 개의 가정 슬라이더를 둔다. 다음 주 프로모션이나 시즌 수요는 발주 판단을 바꾸기
 * 때문에, "판매가 30% 늘면 발주량이 이만큼 늘어난다"를 같은 화면에서 확인할 수 있어야 한다.
 * 계산은 `computeInventoryPlan`이 하고 화면은 결과만 그린다.
 */

const LEVEL_META: Record<StockLevel, { label: string; className: string; dot: string }> = {
  critical: { label: "위험", className: "border-rose-400/30 bg-rose-400/10 text-rose-200", dot: "bg-rose-400" },
  warning: { label: "주의", className: "border-amber-400/30 bg-amber-400/10 text-amber-200", dot: "bg-amber-400" },
  healthy: { label: "안전", className: "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-200", dot: "bg-emerald-400" },
  stalled: { label: "정체", className: "border-white/[0.12] bg-white/[0.04] text-slate-400", dot: "bg-slate-500" },
};

const FILTERS: { id: InventoryFilter; label: string }[] = [
  { id: "attention", label: "발주 필요" },
  { id: "critical", label: "위험만" },
  { id: "warning", label: "주의만" },
  { id: "all", label: "전체 SKU" },
];

function Sparkline({ values }: { values: number[] }) {
  const width = 74;
  const height = 22;
  const max = Math.max(1, ...values);
  const step = width / Math.max(1, values.length);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="shrink-0">
      {values.map((value, index) => {
        const barHeight = Math.max(1.5, (value / max) * (height - 2));
        const isLast = index === values.length - 1;
        return (
          <rect
            key={index}
            x={index * step + 0.8}
            y={height - barHeight}
            width={Math.max(2, step - 1.6)}
            height={barHeight}
            rx={1}
            fill={isLast ? "#34D399" : "rgba(148,163,184,0.45)"}
          />
        );
      })}
    </svg>
  );
}

function LevelBadge({ level }: { level: StockLevel }) {
  const meta = LEVEL_META[level];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${meta.className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden />
      {meta.label}
    </span>
  );
}

export default function InventoryConsole() {
  const [demandLift, setDemandLift] = useState(0);
  const [safetyMultiplier, setSafetyMultiplier] = useState(1);
  const [filter, setFilter] = useState<InventoryFilter>("attention");

  const skus: StockSku[] = useMemo(
    () =>
      STOCK_SKUS.map((sku) => ({
        ...sku,
        dailySales: sku.dailySales.map((value) => value * (1 + demandLift / 100)),
        safetyStockDays: sku.safetyStockDays * safetyMultiplier,
      })),
    [demandLift, safetyMultiplier],
  );

  const basePlan = useMemo(() => computeInventoryPlan(STOCK_SKUS, INVENTORY_SNAPSHOT_DATE), []);
  const plan = useMemo(() => computeInventoryPlan(skus, INVENTORY_SNAPSHOT_DATE), [skus]);
  const rows = useMemo(() => filterInventoryLines(plan.lines, filter), [plan, filter]);
  const notice = useMemo(() => composeReorderNotice(plan), [plan]);

  const downloadCsv = (): void => {
    const csv = buildPurchaseOrderCsv(plan.lines);
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `발주서-${plan.snapshotDate}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const deadlineDays = plan.nextDeadline
    ? Math.round(
        (Date.parse(`${plan.nextDeadline}T00:00:00Z`) - Date.parse(`${plan.snapshotDate}T00:00:00Z`)) /
          (24 * 60 * 60 * 1000),
      )
    : null;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[10.5px] text-slate-600">최근 7일 판매 속도 · 리드타임 · 안전재고 · MOQ 반영</p>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card border-rose-400/20 px-4 py-3">
          <p className="text-[10.5px] text-slate-500">위험 SKU</p>
          <p className="mt-1 text-[20px] font-semibold leading-tight tabular-nums text-rose-300" data-testid="inventory-critical-count">
            {plan.counts.critical}개
          </p>
          <p className="mt-1 text-[10.5px] text-slate-500">
            리드타임 안에 품절 · 주의 {plan.counts.warning}개
          </p>
        </div>

        <div className="card px-4 py-3">
          <p className="text-[10.5px] text-slate-500">권장 발주 수량</p>
          <p className="mt-1 text-[20px] font-semibold leading-tight tabular-nums text-white" data-testid="inventory-total-qty">
            {plan.totalRecommendedQty.toLocaleString("ko-KR")}개
          </p>
          <p className="mt-1 text-[10.5px] tabular-nums text-slate-500" data-testid="inventory-order-value">
            발주 금액 {formatWon(plan.totalOrderValue)}
          </p>
        </div>

        <div className="card px-4 py-3">
          <p className="text-[10.5px] text-slate-500">가장 급한 발주 마감</p>
          <p className="mt-1 text-[20px] font-semibold leading-tight tabular-nums text-amber-200">
            {deadlineDays === null
              ? "—"
              : deadlineDays < 0
                ? `${Math.abs(deadlineDays)}일 지남`
                : deadlineDays === 0
                  ? "오늘"
                  : `${deadlineDays}일 뒤`}
          </p>
          <p className="mt-1 text-[10.5px] tabular-nums text-slate-500">
            {plan.nextDeadline ? plan.nextDeadline.slice(5).replace("-", "/") : "발주 대상 없음"}
          </p>
        </div>

        <div className="card px-4 py-3">
          <p className="text-[10.5px] text-slate-500">가장 빨리 끊기는 SKU</p>
          <p className="mt-1 truncate text-[15px] font-semibold text-white" data-testid="inventory-soonest">
            {plan.soonestStockout ? plan.soonestStockout.productName : "—"}
          </p>
          <p className="mt-1 text-[10.5px] tabular-nums text-slate-500">
            {plan.soonestStockout
              ? `${plan.soonestStockout.optionName} · ${plan.soonestStockout.date.slice(5).replace("-", "/")} 품절`
              : "판매 이력 없음"}
          </p>
        </div>
      </section>

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
        <section className="card self-start overflow-hidden" aria-label="품절 임박 목록">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {FILTERS.map((item) => {
                const active = filter === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={active}
                    data-testid={`inventory-filter-${item.id}`}
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
              <span className="text-[10.5px] tabular-nums text-slate-500" data-testid="inventory-row-count">
                {rows.length}개 SKU
              </span>
              <button
                type="button"
                onClick={downloadCsv}
                data-testid="inventory-csv"
                className="rounded-lg border border-white/[0.1] bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium text-slate-200 transition hover:border-emerald-400/40 hover:text-emerald-100"
              >
                발주서 CSV
              </button>
            </div>
          </div>

          <div className="max-h-[560px] overflow-auto thin-scrollbar">
            <table className="w-full border-collapse text-[11.5px]">
              <thead className="sticky top-0 z-10 bg-ink-950">
                <tr className="text-[10px] text-slate-500">
                  <th className="px-3 py-2 text-left font-semibold">상태</th>
                  <th className="px-2 py-2 text-left font-semibold">상품 · 옵션</th>
                  <th className="px-2 py-2 text-center font-semibold">7일 판매</th>
                  <th className="px-2 py-2 text-right font-semibold">일평균</th>
                  <th className="px-2 py-2 text-right font-semibold">재고</th>
                  <th className="px-2 py-2 text-right font-semibold">품절일</th>
                  <th className="px-2 py-2 text-right font-semibold">발주 마감</th>
                  <th className="px-3 py-2 text-right font-semibold">권장 발주</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {rows.map((line: InventoryLine) => (
                  <tr
                    key={line.id}
                    data-testid="inventory-row"
                    className={line.level === "critical" ? "bg-rose-400/[0.03]" : undefined}
                  >
                    <td className="px-3 py-2">
                      <LevelBadge level={line.level} />
                    </td>
                    <td className="max-w-[240px] px-2 py-2">
                      <p className="truncate text-slate-200">{line.productName}</p>
                      <p className="truncate text-[9.5px] text-slate-500">
                        {line.optionName} · {line.skuCode}
                      </p>
                      <p className="truncate text-[9.5px] leading-snug text-slate-600">{line.reason}</p>
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex justify-center">
                        <Sparkline values={line.dailySales} />
                      </div>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-slate-300">
                      {line.dailyAverage > 0 ? line.dailyAverage.toFixed(1) : "—"}
                      {line.trendRate !== null && Math.abs(line.trendRate) >= 5 ? (
                        <span className={`ml-1 text-[9px] ${line.trendRate > 0 ? "text-emerald-400" : "text-amber-400"}`}>
                          {line.trendRate > 0 ? "▲" : "▼"}
                          {Math.abs(line.trendRate).toFixed(0)}%
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-slate-200">{line.onHand.toLocaleString("ko-KR")}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-slate-300">
                      {line.stockoutDate ? line.stockoutDate.slice(5).replace("-", "/") : "—"}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-slate-300">
                      {line.orderByDate ? line.orderByDate.slice(5).replace("-", "/") : "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className={`tabular-nums font-semibold ${line.recommendedQty > 0 ? "text-white" : "text-slate-600"}`}>
                        {line.recommendedQty > 0 ? `${line.recommendedQty}개` : "—"}
                      </span>
                      {line.recommendedQty > 0 ? (
                        <span className="block text-[9.5px] tabular-nums text-slate-500">{formatWon(line.orderValue)}</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-[12px] text-slate-500">
                      이 조건에 해당하는 SKU가 없습니다. 전체 SKU로 바꾸면 모든 품목을 볼 수 있습니다.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <p className="border-t border-white/[0.06] px-4 py-2 text-[10px] leading-relaxed text-slate-600">
            {plan.assumptions.join(" ")}
          </p>
        </section>

        <div className="space-y-4">
          <section className="card p-4" aria-label="수요 가정">
            <h2 className="text-[13px] font-semibold text-white">수요 가정</h2>
            <p className="mt-0.5 text-[10.5px] leading-relaxed text-slate-500">
              프로모션·시즌 수요를 반영해 발주량을 미리 조정합니다.
            </p>

            <div className="mt-3">
              <div className="flex items-baseline justify-between">
                <label htmlFor="inventory-demand" className="field-label">
                  판매량 변화
                </label>
                <span className="text-[12.5px] font-semibold tabular-nums text-white" data-testid="inventory-demand-value">
                  {demandLift > 0 ? "+" : ""}
                  {demandLift}%
                </span>
              </div>
              <input
                id="inventory-demand"
                type="range"
                min={-30}
                max={60}
                step={5}
                value={demandLift}
                aria-label="판매량 변화"
                data-testid="inventory-demand-slider"
                onChange={(event) => setDemandLift(Number(event.target.value))}
                className="range mt-2"
                style={{
                  background: `linear-gradient(to right, #34D399 ${((demandLift + 30) / 90) * 100}%, rgba(255,255,255,0.10) ${((demandLift + 30) / 90) * 100}%)`,
                }}
              />
              <p className="mt-1.5 text-[10.5px] text-slate-500">
                발주 수량 {plan.totalRecommendedQty.toLocaleString("ko-KR")}개 · 기준 대비{" "}
                {plan.totalRecommendedQty - basePlan.totalRecommendedQty > 0 ? "+" : ""}
                {(plan.totalRecommendedQty - basePlan.totalRecommendedQty).toLocaleString("ko-KR")}개
              </p>
            </div>

            <div className="mt-4">
              <div className="flex items-baseline justify-between">
                <label htmlFor="inventory-safety" className="field-label">
                  안전재고일 배수
                </label>
                <span className="text-[12.5px] font-semibold tabular-nums text-white" data-testid="inventory-safety-value">
                  {safetyMultiplier.toFixed(1)}배
                </span>
              </div>
              <input
                id="inventory-safety"
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={safetyMultiplier}
                aria-label="안전재고일 배수"
                data-testid="inventory-safety-slider"
                onChange={(event) => setSafetyMultiplier(Number(event.target.value))}
                className="range mt-2"
                style={{
                  background: `linear-gradient(to right, #34D399 ${(safetyMultiplier / 2) * 100}%, rgba(255,255,255,0.10) ${(safetyMultiplier / 2) * 100}%)`,
                }}
              />
              <p className="mt-1.5 text-[10.5px] text-slate-500">
                안전재고를 늘리면 발주량이 늘고 품절 위험은 줄어듭니다.
              </p>
            </div>
          </section>

          <section className="card p-4" aria-label="발주 알림">
            <h2 className="text-[13px] font-semibold text-white">발주 알림</h2>
            <div className="mt-2 rounded-xl rounded-tl-sm border border-white/[0.08] bg-[#1b1d21] px-3 py-2">
              <p className="whitespace-pre-line text-[11px] leading-relaxed text-slate-200" data-testid="inventory-notice">
                {notice}
              </p>
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
              위험 SKU가 생기면 담당자에게 이 문구로 알립니다. 발주서 CSV는 발주 담당자에게 그대로
              넘길 수 있는 형식입니다.
            </p>
          </section>

          <section className="card p-4" aria-label="요약">
            <h2 className="text-[13px] font-semibold text-white">오늘 처리할 일</h2>
            <ul className="mt-2 space-y-1.5 text-[10.5px] leading-relaxed text-slate-500">
              <li>· 위험 {plan.counts.critical}개 SKU는 리드타임 안에 품절됩니다.</li>
              <li>
                · 판매 정체 {plan.counts.stalled}개 SKU는 발주 대신 재고 정리를 검토하세요.
              </li>
              <li>
                · 발주 금액 {formatWon(plan.totalOrderValue)} · 수량{" "}
                {plan.totalRecommendedQty.toLocaleString("ko-KR")}개
              </li>
              <li>· 7일 평균 대비 최근 3일 추세는 표의 ▲▼로 표시합니다.</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
