/**
 * 도메인 타입 정의
 *
 * 이 프로젝트의 핵심은 "금액 계산"이다. 원화 금액·수수료율·수량이 뒤섞여
 * 런타임에 NaN이나 단위 오류가 생기면 셀러의 의사결정이 곧바로 틀어진다.
 * 따라서 화면(UI)보다 도메인 타입을 먼저 고정하고, 모든 계산은 이 타입을
 * 통과하도록 강제한다.
 */

/** 마켓(판매 채널) 식별자 */
export type MarketId = "smartstore" | "coupang" | "elevenst" | "gmarket" | "own";

/** 키워드 분석 대상 플랫폼 */
export type KeywordMarket = "naver" | "coupang";

/** 시계열 조회 단위 */
export type TrendRange = "daily" | "monthly";

/** 기회 지수 등급 */
export type KeywordGrade = "진입 추천" | "관찰" | "회피";

/**
 * 마켓별 수수료 프리셋.
 *
 * 실제 정산은 카테고리·계약 조건·프로모션에 따라 달라지므로, 여기 값은
 * "기본값을 채워 주는 출발점"으로만 사용하고 화면에서 자유롭게 수정할 수 있게 한다.
 */
export interface MarketPreset {
  id: MarketId;
  /** 화면에 노출할 정식 명칭 */
  label: string;
  /** 좁은 영역(탭·배지)에 쓰는 축약 명칭 */
  shortLabel: string;
  /** 판매 수수료율(%) */
  commissionRate: number;
  /** 결제·매출 연동 수수료율(%) */
  paymentRate: number;
  /** 정산 소요일(영업일 기준) */
  settlementDays: number;
  /** 셀러가 부담하는 기본 배송비(원) */
  defaultShippingFee: number;
  /** 차트·배지에 쓰는 대표 색상 */
  color: string;
  /** 프리셋 설명(툴팁·도움말) */
  note: string;
}

/**
 * 마진 시뮬레이터 입력값.
 *
 * 모든 금액은 원(KRW) 단위이며, 율(%) 값은 0~100 사이의 퍼센트 숫자다.
 * (예: 10.8% -> 10.8)
 */
export interface MarginInput {
  marketId: MarketId;
  /** 상품 원가(매입가 + 입고 물류비) */
  costPrice: number;
  /** 판매가(부가세 포함 소비자가) */
  sellingPrice: number;
  /** 판매 수수료율(%) */
  commissionRate: number;
  /** 결제·PG 수수료율(%) */
  paymentRate: number;
  /** 셀러 부담 배송비(원) */
  shippingCost: number;
  /** 건당 광고비(원) */
  adCostPerUnit: number;
  /** 반품률(%) */
  returnRate: number;
  /** 월 판매 수량(건) */
  monthlyUnits: number;
  /** 월 고정비(창고비·구독료 등, 원) */
  monthlyFixedCost: number;
}

/** 마진 시뮬레이션 결과 */
export interface MarginBreakdown {
  /** 계산 기준 판매가 */
  sellingPrice: number;
  /** 판매 수수료 */
  commission: number;
  /** 결제 수수료 */
  paymentFee: number;
  /** 셀러 부담 배송비 */
  shippingCost: number;
  /** 건당 광고비 */
  adCost: number;
  /** 반품률을 반영한 기대 반품 손실 */
  expectedReturnLoss: number;
  /** 상품 원가 */
  productCost: number;
  /** 판매가에서 차감되는 모든 비용의 합 */
  totalDeduction: number;
  /** 건당 순이익 */
  netProfitPerUnit: number;
  /** 판매가 대비 순이익률(%) */
  marginRate: number;
  /** 손익분기 판매가(원). 수수료율이 100% 이상이면 Infinity */
  breakEvenPrice: number;
  /** 월 고정비를 회수하는 손익분기 판매량(건). 건당 이익이 0 이하이면 Infinity */
  breakEvenUnits: number;
  /** 월 예상 매출 */
  monthlyRevenue: number;
  /** 월 예상 순이익(고정비 차감 후) */
  monthlyNetProfit: number;
  /** 월 매출 대비 순이익률(%) */
  monthlyMarginRate: number;
  /** 판매가 대비 실제 수수료 부담률(%) */
  effectiveFeeRate: number;
}

/** 키워드 분석 원본 행 */
export interface KeywordRow {
  id: string;
  keyword: string;
  market: KeywordMarket;
  /** 월간 검색량 */
  monthlyVolume: number;
  /** 경쟁 강도 지수(0~100, 높을수록 경쟁 치열) */
  competition: number;
  /** 구매 의도 지수(0~100, 높을수록 구매 목적 검색) */
  purchaseIntent: number;
  /** 카테고리 평균 판매가(원) */
  averagePrice: number;
  /** 카테고리 명 */
  category: string;
}

/** 기회 지수가 계산된 키워드 행 */
export interface ScoredKeyword extends KeywordRow {
  /** 0~100 기회 지수 */
  opportunityScore: number;
  grade: KeywordGrade;
}

/** 매출 추이 한 점 */
export interface SalesPoint {
  /** 축 라벨 (예: 11/10, 26.11) */
  label: string;
  /** 매출(원) */
  revenue: number;
  /** 순이익(원) */
  netProfit: number;
  /** 마진율(%) */
  marginRate: number;
  /** 주문 수(건) */
  orders: number;
}
