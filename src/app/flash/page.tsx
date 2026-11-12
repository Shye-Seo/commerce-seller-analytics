import type { Metadata } from "next";
import Link from "next/link";
import FlashCouponConsole from "@/components/FlashCouponConsole";

export const metadata: Metadata = {
  title: "선착순 드롭 콘솔 · SellerScope",
  description:
    "실시간 선착순 쿠폰 발급 엔진: 오버이슈 0건, 멱등 발급, 마진 가드레일, 쇼핑몰 정산 대사까지 한 화면에서 검증합니다.",
};

export default function FlashPage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/" className="text-[12px] text-slate-400 transition hover:text-white">
          ← SellerScope 홈
        </Link>
        <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-[10.5px] text-slate-400">
          Redis + MySQL 8.0 · 조건부 UPDATE
        </span>
      </div>
      <FlashCouponConsole />
    </main>
  );
}
