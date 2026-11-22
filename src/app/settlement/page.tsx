import type { Metadata } from "next";
import SettlementWorkspace from "@/components/settlement/SettlementWorkspace";
import PageShell from "@/components/ui/PageShell";

export const metadata: Metadata = {
  title: "정산 — 대사·누락 감지",
  description:
    "스마트스토어·쿠팡 정산서의 계약 수수료 기준 기대 정산액과 실제 입금액을 대사하고, 수수료 초과·반품비 중복·역마진을 원인별 금액으로 귀속합니다. 정산 기한을 지난 미수 주문도 같은 화면에서 확인합니다.",
  keywords: ["정산 대사", "정산 누락", "정산 지연", "이상 탐지", "셀러 정산", "반품비 중복"],
};

export default function SettlementPage() {
  return (
    <PageShell>
      <SettlementWorkspace />
    </PageShell>
  );
}
