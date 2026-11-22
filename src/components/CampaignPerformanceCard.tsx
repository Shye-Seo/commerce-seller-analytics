"use client";

/**
 * 홈의 캠페인 현황 (클라이언트)
 *
 * 선착순 콘솔에서 발급한 쿠폰 원장을 메인 화면에서도 본다. 정산 대사 전이므로 여기 숫자는
 * "원장 기준"이고, 확정 ROAS는 정산 대사 콘솔에서 주문별 매칭을 거친 값이다. 두 기준을
 * 섞지 않도록 카드에 그 사실을 적어 둔다.
 *
 * 표면은 운영 모듈 목록과 같은 헤어라인 카드 한 장이다. 지표는 2×2로 접어 세로 길이를 줄였다.
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
    <section
      id="campaign"
      data-testid="home-campaign-card"
      className="flex h-full flex-col overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.015]"
      aria-labelledby="campaign-title"
    >
      <div className="flex items-baseline justify-between gap-2 border-b border-white/[0.06] px-4 py-2">
        <h2 id="campaign-title" className="text-[16px] font-semibold text-slate-100">
          쿠폰 캠페인
        </h2>
        <span className="text-[13px] text-slate-400">발급 원장 기준</span>
      </div>

      {hasData ? (
        <>
          <div className="grid grid-cols-2 divide-x divide-white/[0.06]">
            {[
              { label: "발급 / 사용", value: `${formatCount(ledger.issued)} / ${formatCount(ledger.used)}`, hint: "쿠폰 원장" },
              { label: "쿠폰 할인 총액", value: formatWon(ledger.couponDiscount), hint: `우리 부담 ${formatWon(ledger.ourCouponCost)}` },
              { label: "사용 주문 매출", value: formatWon(ledger.revenue), hint: "결제금액 합(정산 전)" },
              {
                label: "추정 ROAS",
                value: ledger.estimatedRoas === null ? "—" : `${ledger.estimatedRoas.toFixed(2)}배`,
                hint: "매출 ÷ (쿠폰 비용 + 광고비)",
              },
            ].map((stat, index) => (
              <div
                key={stat.label}
                className={`px-4 py-2 ${index >= 2 ? "border-t border-white/[0.06]" : ""}`}
              >
                <p className="text-[12.5px] text-slate-400">{stat.label}</p>
                <p className="mt-0.5 text-[16px] font-semibold tabular-nums text-white">{stat.value}</p>
                <p className="truncate text-[12px] text-slate-400">{stat.hint}</p>
              </div>
            ))}
          </div>

          <ul className="flex-1 px-4 py-2 text-[13px] text-slate-300">
            {ledger.campaigns.slice(0, 3).map((campaign) => (
              <li key={campaign.campaignId} className="truncate">
                {campaign.campaignName} — 사용 {formatCount(campaign.used)} · 할인 {formatWon(campaign.discount)}
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] px-4 py-2">
            <Link href="/flash" className="text-[13px] text-slate-400 transition hover:text-white">
              쿠폰 콘솔
            </Link>
            <Link
              href="/reconciliation#campaign-attribution"
              className="text-[13px] font-medium text-emerald-300 transition hover:text-emerald-200"
            >
              정산 매칭 보기 →
            </Link>
          </div>
        </>
      ) : (
        <div className="flex flex-1 flex-col justify-between gap-3 px-4 py-3">
          <div>
            <p className="text-[14px] text-slate-300">아직 발급된 쿠폰 원장이 없습니다.</p>
            <p className="mt-1 text-[13px] leading-relaxed text-slate-300">
              쿠폰 콘솔에서 부하를 한 번 발생시키면 발급·사용 원장과 쿠폰 사용 주문이 이 카드와 정산
              대사 콘솔에 함께 나타납니다.
            </p>
          </div>
          <Link href="/flash" className="btn-primary self-start">
            쿠폰 콘솔 열기
          </Link>
        </div>
      )}
    </section>
  );
}
