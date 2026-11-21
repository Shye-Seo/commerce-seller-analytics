import type { Metadata } from "next";
import Header from "@/components/Header";
import InventoryConsole from "@/components/inventory/InventoryConsole";

export const metadata: Metadata = {
  title: "품절 임박 · 발주량 계산기",
  description:
    "상품·옵션별 최근 7일 판매 속도로 예상 품절일과 발주 마감일을 계산하고, 리드타임·안전재고·MOQ를 반영한 권장 발주 수량을 산출합니다. 수요 가정 시뮬레이션과 발주서 CSV 내려받기를 지원합니다.",
  keywords: ["품절 임박", "발주량 계산", "재고 관리", "리드타임", "안전재고", "MOQ"],
};

export default function InventoryPage() {
  return (
    <div className="min-h-screen bg-ink-950">
      <Header />
      <InventoryConsole />
    </div>
  );
}
