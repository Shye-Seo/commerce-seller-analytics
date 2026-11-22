"use client";

import { useMemo, useState } from "react";
import {
  DEFAULT_NET_PAYOUT_INPUT,
  FEE_CATEGORY_BY_ID,
  FEE_CATEGORIES,
  calculateNetPayout,
  resolveCategoryFee,
  simulateRoas,
  type FeeCategoryId,
  type NetPayoutInput,
} from "@/lib/netPayout";
import { MARKET_LIST, MARKET_PRESETS } from "@/lib/calculator";
import { formatPercent, formatWon } from "@/lib/format";
import type { MarketId } from "@/lib/types";

/**
 * 실수령 순수익 계산기 (화면)
 *
 * 입력(매출·정산서 금액·ROAS·반품률)을 바꾸면 아래 숫자가 전부 다시 계산된다. 계산은
 * `calculateNetPayout`이 하고, 이 컴포넌트는 결과를 배치만 한다.
 *
 * 화면의 순서는 셀러가 돈을 확인하는 순서와 같다.
 *   매출 → (수수료 차감) → 정산금 → (광고·배송·원가·고정비 차감) → 통장 순수익
 * 그래서 맨 위에 "통장 순수익"을 두고, 어떤 항목이 얼마를 가져갔는지 그 아래에 쌓아 보여 준다.
 */

const CHART = { width: 720, height: 230, top: 16, right: 16, bottom: 34, left: 62 } as const;
const INNER_W = CHART.width - CHART.left - CHART.right;
const INNER_H = CHART.height - CHART.top - CHART.bottom;

function Slider({
  id,
  label,
  value,
  min,
  max,
  step,
  display,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  hint?: string;
  onChange: (value: number) => void;
}) {
  const filled = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="field-label">
          {label}
        </label>
        <span className="text-[14.5px] font-semibold tabular-nums text-white">{display}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        data-testid={id}
        onChange={(event) => onChange(Number(event.target.value))}
        className="range mt-2"
        style={{
          background: `linear-gradient(to right, #34D399 ${filled}%, rgba(255,255,255,0.10) ${filled}%)`,
        }}
      />
      {hint ? <p className="mt-1.5 text-[13px] text-slate-300">{hint}</p> : null}
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  suffix,
  step = 1000,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  suffix: string;
  step?: number;
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      <span className="mt-1 flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-2 focus-within:border-emerald-400/50">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={0}
          step={step}
          value={Number.isFinite(value) ? value : 0}
          data-testid={id}
          onChange={(event) => onChange(Number(event.target.value))}
          className="w-full bg-transparent text-right text-[14.5px] font-medium tabular-nums text-white outline-none"
        />
        <span className="shrink-0 text-[13px] text-slate-300">{suffix}</span>
      </span>
      {hint ? <span className="mt-1 block text-[13px] text-slate-400">{hint}</span> : null}
    </label>
  );
}

export default function NetPayoutConsole() {
  const [input, setInput] = useState<NetPayoutInput>(DEFAULT_NET_PAYOUT_INPUT);

  const result = useMemo(() => calculateNetPayout(input), [input]);
  const curve = useMemo(() => simulateRoas(input, [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 10]), [input]);

  const patch = (next: Partial<NetPayoutInput>): void => {
    setInput((previous) => ({ ...previous, ...next }));
  };

  const selectMarket = (marketId: MarketId): void => {
    const preset = MARKET_PRESETS[marketId];
    patch({
      marketId,
      commissionRate: resolveCategoryFee(marketId, input.categoryId),
      paymentRate: preset.paymentRate,
    });
  };

  const selectCategory = (categoryId: FeeCategoryId): void => {
    patch({
      categoryId,
      commissionRate: resolveCategoryFee(input.marketId, categoryId),
    });
  };

  const category = FEE_CATEGORY_BY_ID[input.categoryId];
  const isProfitable = result.netCash >= 0;

  const breakdown = [
    { label: "광고비", value: result.adSpend, color: "#F59E0B" },
    { label: "반품·교환 배송", value: result.returnShippingLoss + result.exchangeShippingLoss, color: "#FB7185" },
    { label: "상품 원가", value: result.cogs, color: "#6366F1" },
    { label: "고정비", value: result.fixedCost, color: "#64748B" },
    { label: "통장 순수익", value: Math.max(0, result.netCash), color: "#34D399" },
  ];
  const breakdownTotal = breakdown.reduce((sum, item) => sum + item.value, 0) || 1;

  const chart = useMemo(() => {
    const values = curve.map((point) => point.netCash);
    const maxValue = Math.max(0, ...values);
    const minValue = Math.min(0, ...values);
    const span = Math.max(1, maxValue - minValue);
    const xOf = (roas: number) =>
      CHART.left + ((roas - 1) / Math.max(1, 10 - 1)) * INNER_W;
    const yOf = (value: number) =>
      CHART.top + INNER_H - ((value - minValue) / span) * INNER_H;
    const path = curve
      .map((point, index) => `${index === 0 ? "M" : "L"}${xOf(point.roas).toFixed(1)},${yOf(point.netCash).toFixed(1)}`)
      .join(" ");
    return { xOf, yOf, path, zeroY: yOf(0) };
  }, [curve]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[16px] font-semibold text-slate-100">
          매출도 정산금도 아닌, 통장에 실제로 남는 순수익
        </h2>
        <p className="text-[13px] text-slate-400">
          카테고리 요율·광고비(ROAS)·반품 배송비·원가·고정비를 순서대로 차감
        </p>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className={`card px-4 py-3 ${isProfitable ? "" : "border-rose-400/25"}`}>
          <p className="text-[13px] text-slate-300">월 통장 순수익</p>
          <p
            className={`mt-1 text-[22px] font-bold leading-tight tabular-nums ${isProfitable ? "text-emerald-300" : "text-rose-300"}`}
            data-testid="payout-net-cash"
          >
            {formatWon(result.netCash)}
          </p>
          <p className="mt-1 text-[13px] text-slate-300">
            정산금 {formatWon(result.settlementBase)} · 건당 {formatWon(result.netPerOrder)}
          </p>
        </div>

        <div className="card px-4 py-3">
          <p className="text-[13px] text-slate-300">매출 대비 순수익률</p>
          <p className="mt-1 text-[22px] font-bold leading-tight tabular-nums text-white" data-testid="payout-net-margin">
            {formatPercent(result.netMarginRate, 1)}
          </p>
          <p className="mt-1 text-[13px] text-slate-300">
            판매 수수료율 {formatPercent(result.commissionRate, 2)} · 결제 {formatPercent(input.paymentRate, 2)}
          </p>
        </div>

        <div className="card px-4 py-3">
          <p className="text-[13px] text-slate-300">손익분기 ROAS</p>
          <p className="mt-1 text-[22px] font-bold leading-tight tabular-nums text-amber-200" data-testid="payout-breakeven-roas">
            {Number.isFinite(result.breakEvenRoas) ? `${result.breakEvenRoas.toFixed(2)}배` : "도달 불가"}
          </p>
          <p className="mt-1 text-[13px] text-slate-300">
            {result.roasHeadroom === null
              ? "광고를 켜면 적자입니다"
              : `현재 ${result.currentRoas.toFixed(1)}배 · 여유 ${result.roasHeadroom.toFixed(0)}%`}
          </p>
        </div>

        <div className="card px-4 py-3">
          <p className="text-[13px] text-slate-300">월 광고비</p>
          <p className="mt-1 text-[22px] font-bold leading-tight tabular-nums text-white" data-testid="payout-ad-spend">
            {formatWon(result.adSpend)}
          </p>
          <p className="mt-1 text-[13px] text-slate-300">
            손익분기까지 쓸 수 있는 한도 {formatWon(result.maxAdSpend)}
          </p>
        </div>
      </section>

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <section className="card p-4 sm:p-5" aria-label="계산 조건">
          <div className="flex items-center justify-between">
            <h2 className="text-[15.5px] font-semibold text-white">계산 조건</h2>
            <span className="chip">입력 즉시 재계산</span>
          </div>

          <div className="mt-3">
            <p className="field-label">판매 마켓</p>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              {MARKET_LIST.map((market) => {
                const active = market.id === input.marketId;
                return (
                  <button
                    key={market.id}
                    type="button"
                    aria-pressed={active}
                    data-testid={`payout-market-${market.id}`}
                    onClick={() => selectMarket(market.id)}
                    className={`rounded-lg border px-2 py-2 text-left text-[13px] font-medium transition ${
                      active
                        ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-100"
                        : "border-white/[0.07] bg-white/[0.02] text-slate-400 hover:border-white/20"
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: market.color }} aria-hidden />
                      {market.shortLabel}
                    </span>
                    <span className="mt-0.5 block text-[12.5px] tabular-nums text-slate-300">
                      {resolveCategoryFee(market.id, input.categoryId).toFixed(2)}%
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <label className="mt-3 block">
            <span className="field-label">카테고리</span>
            <select
              value={input.categoryId}
              data-testid="payout-category-select"
              onChange={(event) => selectCategory(event.target.value as FeeCategoryId)}
              className="input-base mt-1.5"
              aria-label="카테고리"
            >
              {FEE_CATEGORIES.map((option) => (
                <option key={option.id} value={option.id} className="bg-ink-900">
                  {option.label} · {resolveCategoryFee(input.marketId, option.id).toFixed(2)}%
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[13px] leading-relaxed text-slate-400">{category.note}</span>
          </label>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <NumberField
              id="payout-revenue"
              label="월 매출"
              value={input.monthlyRevenue}
              suffix="원"
              step={100_000}
              onChange={(value) => patch({ monthlyRevenue: value })}
            />
            <NumberField
              id="payout-settlement"
              label="정산서 금액"
              value={input.settlementAmount}
              suffix="원"
              step={100_000}
              hint="모르면 0"
              onChange={(value) => patch({ settlementAmount: value })}
            />
          </div>

          <div className="mt-3 space-y-4">
            <Slider
              id="payout-roas"
              label="광고 ROAS"
              value={input.roas}
              min={0}
              max={10}
              step={0.1}
              display={input.roas === 0 ? "광고 없음" : `${input.roas.toFixed(1)}배`}
              hint={
                input.roas === 0
                  ? "광고비를 반영하지 않습니다."
                  : `광고비 ${formatWon(result.adSpend)} · 매출의 ${(100 / input.roas).toFixed(1)}%`
              }
              onChange={(value) => patch({ roas: value })}
            />
            <Slider
              id="payout-return-rate"
              label="반품률"
              value={input.returnRate}
              min={0}
              max={40}
              step={0.5}
              display={formatPercent(input.returnRate, 1)}
              hint={`반품 ${result.returns}건 · 회수 배송비 왕복 ${formatWon(input.returnShippingFee * 2)}`}
              onChange={(value) => patch({ returnRate: value })}
            />
            <Slider
              id="payout-exchange-rate"
              label="교환률"
              value={input.exchangeRate}
              min={0}
              max={30}
              step={0.5}
              display={formatPercent(input.exchangeRate, 1)}
              hint={`교환 ${result.exchanges}건 · 재발송 ${formatWon(input.exchangeShippingFee)}`}
              onChange={(value) => patch({ exchangeRate: value })}
            />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <NumberField
              id="payout-cogs-rate"
              label="원가율"
              value={input.cogsRate}
              suffix="%"
              step={0.5}
              onChange={(value) => patch({ cogsRate: value })}
            />
            <NumberField
              id="payout-aov"
              label="평균 객단가"
              value={input.averageOrderValue}
              suffix="원"
              step={1000}
              onChange={(value) => patch({ averageOrderValue: value })}
            />
            <NumberField
              id="payout-fixed-cost"
              label="월 고정비"
              value={input.monthlyFixedCost}
              suffix="원"
              step={50_000}
              onChange={(value) => patch({ monthlyFixedCost: value })}
            />
            <NumberField
              id="payout-commission"
              label="판매 수수료율"
              value={input.commissionRate}
              suffix="%"
              step={0.01}
              onChange={(value) => patch({ commissionRate: value })}
            />
          </div>

          <p className="mt-3 text-[12.5px] leading-relaxed text-slate-400">
            카테고리를 바꾸면 그 카테고리의 계약 요율로 맞춰집니다. 실제 계약 요율이 다르면 판매
            수수료율을 직접 고치세요.
          </p>
        </section>

        <div className="space-y-4">
          <section className="card p-4 sm:p-5" aria-label="정산금에서 순수익까지">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-[15.5px] font-semibold text-white">정산금에서 통장까지</h2>
                <p className="mt-0.5 text-[13px] text-slate-300">
                  정산금이 어디로 빠져나가는지 금액과 비중으로 봅니다.
                </p>
              </div>
              {result.settlementGap !== null ? (
                <span
                  className={`rounded-lg border px-2.5 py-2 text-[13px] font-medium ${
                    result.settlementGap < 0
                      ? "border-rose-400/30 bg-rose-400/10 text-rose-200"
                      : "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                  }`}
                  data-testid="payout-settlement-gap"
                >
                  정산서 {formatWon(result.confirmedSettlement as number)} · 예상 대비{" "}
                  {result.settlementGap > 0 ? "+" : ""}
                  {formatWon(result.settlementGap)}
                </span>
              ) : (
                <span className="chip">정산서 금액을 넣으면 차액을 대조합니다</span>
              )}
            </div>

            <div className="mt-4 flex h-3 w-full overflow-hidden rounded-full bg-white/[0.05]" role="img" aria-label="정산금 구성 비중">
              {breakdown.map((item) => (
                <span
                  key={item.label}
                  style={{ width: `${(item.value / breakdownTotal) * 100}%`, backgroundColor: item.color }}
                  title={`${item.label} ${formatWon(item.value)}`}
                />
              ))}
            </div>

            <dl className="mt-4 space-y-1.5 text-[14px]">
              <div className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.02] px-3 py-2">
                <dt className="text-slate-400">
                  매출 {formatWon(result.revenue)} · 반품 {result.returns}건 차감 후 {formatWon(result.keptRevenue)}
                </dt>
                <dd className="tabular-nums text-slate-300">— 판매 수수료 {formatWon(result.commission)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <dt className="text-slate-400">예상 정산금</dt>
                <dd className="tabular-nums text-white" data-testid="payout-expected-settlement">
                  {formatWon(result.expectedSettlement)}
                </dd>
              </div>
              {[
                { label: "광고비", value: result.adSpend },
                { label: "반품 회수 배송비", value: result.returnShippingLoss },
                { label: "교환 재발송 배송비", value: result.exchangeShippingLoss },
                { label: "상품 원가", value: result.cogs },
                { label: "월 고정비", value: result.fixedCost },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-3 px-3 py-1 text-slate-400">
                  <dt>− {row.label}</dt>
                  <dd className="tabular-nums text-slate-300">{formatWon(row.value)}</dd>
                </div>
              ))}
              <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.06] px-3 py-2">
                <dt className="font-medium text-emerald-200">통장에 남는 순수익</dt>
                <dd className={`tabular-nums font-semibold ${isProfitable ? "text-emerald-200" : "text-rose-300"}`}>
                  {formatWon(result.netCash)}
                </dd>
              </div>
            </dl>
          </section>

          <section className="card p-4 sm:p-5" aria-label="ROAS 시뮬레이션">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 className="text-[15.5px] font-semibold text-white">ROAS를 바꾸면 순수익은 어디서 꺾이는가</h2>
                <p className="mt-0.5 text-[13px] text-slate-300">
                  가로축 ROAS, 세로축 월 순수익입니다. 0원 선과 만나는 점이 손익분기 ROAS입니다.
                </p>
              </div>
              <span className="text-[13px] tabular-nums text-slate-400">
                현재 <span className="font-semibold text-emerald-300">{input.roas.toFixed(1)}배</span> ·{" "}
                {formatWon(result.netCash)}
              </span>
            </div>

            <svg
              viewBox={`0 0 ${CHART.width} ${CHART.height}`}
              className="mt-3 h-auto w-full"
              role="img"
              aria-label={`ROAS별 월 순수익 곡선. 손익분기 ${Number.isFinite(result.breakEvenRoas) ? `${result.breakEvenRoas.toFixed(2)}배` : "도달 불가"}`}
              data-testid="payout-roas-chart"
            >
              <line
                x1={CHART.left}
                x2={CHART.left + INNER_W}
                y1={chart.zeroY}
                y2={chart.zeroY}
                stroke="rgba(255,255,255,0.24)"
                strokeDasharray="4 4"
              />
              <text x={CHART.left - 8} y={chart.zeroY + 3.5} textAnchor="end" fontSize={11.5} fill="#94A3B8">
                0원
              </text>

              {[1, 3, 5, 8, 10].map((roas) => (
                <text
                  key={roas}
                  x={chart.xOf(roas)}
                  y={CHART.top + INNER_H + 16}
                  textAnchor="middle"
                  fontSize={11.5}
                  fill="#94A3B8"
                >
                  {roas}배
                </text>
              ))}

              {Number.isFinite(result.breakEvenRoas) &&
              result.breakEvenRoas >= 1 &&
              result.breakEvenRoas <= 10 ? (
                <g>
                  <line
                    x1={chart.xOf(result.breakEvenRoas)}
                    x2={chart.xOf(result.breakEvenRoas)}
                    y1={CHART.top}
                    y2={CHART.top + INNER_H}
                    stroke="rgba(251,191,36,0.5)"
                    strokeDasharray="3 3"
                  />
                  <text
                    x={chart.xOf(result.breakEvenRoas) + 3}
                    y={CHART.top + 10}
                    fontSize={11}
                    fill="#FCD34D"
                  >
                    손익분기 {result.breakEvenRoas.toFixed(2)}배
                  </text>
                </g>
              ) : null}

              <path d={chart.path} fill="none" stroke="#34D399" strokeWidth={2} strokeLinecap="round" />

              {input.roas >= 1 && input.roas <= 10 ? (
                <circle
                  cx={chart.xOf(input.roas)}
                  cy={chart.yOf(result.netCash)}
                  r={4}
                  fill="#34D399"
                  stroke="#070B16"
                  strokeWidth={2}
                />
              ) : null}

              <text x={CHART.left} y={CHART.height - 4} fontSize={11} fill="#94A3B8">
                광고를 끄면(0배) 광고비 0원 · 순수익 최대
              </text>
            </svg>
          </section>
        </div>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <section className="card overflow-hidden" aria-label="카테고리별 순수익">
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <h2 className="text-[16px] font-semibold text-white">같은 매출, 카테고리만 바꾸면</h2>
              <p className="mt-0.5 text-[13px] text-slate-300">
                {MARKET_PRESETS[input.marketId].label} 기준 · 수수료율 차이만 반영합니다.
              </p>
            </div>
          </div>
          <table className="w-full border-collapse text-[13.5px]" data-testid="payout-category-table">
            <thead>
              <tr className="border-y border-white/[0.06] bg-white/[0.02] text-[12.5px] text-slate-300">
                <th className="px-4 py-2 text-left font-semibold">카테고리</th>
                <th className="px-3 py-2 text-right font-semibold">수수료율</th>
                <th className="px-3 py-2 text-right font-semibold">수수료</th>
                <th className="px-3 py-2 text-right font-semibold">통장 순수익</th>
                <th className="px-4 py-2 text-right font-semibold">차액</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {result.categoryScenarios.map((row) => {
                const active = row.categoryId === input.categoryId;
                return (
                  <tr key={row.categoryId} className={active ? "bg-emerald-400/[0.05]" : undefined}>
                    <td className="px-4 py-2 text-slate-200">
                      {row.label}
                      {active ? (
                        <span className="ml-1.5 rounded border border-emerald-400/30 px-1 text-[12px] text-emerald-300">
                          선택
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-400">{row.commissionRate.toFixed(2)}%</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-300">{formatWon(row.commission)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${row.netCash >= 0 ? "text-slate-100" : "text-rose-300"}`}>
                      {formatWon(row.netCash)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-400">
                      {row.delta === 0 ? "—" : `${row.delta > 0 ? "+" : ""}${formatWon(row.delta)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="card overflow-hidden" aria-label="마켓별 순수익">
          <div className="px-4 py-3">
            <h2 className="text-[16px] font-semibold text-white">같은 상품, 마켓만 바꾸면</h2>
            <p className="mt-0.5 text-[13px] text-slate-300">
              {FEE_CATEGORY_BY_ID[input.categoryId].label} · 판매 수수료와 결제 수수료를 함께 반영합니다.
            </p>
          </div>
          <table className="w-full border-collapse text-[13.5px]" data-testid="payout-market-table">
            <thead>
              <tr className="border-y border-white/[0.06] bg-white/[0.02] text-[12.5px] text-slate-300">
                <th className="px-4 py-2 text-left font-semibold">마켓</th>
                <th className="px-3 py-2 text-right font-semibold">수수료율</th>
                <th className="px-3 py-2 text-right font-semibold">통장 순수익</th>
                <th className="px-4 py-2 text-right font-semibold">차액</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {result.marketScenarios.map((row) => {
                const active = row.marketId === input.marketId;
                return (
                  <tr key={row.marketId} className={active ? "bg-emerald-400/[0.05]" : undefined}>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-1.5 text-slate-200">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: row.color }} aria-hidden />
                        {row.shortLabel}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-400">{row.commissionRate.toFixed(2)}%</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${row.netCash >= 0 ? "text-slate-100" : "text-rose-300"}`}>
                      {formatWon(row.netCash)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-400">
                      {row.delta === 0 ? "—" : `${row.delta > 0 ? "+" : ""}${formatWon(row.delta)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="px-4 py-2 text-[12.5px] leading-relaxed text-slate-400">
            자사몰은 중개 수수료가 없지만 결제 수수료(3.3%)와 광고비 비중이 커집니다. 배송·반품 조건이
            같다는 가정이므로, 실제로는 마켓별 배송 정책까지 함께 봐야 합니다.
          </p>
        </section>
      </div>

      <p className="mt-4 text-[13px] leading-relaxed text-slate-400">
        {result.assumptions.join(" ")} 카테고리 요율은 각 마켓이 공개한 구간을 기준으로 한 값이며, 실제
        정산 금액과 다를 수 있습니다.
      </p>
    </div>
  );
}
