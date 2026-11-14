/**
 * 쿠폰 캠페인 공유 스토어 (Promotion Store)
 *
 * 선착순 쿠폰 콘솔(`/flash`)에서 발급한 원장과 주문 연결 결과를 정산 대사 콘솔(`/reconciliation`),
 * 메인 대시보드가 **같은 값으로** 본다. 서버 세션 없이 페이지 사이에서 상태를 공유하려면
 * 브라우저 저장소가 필요하고, 저장소는 "사용자 데이터"가 아니라 이 데모의 원장이므로
 * localStorage 한 곳에 버전을 붙여 보관한다.
 *
 * 설계 원칙
 * ---------
 * - **버전이 다르면 버린다.** 스키마가 바뀐 뒤 남은 옛 원장을 읽으면 화면이 조용히 틀린 숫자를
 *   보여 준다. `version`이 다르면 빈 스냅숏을 돌려주고, 저장할 때 새 버전으로 덮어쓴다.
 * - **읽기는 항상 같은 객체를 돌려준다.** `useSyncExternalStore`는 스냅숏의 참조 동일성을
 *   비교하므로, 변경이 없을 때 매번 새 객체를 만들면 무한 렌더가 된다. 스토어가 캐시를 들고
 *   있다가 쓰기·외부 탭 변경 때만 무효화한다.
 * - **저장소가 없어도 동작한다.** Safari 프라이빗 모드나 SSR에서는 localStorage 접근이 예외를
 *   던진다. 그때는 메모리 상태로만 동작하고(새로 고치면 사라짐), 화면은 그대로 뜬다.
 * - **개인정보를 저장하지 않는다.** 원장에는 해시·마스킹 코드만 있고 쿠폰 원문은 없다.
 */

import { useSyncExternalStore } from "react";
import type { CampaignSpec, CouponTemplateSpec, LedgerEntry } from "./flashCouponEngine";
import type { MarketingOrder } from "./campaignBridge";

export const PROMOTION_STORAGE_KEY = "sellerscope.promotions.v1";
export const PROMOTION_SCHEMA_VERSION = 1;

export interface SimulationSummary {
  presetId: string;
  presetLabel: string;
  requests: number;
  issued: number;
  soldOut: number;
  duplicate: number;
  abuseBlocked: number;
  oversell: number;
  tps: number;
  elapsedMs: number;
  ranAt: number;
}

export interface PromotionSnapshot {
  version: number;
  updatedAt: number;
  campaigns: CampaignSpec[];
  templates: CouponTemplateSpec[];
  ledger: LedgerEntry[];
  orders: MarketingOrder[];
  /** 캠페인별 집행 광고비(원) — ROAS 분모 */
  campaignSpend: Record<number, number>;
  simulation: SimulationSummary | null;
}

export const EMPTY_PROMOTION_SNAPSHOT: PromotionSnapshot = Object.freeze({
  version: PROMOTION_SCHEMA_VERSION,
  updatedAt: 0,
  campaigns: Object.freeze([]) as unknown as CampaignSpec[],
  templates: Object.freeze([]) as unknown as CouponTemplateSpec[],
  ledger: Object.freeze([]) as unknown as LedgerEntry[],
  orders: Object.freeze([]) as unknown as MarketingOrder[],
  campaignSpend: Object.freeze({}) as Record<number, number>,
  simulation: null,
});

/** localStorage와 같은 최소 인터페이스. 테스트에서는 메모리 구현을 넣는다. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function isSnapshot(value: unknown): value is PromotionSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PromotionSnapshot>;
  return (
    candidate.version === PROMOTION_SCHEMA_VERSION &&
    Array.isArray(candidate.campaigns) &&
    Array.isArray(candidate.templates) &&
    Array.isArray(candidate.ledger) &&
    Array.isArray(candidate.orders) &&
    typeof candidate.campaignSpend === "object" &&
    candidate.campaignSpend !== null
  );
}

export class PromotionStore {
  private cache: PromotionSnapshot | null = null;

  private listeners = new Set<() => void>();

  constructor(
    private readonly storage: StorageLike | null,
    private readonly key: string = PROMOTION_STORAGE_KEY,
  ) {}

  /** 저장된 스냅숏. 없거나 스키마가 다르면 빈 스냅숏. 결과는 캐시되어 참조가 유지된다. */
  read(): PromotionSnapshot {
    if (this.cache) return this.cache;

    if (!this.storage) {
      this.cache = EMPTY_PROMOTION_SNAPSHOT;
      return this.cache;
    }

    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) {
        this.cache = EMPTY_PROMOTION_SNAPSHOT;
        return this.cache;
      }
      const parsed: unknown = JSON.parse(raw);
      this.cache = isSnapshot(parsed) ? parsed : EMPTY_PROMOTION_SNAPSHOT;
    } catch {
      // 손상된 JSON·프라이빗 모드 접근 예외 — 데모 화면은 계속 떠야 한다.
      this.cache = EMPTY_PROMOTION_SNAPSHOT;
    }

    return this.cache;
  }

  write(next: PromotionSnapshot): PromotionSnapshot {
    const normalized: PromotionSnapshot = {
      ...next,
      version: PROMOTION_SCHEMA_VERSION,
      updatedAt: Date.now(),
    };

    this.cache = normalized;

    if (this.storage) {
      try {
        this.storage.setItem(this.key, JSON.stringify(normalized));
      } catch {
        // 용량 초과·차단된 저장소: 메모리 상태만 유지한다.
      }
    }

    this.emit();
    return normalized;
  }

  /** 부분 갱신. 배열 필드는 통째로 교체한다(부분 병합은 원장을 흐트러뜨린다). */
  patch(patch: Partial<Omit<PromotionSnapshot, "version" | "updatedAt">>): PromotionSnapshot {
    return this.write({ ...this.read(), ...patch });
  }

  clear(): void {
    this.cache = EMPTY_PROMOTION_SNAPSHOT;
    if (this.storage) {
      try {
        this.storage.removeItem(this.key);
      } catch {
        // 무시
      }
    }
    this.emit();
  }

  /** 다른 탭에서 저장한 값을 다시 읽는다. */
  invalidate(): void {
    this.cache = null;
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let singleton: PromotionStore | null = null;
let storageListenerBound = false;

/** 기본 스토어(브라우저 localStorage). 서버에서는 메모리 스토어로 동작한다. */
export function promotionStore(): PromotionStore {
  if (!singleton) {
    singleton = new PromotionStore(browserStorage());

    if (typeof window !== "undefined" && !storageListenerBound) {
      storageListenerBound = true;
      window.addEventListener("storage", (event) => {
        if (event.key === PROMOTION_STORAGE_KEY || event.key === null) singleton?.invalidate();
      });
    }
  }

  return singleton;
}

/** React 훅: 어느 화면에서든 같은 원장을 읽는다. */
export function usePromotionSnapshot(): PromotionSnapshot {
  return useSyncExternalStore(
    (listener) => promotionStore().subscribe(listener),
    () => promotionStore().read(),
    () => EMPTY_PROMOTION_SNAPSHOT,
  );
}

/** 기본 집행 광고비 — 데모 값이며, 정산 대사 콘솔에서 수정할 수 있다. */
export const DEFAULT_CAMPAIGN_SPEND = 1_500_000;

/** 쿠폰 사용 주문까지 반영된 스냅숏을 저장한다. */
export function savePromotionResult(input: {
  campaigns: CampaignSpec[];
  templates: CouponTemplateSpec[];
  ledger: LedgerEntry[];
  orders: MarketingOrder[];
  simulation: SimulationSummary | null;
  campaignSpend?: Record<number, number>;
}): PromotionSnapshot {
  const previous = promotionStore().read();
  const spend: Record<number, number> = { ...previous.campaignSpend };
  for (const campaign of input.campaigns) {
    if (spend[campaign.id] === undefined) spend[campaign.id] = DEFAULT_CAMPAIGN_SPEND;
  }
  if (input.campaignSpend) Object.assign(spend, input.campaignSpend);

  return promotionStore().write({
    version: PROMOTION_SCHEMA_VERSION,
    updatedAt: Date.now(),
    campaigns: input.campaigns,
    templates: input.templates,
    ledger: input.ledger,
    orders: input.orders,
    campaignSpend: spend,
    simulation: input.simulation,
  });
}

export function setCampaignSpend(campaignId: number, amount: number): PromotionSnapshot {
  const snapshot = promotionStore().read();
  return promotionStore().patch({
    campaigns: snapshot.campaigns,
    campaignSpend: { ...snapshot.campaignSpend, [campaignId]: Math.max(0, Math.round(amount)) },
  });
}

/** 데모 원장 초기화(화면의 "원장 비우기"). */
export function resetPromotionStore(): void {
  promotionStore().clear();
}
