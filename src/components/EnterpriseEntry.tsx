import Link from "next/link";
import { reconcileSettlement } from "@/lib/reconciliationEngine";
import { generateSettlementRows, SETTLEMENT_SNAPSHOT_DATE } from "@/lib/settlementFixtures";
import { formatPercent, formatWon } from "@/lib/format";

/**
 * 홈의 엔터프라이즈 진입 카드 (서버 컴포넌트)
 *
 * 숫자를 손으로 적지 않는다. 빌드 시점에 2,000행 데모 원장을 실제로 대사한 결과를 그대로 보여 준다.
 * 고정 시드이므로 빌드마다 같은 숫자가 나오고, 계산 로직이 바뀌면 이 카드의 숫자도 함께 바뀐다.
 */
const snapshot = reconcileSettlement(generateSettlementRows({ count: 2_000, seed: 20261111 }));

const STATS = [
  { label: "대사 행 수", value: `${snapshot.summary.totalRows.toLocaleString("ko-KR")}건`, hint: `${SETTLEMENT_SNAPSHOT_DATE} 기준 데모 원장` },
  { label: "정상 대사율", value: formatPercent(snapshot.summary.matchedRate, 1), hint: `이상 ${snapshot.summary.flaggedRows.toLocaleString("ko-KR")}건 탐지` },
  { label: "누수 추정 손실액", value: formatWon(snapshot.summary.totalLeak), hint: "계약 조건 대비 부족분" },
  { label: "역마진 노출", value: formatWon(snapshot.summary.marginRiskExposure), hint: `${snapshot.summary.negativeMarginRows}건` },
];

export default function EnterpriseEntry() {
  return (
    <section id="reconciliation" className="scroll-mt-24">
      <div className="mb-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400/80">Enterprise</p>
        <h2 className="mt-1 text-lg font-semibold tracking-tight text-white">
          정산서가 틀렸을 때, 그 돈을 되찾는 도구
        </h2>
        <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-slate-500">
          마진 계산은 시작일 뿐입니다. 실제 B2B 커머스 SaaS의 난제는 10만 행 정산서를 브라우저가 멈추지 않고
          처리하면서, 계약과 어긋난 차액을 원인별로 증명하는 일입니다.
        </p>
      </div>

      <div className="card overflow-hidden">
        <div className="grid gap-px bg-white/[0.06] sm:grid-cols-2 lg:grid-cols-4">
          {STATS.map((stat) => (
            <div key={stat.label} className="bg-[#0A0F1C] px-4 py-4">
              <p className="text-[10.5px] text-slate-500">{stat.label}</p>
              <p className="mt-1 text-[19px] font-semibold tabular-nums text-white">{stat.value}</p>
              <p className="mt-1 text-[10px] text-slate-600">{stat.hint}</p>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3 border-t border-white/[0.06] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <ul className="grid gap-1 text-[11.5px] text-slate-400 sm:grid-cols-2">
            <li>· Web Worker 청크 파싱 + 메인 스레드 폴백</li>
            <li>· 10만 행 가상화 테이블 (DOM 절감 3,000배)</li>
            <li>· 수수료·반품비·정산 차액 원인별 귀속</li>
            <li>· 멀티 테넌트 RBAC + 해시체인 감사 로그</li>
          </ul>
          <Link
            href="/reconciliation"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-emerald-400 px-4 py-2.5 text-[12.5px] font-semibold text-ink-950 transition hover:bg-emerald-300"
          >
            정산 대사 콘솔 열기
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden>
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </Link>
        </div>
      </div>
    </section>
  );
}
