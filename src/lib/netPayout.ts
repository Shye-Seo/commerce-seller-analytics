import { MARKET_LIST, MARKET_PRESETS } from "./calculator";
import type { MarketId } from "./types";

/**
 * 실수령 순수익 계산기 (엔진)
 *
 * 셀러가 보는 "매출"과 통장에 찍히는 "정산금", 그리고 실제로 남는 돈은 셋 다 다르다.
 * 매출에서 판매 수수료와 결제 수수료가 빠진 것이 정산금이고, 정산금에서 다시 광고비·반품
 * 회수 배송비·교환 재발송비·상품 원가·고정비가 빠져야 통장에 남는 돈이 된다.
 *
 * 이 모듈은 그 세 단계를 분리해서 계산한다.
 *
 *   1. 카테고리 수수료: 같은 마켓이라도 카테고리에 따라 수수료율이 다르다.
 *      마켓·카테고리 조합에서 실제 적용되는 요율을 찾아 매출(반품 제외)에 곱한다.
 *   2. 정산금: 매출 - 판매 수수료 - 결제 수수료 - 반품 회수 배송비.
 *      셀러가 정산서에서 확인한 금액을 넣으면 그 값과 예상 정산금의 차이를 같이 보여 준다.
 *   3. 통장 순수익: 정산금 - 광고비 - 교환 재발송비 - 상품 원가 - 고정비.
 *
 * 손익분기 ROAS
 * -------------
 * 광고비만 매출/ROAS 로 두고 나머지를 고정하면, 순수익 ≥ 0 조건은
 *
 *     매출 / ROAS ≤ 광고 전 공헌이익
 *     ⇔ ROAS ≥ 매출 ÷ 광고 전 공헌이익
 *
 * 이다. 즉 광고 전 공헌이익이 0 이하면 어떤 ROAS로도 흑자가 될 수 없고, 그때는
 * "도달 불가"로 표시한다(Infinity). 숫자를 0으로 눕혀 놓으면 "광고를 아주 잘하면 된다"로
 * 오해되기 때문에, 계산이 불가능한 경우를 명시적으로 구분한다.
 *
 * 가정 (화면에도 같은 문구를 적는다)
 * ---------------------------------
 * - 매출·원가는 부가세 제외 금액이다. 부가세는 셀러가 보관했다가 납부하는 돈이라 순수익에 넣지 않는다.
 * - 광고비는 반품 전 결제 매출 기준으로 발생한다(노출·클릭은 반품과 무관하다).
 * - 결제·PG 수수료는 결제 취소 이후에도 환급되지 않는 경우가 많아 결제 매출 전체에 부과한다.
 * - 반품은 판매 수수료와 상품 원가가 회수된다고 보고, 회수 배송비는 셀러가 부담한다.
 * - 교환은 매출이 유지되고 재발송 배송비만 추가로 발생한다.
 */

/** 수수료 카테고리 식별자 */
export type FeeCategoryId =
  | "fashion"
  | "beauty"
  | "food"
  | "digital"
  | "living"
  | "baby"
  | "sports"
  | "pet";

export interface FeeCategory {
  id: FeeCategoryId;
  label: string;
  /** 마켓별 판매 수수료율(%). 자사몰은 중개 수수료가 없어 0이다 */
  rates: Record<MarketId, number>;
  /** 카테고리 특성 한 줄 */
  note: string;
}

/**
 * 마켓·카테고리 수수료표.
 *
 * 각 마켓이 공개한 카테고리 요율 구간을 기준으로 잡은 값이다. 실제 계약은 입점 등급·프로모션·
 * 계약 개정에 따라 달라지므로, 화면에서 요율을 직접 고칠 수 있게 두고 계산은 주입된 값을 쓴다.
 */
export const FEE_CATEGORIES: FeeCategory[] = [
  {
    id: "fashion",
    label: "패션의류·잡화",
    rates: { smartstore: 6.0, coupang: 10.8, elevenst: 12.0, gmarket: 12.0, own: 0 },
    note: "반품률이 가장 높은 카테고리입니다. 회수 배송비를 매출에 미리 반영해야 합니다.",
  },
  {
    id: "beauty",
    label: "뷰티·화장품",
    rates: { smartstore: 5.0, coupang: 10.8, elevenst: 11.0, gmarket: 11.0, own: 0 },
    note: "개봉 후 반품이 제한되어 회수율이 높지만, 교환 요청은 잦습니다.",
  },
  {
    id: "food",
    label: "식품·건강식품",
    rates: { smartstore: 4.0, coupang: 10.0, elevenst: 9.0, gmarket: 10.0, own: 0 },
    note: "유통기한·파손 이슈로 반품 시 재판매가 어렵습니다.",
  },
  {
    id: "digital",
    label: "디지털·가전",
    rates: { smartstore: 3.63, coupang: 8.0, elevenst: 8.0, gmarket: 8.0, own: 0 },
    note: "객단가가 높아 수수료율 차이가 금액으로 크게 벌어집니다.",
  },
  {
    id: "living",
    label: "생활·주방",
    rates: { smartstore: 4.5, coupang: 10.8, elevenst: 9.0, gmarket: 10.0, own: 0 },
    note: "부피가 커 배송비 비중이 높은 품목이 섞여 있습니다.",
  },
  {
    id: "baby",
    label: "출산·유아동",
    rates: { smartstore: 4.0, coupang: 10.0, elevenst: 9.0, gmarket: 10.0, own: 0 },
    note: "안전 인증·교환 조건이 까다로워 교환률이 평균보다 높습니다.",
  },
  {
    id: "sports",
    label: "스포츠·레저",
    rates: { smartstore: 6.0, coupang: 10.8, elevenst: 12.0, gmarket: 12.0, own: 0 },
    note: "사이즈 교환이 많아 재발송 배송비가 순수익을 크게 깎습니다.",
  },
  {
    id: "pet",
    label: "반려동물용품",
    rates: { smartstore: 5.0, coupang: 10.8, elevenst: 10.0, gmarket: 10.0, own: 0 },
    note: "소모품 재구매가 많아 광고 효율(ROAS)이 상대적으로 안정적입니다.",
  },
];

export const FEE_CATEGORY_BY_ID: Record<FeeCategoryId, FeeCategory> = FEE_CATEGORIES.reduce(
  (map, category) => ({ ...map, [category.id]: category }),
  {} as Record<FeeCategoryId, FeeCategory>,
);

/** 마켓·카테고리 조합의 판매 수수료율(%). 알 수 없는 조합이면 마켓 기본 요율. */
export function resolveCategoryFee(marketId: MarketId, categoryId: FeeCategoryId): number {
  const category = FEE_CATEGORY_BY_ID[categoryId];
  const preset = MARKET_PRESETS[marketId];
  if (!category || !preset) return 0;
  const rate = category.rates[marketId];
  return Number.isFinite(rate) ? rate : preset.commissionRate;
}

/** 계산기 입력값 */
export interface NetPayoutInput {
  marketId: MarketId;
  categoryId: FeeCategoryId;
  /** 월 결제 매출(원, 부가세 제외). 반품 전 금액 */
  monthlyRevenue: number;
  /** 정산서에서 확인한 정산금(원). 0이면 예상 정산금을 그대로 쓴다 */
  settlementAmount: number;
  /** 카테고리 수수료율(%). 표의 값을 기본으로 쓰고 직접 수정할 수 있다 */
  commissionRate: number;
  /** 결제·PG 수수료율(%) */
  paymentRate: number;
  /** 상품 원가율(%) — 매출 대비 매입 원가 */
  cogsRate: number;
  /** 광고 ROAS(매출 ÷ 광고비). 0 이하면 광고 미집행 */
  roas: number;
  /** 반품률(%) */
  returnRate: number;
  /** 교환률(%) */
  exchangeRate: number;
  /** 반품 회수 배송비(편도, 원). 왕복으로 계산한다 */
  returnShippingFee: number;
  /** 교환 재발송 배송비(원) */
  exchangeShippingFee: number;
  /** 평균 객단가(원) — 주문 수를 역산한다 */
  averageOrderValue: number;
  /** 월 고정비(원) */
  monthlyFixedCost: number;
}

export interface NetPayoutResult {
  /** 반품 전 결제 매출 */
  revenue: number;
  /** 반품 차감 후 매출(수수료·원가의 기준) */
  keptRevenue: number;
  orders: number;
  returns: number;
  exchanges: number;
  /** 적용된 카테고리 수수료율(%) */
  commissionRate: number;
  commission: number;
  paymentFee: number;
  cogs: number;
  adSpend: number;
  returnShippingLoss: number;
  exchangeShippingLoss: number;
  fixedCost: number;
  /** 예상 정산금 = 반품 후 매출 - 판매 수수료 - 결제 수수료 - 반품 회수 배송비 */
  expectedSettlement: number;
  /** 실제로 넣은 정산금(정산서 값). 입력하지 않으면 null */
  confirmedSettlement: number | null;
  /** 정산서 값 - 예상 정산금. 양수면 예상보다 많이 들어왔다 */
  settlementGap: number | null;
  /** 순수익 계산의 시작점(정산서 값이 있으면 그 값) */
  settlementBase: number;
  /** 광고 전 공헌이익 = 정산금 - 교환 배송비 - 원가 - 고정비 */
  contributionBeforeAd: number;
  /** 통장에 남는 순수익 */
  netCash: number;
  /** 매출 대비 순수익률(%) */
  netMarginRate: number;
  /** 건당 순수익(원) */
  netPerOrder: number;
  /** 손익분기 ROAS. 공헌이익이 0 이하면 Infinity */
  breakEvenRoas: number;
  /** 넣은 ROAS. 광고 미집행이면 0 */
  currentRoas: number;
  /** 지금 ROAS에서 손익분기까지 남은 여유(%p). 광고 미집행이면 null */
  roasHeadroom: number | null;
  /** 손익분기까지 쓸 수 있는 최대 광고비(원) */
  maxAdSpend: number;
  /** 카테고리별 같은 매출 시나리오 */
  categoryScenarios: {
    categoryId: FeeCategoryId;
    label: string;
    commissionRate: number;
    commission: number;
    netCash: number;
    delta: number;
  }[];
  /** 마켓별 같은 조건 시나리오 */
  marketScenarios: {
    marketId: MarketId;
    label: string;
    shortLabel: string;
    color: string;
    commissionRate: number;
    netCash: number;
    delta: number;
  }[];
  assumptions: string[];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function safeAmount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function won(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value);
}

/** 기본 입력값 — 화면 초기 상태로 쓴다. */
export const DEFAULT_NET_PAYOUT_INPUT: NetPayoutInput = {
  marketId: "smartstore",
  categoryId: "living",
  monthlyRevenue: 42_600_000,
  settlementAmount: 0,
  commissionRate: resolveCategoryFee("smartstore", "living"),
  paymentRate: MARKET_PRESETS.smartstore.paymentRate,
  cogsRate: 38,
  roas: 4.2,
  returnRate: 7.5,
  exchangeRate: 3.5,
  returnShippingFee: 3_000,
  exchangeShippingFee: 2_800,
  averageOrderValue: 32_000,
  monthlyFixedCost: 1_850_000,
};

/**
 * 통장 순수익을 계산한다.
 *
 * 금액 단위는 모두 원이고 율은 퍼센트 숫자다. UI 입력에서 빈 값·음수·NaN이 흘러들어와도
 * 계산이 깨지지 않도록 모든 율과 금액을 마지막에 보정한다.
 */
export function calculateNetPayout(input: NetPayoutInput): NetPayoutResult {
  const revenue = safeAmount(input.monthlyRevenue);
  const averageOrderValue = Math.max(1_000, safeAmount(input.averageOrderValue));
  const roas = clamp(input.roas, 0, 50);
  const returnRate = clamp(input.returnRate, 0, 100);
  const exchangeRate = clamp(input.exchangeRate, 0, 100);
  const cogsRate = clamp(input.cogsRate, 0, 100);
  const paymentRate = clamp(input.paymentRate, 0, 100);
  const commissionRate = clamp(
    Number.isFinite(input.commissionRate)
      ? input.commissionRate
      : resolveCategoryFee(input.marketId, input.categoryId),
    0,
    100,
  );

  const orders = revenue / averageOrderValue;
  const returns = (orders * returnRate) / 100;
  const exchanges = (orders * exchangeRate) / 100;

  const keptRevenue = revenue * (1 - returnRate / 100);
  const commission = won(keptRevenue * (commissionRate / 100));
  const paymentFee = won(revenue * (paymentRate / 100));
  const cogs = won(keptRevenue * (cogsRate / 100));
  const adSpend = roas > 0 ? won(revenue / roas) : 0;
  const returnShippingLoss = won(returns * safeAmount(input.returnShippingFee) * 2);
  const exchangeShippingLoss = won(exchanges * safeAmount(input.exchangeShippingFee));
  const fixedCost = won(safeAmount(input.monthlyFixedCost));

  const expectedSettlement = won(
    keptRevenue - commission - paymentFee - returnShippingLoss,
  );
  const confirmedSettlement =
    Number.isFinite(input.settlementAmount) && input.settlementAmount > 0
      ? won(input.settlementAmount)
      : null;
  const settlementBase = confirmedSettlement ?? expectedSettlement;
  const settlementGap = confirmedSettlement === null ? null : confirmedSettlement - expectedSettlement;

  const contributionBeforeAd = won(
    settlementBase - exchangeShippingLoss - cogs - fixedCost,
  );
  const netCash = won(contributionBeforeAd - adSpend);

  const netMarginRate = revenue > 0 ? (netCash / revenue) * 100 : 0;
  const netPerOrder = orders > 0 ? netCash / orders : 0;

  const breakEvenRoas =
    contributionBeforeAd > 0
      ? revenue / contributionBeforeAd
      : Number.POSITIVE_INFINITY;
  const roasHeadroom =
    Number.isFinite(breakEvenRoas) && roas > 0
      ? Number(((roas - breakEvenRoas) / roas) * 100)
      : null;

  const categoryScenarios = FEE_CATEGORIES.map((category) => {
    const rate = resolveCategoryFee(input.marketId, category.id);
    const scenarioCommission = won(keptRevenue * (rate / 100));
    const scenarioSettlement = won(
      keptRevenue - scenarioCommission - paymentFee - returnShippingLoss,
    );
    const scenarioNet = won(
      scenarioSettlement - exchangeShippingLoss - cogs - fixedCost - adSpend,
    );
    return {
      categoryId: category.id,
      label: category.label,
      commissionRate: rate,
      commission: scenarioCommission,
      netCash: scenarioNet,
      delta: scenarioNet - netCash,
    };
  });

  const marketScenarios = MARKET_LIST.map((market) => {
    const rate = resolveCategoryFee(market.id, input.categoryId);
    const scenarioCommission = won(keptRevenue * (rate / 100));
    const scenarioPayment = won(revenue * (clamp(market.paymentRate, 0, 100) / 100));
    const scenarioSettlement = won(
      keptRevenue - scenarioCommission - scenarioPayment - returnShippingLoss,
    );
    const scenarioNet = won(
      scenarioSettlement - exchangeShippingLoss - cogs - fixedCost - adSpend,
    );
    return {
      marketId: market.id,
      label: market.label,
      shortLabel: market.shortLabel,
      color: market.color,
      commissionRate: rate,
      netCash: scenarioNet,
      delta: scenarioNet - netCash,
    };
  });

  return {
    revenue,
    keptRevenue: won(keptRevenue),
    orders: Math.round(orders),
    returns: Math.round(returns),
    exchanges: Math.round(exchanges),
    commissionRate,
    commission,
    paymentFee,
    cogs,
    adSpend,
    returnShippingLoss,
    exchangeShippingLoss,
    fixedCost,
    expectedSettlement,
    confirmedSettlement,
    settlementGap,
    settlementBase,
    contributionBeforeAd,
    netCash,
    netMarginRate,
    netPerOrder,
    breakEvenRoas,
    currentRoas: roas,
    roasHeadroom,
    maxAdSpend: Math.max(0, contributionBeforeAd),
    categoryScenarios,
    marketScenarios,
    assumptions: [
      "매출과 원가는 부가세 제외 금액입니다(부가세는 납부할 돈이라 순수익에서 제외).",
      "광고비는 반품 전 결제 매출 기준으로 발생합니다(노출·클릭은 반품과 무관).",
      "결제·PG 수수료는 결제 취소 후에도 환급되지 않는 경우가 많아 결제 매출 전체에 부과합니다.",
      "반품 시 판매 수수료와 원가는 회수되고, 회수 배송비(왕복)만 셀러 부담으로 계산합니다.",
      "교환은 매출이 유지되고 재발송 배송비만 추가로 발생합니다.",
    ],
  };
}

/**
 * ROAS만 바꿔 가며 순수익을 다시 계산한다(시뮬레이션 표·곡선용).
 * 다른 조건은 그대로 두므로 두 결과의 차이는 광고비 차이뿐이다.
 */
export function simulateRoas(
  input: NetPayoutInput,
  roasList: readonly number[] = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10],
): { roas: number; adSpend: number; netCash: number }[] {
  return roasList.map((roas) => {
    const result = calculateNetPayout({ ...input, roas });
    return { roas, adSpend: result.adSpend, netCash: result.netCash };
  });
}

/** 목표 순수익을 만족하는 ROAS. 목표가 공헌이익을 넘으면 Infinity. */
export function roasForTargetNetCash(input: NetPayoutInput, targetNetCash: number): number {
  const result = calculateNetPayout({ ...input, roas: 0 });
  const budget = result.contributionBeforeAd - safeAmount(targetNetCash);
  if (budget <= 0) return Number.POSITIVE_INFINITY;
  return result.revenue / budget;
}

/** 마켓 + 카테고리 조합의 요율을 한 번에 조회한다(화면 셀렉트용). */
export function listCategoryRates(categoryId: FeeCategoryId): {
  marketId: MarketId;
  label: string;
  color: string;
  rate: number;
}[] {
  return MARKET_LIST.map((market) => ({
    marketId: market.id,
    label: market.label,
    color: market.color,
    rate: resolveCategoryFee(market.id, categoryId),
  }));
}
