/**
 * .xlsx → CSV 변환기 (의존성 0)
 *
 * 왜 필요한가
 * -----------
 * 셀러가 마켓에서 내려받는 정산서는 **대부분 엑셀 파일(.xlsx)**이다. "CSV로 다시 저장해서
 * 올려 주세요"라고 하면 그 순간 제품은 실무에서 죽는다. 그런데 xlsx 파싱 라이브러리
 * (SheetJS 등)는 번들 크기가 수백 KB~1MB이고, CDN/라이선스 이슈도 따라온다.
 *
 * xlsx는 사실 **ZIP 안에 든 XML**이다(xl/worksheets/sheet1.xml, xl/sharedStrings.xml).
 * 그래서 브라우저에 이미 있는 두 가지(중앙 디렉터리에서 ZIP 엔트리 읽기,
 * `DecompressionStream("deflate-raw")`)만으로 필요한 만큼을 직접 구현했다.
 *
 * 지원 범위(정직하게 적는다)
 * ------------------------
 *  - 첫 번째 워크시트의 셀 값(문자열·숫자·날짜서식·인라인 문자열). 수식은 캐시된 값 사용.
 *  - 병합 셀은 좌상단 값만 남는다(엑셀 자체 표시와 같다).
 *  - 구형 바이너리 `.xls`(BIFF)는 ZIP이 아니므로 지원하지 않는다 → 업로드 단계에서 안내.
 *  - 이미지·차트·피벗은 무시한다(정산서에 필요 없다).
 *
 * 변환 결과는 CSV 문자열이므로, 이후 경로(토크나이저·행 매퍼·대사 엔진)는 CSV 업로드와
 * 완전히 동일하다. 파서를 두 벌 유지하지 않는 것이 이 설계의 핵심이다.
 */

/* ------------------------------------------------------------------ */
/* ZIP                                                                 */
/* ------------------------------------------------------------------ */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export class XlsxFormatError extends Error {
  readonly code: "NOT_A_ZIP" | "NO_WORKSHEET" | "UNSUPPORTED_COMPRESSION" | "NO_DEFLATE_SUPPORT" | "TOO_MANY_ROWS";
  constructor(code: XlsxFormatError["code"], message: string) {
    super(message);
    this.name = "XlsxFormatError";
    this.code = code;
  }
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  headerOffset: number;
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

/** EOCD는 ZIP 주석 길이 때문에 끝에서부터 찾아야 한다(고정 오프셋 불가). */
function findEocd(view: DataView): number {
  const limit = Math.min(view.byteLength, 66_000);
  for (let offset = view.byteLength - 22; offset >= view.byteLength - limit && offset >= 0; offset -= 1) {
    if (u32(view, offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

/** 중앙 디렉터리만 읽는다(스트리밍 ZIP의 data descriptor 크기 0 문제를 피한다). */
export function listZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  if (eocd < 0) {
    throw new XlsxFormatError("NOT_A_ZIP", "ZIP 구조를 찾지 못했습니다. .xlsx 파일이 맞는지 확인해 주세요.");
  }
  const count = u16(view, eocd + 10);
  let cursor = u32(view, eocd + 16);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > view.byteLength || u32(view, cursor) !== CENTRAL_SIGNATURE) break;
    const method = u16(view, cursor + 10);
    const compressedSize = u32(view, cursor + 20);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentLength = u16(view, cursor + 32);
    const headerOffset = u32(view, cursor + 42);
    const name = new TextDecoder("utf-8").decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    entries.push({ name, method, compressedSize, headerOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

export type Inflate = (data: Uint8Array) => Promise<Uint8Array>;

/** 브라우저/Node 20의 내장 해제기. 실패하면 원인을 코드로 구분해 던진다. */
const defaultInflate: Inflate = async (data) => {
  if (typeof DecompressionStream === "undefined") {
    throw new XlsxFormatError(
      "NO_DEFLATE_SUPPORT",
      "이 브라우저는 압축 해제(DecompressionStream)를 지원하지 않습니다. 엑셀에서 'CSV UTF-8'로 저장해 업로드해 주세요.",
    );
  }
  try {
    const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (error) {
    throw new XlsxFormatError(
      "UNSUPPORTED_COMPRESSION",
      `압축 해제에 실패했습니다(${error instanceof Error ? error.message : "알 수 없는 오류"}). 엑셀에서 'CSV UTF-8'로 저장해 업로드해 주세요.`,
    );
  }
};

export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry, inflate: Inflate = defaultInflate): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const local = entry.headerOffset;
  if (local + 30 > view.byteLength || u32(view, local) !== LOCAL_SIGNATURE) {
    throw new XlsxFormatError("NOT_A_ZIP", "ZIP 로컬 헤더가 손상되었습니다.");
  }
  const nameLength = u16(view, local + 26);
  const extraLength = u16(view, local + 28);
  const start = local + 30 + nameLength + extraLength;
  const raw = bytes.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflate(raw);
  throw new XlsxFormatError("UNSUPPORTED_COMPRESSION", `지원하지 않는 ZIP 압축 방식입니다(method ${entry.method}).`);
}

async function readEntryByName(bytes: Uint8Array, entries: ZipEntry[], name: string, inflate: Inflate): Promise<string | null> {
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) return null;
  const data = await readZipEntry(bytes, entry, inflate);
  return new TextDecoder("utf-8").decode(data);
}

/* ------------------------------------------------------------------ */
/* XML                                                                 */
/* ------------------------------------------------------------------ */

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

export function decodeXmlText(value: string): string {
  return value
    .replace(/&(amp|lt|gt|quot|apos);/g, (match) => XML_ENTITIES[match] ?? match)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

function attributes(fragment: string): Record<string, string> {
  const map: Record<string, string> = {};
  const pattern = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  for (;;) {
    const match = pattern.exec(fragment);
    if (!match) break;
    const [, key, value] = match;
    if (key && value !== undefined) map[key] = decodeXmlText(value);
  }
  return map;
}

/** sharedStrings.xml → 문자열 목록. `<si>`가 여러 `<t>`로 쪼개질 수 있어 이어 붙인다. */
export function parseSharedStrings(xml: string): string[] {
  const values: string[] = [];
  const siPattern = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  for (;;) {
    const match = siPattern.exec(xml);
    if (!match) break;
    const body = match[1] ?? "";
    const parts: string[] = [];
    const tPattern = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    for (;;) {
      const t = tPattern.exec(body);
      if (!t) break;
      parts.push(decodeXmlText(t[1] ?? ""));
    }
    values.push(parts.join(""));
  }
  return values;
}

/** 열 문자(A, B, ..., AA) → 0-based 인덱스 */
export function columnIndex(ref: string): number {
  let index = 0;
  for (const char of ref) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

/* --- 날짜 서식 ------------------------------------------------------ */

/** 엑셀 내장 날짜 서식 ID (국가별 서식 포함) */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/**
 * styles.xml → "이 셀 스타일 인덱스는 날짜인가" 판정 배열.
 * 날짜 셀의 값은 1900-01-01부터의 일련번호(예: 45678)라서, 서식을 모르면 "45678"이 주문일로 들어온다.
 */
export function parseDateStyles(xml: string): { isDateStyle: (styleIndex: number) => boolean } {
  const customFormats = new Map<number, string>();
  const numFmtPattern = /<numFmt\b([^>]*)\/?>/g;
  for (;;) {
    const match = numFmtPattern.exec(xml);
    if (!match) break;
    const attrs = attributes(match[1] ?? "");
    const id = Number(attrs.numFmtId);
    if (Number.isFinite(id)) customFormats.set(id, attrs.formatCode ?? "");
  }

  const styleFormatIds: number[] = [];
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (cellXfs) {
    const xfPattern = /<xf\b([^>]*)\/?>/g;
    for (;;) {
      const match = xfPattern.exec(cellXfs[1] ?? "");
      if (!match) break;
      styleFormatIds.push(Number(attributes(match[1] ?? "").numFmtId ?? 0));
    }
  }

  const cache = new Map<number, boolean>();
  const isDateFormat = (formatId: number): boolean => {
    if (BUILTIN_DATE_FORMATS.has(formatId)) return true;
    const code = customFormats.get(formatId);
    if (!code) return false;
    // "0.00" 같은 숫자 서식은 제외하고, 연도/일이 들어간 서식만 날짜로 본다.
    return /[yY]/.test(code) || /[dD]/.test(code);
  };

  return {
    isDateStyle(styleIndex: number): boolean {
      if (styleIndex < 0) return false;
      const cached = cache.get(styleIndex);
      if (cached !== undefined) return cached;
      const formatId = styleFormatIds[styleIndex];
      const result = formatId === undefined ? false : isDateFormat(formatId);
      cache.set(styleIndex, result);
      return result;
    },
  };
}

/** 엑셀 일련번호 → YYYY-MM-DD. 1900년 윤년 버그(존재하지 않는 2월 29일)를 보정한다. */
export function excelSerialToDate(serial: number): string {
  if (!Number.isFinite(serial) || serial <= 0) return "";
  const days = Math.floor(serial);
  const adjusted = days < 60 ? days + 1 : days;
  const ms = Date.UTC(1899, 11, 30) + adjusted * 86_400_000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/* ------------------------------------------------------------------ */
/* 워크시트 → 행                                                       */
/* ------------------------------------------------------------------ */

export interface XlsxSheet {
  sheetName: string;
  /** 행 배열. 각 셀은 표시 문자열. */
  rows: string[][];
  truncated: boolean;
}

/** 시트 XML → 2차원 문자열 배열 */
export function parseWorksheet(
  xml: string,
  sharedStrings: readonly string[],
  styleInfo: { isDateStyle: (index: number) => boolean },
  maxRows: number,
): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let truncated = false;
  const rowPattern = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;

  for (;;) {
    const rowMatch = rowPattern.exec(xml);
    if (!rowMatch) break;
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const body = rowMatch[2] ?? "";
    const cells: string[] = [];
    let nextIndex = 0;
    const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

    for (;;) {
      const cellMatch = cellPattern.exec(body);
      if (!cellMatch) break;
      const attrs = attributes(cellMatch[1] ?? "");
      const inner = cellMatch[2] ?? "";
      const ref = attrs.r ?? "";
      const index = ref ? columnIndex(ref) : nextIndex;
      // 빈 셀도 열 위치를 유지해야 헤더 매핑이 어긋나지 않는다.
      while (cells.length < index) cells.push("");

      const type = attrs.t ?? "n";
      const styleIndex = Number(attrs.s ?? -1);
      let value = "";

      if (type === "inlineStr") {
        const parts: string[] = [];
        const tPattern = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        for (;;) {
          const t = tPattern.exec(inner);
          if (!t) break;
          parts.push(decodeXmlText(t[1] ?? ""));
        }
        value = parts.join("");
      } else {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        const raw = v ? decodeXmlText(v[1] ?? "") : "";
        if (type === "s") {
          const sharedIndex = Number(raw);
          value = Number.isFinite(sharedIndex) ? (sharedStrings[sharedIndex] ?? "") : "";
        } else if (type === "str" || type === "e") {
          value = raw;
        } else if (type === "b") {
          value = raw === "1" ? "TRUE" : "FALSE";
        } else if (raw === "") {
          value = "";
        } else if (styleInfo.isDateStyle(styleIndex)) {
          value = excelSerialToDate(Number(raw)) || raw;
        } else {
          value = raw;
        }
      }

      cells[index] = value;
      nextIndex = index + 1;
    }

    // 값이 하나도 없는 행은 CSV에도 넣지 않는다. (엑셀은 서식만 남은 빈 행을 자주 갖고 있다)
    if (cells.some((cell) => cell.trim() !== "")) rows.push(cells);
  }

  return { rows, truncated };
}

/** 2차원 배열 → RFC 4180 CSV */
export function gridToCsv(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => (/[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
        .join(","),
    )
    .join("\r\n");
}

export interface XlsxConvertResult {
  csvText: string;
  sheetName: string;
  rowCount: number;
  truncated: boolean;
  /** 날짜 서식이 없어 일련번호로 남은 값이 있으면 true (UI 경고용) */
  hasNumericDates: boolean;
}

export interface XlsxConvertOptions {
  maxRows?: number;
  inflate?: Inflate;
  /** 변환 진행률(0~1). 워커가 프로그레스 바를 그리는 데 쓴다. */
  onProgress?: (ratio: number) => void;
}

const DEFAULT_MAX_ROWS = 200_000;

/**
 * .xlsx 바이트 → CSV 문자열.
 * 워커에서 호출되므로 DOM에 의존하지 않는다(Blob/DecompressionStream만 사용).
 */
export async function xlsxToCsv(bytes: Uint8Array, options: XlsxConvertOptions = {}): Promise<XlsxConvertResult> {
  const inflate = options.inflate ?? defaultInflate;
  const maxRows = Math.max(1, options.maxRows ?? DEFAULT_MAX_ROWS);
  const report = options.onProgress ?? (() => undefined);
  report(0.02);
  const entries = listZipEntries(bytes);
  report(0.12);

  const workbook = await readEntryByName(bytes, entries, "xl/workbook.xml", inflate);
  const sheetEntry =
    entries.find((entry) => /^xl\/worksheets\/sheet1\.xml$/i.test(entry.name)) ??
    entries
      .filter((entry) => /^xl\/worksheets\/.+\.xml$/i.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))[0];

  if (!sheetEntry) {
    throw new XlsxFormatError("NO_WORKSHEET", "워크시트를 찾지 못했습니다. 엑셀 파일이 비어 있는지 확인해 주세요.");
  }

  const sheetName = workbook ? (/<sheet\b[^>]*name="([^"]*)"/.exec(workbook)?.[1] ?? "Sheet1") : "Sheet1";
  const sheetXml = (await readEntryByName(bytes, entries, sheetEntry.name, inflate)) ?? "";
  const sharedXml = (await readEntryByName(bytes, entries, "xl/sharedStrings.xml", inflate)) ?? "";
  const stylesXml = (await readEntryByName(bytes, entries, "xl/styles.xml", inflate)) ?? "";

  const sharedStrings = sharedXml ? parseSharedStrings(sharedXml) : [];
  const styleInfo = stylesXml ? parseDateStyles(stylesXml) : { isDateStyle: () => false };
  report(0.55);
  const { rows, truncated } = parseWorksheet(sheetXml, sharedStrings, styleInfo, maxRows);
  report(0.9);

  if (rows.length === 0) {
    throw new XlsxFormatError("NO_WORKSHEET", "시트에 값이 없습니다. 정산서 시트를 확인해 주세요.");
  }

  // 완전히 빈 행/열은 CSV에서도 의미가 없어 정리한다(헤더 오프셋을 흔들지 않도록 뒤쪽만).
  const cleaned = rows.filter((row) => row.some((cell) => cell.trim() !== ""));
  const hasNumericDates = cleaned
    .slice(1)
    .some((row) => row.some((cell) => /^\d{5}(\.\d+)?$/.test(cell)));

  report(1);

  return {
    csvText: gridToCsv(cleaned),
    sheetName: decodeXmlText(sheetName),
    rowCount: Math.max(0, cleaned.length - 1),
    truncated,
    hasNumericDates,
  };
}
