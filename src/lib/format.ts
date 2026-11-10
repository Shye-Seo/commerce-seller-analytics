/**
 * 화면 표시용 포맷 유틸.
 *
 * 한국어 금액 표기는 "만/억" 단위가 자연스럽지만, 정확한 금액이 필요한 곳(순이익, 손익분기 판매가)은
 * 원 단위 전체 자릿수를 그대로 보여 준다. 두 표기를 섞어 쓰지 않도록 함수를 용도별로 나눴다.
 */

const numberFormatter = new Intl.NumberFormat("ko-KR");

/** 정확한 원 단위 표기: 24,900원 */
export function formatWon(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value);
  const sign = rounded < 0 ? "-" : "";
  return `${sign}${numberFormatter.format(Math.abs(rounded))}원`;
}

/** 증감 표기: +1,200원 / -300원 */
export function formatSignedWon(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatWon(value)}`;
}

/** 축약 숫자: 4.8만, 1.2억, 950 */
export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);

  if (abs >= 100_000_000) return `${sign}${trimTrailingZero(abs / 100_000_000)}억`;
  if (abs >= 10_000) return `${sign}${trimTrailingZero(abs / 10_000)}만`;
  return `${sign}${numberFormatter.format(Math.round(abs))}`;
}

/** 율 표기: 28.8% */
export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

/** 건수 표기: 382건 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${numberFormatter.format(Math.round(value))}건`;
}

function trimTrailingZero(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}
