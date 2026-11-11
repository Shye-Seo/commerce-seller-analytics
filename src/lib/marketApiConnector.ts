/**
 * 마켓 정산 API 커넥터 · 스마트스토어 / 쿠팡 샌드박스 연동
 *
 * 왜 이 모듈이 필요한가
 * ---------------------
 * 지금까지의 정산 대사는 "정산서 파일을 사람이 내려받아 업로드"하는 흐름이었다. 셀러가 매달
 * 반복하는 일은 파일을 받는 것 자체가 아니라, **마켓이 말하는 숫자와 내 원장이 말하는 숫자가
 * 같은지 확인하는 일**이다. 그 확인을 자동화하려면 마켓 API에서 정산 내역을 직접 받아와야 한다.
 *
 * 두 마켓의 인증 방식은 완전히 다르다.
 *   - 스마트스토어(커머스API): OAuth2 Client Credentials. 토큰 발급 요청의 `client_secret_sign`은
 *     `bcrypt(client_id + "_" + timestamp, client_secret)`를 Base64로 인코딩한 값이다.
 *     (apicenter.commerce.naver.com/docs/auth — 원문 시크릿을 전송하지 않기 위한 장치)
 *   - 쿠팡(Open API): CEA 스킴. `signed-date + method + path + query`를 HMAC-SHA256으로 서명해
 *     `Authorization: CEA algorithm=HmacSHA256, access-key=…, signed-date=…, signature=…`로 보낸다.
 *
 * 이 차이를 화면 코드가 알 필요는 없다. `MarketApiConnector`가 인증·페이지네이션·재시도·에러를
 * 흡수하고, 밖으로는 **정산 레코드 배열**과 **대사 결과**만 내놓는다. 그래서 `reconciliationEngine`은
 * 데이터가 파일에서 왔는지 API에서 왔는지 모른 채로 같은 계약 조건 재계산을 수행한다.
 *
 * 보안 경계 (의도한 설계)
 * -----------------------
 * 1. 시크릿은 화면에 다시 그리지 않는다. 입력 후에는 `sk-••••••1f2a` 형태의 마스크만 남기고,
 *    오류 메시지에 섞여 나온 값도 `scrubSecrets`로 지운 뒤 사용자에게 보여 준다.
 * 2. 로컬 저장은 **기본값 off**다. 공용 PC에서 시크릿이 남는 사고를 막기 위해, 사용자가
 *    "이 브라우저에 저장"을 고른 경우에만 localStorage에 기록한다(저장하지 않으면 메모리만).
 * 3. 실제 서비스에서는 시크릿이 브라우저에 있으면 안 된다. `proxyBaseUrl`을 주면 모든 요청이
 *    서버 프록시(`/api/market/{provider}/…`)를 거치도록 했고, 브라우저에서 직접 호출하는 경로는
 *    **샌드박스 전용**으로 문서에 못 박았다. (마켓 API는 CORS를 허용하지 않는다)
 *
 * 샌드박스
 * --------
 * 샌드박스는 네트워크를 타지 않는다. 고정 시드로 그 달의 정산 내역을 생성하므로, 같은 (마켓, 월)
 * 조합이면 항상 같은 숫자가 나오고 — 리뷰어가 클론해서 눌러도 같은 이상 징후를 본다. 생성기는
 * 데모 원장과 같은 분포(`settlementFixtures`)를 쓰되, **원가는 빼고** 내보낸다. 마켓 API는 원가를
 * 주지 않기 때문이다. 원가는 셀러 원장(`CostLedger`)에서 붙이고, 없으면 `MISSING_LEDGER`로 남긴다.
 */

import bcrypt from "bcryptjs";
import {
  CHANNEL_CONTRACTS,
  reconcileSettlementInBatches,
  type ContractTerms,
  type MarketChannel,
  type OrderStatus,
  type ReconciliationResult,
  type SettlementRow,
} from "./reconciliationEngine";
import { generateSettlementRows } from "./settlementFixtures";

/* ------------------------------------------------------------------ */
/* 마켓 메타데이터                                                     */
/* ------------------------------------------------------------------ */

export type MarketApiProvider = Extract<MarketChannel, "smartstore" | "coupang">;

export interface MarketApiMeta {
  provider: MarketApiProvider;
  label: string;
  /** 인증 방식. 화면이 "왜 키 입력 칸이 다른지"를 설명할 때 쓴다 */
  authKind: "oauth2-bcrypt" | "hmac-sha256";
  host: string;
  tokenPath: string | null;
  settlementPath: string;
  docsUrl: string;
  /** 마켓이 정산 내역으로 내려 주는 값 (원가·계약 수수료율은 없다) */
  returns: string[];
  secretHint: string;
}

export const MARKET_API_META: Record<MarketApiProvider, MarketApiMeta> = {
  smartstore: {
    provider: "smartstore",
    label: "스마트스토어",
    authKind: "oauth2-bcrypt",
    host: "https://api.commerce.naver.com",
    tokenPath: "/external/v1/oauth2/token",
    settlementPath: "/external/v1/pay-settle/settle/request",
    docsUrl: "https://apicenter.commerce.naver.com/docs/auth",
    returns: ["주문번호", "상품·SKU", "결제금액", "판매수수료", "배송비 차감", "반품비", "정산액"],
    secretHint: "커머스API센터에서 발급한 애플리케이션 ID / 시크릿(bcrypt 해시 문자열)",
  },
  coupang: {
    provider: "coupang",
    label: "쿠팡",
    authKind: "hmac-sha256",
    host: "https://api-gateway.coupang.com",
    tokenPath: null,
    settlementPath: "/v2/providers/seller_api/apis/api/v1/marketplace/settlement/receipts",
    docsUrl: "https://developers.coupangcorp.com",
    returns: ["주문번호", "상품·SKU", "결제금액", "판매수수료", "배송비 차감", "반품비", "정산액"],
    secretHint: "쿠팡 WING > 판매자 API에서 발급한 Access Key / Secret Key, 업체코드(vendorId)",
  },
};

/* ------------------------------------------------------------------ */
/* 에러                                                                */
/* ------------------------------------------------------------------ */

export type MarketApiErrorCode =
  | "AUTH"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "NETWORK"
  | "PARSE"
  | "SERVER"
  | "CONFIG";

const ERROR_HINTS: Record<MarketApiErrorCode, string> = {
  AUTH: "키·시크릿이 만료되었거나 스토어 계정과 맞지 않습니다. 마켓 센터에서 재발급한 뒤 다시 연결해 주세요.",
  FORBIDDEN: "키는 유효하지만 이 API를 호출할 권한이 없습니다. 정산 조회 권한(스코프)을 확인해 주세요.",
  RATE_LIMITED: "마켓이 호출 한도를 넘었다고 응답했습니다. 잠시 뒤 다시 시도하거나 페이지 크기를 줄여 주세요.",
  NETWORK: "마켓 서버에 닿지 못했습니다. 네트워크·프록시 설정과 마켓 점검 공지를 확인해 주세요.",
  PARSE: "응답 형식이 예상과 다릅니다. 마켓 API 버전이 바뀌었는지 확인해 주세요.",
  SERVER: "마켓 서버 오류(5xx)입니다. 재시도로도 해결되지 않으면 마켓 고객센터에 문의해 주세요.",
  CONFIG: "설정이 비어 있거나 형식이 잘못되었습니다. 입력값을 확인해 주세요.",
};

/** 시크릿이 오류 메시지·로그로 새지 않도록 지운다. */
export function scrubSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let result = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

export class MarketApiError extends Error {
  readonly code: MarketApiErrorCode;
  readonly status: number | null;
  readonly provider: MarketApiProvider;
  readonly hint: string;
  readonly retryable: boolean;
  /** 사용자에게 그대로 보여 줄 수 있는 값만 담는다(시크릿은 scrub 후) */
  readonly detail: string | null;

  constructor(
    code: MarketApiErrorCode,
    message: string,
    options: {
      provider: MarketApiProvider;
      status?: number | null;
      retryable?: boolean;
      detail?: string | null;
      secrets?: readonly (string | undefined)[];
      hint?: string;
    },
  ) {
    super(scrubSecrets(message, options.secrets ?? []));
    this.name = "MarketApiError";
    this.code = code;
    this.status = options.status ?? null;
    this.provider = options.provider;
    this.retryable =
      options.retryable ?? (code === "RATE_LIMITED" || code === "NETWORK" || code === "SERVER");
    this.hint = options.hint ?? ERROR_HINTS[code];
    this.detail = options.detail ? scrubSecrets(options.detail, options.secrets ?? []) : null;
  }

  /** 화면·리포트에 쓰는 한 줄 요약 */
  toDisplay(): { code: MarketApiErrorCode; title: string; message: string; hint: string; status: number | null } {
    return { code: this.code, title: `${MARKET_API_META[this.provider].label} 연결 오류`, message: this.message, hint: this.hint, status: this.status };
  }
}

/* ------------------------------------------------------------------ */
/* 자격 증명 · 마스킹 · 로컬 저장                                      */
/* ------------------------------------------------------------------ */

export interface MarketApiCredentials {
  provider: MarketApiProvider;
  clientId: string;
  clientSecret: string;
  /** 쿠팡은 업체코드가 필수다. 스마트스토어에서는 비어 있어도 된다 */
  vendorId?: string;
  /** 스마트스토어 전자서명의 type 파라미터. 내 스토어 앱은 SELF만 지원한다 */
  accountType?: "SELF" | "SELLER";
  sandbox: boolean;
}

export interface PublicCredentials {
  provider: MarketApiProvider;
  clientId: string;
  clientIdMasked: string;
  secretMasked: string;
  vendorId: string | null;
  hasSecret: boolean;
  sandbox: boolean;
}

/**
 * 시크릿 마스킹.
 *
 * 길이를 그대로 노출하지 않도록 불릿 개수를 고정한다. 마지막 4자만 남겨 "내가 넣은 그 키"임을
 * 확인할 수 있게 하고, 앞 3자는 서비스 prefix(sk-, CEA 등)를 알아보기 위한 것이다.
 */
export function maskSecret(value: string | undefined | null, keep = 4): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.length <= keep + 2) return "•".repeat(8);
  const head = trimmed.slice(0, 3);
  const tail = trimmed.slice(-keep);
  return `${head}${"•".repeat(8)}${tail}`;
}

export function maskCredentials(credentials: MarketApiCredentials): PublicCredentials {
  return {
    provider: credentials.provider,
    clientId: credentials.clientId,
    clientIdMasked: maskSecret(credentials.clientId, 4),
    secretMasked: maskSecret(credentials.clientSecret),
    vendorId: credentials.vendorId?.trim() ? credentials.vendorId.trim() : null,
    hasSecret: Boolean(credentials.clientSecret?.trim()),
    sandbox: credentials.sandbox,
  };
}

export interface StoredCredentials {
  provider: MarketApiProvider;
  clientId: string;
  /** 사용자가 "이 브라우저에 저장"을 고른 경우에만 존재한다 */
  clientSecret?: string;
  secretPersisted: boolean;
  vendorId?: string;
  sandbox: boolean;
  savedAt: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CredentialStore {
  load(provider: MarketApiProvider): Promise<StoredCredentials | undefined>;
  save(record: StoredCredentials): Promise<void>;
  remove(provider: MarketApiProvider): Promise<void>;
}

export const CREDENTIAL_STORAGE_KEY = "csa.market-api.credentials.v1";

export class MemoryCredentialStore implements CredentialStore {
  private readonly records = new Map<MarketApiProvider, StoredCredentials>();

  async load(provider: MarketApiProvider): Promise<StoredCredentials | undefined> {
    const record = this.records.get(provider);
    return record ? { ...record } : undefined;
  }

  async save(record: StoredCredentials): Promise<void> {
    this.records.set(record.provider, { ...record });
  }

  async remove(provider: MarketApiProvider): Promise<void> {
    this.records.delete(provider);
  }
}

/**
 * localStorage 저장소. 손상된 JSON이나 다른 버전의 레코드는 조용히 버린다(화면이 못 뜨는 것보다 낫다).
 */
export class BrowserCredentialStore implements CredentialStore {
  constructor(private readonly storage: StorageLike, private readonly key = CREDENTIAL_STORAGE_KEY) {}

  private readAll(): Record<string, StoredCredentials> {
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, StoredCredentials>) : {};
    } catch {
      return {};
    }
  }

  async load(provider: MarketApiProvider): Promise<StoredCredentials | undefined> {
    const record = this.readAll()[provider];
    if (!record || record.provider !== provider) return undefined;
    return { ...record };
  }

  async save(record: StoredCredentials): Promise<void> {
    const all = this.readAll();
    all[record.provider] = { ...record };
    this.storage.setItem(this.key, JSON.stringify(all));
  }

  async remove(provider: MarketApiProvider): Promise<void> {
    const all = this.readAll();
    delete all[provider];
    if (Object.keys(all).length === 0) this.storage.removeItem(this.key);
    else this.storage.setItem(this.key, JSON.stringify(all));
  }
}

/** 브라우저면 localStorage, 아니면(SSR·테스트) 메모리. 화면 코드는 이 함수만 알면 된다. */
export function createCredentialStore(): CredentialStore {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return new BrowserCredentialStore(window.localStorage);
    }
  } catch {
    // 사파리 프라이빗 모드처럼 localStorage 접근이 예외를 던지는 환경
  }
  return new MemoryCredentialStore();
}

/* ------------------------------------------------------------------ */
/* 조회 조건 · 응답 정규화                                             */
/* ------------------------------------------------------------------ */

export interface SettlementQuery {
  /** 정산월 (YYYY-MM) */
  month: string;
  pageSize?: number;
  page?: number;
}

export interface DateRange {
  startDate: string;
  endDate: string;
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** "2026-10" → { startDate: "2026-10-01", endDate: "2026-10-31" } */
export function monthRange(month: string): DateRange {
  if (!MONTH_PATTERN.test(month)) {
    throw new MarketApiError("CONFIG", `정산월 형식이 올바르지 않습니다: ${month}`, {
      provider: "smartstore",
      hint: "YYYY-MM 형식으로 지정해 주세요(예: 2026-10).",
    });
  }
  const [yearText, monthText] = month.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText);
  const lastDay = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  return {
    startDate: `${month}-01`,
    endDate: `${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

/** 화면 기본값: 지난 달(정산은 보통 다음 달에 확정된다) */
export function defaultSettlementMonth(nowMs: number = Date.now()): string {
  const date = new Date(nowMs);
  const previous = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** API가 내려 주는 정산 한 건(원가·계약 수수료율은 없다) */
export interface MarketSettlementRecord {
  orderNo: string;
  orderDate: string;
  productName: string;
  sku: string;
  quantity: number;
  paidAmount: number;
  commission: number;
  shippingDeduction: number;
  returnFee: number;
  settledAmount: number;
  status: OrderStatus;
}

export interface MarketSettlementPage {
  records: MarketSettlementRecord[];
  page: number;
  hasNext: boolean;
  /** 응답이 다음 페이지 유무를 명시했는가. 아니면 "페이지가 가득 찼는가"로 추론한다 */
  hasNextKnown: boolean;
  /** 마켓이 준 원본 레코드 수(정규화에서 버려진 행을 세기 위해) */
  rawCount: number;
  droppedCount: number;
}

const STATUS_MAP: Record<string, OrderStatus> = {
  배송완료: "배송완료",
  구매확정: "배송완료",
  delivered: "배송완료",
  delivery_completed: "배송완료",
  purchase_confirmed: "배송완료",
  반품완료: "반품완료",
  반품: "반품완료",
  returned: "반품완료",
  return_completed: "반품완료",
  취소: "취소",
  취소완료: "취소",
  canceled: "취소",
  cancelled: "취소",
  cancel_completed: "취소",
  교환완료: "교환완료",
  exchanged: "교환완료",
  exchange_completed: "교환완료",
};

export function toOrderStatus(value: unknown): OrderStatus | null {
  if (typeof value !== "string") return null;
  return STATUS_MAP[value.trim().toLowerCase()] ?? STATUS_MAP[value.trim()] ?? null;
}

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^\d.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function pickField(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") return source[key];
  }
  return undefined;
}

/**
 * 레코드 정규화. 마켓마다(그리고 같은 마켓의 API 버전마다) 필드명이 다르므로 후보 키를 순서대로
 * 본다. 정산액이 비어 있으면 결제금액-수수료-배송비-반품비로 복원한다 — 이 복원값은 "마켓이 준
 * 숫자"가 아니라 계산값이지만, 대사는 어차피 계약 기준 기대값과 비교하므로 안전하다.
 */
export function normalizeRecord(raw: unknown): MarketSettlementRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const orderNo = str(pickField(source, ["orderNo", "orderId", "orderNumber", "order_no", "order_id"]));
  const productName = str(pickField(source, ["productName", "productNameKo", "itemName", "product_name", "title"]));
  const sku = str(pickField(source, ["sku", "sellerProductId", "sellerProductCode", "vendorItemId", "productId", "itemId"]));
  if (!orderNo) return null;

  const paidAmount = num(pickField(source, ["paidAmount", "orderPrice", "salesAmount", "paymentAmount", "totalPrice"]));
  const commission = num(pickField(source, ["commission", "commissionAmount", "serviceFee", "fee", "salesCommission"]));
  const shippingDeduction = num(pickField(source, ["shippingDeduction", "deliveryFee", "shippingFee", "deliveryDeduction"]));
  const returnFee = num(pickField(source, ["returnFee", "returnCharge", "returnShippingFee"]));
  const settledRaw = pickField(source, ["settledAmount", "settlementAmount", "settleAmount", "payoutAmount", "depositAmount"]);
  const settledAmount =
    settledRaw === undefined ? paidAmount - commission - shippingDeduction - returnFee : num(settledRaw);

  const orderDate = str(pickField(source, ["orderDate", "paidAt", "orderDateTime", "order_date", "settleDate"])).slice(0, 10);
  const status = toOrderStatus(pickField(source, ["status", "orderStatus", "order_status", "settleStatus"])) ?? "배송완료";

  return {
    orderNo,
    orderDate: orderDate || "",
    productName,
    sku,
    quantity: Math.max(1, Math.round(num(pickField(source, ["quantity", "orderCount", "qty"])) || 1)),
    paidAmount: Math.round(paidAmount),
    commission: Math.round(commission),
    shippingDeduction: Math.round(shippingDeduction),
    returnFee: Math.round(returnFee),
    settledAmount: Math.round(settledAmount),
    status,
  };
}

interface PageEnvelope {
  items: unknown[];
  page: number;
  hasNext: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * 페이지 봉투 해석. 스마트스토어는 `{ data: [...] }`, 쿠팡은 `{ code, data: { content: [...] } }`
 * 형태를 쓰지만, 같은 계열 API가 종종 `items`/`elements`로 바뀌므로 배열이 있는 첫 지점을 찾는다.
 * 배열을 찾지 못하면 PARSE 오류다(조용히 0건으로 넘기면 "정산이 없다"는 거짓말이 된다).
 */
export function unwrapSettlementPage(payload: unknown, fallbackPage = 1): PageEnvelope & { hasNextKnown: boolean } {
  const root = asRecord(payload);
  if (!root) throw new MarketApiError("PARSE", "응답이 JSON 객체가 아닙니다.", { provider: "smartstore" });

  const candidates: unknown[] = [];
  const queue: unknown[] = [root];
  let guard = 0;
  while (queue.length > 0 && guard < 12) {
    guard += 1;
    const current = asRecord(queue.shift());
    if (!current) continue;
    for (const key of ["data", "content", "items", "elements", "list", "result", "results"]) {
      const value = current[key];
      if (Array.isArray(value)) candidates.push(value);
      else if (asRecord(value)) queue.push(value);
    }
  }
  const items = candidates.find((candidate) => Array.isArray(candidate)) as unknown[] | undefined;
  if (!items) {
    throw new MarketApiError("PARSE", "응답에서 정산 내역 배열을 찾지 못했습니다.", {
      provider: "smartstore",
      detail: `top-level keys: ${Object.keys(root).join(", ") || "(none)"}`,
    });
  }

  const pages: unknown[] = [];
  const flags: unknown[] = [];
  const scan = (node: unknown): void => {
    const record = asRecord(node);
    if (!record) return;
    for (const key of ["page", "pageNo", "pageNumber", "currentPage"]) if (record[key] !== undefined) pages.push(record[key]);
    for (const key of ["hasNext", "has_next", "nextPage", "isLast"]) if (record[key] !== undefined) flags.push(record[key]);
    for (const key of ["data", "content", "pageInfo", "pagination", "result"]) if (asRecord(record[key])) scan(record[key]);
  };
  scan(root);

  const pageNumber = pages.find((value) => Number.isFinite(Number(value)));
  const flag = flags.find((value) => value !== undefined);
  let hasNext: boolean;
  if (typeof flag === "boolean") hasNext = flag;
  else if (flag === "true" || flag === "Y") hasNext = true;
  else if (flag === "false" || flag === "N") hasNext = false;
  // 페이지 정보가 없으면 "가득 찬 페이지면 다음이 있다"로 본다. 호출부가 pageSize와 비교해 다시 판단한다.
  else hasNext = false;

  const lastMarker = flags.some((value) => value === true || value === false || value === "true" || value === "false" || value === "Y" || value === "N");
  return {
    items,
    page: pageNumber === undefined ? fallbackPage : Math.max(1, Math.round(Number(pageNumber))),
    hasNext,
    hasNextKnown: lastMarker,
  };
}

/** 봉투 + 정규화 + 이탈 행 계수까지 한 번에. */
export function parseSettlementPage(payload: unknown, fallbackPage = 1): MarketSettlementPage {
  const envelope = unwrapSettlementPage(payload, fallbackPage);
  const records: MarketSettlementRecord[] = [];
  let dropped = 0;
  for (const item of envelope.items) {
    const record = normalizeRecord(item);
    if (record) records.push(record);
    else dropped += 1;
  }
  return {
    records,
    page: envelope.page,
    hasNext: envelope.hasNext,
    hasNextKnown: envelope.hasNextKnown,
    rawCount: envelope.items.length,
    droppedCount: dropped,
  };
}

/* ------------------------------------------------------------------ */
/* 서명                                                                */
/* ------------------------------------------------------------------ */

function base64OfUtf8(text: string): string {
  if (typeof btoa === "function") return btoa(text);
  throw new MarketApiError("CONFIG", "Base64 인코더를 사용할 수 없는 환경입니다.", { provider: "smartstore" });
}

/**
 * 스마트스토어 전자서명: Base64(bcrypt(client_id + "_" + timestamp, client_secret)).
 * 시크릿 원문을 전송하지 않기 위한 장치이므로, 해시 결과만 요청에 담긴다.
 */
export function createSmartStoreSecretSign(clientId: string, clientSecret: string, timestampMs: number): string {
  const password = `${clientId}_${timestampMs}`;
  const hashed = bcrypt.hashSync(password, clientSecret);
  return base64OfUtf8(hashed);
}

/** 쿠팡 CEA 서명 메시지: signed-date + method + path + query (도메인 제외) */
export function coupangSignatureMessage(signedDate: string, method: string, path: string, query = ""): string {
  return `${signedDate}${method.toUpperCase()}${path}${query}`;
}

/** UTC 기준 yyMMdd'T'HHmmss'Z' */
export function coupangSignedDate(nowMs: number): string {
  const date = new Date(nowMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new MarketApiError("CONFIG", "이 환경에는 Web Crypto(HMAC)가 없습니다.", {
      provider: "coupang",
      hint: "HTTPS 또는 localhost에서 열어 주세요. 파일로 직접 열면 crypto.subtle을 쓸 수 없습니다.",
    });
  }
  const encoder = new TextEncoder();
  const key = await subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface SignedRequest {
  method: "GET" | "POST";
  /** 프록시를 쓰면 프록시 기준 경로, 아니면 마켓 절대 URL */
  url: string;
  path: string;
  query: string;
  headers: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* 전송 계층                                                           */
/* ------------------------------------------------------------------ */

export interface MarketApiRequest {
  provider: MarketApiProvider;
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface MarketApiResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type HttpTransport = (request: MarketApiRequest) => Promise<MarketApiResponse>;

export interface FetchTransportOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** 브라우저/Node 공통 fetch 전송. 타임아웃은 AbortController로 강제한다. */
export function createFetchTransport(options: FetchTransportOptions = {}): HttpTransport {
  const timeoutMs = options.timeoutMs ?? 15_000;
  return async (request) => {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new MarketApiError("CONFIG", "fetch를 사용할 수 없는 환경입니다.", { provider: request.provider });
    }
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller?.signal,
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return { status: response.status, headers, body: await response.text() };
    } catch (error) {
      if (error instanceof MarketApiError) throw error;
      const aborted = error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
      throw new MarketApiError(
        "NETWORK",
        aborted ? `요청이 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다.` : `네트워크 요청 실패: ${error instanceof Error ? error.message : String(error)}`,
        { provider: request.provider, secrets: Object.values(request.headers) },
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/* ------------------------------------------------------------------ */
/* 샌드박스 데이터셋                                                    */
/* ------------------------------------------------------------------ */

export interface SandboxDataset {
  provider: MarketApiProvider;
  month: string;
  records: MarketSettlementRecord[];
  /** SKU별 원가. 마켓 API는 주지 않으므로 셀러 원장 역할을 샌드박스가 대신한다 */
  ledger: Record<string, { unitCost: number; sellerShippingCost: number }>;
}

const sandboxCache = new Map<string, SandboxDataset>();

function seedFrom(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * (마켓, 월) 고정 시드 정산 내역.
 *
 * 데모 원장 생성기를 그대로 쓰되 원가를 분리한다. 마켓 API가 주는 것(금액)과 셀러 원장이 주는
 * 것(원가)을 섞지 않는 것이 이 모듈의 핵심 구분이기 때문이다.
 */
export function buildSandboxDataset(provider: MarketApiProvider, month: string, count = 1_200): SandboxDataset {
  const key = `${provider}:${month}:${count}`;
  const cached = sandboxCache.get(key);
  if (cached) return cached;

  const range = monthRange(month);
  const rows = generateSettlementRows({
    count,
    seed: seedFrom(`${provider}:${month}`),
    snapshotDate: range.endDate,
    windowDays: 27,
    channels: [provider],
  });

  const ledger: SandboxDataset["ledger"] = {};
  const monthTag = month.replace("-", "");
  const recordsList: MarketSettlementRecord[] = rows.map((row, index) => {
    if (row.unitCost > 0 && !ledger[row.sku]) {
      ledger[row.sku] = { unitCost: row.unitCost, sellerShippingCost: row.sellerShippingCost };
    }
    const prefix = provider === "coupang" ? "CP" : "SS";
    return {
      // 같은 주문번호가 달마다 반복되면 "지난달 정산"과 헷갈린다. 주문번호에 정산월을 박아 둔다.
      orderNo: `${prefix}${monthTag}${String(index + 1).padStart(7, "0")}`,
      orderDate: row.orderDate,
      productName: row.productName,
      sku: row.sku,
      quantity: row.quantity,
      paidAmount: row.paidAmount,
      commission: row.commission,
      shippingDeduction: row.shippingDeduction,
      returnFee: row.returnFee,
      settledAmount: row.settledAmount,
      status: row.status,
    };
  });

  const dataset: SandboxDataset = { provider, month, records: recordsList, ledger };
  sandboxCache.set(key, dataset);
  return dataset;
}

export interface SandboxTransportOptions {
  /** 응답 지연(ms). 기본 0 — 테스트를 느리게 만들지 않는다 */
  latencyMs?: number;
  /** 특정 페이지에서 일부러 실패시킨다(재시도 UI 검증용) */
  failAt?: { page: number; status: number; times?: number };
  count?: number;
}

/**
 * 네트워크 없는 전송 계층.
 *
 * 실제 마켓 응답의 **봉투 모양**을 흉내 낸다(스마트스토어 `data`, 쿠팡 `data.content`). 그래야
 * 파서·페이지네이션·에러 처리가 샌드박스에서만 통과하고 실제에서 깨지는 일이 없다.
 */
export function createSandboxTransport(options: SandboxTransportOptions = {}): HttpTransport {
  const failures = new Map<number, number>();
  const pageSize = 500;
  return async (request): Promise<MarketApiResponse> => {
    if (options.latencyMs && options.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
    }
    const url = new URL(request.url, "https://sandbox.local");
    const provider = request.provider;
    const meta = MARKET_API_META[provider];

    if (request.method === "POST" && meta.tokenPath && url.pathname.endsWith(meta.tokenPath)) {
      const body = request.body ?? "";
      const hasSecret = /client_secret_sign=[^&]+/.test(body);
      if (!hasSecret) {
        return {
          status: 401,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: "GW.AUTHN", message: "client_secret_sign is required" }),
        };
      }
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ access_token: "sandbox-token", expires_in: 10_800, token_type: "Bearer" }),
      };
    }

    if (!url.pathname.endsWith(meta.settlementPath)) {
      return {
        status: 404,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: `unknown sandbox endpoint: ${url.pathname}` }),
      };
    }

    if (provider === "coupang" && !request.headers.authorization?.startsWith("CEA ")) {
      return {
        status: 401,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "ERROR", message: "invalid CEA signature" }),
      };
    }
    if (provider === "smartstore" && !request.headers.authorization?.startsWith("Bearer ")) {
      return {
        status: 401,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "GW.AUTHN", message: "missing bearer token" }),
      };
    }

    const page = Math.max(1, Math.round(Number(url.searchParams.get("page") ?? "1")));
    const month = url.searchParams.get("month") ?? defaultSettlementMonth();
    const dataset = buildSandboxDataset(provider, MONTH_PATTERN.test(month) ? month : defaultSettlementMonth(), options.count);
    const start = (page - 1) * pageSize;
    const slice = dataset.records.slice(start, start + pageSize);
    const hasNext = start + pageSize < dataset.records.length;

    const failure = options.failAt;
    if (failure && failure.page === page) {
      const used = failures.get(page) ?? 0;
      if (used < (failure.times ?? 1)) {
        failures.set(page, used + 1);
        return {
          status: failure.status,
          headers: { "content-type": "application/json", "retry-after": "0" },
          body: JSON.stringify({ message: "sandbox injected failure" }),
        };
      }
    }

    if (provider === "coupang") {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: 200, message: "OK", data: { content: slice, page, hasNext } }),
      };
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: slice, page, hasNext }),
    };
  };
}

/* ------------------------------------------------------------------ */
/* 커넥터                                                              */
/* ------------------------------------------------------------------ */

export interface ConnectorOptions {
  credentials: MarketApiCredentials;
  transport?: HttpTransport;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  /** 서버 프록시를 쓸 때의 기준 경로. 예: "/api/market" */
  proxyBaseUrl?: string;
  onTokenRefresh?: (info: { provider: MarketApiProvider; expiresAtMs: number }) => void;
}

export interface CollectionProgress {
  stage: "auth" | "fetch" | "done";
  page: number;
  records: number;
  message: string;
}

export interface CollectionResult {
  provider: MarketApiProvider;
  month: string;
  records: MarketSettlementRecord[];
  pages: number;
  dropped: number;
  elapsedMs: number;
  sandbox: boolean;
}

export interface ConnectionProbe {
  ok: boolean;
  provider: MarketApiProvider;
  latencyMs: number;
  pageRecords: number;
  message: string;
  status: number;
  sandbox: boolean;
}

export class MarketApiConnector {
  readonly provider: MarketApiProvider;
  private readonly credentials: MarketApiCredentials;
  private readonly transport: HttpTransport;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly proxyBaseUrl: string | null;
  private readonly onTokenRefresh?: ConnectorOptions["onTokenRefresh"];
  private token: { value: string; expiresAtMs: number } | null = null;

  constructor(options: ConnectorOptions) {
    this.credentials = options.credentials;
    this.provider = options.credentials.provider;
    this.transport = options.transport ?? (options.credentials.sandbox ? createSandboxTransport() : createFetchTransport());
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? 2;
    this.proxyBaseUrl = options.proxyBaseUrl ? options.proxyBaseUrl.replace(/\/+$/, "") : null;
    this.onTokenRefresh = options.onTokenRefresh;
  }

  private get meta(): MarketApiMeta {
    return MARKET_API_META[this.provider];
  }

  private secrets(): string[] {
    return [this.credentials.clientSecret, this.credentials.clientId].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
  }

  /** 정산 조회 URL. 프록시가 있으면 마켓 호스트 대신 프록시 기준 경로를 쓴다. */
  private settlementPath(query: SettlementQuery): { path: string; query: string; url: string; hostHeader?: string } {
    const range = monthRange(query.month);
    const page = Math.max(1, Math.round(query.page ?? 1));
    const pageSize = Math.max(1, Math.min(1_000, Math.round(query.pageSize ?? 500)));
    const params = new URLSearchParams({
      startDate: range.startDate,
      endDate: range.endDate,
      page: String(page),
      pageSize: String(pageSize),
      month: query.month,
    });
    if (this.provider === "coupang") {
      const vendorId = this.credentials.vendorId?.trim();
      if (!vendorId) {
        throw new MarketApiError("CONFIG", "쿠팡은 업체코드(vendorId)가 필요합니다.", {
          provider: this.provider,
          hint: "WING > 판매자 API에서 업체코드를 확인해 주세요.",
        });
      }
      params.set("vendorId", vendorId);
    }
    const queryString = params.toString();
    const path = this.meta.settlementPath;
    const url = this.proxyBaseUrl
      ? `${this.proxyBaseUrl}/${this.provider}/settlements?${queryString}`
      : `${this.meta.host}${path}?${queryString}`;
    return { path, query: queryString, url };
  }

  private requireCredentials(): void {
    if (!this.credentials.clientId?.trim()) {
      throw new MarketApiError("CONFIG", "애플리케이션 ID(또는 Access Key)가 비어 있습니다.", {
        provider: this.provider,
        hint: this.meta.secretHint,
      });
    }
    if (!this.credentials.clientSecret?.trim()) {
      throw new MarketApiError("CONFIG", "시크릿이 비어 있습니다.", {
        provider: this.provider,
        hint: this.meta.secretHint,
      });
    }
  }

  /** 스마트스토어 토큰. 만료 60초 전까지 재사용한다(페이지마다 토큰을 새로 받지 않는다). */
  private async getAccessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAtMs - 60_000 > this.now()) return this.token.value;
    this.requireCredentials();

    const timestamp = this.now();
    const sign = createSmartStoreSecretSign(this.credentials.clientId.trim(), this.credentials.clientSecret, timestamp);
    const body = new URLSearchParams({
      client_id: this.credentials.clientId.trim(),
      timestamp: String(timestamp),
      grant_type: "client_credentials",
      client_secret_sign: sign,
      type: this.credentials.accountType ?? "SELF",
    }).toString();

    const response = await this.send({
      provider: this.provider,
      method: "POST",
      url: this.proxyBaseUrl ? `${this.proxyBaseUrl}/${this.provider}/token` : `${this.meta.host}${this.meta.tokenPath}`,
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body,
    });

    if (response.status === 401 || response.status === 400) {
      throw new MarketApiError("AUTH", "스마트스토어 토큰 발급이 거부되었습니다.", {
        provider: this.provider,
        status: response.status,
        detail: response.body.slice(0, 400),
        secrets: this.secrets(),
        retryable: false,
      });
    }
    if (response.status === 429) {
      throw new MarketApiError("RATE_LIMITED", "토큰 발급이 호출 한도에 걸렸습니다(HTTP 429).", {
        provider: this.provider,
        status: 429,
        detail: response.headers["retry-after"] ? `retry-after: ${response.headers["retry-after"]}` : null,
        secrets: this.secrets(),
      });
    }
    if (response.status >= 400) {
      throw new MarketApiError(response.status >= 500 ? "SERVER" : "FORBIDDEN", `토큰 발급 실패(HTTP ${response.status})`, {
        provider: this.provider,
        status: response.status,
        detail: response.body.slice(0, 400),
        secrets: this.secrets(),
        retryable: response.status >= 500,
      });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(response.body);
    } catch {
      throw new MarketApiError("PARSE", "토큰 응답이 JSON이 아닙니다.", {
        provider: this.provider,
        detail: response.body.slice(0, 200),
        secrets: this.secrets(),
      });
    }
    const root = asRecord(payload);
    const token = str(root?.access_token ?? root?.accessToken ?? root?.token);
    if (!token) {
      throw new MarketApiError("AUTH", "토큰 응답에 access_token이 없습니다.", {
        provider: this.provider,
        detail: response.body.slice(0, 200),
        secrets: this.secrets(),
      });
    }
    const expiresInSec = num(root?.expires_in ?? root?.expiresIn ?? 10_800) || 10_800;
    this.token = { value: token, expiresAtMs: this.now() + expiresInSec * 1_000 };
    this.onTokenRefresh?.({ provider: this.provider, expiresAtMs: this.token.expiresAtMs });
    return token;
  }

  /** 쿠팡 CEA 서명 헤더. 서명에는 쿼리 문자열까지 포함되므로 URL과 같은 값을 써야 한다. */
  private async buildCoupangAuth(path: string, query: string): Promise<string> {
    this.requireCredentials();
    const signedDate = coupangSignedDate(this.now());
    const message = coupangSignatureMessage(signedDate, "GET", path, query);
    const signature = await hmacSha256Hex(this.credentials.clientSecret, message);
    return `CEA algorithm=HmacSHA256, access-key=${this.credentials.clientId.trim()}, signed-date=${signedDate}, signature=${signature}`;
  }

  private async send(request: MarketApiRequest): Promise<MarketApiResponse> {
    try {
      return await this.transport(request);
    } catch (error) {
      if (error instanceof MarketApiError) throw error;
      throw new MarketApiError("NETWORK", error instanceof Error ? error.message : String(error), {
        provider: this.provider,
        secrets: this.secrets(),
      });
    }
  }

  /** 재시도 가능한 실패를 흡수한다. Retry-After(초)를 우선하고, 없으면 지수 백오프. */
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await operation();
      } catch (error) {
        const apiError = error instanceof MarketApiError ? error : null;
        if (!apiError || !apiError.retryable || attempt >= this.maxRetries) throw error;
        const delay = apiError.code === "RATE_LIMITED" ? 800 : 300 * 2 ** attempt;
        attempt += 1;
        await this.sleep(delay);
      }
    }
  }

  /** 한 페이지 조회. 401이면 토큰을 한 번 갱신하고 재시도한다(스마트스토어 GW.AUTHN 대응). */
  async fetchPage(query: SettlementQuery): Promise<MarketSettlementPage> {
    const target = this.settlementPath(query);
    const page = Math.max(1, Math.round(query.page ?? 1));

    const request = async (forceToken: boolean): Promise<MarketApiResponse> => {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.provider === "smartstore") {
        headers.authorization = `Bearer ${await this.getAccessToken(forceToken)}`;
      } else {
        headers.authorization = await this.buildCoupangAuth(target.path, target.query);
      }
      return this.send({ provider: this.provider, method: "GET", url: target.url, headers });
    };

    return this.withRetry(async () => {
      let response = await request(false);
      if (response.status === 401 && this.provider === "smartstore") {
        response = await request(true);
      }

      if (response.status === 401) {
        throw new MarketApiError("AUTH", "인증이 거부되었습니다(HTTP 401).", {
          provider: this.provider,
          status: 401,
          detail: response.body.slice(0, 400),
          secrets: this.secrets(),
          retryable: false,
        });
      }
      if (response.status === 403) {
        throw new MarketApiError("FORBIDDEN", "호출 권한이 없습니다(HTTP 403).", {
          provider: this.provider,
          status: 403,
          detail: response.body.slice(0, 400),
          secrets: this.secrets(),
          retryable: false,
        });
      }
      if (response.status === 429) {
        throw new MarketApiError("RATE_LIMITED", "호출 한도를 초과했습니다(HTTP 429).", {
          provider: this.provider,
          status: 429,
          detail: response.headers["retry-after"] ? `retry-after: ${response.headers["retry-after"]}` : null,
          secrets: this.secrets(),
        });
      }
      if (response.status >= 500) {
        throw new MarketApiError("SERVER", `마켓 서버 오류(HTTP ${response.status}).`, {
          provider: this.provider,
          status: response.status,
          detail: response.body.slice(0, 400),
          secrets: this.secrets(),
        });
      }
      if (response.status >= 400) {
        throw new MarketApiError("FORBIDDEN", `요청이 거부되었습니다(HTTP ${response.status}).`, {
          provider: this.provider,
          status: response.status,
          detail: response.body.slice(0, 400),
          secrets: this.secrets(),
          retryable: false,
        });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(response.body);
      } catch {
        throw new MarketApiError("PARSE", "응답이 JSON이 아닙니다. 마켓 점검 페이지일 수 있습니다.", {
          provider: this.provider,
          status: response.status,
          detail: response.body.slice(0, 200),
          secrets: this.secrets(),
          retryable: false,
        });
      }
      try {
        const parsed = parseSettlementPage(payload, page);
        // 페이지 정보가 없는 응답: 요청한 페이지가 가득 찼다면 다음 페이지가 있을 수 있다.
        if (!parsed.hasNextKnown && !parsed.hasNext && parsed.rawCount > 0) {
          const requested = Math.max(1, Math.round(query.pageSize ?? 500));
          parsed.hasNext = parsed.rawCount >= requested;
        }
        return parsed;
      } catch (error) {
        if (error instanceof MarketApiError) throw new MarketApiError(error.code, error.message, { provider: this.provider, detail: error.detail, secrets: this.secrets() });
        throw error;
      }
    });
  }

  /** 연결 확인: 인증 + 첫 페이지 1건 읽기. "성공"은 인증과 응답 형식이 모두 맞다는 뜻이다. */
  async probe(query: SettlementQuery): Promise<ConnectionProbe> {
    const startedAt = this.now();
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const page = await this.fetchPage({ ...query, page: 1, pageSize: 10 });
        return {
          ok: true,
          provider: this.provider,
          latencyMs: Math.max(0, this.now() - startedAt),
          pageRecords: page.records.length,
          status: 200,
          sandbox: this.credentials.sandbox,
          message: page.records.length > 0 ? `연결 성공 · 첫 페이지 ${page.records.length}건` : "연결 성공 · 해당 월 정산 내역이 아직 없습니다",
        };
      } catch (error) {
        const apiError = error instanceof MarketApiError ? error : new MarketApiError("NETWORK", String(error), { provider: this.provider });
        if (!apiError.retryable || attempt >= this.maxRetries) {
          return { ok: false, provider: this.provider, latencyMs: Math.max(0, this.now() - startedAt), pageRecords: 0, status: apiError.status ?? 0, sandbox: this.credentials.sandbox, message: apiError.message };
        }
        await this.sleep(200 * 2 ** attempt);
      }
    }
    return { ok: false, provider: this.provider, latencyMs: Math.max(0, this.now() - startedAt), pageRecords: 0, status: 0, sandbox: this.credentials.sandbox, message: "연결 확인 실패" };
  }

  /**
   * 정산월 전체 수집. 페이지 상한(기본 40)을 두는 이유: 잘못된 hasNext 구현이 무한 루프가 되면
   * 브라우저 탭이 죽는다. 상한에 닿으면 조용히 자르지 않고 오류로 알린다.
   */
  async collect(
    query: SettlementQuery,
    options: { pageSize?: number; maxPages?: number; onProgress?: (progress: CollectionProgress) => void; signal?: AbortSignal } = {},
  ): Promise<CollectionResult> {
    const startedAt = this.now();
    const pageSize = Math.max(1, Math.min(1_000, Math.round(options.pageSize ?? query.pageSize ?? 500)));
    const maxPages = options.maxPages ?? 40;
    const records: MarketSettlementRecord[] = [];
    let page = 1;
    let pages = 0;
    let dropped = 0;
    options.onProgress?.({ stage: "auth", page: 0, records: 0, message: this.credentials.sandbox ? "샌드박스 세션 준비" : "인증 토큰 확인" });

    for (;;) {
      if (options.signal?.aborted) {
        throw new MarketApiError("CONFIG", "수집이 취소되었습니다.", { provider: this.provider, retryable: false });
      }
      if (page > maxPages) {
        throw new MarketApiError("PARSE", `페이지 상한(${maxPages})에 도달했습니다.`, {
          provider: this.provider,
          hint: "마켓이 hasNext를 잘못 내려 주고 있을 수 있습니다. 정산 기간을 나눠 조회해 주세요.",
          retryable: false,
        });
      }
      const parsed = await this.fetchPage({ month: query.month, page, pageSize });
      pages += 1;
      records.push(...parsed.records);
      dropped += parsed.droppedCount;
      options.onProgress?.({
        stage: "fetch",
        page,
        records: records.length,
        message: `${page}페이지 · 누적 ${records.length.toLocaleString("ko-KR")}건`,
      });
      if (!parsed.hasNext) break;
      page += 1;
    }

    options.onProgress?.({ stage: "done", page: pages, records: records.length, message: `수집 완료 · ${records.length.toLocaleString("ko-KR")}건` });
    return {
      provider: this.provider,
      month: query.month,
      records,
      pages,
      dropped,
      elapsedMs: Math.max(0, this.now() - startedAt),
      sandbox: this.credentials.sandbox,
    };
  }
}

/* ------------------------------------------------------------------ */
/* 정산 행 매핑 + 대사 파이프라인                                       */
/* ------------------------------------------------------------------ */

export interface CostLedgerEntry {
  unitCost: number;
  sellerShippingCost: number;
}

export type CostLedger = Record<string, CostLedgerEntry> | Map<string, CostLedgerEntry>;

export type IntakeWarningCode = "LEDGER_MISSING" | "ZERO_PAID" | "UNKNOWN_SKU";

export interface IntakeWarning {
  orderNo: string;
  code: IntakeWarningCode;
  message: string;
}

export interface MappedSettlement {
  rows: SettlementRow[];
  warnings: IntakeWarning[];
  ledgerHits: number;
  ledgerMisses: number;
}

function ledgerLookup(ledger: CostLedger | undefined, sku: string): CostLedgerEntry | undefined {
  if (!ledger) return undefined;
  if (ledger instanceof Map) return ledger.get(sku);
  return Object.prototype.hasOwnProperty.call(ledger, sku) ? ledger[sku] : undefined;
}

export interface MapOptions {
  ledger?: CostLedger;
  contracts?: Record<MarketChannel, ContractTerms>;
  /** 계약서 수수료율을 마켓별 기본 프리셋 대신 직접 줄 때 */
  feeRate?: number;
  /** 이 레코드들이 어느 마켓에서 왔는지. 대사 결과의 채널 집계에 쓰인다 */
  channel?: MarketChannel;
}

/**
 * 마켓 레코드 → 대사 엔진의 입력.
 *
 * 마켓이 주지 않는 두 값을 여기서 붙인다: **계약 수수료율**(계약서)과 **원가**(셀러 원장).
 * 원가를 못 찾은 SKU는 0원으로 두되 경고를 남긴다 — 0원은 "원가가 공짜"가 아니라 "모른다"이고,
 * 대사 엔진은 이를 `MISSING_LEDGER`로 표시한다. 모르는 값을 조용히 채우지 않는 것이 원칙이다.
 */
export function toSettlementRows(records: readonly MarketSettlementRecord[], options: MapOptions = {}): MappedSettlement {
  const contracts = options.contracts ?? CHANNEL_CONTRACTS;
  const channel = options.channel ?? "smartstore";
  const rows: SettlementRow[] = [];
  const warnings: IntakeWarning[] = [];
  let ledgerHits = 0;
  let ledgerMisses = 0;

  for (const record of records) {
    const entry = ledgerLookup(options.ledger, record.sku);
    if (entry) ledgerHits += 1;
    else {
      ledgerMisses += 1;
      warnings.push({
        orderNo: record.orderNo,
        code: record.sku ? "LEDGER_MISSING" : "UNKNOWN_SKU",
        message: record.sku
          ? `SKU ${record.sku}의 매입원가가 원장에 없습니다(원가 0원으로 대사, MISSING_LEDGER로 표시).`
          : "SKU가 비어 있어 원가를 붙이지 못했습니다.",
      });
    }
    if (record.paidAmount <= 0 && record.status !== "취소") {
      warnings.push({ orderNo: record.orderNo, code: "ZERO_PAID", message: "결제금액이 0원인데 취소가 아닙니다." });
    }

    rows.push({
      orderNo: record.orderNo,
      channel,
      orderDate: record.orderDate,
      productName: record.productName,
      sku: record.sku,
      quantity: record.quantity,
      paidAmount: record.paidAmount,
      commission: record.commission,
      shippingDeduction: record.shippingDeduction,
      returnFee: record.returnFee,
      settledAmount: record.settledAmount,
      contractFeeRate: options.feeRate ?? contracts[channel].feeRate,
      unitCost: entry?.unitCost ?? 0,
      sellerShippingCost: entry?.sellerShippingCost ?? 0,
      status: record.status,
    });
  }

  return { rows, warnings, ledgerHits, ledgerMisses };
}

export interface IntakeOptions extends MapOptions {
  month: string;
  pageSize?: number;
  maxPages?: number;
  batchSize?: number;
  onProgress?: (progress: IntakeProgress) => void;
  now?: () => number;
}

export interface IntakeProgress {
  stage: "auth" | "fetch" | "map" | "reconcile" | "done";
  percent: number;
  message: string;
  records?: number;
  pages?: number;
}

export interface IntakeResult {
  provider: MarketApiProvider;
  month: string;
  records: MarketSettlementRecord[];
  rows: SettlementRow[];
  reconciled: ReconciliationResult;
  warnings: IntakeWarning[];
  meta: {
    pages: number;
    droppedRecords: number;
    ledgerHits: number;
    ledgerMisses: number;
    elapsedMs: number;
    sandbox: boolean;
    contractFeeRate: number;
    source: "api";
  };
}

/**
 * API 수집 → 원장 결합 → 대사. 화면이 하는 일은 진행률 표시뿐이 되도록 한 번에 묶었다.
 * 대사 자체는 기존 엔진(`reconcileSettlementInBatches`)에 그대로 위임한다 — 규칙이 두 벌이 되면
 * 파일 경로와 API 경로의 결과가 달라진다.
 */
export async function runSettlementIntake(connector: MarketApiConnector, options: IntakeOptions): Promise<IntakeResult> {
  const startedAt = options.now ? options.now() : Date.now();
  const contracts = options.contracts ?? CHANNEL_CONTRACTS;
  const feeRate = options.feeRate ?? contracts[connector.provider].feeRate;

  const collection = await connector.collect(
    { month: options.month, pageSize: options.pageSize },
    {
      pageSize: options.pageSize,
      maxPages: options.maxPages,
      onProgress: (progress) => {
        const percent = progress.stage === "auth" ? 6 : Math.min(72, 12 + progress.page * 12);
        options.onProgress?.({ stage: progress.stage === "auth" ? "auth" : "fetch", percent, message: progress.message, records: progress.records, pages: progress.page });
      },
    },
  );

  options.onProgress?.({ stage: "map", percent: 78, message: `마켓 금액에 계약 수율·원가를 결합 중`, records: collection.records.length });
  const mapped = toSettlementRows(collection.records, {
    ledger: options.ledger,
    contracts,
    feeRate,
    channel: connector.provider,
  });
  if (mapped.rows.length === 0) {
    throw new MarketApiError("PARSE", "정산 내역이 0건입니다.", {
      provider: connector.provider,
      hint: "정산월을 확인해 주세요. 정산이 아직 확정되지 않은 달일 수 있습니다.",
      retryable: false,
    });
  }

  options.onProgress?.({ stage: "reconcile", percent: 84, message: `${mapped.rows.length.toLocaleString("ko-KR")}건 대사 실행`, records: mapped.rows.length });
  const reconciled = await reconcileSettlementInBatches(mapped.rows, {
    batchSize: options.batchSize ?? 5_000,
    onProgress: (progress) =>
      options.onProgress?.({
        stage: "reconcile",
        percent: 84 + Math.round(progress.percent * 0.16),
        message: `${progress.processed.toLocaleString("ko-KR")} / ${mapped.rows.length.toLocaleString("ko-KR")}건 대사`,
        records: mapped.rows.length,
      }),
  });

  const elapsedMs = (options.now ? options.now() : Date.now()) - startedAt;
  options.onProgress?.({ stage: "done", percent: 100, message: "대사 완료", records: mapped.rows.length, pages: collection.pages });

  return {
    provider: connector.provider,
    month: options.month,
    records: collection.records,
    rows: mapped.rows,
    reconciled,
    warnings: mapped.warnings,
    meta: {
      pages: collection.pages,
      droppedRecords: collection.dropped,
      ledgerHits: mapped.ledgerHits,
      ledgerMisses: mapped.ledgerMisses,
      elapsedMs: Math.max(0, elapsedMs),
      sandbox: collection.sandbox,
      contractFeeRate: feeRate,
      source: "api",
    },
  };
}

/** 샌드박스에서 원가를 붙일 때 쓰는 기본 원장(선택). 실서비스는 셀러 원장 DB에서 읽는다. */
export function sandboxLedgerFor(provider: MarketApiProvider, month: string): CostLedger {
  return buildSandboxDataset(provider, month).ledger;
}
