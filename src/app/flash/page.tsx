import type { Metadata } from "next";
import Link from "next/link";
import FlashCouponConsole from "@/components/FlashCouponConsole";
import PageHeader from "@/components/ui/PageHeader";
import PageShell from "@/components/ui/PageShell";

export const metadata: Metadata = {
  title: "캠페인 — 선착순 쿠폰 드롭",
  description:
    "실시간 선착순 쿠폰 발급 콘솔: 재고를 넘긴 발급 0건, 중복 응모 차단, 마진 가드레일, 쇼핑몰 정산 대사까지 한 화면에서 검증합니다.",
  keywords: ["선착순 쿠폰", "쿠폰 발급", "오버이슈", "중복 차단", "캠페인 ROAS"],
};

export default function FlashPage() {
  return (
    <PageShell>
      <PageHeader
        meta="Campaign"
        title="실시간 선착순 응모 · 쿠폰 발급 콘솔"
        description="재고 100장에 1,000명이 동시에 눌러도 101장이 나가지 않아야 합니다. 이 콘솔은 동시 요청을 실제로 넣어 발급·품절·중복·오버이슈를 집계하고, 발급 원장을 주문·정산과 연결합니다."
        actions={
          <Link href="/settlement" className="btn">
            정산 대사로 확인
          </Link>
        }
      />
      <div className="mt-4">
        <FlashCouponConsole />
      </div>
    </PageShell>
  );
}
