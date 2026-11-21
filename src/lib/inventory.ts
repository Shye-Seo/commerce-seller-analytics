/**
 * 품절 임박 & 발주량 계산기 (엔진)
 *
 * 셀러가 재고 화면에서 실제로 알고 싶은 것은 "재고가 몇 개 남았나"가 아니라
 * **"언제 끊기고, 오늘 얼마를 발주해야 하나"**다. 이 모듈은 최근 7일 판매 속도로
 * 그 두 값을 계산한다.
 *
 *   일평균 판매량 = 최근 7일 판매 합계 ÷ 7
 *   예상 품절일   = 오늘 + floor(가용 재고 ÷ 일평균)
 *   발주 마감일   = 안전재고에 닿는 날 - 리드타임(발주 후 입고까지 걸리는 날)
 *   권장 발주량   = (일평균 × (리드타임 + 안전재고일) - 가용 재고 - 입고 예정) → MOQ 배수 올림
 *
 * 판정 기준
 * ---------
 * 보호 구간 = 리드타임 + 안전재고일. 재고가 이 구간보다 오래 버티지 못하면 지금 발주해야 한다.
 * - 위험: 재고가 리드타임보다 짧다. 오늘 발주해도 입고 전에 끊긴다.
 * - 주의: 재고가 보호 구간보다 짧다. 안전재고를 깎아 먹기 전에 발주해야 한다.
 * - 안전: 보호 구간보다 여유가 있다.
 * - 판매 정체: 최근 7일 판매가 0이라 품절 위험이 아니라 반대로 재고가 묶여 있다.
 *
 * 7일 평균을 쓰는 이유
 * --------------------
 * 하루 판매량은 요일·광고 집행에 따라 2~3배씩 흔들린다. 하루치로 발주량을 정하면
 * 월요일 판매를 보고 주말 수요를 놓친다. 7일 평균은 요일 주기를 한 번 포함하므로
 * 발주 단위(보통 주 단위)와 맞는다. 대신 최근 3일 평균을 함께 보여 주어 추세를 읽게 한다.
 */

export type StockLevel = "critical" | "warning" | "healthy" | "stalled";

/** 발주 판단 대상 SKU (상품·옵션 단위) */
export interface StockSku {
  id: string;
  /** 상품명 */
  productName: string;
  /** 옵션명 */
  optionName: string;
  skuCode: string;
  /** 가용 재고(원) */
  onHand: number;
  /** 입고 예정 수량 */
  inbound: number;
  /** 입고 예정일(YYYY-MM-DD). 없으면 미정 */
  inboundDate?: string;
  /** 발주 후 입고까지 걸리는 날(리드타임) */
  leadTimeDays: number;
  /** 최소 발주 단위(MOA) — 이 배수로만 발주할 수 있다 */
  moq: number;
  /** 안전재고로 잡아 둘 판매일수 */
  safetyStockDays: number;
  /** 최근 7일 일별 판매량(과거 → 최근) */
  dailySales: number[];
  /** 발주 단가(원) */
  unitCost: number;
}

export interface InventoryLine {
  id: string;
  productName: string;
  optionName: string;
  skuCode: string;
  onHand: number;
  inbound: number;
  inboundDate: string | null;
  leadTimeDays: number;
  moq: number;
  safetyStockDays: number;
  dailySales: number[];
  unitCost: number;
  /** 최근 7일 일평균 판매량 */
  dailyAverage: number;
  /** 최근 3일 일평균 */
  recentAverage: number;
  /** 최근 3일이 7일 평균보다 몇 % 빠른지(음수면 둔화) */
  trendRate: number | null;
  /** 안전재고 수량 */
  safetyStock: number;
  /** 재고가 0이 되는 데 걸리는 날 */
  daysOfCover: number;
  /** 예상 품절일(YYYY-MM-DD). 판매가 없으면 null */
  stockoutDate: string | null;
  /** 발주 마감일(YYYY-MM-DD) */
  orderByDate: string | null;
  /** 발주 마감까지 남은 날. 음수면 이미 지났다 */
  orderByInDays: number | null;
  /** 권장 발주 수량(MOQ 배수) */
  recommendedQty: number;
  /** 권장 발주 금액(원) */
  orderValue: number;
  level: StockLevel;
  /** 판정 근거 한 줄 */
  reason: string;
}

export interface InventoryResult {
  snapshotDate: string;
  lines: InventoryLine[];
  counts: { total: number; critical: number; warning: number; healthy: number; stalled: number };
  totalRecommendedQty: number;
  totalOrderValue: number;
  /** 가장 급한 발주 마감일 */
  nextDeadline: string | null;
  /** 가장 빨리 끊기는 SKU */
  soonestStockout: { skuCode: string; productName: string; optionName: string; date: string } | null;
  assumptions: string[];
}

/** 기준일 — 빌드마다 값이 달라지지 않도록 고정한다. */
export const INVENTORY_SNAPSHOT_DATE = "2026-11-21";

const DAY_MS = 24 * 60 * 60 * 1000;

function safeAmount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.round((end - start) / DAY_MS);
}

function monthDay(date: string): string {
  return date.slice(5).replace("-", "/");
}

/** 판매 이력의 일평균. 이력이 비어 있으면 0 */
export function dailyAverageOf(dailySales: readonly number[], days = 7): number {
  const window = dailySales.slice(-days).map(safeAmount);
  if (window.length === 0) return 0;
  return window.reduce((sum, value) => sum + value, 0) / window.length;
}

/** 최근 n일 평균 */
export function recentAverageOf(dailySales: readonly number[], days = 3): number {
  const window = dailySales.slice(-days).map(safeAmount);
  if (window.length === 0) return 0;
  return window.reduce((sum, value) => sum + value, 0) / window.length;
}

/**
 * SKU 한 건의 발주 계획을 계산한다.
 * 판매 이력이 비어 있거나 0이면 품절 위험이 아니라 "판매 정체"로 판정한다.
 */
export function planInventoryLine(sku: StockSku, snapshotDate = INVENTORY_SNAPSHOT_DATE): InventoryLine {
  const dailySales = sku.dailySales.map(safeAmount);
  const dailyAverage = dailyAverageOf(dailySales);
  const recentAverage = recentAverageOf(dailySales);
  const trendRate =
    dailyAverage > 0 ? ((recentAverage - dailyAverage) / dailyAverage) * 100 : null;

  const leadTimeDays = Math.max(0, Math.round(safeAmount(sku.leadTimeDays)));
  const safetyStockDays = Math.max(0, Math.round(safeAmount(sku.safetyStockDays)));
  const moq = Math.max(1, Math.round(safeAmount(sku.moq) || 1));
  const onHand = Math.round(safeAmount(sku.onHand));
  const inbound = Math.round(safeAmount(sku.inbound));
  const safetyStock = Math.ceil(dailyAverage * safetyStockDays);

  const base: Omit<
    InventoryLine,
    | "daysOfCover"
    | "stockoutDate"
    | "orderByDate"
    | "orderByInDays"
    | "recommendedQty"
    | "orderValue"
    | "level"
    | "reason"
  > = {
    id: sku.id,
    productName: sku.productName,
    optionName: sku.optionName,
    skuCode: sku.skuCode,
    onHand,
    inbound,
    inboundDate: sku.inboundDate ?? null,
    leadTimeDays,
    moq,
    safetyStockDays,
    dailySales,
    unitCost: Math.round(safeAmount(sku.unitCost)),
    dailyAverage,
    recentAverage,
    trendRate,
    safetyStock,
  };

  if (dailyAverage <= 0) {
    return {
      ...base,
      daysOfCover: Number.POSITIVE_INFINITY,
      stockoutDate: null,
      orderByDate: null,
      orderByInDays: null,
      recommendedQty: 0,
      orderValue: 0,
      level: "stalled",
      reason: "최근 7일 판매가 없어 발주 대상이 아닙니다(재고 정리 검토).",
    };
  }

  const daysOfCover = onHand / dailyAverage;
  const stockoutInDays = Math.floor(daysOfCover);
  const stockoutDate = shiftDate(snapshotDate, stockoutInDays);

  // 보호 구간 = 리드타임 + 안전재고일. 재고가 이 구간보다 오래 버티지 못하면 지금 발주해야 한다.
  const protectionDays = leadTimeDays + safetyStockDays;
  const orderByInDays = Math.floor(daysOfCover - protectionDays);
  const orderByDate = shiftDate(snapshotDate, orderByInDays);

  // 입고 예정이 품절 전에 도착하면 권장 발주량에서 뺀다(이미 발주한 물량).
  const inboundArrivesInTime =
    inbound > 0 && (!sku.inboundDate || daysBetween(snapshotDate, sku.inboundDate) <= stockoutInDays);
  const inboundApplied = inboundArrivesInTime ? inbound : 0;

  const targetStock = Math.ceil(dailyAverage * protectionDays);
  const shortage = targetStock - onHand - inboundApplied;
  const recommendedQty = shortage > 0 ? Math.ceil(shortage / moq) * moq : 0;
  const orderValue = recommendedQty * base.unitCost;

  const level: StockLevel =
    daysOfCover <= leadTimeDays
      ? "critical"
      : daysOfCover <= protectionDays
        ? "warning"
        : "healthy";

  const reason =
    level === "critical"
      ? recommendedQty > 0
        ? `리드타임 ${leadTimeDays}일 안에 품절됩니다 · 지금 발주해도 ${formatDays(stockoutInDays)} 뒤 끊김`
        : `리드타임(${leadTimeDays}일)보다 재고가 짧습니다 · 입고 예정 물량으로 충당`
      : level === "warning"
        ? `${orderByInDays < 0 ? `발주 마감이 ${Math.abs(orderByInDays)}일 지났습니다` : "발주 마감이 임박했습니다"} · ${formatDays(stockoutInDays)} 뒤 품절`
        : `재고 여유 ${formatDays(stockoutInDays)} · 발주 마감 ${monthDay(orderByDate)}`;

  return {
    ...base,
    daysOfCover,
    stockoutDate,
    orderByDate,
    orderByInDays,
    recommendedQty,
    orderValue,
    level,
    reason,
  };
}

function formatDays(days: number): string {
  if (!Number.isFinite(days)) return "—";
  return days >= 1 ? `${Math.round(days)}일` : "오늘";
}

const LEVEL_WEIGHT: Record<StockLevel, number> = { critical: 0, warning: 1, healthy: 2, stalled: 3 };

export function computeInventoryPlan(
  skus: readonly StockSku[],
  snapshotDate = INVENTORY_SNAPSHOT_DATE,
): InventoryResult {
  const lines = skus
    .map((sku) => planInventoryLine(sku, snapshotDate))
    .sort(
      (a, b) =>
        LEVEL_WEIGHT[a.level] - LEVEL_WEIGHT[b.level] ||
        (a.orderByInDays ?? Number.POSITIVE_INFINITY) - (b.orderByInDays ?? Number.POSITIVE_INFINITY) ||
        b.orderValue - a.orderValue,
    );

  const counts = { total: lines.length, critical: 0, warning: 0, healthy: 0, stalled: 0 };
  for (const line of lines) counts[line.level] += 1;

  const orderLines = lines.filter((line) => line.recommendedQty > 0);
  const totalRecommendedQty = orderLines.reduce((sum, line) => sum + line.recommendedQty, 0);
  const totalOrderValue = orderLines.reduce((sum, line) => sum + line.orderValue, 0);

  const deadlines = orderLines
    .map((line) => line.orderByDate)
    .filter((date): date is string => Boolean(date))
    .sort();
  const nextDeadline = deadlines[0] ?? null;

  const soonest = lines
    .filter((line) => line.stockoutDate !== null && line.dailyAverage > 0)
    .sort((a, b) => (a.daysOfCover ?? 0) - (b.daysOfCover ?? 0))[0];

  return {
    snapshotDate,
    lines,
    counts,
    totalRecommendedQty,
    totalOrderValue,
    nextDeadline,
    soonestStockout: soonest
      ? {
          skuCode: soonest.skuCode,
          productName: soonest.productName,
          optionName: soonest.optionName,
          date: soonest.stockoutDate as string,
        }
      : null,
    assumptions: [
      "판매 속도는 최근 7일 일평균이며, 프로모션·시즌 수요가 급변하면 실제와 달라질 수 있습니다.",
      "발주 마감일은 안전재고에 닿는 날에서 리드타임을 뺀 날입니다(오늘 발주해도 입고 전에 끊기면 위험).",
      "입고 예정 수량은 품절일 전에 도착하는 경우에만 권장 발주량에서 차감합니다.",
      "권장 발주량은 최소 발주 단위(MOQ) 배수로 올림합니다.",
    ],
  };
}

/** 필터: 위험/주의/전체 */
export type InventoryFilter = "attention" | "critical" | "warning" | "all";

export function filterInventoryLines(
  lines: readonly InventoryLine[],
  filter: InventoryFilter,
): InventoryLine[] {
  if (filter === "all") return [...lines];
  if (filter === "critical") return lines.filter((line) => line.level === "critical");
  if (filter === "warning") return lines.filter((line) => line.level === "warning");
  return lines.filter((line) => line.level === "critical" || line.level === "warning");
}

/** 발주서 CSV — 실제 발주 담당자에게 넘기는 형식 그대로 만든다. */
export function buildPurchaseOrderCsv(lines: readonly InventoryLine[]): string {
  const header = ["SKU", "상품명", "옵션", "권장 발주 수량", "발주 단가", "발주 금액", "발주 마감일", "예상 품절일"];
  const rows = lines
    .filter((line) => line.recommendedQty > 0)
    .map((line) => [
      line.skuCode,
      line.productName,
      line.optionName,
      String(line.recommendedQty),
      String(line.unitCost),
      String(line.orderValue),
      line.orderByDate ?? "",
      line.stockoutDate ?? "",
    ]);
  return [header, ...rows]
    .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
    .join("\n");
}

/** 알림 문구 — 위험 SKU와 오늘 발주할 수량만 먼저 보낸다. */
export function composeReorderNotice(
  result: InventoryResult,
  tenantName = "셀러스코프",
): string {
  const urgent = result.lines.filter(
    (line) => line.level === "critical" && line.recommendedQty > 0,
  );
  if (urgent.length === 0) {
    return `[${tenantName}] 발주 점검\n기준일 ${monthDay(result.snapshotDate)} · 오늘 발주할 SKU가 없습니다.\n총 ${result.counts.total}개 SKU 정상 범위입니다.`;
  }
  const preview = urgent
    .slice(0, 3)
    .map((line) => `· ${line.productName} ${line.optionName} ${line.recommendedQty}개`)
    .join("\n");
  return [
    `[${tenantName}] 품절 임박 ${urgent.length}건`,
    `기준일 ${monthDay(result.snapshotDate)} · 오늘 발주 필요`,
    preview,
    urgent.length > 3 ? `외 ${urgent.length - 3}건` : "",
    `합계 ${result.totalRecommendedQty.toLocaleString("ko-KR")}개 · ${result.totalOrderValue.toLocaleString("ko-KR")}원`,
  ]
    .filter(Boolean)
    .join("\n");
}
