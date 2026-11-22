import type { Metadata } from "next";
import MarginWorkspace from "@/components/margin/MarginWorkspace";
import PageShell from "@/components/ui/PageShell";

/**
 * 이전 주소 유지용 화면
 *
 * `/payout`을 북마크하거나 문서에서 링크한 경우가 있어 지우지 않고, 수익 화면의 실수령 순수익
 * 탭을 바로 연 상태로 보여 준다. 내비게이션에는 노출하지 않는다(주소만 남긴다).
 */
export const metadata: Metadata = {
  title: "실수령 순수익 계산기",
  description:
    "매출과 정산금에서 마켓 카테고리별 판매 수수료, 결제 수수료, 광고비(ROAS), 반품 회수·교환 재발송 배송비, 원가, 고정비를 차감해 통장에 실제로 남는 순수익과 손익분기 ROAS를 계산합니다.",
  keywords: ["순수익 계산기", "정산금", "카테고리 수수료", "손익분기 ROAS", "셀러 마진"],
};

export default function PayoutPage() {
  return (
    <PageShell>
      <MarginWorkspace initialTab="payout" />
    </PageShell>
  );
}
