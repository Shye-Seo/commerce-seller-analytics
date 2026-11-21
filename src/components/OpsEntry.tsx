import Link from "next/link";
import { DEFAULT_NET_PAYOUT_INPUT, calculateNetPayout } from "@/lib/netPayout";
import { INVENTORY_PLAN } from "@/lib/inventoryData";
import { computeSettlementWatch } from "@/lib/settlementWatch";
import { WATCH_LEDGER } from "@/lib/settlementWatchData";
import { formatWon } from "@/lib/format";

/**
 * 홈의 운영 모듈 진입 카드 (서버 컴포넌트)
 *
 * 카드에 적히는 숫자는 손으로 쓰지 않는다. 빌드 시점에 같은 엔진으로 실제 계산한 결과를 쓴다.
 * 계산 규칙이 바뀌면 카드 숫자도 함께 바뀌므로, 화면과 엔진이 어긋날 수 없다.
 */
const payout = calculateNetPayout(DEFAULT_NET_PAYOUT_INPUT);
const watch = computeSettlementWatch(WATCH_LEDGER.orders, WATCH_LEDGER.records, WATCH_LEDGER.snapshotDate);

const MODULES = [
  {
    href: "/payout",
    eyebrow: "Net payout",
    title: "실수령 순수익",
    description: "카테고리 수수료·광고비·반품 배송비까지 차감한 통장 순수익과 손익분기 ROAS.",
    metrics: [
      { label: "월 통장 순수익", value: formatWon(payout.netCash) },
      {
        label: "손익분기 ROAS",
        value: Number.isFinite(payout.breakEvenRoas) ? `${payout.breakEvenRoas.toFixed(2)}배` : "도달 불가",
      },
    ],
  },
  {
    href: "/settlement-watch",
    eyebrow: "Settlement watch",
    title: "정산 누락·지연",
    description: "구매확정일과 마켓 정산 기한을 지난 주문 중 정산 내역에 없는 건만 추출.",
    metrics: [
      { label: "위험 건", value: `${watch.counts.risk}건` },
      { label: "미수 금액", value: formatWon(watch.amounts.atRisk) },
    ],
  },
  {
    href: "/inventory",
    eyebrow: "Stock & replenishment",
    title: "품절 임박·발주량",
    description: "7일 판매 속도로 품절일과 발주 마감일을 계산하고 MOQ에 맞춘 발주량을 제시.",
    metrics: [
      { label: "위험 SKU", value: `${INVENTORY_PLAN.counts.critical}개` },
      { label: "권장 발주", value: `${INVENTORY_PLAN.totalRecommendedQty.toLocaleString("ko-KR")}개` },
    ],
  },
];

export default function OpsEntry() {
  return (
    <section id="ops" className="scroll-mt-24">
      <div className="mb-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400/80">Operations</p>
        <h2 className="mt-1 text-lg font-semibold tracking-tight text-white">
          매달 반복되는 세 가지 계산을 화면으로
        </h2>
        <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-slate-500">
          마진 계산 다음에 남는 일은 정산이 제대로 들어왔는지, 광고를 더 써도 남는지, 다음 발주를
          언제 얼마나 해야 하는지입니다. 세 가지를 각각의 콘솔로 분리했습니다.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {MODULES.map((module) => (
          <Link
            key={module.href}
            href={module.href}
            data-testid={`ops-card-${module.href.replace("/", "")}`}
            className="group card flex flex-col justify-between p-4 transition hover:border-emerald-400/30 hover:bg-white/[0.03]"
          >
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                {module.eyebrow}
              </p>
              <h3 className="mt-1 text-[14px] font-semibold text-white">{module.title}</h3>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{module.description}</p>
            </div>

            <div className="mt-3 flex items-end justify-between gap-2 border-t border-white/[0.06] pt-3">
              <div className="space-y-1">
                {module.metrics.map((metric) => (
                  <div key={metric.label} className="flex items-baseline gap-1.5">
                    <span className="text-[9.5px] text-slate-500">{metric.label}</span>
                    <span className="text-[12px] font-semibold tabular-nums text-slate-100">{metric.value}</span>
                  </div>
                ))}
              </div>
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-300 transition group-hover:gap-1.5">
                열기
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden>
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
