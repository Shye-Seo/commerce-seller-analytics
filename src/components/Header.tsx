"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MARKET_PRESETS } from "@/lib/calculator";
import { IconGithub } from "./icons";

/**
 * 상단 내비게이션
 *
 * 화면이 늘어나면서 앵커 8개를 한 줄에 넣을 수 없게 됐다. 그래서 운영 화면(순수익·정산 감시·
 * 재고)을 별도 메뉴로 빼고, 대시보드 안의 세부 섹션(진단·탄력성·마켓 비교)은 스크롤로 읽게 두었다.
 * 현재 경로는 굵기와 밑줄로 표시해, 링크를 눌렀을 때 어디에 있는지 바로 보이게 한다.
 */
const NAV_ITEMS = [
  { href: "/#metrics", label: "핵심 지표", route: false },
  { href: "/#simulator", label: "마진 계산기", route: false },
  { href: "/payout", label: "순수익 계산", route: true },
  { href: "/settlement-watch", label: "정산 감시", route: true },
  { href: "/inventory", label: "재고·발주", route: true },
  { href: "/#reconciliation", label: "정산 대사", route: false },
  { href: "/#keywords", label: "키워드 분석", route: false },
  { href: "/flash", label: "선착순 드롭", route: true },
];

const CONNECTED_MARKETS = [MARKET_PRESETS.smartstore, MARKET_PRESETS.coupang];

export default function Header() {
  const pathname = usePathname();
  // 정적 내보내기(trailingSlash)에서는 "/payout/"처럼 끝에 슬래시가 붙는다.
  const current = (pathname ?? "/").replace(/\/$/, "") || "/";

  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-ink-950/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex shrink-0 items-center gap-3" aria-label="SellerScope 홈">
          <span className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400/90 to-emerald-600 text-ink-950 shadow-glow">
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.1}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M4 15.5 9 9.8l3.6 3.1L20 5.5" />
              <path d="M4 19.5h16" />
            </svg>
          </span>
          <div className="leading-tight">
            <p className="whitespace-nowrap text-[15px] font-semibold tracking-tight text-white">SellerScope</p>
            <p className="hidden whitespace-nowrap text-[11px] font-medium tracking-wide text-slate-500 xl:block">
              COMMERCE SELLER ANALYTICS
            </p>
          </div>
        </Link>

        <nav className="hidden items-center gap-0.5 lg:flex" aria-label="화면 이동">
          {NAV_ITEMS.map((item) => {
            const active = item.route && current === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`whitespace-nowrap rounded-lg px-2 py-2 text-[12px] font-medium transition ${
                  active
                    ? "bg-emerald-400/10 text-emerald-200"
                    : "text-slate-400 hover:bg-white/5 hover:text-white"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-3 whitespace-nowrap rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 2xl:flex">
            {CONNECTED_MARKETS.map((market) => (
              <span key={market.id} className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-slate-400">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: market.color }}
                  aria-hidden
                />
                {market.shortLabel}
              </span>
            ))}
          </div>
          <a
            href="https://github.com/Shye-Seo/commerce-seller-analytics"
            target="_blank"
            rel="noreferrer noopener"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-slate-300 transition hover:border-white/20 hover:text-white"
            aria-label="GitHub 저장소 열기"
          >
            <IconGithub className="h-[18px] w-[18px]" />
          </a>
        </div>
      </div>
    </header>
  );
}
