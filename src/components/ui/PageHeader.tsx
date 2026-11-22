import type { ReactNode } from "react";

/**
 * 페이지 머리말
 *
 * 큰 히어로 대신 한 줄 제목 + 한 줄 설명 + 오른쪽 액션으로 끝낸다. 첫 화면에서 지표가 바로
 * 보이도록 머리말 높이를 고정(제목 20px, 설명 12.5px 두 줄 이내)하는 것이 이 컴포넌트의 역할이다.
 */
export default function PageHeader({
  title,
  description,
  meta,
  actions,
}: {
  title: string;
  description?: string;
  /** 제목 위에 붙는 아주 작은 맥락(섹션 이름) */
  meta?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-white/[0.06] pb-4">
      <div className="min-w-0">
        {meta ? (
          <p className="text-[10.5px] font-medium uppercase tracking-[0.14em] text-slate-500">{meta}</p>
        ) : null}
        <h1 className="mt-0.5 text-[19px] font-semibold tracking-tight text-white">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-slate-500">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
