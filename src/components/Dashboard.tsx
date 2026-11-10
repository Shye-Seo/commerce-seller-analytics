"use client";

import { useCallback, useMemo, useState } from "react";
import { MARKET_PRESETS, calculateMargin } from "@/lib/calculator";
import { formatCount, formatPercent, formatWon } from "@/lib/format";
import { DEFAULT_MARGIN_INPUT } from "@/lib/mockData";
import type { MarginInput, MarketId } from "@/lib/types";
import { IconPercent, IconTarget, IconTrend, IconWallet } from "./icons";
import MarginSimulator from "./MarginSimulator";
import MetricCard from "./MetricCard";

/**
 * 대시보드 상태의 단일 소유자.
 *
 * 마진 입력값 하나만 상태로 두고, 화면에 보이는 모든 지표(건당 순이익, 월 순이익,
 * 손익분기점 등)는 `calculateMargin`의 순수 함수 결과에서 파생시킨다.
 * 파생값을 별도 상태로 두면 "판매가를 바꿨는데 월 순이익이 갱신되지 않는" 종류의
 * 버그가 생기므로, 상태는 최소로 두고 파생은 useMemo로 처리한다.
 */
export default function Dashboard() {
  const [input, setInput] = useState<MarginInput>(DEFAULT_MARGIN_INPUT);

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

  const marginBadge =
    result.marginRate >= 25
      ? { label: "안정", tone: "good" as const }
      : result.marginRate >= 12
        ? { label: "주의", tone: "warn" as const }
        : { label: "위험", tone: "bad" as const };

  return (
    <section id="metrics" className="scroll-mt-24">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400/80">
            Live metrics
          </p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-white">
            지금 설정한 판매 조건의 손익
          </h2>
        </div>
        <p className="text-[11px] text-slate-500">
          아래에서 조건을 바꾸면 이 지표들이 즉시 다시 계산됩니다.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="월 예상 매출"
          value={formatWon(result.monthlyRevenue)}
          caption={`월 ${formatCount(input.monthlyUnits)} × ${formatWon(input.sellingPrice)}`}
          icon={<IconTrend className="h-4 w-4" />}
          tone="sky"
        />
        <MetricCard
          label="월 예상 순이익"
          value={formatWon(result.monthlyNetProfit)}
          caption={`고정비 ${formatWon(input.monthlyFixedCost)} 차감 후`}
          icon={<IconWallet className="h-4 w-4" />}
          tone="emerald"
          badge={{ label: `월 마진 ${formatPercent(result.monthlyMarginRate)}`, tone: marginBadge.tone }}
        />
        <MetricCard
          label="건당 마진율"
          value={formatPercent(result.marginRate)}
          caption={`건당 순이익 ${formatWon(result.netProfitPerUnit)}`}
          icon={<IconPercent className="h-4 w-4" />}
          tone="violet"
          badge={marginBadge}
        />
        <MetricCard
          label="손익분기 판매가"
          value={formatWon(result.breakEvenPrice)}
          caption="이 가격 이하로 팔면 적자"
          icon={<IconTarget className="h-4 w-4" />}
          tone="amber"
        />
      </div>

      <div id="simulator" className="mt-6 scroll-mt-24">
        <MarginSimulator
          input={input}
          result={result}
          onChange={handleChange}
          onSelectMarket={handleSelectMarket}
        />
      </div>
    </section>
  );
}
