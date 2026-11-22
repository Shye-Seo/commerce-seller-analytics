"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { MARKET_PRESETS, calculateMargin } from "@/lib/calculator";
import { formatCount, formatPercent, formatWon } from "@/lib/format";
import { DEFAULT_MARGIN_INPUT } from "@/lib/mockData";
import type { MarginInput, MarketId } from "@/lib/types";
import ElasticityPanel from "@/components/ElasticityPanel";
import MarginSimulator from "@/components/MarginSimulator";
import MarketComparisonMatrix from "@/components/MarketComparisonMatrix";
import NetPayoutConsole from "@/components/payout/NetPayoutConsole";
import KpiStrip, { type KpiItem } from "@/components/ui/KpiStrip";
import PageHeader from "@/components/ui/PageHeader";
import Segmented from "@/components/ui/Segmented";

/**
 * 수익 화면 — 마진·가격·마켓·순수익을 한 페이지 안에서
 *
 * 예전에는 계산기·탄력성·마켓 비교가 개요 아래로 이어져 한 화면이 세 배 길었다. 지금은
 * 판매 조건(input) 하나를 이 컴포넌트가 소유하고, 네 개의 보기는 탭으로 교체된다. 조건을
 * 한 번 바꾸면 어느 탭에서 보든 같은 값으로 다시 계산된다(상태는 하나, 화면은 여러 개).
 *
 * 실수령 순수익 콘솔은 입력 체계가 달라(카테고리 요율·ROAS·반품률) 자체 상태를 갖는다.
 * 탭을 오가도 초기화되지 않도록 항상 마운트해 두고 hidden으로만 감춘다.
 */
type MarginTab = "calculator" | "elasticity" | "markets" | "payout";

const TABS = [
  { id: "calculator" as const, label: "마진 계산기" },
  { id: "elasticity" as const, label: "가격 탄력성" },
  { id: "markets" as const, label: "마켓 비교" },
  { id: "payout" as const, label: "실수령 순수익" },
];

export default function MarginWorkspace({ initialTab = "calculator" }: { initialTab?: MarginTab }) {
  const [input, setInput] = useState<MarginInput>(DEFAULT_MARGIN_INPUT);
  const [tab, setTab] = useState<MarginTab>(initialTab);

  const result = useMemo(() => calculateMargin(input), [input]);

  const handleChange = useCallback((patch: Partial<MarginInput>) => {
    setInput((previous) => ({ ...previous, ...patch }));
  }, []);

  const handleSelectMarket = useCallback((marketId: MarketId) => {
    const preset = MARKET_PRESETS[marketId];
    setInput((previous) => ({
      ...previous,
      marketId,
      commissionRate: preset.commissionRate,
      paymentRate: preset.paymentRate,
      shippingCost: preset.defaultShippingFee,
    }));
  }, []);

  const marginStatus = result.marginRate >= 25 ? "안정" : result.marginRate >= 12 ? "주의" : "위험";

  const kpis: KpiItem[] = [
    {
      label: "월 예상 매출",
      value: formatWon(result.monthlyRevenue),
      hint: `월 ${formatCount(input.monthlyUnits)} × ${formatWon(input.sellingPrice)}`,
    },
    {
      label: "월 예상 순이익",
      value: formatWon(result.monthlyNetProfit),
      hint: `고정비 ${formatWon(input.monthlyFixedCost)} 차감 후`,
      tone: result.monthlyNetProfit > 0 ? "good" : "bad",
    },
    {
      label: "건당 마진율",
      value: formatPercent(result.marginRate),
      hint: `건당 순이익 ${formatWon(result.netProfitPerUnit)}`,
      tone: result.marginRate >= 25 ? "good" : result.marginRate >= 12 ? "warn" : "bad",
      status: marginStatus,
    },
    {
      label: "손익분기 판매가",
      value: formatWon(result.breakEvenPrice),
      hint: "이 가격 이하로 팔면 적자",
    },
  ];

  return (
    <>
      <PageHeader
        meta="Profit"
        title="수익 — 마진, 가격, 마켓, 통장"
        description="판매 조건을 한 번 정하면 마진 계산기·가격 탄력성·마켓 비교가 같은 조건으로 다시 계산됩니다. 실수령 순수익은 카테고리 요율과 광고비까지 반영한 통장 기준 금액입니다."
        actions={
          <Link href="/settlement" className="btn">
            정산서와 대조
          </Link>
        }
      />

      {tab === "payout" ? null : <KpiStrip items={kpis} className="mt-4" />}

      <div className="mt-4 px-0.5">
        <Segmented items={TABS} value={tab} onChange={setTab} label="수익 분석 보기" testIdPrefix="margin-tab" />
      </div>

      <div className="mt-4">
        {tab === "calculator" ? (
          <MarginSimulator input={input} result={result} onChange={handleChange} onSelectMarket={handleSelectMarket} />
        ) : null}

        {tab === "elasticity" ? <ElasticityPanel input={input} onApply={handleChange} /> : null}

        {tab === "markets" ? <MarketComparisonMatrix input={input} onSelectMarket={handleSelectMarket} /> : null}

        <div hidden={tab !== "payout"}>
          <NetPayoutConsole />
        </div>
      </div>
    </>
  );
}
