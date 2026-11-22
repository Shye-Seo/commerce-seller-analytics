import type { Metadata } from "next";
import MarginWorkspace from "@/components/margin/MarginWorkspace";
import PageShell from "@/components/ui/PageShell";

export const metadata: Metadata = {
  title: "수익 분석 — 마진·가격 탄력성·마켓 비교",
  description:
    "판매가를 바꾸면 순이익·마진율·손익분기 판매가가 즉시 다시 계산됩니다. 가격 구간별 적자 지점, 마켓별 마진 비교, 카테고리 요율과 광고비까지 반영한 통장 순수익을 한 화면에서 확인합니다.",
  keywords: ["마진 계산기", "손익분기", "가격 탄력성", "마켓 비교", "순수익 계산기", "셀러 마진"],
};

export default function MarginPage() {
  return (
    <PageShell>
      <MarginWorkspace />
    </PageShell>
  );
}
