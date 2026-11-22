import type { Metadata } from "next";
import InventoryConsole from "@/components/inventory/InventoryConsole";
import PageHeader from "@/components/ui/PageHeader";
import PageShell from "@/components/ui/PageShell";

export const metadata: Metadata = {
  title: "품절 임박 · 발주량 계산기",
  description:
    "상품·옵션별 최근 7일 판매 속도로 예상 품절일과 발주 마감일을 계산하고, 리드타임·안전재고·MOQ를 반영한 권장 발주 수량을 산출합니다. 수요 가정 시뮬레이션과 발주서 CSV 내려받기를 지원합니다.",
  keywords: ["품절 임박", "발주량 계산", "재고 관리", "리드타임", "안전재고", "MOQ"],
};

export default function InventoryPage() {
  return (
    <PageShell>
      <PageHeader
        meta="Inventory"
        title="재고가 몇 개 남았는지보다, 언제 끊기고 오늘 얼마를 발주할지"
        description="최근 7일 판매 속도로 품절일과 발주 마감일을 계산하고, 리드타임·안전재고·MOQ를 반영한 발주량을 제시합니다. 수요 가정을 바꾸면 발주량이 바로 다시 계산됩니다."
      />
      <div className="mt-4">
        <InventoryConsole />
      </div>
    </PageShell>
  );
}
