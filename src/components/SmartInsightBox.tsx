"use client";

import { useMemo } from "react";
import {
  CPS_CEILING_RATE,
  diagnoseMargin,
  TARGET_MARGIN_RATE,
  type DiagnosticAction,
  type MarginDiagnosis,
  type MarginGrade,
} from "@/lib/diagnostics";
import { formatPercent, formatWon } from "@/lib/format";
import type { MarginBreakdown, MarginInput } from "@/lib/types";

export interface SmartInsightBoxProps {
  input: MarginInput;
  result: MarginBreakdown;
}

/**
 * 등급별 색.
 * 초록/노랑/빨강만으로 구분하면 색각 이상 사용자가 읽기 어려우므로, 배지에는 항상
 * 등급 텍스트("우수/주의/위험")를 함께 노출하고 점수 숫자도 같이 보여 준다.
 */
const GRADE_STYLE: Record<
  MarginGrade,
  { text: string; chip: string; stroke: string; bar: string; suffix: string }
> = {
  우수: {
    text: "text-emerald-300",
    chip: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
    stroke: "#34D399",
    bar: "bg-emerald-400",
    suffix: "지금 구조를 유지해도 됩니다",
  },
  주의: {
    text: "text-amber-300",
    chip: "border-amber-400/25 bg-amber-400/10 text-amber-300",
    stroke: "#FBBF24",
    bar: "bg-amber-400",
    suffix: "한두 곳만 손보면 안정권입니다",
  },
  위험: {
    text: "text-rose-300",
    chip: "border-rose-400/25 bg-rose-400/10 text-rose-300",
    stroke: "#FB7185",
    bar: "bg-rose-400",
    suffix: "가격·비용 구조를 먼저 고쳐야 합니다",
  },
};

const PRIORITY_STYLE: Record<DiagnosticAction["priority"], { label: string; chip: string }> = {
  critical: { label: "즉시", chip: "border-rose-400/30 bg-rose-400/10 text-rose-300" },
  recommended: { label: "권장", chip: "border-amber-400/30 bg-amber-400/10 text-amber-300" },
  maintain: { label: "유지", chip: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300" },
};

const IMPACT_LABEL: Record<DiagnosticAction["impactKind"], string> = {
  saving: "월 순이익 개선",
  upside: "월 추가 이익",
  headroom: "확보된 여유",
  neutral: "금액 효과 없음",
};

const IMPACT_COLOR: Record<DiagnosticAction["impactKind"], string> = {
  saving: "text-emerald-300",
  upside: "text-emerald-300",
  headroom: "text-sky-300",
  neutral: "text-slate-500",
};

const STATUS_COLOR: Record<"ok" | "watch" | "over", { bar: string; text: string }> = {
  ok: { bar: "bg-emerald-400/80", text: "text-slate-400" },
  watch: { bar: "bg-amber-400/80", text: "text-amber-300" },
  over: { bar: "bg-rose-400/80", text: "text-rose-300" },
};

/** 반지름 52 기준 원둘레. 점수만큼 호를 그리기 위해 상수로 둔다. */
const RING_CIRCUMFERENCE = 2 * Math.PI * 52;

function ScoreRing({ score, grade }: { score: number; grade: MarginGrade }) {
  const style = GRADE_STYLE[grade];
  const filled = RING_CIRCUMFERENCE * (score / 100);

  return (
    <div
      className="relative h-[108px] w-[108px] shrink-0"
      role="img"
      aria-label={`마진 건강도 ${score}점, ${grade} 등급`}
    >
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
        <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="9" />
        <circle
          cx="60"
          cy="60"
          r="52"
          fill="none"
          stroke={style.stroke}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${RING_CIRCUMFERENCE}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-[27px] font-semibold leading-none tabular-nums ${style.text}`}>
          {score}
        </span>
        <span className="mt-1 text-[10px] font-medium tracking-wide text-slate-500">/ 100</span>
      </div>
    </div>
  );
}

function CostRatioBar({ item }: { item: MarginDiagnosis["costRatios"][number] }) {
  const style = STATUS_COLOR[item.status];
  // 권장 상한의 1.8배를 트랙 끝으로 잡아, 기준선과 현재 값을 같은 축에서 비교한다.
  const trackMax = Math.max(item.benchmark * 1.8, item.ratio * 1.15, 1);
  const width = Math.min((item.ratio / trackMax) * 100, 100);
  const marker = Math.min((item.benchmark / trackMax) * 100, 100);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-slate-400">{item.label}</span>
        <span className={`text-[11px] font-semibold tabular-nums ${style.text}`}>
          {formatPercent(item.ratio, 1)}
        </span>
      </div>
      <div className="relative mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <span className={`absolute inset-y-0 left-0 rounded-full ${style.bar}`} style={{ width: `${width}%` }} />
        <span
          className="absolute inset-y-0 w-px bg-white/40"
          style={{ left: `${marker}%` }}
          aria-hidden
        />
      </div>
      <p className="mt-1 text-[10px] text-slate-500">
        {formatWon(item.amount)} · 권장 {formatPercent(item.benchmark, 1)} 이하
      </p>
    </div>
  );
}

function ActionCard({ action, index }: { action: DiagnosticAction; index: number }) {
  const priority = PRIORITY_STYLE[action.priority];

  return (
    <article className="flex h-full flex-col rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 transition hover:border-white/[0.14]">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-[10px] font-semibold text-slate-400 tabular-nums">
            {String(index + 1).padStart(2, "0")}
          </span>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${priority.chip}`}>
            {priority.label}
          </span>
        </div>
        <span className="shrink-0 text-[11px] font-medium text-slate-500 tabular-nums">
          {action.metric}
        </span>
      </div>

      <h4 className="mt-2.5 text-[13px] font-semibold leading-snug text-white">{action.title}</h4>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-400">{action.detail}</p>

      <div className="mt-auto flex items-baseline justify-between gap-2 border-t border-white/[0.06] pt-2.5">
        <span className="text-[10.5px] text-slate-500">{IMPACT_LABEL[action.impactKind]}</span>
        <span className={`text-[13px] font-semibold tabular-nums ${IMPACT_COLOR[action.impactKind]}`}>
          {action.impactKind === "neutral" ? "—" : formatWon(action.impactMonthly)}
        </span>
      </div>
    </article>
  );
}

/**
 * AI 마진 진단 처방전.
 *
 * 점수·비용 구조·액션 플랜을 한 카드에 묶어, 셀러가 "지금 얼마 남는가"에서 멈추지 않고
 * "그래서 뭘 먼저 해야 하는가"까지 한 화면에서 읽게 한다. 진단은 `diagnoseMargin`의
 * 순수 함수 결과만 사용하므로, 입력이 바뀌면 문장과 금액이 함께 다시 계산된다.
 */
export default function SmartInsightBox({ input, result }: SmartInsightBoxProps) {
  const diagnosis = useMemo(() => diagnoseMargin(input), [input]);
  const style = GRADE_STYLE[diagnosis.grade];

  return (
    <section
      className="card relative overflow-hidden p-5 sm:p-6"
      aria-labelledby="diagnosis-title"
    >
      <div
        className="pointer-events-none absolute -right-24 -top-28 h-64 w-64 rounded-full bg-emerald-500/10 blur-[90px]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -left-20 bottom-0 h-52 w-52 rounded-full bg-indigo-500/10 blur-[90px]"
        aria-hidden
      />

      <div className="relative flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400/80">
            Smart diagnosis
          </p>
          <h2 id="diagnosis-title" className="mt-1 text-lg font-semibold tracking-tight text-white">
            AI 마진 진단 처방전
          </h2>
          <p className="mt-1 max-w-xl text-[12px] leading-relaxed text-slate-500">
            입력한 판매 조건을 네 축(마진율·광고 효율·반품 안정성·고정비 회수)으로 점수화하고,
            지금 바로 실행할 순서를 금액과 함께 제시합니다.
          </p>
        </div>
        <span className="chip">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
          규칙 기반 진단 엔진 · 입력 즉시 재계산
        </span>
      </div>

      <div className="relative mt-5 grid gap-5 lg:grid-cols-[268px_minmax(0,1fr)]">
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
          <div className="flex items-center gap-4">
            <ScoreRing score={diagnosis.score} grade={diagnosis.grade} />
            <div className="min-w-0">
              <span
                className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${style.chip}`}
              >
                마진 건강도 · {diagnosis.grade}
              </span>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{style.suffix}</p>
            </div>
          </div>

          <ul className="mt-4 space-y-2.5 border-t border-white/[0.06] pt-3.5">
            {diagnosis.scoreBreakdown.map((item) => (
              <li key={item.key}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px] font-medium text-slate-300">{item.label}</span>
                  <span className="text-[10.5px] text-slate-500 tabular-nums">
                    {Math.round(item.score)}점 · 가중 {item.weight}%
                  </span>
                </div>
                <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
                  <span
                    className={`block h-full rounded-full ${style.bar}`}
                    style={{ width: `${Math.round(item.score)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="min-w-0">
          <p className="text-[15px] font-semibold leading-snug tracking-tight text-white">
            {diagnosis.headline}
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-slate-400">{diagnosis.summary}</p>

          <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3.5 sm:grid-cols-3">
            {diagnosis.costRatios.map((item) => (
              <CostRatioBar key={item.key} item={item} />
            ))}
          </div>

          <p className="mt-3 text-[10.5px] leading-relaxed text-slate-500">
            막대의 흰 선은 권장 상한입니다. 목표 마진 {TARGET_MARGIN_RATE}% · 광고비 상한{" "}
            {CPS_CEILING_RATE}%는 업종 평균을 기준으로 잡은 참고선이며, 실제 적정선은 카테고리와
            상품 회전율에 따라 달라집니다.
          </p>
        </div>
      </div>

      <div className="relative mt-6 border-t border-white/[0.06] pt-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-white">실전 액션 플랜</h3>
          <p className="text-[11px] text-slate-500">
            위에서부터 순서대로 처리할수록 개선 폭이 큽니다.
          </p>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {diagnosis.actions.map((action, index) => (
            <ActionCard key={action.id} action={action} index={index} />
          ))}
        </div>
        <p className="mt-4 text-[10.5px] leading-relaxed text-slate-500">
          * 처방 금액은 현재 입력한 월 판매량({input.monthlyUnits.toLocaleString("ko-KR")}건)과
          수수료율({formatPercent(input.commissionRate, 2)})을 그대로 반복했을 때의 월 단위
          시뮬레이션입니다. 순이익 계산은 위 마진 계산기와 같은 식을 사용합니다.
          {result.netProfitPerUnit < 0
            ? " 현재는 건당 이익이 0 이하이므로, 판매량을 늘리는 처방은 적용하지 않았습니다."
            : ""}
        </p>
      </div>
    </section>
  );
}
