"use client";

/**
 * 홈 대시보드의 캠페인 현황 카드
 *
 * 선착순 콘솔에서 발급한 쿠폰 원장을 메인 화면에서도 본다. 정산 대사 전이므로 여기 숫자는
 * "원장 기준"이고, 확정 ROAS는 정산 대사 콘솔에서 주문별 매칭을 거친 값이다. 두 기준을
 * 섞지 않도록 카드에 그 사실을 적어 둔다.
 */

import Link from "next/link";
import { useMemo } from "react";
import { summarizeCampaignLedger } from "@/lib/campaignBridge";
import { usePromotionSnapshot } from "@/lib/promotionStore";
import { formatCount, formatWon } from "@/lib/format";

export default function CampaignPerformanceCard() {
  const snapshot = usePromotionSnapshot();

  const ledger = useMemo(
    () =>
      summarizeCampaignLedger({
        ledger: snapshot.ledger,
        orders: snapshot.orders,
        campaigns: snapshot.campaigns,
        campaignSpend: snapshot.campaignSpend,
      }),
    [snapshot],
  );

  const hasData = ledger.issued > 0;

  return (
    <section id="campaign" className="scroll-mt-24" data-testid="home-campaign-card">
      <div className="mb-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400/80">Promotion</p>
        <h2 className="mt-1 text-lg font-semibold tracking-tight text-white">쿠폰 캠페인이 남았는지, 발급 원장에서 정산까지</h2>
        <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-slate-500">
          선착순 드롭 콘솔에서 발급한 쿠폰은 브라우저 원장에 남아 정산 대사 콘솔과 이 화면이 같은 값을 봅니다. 쿠폰 사용 주문은
          주문번호로 정산 행과 매칭되어, 할인 비용을 반영한 순마진과 캠페인별 ROAS로 이어집니다.
        </p>
      </div>

      <div className="card overflow-hidden">
        {hasData ? (
          <>
            <div className="grid gap-px bg-white/[0.06] sm:grid-cols-2 lg:grid-cols-4">
              {[
                { label: "발급 / 사용", value: `${formatCount(ledger.issued)} / ${formatCount(ledger.used)}`, hint: "쿠폰 원장 기준" },
                { label: "쿠폰 할인 총액", value: formatWon(ledger.couponDiscount), hint: `우리 부담 ${formatWon(ledger.ourCouponCost)}` },
                { label: "사용 주문 매출", value: formatWon(ledger.revenue), hint: "결제금액 합(정산 전)" },
                {
                  label: "추정 ROAS",
                  value: ledger.estimatedRoas === null ? "—" : `${ledger.estimatedRoas.toFixed(2)}배`,
                  hint: "매출 ÷ (우리 쿠폰 비용 + 광고비)",
                },
              ].map((stat) => (
                <div key={stat.label} className="bg-[#0A0F1C] px-4 py-4">
                  <p className="text-[10.5px] text-slate-500">{stat.label}</p>
                  <p className="mt-1 text-[19px] font-semibold tabular-nums text-white">{stat.value}</p>
                  <p className="mt-1 text-[10px] text-slate-600">{stat.hint}</p>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-3 border-t border-white/[0.06] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
              <ul className="grid gap-1 text-[11.5px] text-slate-400 sm:grid-cols-2">
                {ledger.campaigns.slice(0, 4).map((campaign) => (
                  <li key={campaign.campaignId}>
                    · {campaign.campaignName} — 사용 {formatCount(campaign.used)} · 할인 {formatWon(campaign.discount)}
                  </li>
                ))}
              </ul>
              <div className="flex shrink-0 items-center gap-2">
                <Link
                  href="/flash"
                  className="rounded-xl border border-white/[0.1] bg-white/[0.03] px-3.5 py-2 text-[12px] font-medium text-slate-200 transition hover:border-white/25 hover:text-white"
                >
                  쿠폰 콘솔
                </Link>
                <Link
                  href="/reconciliation#campaign-attribution"
                  className="rounded-xl bg-emerald-400 px-3.5 py-2 text-[12px] font-semibold text-ink-950 transition hover:bg-emerald-300"
                >
                  정산 매칭 보기
                </Link>
              </div>
            </div>
            <p className="border-t border-white/[0.06] px-4 py-2 text-[10px] leading-relaxed text-slate-600">
              이 카드는 브라우저 원장(localStorage)만 읽습니다. 정산서와 대조한 확정 순마진·ROAS는 정산 대사 콘솔에서 확인하세요.
            </p>
          </>
        ) : (
          <div className="flex flex-col gap-3 px-4 py-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[12.5px] text-slate-300">아직 발급된 쿠폰 원장이 없습니다.</p>
              <p className="mt-1 text-[11px] text-slate-500">
                선착순 드롭 콘솔에서 부하를 한 번 발생시키면 발급·사용 원장과 쿠폰 사용 주문이 이 카드와 정산 대사 콘솔에 함께 나타납니다.
              </p>
            </div>
            <Link
              href="/flash"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-emerald-400 px-4 py-2.5 text-[12.5px] font-semibold text-ink-950 transition hover:bg-emerald-300"
            >
              쿠폰 콘솔 열기
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}
