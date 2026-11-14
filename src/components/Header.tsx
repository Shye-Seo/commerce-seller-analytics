import { MARKET_PRESETS } from "@/lib/calculator";
import Link from "next/link";
import { IconGithub } from "./icons";

const NAV_ITEMS = [
  { href: "/#metrics", label: "핵심 지표" },
  { href: "/#diagnosis", label: "AI 진단" },
  { href: "/#simulator", label: "마진 계산기" },
  { href: "/#markets", label: "마켓 비교" },
  { href: "/#reconciliation", label: "정산 대사" },
  { href: "/#keywords", label: "키워드 분석" },
  { href: "/flash", label: "선착순 드롭" },
  { href: "/reconciliation#alimtalk", label: "알림톡" },
  { href: "/api-docs", label: "API 문서" },
];

const CONNECTED_MARKETS = [MARKET_PRESETS.smartstore, MARKET_PRESETS.coupang];

export default function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-ink-950/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
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
            <p className="text-[15px] font-semibold tracking-tight text-white">SellerScope</p>
            <p className="text-[11px] font-medium tracking-wide text-slate-500">
              COMMERCE SELLER ANALYTICS
            </p>
          </div>
        </div>

        <nav className="hidden items-center gap-0.5 lg:flex" aria-label="섹션 이동">
          {NAV_ITEMS.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-lg px-2.5 py-2 text-[12.5px] font-medium text-slate-400 transition hover:bg-white/5 hover:text-white"
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-3 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 lg:flex">
            {CONNECTED_MARKETS.map((market) => (
              <span key={market.id} className="flex items-center gap-1.5 text-[11px] text-slate-400">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: market.color }}
                  aria-hidden
                />
                {market.shortLabel}
              </span>
            ))}
          </div>
          <Link
            href="/reconciliation"
            className="hidden rounded-lg border border-emerald-400/25 bg-emerald-400/10 px-3 py-1.5 text-[11.5px] font-semibold text-emerald-200 transition hover:border-emerald-400/50 hover:text-emerald-100 xl:inline-flex"
          >
            정산 대사 콘솔
          </Link>
          <span className="hidden rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1.5 text-[11px] font-medium text-emerald-300 sm:inline-flex">
            데모 데이터
          </span>
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
