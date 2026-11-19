import { describe, expect, it } from "vitest";
import { ANOMALY_META, type AnomalyCode, type ReconciliationSummary } from "./reconciliationEngine";
import {
  HISTORY_MAX_MONTHS_PER_TENANT,
  HISTORY_SCHEMA_VERSION,
  HISTORY_STORAGE_KEY,
  createMemoryStorage,
  createSnapshot,
  findPreviousSnapshot,
  normalizeSnapshotSummary,
  parseHistory,
  readHistory,
  removeSnapshot,
  resolveStorage,
  saveSnapshot,
  saveSnapshots,
  serializeHistory,
  snapshotsForTenant,
  upsertSnapshot,
  type HistoryStorage,
  type SettlementMonthSnapshot,
} from "./settlementHistory";

function causeRecord(value: Partial<Record<AnomalyCode, number>> = {}): Record<AnomalyCode, number> {
  const record = {} as Record<AnomalyCode, number>;
  for (const code of Object.keys(ANOMALY_META) as AnomalyCode[]) record[code] = value[code] ?? 0;
  return record;
}

function summary(overrides: Partial<ReconciliationSummary> = {}): ReconciliationSummary {
  return {
    totalRows: 1_000,
    matchedRows: 826,
    flaggedRows: 174,
    matchedRate: 82.6,
    totalPaidAmount: 10_000_000,
    totalCommission: 500_000,
    totalSettledAmount: 9_000_000,
    expectedSettlement: 9_050_000,
    totalLeak: 50_000,
    totalSurplus: 0,
    marginRiskExposure: 120_000,
    negativeMarginRows: 12,
    worstMarginRate: -3.4,
    anomalyCounts: causeRecord({ FEE_OVERCHARGE: 40 }),
    anomalyLoss: causeRecord({ FEE_OVERCHARGE: 30_000, RETURN_FEE_DOUBLE_CHARGED: 20_000 }),
    byChannel: [
      { channel: "smartstore", rows: 600, paidAmount: 6_000_000, settledAmount: 5_400_000, leak: 30_000, flaggedRows: 100 },
      { channel: "coupang", rows: 400, paidAmount: 4_000_000, settledAmount: 3_600_000, leak: 20_000, flaggedRows: 74 },
    ],
    topSkusByLoss: [{ sku: "SKU-9", productName: "테스트", rows: 2, loss: 9_000 }],
    ...overrides,
  };
}

function snapshot(month: string, tenantId = "tn-hq", savedAt = "2026-11-19T09:00:00.000Z") {
  return createSnapshot({ tenantId, month, summary: summary(), source: "generated", savedAt });
}

describe("스냅숏 생성", () => {
  it("필요한 값만 추리고 출처·저장 시각을 남긴다", () => {
    const created = createSnapshot({
      tenantId: "tn-hq",
      month: "2026-11",
      summary: summary(),
      source: "upload",
      label: "11월 정산서.csv",
      savedAt: "2026-11-19T09:00:00.000Z",
    });
    expect(created.version).toBe(HISTORY_SCHEMA_VERSION);
    expect(created.source).toBe("upload");
    expect(created.label).toBe("11월 정산서.csv");
    expect(created.savedAt).toBe("2026-11-19T09:00:00.000Z");
    expect(created.summary.totalLeak).toBe(50_000);
    expect(Object.keys(created.summary)).not.toContain("topSkusByLoss");
  });

  it("잘못된 월은 만들지 않는다", () => {
    expect(() => createSnapshot({ tenantId: "tn-hq", month: "2026-13", summary: summary() })).toThrow(RangeError);
    expect(() => createSnapshot({ tenantId: "tn-hq", month: "26-11", summary: summary() })).toThrow(RangeError);
  });
});

describe("직렬화와 복원", () => {
  it("저장 → 읽기가 같은 값을 돌려준다", () => {
    const list = [snapshot("2026-11"), snapshot("2026-10")];
    const restored = parseHistory(serializeHistory(list));
    expect(restored).toHaveLength(2);
    expect(restored[0]?.month).toBe("2026-11");
    expect(restored.map((entry) => entry.month)).toEqual(["2026-11", "2026-10"]);
  });

  it("깨진 JSON은 빈 이력이 된다(화면이 죽지 않는다)", () => {
    expect(parseHistory("{not json")).toEqual([]);
    expect(parseHistory(null)).toEqual([]);
    expect(parseHistory("")).toEqual([]);
  });

  it("버전이 다르거나 형식이 어긋난 레코드는 버리고 나머지는 살린다", () => {
    const good = snapshot("2026-10");
    const raw = JSON.stringify({
      version: HISTORY_SCHEMA_VERSION,
      snapshots: [
        good,
        { ...good, month: "2026-09", version: 99 },
        { ...good, month: "2026-08", summary: { byChannel: "nope" } },
        { ...good, month: "2026-07", savedAt: "언젠가" },
        { ...good, month: "13월" },
      ],
    });
    const restored = parseHistory(raw);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.month).toBe("2026-10");
  });

  it("array 형태와 {snapshots} 형태를 모두 받는다", () => {
    const list = [snapshot("2026-10")];
    expect(parseHistory(JSON.stringify(list))).toHaveLength(1);
    expect(parseHistory(JSON.stringify({ snapshots: list }))).toHaveLength(1);
  });

  it("같은 테넌트·같은 달이 중복 저장돼 있으면 하나만 남긴다", () => {
    const raw = JSON.stringify({
      version: HISTORY_SCHEMA_VERSION,
      snapshots: [snapshot("2026-11", "tn-hq", "2026-11-19T09:00:00.000Z"), snapshot("2026-11", "tn-hq", "2026-11-20T09:00:00.000Z")],
    });
    expect(parseHistory(raw)).toHaveLength(1);
  });

  it("숫자가 아닌 필드는 0으로 정규화하고, 요약 형식이 아니면 null을 준다", () => {
    const normalized = normalizeSnapshotSummary({
      totalRows: "1000",
      totalLeak: Number.NaN,
      matchedRate: "82.6",
      anomalyLoss: { FEE_OVERCHARGE: "30000" },
      anomalyCounts: {},
      byChannel: [{ channel: "smartstore", rows: 10, leak: 1 }, { channel: "없는채널" }],
    });
    expect(normalized?.totalRows).toBe(0);
    expect(normalized?.totalLeak).toBe(0);
    expect(normalized?.matchedRate).toBe(0);
    expect(normalized?.anomalyLoss.FEE_OVERCHARGE).toBe(0);
    expect(normalized?.byChannel.map((entry) => entry.channel)).toEqual(["smartstore"]);
    expect(normalizeSnapshotSummary(null)).toBeNull();
    expect(normalizeSnapshotSummary({ byChannel: [] })).toBeNull();
  });
});

describe("이력 목록 관리", () => {
  it("같은 테넌트·같은 달은 덮어쓰고 레코드는 늘지 않는다", () => {
    const first = upsertSnapshot([], snapshot("2026-11", "tn-hq", "2026-11-19T09:00:00.000Z"));
    expect(first.replaced).toBe(false);
    const second = upsertSnapshot(first.snapshots, snapshot("2026-11", "tn-hq", "2026-11-21T09:00:00.000Z"));
    expect(second.replaced).toBe(true);
    expect(second.snapshots).toHaveLength(1);
    expect(second.snapshots[0]?.savedAt).toBe("2026-11-21T09:00:00.000Z");
  });

  it("다른 테넌트의 같은 달은 별도로 남는다", () => {
    let list: SettlementMonthSnapshot[] = [];
    list = upsertSnapshot(list, snapshot("2026-11", "tn-hq")).snapshots;
    list = upsertSnapshot(list, snapshot("2026-11", "tn-busan")).snapshots;
    expect(list).toHaveLength(2);
    expect(snapshotsForTenant(list, "tn-hq")).toHaveLength(1);
  });

  it("최신 달이 먼저 오도록 정렬한다", () => {
    let list: SettlementMonthSnapshot[] = [];
    for (const month of ["2026-09", "2026-11", "2026-10"]) {
      list = upsertSnapshot(list, snapshot(month)).snapshots;
    }
    expect(list.map((entry) => entry.month)).toEqual(["2026-11", "2026-10", "2026-09"]);
  });

  it("테넌트당 24개월을 넘으면 오래된 달을 버린다", () => {
    let list: SettlementMonthSnapshot[] = [];
    for (let offset = 0; offset < HISTORY_MAX_MONTHS_PER_TENANT + 5; offset += 1) {
      const month = new Date(2026, 11 - offset, 1);
      const key = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;
      list = upsertSnapshot(list, snapshot(key)).snapshots;
    }
    expect(list).toHaveLength(HISTORY_MAX_MONTHS_PER_TENANT);
  });

  it("해당 월보다 앞선 가장 가까운 달을 고른다", () => {
    const list = [snapshot("2026-09"), snapshot("2026-10"), snapshot("2026-11")];
    expect(findPreviousSnapshot(list, "tn-hq", "2026-11")?.month).toBe("2026-10");
    expect(findPreviousSnapshot(list, "tn-hq", "2026-09")).toBeNull();
    expect(findPreviousSnapshot(list, "tn-busan", "2026-11")).toBeNull();
  });

  it("레코드 삭제는 해당 테넌트·달만 지운다", () => {
    const list = [snapshot("2026-10"), snapshot("2026-11"), snapshot("2026-11", "tn-busan")];
    const next = removeSnapshot(list, "tn-hq", "2026-11");
    expect(next.map((entry) => `${entry.tenantId}:${entry.month}`)).toEqual(["tn-hq:2026-10", "tn-busan:2026-11"]);
  });
});

describe("저장소", () => {
  it("저장소가 없으면 읽기는 빈 배열, 쓰기는 실패로 돌려준다", () => {
    expect(readHistory(null)).toEqual([]);
    const outcome = saveSnapshot(snapshot("2026-11"), null);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("unavailable");
  });

  it("저장한 이력을 다시 읽는다", () => {
    const storage = createMemoryStorage();
    const outcome = saveSnapshot(snapshot("2026-10"), storage);
    expect(outcome.ok).toBe(true);
    const restored = readHistory(storage);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.month).toBe("2026-10");
  });

  it("용량 초과로 실패해도 기존 이력을 잃지 않는다", () => {
    const base = createMemoryStorage();
    saveSnapshot(snapshot("2026-10"), base);
    const failing: HistoryStorage = {
      getItem: (key) => base.getItem(key),
      setItem: () => {
        const error = new Error("The quota has been exceeded.");
        error.name = "QuotaExceededError";
        throw error;
      },
    };
    const outcome = saveSnapshot(snapshot("2026-11"), failing);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("quota");
      expect(outcome.snapshots.map((entry) => entry.month)).toEqual(["2026-10"]);
    }
    expect(readHistory(base)[0]?.month).toBe("2026-10");
  });

  it("여러 달을 한 번에 저장하고, 같은 달은 덮어쓴다", () => {
    const storage = createMemoryStorage();
    saveSnapshots([snapshot("2026-09"), snapshot("2026-10")], storage);
    const second = saveSnapshots([snapshot("2026-10", "tn-hq", "2026-11-22T00:00:00.000Z"), snapshot("2026-11")], storage);
    expect(second.ok).toBe(true);
    const stored = readHistory(storage);
    expect(stored.map((entry) => entry.month)).toEqual(["2026-11", "2026-10", "2026-09"]);
    expect(stored.find((entry) => entry.month === "2026-10")?.savedAt).toBe("2026-11-22T00:00:00.000Z");
  });

  it("저장 키는 버전이 붙은 한 곳만 쓴다", () => {
    const storage = createMemoryStorage();
    saveSnapshot(snapshot("2026-11"), storage);
    expect(Object.keys(storage.dump())).toEqual([HISTORY_STORAGE_KEY]);
  });

  it("서버(SSR)에서는 저장소를 만들지 않는다", () => {
    expect(resolveStorage()).toBeNull();
  });
});
