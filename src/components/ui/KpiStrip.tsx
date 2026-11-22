import Link from "next/link";
import type { ReactNode } from "react";

/**
 * 핵심 지표 스트립
 *
 * 카드 네 장을 띄우지 않고 헤어라인으로 나눈 한 줄로 묶는다. 지표는 "이름 / 값 / 한 줄 맥락"
 * 세 층만 갖고, 값은 항상 tabular-nums로 고정폭이라 숫자가 바뀌어도 폭이 흔들리지 않는다.
 * 색은 보조 수단일 뿐이므로 상태는 `status`의 글자 라벨로도 함께 전달한다.
 */
export type KpiTone = "default" | "good" | "warn" | "bad";

const VALUE_TONE: Record<KpiTone, string> = {
  default: "text-white",
  good: "text-emerald-300",
  warn: "text-amber-200",
  bad: "text-rose-300",
};

const STATUS_STYLE: Record<KpiTone, string> = {
  default: "border-white/[0.12] text-slate-400",
  good: "border-emerald-400/25 text-emerald-300",
  warn: "border-amber-400/25 text-amber-200",
  bad: "border-rose-400/25 text-rose-300",
};

export interface KpiItem {
  label: string;
  value: string;
  hint?: string;
  tone?: KpiTone;
  /** 글자로도 상태를 남기는 라벨(색만으로 구분하지 않는다) */
  status?: string;
  href?: string;
  testId?: string;
}

function Cell({ item }: { item: KpiItem }) {
  const tone = item.tone ?? "default";
  return (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate text-[13px] font-medium text-slate-300">{item.label}</p>
        {item.status ? (
          <span
            className={`shrink-0 rounded border px-1 py-px text-[12px] font-medium leading-4 ${STATUS_STYLE[tone]}`}
          >
            {item.status}
          </span>
        ) : null}
      </div>
      <p className={`mt-1 text-[22px] font-bold leading-tight tracking-tight tabular-nums ${VALUE_TONE[tone]}`} data-testid={item.testId}>
        {item.value}
      </p>
      {item.hint ? <p className="mt-0.5 truncate text-[13px] text-slate-400">{item.hint}</p> : null}
    </>
  );
}

export default function KpiStrip({
  items,
  className = "",
}: {
  items: readonly KpiItem[];
  className?: string;
}) {
  return (
    <div
      className={`grid grid-cols-2 divide-white/[0.06] overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.015] sm:divide-x xl:grid-cols-4 ${className}`}
    >
      {items.map((item, index) => {
        const body = (
          <div
            className={`h-full px-4 py-3 ${
              index >= 2 ? "border-t border-white/[0.06] xl:border-t-0" : ""
            } ${index === 1 ? "border-l border-white/[0.06] sm:border-l-0" : ""} ${
              index === 3 ? "border-l border-white/[0.06]" : ""
            }`}
          >
            <Cell item={item} />
          </div>
        );
        if (!item.href) return <div key={item.label}>{body}</div>;
        return (
          <Link
            key={item.label}
            href={item.href}
            className="group block transition hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-400/40"
          >
            {body}
          </Link>
        );
      })}
    </div>
  );
}

/** 패널 한 장: 제목 줄은 선택, 본문은 그대로. 카드 그림자 없이 헤어라인만 쓴다. */
export function Panel({
  title,
  hint,
  actions,
  children,
  className = "",
  bodyClassName = "p-4",
  id,
}: {
  title?: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`rounded-xl border border-white/[0.07] bg-white/[0.015] ${className}`}>
      {title ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-2">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[16px] font-semibold text-slate-100">{title}</h2>
            {hint ? <span className="text-[13px] text-slate-400">{hint}</span> : null}
          </div>
          {actions}
        </div>
      ) : null}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
