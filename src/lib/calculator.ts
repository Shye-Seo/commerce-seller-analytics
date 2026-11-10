import type {
  KeywordRow,
  KeywordGrade,
  MarginBreakdown,
  MarginInput,
  MarketId,
  MarketPreset,
  ScoredKeyword,
} from "./types";

/**
 * 마켓별 수수료 프리셋.
 *
 * 값은 2024~2026년 공개된 오픈마켓 수수료 정책을 참고한 "기본값"이며, 실제 정산은
 * 카테고리·계약 등급·프로모션에 따라 달라진다. 그래서 프리셋은 입력값을 채워 주는
 * 출발점일 뿐이고, 화면에서 수수료율을 직접 수정할 수 있게 설계했다.
 */
export const MARKET_PRESETS: Record<MarketId, MarketPreset> = {
  smartstore: {
    id: "smartstore",
    label: "네이버 스마트스토어",
    shortLabel: "스마트스토어",
    commissionRate: 3.63,
    paymentRate: 0,
    settlementDays: 3,
    defaultShippingFee: 3000,
    color: "#03C75A",
    note: "일반 카테고리 기준. 판매 수수료에 결제 수수료가 포함된 구조.",
  },
  coupang: {
    id: "coupang",
    label: "쿠팡 마켓플레이스",
    shortLabel: "쿠팡",
    commissionRate: 10.8,
    paymentRate: 0,
    settlementDays: 7,
    defaultShippingFee: 0,
    color: "#F1682A",
    note: "카테고리별 5~15% 구간. 판매자 부담 배송이 기본인 상품군이 많다.",
  },
  elevenst: {
    id: "elevenst",
    label: "11번가",
    shortLabel: "11번가",
    commissionRate: 9,
    paymentRate: 0,
    settlementDays: 5,
    defaultShippingFee: 3000,
    color: "#FF0038",
    note: "카테고리별 6~12% 구간. 프로모션 수수료가 별도로 붙는 경우가 있다.",
  },
  gmarket: {
    id: "gmarket",
    label: "G마켓 · 옥션",
    shortLabel: "G마켓",
    commissionRate: 8.5,
    paymentRate: 0,
    settlementDays: 5,
    defaultShippingFee: 3000,
    color: "#00A05B",
    note: "판매 등급에 따라 8~12% 구간이 적용된다.",
  },
  own: {
    id: "own",
    label: "자사몰 (PG 직접 계약)",
    shortLabel: "자사몰",
    commissionRate: 0,
    paymentRate: 3.3,
    settlementDays: 2,
    defaultShippingFee: 3000,
    color: "#6366F1",
    note: "중개 수수료 대신 PG 결제 수수료만 발생한다. 광고비 비중은 커진다.",
  },
};

/** 화면 노출 순서를 고정하기 위한 마켓 목록 */
export const MARKET_LIST: MarketPreset[] = [
  MARKET_PRESETS.smartstore,
  MARKET_PRESETS.coupang,
  MARKET_PRESETS.elevenst,
  MARKET_PRESETS.gmarket,
  MARKET_PRESETS.own,
];

/**
 * 반품 1건이 발생했을 때 원가에서 회수하지 못하는 비율.
 *
 * 반품된 상품은 재검수·재포장을 거치며 가치가 일부 하락한다(개봉·사용 흔적,
 * 포장 파손 등). 실제 셀러 회계에서는 이 손실을 "반품 충당금"으로 잡는데,
 * 여기서는 보수적으로 원가의 10%를 적용한다.
 */
export const RETURN_HANDLING_RATE = 0.1;

/** 기회 지수 계산에서 검색량을 100%로 포화시키는 기준값 */
const VOLUME_SATURATION = 100_000;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function safeAmount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(value, 0);
}

/**
 * 판매가에서 발생하는 수수료(판매 수수료 + 결제 수수료)를 계산한다.
 */
export function calculateFees(
  sellingPrice: number,
  commissionRate: number,
  paymentRate: number,
): { commission: number; paymentFee: number; total: number } {
  const price = safeAmount(sellingPrice);
  const commission = price * (clamp(commissionRate, 0, 100) / 100);
  const paymentFee = price * (clamp(paymentRate, 0, 100) / 100);

  return {
    commission: Math.round(commission),
    paymentFee: Math.round(paymentFee),
    total: Math.round(commission + paymentFee),
  };
}

/**
 * 손익분기 판매가를 계산한다.
 *
 * 순이익 = P(1 - 판매수수료율 - 결제수수료율) - 고정비성 원가
 * 위 식을 P에 대해 풀면 P = 고정비성 원가 / (1 - 판매수수료율 - 결제수수료율) 이다.
 * 여기서 "고정비성 원가"는 판매가와 무관하게 발생하는 원가 + 배송비 + 광고비 + 기대 반품 손실이다.
 *
 * 수수료율 합이 100% 이상이면 어떤 가격으로도 이익이 날 수 없으므로 Infinity를 반환한다.
 */
export function computeBreakEvenPrice(
  fixedCost: number,
  commissionRate: number,
  paymentRate: number,
): number {
  const feeRateSum = clamp(commissionRate, 0, 100) / 100 + clamp(paymentRate, 0, 100) / 100;
  const denominator = 1 - feeRateSum;
  if (denominator <= 0.0001) return Number.POSITIVE_INFINITY;

  return Math.ceil(safeAmount(fixedCost) / denominator);
}

/**
 * 목표 마진율을 확보하는 권장 판매가를 계산한다.
 *
 * 손익분기 판매가와 같은 식에서 분자에 목표 마진율을 더한 형태다.
 * (예: 목표 마진 25% -> P = 고정비성 원가 / (1 - 수수료율 - 0.25))
 */
export function recommendSellingPrice(input: MarginInput, targetMarginRate = 25): number {
  const snapshot = calculateMargin(input);
  const feeRateSum =
    clamp(input.commissionRate, 0, 100) / 100 + clamp(input.paymentRate, 0, 100) / 100;
  const target = clamp(targetMarginRate, 0, 90) / 100;
  const denominator = 1 - feeRateSum - target;
  if (denominator <= 0.0001) return Number.POSITIVE_INFINITY;

  const fixedCost =
    snapshot.productCost + snapshot.shippingCost + snapshot.adCost + snapshot.expectedReturnLoss;

  // 100원 단위로 올림해 실제 판매가로 쓰기 좋은 숫자로 만든다.
  return Math.ceil(fixedCost / denominator / 100) * 100;
}

/**
 * 마진 시뮬레이션 본체.
 *
 * 입력값을 그대로 신뢰하지 않고 0~100% 범위를 벗어난 율, 음수 금액을 모두 보정한다.
 * UI에서 숫자 입력은 빈 문자열 → 0 → 음수까지 흘러들어올 수 있기 때문에,
 * 계산 함수가 마지막 방어선 역할을 해야 한다.
 */
export function calculateMargin(input: MarginInput): MarginBreakdown {
  const sellingPrice = safeAmount(input.sellingPrice);
  const productCost = safeAmount(input.costPrice);
  const shippingCost = safeAmount(input.shippingCost);
  const adCost = safeAmount(input.adCostPerUnit);
  const monthlyUnits = safeAmount(input.monthlyUnits);
  const monthlyFixedCost = safeAmount(input.monthlyFixedCost);

  const commissionRate = clamp(input.commissionRate, 0, 100);
  const paymentRate = clamp(input.paymentRate, 0, 100);
  const returnRate = clamp(input.returnRate, 0, 100) / 100;

  const { commission, paymentFee } = calculateFees(sellingPrice, commissionRate, paymentRate);

  // 반품 1건당 손실 = 왕복 배송비 + 재판매 가치 하락분. 여기에 반품률을 곱해 기대값을 구한다.
  const expectedReturnLoss = Math.round(
    returnRate * (shippingCost * 2 + productCost * RETURN_HANDLING_RATE),
  );

  const totalDeduction =
    productCost + commission + paymentFee + shippingCost + adCost + expectedReturnLoss;
  const netProfitPerUnit = sellingPrice - totalDeduction;

  const marginRate = sellingPrice > 0 ? (netProfitPerUnit / sellingPrice) * 100 : 0;
  const effectiveFeeRate =
    sellingPrice > 0 ? ((commission + paymentFee) / sellingPrice) * 100 : 0;

  const breakEvenPrice = computeBreakEvenPrice(
    productCost + shippingCost + adCost + expectedReturnLoss,
    commissionRate,
    paymentRate,
  );

  const breakEvenUnits =
    monthlyFixedCost === 0
      ? 0
      : netProfitPerUnit > 0
        ? Math.ceil(monthlyFixedCost / netProfitPerUnit)
        : Number.POSITIVE_INFINITY;

  const monthlyRevenue = sellingPrice * monthlyUnits;
  const monthlyNetProfit = netProfitPerUnit * monthlyUnits - monthlyFixedCost;
  const monthlyMarginRate = monthlyRevenue > 0 ? (monthlyNetProfit / monthlyRevenue) * 100 : 0;

  return {
    sellingPrice,
    commission,
    paymentFee,
    shippingCost,
    adCost,
    expectedReturnLoss,
    productCost,
    totalDeduction,
    netProfitPerUnit,
    marginRate,
    breakEvenPrice,
    breakEvenUnits,
    monthlyRevenue,
    monthlyNetProfit,
    monthlyMarginRate,
    effectiveFeeRate,
  };
}

/**
 * 키워드 기회 지수.
 *
 * 셀러가 실제로 던지는 질문은 "검색량이 많은가"가 아니라
 * "검색량 대비 경쟁이 감당 가능하고, 구매 의도가 높은가"다.
 * 따라서 세 지표를 다음 가중치로 합성한다.
 *
 *   기회 지수 = 0.45 × 수요(검색량 로그 정규화)
 *             + 0.30 × 구매 의도
 *             + 0.25 × (1 - 경쟁 강도)
 *
 * 검색량은 절대값이 아니라 로그 스케일로 정규화한다. 1,000 → 100,000 구간의
 * 차이는 크지만, 100,000 → 200,000의 차이는 셀러 판단을 크게 바꾸지 않기 때문이다.
 */
export function scoreKeyword(row: KeywordRow): ScoredKeyword {
  const volume = safeAmount(row.monthlyVolume);
  const demand =
    volume <= 0 ? 0 : clamp(Math.log10(volume) / Math.log10(VOLUME_SATURATION), 0, 1);
  const competition = clamp(row.competition, 0, 100) / 100;
  const intent = clamp(row.purchaseIntent, 0, 100) / 100;

  const raw = 0.45 * demand + 0.3 * intent + 0.25 * (1 - competition);
  const opportunityScore = Math.round(clamp(raw, 0, 1) * 100);

  const grade: KeywordGrade =
    opportunityScore >= 70 ? "진입 추천" : opportunityScore >= 55 ? "관찰" : "회피";

  return { ...row, opportunityScore, grade };
}

/** 키워드 목록을 기회 지수 내림차순으로 정렬해 반환한다. */
export function scoreKeywords(rows: KeywordRow[]): ScoredKeyword[] {
  return rows.map(scoreKeyword).sort((a, b) => b.opportunityScore - a.opportunityScore);
}
