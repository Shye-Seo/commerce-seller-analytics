import type { Metadata } from "next";
import Header from "@/components/Header";
import ReconciliationConsole from "@/components/reconciliation/ReconciliationConsole";

export const metadata: Metadata = {
  title: "정산 대사 콘솔 · B2B 이상 탐지",
  description:
    "스마트스토어·쿠팡 정산서 10만 행을 Web Worker로 파싱하고, 계약 수수료율 기준 기대 정산액과 실제 입금액을 대사합니다. 수수료 초과 청구·반품비 중복 차감·역마진을 원인별로 귀속하고, 멀티 테넌트 RBAC과 해시체인 감사 로그로 반출까지 통제합니다.",
  keywords: ["정산 대사", "reconciliation", "이상 탐지", "Web Worker", "가상화 테이블", "RBAC", "B2B SaaS"],
};

export default function ReconciliationPage() {
  return (
    <div className="min-h-screen bg-ink-950">
      <Header />
      <ReconciliationConsole />
    </div>
  );
}
