"use client";

import { useMemo, useState } from "react";
import { formatCompactNumber, formatCount, formatPercent, formatWon } from "@/lib/format";
import type { SalesPoint, TrendRange } from "@/lib/types";

const CHART = {
  width: 760,
  height: 300,
  top: 18,
  right: 16,
  bottom: 38,
  left: 54,
} as const;

const INNER_WIDTH = CHART.width - CHART.left - CHART.right;
const INNER_HEIGHT = CHART.height - CHART.top - CHART.bottom;

/** 막대는 아래 68%, 마진율 선은 위 30% 영역에 배치해 두 지표가 서로 가리지 않게 한다. */
const BAR_HEIGHT_RATIO = 0.68;
const RATE_BAND_RATIO = 0.3;

const RANGE_OPTIONS: Array<{ value: TrendRange; label: string; sub: string }> = [
  { value: "daily", label: "일별", sub: "최근 30일" },
  { value: "monthly", label: "월별", sub: "최근 12개월" },
];

export interface SalesTrendChartProps {
  daily: SalesPoint[];
  monthly: SalesPoint[];
}

export default function SalesTrendChart({ daily, monthly }: SalesTrendChartProps) {
  const [range, setRange] = useState<TrendRange>("daily");
  const [hovered, setHovered] = useState<number | null>(null);

  const points = range === "daily" ? daily : monthly;

  const geometry = useMemo(() => {
    const revenues = points.map((point) => point.revenue);
    const maxRevenue = Math.max(...revenues, 1);
    const paddedMax = maxRevenue * 1.14;

    const rates = points.map((point) => point.marginRate);
    const minRate = Math.min(...rates);
    const maxRate = Math.max(...rates);
    const rateSpan = Math.max(maxRate - minRate, 0.6);

    const barAreaHeight = INNER_HEIGHT * BAR_HEIGHT_RATIO;
    const barBottom = CHART.top + INNER_HEIGHT;
    const rateTop = CHART.top;
    const rateBottom = CHART.top + INNER_HEIGHT * RATE_BAND_RATIO;

    const slot = INNER_WIDTH / points.length;
    const barWidth = Math.min(slot * 0.56, 22);

    const xOf = (index: number) => CHART.left + slot * (index + 0.5);
    const yOfRevenue = (value: number) => barBottom - (value / paddedMax) * barAreaHeight;
    const yOfRate = (value: number) => rateBottom - ((value - minRate) / rateSpan) * (rateBottom - rateTop);

    return {
      paddedMax,
      minRate,
      maxRate,
      slot,
      barWidth,
      barBottom,
      xOf,
      yOfRevenue,
      yOfRate,
      linePath: points
        .map((point, index) => `${index === 0 ? "M" : "L"}${xOf(index).toFixed(1)},${yOfRate(point.marginRate).toFixed(1)}`)
        .join(" "),
      gridValues: [0, 0.25, 0.5, 0.75, 1].map((ratio) => paddedMax * ratio),
      labelStep: Math.ceil(points.length / 8),
    };
  }, [points]);

  const summary = useMemo(() => {
    const totalRevenue = points.reduce((sum, point) => sum + point.revenue, 0);
    const totalProfit = points.reduce((sum, point) => sum + point.netProfit, 0);
    const averageMargin =
      points.reduce((sum, point) => sum + point.marginRate, 0) / Math.max(points.length, 1);
    const peak = points.reduce(
      (best, point) => (point.revenue > best.revenue ? point : best),
      points[0],
    );

    return {
      totalRevenue,
      totalProfit,
      averageMargin,
      peak,
      averageOrderValue: totalRevenue / Math.max(
        points.reduce((sum, point) => sum + point.orders, 0),
        1,
      ),
    };
  }, [points]);

  const activePoint = hovered === null ? null : points[hovered];
  const tooltipLeft =
    hovered === null ? 0 : Math.min(88, Math.max(12, (geometry.xOf(hovered) / CHART.width) * 100));

  return (
    <div className="card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-white">매출 · 마진 추이</h3>
          <p className="mt-1 text-[11px] text-slate-500">
            막대는 매출, 선은 마진율입니다. 막대에 커서를 올리면 일별 상세가 표시됩니다.
          </p>
        </div>
        <div className="flex rounded-xl border border-white/[0.08] bg-white/[0.02] p-1">
          {RANGE_OPTIONS.map((option) => {
            const active = option.value === range;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setRange(option.value);
                  setHovered(null);
                }}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  active ? "bg-white/10 text-white" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {option.label}
                <span className="ml-1 text-[10px] font-normal text-slate-500">{option.sub}</span>
              </button>
            );
          })}
        </div>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "기간 총매출", value: formatWon(summary.totalRevenue) },
          { label: "기간 순이익", value: formatWon(summary.totalProfit) },
          { label: "평균 마진율", value: formatPercent(summary.averageMargin) },
          { label: "최고 매출", value: `${formatCompactNumber(summary.peak.revenue)}원` },
        ].map((item) => (
          <div key={item.label} className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-3 py-2.5">
            <dt className="text-[11px] text-slate-500">{item.label}</dt>
            <dd className="mt-1 text-sm font-semibold text-slate-100 tabular-nums">{item.value}</dd>
          </div>
        ))}
      </dl>

      <div className="relative mt-6">
        <svg
          viewBox={`0 0 ${CHART.width} ${CHART.height}`}
          className="h-auto w-full overflow-visible"
          role="img"
          aria-label={`${range === "daily" ? "최근 30일 일별" : "최근 12개월 월별"} 매출과 마진율 추이 차트`}
        >
          <defs>
            <linearGradient id="revenueBar" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#34D399" stopOpacity="0.95" />
              <stop offset="100%" stopColor="#34D399" stopOpacity="0.18" />
            </linearGradient>
            <linearGradient id="marginLine" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#818CF8" />
              <stop offset="100%" stopColor="#C4B5FD" />
            </linearGradient>
          </defs>

          {geometry.gridValues.map((value) => {
            const y = geometry.yOfRevenue(value);
            return (
              <g key={value}>
                <line
                  x1={CHART.left}
                  x2={CHART.width - CHART.right}
                  y1={y}
                  y2={y}
                  stroke="rgba(255,255,255,0.06)"
                  strokeDasharray="3 5"
                />
                <text
                  x={CHART.left - 10}
                  y={y + 3.5}
                  textAnchor="end"
                  className="fill-slate-500"
                  fontSize="10"
                >
                  {formatCompactNumber(value)}
                </text>
              </g>
            );
          })}

          <text x={CHART.left - 10} y={CHART.top + 2} textAnchor="end" className="fill-indigo-300" fontSize="10">
            {formatPercent(geometry.maxRate, 0)}
          </text>
          <text
            x={CHART.left - 10}
            y={CHART.top + INNER_HEIGHT * RATE_BAND_RATIO}
            textAnchor="end"
            className="fill-indigo-300/70"
            fontSize="10"
          >
            {formatPercent(geometry.minRate, 0)}
          </text>

          {points.map((point, index) => {
            const height = geometry.barBottom - geometry.yOfRevenue(point.revenue);
            const isActive = hovered === index;
            return (
              <rect
                key={`${point.label}-${index}`}
                x={geometry.xOf(index) - geometry.barWidth / 2}
                y={geometry.yOfRevenue(point.revenue)}
                width={geometry.barWidth}
                height={Math.max(height, 2)}
                rx={3}
                fill="url(#revenueBar)"
                opacity={hovered === null || isActive ? 1 : 0.45}
                className="transition-opacity duration-150"
              />
            );
          })}

          <path
            d={geometry.linePath}
            fill="none"
            stroke="url(#marginLine)"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {points.map((point, index) => {
            const isActive = hovered === index;
            if (!isActive && points.length > 14) return null;
            return (
              <circle
                key={`dot-${point.label}-${index}`}
                cx={geometry.xOf(index)}
                cy={geometry.yOfRate(point.marginRate)}
                r={isActive ? 4.2 : 2.6}
                fill={isActive ? "#F5F3FF" : "#A5B4FC"}
                stroke="#0B1020"
                strokeWidth={1.4}
              />
            );
          })}

          {points.map((point, index) => {
            if (index % geometry.labelStep !== 0) return null;
            return (
              <text
                key={`label-${point.label}-${index}`}
                x={geometry.xOf(index)}
                y={CHART.height - 12}
                textAnchor="middle"
                className="fill-slate-500"
                fontSize="10"
              >
                {point.label}
              </text>
            );
          })}

          {points.map((point, index) => (
            <rect
              key={`hit-${point.label}-${index}`}
              x={CHART.left + geometry.slot * index}
              y={CHART.top}
              width={geometry.slot}
              height={INNER_HEIGHT}
              fill="transparent"
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered(null)}
            />
          ))}
        </svg>

        {activePoint ? (
          <div
            className="pointer-events-none absolute top-0 z-10 w-40 -translate-x-1/2 rounded-xl border border-white/10 bg-ink-800/95 p-3 shadow-card backdrop-blur"
            style={{ left: `${tooltipLeft}%` }}
          >
            <p className="text-[11px] font-semibold text-slate-300">{activePoint.label}</p>
            <dl className="mt-2 space-y-1 text-[11px]">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-500">매출</dt>
                <dd className="font-medium text-slate-100 tabular-nums">
                  {formatWon(activePoint.revenue)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-500">순이익</dt>
                <dd className="font-medium text-emerald-300 tabular-nums">
                  {formatWon(activePoint.netProfit)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-500">마진율</dt>
                <dd className="font-medium text-indigo-300 tabular-nums">
                  {formatPercent(activePoint.marginRate)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-500">주문</dt>
                <dd className="font-medium text-slate-100 tabular-nums">
                  {formatCount(activePoint.orders)}
                </dd>
              </div>
            </dl>
          </div>
        ) : null}
      </div>

      <p className="mt-4 text-[11px] text-slate-500">
        평균 객단가 {formatWon(summary.averageOrderValue)} · 모든 수치는 데모 데이터입니다.
      </p>
    </div>
  );
}
