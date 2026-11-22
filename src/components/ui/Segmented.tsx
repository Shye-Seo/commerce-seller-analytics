"use client";

import { useRef, type KeyboardEvent } from "react";

/**
 * 한 단계 세그먼트 탭
 *
 * 화면을 세로로 쌓지 않고 같은 자리에서 바꿔 보여 주기 위한 공용 탭이다. 메뉴가 아니라
 * "지금 이 페이지 안에서 무엇을 보고 있는가"를 나타내므로, 내비게이션과 달리 링크가 아니라
 * 버튼이고 URL을 바꾸지 않는다. 탭 목록은 항상 한 줄이며 하위 탭을 두지 않는다.
 *
 * 접근성: tablist/tab 역할과 aria-selected를 주고, 좌우 방향키·Home/End로 이동한다.
 */
export interface SegmentedItem<T extends string> {
  id: T;
  label: string;
  /** 탭 아래 한 줄 설명. 좁은 화면에서는 숨긴다. */
  hint?: string;
  /** 오른쪽에 붙는 작은 숫자(건수 등). */
  count?: string;
}

export default function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
  testIdPrefix,
  className = "",
}: {
  items: readonly SegmentedItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** 탭 묶음의 접근성 이름 */
  label: string;
  /** 버튼 data-testid 접두사. `${testIdPrefix}-${id}`로 붙는다. */
  testIdPrefix?: string;
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  const move = (index: number): void => {
    const next = items[index];
    if (!next) return;
    onChange(next.id);
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[index]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      move((index + 1) % items.length);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      move((index - 1 + items.length) % items.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      move(0);
    } else if (event.key === "End") {
      event.preventDefault();
      move(items.length - 1);
    }
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      className={`-mb-px flex items-stretch gap-1 overflow-x-auto border-b border-white/[0.07] thin-scrollbar ${className}`}
    >
      {items.map((item, index) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            data-testid={testIdPrefix ? `${testIdPrefix}-${item.id}` : undefined}
            className={`group relative flex shrink-0 items-baseline gap-1.5 whitespace-nowrap px-3 pb-2 pt-1.5 text-[12.5px] font-medium transition ${
              active ? "text-white" : "text-slate-500 hover:text-slate-200"
            }`}
          >
            <span>{item.label}</span>
            {item.count ? (
              <span className={`text-[10.5px] tabular-nums ${active ? "text-emerald-300" : "text-slate-600"}`}>
                {item.count}
              </span>
            ) : null}
            <span
              aria-hidden
              className={`absolute inset-x-2 -bottom-px h-0.5 rounded-full transition ${
                active ? "bg-emerald-400" : "bg-transparent group-hover:bg-white/10"
              }`}
            />
          </button>
        );
      })}
    </div>
  );
}
