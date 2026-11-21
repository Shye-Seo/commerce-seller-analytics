import type { Metadata } from "next";
import Header from "@/components/Header";
import SettlementWatchConsole from "@/components/settlement-watch/SettlementWatchConsole";

export const metadata: Metadata = {
  title: "정산 누락·지연 감지기",
  description:
    "구매확정일과 마켓별 정산 기한을 기준으로, 정산 예정·완료 내역에 잡히지 않은 주문을 위험·경고로 추출합니다. 누락 의심, 지연 입금, 부분 정산을 한 화면에서 확인합니다.",
  keywords: ["정산 누락", "정산 지연", "구매확정", "정산 기한", "셀러 정산"],
};

export default function SettlementWatchPage() {
  return (
    <div className="min-h-screen bg-ink-950">
      <Header />
      <SettlementWatchConsole />
    </div>
  );
}
