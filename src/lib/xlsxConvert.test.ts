import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  columnIndex,
  decodeXmlText,
  excelSerialToDate,
  gridToCsv,
  listZipEntries,
  parseDateStyles,
  parseSharedStrings,
  parseWorksheet,
  xlsxToCsv,
  XlsxFormatError,
} from "./xlsxConvert";
import { parseSettlementCsvText } from "./csvStreamParser";

/* ------------------------------------------------------------------ */
/* 테스트용 최소 ZIP 작성기                                            */
/* ------------------------------------------------------------------ */

interface Entry {
  name: string;
  data: Uint8Array;
  deflate?: boolean;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * ZIP 로컬 헤더 + 중앙 디렉터리 + EOCD를 직접 만든다.
 * 엑셀 파일의 실제 구조를 흉내 내는 것이 목적이므로 압축 방식(0=stored, 8=deflate)을
 * 둘 다 지원한다. CRC는 리더가 검사하지 않지만 실제 파일과 같이 계산해 둔다.
 */
function buildZip(entries: Entry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      table[index] = value >>> 0;
    }
    return table;
  })();
  const crc32 = (data: Uint8Array): number => {
    let crc = 0xffffffff;
    for (const byte of data) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };

  for (const entry of entries) {
    const nameBytes = utf8(entry.name);
    const method = entry.deflate ? 8 : 0;
    const payload = entry.deflate ? new Uint8Array(deflateRawSync(entry.data)) : entry.data;

    const local = new Uint8Array(30 + nameBytes.length + payload.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc32(entry.data), true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(payload, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc32(entry.data), true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

const SHARED_STRINGS = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">
  <si><t>주문번호</t></si>
  <si><t>채널</t></si>
  <si><t>결제금액</t></si>
  <si><t>스마트스토어</t></si>
</sst>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>
  <cellXfs count="3">
    <xf numFmtId="0"/>
    <xf numFmtId="14"/>
    <xf numFmtId="164"/>
  </cellXfs>
</styleSheet>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheets><sheet name="정산내역" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

function sheetXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
      <c r="C1" t="s"><v>2</v></c>
      <c r="D1" t="inlineStr"><is><t>실정산액</t></is></c>
      <c r="E1" t="inlineStr"><is><t>주문일</t></is></c>
    </row>
    <row r="2">
      <c r="A2" t="inlineStr"><is><t>SS2026101501</t></is></c>
      <c r="B2" t="s"><v>3</v></c>
      <c r="C2"><v>27900</v></c>
      <c r="D2"><v>23887</v></c>
      <c r="E2" s="1"><v>45292</v></c>
    </row>
    <row r="3">
      <c r="A3" t="inlineStr"><is><t>SS2026101502</t></is></c>
      <c r="B3" t="s"><v>3</v></c>
      <c r="C3"><v>19900</v></c>
      <c r="D3"><v>16350</v></c>
      <c r="E3" s="2"><v>45293</v></c>
    </row>
    <row r="4"/>
  </sheetData>
</worksheet>`;
}

function buildWorkbook(overrides: { sheet?: string; styles?: string; shared?: string; omitShared?: boolean } = {}): Uint8Array {
  const entries: Entry[] = [
    { name: "xl/workbook.xml", data: utf8(WORKBOOK), deflate: true },
    { name: "xl/worksheets/sheet1.xml", data: utf8(overrides.sheet ?? sheetXml()), deflate: true },
    { name: "xl/styles.xml", data: utf8(overrides.styles ?? STYLES), deflate: true },
  ];
  if (!overrides.omitShared) entries.push({ name: "xl/sharedStrings.xml", data: utf8(overrides.shared ?? SHARED_STRINGS), deflate: true });
  entries.push({ name: "[Content_Types].xml", data: utf8("<Types/>"), deflate: false });
  return buildZip(entries);
}

/* ------------------------------------------------------------------ */

describe("ZIP 읽기", () => {
  it("중앙 디렉터리에서 엔트리를 찾는다", () => {
    const names = listZipEntries(buildWorkbook()).map((entry) => entry.name);
    expect(names).toContain("xl/worksheets/sheet1.xml");
    expect(names).toContain("xl/sharedStrings.xml");
    expect(names).toHaveLength(5);
  });

  it("ZIP이 아니면 NOT_A_ZIP으로 실패한다", async () => {
    const notZip = utf8("<html>로그인이 필요합니다</html>");
    await expect(xlsxToCsv(notZip)).rejects.toBeInstanceOf(XlsxFormatError);
    await expect(xlsxToCsv(notZip)).rejects.toMatchObject({ code: "NOT_A_ZIP" });
  });
});

describe("XML 파싱", () => {
  it("sharedStrings의 여러 <t>를 이어 붙인다", () => {
    const xml = `<sst><si><r><t>부산 </t></r><r><t>문현동</t></r></si><si><t>A &amp; B</t></si></sst>`;
    expect(parseSharedStrings(xml)).toEqual(["부산 문현동", "A & B"]);
  });

  it("엔티티와 유니코드 이스케이프를 푼다", () => {
    expect(decodeXmlText("&lt;b&gt; &#54620;&#xAE00;")).toBe("<b> 한글");
  });

  it("셀 참조를 0-based 열 인덱스로 바꾼다", () => {
    expect(columnIndex("A1")).toBe(0);
    expect(columnIndex("Z9")).toBe(25);
    expect(columnIndex("AA1")).toBe(26);
    expect(columnIndex("AB12")).toBe(27);
  });

  it("내장/사용자 지정 날짜 서식을 모두 날짜로 판정한다", () => {
    const styles = parseDateStyles(STYLES);
    expect(styles.isDateStyle(1)).toBe(true); // numFmtId 14
    expect(styles.isDateStyle(2)).toBe(true); // custom yyyy-mm-dd
    expect(styles.isDateStyle(0)).toBe(false); // 일반
    expect(styles.isDateStyle(99)).toBe(false); // 범위 밖
  });

  it("숫자 서식(0.00)을 날짜로 오인하지 않는다", () => {
    const styles = parseDateStyles(
      `<styleSheet><numFmts><numFmt numFmtId="170" formatCode="0.00"/></numFmts><cellXfs><xf numFmtId="170"/></cellXfs></styleSheet>`,
    );
    expect(styles.isDateStyle(0)).toBe(false);
  });

  it("엑셀 일련번호를 날짜로 바꾼다(1900년 윤년 버그 보정)", () => {
    expect(excelSerialToDate(45292)).toBe("2024-01-01");
    expect(excelSerialToDate(1)).toBe("1900-01-01");
    expect(excelSerialToDate(61)).toBe("1900-03-01");
    expect(excelSerialToDate(0)).toBe("");
  });
});

describe("시트 → CSV", () => {
  it("셀 값을 열 위치에 맞춰 채우고 빈 행은 버린다", () => {
    const { rows } = parseWorksheet(sheetXml(), parseSharedStrings(SHARED_STRINGS), parseDateStyles(STYLES), 100);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual(["주문번호", "채널", "결제금액", "실정산액", "주문일"]);
    expect(rows[1]).toEqual(["SS2026101501", "스마트스토어", "27900", "23887", "2024-01-01"]);
    expect(rows[2]?.[4]).toBe("2024-01-02");
  });

  it("중간에 빈 셀이 있어도 열이 밀리지 않는다", () => {
    const xml = `<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row></sheetData></worksheet>`;
    const { rows } = parseWorksheet(xml, [], { isDateStyle: () => false }, 10);
    expect(rows[0]).toEqual(["1", "", "3"]);
  });

  it("행 상한을 넘으면 truncated로 알린다", () => {
    const { rows, truncated } = parseWorksheet(sheetXml(), parseSharedStrings(SHARED_STRINGS), parseDateStyles(STYLES), 1);
    expect(rows).toHaveLength(1);
    expect(truncated).toBe(true);
  });

  it("CSV로 직렬화할 때 쉼표·따옴표를 인용한다", () => {
    expect(gridToCsv([["a,b", 'c"d'], ["e", "f"]])).toBe('"a,b","c""d"\r\ne,f');
  });
});

describe("xlsxToCsv", () => {
  it("워크시트 이름과 행 수를 함께 돌려준다", async () => {
    const converted = await xlsxToCsv(buildWorkbook());
    expect(converted.sheetName).toBe("정산내역");
    expect(converted.rowCount).toBe(2);
    expect(converted.truncated).toBe(false);
    expect(converted.csvText.split("\r\n")[0]).toBe("주문번호,채널,결제금액,실정산액,주문일");
  });

  it("진행률을 0~1로 보고한다", async () => {
    const ratios: number[] = [];
    await xlsxToCsv(buildWorkbook(), { onProgress: (ratio) => ratios.push(ratio) });
    expect(ratios[0]).toBeLessThan(0.1);
    expect(ratios[ratios.length - 1]).toBe(1);
    expect(ratios.length).toBeGreaterThanOrEqual(4);
  });

  it("변환 결과가 기존 정산 파이프라인을 그대로 통과한다", async () => {
    const converted = await xlsxToCsv(buildWorkbook());
    const parsed = await parseSettlementCsvText(converted.csvText);

    expect(parsed.errorCount).toBe(0);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      orderNo: "SS2026101501",
      channel: "smartstore",
      paidAmount: 27_900,
      settledAmount: 23_887,
      orderDate: "2024-01-01",
    });
  });

  it("sharedStrings가 없어도 인라인 문자열로 읽는다", async () => {
    const sheet = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>주문번호</t></is></c><c r="B1" t="inlineStr"><is><t>채널</t></is></c><c r="C1" t="inlineStr"><is><t>결제금액</t></is></c><c r="D1" t="inlineStr"><is><t>실정산액</t></is></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>X1</t></is></c><c r="B2" t="inlineStr"><is><t>쿠팡</t></is></c><c r="C2"><v>10000</v></c><c r="D2"><v>9000</v></c></row>
    </sheetData></worksheet>`;
    const converted = await xlsxToCsv(buildWorkbook({ sheet, omitShared: true }));
    const parsed = await parseSettlementCsvText(converted.csvText);
    expect(parsed.rows[0]).toMatchObject({ orderNo: "X1", channel: "coupang", paidAmount: 10_000 });
  });

  it("스타일이 없으면 날짜를 일련번호로 남기고 그 사실을 알린다", async () => {
    const converted = await xlsxToCsv(buildWorkbook({ styles: "<styleSheet/>" }));
    expect(converted.hasNumericDates).toBe(true);
  });

  it("시트가 비어 있으면 NO_WORKSHEET으로 실패한다", async () => {
    const empty = `<worksheet><sheetData><row r="1"></row></sheetData></worksheet>`;
    await expect(xlsxToCsv(buildWorkbook({ sheet: empty }))).rejects.toMatchObject({ code: "NO_WORKSHEET" });
  });

  it("stored(무압축) 엔트리도 읽는다", async () => {
    const zip = buildZip([
      { name: "xl/workbook.xml", data: utf8(WORKBOOK) },
      { name: "xl/worksheets/sheet1.xml", data: utf8(sheetXml()) },
      { name: "xl/sharedStrings.xml", data: utf8(SHARED_STRINGS) },
      { name: "xl/styles.xml", data: utf8(STYLES) },
    ]);
    const converted = await xlsxToCsv(zip);
    expect(converted.rowCount).toBe(2);
  });

  it("maxRows를 넘으면 truncated가 true", async () => {
    const converted = await xlsxToCsv(buildWorkbook(), { maxRows: 2 });
    expect(converted.truncated).toBe(true);
  });
});
