import type { ReactNode } from "react";

type Tone = "emerald" | "sky" | "amber" | "violet";
type BadgeTone = "good" | "warn" | "bad";

export interface MetricCardProps {
  label: string;
  value: string;
  caption: string;
  icon: ReactNode;
  tone?: Tone;
  badge?: { label: string; tone: BadgeTone };
}

const TONE_STYLES: Record<Tone, string> = {
  emerald: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
  sky: "border-sky-400/20 bg-sky-400/10 text-sky-300",
  amber: "border-amber-400/20 bg-amber-400/10 text-amber-300",
  violet: "border-violet-400/20 bg-violet-400/10 text-violet-300",
};

const BADGE_STYLES: Record<BadgeTone, string> = {
  good: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  warn: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  bad: "border-rose-400/25 bg-rose-400/10 text-rose-300",
};

/**
 * 단일 지표 카드.
 *
 * 값은 항상 문자열로 받는다. 포맷(원/%, 만 단위)은 호출부에서 결정하고, 카드는
 * "지표 이름 + 값 + 맥락 한 줄"이라는 동일한 골격만 유지한다. 그래야 지표가 늘어나도
 * 화면 리듬이 무너지지 않는다.
 */
export default function MetricCard({
  label,
  value,
  caption,
  icon,
  tone = "emerald",
  badge,
}: MetricCardProps) {
  return (
    <div className="card group relative overflow-hidden p-5 transition duration-300 hover:border-white/[0.12]">
      <div
        className="pointer-events-none absolute -right-10 -top-12 h-28 w-28 rounded-full bg-white/[0.02] blur-2xl transition group-hover:bg-white/[0.05]"
        aria-hidden
      />
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium tracking-wide text-slate-400">{label}</p>
        <span
          className={`flex h-8 w-8 items-center justify-center rounded-lg border ${TONE_STYLES[tone]}`}
        >
          {icon}
        </span>
      </div>
      <p className="mt-3 text-[26px] font-semibold leading-none tracking-tight text-white tabular-nums">
        {value}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {badge ? (
          <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${BADGE_STYLES[badge.tone]}`}
          >
            {badge.label}
          </span>
        ) : null}
        <p className="text-[11px] leading-relaxed text-slate-500">{caption}</p>
      </div>
    </div>
  );
}
