import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "SellerScope — 이커머스 셀러 마진 시뮬레이터 & 키워드 분석",
    template: "%s | SellerScope",
  },
  description:
    "스마트스토어·쿠팡 셀러를 위한 실시간 마진 시뮬레이터와 키워드 기회 분석 대시보드. 수수료·배송비·광고비·반품률을 반영한 실제 순이익과 손익분기 판매가를 즉시 계산합니다.",
  keywords: [
    "이커머스",
    "스마트스토어",
    "쿠팡",
    "마진 계산기",
    "키워드 분석",
    "셀러 대시보드",
    "Next.js",
    "TypeScript",
  ],
  authors: [{ name: "서승혜", url: "https://github.com/Shye-Seo" }],
  creator: "서승혜",
  openGraph: {
    type: "website",
    locale: "ko_KR",
    title: "SellerScope — 이커머스 셀러 마진 시뮬레이터 & 키워드 분석",
    description:
      "수수료·배송비·광고비·반품률을 반영한 실시간 마진 계산과 키워드 기회 지수 분석을 한 화면에서.",
    siteName: "SellerScope",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#070B16",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-screen bg-ink-950 font-sans text-slate-200 antialiased">
        {children}
      </body>
    </html>
  );
}
