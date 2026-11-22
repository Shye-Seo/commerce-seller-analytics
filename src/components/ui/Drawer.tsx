"use client";

import { useEffect, type ReactNode } from "react";

/**
 * 오른쪽 사이드 드로어
 *
 * 화면에 늘 떠 있을 필요는 없지만 필요할 때 바로 꺼내야 하는 보조 도구(법인·권한, 감사 기록)를
 * 담는다. 본문 위에 겹쳐 열리므로 문서 흐름의 세로 길이를 늘리지 않는다.
 */
export default function Drawer({
  open,
  title,
  description,
  onClose,
  children,
  testId,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60]" data-testid={testId}>
      <button
        type="button"
        aria-label="패널 닫기"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-ink-950/70 backdrop-blur-[2px]"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="absolute right-0 top-0 flex h-full w-full max-w-[420px] flex-col border-l border-white/[0.08] bg-ink-900 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-white/[0.07] px-4 py-3">
          <div>
            <h2 className="text-[13.5px] font-semibold text-white">{title}</h2>
            {description ? <p className="mt-0.5 text-[11px] text-slate-500">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-white/[0.08] px-2 py-1 text-[11px] text-slate-400 transition hover:border-white/20 hover:text-white"
          >
            닫기
          </button>
        </div>
        <div className="thin-scrollbar flex-1 overflow-y-auto p-3">{children}</div>
      </aside>
    </div>
  );
}
