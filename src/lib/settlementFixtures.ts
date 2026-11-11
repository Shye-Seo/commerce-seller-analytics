import type { MarketChannel, OrderStatus, SettlementRow } from "./reconciliationEngine";
import { CHANNEL_CONTRACTS, roundWon } from "./reconciliationEngine";

/**
 * 정산서 데모 데이터 생성기
 *
 * 데모라도 "랜덤 쓰레기"는 의미가 없다. 여기서는 **실제 정산서가 어긋나는 패턴**을 의도적으로
 * 주입한다. 주입한 이상의 종류와 비율을 알고 있으므로, 대사 엔진이 그 이상을 정확히 잡아내는지
 * 역으로 검증할 수 있다(테스트의 recoverability 케이스).
 *
 * 고정 시드(mulberry32)를 쓰기 때문에 서버 렌더와 클라이언트 하이드레이션이 같은 값을 본다.
 */

/** 데모 기준일 — `new Date()`를 쓰면 빌드마다 결과가 달라진다. */
export const SETTLEMENT_SNAPSHOT_DATE = "2026-11-10";

const CHANNELS: MarketChannel[] = ["smartstore", "coupang", "elevenst", "gmarket"];

interface CatalogItem {
  sku: string;
  name: string;
  /** 매입원가 범위(원) */
  costRange: [number, number];
  /** 판매가 범위(원) */
  priceRange: [number, number];
}

const CATALOG: CatalogItem[] = [
  { sku: "SG-CANDLE-01", name: "소이 캔들 200g · 우드윅", costRange: [6_200, 7_400], priceRange: [16_900, 21_900] },
  { sku: "SG-CANDLE-02", name: "소이 캔들 200g · 시트러스", costRange: [6_200, 7_400], priceRange: [16_900, 21_900] },
  { sku: "SG-DIFF-01", name: "리드 디퓨저 100ml · 린넨", costRange: [5_100, 6_300], priceRange: [14_900, 19_900] },
  { sku: "SG-POUCH-01", name: "린넨 파우치 · 아이보리", costRange: [3_100, 4_200], priceRange: [11_900, 15_900] },
  { sku: "SG-POUCH-02", name: "린넨 파우치 · 세이지", costRange: [3_100, 4_200], priceRange: [11_900, 15_900] },
  { sku: "SG-MUG-01", name: "무광 세라믹 머그 350ml", costRange: [4_800, 5_900], priceRange: [13_900, 17_900] },
  { sku: "SG-MUG-02", name: "무광 세라믹 머그 500ml", costRange: [5_600, 6_800], priceRange: [15_900, 19_900] },
  { sku: "SG-TOWEL-01", name: "와플 코튼 타월 40수", costRange: [2_900, 3_800], priceRange: [9_900, 12_900] },
  { sku: "SG-TOWEL-02", name: "와플 코튼 타월 60수", costRange: [3_800, 4_900], priceRange: [12_900, 15_900] },
  { sku: "SG-BAG-01", name: "캔버스 에코백 · 내추럴", costRange: [2_400, 3_200], priceRange: [8_900, 11_900] },
  { sku: "SG-BAG-02", name: "캔버스 에코백 · 차콜", costRange: [2_400, 3_200], priceRange: [8_900, 11_900] },
  { sku: "SG-NOTE-01", name: "도트 그리드 노트 A5", costRange: [1_200, 1_800], priceRange: [5_900, 7_900] },
  { sku: "SG-NOTE-02", name: "도트 그리드 노트 B5", costRange: [1_900, 2_600], priceRange: [7_900, 9_900] },
  { sku: "SG-PEN-01", name: "젤 볼펜 3색 세트", costRange: [1_100, 1_600], priceRange: [4_900, 6_900] },
  { sku: "SG-BOTTLE-01", name: "스테인리스 보틀 500ml", costRange: [8_200, 9_800], priceRange: [22_900, 27_900] },
  { sku: "SG-BOTTLE-02", name: "스테인리스 보틀 750ml", costRange: [9_400, 11_200], priceRange: [25_900, 31_900] },
  { sku: "SG-TRAY-01", name: "아카시아 원목 트레이", costRange: [7_100, 8_600], priceRange: [19_900, 24_900] },
  { sku: "SG-TRAY-02", name: "아카시아 원목 트레이 (대)", costRange: [9_300, 11_000], priceRange: [26_900, 32_900] },
  { sku: "SG-CUSHION-01", name: "소파 쿠션 커버 45cm", costRange: [5_400, 6_600], priceRange: [15_900, 19_900] },
  { sku: "SG-CUSHION-02", name: "소파 쿠션 커버 50cm", costRange: [6_100, 7_500], priceRange: [17_900, 22_900] },
  { sku: "SG-BLANKET-01", name: "워시드 코튼 블랭킷", costRange: [14_100, 16_800], priceRange: [38_900, 46_900] },
  { sku: "SG-APRON-01", name: "린넨 앞치마 · 베이지", costRange: [6_800, 8_100], priceRange: [18_900, 23_900] },
  { sku: "SG-HANGER-01", name: "원목 옷걸이 5P", costRange: [3_400, 4_400], priceRange: [12_900, 16_900] },
  { sku: "SG-STORAGE-01", name: "패브릭 수납함 (L)", costRange: [5_900, 7_200], priceRange: [16_900, 21_900] },
];

/** 결정론적 난수 (mulberry32) */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  const index = Math.floor(random() * items.length) % items.length;
  return items[index] as T;
}

function intBetween(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

function roundToThousand(value: number): number {
  return Math.round(value / 1_000) * 1_000;
}

function dateBefore(base: string, daysAgo: number): string {
  const baseTime = Date.parse(`${base}T00:00:00Z`);
  const target = new Date(baseTime - daysAgo * 24 * 60 * 60 * 1000);
  return target.toISOString().slice(0, 10);
}

/**
 * 이상 주입 비율.
 * 합이 1을 넘지 않아야 하며, 나머지는 "정상" 행이 된다.
 */
export interface AnomalyRates {
  /** 수수료 초과 청구 (청구액을 3~14% 부풀린다) */
  feeOvercharge: number;
  /** 수수료 과소 청구 */
  feeUndercharge: number;
  /** 반품비 중복 차감(왕복 기준액의 1.4~2배) */
  duplicateReturnFee: number;
  /** 배송완료 건에 반품비 부과 */
  returnFeeOnShipped: number;
  /** 배송비 초과 차감 */
  shippingOvercharge: number;
  /** 원인 미상 정산 부족 */
  unattributedShortfall: number;
  /** 반올림 누수(1~9원) */
  roundingLeak: number;
  /** 역마진(원가 이하 판매) */
  negativeMargin: number;
  /** 원장 누락(원가 0) */
  missingLedger: number;
  /** 취소 건 수수료 청구 */
  feeOnCanceled: number;
}

export const DEFAULT_ANOMALY_RATES: AnomalyRates = {
  feeOvercharge: 0.018,
  feeUndercharge: 0.004,
  duplicateReturnFee: 0.012,
  returnFeeOnShipped: 0.008,
  shippingOvercharge: 0.01,
  unattributedShortfall: 0.005,
  roundingLeak: 0.03,
  negativeMargin: 0.06,
  missingLedger: 0.003,
  feeOnCanceled: 0.003,
};

export interface FixtureOptions {
  /** 생성할 행 수 */
  count: number;
  seed?: number;
  /** 기준일(YYYY-MM-DD) */
  snapshotDate?: string;
  /** 주문일 분포 기간(일) */
  windowDays?: number;
  anomalyRates?: Partial<AnomalyRates>;
  channels?: MarketChannel[];
}

const STATUS_WEIGHTS: { status: OrderStatus; weight: number }[] = [
  { status: "배송완료", weight: 0.86 },
  { status: "반품완료", weight: 0.08 },
  { status: "취소", weight: 0.03 },
  { status: "교환완료", weight: 0.03 },
];

function pickStatus(random: () => number): OrderStatus {
  const value = random();
  let cumulative = 0;
  for (const entry of STATUS_WEIGHTS) {
    cumulative += entry.weight;
    if (value <= cumulative) return entry.status;
  }
  return "배송완료";
}

/**
 * 정산서 데모 행 생성.
 *
 * 각 행은 계약 조건으로 "깨끗한 정산"을 먼저 만든 뒤, 주입 비율에 따라 한 가지 이상을 어긋나게 한다.
 * 어긋남은 항상 `settledAmount`에도 반영되므로, 대사 엔진이 기대값과 비교해 되찾아낼 수 있어야 한다.
 */
export function generateSettlementRows(options: FixtureOptions): SettlementRow[] {
  const count = Math.max(0, Math.floor(options.count));
  const random = createRandom(options.seed ?? 20261111);
  const snapshotDate = options.snapshotDate ?? SETTLEMENT_SNAPSHOT_DATE;
  const windowDays = options.windowDays ?? 90;
  const channels = options.channels && options.channels.length > 0 ? options.channels : CHANNELS;
  const rates: AnomalyRates = { ...DEFAULT_ANOMALY_RATES, ...options.anomalyRates };

  const rows: SettlementRow[] = [];

  for (let index = 0; index < count; index += 1) {
    const channel = pick(random, channels);
    const contract = CHANNEL_CONTRACTS[channel];
    const catalog = pick(random, CATALOG);
    const status = pickStatus(random);

    const quantity = random() < 0.78 ? 1 : intBetween(random, 2, 3);
    const unitCost = roundToThousand(intBetween(random, catalog.costRange[0], catalog.costRange[1]));
    const unitPrice = roundToThousand(intBetween(random, catalog.priceRange[0], catalog.priceRange[1])) - 100;
    const paidAmount = unitPrice * quantity;
    const sellerShippingCost = status === "취소" ? 0 : roundToThousand(intBetween(random, 2_400, 3_600));

    const revenue = status === "취소" || status === "반품완료" ? 0 : paidAmount;
    let commission = roundWon((revenue * contract.feeRate) / 100);
    let shippingDeduction = revenue === 0 ? 0 : contract.outboundShipping;
    let returnFee =
      status === "반품완료" || status === "교환완료" ? contract.roundTripReturnFee : 0;

    // --- 이상 주입 ---
    // 누적 임계값으로 밴드를 나눈다. 비율의 합이 1을 넘으면 뒤쪽 밴드는 자연히 사라진다.
    const roll = random();
    const feeOverEnd = rates.feeOvercharge;
    const feeUnderEnd = feeOverEnd + rates.feeUndercharge;
    const duplicateEnd = feeUnderEnd + rates.duplicateReturnFee;
    const returnOnShippedEnd = duplicateEnd + rates.returnFeeOnShipped;
    const shippingOverEnd = returnOnShippedEnd + rates.shippingOvercharge;
    const feeOnCanceledEnd = shippingOverEnd + rates.feeOnCanceled;

    if (roll < feeOverEnd) {
      // 수수료 초과 청구: 계약 수수료의 3~14%를 더 청구
      commission += Math.max(120, roundWon(commission * (0.03 + random() * 0.11)));
    } else if (roll < feeUnderEnd) {
      commission = Math.max(0, commission - Math.max(150, roundWon(commission * 0.05)));
    } else if (roll < duplicateEnd) {
      if (status === "반품완료") {
        // 반품비 중복 차감: 왕복 기준액의 1.4~2배
        returnFee += roundWon(contract.roundTripReturnFee * (0.4 + random()));
      }
    } else if (roll < returnOnShippedEnd) {
      if (status === "배송완료") {
        returnFee = roundToThousand(intBetween(random, 2_500, 3_500));
      }
    } else if (roll < shippingOverEnd) {
      if (revenue > 0) shippingDeduction += roundToThousand(intBetween(random, 1_000, 2_500));
    } else if (roll < feeOnCanceledEnd) {
      if (status === "취소") commission = roundToThousand(intBetween(random, 1_500, 4_500));
    }

    // 역마진: 원가 이하로 판매된 건. 정산액 자체는 정상이지만 마진이 마이너스다.
    if (random() < rates.negativeMargin && status === "배송완료") {
      const lossPrice = Math.max(1_000, roundToThousand(unitCost * (0.62 + random() * 0.2)) - 100);
      const recalculated = lossPrice * quantity;
      const ratio = paidAmount > 0 ? recalculated / paidAmount : 1;
      commission = roundWon(commission * ratio);
      shippingDeduction = roundWon(shippingDeduction * ratio);
      returnFee = roundWon(returnFee * ratio);
      rows.push({
        orderNo: buildOrderNo(channel, index),
        channel,
        orderDate: dateBefore(snapshotDate, intBetween(random, 0, windowDays)),
        productName: catalog.name,
        sku: catalog.sku,
        quantity,
        paidAmount: recalculated,
        commission,
        shippingDeduction,
        returnFee,
        settledAmount: recalculated - commission - shippingDeduction - returnFee,
        contractFeeRate: contract.feeRate,
        unitCost,
        sellerShippingCost,
        status,
      });
      continue;
    }

    if (random() < rates.missingLedger) {
      // 원장 누락: 매입원가가 0으로 기록됨
      const settled = revenue - commission - shippingDeduction - returnFee;
      rows.push({
        orderNo: buildOrderNo(channel, index),
        channel,
        orderDate: dateBefore(snapshotDate, intBetween(random, 0, windowDays)),
        productName: catalog.name,
        sku: catalog.sku,
        quantity,
        paidAmount,
        commission,
        shippingDeduction,
        returnFee,
        settledAmount: settled,
        contractFeeRate: contract.feeRate,
        unitCost: 0,
        sellerShippingCost,
        status,
      });
      continue;
    }

    let settledAmount = revenue - commission - shippingDeduction - returnFee;

    if (random() < rates.unattributedShortfall) {
      settledAmount -= roundToThousand(intBetween(random, 800, 4_200));
    } else if (random() < rates.roundingLeak) {
      settledAmount -= intBetween(random, 1, 9);
    }

    rows.push({
      orderNo: buildOrderNo(channel, index),
      channel,
      orderDate: dateBefore(snapshotDate, intBetween(random, 0, windowDays)),
      productName: catalog.name,
      sku: catalog.sku,
      quantity,
      paidAmount,
      commission,
      shippingDeduction,
      returnFee,
      settledAmount,
      contractFeeRate: contract.feeRate,
      unitCost,
      sellerShippingCost,
      status,
    });
  }

  return rows;
}

function buildOrderNo(channel: MarketChannel, index: number): string {
  const prefix: Record<MarketChannel, string> = {
    smartstore: "SS",
    coupang: "CP",
    elevenst: "EL",
    gmarket: "GM",
  };
  return `${prefix[channel]}${String(202611000000 + index).padStart(14, "0")}`;
}

/** CSV 직렬화에 쓰는 한글 헤더 (파서가 한글/영문 헤더를 모두 받는다) */
export const SETTLEMENT_CSV_HEADERS = [
  "주문번호",
  "채널",
  "주문일",
  "상품명",
  "SKU",
  "수량",
  "결제금액",
  "마켓수수료",
  "배송비차감액",
  "반품비",
  "실정산액",
  "계약수수료율",
  "매입원가",
  "실배송원가",
  "주문상태",
] as const;

function escapeCsvField(value: string | number): string {
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** 정산 행 → CSV 텍스트 (테스트·샘플 파일 생성용) */
export function generateSettlementCsv(rows: readonly SettlementRow[], options: { bom?: boolean } = {}): string {
  const lines: string[] = [SETTLEMENT_CSV_HEADERS.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.orderNo,
        row.channel,
        row.orderDate,
        row.productName,
        row.sku,
        row.quantity,
        row.paidAmount,
        row.commission,
        row.shippingDeduction,
        row.returnFee,
        row.settledAmount,
        row.contractFeeRate,
        row.unitCost,
        row.sellerShippingCost,
        row.status,
      ]
        .map(escapeCsvField)
        .join(","),
    );
  }
  const body = lines.join("\r\n");
  return options.bom === false ? body : `\uFEFF${body}`;
}
