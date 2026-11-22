"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconGithub } from "./icons";

/**
 * 전역 내비게이션 — 한 단계, 다섯 칸
 *
 * 원칙은 하나다. 메뉴는 "셀러가 오늘 하는 일" 단위로만 나눈다. 세부 화면은 각 페이지 안의
 * 세그먼트 탭으로 들어가므로, 여기에는 하위 메뉴도, 앵커 링크도 두지 않는다. 메뉴가 늘어나면
 * 사용자는 지금 어디에 있는지보다 무엇을 눌러야 하는지를 먼저 고민하게 된다.
 *
 * 왼쪽부터 개요 → 수익 → 정산 → 재고 → 캠페인 순서는 하루의 흐름(현황 파악 → 단가 판단 →
 * 입금 확인 → 발주 → 판촉)과 같다.
 */
const NAV_ITEMS = [
  { id: "home", href: "/", label: "개요", match: ["/"] },
  { id: "margin", href: "/margin", label: "수익", match: ["/margin", "/payout"] },
  { id: "settlement", href: "/settlement", label: "정산", match: ["/settlement", "/reconciliation", "/settlement-watch"] },
  { id: "inventory", href: "/inventory", label: "재고", match: ["/inventory"] },
  { id: "campaign", href: "/flash", label: "캠페인", match: ["/flash"] },
];

export default function Header() {
  const pathname = usePathname();
  // 정적 내보내기(trailingSlash)에서는 "/margin/"처럼 끝에 슬래시가 붙는다.
  const current = (pathname ?? "/").replace(/\/$/, "") || "/";
  const activeId = NAV_ITEMS.find((item) => item.match.includes(current))?.id;

  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.07] bg-ink-950/85 backdrop-blur-xl">
      <div className="mx-auto flex h-14 w-full max-w-[1280px] items-center gap-2 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="SellerScope 홈">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-emerald-400/25 bg-emerald-400/10 text-emerald-300">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 15.5 9 9.8l3.6 3.1L20 5.5" />
              <path d="M4 19.5h16" />
            </svg>
          </span>
          <span className="hidden whitespace-nowrap text-[14.5px] font-semibold tracking-tight text-white sm:block">SellerScope</span>
        </Link>

        <nav className="thin-scrollbar ml-1 flex flex-1 items-center gap-0.5 overflow-x-auto sm:ml-2" aria-label="주요 화면">
          {NAV_ITEMS.map((item) => {
            const active = item.id === activeId;
            return (
              <Link
                key={item.id}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative shrink-0 whitespace-nowrap rounded-md px-2.5 py-2 text-[14px] font-medium transition ${
                  active ? "bg-white/[0.07] text-white" : "text-slate-400 hover:bg-white/[0.03] hover:text-slate-100"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-1.5">
          <span className="hidden items-center gap-1.5 rounded-md border border-white/[0.07] px-2 py-1 text-[13px] text-slate-300 xl:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
            스마트스토어·쿠팡 연결
          </span>
          <a
            href="https://github.com/Shye-Seo/commerce-seller-analytics"
            target="_blank"
            rel="noreferrer noopener"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-white/[0.08] text-slate-400 transition hover:border-white/20 hover:text-white"
            aria-label="GitHub 저장소 열기"
          >
            <IconGithub className="h-[15px] w-[15px]" />
          </a>
        </div>
      </div>
    </header>
  );
}
