import { describe, expect, it } from "vitest";
import {
  INVENTORY_SNAPSHOT_DATE,
  buildPurchaseOrderCsv,
  composeReorderNotice,
  computeInventoryPlan,
  dailyAverageOf,
  filterInventoryLines,
  planInventoryLine,
  recentAverageOf,
  type StockSku,
} from "./inventory";
import { INVENTORY_PLAN, STOCK_SKUS } from "./inventoryData";

function sku(overrides: Partial<StockSku> = {}): StockSku {
  return {
    id: "sku-1",
    productName: "울 블렌드 케이프 코트",
    optionName: "차콜 / FREE",
    skuCode: "OW-COAT-CH-F",
    onHand: 14,
    inbound: 0,
    leadTimeDays: 12,
    moq: 5,
    safetyStockDays: 10,
    dailySales: [3, 4, 2, 4, 3, 4, 4],
    unitCost: 54_000,
    ...overrides,
  };
}

describe("판매 속도", () => {
  it("7일 평균은 이력이 짧으면 있는 날짜로 나눈다", () => {
    expect(dailyAverageOf([2, 2, 2, 2, 2, 2, 2])).toBe(2);
    expect(dailyAverageOf([4, 4])).toBe(4);
    expect(dailyAverageOf([])).toBe(0);
    // 음수·NaN은 0으로 보정한다.
    expect(dailyAverageOf([-3, Number.NaN, 7])).toBeCloseTo(7 / 3, 5);
  });

  it("최근 3일 평균과 추세를 함께 구한다", () => {
    expect(recentAverageOf([1, 1, 1, 5, 5, 5])).toBe(5);
    const line = planInventoryLine(sku({ dailySales: [1, 1, 1, 1, 5, 5, 5] }));
    expect(line.trendRate).not.toBeNull();
    expect(line.trendRate as number).toBeGreaterThan(0);
  });
});

describe("품절일과 발주량", () => {
  it("재고를 일평균으로 나눠 품절일을 구한다", () => {
    const line = planInventoryLine(sku({ onHand: 14, dailySales: [2, 2, 2, 2, 2, 2, 2] }));
    expect(line.dailyAverage).toBe(2);
    expect(line.daysOfCover).toBe(7);
    // 2026-11-21 + 7일
    expect(line.stockoutDate).toBe("2026-11-28");
    expect(line.safetyStock).toBe(20);
    expect(line.level).toBe("critical");
  });

  it("권장 발주량은 리드타임+안전재고 수요에서 재고를 빼고 MOQ 배수로 올린다", () => {
    const line = planInventoryLine(sku({ onHand: 14, leadTimeDays: 12, safetyStockDays: 10, moq: 5 }));
    // 일평균 3.43 × 22일 = 75.4 → 76, 76 - 14 = 62 → 5의 배수 65
    expect(line.recommendedQty).toBe(65);
    expect(line.orderValue).toBe(65 * 54_000);
    expect(line.recommendedQty % 5).toBe(0);
  });

  it("입고 예정 물량이 품절 전에 오면 발주량에서 차감한다", () => {
    const withoutInbound = planInventoryLine(sku({ onHand: 20, inbound: 30, inboundDate: "2026-12-20" }));
    const withInbound = planInventoryLine(sku({ onHand: 20, inbound: 30, inboundDate: "2026-11-24" }));
    // 품절일(11/21 + 5일 = 11/26) 전에 도착하므로 차감된다.
    expect(withInbound.recommendedQty).toBeLessThan(withoutInbound.recommendedQty);
    expect(withInbound.inbound).toBe(30);
  });

  it("입고 예정만으로 충분하면 발주량은 0이다", () => {
    const line = planInventoryLine(
      sku({ onHand: 30, inbound: 60, inboundDate: "2026-11-24", leadTimeDays: 7, safetyStockDays: 5 }),
    );
    expect(line.recommendedQty).toBe(0);
    expect(line.orderValue).toBe(0);
    expect(line.level).toBe("warning");
    expect(line.reason).toContain("지났");
  });

  it("재고가 보호 구간보다 많으면 안전이고 발주량은 0이다", () => {
    const line = planInventoryLine(sku({ onHand: 200 }));
    expect(line.level).toBe("healthy");
    expect(line.recommendedQty).toBe(0);
    expect(line.orderByInDays as number).toBeGreaterThan(0);
  });

  it("판매가 0이면 품절 대신 판매 정체로 분류한다", () => {
    const line = planInventoryLine(sku({ dailySales: [0, 0, 0, 0, 0, 0, 0], onHand: 180 }));
    expect(line.level).toBe("stalled");
    expect(line.daysOfCover).toBe(Number.POSITIVE_INFINITY);
    expect(line.stockoutDate).toBeNull();
    expect(line.recommendedQty).toBe(0);
    expect(line.trendRate).toBeNull();
  });

  it("리드타임이 0이면 보호 구간이 없어 계산이 깨지지 않는다", () => {
    const line = planInventoryLine(sku({ leadTimeDays: 0, safetyStockDays: 0, onHand: 5 }));
    // 보호 구간이 0일이면 재고가 오늘 끊기지 않는 한 발주 대상이 아니다(판정 기준과 일관).
    expect(line.level).toBe("healthy");
    expect(Number.isFinite(line.orderByInDays as number)).toBe(true);
  });
});

describe("전체 계획", () => {
  it("SKU를 위험 → 주의 → 안전 → 정체 순서로 정렬한다", () => {
    const plans = computeInventoryPlan(STOCK_SKUS);
    const weights = plans.lines.map((line) =>
      line.level === "critical" ? 0 : line.level === "warning" ? 1 : line.level === "healthy" ? 2 : 3,
    );
    expect([...weights].sort((a, b) => a - b)).toEqual(weights);
  });

  it("발주 필요 수량과 금액을 합산하고 가장 급한 마감일을 낸다", () => {
    expect(INVENTORY_PLAN.counts.total).toBe(14);
    expect(INVENTORY_PLAN.counts.critical).toBe(3);
    expect(INVENTORY_PLAN.counts.warning).toBe(3);
    expect(INVENTORY_PLAN.counts.stalled).toBe(1);

    const orderLines = INVENTORY_PLAN.lines.filter((line) => line.recommendedQty > 0);
    expect(INVENTORY_PLAN.totalRecommendedQty).toBe(
      orderLines.reduce((sum, line) => sum + line.recommendedQty, 0),
    );
    expect(INVENTORY_PLAN.totalOrderValue).toBe(
      orderLines.reduce((sum, line) => sum + line.orderValue, 0),
    );
    expect(INVENTORY_PLAN.nextDeadline).not.toBeNull();
    expect(INVENTORY_PLAN.soonestStockout?.skuCode).toBe("OW-VEST-CR-M");
  });

  it("필터는 위험/주의/전체를 구분한다", () => {
    const lines = INVENTORY_PLAN.lines;
    expect(filterInventoryLines(lines, "critical")).toHaveLength(INVENTORY_PLAN.counts.critical);
    expect(filterInventoryLines(lines, "warning")).toHaveLength(INVENTORY_PLAN.counts.warning);
    expect(filterInventoryLines(lines, "attention")).toHaveLength(
      INVENTORY_PLAN.counts.critical + INVENTORY_PLAN.counts.warning,
    );
    expect(filterInventoryLines(lines, "all")).toHaveLength(lines.length);
  });

  it("기준일을 바꾸면 품절일·마감일이 함께 이동한다", () => {
    const later = computeInventoryPlan(STOCK_SKUS, "2026-11-28");
    const first = INVENTORY_PLAN.lines.find((line) => line.skuCode === "OW-COAT-CH-F");
    const shifted = later.lines.find((line) => line.skuCode === "OW-COAT-CH-F");
    expect(shifted?.stockoutDate).not.toBe(first?.stockoutDate);
    expect(shifted?.daysOfCover).toBe(first?.daysOfCover);
    expect(later.counts.critical).toBe(INVENTORY_PLAN.counts.critical);
  });
});

describe("발주서와 알림", () => {
  it("CSV에는 발주 대상만 들어가고 금액이 원 단위로 남는다", () => {
    const csv = buildPurchaseOrderCsv(INVENTORY_PLAN.lines);
    const rows = csv.split("\n");
    const orderLines = INVENTORY_PLAN.lines.filter((line) => line.recommendedQty > 0);
    expect(rows).toHaveLength(orderLines.length + 1);
    expect(rows[0]).toContain('"SKU"');
    expect(csv).toContain('"OW-COAT-CH-F"');
    expect(csv).not.toContain('"SG-STOR-L-GY"');
    // 판매 정체 SKU는 발주서에 들어가지 않는다.
    expect(csv).not.toContain('"SG-PEN3-05"');
  });

  it("알림은 위험 SKU의 발주 수량을 먼저 적는다", () => {
    const notice = composeReorderNotice(INVENTORY_PLAN);
    expect(notice).toContain("품절 임박 3건");
    expect(notice).toContain("울 블렌드 케이프 코트");
    expect(notice).toContain("65개");

    const calm = computeInventoryPlan([
      {
        ...STOCK_SKUS[4],
        id: "calm",
        onHand: 500,
      },
    ]);
    expect(composeReorderNotice(calm)).toContain("오늘 발주할 SKU가 없습니다");
  });

  it("기준일은 고정 상수로 유지된다", () => {
    expect(INVENTORY_PLAN.snapshotDate).toBe(INVENTORY_SNAPSHOT_DATE);
  });
});
