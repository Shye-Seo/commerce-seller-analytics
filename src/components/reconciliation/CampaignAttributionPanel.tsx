"use client";

/**
 * 쿠폰 비용 매칭 · 캠페인 ROAS 패널
 *
 * 정산 대사가 끝난 행(`ReconciledRow`)과 쿠폰 원장에서 만든 주문(`MarketingOrder`)을 대조해
 * "쿠폰으로 할인한 돈이 정산에 그대로 반영됐는지"와 "그 캠페인이 남았는지"를 한 화면에 보여 준다.
 *
 * 화면은 계산하지 않는다. 값은 전부 `campaignBridge`가 만든 것이고, 여기서는 읽기 좋게 배치만 한다.
 */

import Link from "next/link";
import { formatCount, formatPercent, formatWon } from "@/lib/format";
import type { CampaignPerformanceSummary } from "@/lib/campaignBridge";
import type { SimulationSummary } from "@/lib/promotionStore";

interface Props {
  performance: CampaignPerformanceSummary;
  issuedCoupons: number;
  simulation: SimulationSummary | null;
  campaignSpend: Record<number, number>;
  onSpendChange: (campaignId: number, amount: number) => void;
  onReset: () => void;
  onReload: () => void;
}

function Metric({ label, value, hint, tone = "default", testId }: { label: string; value: string; hint: string; tone?: "default" | "good" | "warn" | "danger"; testId?: string }) {
  const toneClass = tone === "good" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : tone === "danger" ? "text-rose-300" : "text-white";
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5" data-testid={testId}>
      <p className="text-[10.5px] text-slate-500">{label}</p>
      <p className={`mt-1 text-[18px] font-semibold leading-tight tabular-nums ${toneClass}`}>{value}</p>
      <p className="mt-0.5 text-[10px] leading-snug text-slate-600">{hint}</p>
    </div>
  );
}

export default function CampaignAttributionPanel({ performance, issuedCoupons, simulation, campaignSpend, onSpendChange, onReset, onReload }: Props) {
  const { match, totals, campaigns } = performance;
  const hasLedger = match.ordersLinked > 0;
  // 원장은 있는데 현재 정산서에 쿠폰 주문이 하나도 없는 경우(파일 업로드·마켓 API 수집)
  const allMissing = hasLedger && match.missingSettlement === match.rows.length;

  return (
    <section className="card p-4" data-testid="campaign-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400/80">Coupon attribution</p>
          <h2 className="mt-1 text-[13.5px] font-semibold text-white">쿠폰 비용 매칭 · 캠페인별 ROAS</h2>
          <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-slate-500">
            선착순 콘솔에서 발급한 쿠폰 중 실제 주문으로 이어진 건을 <strong className="font-medium text-slate-300">주문번호</strong>로 정산 행과
            맞춥니다. 정산서의 결제금액은 이미 할인 반영 후 금액이므로, 역산한 할인액이 원장 할인액과 같은지 대조하고
            차액은 회수 대상으로 분리합니다.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[10px] text-slate-400">
            발급 {formatCount(issuedCoupons)} · 사용 {formatCount(match.ordersLinked)}
          </span>
          <Link href="/flash" className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-[11px] text-slate-300 transition hover:border-white/20 hover:text-white">
            쿠폰 콘솔
          </Link>
          <button
            type="button"
            onClick={onReset}
            disabled={!hasLedger}
            className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 text-[11px] text-slate-500 transition enabled:hover:border-rose-400/40 enabled:hover:text-rose-300 disabled:opacity-40"
          >
            원장 비우기
          </button>
        </div>
      </div>

      {!hasLedger ? (
        <div className="mt-3 rounded-xl border border-dashed border-white/[0.08] px-4 py-6 text-center" data-testid="campaign-panel-empty">
          <p className="text-[12px] text-slate-400">
            아직 연결된 쿠폰 원장이 없습니다.{" "}
            <Link href="/flash" className="text-emerald-300 underline decoration-emerald-400/40 underline-offset-2">
              선착순 드롭 콘솔
            </Link>
            에서 부하를 한 번 발생시키면 발급 원장과 주문 연결이 이 화면으로 넘어옵니다.
          </p>
          <p className="mt-1.5 text-[10.5px] text-slate-600">
            원장은 브라우저 localStorage에만 저장되며 서버로 전송되지 않습니다.
          </p>
        </div>
      ) : (
        <>
          {allMissing && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.07] px-3 py-2 text-[11.5px] text-amber-200" data-testid="campaign-missing-settlement">
              <span>
                쿠폰 원장은 있지만 현재 정산서에 쿠폰 주문이 하나도 없습니다({formatCount(match.missingSettlement)}건 누락). 업로드한 파일에 쿠폰 주문이 없는 것이 맞다면 그대로 두면 됩니다.
              </span>
              <button
                type="button"
                onClick={onReload}
                className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-2.5 py-1 text-[11px] font-medium text-amber-100 transition hover:bg-amber-400/20"
              >
                쿠폰 주문 포함해 다시 대사
              </button>
            </div>
          )}

          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              label="쿠폰 할인 총액"
              value={formatWon(totals.couponDiscount)}
              hint={`우리 부담 ${formatWon(totals.ourCouponCost)} · 제휴사 ${formatWon(totals.partnerCost)}`}
              tone="warn"
            />
            <Metric
              label="쿠폰 반영 후 순마진"
              value={formatWon(totals.netMargin)}
              hint={`반영 전 ${formatWon(totals.netMarginBeforeCoupon)} · 마진율 ${formatPercent(totals.netMarginRate, 1)}`}
              tone={totals.netMargin >= 0 ? "good" : "danger"}
            />
            <Metric
              label="캠페인 ROAS"
              testId="campaign-roas"
              value={totals.roas === null ? "—" : `${totals.roas.toFixed(2)}배`}
              hint={`귀속 매출 ${formatWon(totals.revenue)} ÷ 미디어 비용 ${formatWon(totals.mediaCost)}`}
              tone={totals.roas !== null && totals.roas >= 3 ? "good" : "warn"}
            />
            <Metric
              label="광고비 차감 기여이익"
              value={formatWon(totals.contributionAfterAdSpend)}
              hint={`순마진 ${formatWon(totals.netMargin)} − 광고비 ${formatWon(totals.adSpend)}`}
              tone={totals.contributionAfterAdSpend >= 0 ? "good" : "danger"}
            />
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[11.5px]">
              <thead className="text-[10px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 font-medium">캠페인</th>
                  <th className="px-2 py-1.5 font-medium text-right">사용 주문</th>
                  <th className="px-2 py-1.5 font-medium text-right">귀속 매출</th>
                  <th className="px-2 py-1.5 font-medium text-right">쿠폰 할인</th>
                  <th className="px-2 py-1.5 font-medium text-right">집행 광고비</th>
                  <th className="px-2 py-1.5 font-medium text-right">순마진</th>
                  <th className="px-2 py-1.5 font-medium text-right">ROAS</th>
                  <th className="px-2 py-1.5 font-medium text-right">예산 소진</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((campaign) => (
                  <tr key={campaign.campaignId} className="border-t border-white/[0.05]">
                    <td className="px-2 py-2">
                      <p className="font-medium text-slate-200">{campaign.campaignName}</p>
                      <p className="text-[10px] text-slate-500">
                        {campaign.campaignCode} · {campaign.byTemplate.map((template) => `${template.templateName} ${template.orders}건`).join(" · ")}
                      </p>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-slate-300">{formatCount(campaign.orders)}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-slate-300">{formatWon(campaign.revenue)}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-amber-200/90">{formatWon(campaign.couponDiscount)}</td>
                    <td className="px-2 py-2 text-right">
                      <input
                        type="number"
                        min={0}
                        step={100_000}
                        value={campaignSpend[campaign.campaignId] ?? campaign.adSpend}
                        onChange={(event) => onSpendChange(campaign.campaignId, Number(event.target.value))}
                        aria-label={`${campaign.campaignName} 집행 광고비`}
                        className="w-28 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-right text-[11.5px] tabular-nums text-slate-200 outline-none focus:border-emerald-400/50"
                      />
                    </td>
                    <td className={`px-2 py-2 text-right tabular-nums ${campaign.netMargin >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{formatWon(campaign.netMargin)}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-slate-200">{campaign.roas === null ? "—" : `${campaign.roas.toFixed(2)}배`}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-slate-400">{formatPercent(campaign.budgetUsedRate, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/[0.05] px-3 py-2">
              <p className="text-[10px] text-emerald-200/80">원장 = 정산 일치</p>
              <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-emerald-200">{formatCount(match.matched)}</p>
              <p className="text-[10px] text-slate-500">할인액을 정산서에서 그대로 확인</p>
            </div>
            <div className="rounded-lg border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2">
              <p className="text-[10px] text-amber-200/80">차액 · 회수 대상</p>
              <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-amber-200">{formatWon(match.recoverable)}</p>
              <p className="text-[10px] text-slate-500">
                불일치 {formatCount(match.disputed)} · 정산서 할인 차감 {formatWon(match.settlementDeduction)}
              </p>
            </div>
            <div className="rounded-lg border border-rose-400/20 bg-rose-400/[0.05] px-3 py-2">
              <p className="text-[10px] text-rose-200/80">정산 누락 · 우리 부담</p>
              <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-rose-200">
                {formatCount(match.missingSettlement)} · {formatWon(match.overborne)}
              </p>
              <p className="text-[10px] text-slate-500">쿠폰 주문이 정산서에 없거나 우리가 더 부담</p>
            </div>
          </div>
        </>
      )}

      <p className="mt-3 border-t border-white/[0.05] pt-2 text-[10px] leading-relaxed text-slate-600">
        계산식: 순마진 = 실정산액 − 매입원가 − 실배송원가(결제금액이 할인 반영 후이므로 쿠폰 비용이 이미 차감된 값).
        ROAS = 귀속 매출 ÷ (우리 부담 쿠폰 비용 + 집행 광고비). 제휴사 부담 쿠폰은 우리 비용이 아니므로 분모에서 뺍니다.
        쿠폰 사용 주문과 집행 광고비는 데모 시뮬레이터가 만든 값이며, 광고비는 위 표에서 직접 바꿀 수 있습니다.
        {simulation ? ` 마지막 시뮬레이션: ${simulation.presetLabel} · 요청 ${simulation.requests.toLocaleString("ko-KR")}건 · 발급 ${simulation.issued.toLocaleString("ko-KR")}장.` : ""}
      </p>
    </section>
  );
}
