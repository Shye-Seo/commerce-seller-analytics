import Link from "next/link";
import { DEFAULT_NET_PAYOUT_INPUT, calculateNetPayout } from "@/lib/netPayout";
import { INVENTORY_PLAN } from "@/lib/inventoryData";
import { computeSettlementWatch } from "@/lib/settlementWatch";
import { WATCH_LEDGER } from "@/lib/settlementWatchData";
import { demoReconciliation } from "@/lib/demoLedger";
import { formatCount, formatPercent, formatWon } from "@/lib/format";

/**
 * 홈의 운영 모듈 진입 목록 (서버 컴포넌트)
 *
 * 카드 네 장을 띄우는 대신 한 줄씩 쌓은 목록으로 바꿨다. 목록은 "이름 → 지금 값 두 개 → 열기"
 * 순서로 읽히므로 세로 길이가 카드 그리드의 절반이고, 같은 정보를 세로 정렬로 비교할 수 있다.
 *
 * 카드에 적히는 숫자는 손으로 쓰지 않는다. 빌드 시점에 각 엔진으로 실제 계산한 결과를 쓴다.
 * 계산 규칙이 바뀌면 카드 숫자도 함께 바뀌므로, 화면과 엔진이 어긋날 수 없다.
 */
const payout = calculateNetPayout(DEFAULT_NET_PAYOUT_INPUT);
const watch = computeSettlementWatch(WATCH_LEDGER.orders, WATCH_LEDGER.records, WATCH_LEDGER.snapshotDate);
const reconciliation = demoReconciliation();

const MODULES = [
  {
    href: "/margin",
    testId: "ops-card-payout",
    title: "실수령 순수익",
    description: "카테고리 수수료·광고비·반품 배송비까지 뺀 통장 순수익과 손익분기 ROAS",
    metrics: [
      { label: "월 순수익", value: formatWon(payout.netCash) },
      {
        label: "손익분기 ROAS",
        value: Number.isFinite(payout.breakEvenRoas) ? `${payout.breakEvenRoas.toFixed(2)}배` : "도달 불가",
      },
    ],
  },
  {
    href: "/settlement-watch",
    testId: "ops-card-settlement-watch",
    title: "정산 누락·지연",
    description: "정산 기한을 지난 주문 중 정산 내역에 없는 건만 추출",
    metrics: [
      { label: "위험 건", value: formatCount(watch.counts.risk) },
      { label: "미수 금액", value: formatWon(watch.amounts.atRisk) },
    ],
  },
  {
    href: "/inventory",
    testId: "ops-card-inventory",
    title: "품절 임박·발주량",
    description: "7일 판매 속도로 품절일과 발주 마감일을 계산하고 MOQ에 맞춘 발주량 제시",
    metrics: [
      { label: "위험 SKU", value: `${INVENTORY_PLAN.counts.critical}개` },
      { label: "권장 발주", value: `${INVENTORY_PLAN.totalRecommendedQty.toLocaleString("ko-KR")}개` },
    ],
  },
  {
    href: "/reconciliation",
    testId: "ops-card-reconciliation",
    title: "정산서 대사",
    description: "계약 조건과 어긋난 차액을 수수료·반품·정산 부족으로 원인별 귀속",
    metrics: [
      { label: "정상 대사율", value: formatPercent(reconciliation.summary.matchedRate, 1) },
      { label: "누수 추정", value: formatWon(reconciliation.summary.totalLeak) },
    ],
  },
];

export default function OpsEntry() {
  return (
    <section id="ops" aria-labelledby="ops-title">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 id="ops-title" className="text-[13px] font-semibold text-slate-100">
          운영 모듈
        </h2>
        <p className="text-[10.5px] text-slate-600">매달 반복되는 네 가지 계산</p>
      </div>

      <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.015]">
        {MODULES.map((module) => (
          <li key={module.href}>
            <Link
              href={module.href}
              data-testid={module.testId}
              className="group flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition hover:bg-white/[0.03]"
            >
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] font-semibold text-slate-100">{module.title}</p>
                <p className="hidden truncate text-[10.5px] text-slate-500 sm:block">{module.description}</p>
              </div>
              <div className="flex w-full shrink-0 items-center justify-between gap-3 sm:w-auto sm:justify-end sm:gap-4">
                {module.metrics.map((metric) => (
                  <div key={metric.label} className="text-right">
                    <p className="text-[9.5px] text-slate-600">{metric.label}</p>
                    <p className="text-[11.5px] font-semibold tabular-nums text-slate-200 sm:text-[12px]">{metric.value}</p>
                  </div>
                ))}
                <span className="text-[11px] text-slate-600 transition group-hover:text-emerald-300" aria-hidden>
                  →
                </span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
