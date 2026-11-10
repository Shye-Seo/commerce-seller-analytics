import { MARKET_PRESETS, scoreKeywords } from "./calculator";
import type { KeywordRow, MarginInput, SalesPoint } from "./types";

/**
 * 데모 데이터.
 *
 * 1) 고정 시드 난수를 사용한다. 같은 빌드에서는 언제나 같은 값이 나오므로
 *    서버 컴포넌트 렌더 결과와 클라이언트 하이드레이션 결과가 어긋나지 않는다.
 * 2) 기준일도 상수로 고정한다. `new Date()`를 쓰면 빌드 시각에 따라 축 라벨이
 *    달라져 스냅샷 테스트와 스크린샷이 매번 바뀐다.
 *
 * 실제 오픈마켓 API를 연동하면 이 모듈은 "API 응답 → SalesPoint[]" 매퍼로 교체된다.
 */

/** 데모 데이터 기준일 */
export const DEMO_SNAPSHOT_DATE = "2026-11-10";

/** 시뮬레이터 초기 입력값 */
export const DEFAULT_MARGIN_INPUT: MarginInput = {
  marketId: "smartstore",
  costPrice: 12800,
  sellingPrice: 27900,
  commissionRate: MARKET_PRESETS.smartstore.commissionRate,
  paymentRate: MARKET_PRESETS.smartstore.paymentRate,
  shippingCost: MARKET_PRESETS.smartstore.defaultShippingFee,
  adCostPerUnit: 2400,
  returnRate: 9,
  monthlyUnits: 380,
  monthlyFixedCost: 620000,
};

/** 결정론적 난수 생성기 (mulberry32). 데모 데이터 재현성을 위해 사용한다. */
function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roundTo(value: number, unit: number): number {
  return Math.round(value / unit) * unit;
}

function formatDailyLabel(date: Date): string {
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

function formatMonthlyLabel(date: Date): string {
  const year = String(date.getUTCFullYear()).slice(2);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}.${month}`;
}

const dailyRandom = createSeededRandom(20261110);

/** 최근 30일 일별 매출 추이 */
export const DAILY_SALES: SalesPoint[] = (() => {
  const snapshot = new Date(`${DEMO_SNAPSHOT_DATE}T00:00:00Z`);

  return Array.from({ length: 30 }, (_, index) => {
    const date = new Date(snapshot);
    date.setUTCDate(date.getUTCDate() - (29 - index));

    const isWeekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
    const weekendBoost = isWeekend ? 1.24 : 1;
    const slowTrend = 1 + index * 0.005;
    const noise = 0.87 + dailyRandom() * 0.28;

    const revenue = roundTo(7_300_000 * weekendBoost * slowTrend * noise, 1000);
    const marginRate = Number((19 + dailyRandom() * 7.4).toFixed(1));
    const netProfit = Math.round((revenue * marginRate) / 100);
    const averageOrderValue = 26_000 + dailyRandom() * 9_000;
    const orders = Math.max(1, Math.round(revenue / averageOrderValue));

    return {
      label: formatDailyLabel(date),
      revenue,
      netProfit,
      marginRate,
      orders,
    };
  });
})();

const monthlyRandom = createSeededRandom(731104);

/** 최근 12개월 월별 매출 추이 */
export const MONTHLY_SALES: SalesPoint[] = (() => {
  const snapshot = new Date(`${DEMO_SNAPSHOT_DATE}T00:00:00Z`);
  const start = new Date(Date.UTC(snapshot.getUTCFullYear(), snapshot.getUTCMonth() - 11, 1));

  return Array.from({ length: 12 }, (_, index) => {
    const date = new Date(start);
    date.setUTCMonth(start.getUTCMonth() + index);

    const growth = 1 + index * 0.052;
    const seasonal = index >= 8 ? 1.14 : 1; // 하반기 성수기 반영
    const noise = 0.92 + monthlyRandom() * 0.16;

    const revenue = roundTo(168_000_000 * growth * seasonal * noise, 10_000);
    const marginRate = Number((17.5 + monthlyRandom() * 8.2).toFixed(1));
    const netProfit = Math.round((revenue * marginRate) / 100);
    const orders = Math.round(revenue / (27_000 + monthlyRandom() * 6_000));

    return {
      label: formatMonthlyLabel(date),
      revenue,
      netProfit,
      marginRate,
      orders,
    };
  });
})();

/** 키워드 분석 원본 데이터 (캠핑·아웃도어 카테고리 기준) */
export const KEYWORD_ROWS: KeywordRow[] = [
  {
    id: "kw-01",
    keyword: "캠핑 의자 추천",
    market: "naver",
    monthlyVolume: 162_000,
    competition: 78,
    purchaseIntent: 58,
    averagePrice: 32_000,
    category: "캠핑 용품",
  },
  {
    id: "kw-02",
    keyword: "경량 캠핑 체어",
    market: "naver",
    monthlyVolume: 48_300,
    competition: 41,
    purchaseIntent: 72,
    averagePrice: 45_000,
    category: "캠핑 용품",
  },
  {
    id: "kw-03",
    keyword: "캠핑 테이블",
    market: "coupang",
    monthlyVolume: 96_500,
    competition: 69,
    purchaseIntent: 64,
    averagePrice: 58_000,
    category: "캠핑 용품",
  },
  {
    id: "kw-04",
    keyword: "감성 캠핑 랜턴",
    market: "naver",
    monthlyVolume: 27_400,
    competition: 33,
    purchaseIntent: 76,
    averagePrice: 21_900,
    category: "캠핑 용품",
  },
  {
    id: "kw-05",
    keyword: "캠핑 랜턴 usb 충전",
    market: "coupang",
    monthlyVolume: 18_900,
    competition: 28,
    purchaseIntent: 81,
    averagePrice: 19_800,
    category: "캠핑 용품",
  },
  {
    id: "kw-06",
    keyword: "차박 매트",
    market: "naver",
    monthlyVolume: 73_200,
    competition: 62,
    purchaseIntent: 55,
    averagePrice: 89_000,
    category: "차박 용품",
  },
  {
    id: "kw-07",
    keyword: "캠핑 웨건",
    market: "coupang",
    monthlyVolume: 41_700,
    competition: 58,
    purchaseIntent: 47,
    averagePrice: 134_000,
    category: "캠핑 용품",
  },
  {
    id: "kw-08",
    keyword: "캠핑 웨건 가성비",
    market: "naver",
    monthlyVolume: 12_600,
    competition: 24,
    purchaseIntent: 88,
    averagePrice: 97_000,
    category: "캠핑 용품",
  },
  {
    id: "kw-09",
    keyword: "폴딩 박스",
    market: "coupang",
    monthlyVolume: 55_800,
    competition: 51,
    purchaseIntent: 66,
    averagePrice: 16_500,
    category: "캠핑 용품",
  },
  {
    id: "kw-10",
    keyword: "캠핑 수납 박스",
    market: "naver",
    monthlyVolume: 34_500,
    competition: 39,
    purchaseIntent: 70,
    averagePrice: 23_800,
    category: "캠핑 용품",
  },
  {
    id: "kw-11",
    keyword: "미니멀 캠핑 의자",
    market: "coupang",
    monthlyVolume: 9_300,
    competition: 18,
    purchaseIntent: 84,
    averagePrice: 52_000,
    category: "캠핑 용품",
  },
  {
    id: "kw-12",
    keyword: "캠핑 버너",
    market: "naver",
    monthlyVolume: 88_000,
    competition: 74,
    purchaseIntent: 49,
    averagePrice: 41_000,
    category: "캠핑 용품",
  },
  {
    id: "kw-13",
    keyword: "아이스박스",
    market: "coupang",
    monthlyVolume: 121_000,
    competition: 81,
    purchaseIntent: 57,
    averagePrice: 68_000,
    category: "캠핑 용품",
  },
  {
    id: "kw-14",
    keyword: "소형 아이스박스",
    market: "naver",
    monthlyVolume: 22_700,
    competition: 31,
    purchaseIntent: 79,
    averagePrice: 34_500,
    category: "캠핑 용품",
  },
];

/** 기회 지수가 계산·정렬된 키워드 목록 */
export const SCORED_KEYWORDS = scoreKeywords(KEYWORD_ROWS);
