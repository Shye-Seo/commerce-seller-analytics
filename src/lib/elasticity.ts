import { MARKET_LIST, RETURN_HANDLING_RATE } from "./calculator";
import type { MarginInput, MarketId, MarketPreset } from "./types";

/**
 * 가격·마진 탄력성 시뮬레이터 (엔진)
 *
 * 셀러가 실제로 던지는 질문은 "지금 이 가격이 남는가" 하나가 아니다. 할인율을 5%p 더 주면
 * 마진이 어떻게 깎이는지, 광고 ROAS를 4에서 3으로 낮추면 어느 마켓에서 적자로 넘어가는지가
 * 같이 궁금하다. 이 모듈은 그 세 축(정가·할인율·ROAS)을 5개 마켓의 **같은 비용 구조**에
 * 적용해 마진 곡선과 손익분기 판매가를 한 번에 계산한다.
 *
 * 모델의 가정 (화면에도 같은 문구를 적는다)
 * -----------------------------------------
 * - 판매 수수료·결제 수수료·광고비는 판매가에 **비례**한다. 광고비는 ROAS를 유지한다고 보고
 *   `판매가 ÷ ROAS`로 둔다. 즉 광고를 켜 둔 채 가격을 올리면 광고비도 같이 오른다.
 * - 상품 원가·셀러 부담 배송비·기대 반품 손실은 판매가와 무관한 **고정비성 원가**다.
 * - 반품 손실은 기존 마진 계산기와 같은 식(`반품률 × (왕복 배송비 + 원가의 10%)`)을 쓴다.
 *
 * 이 가정 때문에 건당 순이익은 판매가에 대해 1차식이고, 마진율(%)은 원점을 지나는
 * 쌍곡선 모양이 된다. 곡선이 휘는 이유가 계산 오차가 아니라 분모(판매가)가 커지기 때문이라는
 * 점을 숨기지 않으려고 마진율을 세로축으로 쓴다.
 */

/** 시뮬레이터 입력: 정가·할인율·목표 ROAS */
export interface ElasticityConfig {
  /** 할인 전 정가(원) */
  listPrice: number;
  /** 정가에서 차감하는 할인율(%) */
  discountRate: number;
  /** 목표 ROAS(매출 ÷ 광고비). 0 이하면 광고비를 반영하지 않는다 */
  roas: number;
}

/** 곡선 위 한 점 */
export interface ElasticityPoint {
  /** 실제 판매가(원, 10원 단위 반올림) */
  price: number;
  /** 건당 순이익(원) */
  netPerUnit: number;
  /** 판매가 대비 순이익률(%) */
  marginRate: number;
}

/** 마켓 한 곳의 곡선과 손익분기점 */
export interface MarketCurve {
  marketId: MarketId;
  label: string;
  shortLabel: string;
  color: string;
  /** 판매 수수료율(%) */
  commissionRate: number;
  /** 결제·PG 수수료율(%) */
  paymentRate: number;
  /** 판매가 - 수수료 - 고정비성 원가 - 광고비 */
  netPerUnit: number;
  marginRate: number;
  /** 이 마켓에서 적자로 넘어가는 판매가(원). 수수료+광고비율이 100% 이상이면 Infinity */
  breakEvenPrice: number;
  /** 현재 조건의 월 예상 순이익(원) */
  monthlyNetProfit: number;
  series: ElasticityPoint[];
}

/** 시뮬레이터 결과 */
export interface ElasticityResult {
  config: {
    listPrice: number;
    discountRate: number;
    paidPrice: number;
    roas: number;
    /** 건당 광고비(원). ROAS가 0 이하이면 0 */
    adCostPerUnit: number;
    /** 건당 기대 반품 손실(원) */
    returnLossPerUnit: number;
    /** 판매가와 무관한 고정비성 원가 합(원) */
    fixedCostPerUnit: number;
  };
  axis: { min: number; max: number; steps: number };
  curves: MarketCurve[];
  /** 현재 판매가에서 건당 순이익이 가장 큰 마켓 */
  best: MarketCurve | null;
  /** 5개 마켓 중 손익분기 판매가가 가장 낮은 마켓 */
  lowestBreakEven: MarketCurve | null;
  /** 차트 y축 범위(%) — 곡선이 전부 들어오도록 계산한다 */
  chart: { minMarginRate: number; maxMarginRate: number };
  assumptions: string[];
}

const MIN_PRICE = 100;
const MAX_PRICE = 5_000_000;
const DEFAULT_RANGE_PCT = 30;
const DEFAULT_STEPS = 24;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function safeAmount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(value, 0);
}

function roundToTen(value: number): number {
  return Math.round(value / 10) * 10;
}

function feeRateOf(market: MarketPreset): number {
  return (clamp(market.commissionRate, 0, 100) + clamp(market.paymentRate, 0, 100)) / 100;
}

/**
 * 특정 판매가에서의 건당 순이익.
 *
 * 순이익 = P(1 - 수수료율 - 1/ROAS) - 고정비성 원가
 * ROAS가 0 이하이면 광고비 항(1/ROAS)을 0으로 둔다(광고 미집행).
 */
export function netProfitAtPrice(
  price: number,
  feeRate: number,
  fixedCost: number,
  roas: number,
): number {
  const adRate = roas > 0 ? 1 / roas : 0;
  const contribution = 1 - clamp(feeRate, 0, 1) - adRate;
  return safeAmount(price) * contribution - safeAmount(fixedCost);
}

/**
 * 손익분기 판매가.
 *
 * `P(1 - 수수료율 - 1/ROAS) = 고정비성 원가` 를 P에 대해 푼 값이다.
 * 계수 합이 0 이하이면 어떤 가격으로도 이익이 날 수 없으므로 Infinity를 반환한다
 * (화면은 이 값을 "도달 불가"로 표시한다).
 */
export function breakEvenPrice(
  feeRate: number,
  fixedCost: number,
  roas: number,
): number {
  const adRate = roas > 0 ? 1 / roas : 0;
  const denominator = 1 - clamp(feeRate, 0, 1) - adRate;
  if (denominator <= 0.0001) return Number.POSITIVE_INFINITY;
  // 100원 단위로 올림 — 실제 판매가로 바로 쓸 수 있는 숫자로 만든다(기존 계산기와 같은 규칙).
  return Math.ceil(safeAmount(fixedCost) / denominator / 100) * 100;
}

/** 마켓 하나의 곡선을 만든다. 축은 정가 기준 ±rangePct%를 steps 등분한다. */
export function computeMarketCurve(
  input: MarginInput,
  market: MarketPreset,
  config: ElasticityConfig,
  options: { rangePct?: number; steps?: number } = {},
): MarketCurve {
  const listPrice = clamp(config.listPrice, MIN_PRICE, MAX_PRICE);
  const discountRate = clamp(config.discountRate, 0, 90);
  const roas = clamp(config.roas, 0, 30);
  const rangePct = clamp(options.rangePct ?? DEFAULT_RANGE_PCT, 5, 80);
  const steps = Math.round(clamp(options.steps ?? DEFAULT_STEPS, 4, 80));

  const productCost = safeAmount(input.costPrice);
  const shippingCost = safeAmount(input.shippingCost);
  const returnRate = clamp(input.returnRate, 0, 100) / 100;
  const returnLoss = returnRate * (shippingCost * 2 + productCost * RETURN_HANDLING_RATE);
  const fixedCost = productCost + shippingCost + returnLoss;
  const feeRate = feeRateOf(market);

  const paidPrice = roundToTen(listPrice * (1 - discountRate / 100));
  const series: ElasticityPoint[] = [];
  const low = listPrice * (1 - rangePct / 100);
  const high = listPrice * (1 + rangePct / 100);

  for (let index = 0; index <= steps; index += 1) {
    const price = roundToTen(low + ((high - low) * index) / steps);
    const netPerUnit = netProfitAtPrice(price, feeRate, fixedCost, roas);
    series.push({
      price,
      netPerUnit,
      marginRate: price > 0 ? (netPerUnit / price) * 100 : 0,
    });
  }

  const netPerUnit = netProfitAtPrice(paidPrice, feeRate, fixedCost, roas);
  const monthlyUnits = safeAmount(input.monthlyUnits);
  const monthlyFixedCost = safeAmount(input.monthlyFixedCost);

  return {
    marketId: market.id,
    label: market.label,
    shortLabel: market.shortLabel,
    color: market.color,
    commissionRate: market.commissionRate,
    paymentRate: market.paymentRate,
    netPerUnit,
    marginRate: paidPrice > 0 ? (netPerUnit / paidPrice) * 100 : 0,
    breakEvenPrice: breakEvenPrice(feeRate, fixedCost, roas),
    monthlyNetProfit: netPerUnit * monthlyUnits - monthlyFixedCost,
    series,
  };
}

/**
 * 5개 마켓 곡선을 한 번에 계산한다. 화면은 이 결과만 그린다.
 */
export function computeElasticity(
  input: MarginInput,
  config: ElasticityConfig,
  options: { rangePct?: number; steps?: number } = {},
): ElasticityResult {
  const listPrice = clamp(config.listPrice || input.sellingPrice, MIN_PRICE, MAX_PRICE);
  const discountRate = clamp(config.discountRate, 0, 90);
  const roas = clamp(config.roas, 0, 30);
  const normalized: ElasticityConfig = { listPrice, discountRate, roas };

  const curves = MARKET_LIST.map((market) => computeMarketCurve(input, market, normalized, options));

  const paidPrice = roundToTen(listPrice * (1 - discountRate / 100));
  const productCost = safeAmount(input.costPrice);
  const shippingCost = safeAmount(input.shippingCost);
  const returnRate = clamp(input.returnRate, 0, 100) / 100;
  const returnLoss = returnRate * (shippingCost * 2 + productCost * RETURN_HANDLING_RATE);

  const best = curves.reduce<MarketCurve | null>(
    (current, curve) => (current === null || curve.netPerUnit > current.netPerUnit ? curve : current),
    null,
  );
  const lowestBreakEven = curves.reduce<MarketCurve | null>((current, curve) => {
    if (current === null) return Number.isFinite(curve.breakEvenPrice) ? curve : null;
    if (!Number.isFinite(curve.breakEvenPrice)) return current;
    return curve.breakEvenPrice < current.breakEvenPrice ? curve : current;
  }, null);

  const finiteRates = curves
    .flatMap((curve) => curve.series.map((point) => point.marginRate))
    .filter((rate) => Number.isFinite(rate));
  const minRate = finiteRates.length > 0 ? Math.min(...finiteRates) : -50;
  const maxRate = finiteRates.length > 0 ? Math.max(...finiteRates) : 50;

  return {
    config: {
      listPrice,
      discountRate,
      paidPrice,
      roas,
      adCostPerUnit: roas > 0 ? Math.round(paidPrice / roas) : 0,
      returnLossPerUnit: Math.round(returnLoss),
      fixedCostPerUnit: productCost + shippingCost + returnLoss,
    },
    axis: {
      min: roundToTen(listPrice * (1 - clamp(options.rangePct ?? DEFAULT_RANGE_PCT, 5, 80) / 100)),
      max: roundToTen(listPrice * (1 + clamp(options.rangePct ?? DEFAULT_RANGE_PCT, 5, 80) / 100)),
      steps: Math.round(clamp(options.steps ?? DEFAULT_STEPS, 4, 80)),
    },
    curves,
    best,
    lowestBreakEven,
    chart: {
      // 0선이 항상 보이도록 y축을 0 포함 구간으로 넓힌다.
      minMarginRate: Math.min(0, Math.floor(minRate / 10) * 10),
      maxMarginRate: Math.max(0, Math.ceil(maxRate / 10) * 10),
    },
    assumptions: [
      "판매·결제 수수료와 광고비는 판매가에 비례한다고 가정합니다(광고비 = 판매가 ÷ ROAS).",
      "상품 원가·셀러 부담 배송비·기대 반품 손실은 판매가와 무관한 고정비성 원가입니다.",
      "마켓 수수료율은 공개 정책을 참고한 프리셋이며, 실제 계약서 값과 다를 수 있습니다.",
    ],
  };
}
