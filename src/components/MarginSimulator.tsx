"use client";

import { useEffect, useMemo, useState } from "react";
import { MARKET_LIST, RETURN_HANDLING_RATE, recommendSellingPrice } from "@/lib/calculator";
import { formatCount, formatPercent, formatWon } from "@/lib/format";
import type { MarginBreakdown, MarginInput, MarketId } from "@/lib/types";
import { IconAlert } from "./icons";

export interface MarginSimulatorProps {
  input: MarginInput;
  result: MarginBreakdown;
  onChange: (patch: Partial<MarginInput>) => void;
  onSelectMarket: (marketId: MarketId) => void;
}

interface NumberFieldProps {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  suffix?: string;
  hint?: string;
}

/**
 * 숫자 입력 필드.
 *
 * 두 가지 요구를 동시에 만족해야 한다.
 * 1) "12800"을 입력하는 도중("1280", "128")에도 부모 상태가 갱신되어야 한다(실시간 계산).
 * 2) 사용자가 "12800." 처럼 소수점을 입력 중일 때 부모 값(12800)이 입력창을 덮어쓰면 안 된다.
 *
 * 그래서 입력 중에는 로컬 문자열(draft)을 그대로 보여 주고, 포커스가 없을 때만
 * 외부 값과 동기화한다. 마켓 프리셋 변경처럼 외부에서 값이 바뀌는 경우는
 * 포커스가 없는 상태이므로 자연스럽게 반영된다.
 */
function NumberField({ id, label, value, onChange, suffix, hint }: NumberFieldProps) {
  const [draft, setDraft] = useState(() => String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [value, focused]);

  return (
    <div>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <div className="relative mt-1.5">
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={draft}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setDraft(String(value));
          }}
          onChange={(event) => {
            const raw = event.target.value.replace(/[^0-9.]/g, "");
            setDraft(raw);
            const parsed = Number(raw);
            if (raw !== "" && Number.isFinite(parsed)) onChange(parsed);
          }}
          className="input-base pr-9 tabular-nums"
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        {suffix ? (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-medium text-slate-500">
            {suffix}
          </span>
        ) : null}
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="mt-1 text-[11px] text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

interface RangeFieldProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
  hint?: string;
}

function RangeField({
  id,
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
  hint,
}: RangeFieldProps) {
  const filled = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="field-label">
          {label}
        </label>
        <span className="text-sm font-semibold text-white tabular-nums">{display}</span>
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
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-[11px] text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const BREAKDOWN_SEGMENTS = [
  { key: "productCost", label: "상품 원가", color: "#38BDF8" },
  { key: "commission", label: "판매 수수료", color: "#F472B6" },
  { key: "paymentFee", label: "결제 수수료", color: "#FBBF24" },
  { key: "shippingCost", label: "배송비", color: "#A78BFA" },
  { key: "adCost", label: "광고비", color: "#22D3EE" },
  { key: "expectedReturnLoss", label: "반품 손실", color: "#94A3B8" },
] as const;

function CostBreakdown({ result }: { result: MarginBreakdown }) {
  const profit = Math.max(result.netProfitPerUnit, 0);
  const basis = Math.max(result.totalDeduction + profit, 1);

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">판매가 구성</h3>
        <span className="text-[11px] text-slate-500">판매가 {formatWon(result.sellingPrice)}</span>
      </div>

      <div className="mt-4 flex h-2.5 w-full overflow-hidden rounded-full bg-white/5">
        {BREAKDOWN_SEGMENTS.map((segment) => {
          const amount = result[segment.key];
          if (amount <= 0) return null;
          return (
            <span
              key={segment.key}
              className="h-full transition-all duration-300"
              style={{
                width: `${(amount / basis) * 100}%`,
                backgroundColor: segment.color,
              }}
              title={`${segment.label} ${formatWon(amount)}`}
            />
          );
        })}
        {profit > 0 ? (
          <span
            className="h-full bg-emerald-400 transition-all duration-300"
            style={{ width: `${(profit / basis) * 100}%` }}
            title={`순이익 ${formatWon(profit)}`}
          />
        ) : null}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
        {BREAKDOWN_SEGMENTS.map((segment) => (
          <div key={segment.key} className="flex items-center justify-between gap-2">
            <dt className="flex items-center gap-1.5 text-slate-400">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: segment.color }}
                aria-hidden
              />
              {segment.label}
            </dt>
            <dd className="font-medium text-slate-200 tabular-nums">
              {formatWon(result[segment.key])}
            </dd>
          </div>
        ))}
        <div className="col-span-2 mt-1 flex items-center justify-between border-t border-white/[0.06] pt-2">
          <dt className="flex items-center gap-1.5 font-medium text-slate-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
            건당 순이익
          </dt>
          <dd
            className={`font-semibold tabular-nums ${
              result.netProfitPerUnit >= 0 ? "text-emerald-300" : "text-rose-300"
            }`}
          >
            {formatWon(result.netProfitPerUnit)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export default function MarginSimulator({
  input,
  result,
  onChange,
  onSelectMarket,
}: MarginSimulatorProps) {
  const recommendedPrice = useMemo(() => recommendSellingPrice(input, 25), [input]);
  const isLoss = result.netProfitPerUnit < 0;
  const isThin = !isLoss && result.marginRate < 12;

  return (
    <div className="grid gap-5 lg:grid-cols-5">
      <div className="card p-5 sm:p-6 lg:col-span-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white">판매 조건 입력</h3>
            <p className="mt-1 text-[11px] text-slate-500">
              값을 바꾸면 오른쪽 지표가 즉시 다시 계산됩니다.
            </p>
          </div>
          <span className="chip">화면 내 계산 · 서버 요청 없음</span>
        </div>

        <div className="mt-5">
          <p className="field-label mb-2">판매 마켓</p>
          <div className="flex flex-wrap gap-2">
            {MARKET_LIST.map((market) => {
              const active = market.id === input.marketId;
              return (
                <button
                  key={market.id}
                  type="button"
                  onClick={() => onSelectMarket(market.id)}
                  aria-pressed={active}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium transition ${
                    active
                      ? "border-emerald-400/40 bg-emerald-400/10 text-white"
                      : "border-white/[0.08] bg-white/[0.02] text-slate-400 hover:border-white/20 hover:text-slate-200"
                  }`}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: market.color }}
                    aria-hidden
                  />
                  {market.shortLabel}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            {MARKET_LIST.find((market) => market.id === input.marketId)?.note}
          </p>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <NumberField
            id="cost-price"
            label="상품 원가"
            value={input.costPrice}
            onChange={(value) => onChange({ costPrice: value })}
            suffix="원"
            hint="매입가 + 입고 물류비"
          />
          <NumberField
            id="selling-price"
            label="판매가"
            value={input.sellingPrice}
            onChange={(value) => onChange({ sellingPrice: value })}
            suffix="원"
            hint="부가세 포함 소비자가"
          />
          <NumberField
            id="shipping-cost"
            label="셀러 부담 배송비"
            value={input.shippingCost}
            onChange={(value) => onChange({ shippingCost: value })}
            suffix="원"
            hint="무료배송이면 실제 택배 원가를 입력"
          />
          <NumberField
            id="ad-cost"
            label="건당 광고비"
            value={input.adCostPerUnit}
            onChange={(value) => onChange({ adCostPerUnit: value })}
            suffix="원"
            hint="월 광고비 ÷ 월 판매량"
          />
          <NumberField
            id="monthly-units"
            label="월 판매 수량"
            value={input.monthlyUnits}
            onChange={(value) => onChange({ monthlyUnits: value })}
            suffix="건"
          />
          <NumberField
            id="monthly-fixed"
            label="월 고정비"
            value={input.monthlyFixedCost}
            onChange={(value) => onChange({ monthlyFixedCost: value })}
            suffix="원"
            hint="창고비·구독료 등 판매량과 무관한 비용"
          />
        </div>

        <div className="mt-6 space-y-5 border-t border-white/[0.06] pt-5">
          <RangeField
            id="commission-rate"
            label="판매 수수료율"
            value={input.commissionRate}
            min={0}
            max={30}
            step={0.01}
            display={formatPercent(input.commissionRate, 2)}
            onChange={(value) => onChange({ commissionRate: value })}
            hint="마켓 프리셋을 선택하면 기본값이 채워집니다."
          />
          <RangeField
            id="payment-rate"
            label="결제 · PG 수수료율"
            value={input.paymentRate}
            min={0}
            max={10}
            step={0.1}
            display={formatPercent(input.paymentRate, 2)}
            onChange={(value) => onChange({ paymentRate: value })}
            hint="자사몰처럼 PG와 직접 계약한 경우에만 발생합니다."
          />
          <RangeField
            id="return-rate"
            label="반품률"
            value={input.returnRate}
            min={0}
            max={30}
            step={0.5}
            display={formatPercent(input.returnRate, 1)}
            onChange={(value) => onChange({ returnRate: value })}
            hint={`반품 1건당 손실은 왕복 배송비 + 원가의 ${Math.round(RETURN_HANDLING_RATE * 100)}%로 계산합니다.`}
          />
        </div>
      </div>

      <div className="space-y-5 lg:col-span-2">
        <div
          className={`card relative overflow-hidden p-5 ${
            isLoss ? "border-rose-400/25 bg-rose-400/[0.05]" : "border-emerald-400/20 bg-emerald-400/[0.05]"
          }`}
        >
          <p className="text-xs font-medium text-slate-400">건당 순이익</p>
          <p
            className={`mt-2 text-[34px] font-semibold leading-none tracking-tight tabular-nums ${
              isLoss ? "text-rose-300" : "text-emerald-300"
            }`}
          >
            {formatWon(result.netProfitPerUnit)}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-slate-400">
            <span>
              마진율{" "}
              <strong className={isLoss ? "text-rose-300" : "text-white"}>
                {formatPercent(result.marginRate)}
              </strong>
            </span>
            <span>
              실효 수수료율{" "}
              <strong className="text-white">{formatPercent(result.effectiveFeeRate, 2)}</strong>
            </span>
          </div>

          {isLoss || isThin ? (
            <div
              className={`mt-4 flex items-start gap-2 rounded-xl border px-3 py-2.5 text-[12px] leading-relaxed ${
                isLoss
                  ? "border-rose-400/30 bg-rose-400/10 text-rose-200"
                  : "border-amber-400/30 bg-amber-400/10 text-amber-200"
              }`}
            >
              <IconAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {isLoss
                  ? "현재 조건에서는 팔수록 손해입니다. 판매가를 올리거나 광고비·반품률을 낮춰야 합니다."
                  : "마진율이 12% 미만입니다. 광고비와 반품률이 이익을 대부분 가져가고 있습니다."}
              </span>
            </div>
          ) : null}
        </div>

        <div className="card divide-y divide-white/[0.06]">
          {[
            {
              label: "손익분기 판매가",
              value: formatWon(result.breakEvenPrice),
              hint: "이 가격 이하로 팔면 적자",
            },
            {
              label: "손익분기 판매량",
              value:
                result.breakEvenUnits === 0 ? "고정비 없음" : formatCount(result.breakEvenUnits),
              hint: "월 고정비를 회수하는 판매량",
            },
            {
              label: "권장 판매가 (마진 25%)",
              value: formatWon(recommendedPrice),
              hint: "같은 비용 구조에서 25% 마진 확보",
            },
            {
              label: "월 예상 순이익",
              value: formatWon(result.monthlyNetProfit),
              hint: `월 매출 ${formatWon(result.monthlyRevenue)} 기준`,
            },
          ].map((item) => (
            <div key={item.label} className="flex items-center justify-between gap-3 px-5 py-3.5">
              <div>
                <p className="text-[12px] font-medium text-slate-300">{item.label}</p>
                <p className="mt-0.5 text-[11px] text-slate-500">{item.hint}</p>
              </div>
              <p className="shrink-0 text-sm font-semibold text-white tabular-nums">{item.value}</p>
            </div>
          ))}
        </div>

        <CostBreakdown result={result} />
      </div>
    </div>
  );
}
