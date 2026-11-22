import CampaignPerformanceCard from "@/components/CampaignPerformanceCard";
import HomePanels from "@/components/HomePanels";
import OpsEntry from "@/components/OpsEntry";
import KpiStrip, { type KpiItem } from "@/components/ui/KpiStrip";
import PageHeader from "@/components/ui/PageHeader";
import PageShell from "@/components/ui/PageShell";
import { calculateMargin } from "@/lib/calculator";
import { formatCount, formatPercent, formatWon } from "@/lib/format";
import { INVENTORY_PLAN } from "@/lib/inventoryData";
import { DEFAULT_MARGIN_INPUT } from "@/lib/mockData";
import { reconcileSettlement } from "@/lib/reconciliationEngine";
import { generateSettlementRows, SETTLEMENT_SNAPSHOT_DATE } from "@/lib/settlementFixtures";
import { computeSettlementWatch } from "@/lib/settlementWatch";
import { WATCH_LEDGER } from "@/lib/settlementWatchData";

/**
 * 개요 화면
 *
 * 위에서부터 (1) 오늘의 핵심 지표 네 개, (2) 분석 패널 한 장, (3) 운영 모듈 목록과 캠페인 카드.
 * 세로로 쌓는 것은 이 세 덩어리뿐이고, 각 덩어리 안의 세부 화면은 탭·목록으로 접혀 있다.
 * 지표와 카드의 숫자는 모두 빌드 시점에 엔진으로 계산한 값이라, 손으로 적은 숫자가 없다.
 */
const margin = calculateMargin(DEFAULT_MARGIN_INPUT);
const reconciliation = reconcileSettlement(generateSettlementRows({ count: 2_000, seed: 20261111 }));
const watch = computeSettlementWatch(WATCH_LEDGER.orders, WATCH_LEDGER.records, WATCH_LEDGER.snapshotDate);

const marginStatus =
  margin.marginRate >= 25 ? "안정" : margin.marginRate >= 12 ? "주의" : "위험";

const KPI_ITEMS: KpiItem[] = [
  {
    label: "월 예상 순이익",
    value: formatWon(margin.monthlyNetProfit),
    hint: `월 마진 ${formatPercent(margin.monthlyMarginRate)} · 건당 ${formatWon(margin.netProfitPerUnit)}`,
    tone: margin.marginRate >= 25 ? "good" : margin.marginRate >= 12 ? "warn" : "bad",
    status: marginStatus,
    href: "/margin",
  },
  {
    label: "정산 누수 추정",
    value: formatWon(reconciliation.summary.totalLeak),
    hint: `정상 대사율 ${formatPercent(reconciliation.summary.matchedRate, 1)} · 이상 ${formatCount(reconciliation.summary.flaggedRows)}`,
    tone: "bad",
    status: "회수 대상",
    href: "/settlement",
  },
  {
    label: "미수 위험 금액",
    value: formatWon(watch.amounts.atRisk),
    hint: `위험 ${formatCount(watch.counts.risk)} · 경고 ${formatCount(watch.counts.warning)}`,
    tone: "warn",
    status: "확인 필요",
    href: "/settlement-watch",
  },
  {
    label: "품절 임박 SKU",
    value: `${INVENTORY_PLAN.counts.critical}개`,
    hint: `권장 발주 ${INVENTORY_PLAN.totalRecommendedQty.toLocaleString("ko-KR")}개`,
    tone: "warn",
    status: "발주 대기",
    href: "/inventory",
  },
];

export default function HomePage() {
  return (
    <PageShell>
      <PageHeader
        meta="Overview"
        title="오늘의 셀러 상태"
        description={`판매 조건에서 실제로 남는 돈, 아직 들어오지 않은 정산, 곧 끊길 재고를 한 화면에서 봅니다. 지표를 누르면 그 화면으로 이동합니다. 기준일 ${SETTLEMENT_SNAPSHOT_DATE}.`}
        actions={
          <>
            <a href="/settlement" className="btn">
              정산 대사
            </a>
            <a href="/margin" className="btn-primary">
              마진 계산기
            </a>
          </>
        }
      />

      <KpiStrip items={KPI_ITEMS} className="mt-4" />

      <div className="mt-4">
        <HomePanels />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <OpsEntry />
        <CampaignPerformanceCard />
      </div>
    </PageShell>
  );
}
