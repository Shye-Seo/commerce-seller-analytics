import { WATCH_SNAPSHOT_DATE, expectedSettlementAmount, type SettlementRecord, type WatchOrder } from "./settlementWatch";
import { addBusinessDays, calendarDaysBetween } from "./alertRules";
import { MARKET_PRESETS } from "./calculator";
import type { MarketChannel } from "./reconciliationEngine";

/**
 * 정산 감시 데모 원장 생성기
 *
 * "구매확정 140건"과 "마켓 정산 내역"을 고정 시드로 만든다. 정상 정산만 넣으면 감지기를
 * 보여 줄 수 없으므로, 실제 운영에서 발생하는 유형을 비율로 주입한다.
 *
 *   - 기한 내 정상 정산
 *   - 예정일보다 늦은 입금
 *   - 금액이 모자란 부분 정산
 *   - "예정"으로만 잡혀 있고 기한이 지난 건
 *   - 정산 내역 자체가 없는 건(누락 의심)
 *
 * 고정 시드이므로 서버 렌더와 클라이언트 하이드레이션이 같은 원장을 본다.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

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

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

interface CatalogItem {
  sku: string;
  name: string;
  optionName: string;
  price: number;
}

const CATALOG: CatalogItem[] = [
  { sku: "SS-WOOL", name: "울 블렌드 케이프 코트", optionName: "차콜 / FREE", price: 128_000 },
  { sku: "SS-PUFF", name: "경량 패딩 베스트", optionName: "크림 / M", price: 79_000 },
  { sku: "SS-KNIT", name: "캐시미어 터틀넥 니트", optionName: "오트밀 / L", price: 64_000 },
  { sku: "SS-SNEAK", name: "데일리 스니커즈", optionName: "화이트 / 235", price: 89_000 },
  { sku: "SS-BOOT", name: "첼시 앵클 부츠", optionName: "브라운 / 240", price: 119_000 },
  { sku: "SS-BAG", name: "미니 크로스백", optionName: "블랙", price: 54_000 },
  { sku: "SS-CANDLE", name: "소이 캔들 200g", optionName: "우드윅", price: 21_900 },
  { sku: "SS-DIFF", name: "리드 디퓨저 100ml", optionName: "린넨", price: 18_900 },
  { sku: "SS-MUG", name: "무광 세라믹 머그", optionName: "350ml", price: 15_900 },
  { sku: "SS-TRAY", name: "아카시아 원목 트레이", optionName: "중", price: 24_900 },
  { sku: "SS-CUSHION", name: "소파 쿠션 커버", optionName: "세이지 / 45cm", price: 17_900 },
  { sku: "SS-BLANKET", name: "워시드 코튼 블랭킷", optionName: "베이지", price: 42_900 },
];

/** 채널별 주문 비중 — 스마트스토어가 가장 크고 쿠팡이 뒤따른다 */
const CHANNEL_MIX: { channel: MarketChannel; prefix: string; weight: number }[] = [
  { channel: "smartstore", prefix: "SS", weight: 42 },
  { channel: "coupang", prefix: "CP", weight: 30 },
  { channel: "elevenst", prefix: "EL", weight: 15 },
  { channel: "gmarket", prefix: "GM", weight: 13 },
];

function pickChannel(random: () => number): (typeof CHANNEL_MIX)[number] {
  const total = CHANNEL_MIX.reduce((sum, entry) => sum + entry.weight, 0);
  let ticket = random() * total;
  for (const entry of CHANNEL_MIX) {
    ticket -= entry.weight;
    if (ticket <= 0) return entry;
  }
  return CHANNEL_MIX[0] as (typeof CHANNEL_MIX)[number];
}

export interface WatchLedger {
  orders: WatchOrder[];
  records: SettlementRecord[];
  snapshotDate: string;
}

/**
 * 구매확정 원장과 마켓 정산 내역을 만든다.
 *
 * 구매확정일은 기준일 이전 40일 구간에 흩어 놓는다. 그래야 기한이 지난 건과 아직 기한 전인
 * 건이 함께 생기고, 한 화면에서 "위험·경고·대기"가 동시에 보인다.
 */
export function generateWatchLedger(options: { count?: number; seed?: number; snapshotDate?: string } = {}): WatchLedger {
  const count = Math.max(1, options.count ?? 140);
  const seed = options.seed ?? 20261121;
  const snapshotDate = options.snapshotDate ?? WATCH_SNAPSHOT_DATE;
  const random = createRandom(seed);
  const orders: WatchOrder[] = [];
  const records: SettlementRecord[] = [];

  for (let index = 0; index < count; index += 1) {
    const item = pick(random, CATALOG);
    const channelEntry = pickChannel(random);
    const confirmedAt = shiftDate(snapshotDate, -intBetween(random, 1, 40));
    const quantity = random() < 0.82 ? 1 : intBetween(random, 2, 3);
    const paidAmount = item.price * quantity;
    const orderNo = `${channelEntry.prefix}-${confirmedAt.replace(/-/g, "")}-${String(1000 + index)}`;

    orders.push({
      orderNo,
      channel: channelEntry.channel,
      productName: item.name,
      optionName: item.optionName,
      paidAmount,
      confirmedAt,
    });

    const preset = MARKET_PRESETS[channelEntry.channel];
    const dueDate = addBusinessDays(confirmedAt, preset ? preset.settlementDays : 3);
    const overdueDays = calendarDaysBetween(dueDate, snapshotDate);
    const expected = expectedSettlementAmount(paidAmount, channelEntry.channel);

    // 기한 전 주문은 "예정" 또는 내역 없음(대기)으로만 둔다.
    if (overdueDays <= 0) {
      if (random() < 0.62) {
        records.push({ orderNo, state: "scheduled", amount: expected });
      }
      continue;
    }

    const roll = random();
    if (roll < 0.7) {
      records.push({ orderNo, state: "paid", amount: expected, paidAt: dueDate });
      continue;
    }
    if (roll < 0.79) {
      const lateDays = Math.min(overdueDays, intBetween(random, 1, 4));
      records.push({
        orderNo,
        state: "paid",
        amount: expected,
        paidAt: shiftDate(dueDate, lateDays),
      });
      continue;
    }
    if (roll < 0.85) {
      const shortRate = intBetween(random, 25, 90) / 1000;
      records.push({
        orderNo,
        state: "paid",
        amount: Math.round(expected * (1 - shortRate)),
        paidAt: shiftDate(dueDate, Math.min(overdueDays, 1)),
      });
      continue;
    }
    if (roll < 0.93) {
      records.push({ orderNo, state: "scheduled", amount: expected });
      continue;
    }
    // roll >= 0.89 — 정산 내역 없음(누락 의심). 기한 경과 3일 이상이면 위험으로 판정된다.
  }

  return { orders, records, snapshotDate };
}

/** 화면이 쓰는 고정 원장 */
export const WATCH_LEDGER = generateWatchLedger();
