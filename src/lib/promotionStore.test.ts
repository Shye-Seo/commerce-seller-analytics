import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CAMPAIGN_SPEND,
  EMPTY_PROMOTION_SNAPSHOT,
  PROMOTION_SCHEMA_VERSION,
  PROMOTION_STORAGE_KEY,
  PromotionStore,
  type StorageLike,
} from "./promotionStore";
import type { CampaignSpec } from "./flashCouponEngine";

class MemoryStorage implements StorageLike {
  private map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const CAMPAIGN: CampaignSpec = {
  id: 1,
  tenantId: 1,
  code: "toss-drop-2026-11",
  name: "무신사 스탠다드 시크릿 드롭",
  type: "TOSS_STYLE_DROP",
  rewardBudget: 9_000_000,
  tokenBudget: 3_000,
  minGuaranteedMargin: 12,
  marginGuardMode: "block",
  startsAt: 0,
  endsAt: 1,
  status: "live",
  expectedPeakTps: 3_500,
};

describe("PromotionStore", () => {
  it("저장한 스냅숏을 같은 저장소에서 다시 읽는다", () => {
    const storage = new MemoryStorage();
    const store = new PromotionStore(storage);

    store.write({
      version: PROMOTION_SCHEMA_VERSION,
      updatedAt: 0,
      campaigns: [CAMPAIGN],
      templates: [],
      ledger: [],
      orders: [],
      campaignSpend: { 1: DEFAULT_CAMPAIGN_SPEND },
      simulation: null,
    });

    const reloaded = new PromotionStore(storage).read();
    expect(reloaded.campaigns).toHaveLength(1);
    expect(reloaded.campaignSpend[1]).toBe(DEFAULT_CAMPAIGN_SPEND);
    expect(storage.getItem(PROMOTION_STORAGE_KEY)).toContain("toss-drop-2026-11");
  });

  it("저장소가 비어 있으면 같은 빈 스냅숏 참조를 돌려준다(렌더 무한 루프 방지)", () => {
    const store = new PromotionStore(null);
    expect(store.read()).toBe(EMPTY_PROMOTION_SNAPSHOT);
    expect(store.read()).toBe(store.read());
  });

  it("스키마 버전이 다르면 옛 원장을 버린다", () => {
    const storage = new MemoryStorage();
    storage.setItem(PROMOTION_STORAGE_KEY, JSON.stringify({ version: 0, campaigns: [], templates: [], ledger: [], orders: [], campaignSpend: {} }));
    expect(new PromotionStore(storage).read()).toBe(EMPTY_PROMOTION_SNAPSHOT);
  });

  it("손상된 JSON을 만나도 예외를 던지지 않고 빈 스냅숏으로 시작한다", () => {
    const storage = new MemoryStorage();
    storage.setItem(PROMOTION_STORAGE_KEY, "{not-json");
    expect(new PromotionStore(storage).read()).toBe(EMPTY_PROMOTION_SNAPSHOT);
  });

  it("patch는 배열 필드를 통째로 교체하고 updatedAt을 갱신한다", () => {
    const store = new PromotionStore(new MemoryStorage());
    const first = store.write({
      version: PROMOTION_SCHEMA_VERSION,
      updatedAt: 0,
      campaigns: [CAMPAIGN],
      templates: [],
      ledger: [],
      orders: [],
      campaignSpend: {},
      simulation: null,
    });

    const patched = store.patch({ campaignSpend: { 1: 200_000 } });
    expect(patched.campaignSpend).toEqual({ 1: 200_000 });
    expect(patched.campaigns).toHaveLength(1);
    expect(patched.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });

  it("구독자는 쓰기·초기화 때 호출되고, 해지하면 더 이상 호출되지 않는다", () => {
    const store = new PromotionStore(new MemoryStorage());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.patch({ campaignSpend: { 1: 1 } });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.clear();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("저장 용량 예외가 나도 메모리 상태는 유지된다", () => {
    const failing: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
    };

    const store = new PromotionStore(failing);
    const written = store.write({
      version: PROMOTION_SCHEMA_VERSION,
      updatedAt: 0,
      campaigns: [CAMPAIGN],
      templates: [],
      ledger: [],
      orders: [],
      campaignSpend: {},
      simulation: null,
    });

    expect(written.campaigns).toHaveLength(1);
    expect(store.read().campaigns).toHaveLength(1);
  });

  it("원장 비우기는 저장소 키를 지운다", () => {
    const storage = new MemoryStorage();
    const store = new PromotionStore(storage);
    store.patch({ campaignSpend: { 1: 1 } });
    expect(storage.getItem(PROMOTION_STORAGE_KEY)).not.toBeNull();

    store.clear();
    expect(storage.getItem(PROMOTION_STORAGE_KEY)).toBeNull();
    expect(store.read().campaignSpend).toEqual({});
  });
});
