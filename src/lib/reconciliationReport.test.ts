import { describe, expect, it } from "vitest";
import {
  buildClaimReport,
  claimCsvFileName,
  buildPrintHtml,
  CLAIMABLE_CODES,
  CLAIM_PLATFORM_META,
  csvCell,
  describeClaimReport,
  platformOfChannel,
  toPlatformClaimCsv,
  UTF8_BOM,
} from "./reconciliationReport";
import { reconcileRow, type ReconciledRow, type SettlementRow } from "./reconciliationEngine";

/** 마켓 계약대로 계산된 기준 행 (스마트스토어, 결제 27,900원) */
function smartstoreRow(overrides: Partial<SettlementRow> = {}): SettlementRow {
  return {
    orderNo: "SS0001",
    channel: "smartstore",
    orderDate: "2026-10-15",
    productName: "소이 캔들 200g",
    sku: "SG-CANDLE-01",
    quantity: 1,
    paidAmount: 27_900,
    commission: 1_013,
    shippingDeduction: 3_000,
    returnFee: 0,
    settledAmount: 23_887,
    contractFeeRate: 3.63,
    unitCost: 12_800,
    sellerShippingCost: 2_800,
    status: "배송완료",
    ...overrides,
  };
}

function coupangRow(overrides: Partial<SettlementRow> = {}): SettlementRow {
  return {
    orderNo: "CP0001",
    channel: "coupang",
    orderDate: "2026-10-20",
    productName: "린넨 커튼 2장",
    sku: "CP-CURTAIN",
    quantity: 1,
    paidAmount: 30_000,
    commission: 0,
    shippingDeduction: 0,
    returnFee: 11_200,
    settledAmount: -11_200,
    contractFeeRate: 10.8,
    unitCost: 9_000,
    sellerShippingCost: 0,
    status: "반품완료",
    ...overrides,
  };
}

/** 수수료 초과 청구 1,487원 (부족분과 정확히 일치) */
function feeOverchargeRow(): ReconciledRow {
  return reconcileRow(smartstoreRow({ commission: 2_500, settledAmount: 22_400 }));
}

/** 반품비 중복 차감 5,600원 */
function returnDoubleRow(): ReconciledRow {
  return reconcileRow(coupangRow());
}

/** 취소 건 수수료 726원 (기본 하한 1,000원 미만) */
function canceledFeeRow(): ReconciledRow {
  return reconcileRow(
    smartstoreRow({ orderNo: "SS0002", status: "취소", commission: 726, settledAmount: -726, shippingDeduction: 0 }),
  );
}

/** 11번가 배송비 초과 차감 */
function elevenstShippingRow(): ReconciledRow {
  return reconcileRow({
    ...smartstoreRow({ orderNo: "EL0001", channel: "elevenst", productName: "세라믹 머그 2P" }),
    shippingDeduction: 5_000,
    settledAmount: 20_000,
  });
}

/** 역마진 — 청구 대상이 아니지만 리포트에 각주로 남아야 한다 */
function negativeMarginRow(): ReconciledRow {
  return reconcileRow(smartstoreRow({ orderNo: "SS0003", unitCost: 40_000 }));
}

const FIXED_AT = "2026-11-11T21:30:00.000Z";

describe("청구 대상 선택", () => {
  it("청구 가능한 원인만 골라 담는다", () => {
    const rows = [feeOverchargeRow(), returnDoubleRow(), negativeMarginRow()];
    const report = buildClaimReport(rows, { generatedAt: FIXED_AT, minAmount: 0 });

    expect(report.lines).toHaveLength(2);
    expect(report.lines.map((line) => line.primaryCode).sort()).toEqual(["FEE_OVERCHARGE", "RETURN_FEE_DOUBLE_CHARGED"]);
    // 역마진은 청구 대상이 아니므로 접수 목록에 없고, 제외 사유로만 남는다.
    expect(report.lines.some((line) => line.reasons.some((reason) => reason.code === "NEGATIVE_MARGIN"))).toBe(false);
    const excluded = report.excluded.map((entry) => entry.code);
    expect(excluded).toContain("NEGATIVE_MARGIN");
  });

  it("청구액은 해당 주문의 정산 부족액을 넘지 않는다", () => {
    const report = buildClaimReport([feeOverchargeRow(), returnDoubleRow(), elevenstShippingRow()], { generatedAt: FIXED_AT });
    expect(report.lines).toHaveLength(3);
    for (const line of report.lines) {
      expect(line.claimAmount).toBeLessThanOrEqual(line.shortfall);
      expect(line.claimAmount).toBe(line.reasons.reduce((sum, reason) => sum + reason.amount, 0));
    }
  });

  it("수수료 초과는 계약 대비 차액만큼 청구한다", () => {
    const report = buildClaimReport([feeOverchargeRow()], { generatedAt: FIXED_AT });
    const line = report.lines[0];
    expect(line?.claimAmount).toBe(1_487);
    expect(line?.expectedSettlement).toBe(23_887);
    expect(line?.actualSettlement).toBe(22_400);
    expect(line?.evidence).toContain("계약 수수료율 3.63%");
  });

  it("금액 하한 미만은 접수 대상에서 빼고 건수로 남긴다", () => {
    const report = buildClaimReport([canceledFeeRow(), feeOverchargeRow()], { generatedAt: FIXED_AT, minAmount: 1_000 });
    expect(report.lines.map((line) => line.orderNo)).toEqual(["SS0001"]);
    expect(report.belowThreshold).toBe(1);

    // 하한을 0으로 내리면 접수된다(정책이지 버그가 아니다).
    const all = buildClaimReport([canceledFeeRow(), feeOverchargeRow()], { generatedAt: FIXED_AT, minAmount: 0 });
    expect(all.lines.map((line) => line.orderNo).sort()).toEqual(["SS0001", "SS0002"]);
  });

  it("금액 내림차순으로 정렬하고 maxLines에서 자른다", () => {
    const report = buildClaimReport([canceledFeeRow(), feeOverchargeRow(), returnDoubleRow()], {
      generatedAt: FIXED_AT,
      minAmount: 0,
      maxLines: 2,
    });
    expect(report.lines.map((line) => line.claimAmount)).toEqual([5_600, 1_487]);
    expect(report.truncated).toBe(1);
  });

  it("채널 필터를 적용하면 해당 채널만 접수한다", () => {
    const report = buildClaimReport([feeOverchargeRow(), returnDoubleRow(), elevenstShippingRow()], {
      generatedAt: FIXED_AT,
      channels: ["coupang"],
    });
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0]?.platform).toBe("coupang");
  });

  it("플랫폼별로 건수와 금액을 묶는다", () => {
    const report = buildClaimReport([feeOverchargeRow(), returnDoubleRow(), elevenstShippingRow()], { generatedAt: FIXED_AT });
    const byPlatform = new Map(report.byPlatform.map((entry) => [entry.platform, entry]));
    expect(byPlatform.get("smartstore")?.lines).toBe(1);
    expect(byPlatform.get("coupang")?.amount).toBe(5_600);
    expect(byPlatform.get("other")?.lines).toBe(1);
    expect(report.totalAmount).toBe(report.lines.reduce((sum, line) => sum + line.claimAmount, 0));
  });

  it("원인별 합계가 총액과 일치한다", () => {
    const report = buildClaimReport([feeOverchargeRow(), returnDoubleRow(), elevenstShippingRow()], { generatedAt: FIXED_AT });
    const reasonTotal = report.byReason.reduce((sum, reason) => sum + reason.amount, 0);
    expect(reasonTotal).toBe(report.totalAmount);
  });

  it("빈 입력은 빈 리포트가 된다(예외를 던지지 않는다)", () => {
    const report = buildClaimReport([], { generatedAt: FIXED_AT });
    expect(report.lines).toHaveLength(0);
    expect(report.totalAmount).toBe(0);
    expect(describeClaimReport(report)).toContain("청구 가능한 불일치가 없습니다");
  });
});

describe("플랫폼 매핑 · 파일명", () => {
  it("채널을 접수 창구로 매핑한다", () => {
    expect(platformOfChannel("smartstore")).toBe("smartstore");
    expect(platformOfChannel("coupang")).toBe("coupang");
    expect(platformOfChannel("elevenst")).toBe("other");
    expect(platformOfChannel("gmarket")).toBe("other");
  });

  it("파일명에 플랫폼·날짜·건수를 넣는다", () => {
    const report = buildClaimReport([returnDoubleRow(), feeOverchargeRow()], { generatedAt: FIXED_AT });
    expect(claimCsvFileName("coupang", report)).toBe("소명요청_쿠팡_2026-11-11_1건.csv");
  });
});

describe("CSV 셀 직렬화", () => {
  it("쉼표·따옴표·개행이 있으면 인용한다", () => {
    expect(csvCell("서울, 강남")).toBe('"서울, 강남"');
    expect(csvCell('12" 모니터')).toBe('"12"" 모니터"');
    expect(csvCell("2줄\n상품명")).toBe('"2줄\n상품명"');
  });

  it("수식 인젝션을 문자열로 고정한다", () => {
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe("\"'=HYPERLINK(\"\"http://evil\"\")\"");
    expect(csvCell("+82 10-0000")).toBe("'+82 10-0000");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("금액 열은 숫자로 남긴다(음수 부호 유지, 반올림)", () => {
    expect(csvCell(1234.6, "number")).toBe("1235");
    expect(csvCell(-1100, "number")).toBe("-1100");
    expect(csvCell("1,234원", "number")).toBe("1234");
    // 숫자 열의 결측은 0이 아니라 빈 셀로 둔다(없는 값과 0원은 다르다).
    expect(csvCell(null, "number")).toBe("");
  });

  it("빈 값은 빈 문자열", () => {
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(null)).toBe("");
  });
});

describe("플랫폼별 소명 CSV", () => {
  const context = { tenantName: "승혜상회", businessNo: "123-45-67890", period: "2026-08-01 ~ 2026-10-31" };

  it("스마트스토어 양식은 판매자센터 문의 항목을 포함한다", () => {
    const report = buildClaimReport([feeOverchargeRow()], { generatedAt: FIXED_AT });
    const csv = toPlatformClaimCsv("smartstore", report, context) ?? "";

    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    const [header] = csv.replace(UTF8_BOM, "").split("\r\n");
    expect(header).toBe("문의유형,스토어명,사업자번호,주문번호,상품명,주문일,기대정산액,실제입금액,차액(환불요청),문의내용");
    expect(csv).toContain("승혜상회");
    expect(csv).toContain("123-45-67890");
    expect(csv).toContain("SS0001");
    expect(csv).toContain("1487");
  });

  it("쿠팡 양식은 업체코드와 정산월을 넣는다", () => {
    const report = buildClaimReport([returnDoubleRow()], { generatedAt: FIXED_AT });
    const csv = toPlatformClaimCsv("coupang", report, context) ?? "";
    const lines = csv.replace(UTF8_BOM, "").split("\r\n");

    expect(lines[0]).toBe("문의구분,업체명,업체코드,정산월,주문번호,상품명,청구금액,정상금액,차액,문의내용");
    expect(lines[1]?.startsWith("정산-수수료,승혜상회,123-45-67890,2026-10")).toBe(true);
    expect(lines[1]).toContain("5600");
  });

  it("다른 플랫폼 건은 섞이지 않는다", () => {
    const report = buildClaimReport([feeOverchargeRow(), returnDoubleRow()], { generatedAt: FIXED_AT });
    const coupangCsv = toPlatformClaimCsv("coupang", report, context) ?? "";
    expect(coupangCsv).not.toContain("SS0001");
    expect(coupangCsv).toContain("CP0001");
  });

  it("해당 플랫폼 건이 없으면 null", () => {
    const report = buildClaimReport([feeOverchargeRow()], { generatedAt: FIXED_AT });
    expect(toPlatformClaimCsv("coupang", report, context)).toBeNull();
  });

  it("상품명의 쉼표·수식이 CSV 구조를 깨지 않는다", () => {
    const row = reconcileRow(smartstoreRow({ commission: 2_500, settledAmount: 22_400, productName: '=1+1, "특가" 캔들' }));
    const report = buildClaimReport([row], { generatedAt: FIXED_AT });
    const csv = toPlatformClaimCsv("smartstore", report, context) ?? "";
    // 헤더 + 1행. 인용이 깨지면 행이 늘어난다.
    expect(csv.replace(UTF8_BOM, "").split("\r\n").filter(Boolean)).toHaveLength(2);
    expect(csv).toContain(`"'=1+1, ""특가"" 캔들"`);
  });

  it("탭 구분 파일용 기타 양식은 마켓명 열을 갖는다", () => {
    const report = buildClaimReport([elevenstShippingRow()], { generatedAt: FIXED_AT });
    const csv = toPlatformClaimCsv("other", report, context) ?? "";
    expect(csv.split("\r\n")[0]).toContain("마켓,업체명,주문번호");
    expect(csv).toContain("11번가");
  });
});

describe("인쇄용 HTML", () => {
  it("요약·상세·합계를 한 문서에 담는다", () => {
    const report = buildClaimReport([feeOverchargeRow(), returnDoubleRow()], { generatedAt: FIXED_AT });
    const html = buildPrintHtml(report, { tenantName: "승혜상회", businessNo: "123-45-67890" });

    expect(html).toContain("정산 불일치 소명 요청서");
    expect(html).toContain("승혜상회");
    expect(html).toContain(report.totalAmount.toLocaleString("ko-KR"));
    expect(html).toContain("SS0001");
    expect(html).toContain("CP0001");
    expect(html).toContain("@page { size: A4");
  });

  it("고객 데이터의 HTML을 이스케이프한다", () => {
    const row = reconcileRow(
      smartstoreRow({ commission: 2_500, settledAmount: 22_400, productName: '<script>alert("x")</script>' }),
    );
    const report = buildClaimReport([row], { generatedAt: FIXED_AT });
    const html = buildPrintHtml(report);

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("청구에서 제외한 원인을 각주로 설명한다", () => {
    const report = buildClaimReport([feeOverchargeRow(), negativeMarginRow()], { generatedAt: FIXED_AT });
    const html = buildPrintHtml(report);
    expect(html).toContain("청구에서 제외한 항목");
    expect(html).toContain("역마진");
  });

  it("빈 리포트도 깨지지 않는 문서를 만든다", () => {
    const report = buildClaimReport([], { generatedAt: FIXED_AT });
    const html = buildPrintHtml(report);
    expect(html).toContain("청구 대상 건이 없습니다.");
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });
});

describe("정책 상수", () => {
  it("청구 가능 코드는 계약 위반만 담는다", () => {
    expect(CLAIMABLE_CODES).toContain("FEE_OVERCHARGE");
    expect(CLAIMABLE_CODES).toContain("SETTLEMENT_SHORTFALL");
    expect(CLAIMABLE_CODES).not.toContain("NEGATIVE_MARGIN");
    expect(CLAIMABLE_CODES).not.toContain("SETTLEMENT_SURPLUS");
    expect(CLAIMABLE_CODES).not.toContain("FEE_UNDERCHARGE");
  });

  it("플랫폼 메타에 접수 창구가 적혀 있다", () => {
    for (const meta of Object.values(CLAIM_PLATFORM_META)) {
      expect(meta.desk.length).toBeGreaterThan(0);
      expect(meta.channels.length).toBeGreaterThan(0);
    }
  });

  it("요약 문장은 플랫폼별 건수를 보여 준다", () => {
    const report = buildClaimReport([feeOverchargeRow(), returnDoubleRow()], { generatedAt: FIXED_AT });
    expect(describeClaimReport(report)).toContain("스마트스토어 1건");
    expect(describeClaimReport(report)).toContain("쿠팡 1건");
  });
});
