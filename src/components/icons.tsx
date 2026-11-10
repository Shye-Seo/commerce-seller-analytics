import type { SVGProps } from "react";

/**
 * 인라인 SVG 아이콘 모음.
 *
 * 아이콘 라이브러리를 추가하면 번들에 수백 KB가 붙는다. 이 화면에서 쓰는 아이콘은
 * 10개 남짓이므로, 필요한 패스만 직접 두는 편이 번들·의존성 관리에 유리하다.
 */
type IconProps = SVGProps<SVGSVGElement>;

function base(props: IconProps) {
  return {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...props,
  };
}

export function IconWallet(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h13A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
      <path d="M3 10h12.5a2 2 0 0 1 0 4H3" />
      <circle cx="16.4" cy="12" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconTrend(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 17.5 9.2 11l3.4 2.9L20 6" />
      <path d="M15.4 6H20v4.6" />
    </svg>
  );
}

export function IconPercent(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M19 5 5 19" />
      <circle cx="7.4" cy="7.4" r="2.4" />
      <circle cx="16.6" cy="16.6" r="2.4" />
    </svg>
  );
}

export function IconTarget(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.4" />
      <path d="M12 4V2.5M12 21.5V20M4 12H2.5M21.5 12H20" />
    </svg>
  );
}

export function IconAlert(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 4.2 21 19.5H3z" />
      <path d="M12 9.5v4.2" />
      <circle cx="12" cy="16.6" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m15.6 15.6 4 4" />
    </svg>
  );
}

export function IconGithub(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M12 2.2a9.9 9.9 0 0 0-3.13 19.29c.5.09.68-.21.68-.47v-1.8c-2.75.6-3.33-1.2-3.33-1.2-.45-1.14-1.1-1.45-1.1-1.45-.9-.61.07-.6.07-.6 1 .07 1.52 1.03 1.52 1.03.88 1.5 2.3 1.07 2.86.82.09-.64.35-1.07.63-1.32-2.2-.25-4.5-1.1-4.5-4.89 0-1.08.38-1.96 1-2.65-.1-.25-.44-1.26.1-2.62 0 0 .82-.26 2.7 1.01a9.3 9.3 0 0 1 4.92 0c1.88-1.27 2.7-1 2.7-1 .54 1.36.2 2.37.1 2.62.63.69 1 1.57 1 2.65 0 3.8-2.3 4.64-4.5 4.88.36.32.68.94.68 1.9v2.82c0 .26.18.57.69.47A9.9 9.9 0 0 0 12 2.2" />
    </svg>
  );
}

export function IconArrowUpRight(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M7 17 17 7" />
      <path d="M9 7h8v8" />
    </svg>
  );
}
