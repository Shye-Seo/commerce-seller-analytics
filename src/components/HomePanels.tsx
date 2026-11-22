"use client";

import { useMemo, useState } from "react";
import { calculateMargin } from "@/lib/calculator";
import { DAILY_SALES, DEFAULT_MARGIN_INPUT, MONTHLY_SALES, SCORED_KEYWORDS } from "@/lib/mockData";
import KeywordRankingTable from "./KeywordRankingTable";
import SalesTrendChart from "./SalesTrendChart";
import SmartInsightBox from "./SmartInsightBox";
import Segmented from "./ui/Segmented";

/**
 * 개요 화면의 분석 패널
 *
 * 진단·추이·키워드를 세로로 쌓지 않고 한 자리에서 바꿔 본다. 첫 화면에서 보이는 것은
 * 지표 스트립 → 이 패널의 첫 탭(진단)까지이고, 나머지는 누르면 같은 높이에서 교체된다.
 * 셀러가 하루에 한 번 보는 화면이라 "스크롤해서 찾기"보다 "탭으로 고르기"가 빠르다.
 *
 * 마진 입력값은 개요에서 바꾸지 않는다(수익 화면에서 조정). 여기서는 기본 조건의 진단만 보여 준다.
 */
type HomeTab = "diagnosis" | "trend" | "keywords";

const TABS = [
  { id: "diagnosis" as const, label: "수익 구조 진단" },
  { id: "trend" as const, label: "매출·마진 추이" },
  { id: "keywords" as const, label: "키워드 기회" },
];

export default function HomePanels() {
  const [tab, setTab] = useState<HomeTab>("diagnosis");
  const result = useMemo(() => calculateMargin(DEFAULT_MARGIN_INPUT), []);

  return (
    <section className="rounded-xl border border-white/[0.07] bg-white/[0.015]" aria-label="분석 패널">
      <div className="px-3 pt-1.5">
        <Segmented items={TABS} value={tab} onChange={setTab} label="개요 분석" testIdPrefix="home-tab" />
      </div>

      <div className="p-4" role="tabpanel" aria-label={TABS.find((item) => item.id === tab)?.label ?? "분석"}>
        {tab === "diagnosis" ? <SmartInsightBox input={DEFAULT_MARGIN_INPUT} result={result} /> : null}
        {tab === "trend" ? <SalesTrendChart daily={DAILY_SALES} monthly={MONTHLY_SALES} /> : null}
        {tab === "keywords" ? <KeywordRankingTable rows={SCORED_KEYWORDS} /> : null}
      </div>
    </section>
  );
}
