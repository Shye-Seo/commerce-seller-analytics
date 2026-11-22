import type { Metadata } from "next";
import SettlementWorkspace from "@/components/settlement/SettlementWorkspace";
import PageShell from "@/components/ui/PageShell";

/**
 * 이전 주소 유지용 화면
 *
 * 정산 화면이 `/settlement`로 통합되면서 `/reconciliation`은 대사 개요 탭을 바로 연다.
 * 문서·북마크에 남아 있는 주소가 깨지지 않도록 내비게이션에서만 빼고 주소는 살려 둔다.
 */
export const metadata: Metadata = {
  title: "정산 대사 — 계약 기준 재계산",
  description:
    "스마트스토어·쿠팡 정산서 10만 행을 처리하고, 계약 수수료율 기준 기대 정산액과 실제 입금액을 대사합니다. 수수료 초과 청구·반품비 중복 차감·역마진을 원인별로 귀속하고, 멀티 테넌트 권한과 감사 기록으로 반출까지 통제합니다.",
  keywords: ["정산 대사", "reconciliation", "이상 탐지", "가상화 테이블", "RBAC", "B2B SaaS"],
};

export default function ReconciliationPage() {
  return (
    <PageShell>
      <SettlementWorkspace initialTab="overview" />
    </PageShell>
  );
}
