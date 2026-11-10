import { MARKET_LIST, MARKET_PRESETS, calculateMargin } from "./calculator";
import type { MarginInput, MarketId } from "./types";

/**
 * 5대 마켓 동시 비교.
 *
 * 비교의 목적은 "같은 상품을 어느 채널에 올릴까"를 한 화면에서 결정하는 것이다.
 * 그래서 **상품 고유 조건은 고정**하고 **플랫폼 고유 조건만 바꾼다.**
 *
 *   고정: 판매가, 원가, 셀러 부담 배송비, 건당 광고비, 반품률, 월 판매량, 월 고정비
 *   변경: 판매 수수료율, 결제(PG) 수수료율, 정산 주기
 *
 * 배송비를 마켓 프리셋의 기본값으로 바꾸지 않은 이유가 중요하다. 프리셋의 배송비는
 * "그 마켓을 선택했을 때 입력창에 채워 주는 출발점"이고, 실제 배송 원가는 같은 상품이면
 * 어느 채널에 올려도 같다(쿠팡도 판매자 부담 배송이 기본인 상품군이 많다). 배송비까지
 * 마켓별로 바꾸면 수수료 차이와 배송비 차이가 섞여 "왜 이 채널이 유리한지"를 읽을 수 없다.
 *
 * 월 판매량도 모든 채널에서 동일하게 둔다. 채널마다 노출 규모가 달라 판매량이 달라지는
 * 것은 사실이지만, 그 변수는 마켓 API·광고 데이터가 있어야 추정할 수 있다. 지금 단계에서는
 * "같은 판매량을 가정했을 때의 단위 경제성"만 비교하고, 그 가정을 화면에 명시한다.
 */

export interface MarketComparisonRow {
  id: MarketId;
  label: string;
  shortLabel: string;
  color: string;
  note: string;
  /** 판매 수수료율(%) */
  commissionRate: number;
  /** 결제·PG 수수료율(%) */
  paymentRate: number;
  /** 두 수수료율의 합(%) */
  totalFeeRate: number;
  /** 건당 수수료 부담액(원) */
  feePerUnit: number;
  /** 건당 순이익(원) */
  netProfitPerUnit: number;
  /** 순마진율(%) */
  marginRate: number;
  /** 월 예상 매출(원) */
  monthlyRevenue: number;
  /** 월 예상 순이익(고정비 차감 후, 원) */
  monthlyNetProfit: number;
  /** 정산 주기(영업일) */
  settlementDays: number;
  /** 순마진 1위 여부 */
  isBestMargin: boolean;
  /** 정산이 가장 빠른 채널 여부 */
  isFastestSettlement: boolean;
  /** 현재 시뮬레이터에서 선택된 마켓인지 */
  isSelected: boolean;
  /** 순마진 순위(1부터) */
  rank: number;
  /** 1위 대비 건당 순이익 차이(원, 1위는 0) */
  gapFromBest: number;
}

export interface MarketComparisonResult {
  rows: MarketComparisonRow[];
  bestMargin: MarketComparisonRow;
  worstMargin: MarketComparisonRow;
  fastestSettlement: MarketComparisonRow;
  /** 1위와 최하위의 건당 순이익 차이(원) */
  perUnitSpread: number;
  /** 1위와 최하위의 월 순이익 차이(원) */
  monthlySpread: number;
  /** 현재 선택된 마켓의 비교 행 */
  selected: MarketComparisonRow;
}

/** 비교 계산에 쓰는 마켓 프리셋 순서(화면 노출 순서와 동일) */
export const COMPARISON_MARKETS = MARKET_LIST;

/**
 * 특정 마켓 기준으로 입력값을 변환한다.
 * 수수료율·결제 수수료만 바꾸고, 상품 고유 비용(원가·배송비·광고비·반품률)은 유지한다.
 */
export function toMarketInput(input: MarginInput, marketId: MarketId): MarginInput {
  const preset = MARKET_PRESETS[marketId];

  return {
    ...input,
    marketId,
    commissionRate: preset.commissionRate,
    paymentRate: preset.paymentRate,
  };
}

export function compareMarkets(input: MarginInput): MarketComparisonResult {
  const computed = COMPARISON_MARKETS.map((preset) => {
    const presetInput = toMarketInput(input, preset.id);
    const result = calculateMargin(presetInput);

    return { preset, result };
  });

  const bestMarginProfit = Math.max(...computed.map(({ result }) => result.netProfitPerUnit));
  const worstMarginProfit = Math.min(...computed.map(({ result }) => result.netProfitPerUnit));
  const fastestSettlementDays = Math.min(
    ...computed.map(({ preset }) => preset.settlementDays),
  );

  // 순마진 내림차순 순위. 동률이면 MARKET_LIST 순서를 유지한다(정렬이 안정적).
  const ranked = [...computed].sort(
    (a, b) => b.result.netProfitPerUnit - a.result.netProfitPerUnit,
  );
  const rankById = new Map<MarketId, number>(
    ranked.map(({ preset }, index) => [preset.id, index + 1]),
  );

  const rows: MarketComparisonRow[] = computed.map(({ preset, result }) => ({
    id: preset.id,
    label: preset.label,
    shortLabel: preset.shortLabel,
    color: preset.color,
    note: preset.note,
    commissionRate: preset.commissionRate,
    paymentRate: preset.paymentRate,
    totalFeeRate: preset.commissionRate + preset.paymentRate,
    feePerUnit: result.commission + result.paymentFee,
    netProfitPerUnit: result.netProfitPerUnit,
    marginRate: result.marginRate,
    monthlyRevenue: result.monthlyRevenue,
    monthlyNetProfit: result.monthlyNetProfit,
    settlementDays: preset.settlementDays,
    // 동률이면 공동 1위로 보고 모두 배지를 받는다(반올림 오차로 한쪽만 강조되는 일 방지).
    isBestMargin: result.netProfitPerUnit === bestMarginProfit,
    isFastestSettlement: preset.settlementDays === fastestSettlementDays,
    isSelected: preset.id === input.marketId,
    rank: rankById.get(preset.id) ?? computed.length,
    gapFromBest: bestMarginProfit - result.netProfitPerUnit,
  }));

  const bestRow = rows.reduce((best, row) =>
    row.netProfitPerUnit > best.netProfitPerUnit ? row : best,
  );
  const worstRow = rows.reduce((worst, row) =>
    row.netProfitPerUnit < worst.netProfitPerUnit ? row : worst,
  );
  const fastestRow = rows.reduce((fastest, row) =>
    row.settlementDays < fastest.settlementDays ? row : fastest,
  );
  const selectedRow = rows.find((row) => row.isSelected) ?? bestRow;

  return {
    rows,
    bestMargin: bestRow,
    worstMargin: worstRow,
    fastestSettlement: fastestRow,
    perUnitSpread: bestRow.netProfitPerUnit - worstRow.netProfitPerUnit,
    monthlySpread: bestRow.monthlyNetProfit - worstRow.monthlyNetProfit,
    selected: selectedRow,
  };
}
