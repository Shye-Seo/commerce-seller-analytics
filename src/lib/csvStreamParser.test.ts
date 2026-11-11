import { describe, expect, it } from "vitest";
import {
  createSettlementRowMapper,
  CsvTokenizer,
  formatBytes,
  formatThroughput,
  parseOrderDate,
  parseRateValue,
  parseSettlementCsvText,
  parseWonValue,
  SettlementCsvPipeline,
  SettlementCsvSchemaError,
} from "./csvStreamParser";
import { generateSettlementCsv, generateSettlementRows } from "./settlementFixtures";

const HEADER = "주문번호,채널,주문일,상품명,SKU,수량,결제금액,마켓수수료,배송비차감액,반품비,실정산액,계약수수료율,매입원가,실배송원가,주문상태";

function csvLine(overrides: Partial<Record<string, string>> = {}): string {
  const values: Record<string, string> = {
    orderNo: "SS0001",
    channel: "smartstore",
    date: "2026-10-15",
    name: "소이 캔들 200g",
    sku: "SG-CANDLE-01",
    qty: "1",
    paid: "27900",
    commission: "1013",
    shipping: "3000",
    returnFee: "0",
    settled: "23887",
    rate: "3.63",
    cost: "12800",
    sellerShipping: "2800",
    status: "배송완료",
    ...overrides,
  };
  return [
    values.orderNo,
    values.channel,
    values.date,
    values.name,
    values.sku,
    values.qty,
    values.paid,
    values.commission,
    values.shipping,
    values.returnFee,
    values.settled,
    values.rate,
    values.cost,
    values.sellerShipping,
    values.status,
  ].join(",");
}

describe("값 파서", () => {
  it("금액 표기에서 원 단위 정수를 뽑는다", () => {
    expect(parseWonValue("27,900")).toBe(27_900);
    expect(parseWonValue("₩ 1,234,567")).toBe(1_234_567);
    expect(parseWonValue("12000원")).toBe(12_000);
    expect(parseWonValue("-5000")).toBe(-5_000);
    expect(parseWonValue("(1,200)")).toBe(-1_200);
    expect(parseWonValue("")).toBe(0);
    expect(() => parseWonValue("결제오류")).toThrow(/금액 형식/);
  });

  it("수수료율과 주문일을 정규화한다", () => {
    expect(parseRateValue("3.63%")).toBe(3.63);
    expect(parseRateValue("10.8")).toBe(10.8);
    expect(parseOrderDate("2026-10-15")).toBe("2026-10-15");
    expect(parseOrderDate("2026.10.15")).toBe("2026-10-15");
    expect(parseOrderDate("20261015")).toBe("2026-10-15");
    expect(() => parseOrderDate("십월")).toThrow(/주문일 형식/);
  });

  it("처리량·바이트 표기를 만든다", () => {
    expect(formatThroughput(124_000)).toBe("12.4만 건/s");
    expect(formatThroughput(3_500)).toBe("3,500건/s");
    expect(formatThroughput(0)).toBe("—");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0MB");
    expect(formatBytes(0)).toBe("0B");
  });
});

describe("CsvTokenizer", () => {
  it("따옴표 안의 쉼표와 개행을 하나의 필드로 유지한다", () => {
    const tokenizer = new CsvTokenizer();
    const records = tokenizer.push('a,"서울, 강남구","두\n줄"\r\nb,c,d');
    const flushed = tokenizer.flush();

    expect(records).toHaveLength(1);
    expect(records[0]?.fields).toEqual(["a", "서울, 강남구", "두\n줄"]);
    expect(flushed[0]?.fields).toEqual(["b", "c", "d"]);
  });

  it("청크가 따옴표 중간에서 끊겨도 이스케이프를 복원한다", () => {
    const tokenizer = new CsvTokenizer();
    const pieces = ['x,"he said ""hi""', ' and left",z\n', "1,2,3"];
    const records = pieces.flatMap((piece) => tokenizer.push(piece));
    records.push(...tokenizer.flush());

    expect(records[0]?.fields).toEqual(["x", 'he said "hi" and left', "z"]);
    expect(records[1]?.fields).toEqual(["1", "2", "3"]);
  });

  it("BOM을 제거하고 원본 행 번호를 센다", () => {
    const tokenizer = new CsvTokenizer();
    const records = tokenizer.push("\uFEFFheader\r\nrow1\r\nrow2\r\n");
    expect(tokenizer.bomStripped).toBe(true);
    expect(records.map((record) => record.line)).toEqual([1, 2, 3]);
    expect(records[1]?.fields).toEqual(["row1"]);
  });

  it("필드 길이 제한을 넘긴 행은 corrupted로 표시한다", () => {
    const tokenizer = new CsvTokenizer({ maxFieldChars: 5 });
    const records = tokenizer.push("abcdefghij,ok\n");
    expect(records[0]?.corrupted).toBe(true);
  });
});

describe("parseSettlementCsvText", () => {
  it("헤더와 한 행을 정확히 매핑한다", async () => {
    const result = await parseSettlementCsvText(`${HEADER}\n${csvLine()}\n`, { yieldToEventLoop: false });

    expect(result.errorCount).toBe(0);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row?.orderNo).toBe("SS0001");
    expect(row?.channel).toBe("smartstore");
    expect(row?.paidAmount).toBe(27_900);
    expect(row?.commission).toBe(1_013);
    expect(row?.settledAmount).toBe(23_887);
    expect(row?.unitCost).toBe(12_800);
    expect(row?.status).toBe("배송완료");
  });

  it("한글·영문 별칭 헤더를 모두 인식한다", async () => {
    const header = "주문아이디,마켓,결제액,판매수수료,정산금액,수수료율";
    const result = await parseSettlementCsvText(`${header}\nA1,쿠팡,30000,3240,26760,10.8`, {
      yieldToEventLoop: false,
    });

    const row = result.rows[0];
    expect(row?.channel).toBe("coupang");
    expect(row?.paidAmount).toBe(30_000);
    expect(row?.contractFeeRate).toBe(10.8);
    expect(row?.orderDate).toBe("1970-01-01");
    expect(row?.quantity).toBe(1);
  });

  it("필수 열이 없으면 조용히 넘어가지 않고 스키마 오류를 던진다", async () => {
    await expect(
      parseSettlementCsvText("주문번호,상품명\nA1,캔들", { yieldToEventLoop: false }),
    ).rejects.toBeInstanceOf(SettlementCsvSchemaError);

    try {
      await parseSettlementCsvText("주문번호,상품명\nA1,캔들", { yieldToEventLoop: false });
    } catch (error) {
      expect((error as SettlementCsvSchemaError).missing).toContain("채널");
      expect((error as SettlementCsvSchemaError).missing).toContain("결제금액");
    }
  });

  it("깨진 행은 격리하고 나머지 행으로 계속 진행한다", async () => {
    const text = [
      HEADER,
      csvLine({ orderNo: "A1" }),
      csvLine({ orderNo: "A2", paid: "금액오류" }),
      csvLine({ orderNo: "A3", channel: "알수없는몰" }),
      csvLine({ orderNo: "A4" }),
    ].join("\n");

    const result = await parseSettlementCsvText(text, { yieldToEventLoop: false });

    expect(result.rows).toHaveLength(2);
    expect(result.errorCount).toBe(2);
    expect(result.errors[0]?.line).toBe(3);
    expect(result.errors[0]?.message).toContain("금액 형식");
    expect(result.errors[1]?.message).toContain("알 수 없는 채널");
    expect(result.totalLines).toBe(4);
  });

  it("중복 주문번호는 두 번째 행부터 제외한다", async () => {
    const text = [HEADER, csvLine({ orderNo: "DUP" }), csvLine({ orderNo: "DUP", paid: "19900" })].join("\n");
    const result = await parseSettlementCsvText(text, { yieldToEventLoop: false });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.paidAmount).toBe(27_900);
    expect(result.errorCount).toBe(1);
    expect(result.meta.duplicateOrderCount).toBe(1);
  });

  it("따옴표로 감싼 상품명(쉼표 포함)을 깨뜨리지 않는다", async () => {
    const line = csvLine({ name: '"캔들 세트, 3종"' });
    const result = await parseSettlementCsvText(`${HEADER}\n${line}`, { yieldToEventLoop: false });
    expect(result.rows[0]?.productName).toBe("캔들 세트, 3종");
  });

  it("청크 경계가 매 글자여도 같은 결과가 나온다", async () => {
    const text = `${HEADER}\r\n${csvLine({ orderNo: "C1", name: '"세트, 대형"' })}\r\n${csvLine({ orderNo: "C2" })}\r\n`;
    const whole = await parseSettlementCsvText(text, { yieldToEventLoop: false });
    const sliced = await parseSettlementCsvText(text, { chunkSize: 7, yieldToEventLoop: false });

    expect(sliced.rows).toEqual(whole.rows);
    expect(sliced.meta.chunkCount).toBeGreaterThan(whole.meta.chunkCount);
  });

  it("진행률이 100%로 끝나고 처리 행 수가 맞는다", async () => {
    const text = [HEADER, ...Array.from({ length: 40 }, (_unused, index) => csvLine({ orderNo: `P${index}` }))].join("\n");
    const progress: number[] = [];
    const result = await parseSettlementCsvText(text, {
      progressEveryRows: 10,
      yieldToEventLoop: false,
      onProgress: (value) => progress.push(value.percent),
    });

    expect(result.rows).toHaveLength(40);
    expect(progress[progress.length - 1]).toBe(100);
    expect(result.meta.rowsPerSecond).toBeGreaterThanOrEqual(0);
  });

  it("생성한 CSV를 다시 파싱하면 원본 행과 같아진다(왕복)", async () => {
    const source = generateSettlementRows({ count: 120, seed: 3 });
    const text = generateSettlementCsv(source);
    const result = await parseSettlementCsvText(text, { yieldToEventLoop: false });

    expect(result.rows).toHaveLength(source.length);
    expect(result.rows[0]).toEqual(source[0]);
    expect(result.rows[119]).toEqual(source[119]);
    expect(result.meta.bom).toBe(true);
  });

  it("파이프라인을 직접 쓰면 조각 단위로 결과를 만들 수 있다", async () => {
    const pipeline = new SettlementCsvPipeline(200);
    await pipeline.push(`${HEADER}\n`);
    await pipeline.push(csvLine({ orderNo: "S1" }));
    await pipeline.push("\n");
    const result = pipeline.finish();

    expect(result.rows).toHaveLength(1);
    expect(result.meta.chunkCount).toBe(3);
  });
});

describe("행 매퍼", () => {
  it("깨진 레코드와 빈 행을 오류로 돌려준다", () => {
    const mapper = createSettlementRowMapper(HEADER.split(","));
    const empty = mapper.map({ fields: [""], line: 2, corrupted: false });
    const corrupted = mapper.map({ fields: ["a"], line: 3, corrupted: true });

    expect(empty.error?.message).toContain("빈 행");
    expect(corrupted.error?.message).toContain("구조가 깨졌습니다");
  });

  it("원가·수수료율 열이 없으면 0으로 두고 실효 수수료율로 대체한다", () => {
    const mapper = createSettlementRowMapper(["주문번호", "채널", "결제금액", "마켓수수료", "실정산액"]);
    const result = mapper.map({ fields: ["A1", "스마트스토어", "27900", "1013", "23887"], line: 2, corrupted: false });

    expect(result.row?.unitCost).toBe(0);
    expect(result.row?.contractFeeRate).toBe(3.63);
    expect(result.row?.sku).toBe("UNKNOWN-A1");
  });
});

describe("대용량 처리", () => {
  it("5만 행 CSV를 8초 이내에 파싱한다", async () => {
    const rows = generateSettlementRows({ count: 50_000, seed: 21 });
    const text = generateSettlementCsv(rows);
    const startedAt = Date.now();
    const result = await parseSettlementCsvText(text, { yieldToEventLoop: false, progressEveryRows: 5_000 });
    const elapsed = Date.now() - startedAt;

    expect(result.rows).toHaveLength(50_000);
    expect(result.errorCount).toBe(0);
    expect(elapsed).toBeLessThan(8_000);
  }, 20_000);
});
