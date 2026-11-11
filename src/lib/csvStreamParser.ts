/**
 * 대용량 정산 CSV 스트리밍 파서
 *
 * 문제
 * ----
 * 스마트스토어·쿠팡 정산서는 3~6개월 치를 한 파일로 받으면 5만~30만 행이 된다.
 * `file.text()`로 통째로 읽고 `split("\n")`으로 자르면 두 가지가 무너진다.
 *
 *   1) **메모리**: 20만 행 × 15열이면 문자열만 수십 MB, 파싱된 객체까지 포함하면 수백 MB.
 *      모바일 브라우저에서는 탭이 죽는다(스왑 또는 OOM).
 *   2) **반응성**: 파싱과 매핑이 한 번에 메인 스레드를 점유해 UI가 수 초간 얼어붙는다.
 *
 * 해결
 * ----
 * - **청크 단위 토크나이저**: 들어오는 문자열 조각의 경계에서 따옴표/이스케이프 상태를 유지한다.
 *   즉 `"...","서울, 강남"` 처럼 필드 안에 쉼표가 있어도, 잘린 위치가 필드 중간이어도 안전하다.
 * - **배치 양보**: N행마다 `setTimeout(0)`으로 이벤트 루프에 제어를 돌려준다. 진행률 UI가 산다.
 * - **행 단위 오류 격리**: 한 행이 깨져도 파일 전체를 버리지 않는다. 오류 행은 사유·행번호와
 *   함께 격리하고, 나머지 정상 행으로 대사를 계속한다. (실무 정산서는 항상 몇 행이 깨져 있다)
 *
 * 이 모듈은 Node(테스트)와 브라우저에서 동일하게 동작한다. DOM API에 의존하지 않는다.
 */

import type { MarketChannel, OrderStatus, SettlementRow } from "./reconciliationEngine";
import { roundWon } from "./reconciliationEngine";
import { SETTLEMENT_CSV_HEADERS } from "./settlementFixtures";

/* ------------------------------------------------------------------ */
/* 토크나이저                                                          */
/* ------------------------------------------------------------------ */

/** 토크나이저가 뽑아낸 레코드. `corrupted`는 필드 길이 제한을 넘긴 행이다. */
export interface CsvRecord {
  fields: string[];
  /** 1부터 시작하는 원본 파일 행 번호(헤더 포함) */
  line: number;
  corrupted: boolean;
}

export interface CsvTokenizerOptions {
  delimiter?: string;
  /** 한 필드의 최대 길이(문자). 초과 시 해당 행을 corrupted로 표시한다. */
  maxFieldChars?: number;
}

/**
 * 청크 경계를 넘어 상태를 유지하는 CSV 토크나이저.
 *
 * RFC 4180 규칙을 따른다: 따옴표로 감싼 필드 안의 쉼표·개행은 데이터, `""`는 따옴표 한 개.
 * 청크가 따옴표 바로 뒤에서 끊기는 경우(`pendingQuote`)를 따로 기억해 다음 조각에서 판정한다.
 */
export class CsvTokenizer {
  private readonly delimiter: string;
  private readonly maxFieldChars: number;

  private fields: string[] = [];
  private field = "";
  private inQuotes = false;
  private pendingQuote = false;
  private lineNumber = 0;
  private sawBom = false;
  private corrupted = false;

  constructor(options: CsvTokenizerOptions = {}) {
    this.delimiter = options.delimiter ?? ",";
    this.maxFieldChars = options.maxFieldChars ?? 64 * 1024;
  }

  get bomStripped(): boolean {
    return this.sawBom;
  }

  /** 청크를 넣고, 완성된 레코드만 돌려준다. 마지막 미완성 레코드는 내부 버퍼에 남는다. */
  push(chunk: string): CsvRecord[] {
    let text = chunk;
    if (!this.sawBom && this.lineNumber === 0 && this.field === "" && this.fields.length === 0) {
      if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
        this.sawBom = true;
      }
    }

    const records: CsvRecord[] = [];
    let index = 0;

    while (index < text.length) {
      // 이전 청크에서 따옴표 하나를 보류해 둔 경우
      if (this.pendingQuote) {
        this.pendingQuote = false;
        if (text[index] === '"') {
          this.appendChar('"');
          index += 1;
          continue;
        }
        this.inQuotes = false;
        // 현재 문자는 따옴표 밖 상태로 다시 처리한다.
      }

      const char = text[index] as string;

      if (this.inQuotes) {
        if (char === '"') {
          if (index + 1 >= text.length) {
            this.pendingQuote = true;
            index += 1;
            continue;
          }
          if (text[index + 1] === '"') {
            this.appendChar('"');
            index += 2;
            continue;
          }
          this.inQuotes = false;
          index += 1;
          continue;
        }
        this.appendChar(char);
        index += 1;
        continue;
      }

      if (char === '"' && this.field.length === 0) {
        this.inQuotes = true;
        index += 1;
        continue;
      }

      if (char === this.delimiter) {
        this.fields.push(this.field);
        this.field = "";
        index += 1;
        continue;
      }

      if (char === "\n") {
        records.push(this.finishRecord());
        index += 1;
        continue;
      }

      if (char === "\r") {
        // CRLF는 \n에서 처리한다. 단독 CR은 개행으로 본다.
        if (index + 1 < text.length && text[index + 1] === "\n") {
          index += 1;
          continue;
        }
        records.push(this.finishRecord());
        index += 1;
        continue;
      }

      this.appendChar(char);
      index += 1;
    }

    return records;
  }

  /** 남아 있는 마지막 레코드를 마감한다. */
  flush(): CsvRecord[] {
    if (this.pendingQuote) {
      this.pendingQuote = false;
      this.inQuotes = false;
    }
    if (this.field === "" && this.fields.length === 0) return [];
    const record = this.finishRecord();
    return record.fields.length === 1 && record.fields[0] === "" ? [] : [record];
  }

  private appendChar(char: string): void {
    if (this.field.length >= this.maxFieldChars) {
      this.corrupted = true;
      return;
    }
    this.field += char;
  }

  private finishRecord(): CsvRecord {
    this.fields.push(this.field);
    this.field = "";
    this.lineNumber += 1;
    const record: CsvRecord = {
      fields: this.fields,
      line: this.lineNumber,
      corrupted: this.corrupted || this.inQuotes,
    };
    this.fields = [];
    this.corrupted = false;
    this.inQuotes = false;
    return record;
  }
}

/* ------------------------------------------------------------------ */
/* 헤더 매핑                                                           */
/* ------------------------------------------------------------------ */

type FieldKey =
  | "orderNo"
  | "channel"
  | "orderDate"
  | "productName"
  | "sku"
  | "quantity"
  | "paidAmount"
  | "commission"
  | "shippingDeduction"
  | "returnFee"
  | "settledAmount"
  | "contractFeeRate"
  | "unitCost"
  | "sellerShippingCost"
  | "status";

/**
 * 헤더 별칭.
 * 같은 값을 마켓마다 다르게 부른다(마켓수수료/판매수수료/수수료, 실정산액/정산금액/입금액).
 * 별칭을 한 곳에 모아 두면 새 마켓 정산서를 붙일 때 이 표만 늘리면 된다.
 */
const HEADER_ALIASES: Record<FieldKey, string[]> = {
  orderNo: ["주문번호", "주문번호(orderid)", "orderid", "orderno", "order_no", "주문id", "주문아이디"],
  channel: ["채널", "마켓", "판매채널", "channel", "market", "플랫폼"],
  orderDate: ["주문일", "주문일자", "결제일", "orderdate", "order_date", "date", "일자"],
  productName: ["상품명", "상품", "productname", "product", "product_name"],
  sku: ["sku", "상품코드", "sellerproductcode", "셀러상품코드", "관리코드"],
  quantity: ["수량", "주문수량", "quantity", "qty"],
  paidAmount: ["결제금액", "결제금액(원)", "판매금액", "paidamount", "paid_amount", "결제액", "gross"],
  commission: ["마켓수수료", "판매수수료", "수수료", "commission", "fee", "수수료금액"],
  shippingDeduction: ["배송비차감액", "배송비차감", "배송비", "shippingdeduction", "shipping_deduction", "배송비공제"],
  returnFee: ["반품비", "반품배송비", "returnfee", "return_fee", "반품차감"],
  settledAmount: ["실정산액", "정산액", "정산금액", "입금액", "settledamount", "settled_amount", "settlement"],
  contractFeeRate: ["계약수수료율", "수수료율", "contractfeerate", "contract_fee_rate", "feerate"],
  unitCost: ["매입원가", "원가", "unitcost", "unit_cost", "cost"],
  sellerShippingCost: ["실배송원가", "배송원가", "sellershipingcost", "seller_shipping_cost", "shippingcost"],
  status: ["주문상태", "상태", "status", "orderstatus"],
};

/** 필수 열 — 없으면 파일을 잘못 읽은 것이므로 조용히 넘어가지 않고 즉시 실패한다. */
const REQUIRED_FIELDS: FieldKey[] = ["orderNo", "channel", "paidAmount", "settledAmount"];

/** 헤더 정규화: 소문자화 + 공백/밑줄/가운뎃점 제거 */
function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_\-./·]/g, "");
}

const ALIAS_LOOKUP: Map<string, FieldKey> = (() => {
  const map = new Map<string, FieldKey>();
  for (const key of Object.keys(HEADER_ALIASES) as FieldKey[]) {
    for (const alias of HEADER_ALIASES[key]) {
      map.set(normalizeHeader(alias), key);
    }
  }
  return map;
})();

/** CSV 한글 헤더 순서(샘플 파일 생성기와 동일) */
export const CSV_HEADER_ORDER: readonly string[] = SETTLEMENT_CSV_HEADERS;

/* ------------------------------------------------------------------ */
/* 값 파싱                                                             */
/* ------------------------------------------------------------------ */

const CHANNEL_ALIASES: Record<string, MarketChannel> = {
  smartstore: "smartstore",
  스마트스토어: "smartstore",
  네이버: "smartstore",
  naver: "smartstore",
  coupang: "coupang",
  쿠팡: "coupang",
  "11번가": "elevenst",
  "11st": "elevenst",
  elevenst: "elevenst",
  gmarket: "gmarket",
  지마켓: "gmarket",
  옥션: "gmarket",
  auction: "gmarket",
};

const STATUS_ALIASES: Record<string, OrderStatus> = {
  배송완료: "배송완료",
  delivered: "배송완료",
  반품완료: "반품완료",
  returned: "반품완료",
  취소: "취소",
  canceled: "취소",
  cancelled: "취소",
  교환완료: "교환완료",
  exchanged: "교환완료",
};

/** 금액 문자열 → 정수 원. `₩12,000`, `12000원`, `(1,200)`(음수 표기)를 모두 받는다. */
export function parseWonValue(raw: string): number {
  const text = raw.trim();
  if (text === "" || text === "-" || text === "—") return 0;
  const negative = /^\(.*\)$/.test(text) || text.startsWith("-");
  const digits = text.replace(/[^\d.]/g, "");
  if (digits === "") throw new Error(`금액 형식이 아닙니다: "${raw}"`);
  const value = Number(digits);
  if (!Number.isFinite(value)) throw new Error(`금액 형식이 아닙니다: "${raw}"`);
  return roundWon(negative ? -value : value);
}

/** 율 문자열 → 숫자(%). `3.63%` → 3.63 */
export function parseRateValue(raw: string): number {
  const text = raw.trim();
  if (text === "") return 0;
  const value = Number(text.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(value)) throw new Error(`수수료율 형식이 아닙니다: "${raw}"`);
  return value;
}

/** 날짜 문자열 → YYYY-MM-DD */
export function parseOrderDate(raw: string): string {
  const text = raw.trim();
  if (text === "") throw new Error("주문일이 비어 있습니다.");
  const compact = text.replace(/[^\d]/g, "");
  if (compact.length === 8) {
    const year = compact.slice(0, 4);
    const month = compact.slice(4, 6);
    const day = compact.slice(6, 8);
    return `${year}-${month}-${day}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  throw new Error(`주문일 형식이 아닙니다: "${raw}"`);
}

export function parseChannelValue(raw: string): MarketChannel {
  const key = normalizeHeader(raw);
  const channel = CHANNEL_ALIASES[key];
  if (!channel) throw new Error(`알 수 없는 채널입니다: "${raw}"`);
  return channel;
}

export function parseStatusValue(raw: string): OrderStatus {
  const key = normalizeHeader(raw);
  const status = STATUS_ALIASES[key];
  if (!status) throw new Error(`알 수 없는 주문 상태입니다: "${raw}"`);
  return status;
}

/* ------------------------------------------------------------------ */
/* 행 매퍼                                                             */
/* ------------------------------------------------------------------ */

export interface ParseError {
  /** 1부터 시작하는 원본 파일 행 번호(헤더 포함) */
  line: number;
  field?: string;
  message: string;
  /** 문제가 된 원본 값 (개인정보 최소화를 위해 40자로 자른다) */
  raw?: string;
}

export interface SettlementRowMapper {
  /** 헤더 배열을 받아 열 인덱스 맵을 만든다. 필수 열이 없으면 예외. */
  readonly headerMap: Map<FieldKey, number>;
  /** 레코드 하나를 정산 행으로 변환한다. 실패하면 ParseError를 돌려준다. */
  map(record: CsvRecord): { row: SettlementRow; error?: undefined } | { row?: undefined; error: ParseError };
}

/** 필수 열 누락 — 파일 자체를 읽을 수 없는 경우 */
export class SettlementCsvSchemaError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`정산서에 필요한 열이 없습니다: ${missing.join(", ")}`);
    this.name = "SettlementCsvSchemaError";
    this.missing = missing;
  }
}

function buildHeaderMap(headerFields: string[]): Map<FieldKey, number> {
  const map = new Map<FieldKey, number>();
  headerFields.forEach((label, index) => {
    const key = ALIAS_LOOKUP.get(normalizeHeader(label));
    if (key && !map.has(key)) map.set(key, index);
  });
  const missing = REQUIRED_FIELDS.filter((key) => !map.has(key)).map((key) => HEADER_ALIASES[key][0] ?? key);
  if (missing.length > 0) throw new SettlementCsvSchemaError(missing);
  return map;
}

function readField(record: CsvRecord, headerMap: Map<FieldKey, number>, key: FieldKey): string | undefined {
  const index = headerMap.get(key);
  if (index === undefined) return undefined;
  return record.fields[index];
}

/** 정산서 행 매퍼 생성. 헤더가 바뀌어도 매퍼 하나만 새로 만들면 된다. */
export function createSettlementRowMapper(headerFields: string[]): SettlementRowMapper {
  const headerMap = buildHeaderMap(headerFields);

  return {
    headerMap,
    map(record) {
      const fail = (message: string, field?: string, raw?: string): { error: ParseError } => ({
        error: {
          line: record.line,
          field,
          message,
          raw: raw ? raw.slice(0, 40) : undefined,
        },
      });

      if (record.corrupted) return fail("행 구조가 깨졌습니다(따옴표 또는 필드 길이 초과).");
      if (record.fields.length <= 1) return fail("빈 행입니다.");

      try {
        const orderNo = (readField(record, headerMap, "orderNo") ?? "").trim();
        if (orderNo === "") return fail("주문번호가 비어 있습니다.", "orderNo");

        const channel = parseChannelValue(readField(record, headerMap, "channel") ?? "");
        const paidAmount = parseWonValue(readField(record, headerMap, "paidAmount") ?? "0");
        if (paidAmount < 0) return fail("결제금액이 음수입니다.", "paidAmount");

        const quantityRaw = readField(record, headerMap, "quantity");
        const quantity = quantityRaw ? Math.max(1, Math.round(parseWonValue(quantityRaw))) : 1;

        const statusRaw = readField(record, headerMap, "status");
        const status: OrderStatus = statusRaw ? parseStatusValue(statusRaw) : "배송완료";

        const dateRaw = readField(record, headerMap, "orderDate");
        const orderDate = dateRaw ? parseOrderDate(dateRaw) : "1970-01-01";

        const rateRaw = readField(record, headerMap, "contractFeeRate");
        const contractFeeRate = rateRaw ? parseRateValue(rateRaw) : 0;

        // 계약 수수료율 열이 없는 정산서도 있다. 그 경우 실효 수수료율을 계약값으로 간주한다.
        const commission = readField(record, headerMap, "commission");
        const effectiveRate =
          contractFeeRate > 0
            ? contractFeeRate
            : paidAmount > 0 && commission
              ? Math.round((parseWonValue(commission) / paidAmount) * 10_000) / 100
              : 0;

        const row: SettlementRow = {
          orderNo,
          channel,
          orderDate,
          productName: (readField(record, headerMap, "productName") ?? "").trim() || "상품명 미상",
          sku: (readField(record, headerMap, "sku") ?? "").trim() || `UNKNOWN-${orderNo}`,
          quantity,
          paidAmount,
          commission: parseWonValue(readField(record, headerMap, "commission") ?? "0"),
          shippingDeduction: parseWonValue(readField(record, headerMap, "shippingDeduction") ?? "0"),
          returnFee: parseWonValue(readField(record, headerMap, "returnFee") ?? "0"),
          settledAmount: parseWonValue(readField(record, headerMap, "settledAmount") ?? "0"),
          contractFeeRate: effectiveRate,
          unitCost: parseWonValue(readField(record, headerMap, "unitCost") ?? "0"),
          sellerShippingCost: parseWonValue(readField(record, headerMap, "sellerShippingCost") ?? "0"),
          status,
        };

        return { row };
      } catch (error) {
        const message = error instanceof Error ? error.message : "알 수 없는 파싱 오류";
        return fail(message);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* 진행률 · 결과 타입                                                  */
/* ------------------------------------------------------------------ */

export interface ParseProgress {
  engine: ParseEngine;
  /** 0~100 */
  percent: number;
  /** 진행 단계. 엑셀 파일은 변환(convert) → 파싱(parse) 두 구간을 지난다. */
  stage?: "convert" | "parse";
  /** 읽은 데이터 행 수(헤더 제외, 오류 포함) */
  processedRows: number;
  /** 정상 변환된 행 수 */
  parsedRows: number;
  /** 격리된 오류 행 수 */
  errorRows: number;
  bytesRead: number;
  totalBytes: number;
  rowsPerSecond: number;
  elapsedMs: number;
}

export type ParseEngine = "main-thread" | "worker";

export interface ParseMeta {
  engine: ParseEngine;
  bytesRead: number;
  elapsedMs: number;
  rowsPerSecond: number;
  chunkCount: number;
  bom: boolean;
  duplicateOrderCount: number;
  /** 원본 파일 형식. 엑셀은 워커에서 CSV로 변환한 뒤 같은 파이프라인을 탄다. */
  sourceFormat?: "csv" | "tsv" | "xlsx";
  /** 엑셀일 때 읽은 시트 이름 */
  sheetName?: string;
  /** 엑셀에서 변환된 데이터 행 수(헤더 제외) */
  convertedRowCount?: number;
  /** 행 상한(20만)을 넘어 잘렸는지 */
  truncated?: boolean;
}

export interface SettlementParseResult {
  rows: SettlementRow[];
  errors: ParseError[];
  /** 전체 오류 행 수(샘플은 최대 maxErrorSamples개) */
  errorCount: number;
  /** 데이터 행 수(헤더 제외) */
  totalLines: number;
  meta: ParseMeta;
}

export interface SettlementParseOptions {
  delimiter?: string;
  /** 진행률 콜백 호출 주기(행) */
  progressEveryRows?: number;
  /** 보관할 오류 샘플 최대 개수 */
  maxErrorSamples?: number;
  /** 시간 주입(테스트 결정성) */
  now?: () => number;
  /** 이벤트 루프 양보 여부 */
  yieldToEventLoop?: boolean;
  onProgress?: (progress: ParseProgress) => void;
  /** 중단 신호 */
  signal?: { aborted: boolean };
}

const DEFAULT_OPTIONS: Required<Omit<SettlementParseOptions, "onProgress" | "signal">> = {
  delimiter: ",",
  progressEveryRows: 2_000,
  maxErrorSamples: 200,
  now: () => Date.now(),
  yieldToEventLoop: true,
};

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/* ------------------------------------------------------------------ */
/* 파이프라인                                                          */
/* ------------------------------------------------------------------ */

interface PipelineState {
  tokenizer: CsvTokenizer;
  mapper: SettlementRowMapper | null;
  rows: SettlementRow[];
  errors: ParseError[];
  errorCount: number;
  duplicates: number;
  parsedRows: number;
  processedRows: number;
  headerSkipped: boolean;
  seen: Set<string>;
  chunkCount: number;
  bytesRead: number;
  maxErrorSamples: number;
  pendingYield: number;
}

function createState(options: Required<Omit<SettlementParseOptions, "onProgress" | "signal">>): PipelineState {
  return {
    tokenizer: new CsvTokenizer({ delimiter: options.delimiter }),
    mapper: null,
    rows: [],
    errors: [],
    errorCount: 0,
    duplicates: 0,
    parsedRows: 0,
    processedRows: 0,
    headerSkipped: false,
    seen: new Set<string>(),
    chunkCount: 0,
    bytesRead: 0,
    maxErrorSamples: options.maxErrorSamples,
    pendingYield: 0,
  };
}

function handleRecords(state: PipelineState, records: CsvRecord[]): void {
  for (const record of records) {
    if (!state.headerSkipped) {
      // 첫 레코드는 헤더. 스키마 오류는 여기서 즉시 던진다(파일 전체 불가).
      state.mapper = createSettlementRowMapper(record.fields);
      state.headerSkipped = true;
      continue;
    }

    if (record.fields.length === 1 && (record.fields[0] ?? "").trim() === "") continue;

    state.processedRows += 1;
    const mapper = state.mapper;
    if (!mapper) continue;

    const result = mapper.map(record);
    if (result.error) {
      state.errorCount += 1;
      if (state.errors.length < state.maxErrorSamples) state.errors.push(result.error);
      continue;
    }

    const row = result.row;
    const key = `${row.channel}:${row.orderNo}`;
    if (state.seen.has(key)) {
      // 같은 주문이 두 번 들어오면 정산이 두 번 계산된다. 조용히 넘기지 않는다.
      state.duplicates += 1;
      state.errorCount += 1;
      if (state.errors.length < state.maxErrorSamples) {
        state.errors.push({
          line: record.line,
          field: "orderNo",
          message: `중복 주문번호입니다(${row.orderNo}). 두 번째 행부터는 제외했습니다.`,
        });
      }
      continue;
    }

    state.seen.add(key);
    state.rows.push(row);
    state.parsedRows += 1;
  }
}

/**
 * 문자열/스트림 조각을 받아 정산 행으로 변환하는 파이프라인.
 * `push`와 `flush`를 나눠 두어 File 스트림, fetch 스트림, 테스트의 임의 분할을 모두 같은 코드로 처리한다.
 */
export class SettlementCsvPipeline {
  private readonly state: PipelineState;
  private readonly options: Required<Omit<SettlementParseOptions, "onProgress" | "signal">>;
  private readonly startedAt: number;
  private readonly engine: ParseEngine;
  private readonly totalBytes: number;
  private lastProgressAt = 0;
  private readonly onProgress?: (progress: ParseProgress) => void;
  private readonly signal?: { aborted: boolean };

  constructor(totalBytes: number, options: SettlementParseOptions = {}, engine: ParseEngine = "main-thread") {
    const { delimiter, progressEveryRows, maxErrorSamples, now, yieldToEventLoop } = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
    this.options = { delimiter, progressEveryRows, maxErrorSamples, now, yieldToEventLoop };
    this.state = createState(this.options);
    this.startedAt = this.options.now();
    this.engine = engine;
    this.totalBytes = Math.max(0, totalBytes);
    this.onProgress = options.onProgress;
    this.signal = options.signal;
  }

  get aborted(): boolean {
    return Boolean(this.signal?.aborted);
  }

  /** 조각을 투입한다. 내부에서 주기적으로 진행률을 알린다. */
  async push(chunk: string): Promise<void> {
    const records = this.state.tokenizer.push(chunk);
    this.state.chunkCount += 1;
    this.state.bytesRead += chunk.length;
    handleRecords(this.state, records);

    if (this.state.processedRows - this.lastProgressAt >= this.options.progressEveryRows) {
      this.lastProgressAt = this.state.processedRows;
      this.emitProgress();
      if (this.options.yieldToEventLoop) await yieldToEventLoop();
    }
  }

  /** 남은 버퍼를 마감하고 결과를 만든다. */
  finish(): SettlementParseResult {
    handleRecords(this.state, this.state.tokenizer.flush());
    this.emitProgress();
    const elapsedMs = Math.max(0, this.options.now() - this.startedAt);
    return {
      rows: this.state.rows,
      errors: this.state.errors,
      errorCount: this.state.errorCount,
      totalLines: this.state.processedRows,
      meta: {
        engine: this.engine,
        bytesRead: this.state.bytesRead,
        elapsedMs,
        rowsPerSecond: elapsedMs > 0 ? Math.round((this.state.processedRows / elapsedMs) * 1000) : 0,
        chunkCount: this.state.chunkCount,
        bom: this.state.tokenizer.bomStripped,
        duplicateOrderCount: this.state.duplicates,
      },
    };
  }

  private emitProgress(): void {
    if (!this.onProgress) return;
    const elapsedMs = Math.max(0, this.options.now() - this.startedAt);
    const percent =
      this.totalBytes > 0
        ? Math.min(100, Math.round((this.state.bytesRead / this.totalBytes) * 100))
        : this.state.processedRows > 0
          ? 100
          : 0;
    this.onProgress({
      engine: this.engine,
      percent,
      processedRows: this.state.processedRows,
      parsedRows: this.state.parsedRows,
      errorRows: this.state.errorCount,
      bytesRead: this.state.bytesRead,
      totalBytes: this.totalBytes,
      rowsPerSecond: elapsedMs > 0 ? Math.round((this.state.processedRows / elapsedMs) * 1000) : 0,
      elapsedMs,
    });
  }
}

/** 문자열 하나를 청크로 잘라 스트리밍 파서에 통과시킨다. */
export async function parseSettlementCsvText(
  text: string,
  options: SettlementParseOptions & { chunkSize?: number; engine?: ParseEngine } = {},
): Promise<SettlementParseResult> {
  const chunkSize = Math.max(1, options.chunkSize ?? 64 * 1024);
  const pipeline = new SettlementCsvPipeline(text.length, options, options.engine ?? "main-thread");

  for (let offset = 0; offset < text.length; offset += chunkSize) {
    if (pipeline.aborted) break;
    await pipeline.push(text.slice(offset, offset + chunkSize));
  }

  return pipeline.finish();
}

/** 미리 잘려 들어오는 문자열 스트림을 그대로 흘려보낸다. */
export async function parseSettlementCsvChunks(
  chunks: AsyncIterable<string>,
  options: SettlementParseOptions & { totalBytes?: number; engine?: ParseEngine } = {},
): Promise<SettlementParseResult> {
  const pipeline = new SettlementCsvPipeline(options.totalBytes ?? 0, options, options.engine ?? "main-thread");
  for await (const chunk of chunks) {
    if (pipeline.aborted) break;
    await pipeline.push(chunk);
  }
  return pipeline.finish();
}

/** 초당 처리량 표기: 12.4만 건/s */
export function formatThroughput(rowsPerSecond: number): string {
  if (!Number.isFinite(rowsPerSecond) || rowsPerSecond <= 0) return "—";
  if (rowsPerSecond >= 10_000) return `${(rowsPerSecond / 10_000).toFixed(1)}만 건/s`;
  return `${Math.round(rowsPerSecond).toLocaleString("ko-KR")}건/s`;
}

/** 바이트 표기: 12.4MB */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`;
}
