/**
 * 알림톡 발송 이력 저장소 (localStorage)
 *
 * 발송 로그는 "새로 고치면 사라지는" 데모가 아니라 누적되는 이력이어야 한다. 같은 이상으로
 * 다시 시도했을 때 중복 차단(dedupe)이 화면에서 확인되어야 하기 때문이다.
 * 쿠폰 원장과 같은 원칙(버전 불일치는 버림, 참조 동일성 유지, 저장소가 없어도 동작)을 쓴다.
 */

import { useSyncExternalStore } from "react";
import type { AlimtalkLogEntry } from "./alimtalkSimulator";
import type { StorageLike } from "./promotionStore";

export const ALIMTALK_STORAGE_KEY = "sellerscope.alimtalk.v1";
const MAX_LOG_ENTRIES = 60;

interface PersistedLogs {
  version: number;
  updatedAt: number;
  logs: AlimtalkLogEntry[];
}

const EMPTY: PersistedLogs = Object.freeze({ version: 1, updatedAt: 0, logs: Object.freeze([]) as unknown as AlimtalkLogEntry[] });

function isPersisted(value: unknown): value is PersistedLogs {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as PersistedLogs).version === 1 &&
    Array.isArray((value as PersistedLogs).logs)
  );
}

export class AlimtalkLogStore {
  private cache: PersistedLogs | null = null;

  private listeners = new Set<() => void>();

  constructor(
    private readonly storage: StorageLike | null,
    private readonly key: string = ALIMTALK_STORAGE_KEY,
  ) {}

  read(): PersistedLogs {
    if (this.cache) return this.cache;
    if (!this.storage) {
      this.cache = EMPTY;
      return this.cache;
    }

    try {
      const raw = this.storage.getItem(this.key);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      this.cache = isPersisted(parsed) ? parsed : EMPTY;
    } catch {
      this.cache = EMPTY;
    }

    return this.cache;
  }

  write(logs: readonly AlimtalkLogEntry[]): PersistedLogs {
    const next: PersistedLogs = {
      version: 1,
      updatedAt: Date.now(),
      logs: logs.slice(-MAX_LOG_ENTRIES),
    };
    this.cache = next;

    if (this.storage) {
      try {
        this.storage.setItem(this.key, JSON.stringify(next));
      } catch {
        // 저장 실패는 화면을 막지 않는다(메모리 이력으로 계속 동작)
      }
    }

    this.emit();
    return next;
  }

  clear(): void {
    this.cache = EMPTY;
    if (this.storage) {
      try {
        this.storage.removeItem(this.key);
      } catch {
        // 무시
      }
    }
    this.emit();
  }

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

let singleton: AlimtalkLogStore | null = null;
let bound = false;

export function alimtalkLogStore(): AlimtalkLogStore {
  if (!singleton) {
    singleton = new AlimtalkLogStore(browserStorage());
    if (typeof window !== "undefined" && !bound) {
      bound = true;
      window.addEventListener("storage", (event) => {
        if (event.key === ALIMTALK_STORAGE_KEY || event.key === null) singleton?.invalidate();
      });
    }
  }
  return singleton;
}

export function useAlimtalkLogs(): AlimtalkLogEntry[] {
  return useSyncExternalStore(
    (listener) => alimtalkLogStore().subscribe(listener),
    () => alimtalkLogStore().read().logs,
    () => EMPTY.logs,
  );
}
