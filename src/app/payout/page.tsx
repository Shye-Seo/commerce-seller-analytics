import type { Metadata } from "next";
import Header from "@/components/Header";
import NetPayoutConsole from "@/components/payout/NetPayoutConsole";

export const metadata: Metadata = {
  title: "실수령 순수익 계산기",
  description:
    "매출과 정산금에서 마켓 카테고리별 판매 수수료, 결제 수수료, 광고비(ROAS), 반품 회수·교환 재발송 배송비, 원가, 고정비를 차감해 통장에 실제로 남는 순수익과 손익분기 ROAS를 계산합니다.",
  keywords: ["순수익 계산기", "정산금", "카테고리 수수료", "손익분기 ROAS", "셀러 마진"],
};

export default function PayoutPage() {
  return (
    <div className="min-h-screen bg-ink-950">
      <Header />
      <NetPayoutConsole />
    </div>
  );
}
