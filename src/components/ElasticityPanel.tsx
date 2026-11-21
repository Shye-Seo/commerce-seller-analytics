"use client";

import { useMemo, useState } from "react";
import { computeElasticity, type ElasticityResult, type MarketCurve } from "@/lib/elasticity";
import { formatPercent, formatWon } from "@/lib/format";
import type { MarginInput } from "@/lib/types";

/**
 * 가격·마진 탄력성 시뮬레이터 (화면)
 *
 * 슬라이더 세 개(정가·할인율·ROAS)만 두고, 계산은 전부 `elasticity`가 한다.
 * 차트는 라이브러리 없이 SVG로 그린다. 이 프로젝트의 다른 차트와 같은 이유다 —
 * 번들에 차트 라이브러리를 넣으면 30KB를 넘게 되고, 필요한 것은 축·격자·폴리라인뿐이다.
 *
 * 세로축을 "건당 순이익(원)"이 아니라 "마진율(%)"로 둔 이유:
 * 순이익은 판매가에 대해 1차식이라 5개 마켓이 평행선처럼 보인다. 마진율은 분모가 판매가라
 * 곡선이 휘고, 손익분기(0%)를 지나는 지점이 눈에 보인다. 계산 오차처럼 보이는 직선을
 * 피하려는 선택이지, 숫자를 꾸미려는 것이 아니다.
 */

const CHART = { width: 760, height: 320, top: 20, right: 18, bottom: 40, left: 56 } as const;
const INNER_W = CHART.width - CHART.left - CHART.right;
const INNER_H = CHART.height - CHART.top - CHART.bottom;

export interface ElasticityPanelProps {
  input: MarginInput;
  /** "이 조건을 대시보드에 반영"이 호출하는 콜백 */
  onApply?: (patch: Partial<MarginInput>) => void;
}

interface SliderProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  hint?: string;
  onChange: (value: number) => void;
}

function Slider({ id, label, value, min, max, step, display, hint, onChange }: SliderProps) {
  const filled = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="field-label">
          {label}
        </label>
        <span className="text-sm font-semibold tabular-nums text-white">{display}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="range mt-2.5"
        style={{
          background: `linear-gradient(to right, #34D399 ${filled}%, rgba(255,255,255,0.10) ${filled}%)`,
        }}
      />
      {hint ? <p className="mt-1.5 text-[11px] text-slate-500">{hint}</p> : null}
    </div>
  );
}

/** 마켓 곡선 5개를 한 좌표계에 그린다. */
function MarginCurves({
  result,
  visible,
}: {
  result: ElasticityResult;
  visible: Record<string, boolean>;
}) {
  const geometry = useMemo(() => {
    const { min, max } = result.axis;
    const rateMin = result.chart.minMarginRate;
    const rateMax = result.chart.maxMarginRate;
    const span = Math.max(rateMax - rateMin, 10);

    const xOf = (price: number) => CHART.left + ((price - min) / Math.max(1, max - min)) * INNER_W;
    const yOf = (rate: number) =>
      CHART.top + INNER_H - ((Math.min(rateMax, Math.max(rateMin, rate)) - rateMin) / span) * INNER_H;

    const curves = result.curves
      .filter((curve) => visible[curve.marketId] !== false)
      .map((curve) => ({
        curve,
        path: curve.series
          .map(
            (point, index) =>
              `${index === 0 ? "M" : "L"}${xOf(point.price).toFixed(1)},${yOf(point.marginRate).toFixed(1)}`,
          )
          .join(" "),
        breakEven:
          Number.isFinite(curve.breakEvenPrice) &&
          curve.breakEvenPrice >= min &&
          curve.breakEvenPrice <= max
            ? xOf(curve.breakEvenPrice)
            : null,
      }));

    // 눈금은 5·10·20·25처럼 읽기 좋은 단위로 맞춘다(10% 간격이면 -10·0·10·20…).
    const rough = span / 5;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= rough) ?? rough;
    const rateTicks: number[] = [];
    for (let value = Math.ceil(rateMin / step) * step; value <= rateMax + 1e-9; value += step) {
      rateTicks.push(Math.round(value * 10) / 10);
    }
    const priceTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => min + (max - min) * ratio);

    return {
      curves,
      xOf,
      yOf,
      zeroY: yOf(0),
      rateTicks,
      priceTicks,
      currentX: xOf(result.config.paidPrice),
    };
  }, [result, visible]);

  const label = `5개 마켓 마진율 곡선. 세로축 ${result.chart.minMarginRate}%에서 ${result.chart.maxMarginRate}%, 가로축 ${formatWon(result.axis.min)}에서 ${formatWon(result.axis.max)}.`;

  return (
    <svg
      viewBox={`0 0 ${CHART.width} ${CHART.height}`}
      className="h-auto w-full"
      role="img"
      aria-label={label}
      data-testid="elasticity-chart"
    >
      {geometry.rateTicks.map((rate) => {
        const y = geometry.yOf(rate);
        return (
          <g key={`rate-${rate.toFixed(2)}`}>
            <line
              x1={CHART.left}
              x2={CHART.left + INNER_W}
              y1={y}
              y2={y}
              stroke={Math.abs(rate) < 0.001 ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.06)"}
              strokeDasharray={Math.abs(rate) < 0.001 ? "4 4" : undefined}
            />
            <text x={CHART.left - 8} y={y + 3.5} textAnchor="end" fontSize={10} fill="#64748B">
              {`${rate.toFixed(0)}%`}
            </text>
          </g>
        );
      })}

      {geometry.priceTicks.map((price) => (
        <text
          key={`price-${price}`}
          x={geometry.xOf(price)}
          y={CHART.top + INNER_H + 18}
          textAnchor="middle"
          fontSize={10}
          fill="#64748B"
        >
          {price >= 10_000 ? `${Math.round(price / 1_000)}천` : Math.round(price).toLocaleString("ko-KR")}
        </text>
      ))}

      {/* 현재 할인 적용 판매가 — 이 선 위에서 각 마켓의 마진율을 읽는다 */}
      <line
        x1={geometry.currentX}
        x2={geometry.currentX}
        y1={CHART.top}
        y2={CHART.top + INNER_H}
        stroke="rgba(52,211,153,0.45)"
        strokeDasharray="3 3"
      />
      <text x={geometry.currentX + 4} y={CHART.top + 10} fontSize={9.5} fill="#6EE7B7">
        현재 {formatWon(result.config.paidPrice)}
      </text>

      {geometry.curves.map(({ curve, path }) => (
        <path
          key={curve.marketId}
          d={path}
          fill="none"
          stroke={curve.color}
          strokeWidth={2}
          strokeLinecap="round"
          opacity={0.92}
        />
      ))}

      {geometry.curves.map(({ curve, breakEven }) =>
        breakEven === null ? null : (
          <g key={`be-${curve.marketId}`}>
            <circle cx={breakEven} cy={geometry.zeroY} r={3.5} fill={curve.color} opacity={0.9} />
            <title>{`${curve.shortLabel} 손익분기 ${formatWon(curve.breakEvenPrice)}`}</title>
          </g>
        ),
      )}

      <text
        x={CHART.left + INNER_W}
        y={CHART.height - 6}
        textAnchor="end"
        fontSize={9.5}
        fill="#475569"
      >
        판매가(원) · 점 = 손익분기 판매가
      </text>
    </svg>
  );
}

function MarketRow({ curve, best }: { curve: MarketCurve; best: boolean }) {
  const reachable = Number.isFinite(curve.breakEvenPrice);
  return (
    <tr className={best ? "bg-emerald-400/[0.04]" : undefined}>
      <td className="px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-slate-200">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: curve.color }}
            aria-hidden
          />
          {curve.shortLabel}
          {best ? (
            <span className="rounded border border-emerald-400/30 bg-emerald-400/10 px-1 text-[9.5px] font-medium text-emerald-300">
              최고
            </span>
          ) : null}
        </span>
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-slate-300">
        {reachable ? formatWon(curve.breakEvenPrice) : "도달 불가"}
      </td>
      <td
        className={`px-3 py-2 text-right tabular-nums ${
          curve.netPerUnit >= 0 ? "text-emerald-300" : "text-rose-300"
        }`}
      >
        {formatWon(curve.netPerUnit)}
      </td>
      <td
        className={`px-3 py-2 text-right tabular-nums ${
          curve.marginRate >= 12 ? "text-slate-200" : curve.marginRate >= 0 ? "text-amber-300" : "text-rose-300"
        }`}
      >
        {formatPercent(curve.marginRate, 1)}
      </td>
      <td
        className={`px-3 py-2 text-right tabular-nums ${
          curve.monthlyNetProfit >= 0 ? "text-slate-200" : "text-rose-300"
        }`}
      >
        {formatWon(curve.monthlyNetProfit)}
      </td>
    </tr>
  );
}

export default function ElasticityPanel({ input, onApply }: ElasticityPanelProps) {
  const [listPrice, setListPrice] = useState(() => Math.max(1_000, input.sellingPrice));
  const [discountRate, setDiscountRate] = useState(0);
  const [roas, setRoas] = useState(() => {
    // 현재 대시보드의 광고비에서 출발 ROAS를 역산한다(광고비 0이면 4로 시작).
    if (input.adCostPerUnit <= 0 || input.sellingPrice <= 0) return 4;
    return Math.min(12, Math.max(1, Math.round((input.sellingPrice / input.adCostPerUnit) * 10) / 10));
  });
  const [visible, setVisible] = useState<Record<string, boolean>>({});

  const result = useMemo(
    () => computeElasticity(input, { listPrice, discountRate, roas }),
    [input, listPrice, discountRate, roas],
  );

  const toggleMarket = (marketId: string): void => {
    setVisible((previous) => ({ ...previous, [marketId]: previous[marketId] === false }));
  };

  const applyToDashboard = (): void => {
    if (!onApply) return;
    onApply({
      sellingPrice: result.config.paidPrice,
      adCostPerUnit: result.config.adCostPerUnit,
    });
  };

  return (
    <div className="card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400/80">
            Elasticity
          </p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-white">
            정가·할인·ROAS를 바꾸면 어느 마켓에서 적자가 되는가
          </h2>
          <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-slate-500">
            같은 원가·배송·반품 조건을 5개 마켓에 그대로 적용하고, 수수료율과 광고비만 다르게 계산합니다.
            슬라이더를 움직이면 곡선과 표가 함께 다시 계산됩니다.
          </p>
        </div>
        <span className="chip">입력 즉시 재계산</span>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Slider
            id="elasticity-list-price"
            label="정가(할인 전)"
            value={listPrice}
            min={5_000}
            max={120_000}
            step={500}
            display={formatWon(listPrice)}
            hint="마켓별로 같은 정가를 적용합니다."
            onChange={setListPrice}
          />
          <Slider
            id="elasticity-discount"
            label="할인율"
            value={discountRate}
            min={0}
            max={40}
            step={1}
            display={formatPercent(discountRate, 0)}
            hint={`실제 판매가 ${formatWon(result.config.paidPrice)}`}
            onChange={setDiscountRate}
          />
          <Slider
            id="elasticity-roas"
            label="목표 ROAS"
            value={roas}
            min={0}
            max={12}
            step={0.5}
            display={roas === 0 ? "광고 없음" : `${roas.toFixed(1)}배`}
            hint={
              roas === 0
                ? "광고비를 반영하지 않습니다."
                : `판매가의 ${(100 / roas).toFixed(1)}%를 광고비로 씁니다 (${formatWon(result.config.adCostPerUnit)}/건)`
            }
            onChange={setRoas}
          />

          <dl className="space-y-2 rounded-xl border border-white/[0.06] bg-white/[0.015] px-3.5 py-3 text-[12px]">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-slate-400">고정비성 원가</dt>
              <dd className="tabular-nums text-slate-200">{formatWon(result.config.fixedCostPerUnit)}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-slate-400">기대 반품 손실</dt>
              <dd className="tabular-nums text-slate-200">{formatWon(result.config.returnLossPerUnit)}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-slate-400">광고비</dt>
              <dd className="tabular-nums text-slate-200">{formatWon(result.config.adCostPerUnit)}</dd>
            </div>
          </dl>

          {onApply ? (
            <button
              type="button"
              onClick={applyToDashboard}
              className="w-full rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-[12px] font-medium text-emerald-200 transition hover:border-emerald-400/50 hover:bg-emerald-400/15"
            >
              이 조건을 대시보드에 반영
            </button>
          ) : null}
        </div>

        <div>
          <div className="flex flex-wrap items-center gap-1.5">
            {result.curves.map((curve) => {
              const active = visible[curve.marketId] !== false;
              return (
                <button
                  key={curve.marketId}
                  type="button"
                  onClick={() => toggleMarket(curve.marketId)}
                  aria-pressed={active}
                  data-testid={`elasticity-legend-${curve.marketId}`}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[10.5px] font-medium transition ${
                    active
                      ? "border-white/[0.12] bg-white/[0.04] text-slate-200"
                      : "border-white/[0.05] bg-transparent text-slate-600"
                  }`}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: active ? curve.color : "#475569" }}
                    aria-hidden
                  />
                  {curve.shortLabel}
                </button>
              );
            })}
            <span className="ml-auto text-[10.5px] text-slate-500">
              y축은 마진율, 0% 선이 손익분기입니다
            </span>
          </div>

          <div className="mt-2 rounded-xl border border-white/[0.05] bg-white/[0.012] p-2">
            <MarginCurves result={result} visible={visible} />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
              <p className="text-[10.5px] text-slate-500">현재 판매가</p>
              <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-white">
                {formatWon(result.config.paidPrice)}
              </p>
            </div>
            <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] px-3 py-2.5">
              <p className="text-[10.5px] text-slate-500">마진 최고 마켓</p>
              <p className="mt-0.5 text-[15px] font-semibold text-emerald-300">
                {result.best ? result.best.shortLabel : "—"}
                {result.best ? (
                  <span className="ml-1.5 text-[11px] font-medium text-slate-400">
                    {formatPercent(result.best.marginRate, 1)}
                  </span>
                ) : null}
              </p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
              <p className="text-[10.5px] text-slate-500">손익분기 낮은 마켓</p>
              <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-white">
                {result.lowestBreakEven
                  ? `${result.lowestBreakEven.shortLabel} ${formatWon(result.lowestBreakEven.breakEvenPrice)}`
                  : "도달 불가"}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-5 overflow-hidden rounded-xl border border-white/[0.06]">
        <table className="w-full border-collapse text-[11.5px]">
          <thead>
            <tr className="bg-white/[0.02] text-[10.5px] text-slate-500">
              <th className="px-3 py-2 text-left font-semibold">마켓</th>
              <th className="px-3 py-2 text-right font-semibold">손익분기 판매가</th>
              <th className="px-3 py-2 text-right font-semibold">건당 순이익</th>
              <th className="px-3 py-2 text-right font-semibold">마진율</th>
              <th className="px-3 py-2 text-right font-semibold">월 순이익</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04]">
            {result.curves.map((curve) => (
              <MarketRow
                key={curve.marketId}
                curve={curve}
                best={result.best?.marketId === curve.marketId}
              />
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[10.5px] leading-relaxed text-slate-600">
        {result.assumptions.join(" ")} 수수료·광고비가 판매가에 비례하므로 건당 순이익은 1차식이고, 마진율 곡선이
        휘는 것은 분모가 판매가이기 때문입니다.
      </p>
    </div>
  );
}
