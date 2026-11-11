import { describe, expect, it } from "vitest";
import {
  DEFAULT_UPLOAD_LIMITS,
  describeMultiFileDrop,
  detectFormat,
  formatBytes,
  UPLOAD_ACCEPT,
  validateUploadFile,
} from "./settlementUpload";

const head = (...bytes: number[]) => async () => new Uint8Array(bytes);
const ZIP_HEAD = [0x50, 0x4b, 0x03, 0x04];
const HTML_HEAD = [0x3c, 0x21, 0x44, 0x4f]; // "<!DO"

describe("형식 판정", () => {
  it("확장자로 CSV·TSV·엑셀을 구분한다", () => {
    expect(detectFormat("정산서_2026-10.csv")).toBe("csv");
    expect(detectFormat("정산서.CSV")).toBe("csv");
    expect(detectFormat("정산서.txt")).toBe("csv");
    expect(detectFormat("정산서.tsv")).toBe("tsv");
    expect(detectFormat("정산서.xlsx")).toBe("xlsx");
    expect(detectFormat("정산서.xlsm")).toBe("xlsx");
    expect(detectFormat("정산서.xls")).toBe("xls");
  });

  it("확장자가 없거나 모르는 형식은 null", () => {
    expect(detectFormat("정산서")).toBeNull();
    expect(detectFormat("정산서.pdf")).toBeNull();
    expect(detectFormat("정산서.zip")).toBeNull();
  });
});

describe("파일 검증", () => {
  it("정상 CSV는 통과하고 형식을 알려 준다", async () => {
    const result = await validateUploadFile({ name: "정산서.csv", size: 1024 * 1024 });
    expect(result.ok).toBe(true);
    expect(result.format).toBe("csv");
    expect(result.sizeLabel).toBe("1.0MB");
    expect(result.warnings).toEqual([]);
  });

  it("정상 xlsx는 ZIP 매직바이트를 확인한 뒤 통과한다", async () => {
    const result = await validateUploadFile({ name: "정산서.xlsx", size: 4096, readHead: head(...ZIP_HEAD) });
    expect(result.ok).toBe(true);
    expect(result.format).toBe("xlsx");
  });

  it("확장자만 xlsx인 HTML 오류 페이지를 거절한다", async () => {
    const result = await validateUploadFile({ name: "정산서.xlsx", size: 2048, readHead: head(...HTML_HEAD) });
    expect(result.ok).toBe(false);
    expect(result.issue?.code).toBe("BROKEN_XLSX");
    expect(result.issue?.hint).toContain("다시 내려받");
  });

  it("0바이트 파일을 거절한다", async () => {
    const result = await validateUploadFile({ name: "정산서.csv", size: 0 });
    expect(result.ok).toBe(false);
    expect(result.issue?.code).toBe("EMPTY_FILE");
  });

  it("상한을 넘는 파일을 거절하고 대안을 알려 준다", async () => {
    const result = await validateUploadFile({ name: "정산서.csv", size: DEFAULT_UPLOAD_LIMITS.maxBytes + 1 });
    expect(result.ok).toBe(false);
    expect(result.issue?.code).toBe("TOO_LARGE");
    expect(result.issue?.hint).toContain("기간을 나눠");
  });

  it("구형 .xls는 변환 안내와 함께 거절한다", async () => {
    const result = await validateUploadFile({ name: "정산서.xls", size: 4096 });
    expect(result.ok).toBe(false);
    expect(result.issue?.code).toBe("LEGACY_EXCEL");
    expect(result.issue?.hint).toContain(".xlsx");
  });

  it("정산서가 아닌 확장자를 거절한다", async () => {
    const result = await validateUploadFile({ name: "계약서.pdf", size: 4096 });
    expect(result.ok).toBe(false);
    expect(result.issue?.code).toBe("UNSUPPORTED_EXTENSION");
  });

  it("큰 파일은 통과시키되 느릴 수 있다고 경고한다", async () => {
    const result = await validateUploadFile({ name: "정산서.csv", size: DEFAULT_UPLOAD_LIMITS.warnBytes + 1 });
    expect(result.ok).toBe(true);
    expect(result.warnings[0]).toContain("수 초");
  });

  it("탭 구분 파일은 구분자를 알려 준다", async () => {
    const result = await validateUploadFile({ name: "정산서.tsv", size: 2048 });
    expect(result.format).toBe("tsv");
    expect(result.warnings.join(" ")).toContain("탭");
  });

  it("accept 속성에 지원 형식이 모두 들어 있다", () => {
    for (const extension of [".csv", ".tsv", ".xlsx"]) expect(UPLOAD_ACCEPT).toContain(extension);
    expect(UPLOAD_ACCEPT).not.toContain(".xls,");
  });
});

describe("표시 유틸", () => {
  it("바이트를 사람이 읽는 단위로 바꾼다", () => {
    expect(formatBytes(0)).toBe("0B");
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(1536)).toBe("1.5KB");
    expect(formatBytes(20 * 1024 * 1024)).toBe("20.0MB");
  });

  it("여러 파일을 떨어뜨렸을 때 조용히 무시하지 않고 알린다", () => {
    expect(describeMultiFileDrop(1)).toBeNull();
    expect(describeMultiFileDrop(3)).toContain("첫 번째 파일만");
  });
});
