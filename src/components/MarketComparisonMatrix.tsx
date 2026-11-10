"use client";

import { useMemo } from "react";
import { formatPercent, formatWon } from "@/lib/format";
import { compareMarkets, type MarketComparisonRow } from "@/lib/marketComparison";
import type { MarginInput, MarketId } from "@/lib/types";

export interface MarketComparisonMatrixProps {
  input: MarginInput;
  onSelectMarket: (marketId: MarketId) => void;
}

function Badge({ tone, children }: { tone: "best" | "fast" | "current"; children: string }) {
  const styles = {
    best: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
    fast: "border-sky-400/30 bg-sky-400/10 text-sky-300",
    current: "border-white/[0.14] bg-white/[0.06] text-slate-300",
  } as const;

  return (
    <span
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9.5px] font-semibold leading-none ${styles[tone]}`}
    >
      {children}
    </span>
  );
}

function MarketBadges({ row }: { row: MarketComparisonRow }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {row.isBestMargin ? <Badge tone="best">Best Margin</Badge> : null}
      {row.isFastestSettlement ? <Badge tone="fast">Fast Settlement</Badge> : null}
      {row.isSelected ? <Badge tone="current">현재 선택</Badge> : null}
    </div>
  );
}

function MarginMeter({ value, max }: { value: number; max: number }) {
  const width = max > 0 ? Math.max(Math.min((value / max) * 100, 100), value > 0 ? 3 : 0) : 0;
  const tone =
    value >= 25 ? "bg-emerald-400" : value >= 12 ? "bg-amber-400" : value >= 0 ? "bg-rose-400" : "bg-rose-500";

  return (
    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
      <span className={`block h-full rounded-full ${tone}`} style={{ width: `${width}%` }} />
    </div>
  );
}

/**
 * 5대 마켓 실시간 마진 비교 매트릭스.
 *
 * 같은 상품(판매가·원가·배송비·광고비·반품률·판매량 고정)을 스마트스토어·쿠팡·11번가·
 * G마켓·자사몰에 올렸을 때의 단위 경제성을 나란히 놓는다. 데스크톱은 표, 모바일은 카드로
 * 같은 데이터를 보여 주되, 판단에 필요한 값(건당 순이익·순마진율·정산 주기)의 순서는
 * 두 뷰에서 동일하게 유지한다.
 */
export default function MarketComparisonMatrix({
  input,
  onSelectMarket,
}: MarketComparisonMatrixProps) {
  const comparison = useMemo(() => compareMarkets(input), [input]);
  const bestMarginRate = Math.max(...comparison.rows.map((row) => Math.max(row.marginRate, 0)));

  return (
    <section id="markets" className="scroll-mt-24" aria-labelledby="markets-title">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400/80">
            Market matrix
          </p>
          <h2 id="markets-title" className="mt-1 text-lg font-semibold tracking-tight text-white">
            같은 상품, 5개 마켓 마진 비교
          </h2>
          <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-slate-500">
            판매가·원가·배송비·광고비·반품률·판매량은 그대로 두고, 플랫폼 수수료와 정산 주기만
            바꿔 계산했습니다. &ldquo;어디에 집중할지&rdquo;는 결국 건당 순이익과 현금 회수 속도로
            결정됩니다.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
            최고 마진 {comparison.bestMargin.shortLabel}{" "}
            {formatPercent(comparison.bestMargin.marginRate)}
          </span>
          <span className="chip">
            <span className="h-1.5 w-1.5 rounded-full bg-sky-400" aria-hidden />
            최단 정산 {comparison.fastestSettlement.shortLabel}{" "}
            {comparison.fastestSettlement.settlementDays}일
          </span>
          <span className="chip">월 손익 차이 {formatWon(comparison.monthlySpread)}</span>
        </div>
      </div>

      {/* 데스크톱 · 태블릿: 표 뷰 */}
      <div className="card hidden overflow-hidden md:block">
        <div className="overflow-x-auto thin-scrollbar">
          <table className="w-full min-w-[860px] border-collapse text-left">
            <caption className="sr-only">
              마켓별 수수료율, 건당 수수료, 건당 순이익, 순마진율, 월 순이익, 정산 주기 비교
            </caption>
            <thead>
              <tr className="border-b border-white/[0.06] bg-white/[0.02] text-[10.5px] uppercase tracking-[0.08em] text-slate-500">
                <th scope="col" className="px-4 py-3 font-semibold">
                  판매 채널
                </th>
                <th scope="col" className="px-3 py-3 text-right font-semibold">
                  수수료율
                </th>
                <th scope="col" className="px-3 py-3 text-right font-semibold">
                  건당 수수료
                </th>
                <th scope="col" className="px-3 py-3 text-right font-semibold">
                  건당 순이익
                </th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">
                  순마진율
                </th>
                <th scope="col" className="px-3 py-3 text-right font-semibold">
                  월 순이익
                </th>
                <th scope="col" className="px-3 py-3 text-right font-semibold">
                  정산
                </th>
                <th scope="col" className="px-3 py-3">
                  <span className="sr-only">시뮬레이터에 적용</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {comparison.rows.map((row) => (
                <tr
                  key={row.id}
                  className={`group transition ${
                    row.isSelected
                      ? "bg-white/[0.045]"
                      : row.isBestMargin
                        ? "bg-emerald-400/[0.035]"
                        : "hover:bg-white/[0.02]"
                  }`}
                >
                  <th scope="row" className="px-4 py-3 text-left font-normal">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: row.color }}
                        aria-hidden
                      />
                      <span className="text-[12.5px] font-semibold text-white">{row.shortLabel}</span>
                      <span className="text-[10px] text-slate-500 tabular-nums">{row.rank}위</span>
                    </div>
                    <MarketBadges row={row} />
                  </th>
                  <td className="px-3 py-3 text-right align-top">
                    <p className="text-[12px] font-medium text-slate-200 tabular-nums">
                      {formatPercent(row.totalFeeRate, 2)}
                    </p>
                    <p className="mt-0.5 text-[10px] text-slate-500 tabular-nums">
                      {row.paymentRate > 0
                        ? `PG ${formatPercent(row.paymentRate, 2)}`
                        : `판매 ${formatPercent(row.commissionRate, 2)}`}
                    </p>
                  </td>
                  <td className="px-3 py-3 text-right align-top text-[12px] font-medium text-slate-300 tabular-nums">
                    {formatWon(row.feePerUnit)}
                  </td>
                  <td className="px-3 py-3 text-right align-top">
                    <p
                      className={`text-[12.5px] font-semibold tabular-nums ${
                        row.netProfitPerUnit >= 0 ? "text-emerald-300" : "text-rose-300"
                      }`}
                    >
                      {formatWon(row.netProfitPerUnit)}
                    </p>
                    <p className="mt-0.5 text-[10px] text-slate-500 tabular-nums">
                      {row.gapFromBest === 0 ? "1위" : `1위 대비 −${formatWon(row.gapFromBest)}`}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-right align-top">
                    <p className="text-[12px] font-semibold text-white tabular-nums">
                      {formatPercent(row.marginRate)}
                    </p>
                    <MarginMeter value={row.marginRate} max={bestMarginRate} />
                  </td>
                  <td className="px-3 py-3 text-right align-top">
                    <p
                      className={`text-[12px] font-medium tabular-nums ${
                        row.monthlyNetProfit >= 0 ? "text-slate-200" : "text-rose-300"
                      }`}
                    >
                      {formatWon(row.monthlyNetProfit)}
                    </p>
                    <p className="mt-0.5 text-[10px] text-slate-500 tabular-nums">
                      매출 {formatWon(row.monthlyRevenue)}
                    </p>
                  </td>
                  <td className="px-3 py-3 text-right align-top">
                    <span
                      className={`text-[12px] font-medium tabular-nums ${
                        row.isFastestSettlement ? "text-sky-300" : "text-slate-300"
                      }`}
                    >
                      {row.settlementDays}일
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right align-top">
                    <button
                      type="button"
                      onClick={() => onSelectMarket(row.id)}
                      aria-pressed={row.isSelected}
                      className={`whitespace-nowrap rounded-lg border px-2 py-1 text-[10.5px] font-medium transition ${
                        row.isSelected
                          ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
                          : "border-white/[0.08] bg-white/[0.02] text-slate-400 hover:border-white/25 hover:text-white"
                      }`}
                    >
                      {row.isSelected ? "계산 중" : "적용"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 모바일: 카드 뷰 */}
      <div className="grid gap-3 md:hidden">
        {comparison.rows.map((row) => (
          <article
            key={row.id}
            className={`card p-4 ${
              row.isBestMargin ? "border-emerald-400/25 bg-emerald-400/[0.04]" : ""
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: row.color }}
                    aria-hidden
                  />
                  <h3 className="text-[13px] font-semibold text-white">{row.shortLabel}</h3>
                  <span className="text-[10px] text-slate-500 tabular-nums">{row.rank}위</span>
                </div>
                <MarketBadges row={row} />
              </div>
              <button
                type="button"
                onClick={() => onSelectMarket(row.id)}
                aria-pressed={row.isSelected}
                className={`shrink-0 rounded-lg border px-2 py-1 text-[10.5px] font-medium transition ${
                  row.isSelected
                    ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
                    : "border-white/[0.08] bg-white/[0.02] text-slate-400"
                }`}
              >
                {row.isSelected ? "계산 중" : "적용"}
              </button>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 text-[11px]">
              <div>
                <p className="text-slate-500">수수료율</p>
                <p className="mt-0.5 font-semibold text-slate-200 tabular-nums">
                  {formatPercent(row.totalFeeRate, 2)}
                  <span className="ml-1 text-[10px] font-normal text-slate-500">
                    ({formatWon(row.feePerUnit)})
                  </span>
                </p>
              </div>
              <div>
                <p className="text-slate-500">건당 순이익</p>
                <p
                  className={`mt-0.5 font-semibold tabular-nums ${
                    row.netProfitPerUnit >= 0 ? "text-emerald-300" : "text-rose-300"
                  }`}
                >
                  {formatWon(row.netProfitPerUnit)}
                </p>
              </div>
              <div>
                <p className="text-slate-500">순마진율</p>
                <p className="mt-0.5 font-semibold text-white tabular-nums">
                  {formatPercent(row.marginRate)}
                </p>
                <MarginMeter value={row.marginRate} max={bestMarginRate} />
              </div>
              <div>
                <p className="text-slate-500">정산 주기</p>
                <p
                  className={`mt-0.5 font-semibold tabular-nums ${
                    row.isFastestSettlement ? "text-sky-300" : "text-slate-200"
                  }`}
                >
                  {row.settlementDays}일
                </p>
              </div>
              <div className="col-span-2 border-t border-white/[0.06] pt-2">
                <p className="text-slate-500">월 순이익</p>
                <p
                  className={`mt-0.5 font-semibold tabular-nums ${
                    row.monthlyNetProfit >= 0 ? "text-slate-100" : "text-rose-300"
                  }`}
                >
                  {formatWon(row.monthlyNetProfit)}
                  <span className="ml-1.5 text-[10px] font-normal text-slate-500">
                    매출 {formatWon(row.monthlyRevenue)}
                  </span>
                </p>
              </div>
            </div>
          </article>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-2 text-[10.5px] leading-relaxed text-slate-500">
        <p className="max-w-3xl">
          * 수수료율은 마켓 프리셋(공개 정책 참고값)을 적용했고, 배송비·광고비·반품률은 같은
          상품이면 채널이 달라도 같다고 보고 고정했습니다. 월 판매량도 모든 채널에서 동일하게
          가정했으므로, 실제로는 채널별 노출 규모에 따라 판매량이 달라집니다. 정산 주기는 영업일
          기준입니다.
        </p>
        <p className="shrink-0">계산: calculateMargin() × 5개 프리셋</p>
      </div>
    </section>
  );
}
