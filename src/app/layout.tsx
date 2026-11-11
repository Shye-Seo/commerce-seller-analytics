import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "SellerScope — 정산 대사 & 이커머스 셀러 분석 플랫폼",
    template: "%s | SellerScope",
  },
  description:
    "스마트스토어·쿠팡 셀러를 위한 B2B 정산 대사 콘솔과 마진 분석 대시보드. 10만 행 정산서를 Web Worker로 파싱하고, 계약 기준 기대 정산액과 실제 입금액의 차액을 원인별로 귀속합니다.",
  keywords: [
    "이커머스",
    "정산 대사",
    "reconciliation",
    "이상 탐지",
    "스마트스토어",
    "쿠팡",
    "마진 계산기",
    "Web Worker",
    "가상화 테이블",
    "Next.js",
    "TypeScript",
  ],
  authors: [{ name: "서승혜", url: "https://github.com/Shye-Seo" }],
  creator: "서승혜",
  openGraph: {
    type: "website",
    locale: "ko_KR",
    title: "SellerScope — 정산 대사 & 이커머스 셀러 분석 플랫폼",
    description:
      "10만 행 정산서를 Web Worker로 파싱하고, 수수료 초과·반품비 중복·정산 부족을 원인별 금액으로 증명하는 B2B 정산 대사 콘솔.",
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
