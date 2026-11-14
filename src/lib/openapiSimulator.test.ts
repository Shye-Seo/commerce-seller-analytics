import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  firstExample,
  inspectSpec,
  listOperations,
  resolveParameters,
  simulateRequest,
  successResponse,
  type OpenApiSpec,
} from "./openapiSimulator";

const ROOT = process.cwd();

function loadSpec(): OpenApiSpec {
  return JSON.parse(readFileSync(join(ROOT, "public/openapi.json"), "utf8")) as OpenApiSpec;
}

/** index.php 라우터에 실제로 등록된 경로를 읽는다. 명세가 코드보다 앞서 나가면 여기서 깨진다. */
function routerRoutes(): Array<{ method: string; path: string }> {
  const source = readFileSync(join(ROOT, "backend/public/index.php"), "utf8");
  const routes: Array<{ method: string; path: string }> = [];
  const pattern = /\$router->(get|post)\('([^']+)'/g;
  let match = pattern.exec(source);
  while (match) {
    routes.push({ method: (match[1] ?? "").toUpperCase(), path: match[2] ?? "" });
    match = pattern.exec(source);
  }
  return routes;
}

describe("openapi.json", () => {
  it("OpenAPI 3.0 명세로 유효하고 외부 참조가 없다", () => {
    const spec = loadSpec();
    const inspection = inspectSpec(spec);

    expect(inspection.problems).toEqual([]);
    expect(inspection.ok).toBe(true);
    expect(spec.openapi.startsWith("3.0.")).toBe(true);
  });

  it("index.php의 모든 라우트가 명세에 있고, 그 반대도 성립한다", () => {
    const spec = loadSpec();
    const specRoutes = new Set(listOperations(spec).map((entry) => `${entry.method.toUpperCase()} ${entry.path}`));
    const codeRoutes = new Set(routerRoutes().map((route) => `${route.method} ${route.path}`));

    expect(codeRoutes.size).toBeGreaterThan(0);
    expect([...codeRoutes].sort()).toEqual([...specRoutes].sort());
  });

  it("모든 오퍼레이션에 요약·2xx 응답·예시가 있다", () => {
    const spec = loadSpec();

    for (const entry of listOperations(spec)) {
      expect(entry.operation.summary, `${entry.method} ${entry.path}`).toBeTruthy();
      const success = successResponse(entry.operation);
      expect(success, `${entry.method} ${entry.path}`).not.toBeNull();
      expect(firstExample(success!.response.content?.["application/json"])).toBeDefined();
    }
  });

  it("필수 쿼리 파라미터가 명세대로 표시된다", () => {
    const spec = loadSpec();
    const entry = listOperations(spec).find((item) => item.operationId === "getReconciliationSummary");
    expect(entry).toBeDefined();

    const params = resolveParameters(spec, entry!.operation);
    expect(params.find((parameter) => parameter.name === "tenant_id")?.required).toBe(true);
    expect(params.find((parameter) => parameter.name === "from")?.required).toBe(false);
  });
});

describe("simulateRequest", () => {
  const spec = loadSpec();

  function operation(operationId: string) {
    const entry = listOperations(spec).find((item) => item.operationId === operationId);
    if (!entry) throw new Error(`오퍼레이션을 찾을 수 없습니다: ${operationId}`);
    return entry;
  }

  it("명세의 POST 예시 본문은 검증을 통과하고 201 예시 응답을 돌려준다", () => {
    const entry = operation("createReconciliationBatch");
    const media = entry.operation.requestBody?.content?.["application/json"];
    const example = firstExample(media);

    const result = simulateRequest(spec, entry, { body: JSON.stringify(example) });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(201);
    expect(result.issues).toEqual([]);
    expect(result.body).toMatchObject({ tenant_id: 1 });
    expect(result.curl).toContain("curl -X POST");
  });

  it("tenant_id가 0이면 400과 필드 경로를 돌려준다", () => {
    const entry = operation("createReconciliationBatch");
    const body = { tenant_id: 0, rows: [{ order_no: "A1" }] };

    const result = simulateRequest(spec, entry, { body: JSON.stringify(body) });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.issues.some((issue) => issue.path === "body.tenant_id" && issue.keyword === "minimum")).toBe(true);
    expect(result.body).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("5,000행을 넘으면 maxItems 위반으로 잡는다", () => {
    const entry = operation("createReconciliationBatch");
    const row = {
      order_no: "CP1",
      channel: "coupang",
      order_date: "2026-10-03",
      product_name: "상품",
      sku: "SKU",
      quantity: 1,
      paid_amount: 1000,
      commission: 100,
      shipping_deduction: 0,
      return_fee: 0,
      settled_amount: 900,
      order_status: "배송완료",
    };
    const body = { tenant_id: 1, rows: Array.from({ length: 5_001 }, () => row) };

    const result = simulateRequest(spec, entry, { body: JSON.stringify(body) });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.keyword === "maxItems")).toBe(true);
  });

  it("잘못된 enum은 허용값을 알려 준다", () => {
    const entry = operation("createReconciliationBatch");
    const body = {
      tenant_id: 1,
      rows: [
        {
          order_no: "CP1",
          channel: "gmarket2",
          order_date: "2026-10-03",
          product_name: "상품",
          sku: "SKU",
          quantity: 1,
          paid_amount: 1000,
          commission: 100,
          shipping_deduction: 0,
          return_fee: 0,
          settled_amount: 900,
          order_status: "배송완료",
        },
      ],
    };

    const result = simulateRequest(spec, entry, { body: JSON.stringify(body) });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.keyword === "enum" && issue.path === "body.rows[0].channel")).toBe(true);
  });

  it("필수 쿼리 파라미터가 비면 400, 채우면 200 예시를 돌려준다", () => {
    const entry = operation("getReconciliationSummary");

    const missing = simulateRequest(spec, entry, { query: {} });
    expect(missing.ok).toBe(false);
    expect(missing.issues.some((issue) => issue.path === "tenant_id")).toBe(true);

    const filled = simulateRequest(spec, entry, { query: { tenant_id: "1", from: "2026-10-01", to: "2026-10-31" } });
    expect(filled.ok).toBe(true);
    expect(filled.status).toBe(200);
    expect(filled.request.url).toContain("tenant_id=1");
    expect(filled.body).toMatchObject({ tenant_id: 1 });
  });

  it("숫자 파라미터에 문자가 들어오면 타입 오류로 잡는다", () => {
    const entry = operation("listReconciliationRows");
    const result = simulateRequest(spec, entry, { query: { tenant_id: "abc" } });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.keyword === "type")).toBe(true);
  });

  it("JSON이 아닌 본문은 파싱 오류로 400을 돌려준다", () => {
    const entry = operation("createReconciliationBatch");
    const result = simulateRequest(spec, entry, { body: "{oops" });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toMatch(/JSON/);
  });

  it("GET /health는 파라미터 없이도 예시 응답이 나온다", () => {
    const entry = operation("getHealth");
    const result = simulateRequest(spec, entry, {});

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.request.url).toBe("http://127.0.0.1:8080/health");
    expect(result.body).toMatchObject({ status: "ok" });
  });
});
