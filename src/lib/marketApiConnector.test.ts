import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserCredentialStore,
  CREDENTIAL_STORAGE_KEY,
  MarketApiConnector,
  MarketApiError,
  MemoryCredentialStore,
  buildSandboxDataset,
  coupangSignatureMessage,
  coupangSignedDate,
  createSandboxTransport,
  createSmartStoreSecretSign,
  defaultSettlementMonth,
  maskCredentials,
  maskSecret,
  monthRange,
  normalizeRecord,
  parseSettlementPage,
  runSettlementIntake,
  sandboxLedgerFor,
  scrubSecrets,
  toSettlementRows,
  type HttpTransport,
  type MarketApiCredentials,
  type MarketApiRequest,
  type MarketApiResponse,
  type StorageLike,
} from "./marketApiConnector";

const NOW = Date.parse("2026-11-11T03:04:05.000Z");

function credentials(overrides: Partial<MarketApiCredentials> = {}): MarketApiCredentials {
  return {
    provider: "smartstore",
    clientId: "app-client-id",
    clientSecret: "$2a$10$abcdefghijklmnopqrstuv",
    sandbox: true,
    ...overrides,
  };
}

function jsonResponse(status: number, payload: unknown, headers: Record<string, string> = {}): MarketApiResponse {
  return { status, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload) };
}

/** 요청을 기록하고 스크립트대로 응답하는 전송 계층 */
function scriptedTransport(script: (request: MarketApiRequest, index: number) => MarketApiResponse | Promise<MarketApiResponse>): {
  transport: HttpTransport;
  calls: MarketApiRequest[];
} {
  const calls: MarketApiRequest[] = [];
  return {
    calls,
    transport: async (request) => {
      calls.push(request);
      return script(request, calls.length - 1);
    },
  };
}

function smartStorePage(records: unknown[], page = 1, hasNext = false): MarketApiResponse {
  return jsonResponse(200, { data: records, page, hasNext });
}

function record(orderNo: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderNo,
    orderDate: "2026-10-12",
    productName: "소이 캔들 200g",
    sku: "SG-CANDLE-01",
    quantity: 1,
    paidAmount: 19_900,
    commission: 722,
    shippingDeduction: 3_000,
    returnFee: 0,
    settledAmount: 16_178,
    status: "배송완료",
    ...overrides,
  };
}

describe("마스킹 · 시크릿 보호", () => {
  it("시크릿 가운데를 가리고 길이를 노출하지 않는다", () => {
    const masked = maskSecret("sk-live-abcdefghijklmnop-9f2a");
    expect(masked.startsWith("sk-")).toBe(true);
    expect(masked.endsWith("9f2a")).toBe(true);
    expect(masked).toContain("••••••••");
    expect(masked).not.toContain("abcdefgh");
    expect(maskSecret("short")).toBe("••••••••");
    expect(maskSecret("")).toBe("");
  });

  it("화면에 넘길 자격 증명 요약에는 시크릿 원문이 없다", () => {
    const publicView = maskCredentials(credentials());
    expect(publicView.hasSecret).toBe(true);
    expect(JSON.stringify(publicView)).not.toContain("abcdefghijklmnop");
    expect(publicView.clientIdMasked).toContain("••••••••");
  });

  it("오류 문장에 섞인 시크릿을 지운다", () => {
    const cleaned = scrubSecrets("sign failed for $2a$10$abcdefghijklmnopqrstuv (client app-client-id)", [
      "$2a$10$abcdefghijklmnopqrstuv",
      "app-client-id",
    ]);
    expect(cleaned).not.toContain("abcdefghijklmnop");
    expect(cleaned).not.toContain("app-client-id");
    expect(cleaned).toContain("[REDACTED]");
  });

  it("MarketApiError는 시크릿이 섞인 detail도 지운다", () => {
    const error = new MarketApiError("AUTH", "bad secret $2a$10$abcdefghijklmnopqrstuv", {
      provider: "smartstore",
      detail: "body: client_secret=$2a$10$abcdefghijklmnopqrstuv",
      secrets: ["$2a$10$abcdefghijklmnopqrstuv"],
    });
    expect(error.message).not.toContain("abcdefghijklmnop");
    expect(error.detail).not.toContain("abcdefghijklmnop");
    expect(error.retryable).toBe(false);
    expect(error.toDisplay().hint).toContain("재발급");
  });
});

describe("정산월 · 날짜 범위", () => {
  it("월의 첫날과 마지막날을 계산한다", () => {
    expect(monthRange("2026-10")).toEqual({ startDate: "2026-10-01", endDate: "2026-10-31" });
    expect(monthRange("2026-02")).toEqual({ startDate: "2026-02-01", endDate: "2026-02-28" });
    expect(monthRange("2024-02")).toEqual({ startDate: "2024-02-01", endDate: "2024-02-29" });
    expect(monthRange("2026-04")).toEqual({ startDate: "2026-04-01", endDate: "2026-04-30" });
  });

  it("형식이 틀리면 CONFIG 오류로 알리고, 고칠 방법을 힌트에 적는다", () => {
    expect(() => monthRange("2026-13")).toThrow(MarketApiError);
    try {
      monthRange("202610");
      throw new Error("여기까지 오면 실패");
    } catch (error) {
      expect(error).toBeInstanceOf(MarketApiError);
      expect((error as MarketApiError).code).toBe("CONFIG");
      expect((error as MarketApiError).hint).toContain("YYYY-MM");
    }
  });

  it("기본 정산월은 지난 달이다", () => {
    expect(defaultSettlementMonth(Date.parse("2026-11-11T00:00:00Z"))).toBe("2026-10");
    expect(defaultSettlementMonth(Date.parse("2026-01-05T00:00:00Z"))).toBe("2025-12");
  });
});

describe("전자서명", () => {
  it("스마트스토어 서명은 bcrypt 해시를 Base64로 감싼 값이다", () => {
    const sign = createSmartStoreSecretSign("aaaabbbb", "$2a$10$abcdefghijklmnopqrstuv", 1_643_956_077_762);
    const decoded = Buffer.from(sign, "base64").toString("utf8");
    expect(decoded.startsWith("$2a$10$")).toBe(true);
    expect(sign).not.toContain("aaaabbbb");
    // 같은 입력이면 같은 서명(타임스탬프가 서명에 고정되므로 재생 공격 창이 좁아진다)
    expect(createSmartStoreSecretSign("aaaabbbb", "$2a$10$abcdefghijklmnopqrstuv", 1_643_956_077_762)).toBe(sign);
  });

  it("쿠팡 서명 메시지는 signed-date + method + path + query 순서다", () => {
    expect(coupangSignatureMessage("261111T030405Z", "get", "/v2/settlement", "vendorId=1&page=1")).toBe(
      "261111T030405ZGET/v2/settlementvendorId=1&page=1",
    );
    expect(coupangSignedDate(Date.parse("2026-11-11T03:04:05Z"))).toBe("261111T030405Z");
  });
});

describe("응답 정규화", () => {
  it("영문·한글 필드명을 모두 읽는다", () => {
    const normalized = normalizeRecord({
      orderId: "CP-1",
      orderDateTime: "2026-10-02T10:00:00+09:00",
      itemName: "무광 세라믹 머그",
      vendorItemId: "SG-MUG-01",
      orderCount: "2",
      orderPrice: "35900",
      serviceFee: "3877",
      deliveryFee: "0",
      returnCharge: "5600",
      settlementAmount: "26423",
      orderStatus: "RETURNED",
    });
    expect(normalized).toMatchObject({
      orderNo: "CP-1",
      orderDate: "2026-10-02",
      sku: "SG-MUG-01",
      quantity: 2,
      paidAmount: 35_900,
      commission: 3_877,
      returnFee: 5_600,
      settledAmount: 26_423,
      status: "반품완료",
    });
  });

  it("정산액이 없으면 결제금액에서 차감액을 빼서 복원한다", () => {
    const normalized = normalizeRecord({
      orderNo: "SS-9",
      paidAmount: 20_000,
      commission: 700,
      shippingDeduction: 3_000,
      returnFee: 0,
    });
    expect(normalized?.settledAmount).toBe(16_300);
    expect(normalized?.status).toBe("배송완료");
  });

  it("주문번호가 없으면 버린다", () => {
    expect(normalizeRecord({ paidAmount: 1000 })).toBeNull();
    expect(normalizeRecord(null)).toBeNull();
    expect(normalizeRecord("text")).toBeNull();
  });

  it("스마트스토어/쿠팡 봉투를 모두 해석한다", () => {
    const smartstore = parseSettlementPage({ data: [record("SS-1"), record("SS-2")], page: 1, hasNext: true });
    expect(smartstore.records).toHaveLength(2);
    expect(smartstore.hasNext).toBe(true);

    const coupang = parseSettlementPage({ code: 200, data: { content: [record("CP-1", { orderNo: "CP-1" })], page: 2, hasNext: false } }, 2);
    expect(coupang.records).toHaveLength(1);
    expect(coupang.page).toBe(2);
    expect(coupang.hasNext).toBe(false);
  });

  it("배열이 없는 응답은 PARSE 오류다(0건으로 조용히 넘기지 않는다)", () => {
    expect(() => parseSettlementPage({ message: "maintenance" })).toThrow(MarketApiError);
  });

  it("정규화에 실패한 행은 버리되 개수를 센다", () => {
    const page = parseSettlementPage({ data: [record("SS-1"), { paidAmount: 10 }] });
    expect(page.records).toHaveLength(1);
    expect(page.rawCount).toBe(2);
    expect(page.droppedCount).toBe(1);
  });
});

describe("MarketApiConnector · 스마트스토어", () => {
  it("토큰을 한 번만 발급하고 두 페이지를 연속 조회한다", async () => {
    const { transport, calls } = scriptedTransport((request) => {
      if (request.method === "POST") return jsonResponse(200, { access_token: "tok-1", expires_in: 10_800 });
      const page = new URL(request.url).searchParams.get("page");
      return page === "1" ? smartStorePage([record("SS-1")], 1, true) : smartStorePage([record("SS-2")], 2, false);
    });
    const connector = new MarketApiConnector({ credentials: credentials({ sandbox: false }), transport, now: () => NOW, sleep: async () => undefined });

    const result = await connector.collect({ month: "2026-10", pageSize: 1 });
    expect(result.records.map((item) => item.orderNo)).toEqual(["SS-1", "SS-2"]);
    expect(result.pages).toBe(2);

    const tokenCalls = calls.filter((call) => call.method === "POST");
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.body).toContain("client_secret_sign=");
    expect(tokenCalls[0]?.body).not.toContain("$2a$10$abcdefghijklmnopqrstuv");
    expect(tokenCalls[0]?.body).toContain(`timestamp=${NOW}`);
    expect(tokenCalls[0]?.body).toContain("type=SELF");

    const pageCalls = calls.filter((call) => call.method === "GET");
    expect(pageCalls[0]?.headers.authorization).toBe("Bearer tok-1");
    const query = new URL(pageCalls[0]?.url ?? "").searchParams;
    expect(query.get("startDate")).toBe("2026-10-01");
    expect(query.get("endDate")).toBe("2026-10-31");
    expect(query.get("month")).toBe("2026-10");
  });

  it("페이지 401을 받으면 토큰을 갱신해 한 번 재시도한다", async () => {
    let tokenIssued = 0;
    const { transport, calls } = scriptedTransport((request) => {
      if (request.method === "POST") {
        tokenIssued += 1;
        return jsonResponse(200, { access_token: `tok-${tokenIssued}`, expires_in: 3600 });
      }
      if (request.headers.authorization === "Bearer tok-1") {
        return jsonResponse(401, { code: "GW.AUTHN", message: "expired" });
      }
      return smartStorePage([record("SS-9")], 1, false);
    });
    const connector = new MarketApiConnector({ credentials: credentials({ sandbox: false }), transport, now: () => NOW, sleep: async () => undefined });

    const page = await connector.fetchPage({ month: "2026-10" });
    expect(page.records[0]?.orderNo).toBe("SS-9");
    expect(tokenIssued).toBe(2);
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(2);
  });

  it("토큰 발급이 거부되면 재시도하지 않고 AUTH로 끝난다", async () => {
    const { transport, calls } = scriptedTransport(() => jsonResponse(401, { code: "GW.AUTHN" }));
    const connector = new MarketApiConnector({ credentials: credentials({ sandbox: false }), transport, now: () => NOW, sleep: async () => undefined, maxRetries: 3 });

    await expect(connector.fetchPage({ month: "2026-10" })).rejects.toMatchObject({ code: "AUTH", retryable: false });
    expect(calls).toHaveLength(1);
  });

  it("429는 Retry-After 후 재시도하고, 계속되면 RATE_LIMITED로 알린다", async () => {
    const sleep = vi.fn(async () => undefined);
    const { transport, calls } = scriptedTransport(() => jsonResponse(429, { message: "too many" }, { "retry-after": "1" }));
    const connector = new MarketApiConnector({ credentials: credentials({ sandbox: false }), transport, now: () => NOW, sleep, maxRetries: 2 });

    await expect(connector.fetchPage({ month: "2026-10" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("5xx는 재시도 후 성공할 수 있다", async () => {
    let attempt = 0;
    const { transport } = scriptedTransport((request) => {
      if (request.method === "POST") return jsonResponse(200, { access_token: "tok", expires_in: 3600 });
      attempt += 1;
      return attempt === 1 ? jsonResponse(503, { message: "down" }) : smartStorePage([record("SS-3")]);
    });
    const connector = new MarketApiConnector({ credentials: credentials({ sandbox: false }), transport, now: () => NOW, sleep: async () => undefined });
    const page = await connector.fetchPage({ month: "2026-10" });
    expect(page.records).toHaveLength(1);
    expect(attempt).toBe(2);
  });

  it("네트워크 실패와 JSON 파싱 실패를 구분해 알린다", async () => {
    const failing: HttpTransport = async () => {
      throw new TypeError("Failed to fetch");
    };
    const networkConnector = new MarketApiConnector({ credentials: credentials({ sandbox: false }), transport: failing, now: () => NOW, sleep: async () => undefined, maxRetries: 0 });
    await expect(networkConnector.fetchPage({ month: "2026-10" })).rejects.toMatchObject({ code: "NETWORK" });

    const html = scriptedTransport((request) =>
      request.method === "POST" ? jsonResponse(200, { access_token: "t", expires_in: 3600 }) : { status: 200, headers: {}, body: "<html>점검중</html>" },
    );
    const parseConnector = new MarketApiConnector({ credentials: credentials({ sandbox: false }), transport: html.transport, now: () => NOW, sleep: async () => undefined });
    await expect(parseConnector.fetchPage({ month: "2026-10" })).rejects.toMatchObject({ code: "PARSE" });
  });

  it("설정이 비면 네트워크를 타지 않고 CONFIG로 끝난다", async () => {
    const { transport, calls } = scriptedTransport(() => jsonResponse(200, {}));
    const connector = new MarketApiConnector({ credentials: credentials({ clientId: "", sandbox: false }), transport, now: () => NOW });
    await expect(connector.fetchPage({ month: "2026-10" })).rejects.toMatchObject({ code: "CONFIG" });
    expect(calls).toHaveLength(0);
  });

  it("페이지 상한에 닿으면 무한 루프 대신 오류를 낸다", async () => {
    const { transport } = scriptedTransport((request) =>
      request.method === "POST" ? jsonResponse(200, { access_token: "tok", expires_in: 3600 }) : smartStorePage([record("SS-X")], 1, true),
    );
    const connector = new MarketApiConnector({ credentials: credentials({ sandbox: false }), transport, now: () => NOW, sleep: async () => undefined });
    await expect(connector.collect({ month: "2026-10" }, { maxPages: 3 })).rejects.toMatchObject({ code: "PARSE" });
  });
});

describe("MarketApiConnector · 쿠팡", () => {
  it("CEA 서명을 만들고, 서명이 실제 HMAC-SHA256과 일치한다", async () => {
    const { transport, calls } = scriptedTransport((request) => {
      expect(request.headers.authorization?.startsWith("CEA ")).toBe(true);
      return jsonResponse(200, { code: 200, data: { content: [record("CP-1")], page: 1, hasNext: false } });
    });
    const connector = new MarketApiConnector({
      credentials: credentials({ provider: "coupang", clientId: "AK-1", clientSecret: "SK-1", vendorId: "V-100", sandbox: false }),
      transport,
      now: () => NOW,
      sleep: async () => undefined,
    });

    const page = await connector.fetchPage({ month: "2026-10" });
    expect(page.records[0]?.orderNo).toBe("CP-1");

    const authorization = calls[0]?.headers.authorization ?? "";
    const parts = Object.fromEntries(
      authorization.replace(/^CEA /, "").split(",").map((part) => {
        const [key, value] = part.trim().split("=");
        return [key, value];
      }),
    );
    expect(parts.algorithm).toBe("HmacSHA256");
    expect(parts["access-key"]).toBe("AK-1");
    expect(parts["signed-date"]).toBe("261111T030405Z");

    const url = new URL(calls[0]?.url ?? "");
    const expected = createHmac("sha256", "SK-1")
      .update(`261111T030405ZGET${url.pathname}${url.search.replace(/^\?/, "")}`)
      .digest("hex");
    expect(parts.signature).toBe(expected);
    expect(url.searchParams.get("vendorId")).toBe("V-100");
  });

  it("업체코드가 없으면 요청 전에 CONFIG로 막는다", async () => {
    const { transport, calls } = scriptedTransport(() => jsonResponse(200, {}));
    const connector = new MarketApiConnector({
      credentials: credentials({ provider: "coupang", clientId: "AK", clientSecret: "SK", sandbox: false }),
      transport,
      now: () => NOW,
    });
    await expect(connector.fetchPage({ month: "2026-10" })).rejects.toMatchObject({ code: "CONFIG" });
    expect(calls).toHaveLength(0);
  });
});

describe("샌드박스", () => {
  it("같은 (마켓, 월)이면 항상 같은 정산 내역이고, 월이 다르면 달라진다", () => {
    const october = buildSandboxDataset("smartstore", "2026-10", 50);
    const octoberAgain = buildSandboxDataset("smartstore", "2026-10", 50);
    const september = buildSandboxDataset("smartstore", "2026-09", 50);
    expect(october.records).toEqual(octoberAgain.records);
    expect(october.records[0]?.settledAmount).toBe(octoberAgain.records[0]?.settledAmount);

    const fingerprint = (dataset: { records: { orderNo: string; paidAmount: number; settledAmount: number }[] }): string =>
      dataset.records.map((row) => `${row.orderNo}:${row.paidAmount}:${row.settledAmount}`).join("|");
    expect(fingerprint(october)).not.toBe(fingerprint(september));
    expect(october.records[0]?.orderNo).toContain("202610");
  });

  it("샌드박스 레코드는 마켓이 주는 값만 담는다(원가는 원장 쪽에 있다)", () => {
    const dataset = buildSandboxDataset("coupang", "2026-10", 40);
    const sample = dataset.records[0];
    expect(sample).toBeDefined();
    expect(Object.keys(sample ?? {})).not.toContain("unitCost");
    expect(Object.keys(sample ?? {})).not.toContain("contractFeeRate");
    expect(Object.keys(dataset.ledger).length).toBeGreaterThan(0);
  });

  it("샌드박스 전송은 인증 헤더 없이는 401을 돌려준다", async () => {
    const transport = createSandboxTransport();
    const response = await transport({
      provider: "coupang",
      method: "GET",
      url: "https://api-gateway.coupang.com/v2/providers/seller_api/apis/api/v1/marketplace/settlement/receipts?month=2026-10",
      headers: {},
    });
    expect(response.status).toBe(401);
  });

  it("샌드박스 커넥터로 끝까지 수집한다(네트워크 없음)", async () => {
    const connector = new MarketApiConnector({ credentials: credentials(), now: () => NOW, sleep: async () => undefined });
    const result = await connector.collect({ month: "2026-10" }, { pageSize: 500 });
    expect(result.sandbox).toBe(true);
    expect(result.records.length).toBe(1_200);
    expect(result.pages).toBe(3);
    expect(result.records.every((item) => item.orderNo.length > 0)).toBe(true);
  });

  it("일시 장애를 재시도로 넘긴다", async () => {
    const connector = new MarketApiConnector({
      credentials: credentials(),
      transport: createSandboxTransport({ failAt: { page: 2, status: 503, times: 1 } }),
      now: () => NOW,
      sleep: async () => undefined,
      maxRetries: 2,
    });
    const result = await connector.collect({ month: "2026-10" }, { pageSize: 500 });
    expect(result.records).toHaveLength(1_200);
  });

  it("연결 확인은 인증·응답 형식·레코드 수를 함께 돌려준다", async () => {
    const connector = new MarketApiConnector({ credentials: credentials(), now: () => NOW });
    const probe = await connector.probe({ month: "2026-10" });
    expect(probe.ok).toBe(true);
    expect(probe.pageRecords).toBeGreaterThan(0);
    expect(probe.message).toContain("연결 성공");
  });
});

describe("정산 행 매핑 · 대사 연결", () => {
  const ledger = { "SG-CANDLE-01": { unitCost: 7_000, sellerShippingCost: 3_000 } };

  it("원가와 계약 수수료율을 붙이고, 원장에 없는 SKU는 경고로 남긴다", () => {
    const mapped = toSettlementRows(
      [
        { orderNo: "A", orderDate: "2026-10-01", productName: "캔들", sku: "SG-CANDLE-01", quantity: 1, paidAmount: 19_900, commission: 722, shippingDeduction: 3_000, returnFee: 0, settledAmount: 16_178, status: "배송완료" },
        { orderNo: "B", orderDate: "2026-10-02", productName: "머그", sku: "SG-MUG-99", quantity: 1, paidAmount: 15_900, commission: 577, shippingDeduction: 3_000, returnFee: 0, settledAmount: 12_323, status: "배송완료" },
      ],
      { ledger, channel: "coupang" },
    );

    expect(mapped.rows).toHaveLength(2);
    expect(mapped.rows[0]?.unitCost).toBe(7_000);
    expect(mapped.rows[0]?.contractFeeRate).toBe(10.8);
    expect(mapped.rows[0]?.channel).toBe("coupang");
    expect(mapped.rows[1]?.unitCost).toBe(0);
    expect(mapped.ledgerHits).toBe(1);
    expect(mapped.ledgerMisses).toBe(1);
    expect(mapped.warnings[0]?.code).toBe("LEDGER_MISSING");
  });

  it("계약서 수수료율을 직접 주면 그 값을 쓴다", () => {
    const mapped = toSettlementRows(
      [{ orderNo: "A", orderDate: "2026-10-01", productName: "캔들", sku: "SG-CANDLE-01", quantity: 1, paidAmount: 19_900, commission: 722, shippingDeduction: 0, returnFee: 0, settledAmount: 19_178, status: "배송완료" }],
      { feeRate: 2.5 },
    );
    expect(mapped.rows[0]?.contractFeeRate).toBe(2.5);
  });

  it("API 수집 → 대사까지 한 번에 돌면 엔진이 이상 징후를 찾아낸다", async () => {
    const connector = new MarketApiConnector({ credentials: credentials(), now: () => NOW, sleep: async () => undefined });
    const progress: string[] = [];
    const result = await runSettlementIntake(connector, {
      month: "2026-10",
      ledger: sandboxLedgerFor("smartstore", "2026-10"),
      pageSize: 500,
      onProgress: (step) => progress.push(step.stage),
    });

    expect(result.meta.source).toBe("api");
    expect(result.records).toHaveLength(1_200);
    expect(result.rows).toHaveLength(1_200);
    expect(result.reconciled.summary.totalRows).toBe(1_200);
    expect(result.reconciled.summary.flaggedRows).toBeGreaterThan(0);
    expect(result.reconciled.summary.totalLeak).toBeGreaterThan(0);
    expect(result.meta.pages).toBe(3);
    expect(progress[0]).toBe("auth");
    expect(progress[progress.length - 1]).toBe("done");

    // 원인별 귀속 합계가 총 누수를 넘지 않는다(이중 계산 금지)
    const attributed = Object.values(result.reconciled.summary.anomalyLoss).reduce((sum, value) => sum + value, 0);
    expect(attributed).toBeLessThanOrEqual(result.reconciled.summary.totalLeak);
  });

  it("정산 내역이 0건이면 성공으로 위장하지 않는다", async () => {
    const { transport } = scriptedTransport((request) =>
      request.method === "POST" ? jsonResponse(200, { access_token: "t", expires_in: 3600 }) : smartStorePage([], 1, false),
    );
    const connector = new MarketApiConnector({ credentials: credentials({ sandbox: false }), transport, now: () => NOW, sleep: async () => undefined });
    await expect(runSettlementIntake(connector, { month: "2026-10" })).rejects.toMatchObject({ code: "PARSE" });
  });
});

describe("자격 증명 저장소", () => {
  function fakeStorage(): StorageLike & { dump: () => Record<string, string> } {
    const data = new Map<string, string>();
    return {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
      dump: () => Object.fromEntries(data),
    };
  }

  it("선택한 경우에만 시크릿을 저장하고, 삭제하면 키까지 지운다", async () => {
    const storage = fakeStorage();
    const store = new BrowserCredentialStore(storage);

    await store.save({ provider: "smartstore", clientId: "app-1", clientSecret: "secret-1", secretPersisted: true, sandbox: true, savedAt: "2026-11-11T00:00:00.000Z" });
    expect(await store.load("smartstore")).toMatchObject({ clientId: "app-1", clientSecret: "secret-1", secretPersisted: true });

    await store.save({ provider: "coupang", clientId: "AK", vendorId: "V-1", secretPersisted: false, sandbox: true, savedAt: "2026-11-11T00:00:00.000Z" });
    expect(await store.load("coupang")).toMatchObject({ clientId: "AK", vendorId: "V-1", secretPersisted: false });
    expect(await store.load("coupang")).not.toHaveProperty("clientSecret");

    await store.remove("smartstore");
    await store.remove("coupang");
    expect(storage.dump()).toEqual({});
  });

  it("손상된 저장값은 무시하고 빈 상태로 시작한다", async () => {
    const storage = fakeStorage();
    storage.setItem(CREDENTIAL_STORAGE_KEY, "{not-json");
    const store = new BrowserCredentialStore(storage);
    await expect(store.load("smartstore")).resolves.toBeUndefined();
  });

  it("메모리 저장소는 같은 계약을 지킨다", async () => {
    const store = new MemoryCredentialStore();
    expect(await store.load("smartstore")).toBeUndefined();
    await store.save({ provider: "smartstore", clientId: "a", secretPersisted: false, sandbox: true, savedAt: "2026-11-11T00:00:00.000Z" });
    expect((await store.load("smartstore"))?.clientId).toBe("a");
    await store.remove("smartstore");
    expect(await store.load("smartstore")).toBeUndefined();
  });
});
