/**
 * OpenAPI 3.0 명세 해석 · 요청 검증 시뮬레이터
 *
 * `/api-docs` 화면이 쓰는 순수 로직이다. 외부 CDN(Swagger UI 등)에 의존하지 않고, 명세 파일
 * 하나만으로 다음을 한다.
 *
 *   1. `$ref` 해석 — `#/components/schemas/...` 형태만 지원한다(외부 참조 없음)
 *   2. OpenAPI 3.0 스키마의 부분집합 검증 — type/required/properties/items/enum/min~max/minItems
 *      PHP 컨트롤러의 검증 규칙(tenant_id ≥ 1, rows 1~5,000, severity enum)을 브라우저에서
 *      같은 문구로 먼저 확인해 주는 것이 목적이다.
 *   3. 예시 응답 선택 — 명세의 `examples`에서 고정 예시를 꺼낸다. 서버를 호출하지 않는다.
 *
 * 여기서 "검증 통과"는 "서버가 받아 준다"는 뜻이 아니다. 저장소·SENS 키·DB 상태는 명세로
 * 알 수 없기 때문에, 화면은 검증 결과와 예시 응답을 **시뮬레이션**이라고 명시한다.
 */

export interface JsonSchema {
  $ref?: string;
  type?: string;
  format?: string;
  description?: string;
  nullable?: boolean;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  example?: unknown;
  default?: unknown;
  description_?: string;
}

export interface OpenApiParameter {
  $ref?: string;
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
}

export interface OpenApiExample {
  summary?: string;
  value?: unknown;
}

export interface OpenApiMediaType {
  schema?: JsonSchema;
  examples?: Record<string, OpenApiExample>;
  example?: unknown;
}

export interface OpenApiResponse {
  description?: string;
  content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiOperation {
  tags?: string[];
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    description?: string;
    content?: Record<string, OpenApiMediaType>;
  };
  responses?: Record<string, OpenApiResponse>;
}

export interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  tags?: Array<{ name: string; description?: string }>;
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: {
    schemas?: Record<string, JsonSchema>;
    parameters?: Record<string, OpenApiParameter>;
  };
}

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface OperationEntry {
  method: HttpMethod;
  path: string;
  operation: OpenApiOperation;
  /** 태그가 없으면 "기타" */
  tag: string;
  operationId: string;
}

/** 명세의 `$ref`를 해석한다. 외부 URL 참조는 지원하지 않는다(명세가 자기완결이어야 한다). */
export function resolveRef<T>(spec: OpenApiSpec, node: T): T {
  let current: unknown = node;
  let guard = 0;

  while (current && typeof current === "object" && "$ref" in (current as Record<string, unknown>)) {
    guard += 1;
    if (guard > 20) break; // 순환 참조 방지

    const ref = (current as { $ref: string }).$ref;
    if (!ref.startsWith("#/")) break;

    const segments = ref
      .slice(2)
      .split("/")
      .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

    let target: unknown = spec;
    for (const segment of segments) {
      if (!target || typeof target !== "object") return node;
      target = (target as Record<string, unknown>)[segment];
    }
    current = target;
  }

  return (current ?? node) as T;
}

export function listOperations(spec: OpenApiSpec): OperationEntry[] {
  const entries: OperationEntry[] = [];

  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!operation) continue;
      entries.push({
        method,
        path,
        operation,
        tag: operation.tags?.[0] ?? "기타",
        operationId: operation.operationId ?? `${method}-${path.replace(/\W+/g, "-")}`,
      });
    }
  }

  return entries;
}

export function resolveParameters(spec: OpenApiSpec, operation: OpenApiOperation): OpenApiParameter[] {
  return (operation.parameters ?? []).map((parameter) => resolveRef(spec, parameter));
}

export function successResponse(operation: OpenApiOperation): { status: string; response: OpenApiResponse } | null {
  const responses = operation.responses ?? {};
  const status = Object.keys(responses)
    .filter((code) => /^2\d\d$/.test(code))
    .sort()[0];

  if (!status) return null;
  return { status, response: responses[status] as OpenApiResponse };
}

export function firstExample(media: OpenApiMediaType | undefined): unknown {
  if (!media) return undefined;
  if (media.examples) {
    const first = Object.values(media.examples)[0];
    if (first) return first.value;
  }
  return media.example;
}

/* ─────────────────────────────────────────────────────────────
 * 스키마 검증 (OpenAPI 3.0 부분집합)
 * ───────────────────────────────────────────────────────────── */

export interface ValidationIssue {
  /** 값까지 이어진 경로. 예: `rows[3].paid_amount` */
  path: string;
  message: string;
  keyword: "required" | "type" | "enum" | "minimum" | "maximum" | "minItems" | "maxItems" | "format" | "additionalProperties";
}

type JsonValue = unknown;

function typeOf(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value: JsonValue, type: string): boolean {
  if (value === null) return type === "null";
  switch (type) {
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && !Array.isArray(value);
    default:
      return true;
  }
}

/**
 * 값 하나를 스키마로 검증한다. 첫 오류에서 멈추지 않고 전부 모은다 —
 * 화면에서 "무엇이 왜 틀렸는지"를 한 번에 보여 주기 위해서다.
 */
export function validateValue(
  spec: OpenApiSpec,
  schema: JsonSchema | undefined,
  value: JsonValue,
  path = "body",
  depth = 0,
): ValidationIssue[] {
  if (!schema || depth > 12) return [];

  const resolved = resolveRef(spec, schema);
  const issues: ValidationIssue[] = [];

  if (value === null || value === undefined) {
    if (resolved.nullable) return issues;
    if (resolved.type) {
      issues.push({ path, message: "값이 필요합니다(null일 수 없습니다).", keyword: "type" });
    }
    return issues;
  }

  if (resolved.type && !matchesType(value, resolved.type)) {
    issues.push({
      path,
      message: `${resolved.type} 타입이어야 하는데 ${typeOf(value)}가 들어왔습니다.`,
      keyword: "type",
    });
    return issues;
  }

  if (resolved.enum && !resolved.enum.some((candidate) => candidate === value)) {
    issues.push({
      path,
      message: `허용된 값이 아닙니다. 허용: ${resolved.enum.map((candidate) => JSON.stringify(candidate)).join(" | ")}`,
      keyword: "enum",
    });
  }

  if (typeof value === "number") {
    if (typeof resolved.minimum === "number" && value < resolved.minimum) {
      issues.push({ path, message: `${resolved.minimum} 이상이어야 합니다(입력값 ${value}).`, keyword: "minimum" });
    }
    if (typeof resolved.maximum === "number" && value > resolved.maximum) {
      issues.push({ path, message: `${resolved.maximum} 이하여야 합니다(입력값 ${value}).`, keyword: "maximum" });
    }
  }

  if (typeof value === "string" && resolved.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    issues.push({ path, message: "YYYY-MM-DD 형식이어야 합니다.", keyword: "format" });
  }

  if (Array.isArray(value)) {
    if (typeof resolved.minItems === "number" && value.length < resolved.minItems) {
      issues.push({ path, message: `최소 ${resolved.minItems}개가 필요합니다(입력 ${value.length}개).`, keyword: "minItems" });
    }
    if (typeof resolved.maxItems === "number" && value.length > resolved.maxItems) {
      issues.push({ path, message: `최대 ${resolved.maxItems}개까지 허용합니다(입력 ${value.length}개).`, keyword: "maxItems" });
    }
    if (resolved.items) {
      value.forEach((item, index) => {
        issues.push(...validateValue(spec, resolved.items, item, `${path}[${index}]`, depth + 1));
      });
    }
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, JsonValue>;

    for (const key of resolved.required ?? []) {
      if (record[key] === undefined || record[key] === null || record[key] === "") {
        issues.push({ path: `${path}.${key}`, message: "필수 값이 없습니다.", keyword: "required" });
      }
    }

    for (const [key, child] of Object.entries(resolved.properties ?? {})) {
      if (record[key] === undefined) continue;
      issues.push(...validateValue(spec, child, record[key], `${path}.${key}`, depth + 1));
    }

    if (resolved.additionalProperties === false) {
      const allowed = new Set(Object.keys(resolved.properties ?? {}));
      for (const key of Object.keys(record)) {
        if (!allowed.has(key)) {
          issues.push({ path: `${path}.${key}`, message: "명세에 없는 필드입니다.", keyword: "additionalProperties" });
        }
      }
    }
  }

  return issues;
}

/* ─────────────────────────────────────────────────────────────
 * 요청 시뮬레이션
 * ───────────────────────────────────────────────────────────── */

export interface SimulationInput {
  pathParams?: Record<string, string>;
  query?: Record<string, string>;
  /** 요청 본문(문자열이면 JSON으로 파싱해 검증한다) */
  body?: string;
}

export interface SimulationResult {
  ok: boolean;
  /** 시뮬레이션 응답 상태 코드 */
  status: number;
  statusText: string;
  /** 명세의 예시 응답 또는 검증 실패 형식의 400 본문 */
  body: JsonValue;
  issues: ValidationIssue[];
  /** 브라우저에서 복사해 쓸 실제 요청 미리보기 */
  request: { method: string; url: string; headers: Record<string, string>; body?: string };
  curl: string;
}

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  400: "Bad Request",
  401: "Unauthorized",
  404: "Not Found",
  422: "Unprocessable Entity",
  500: "Internal Server Error",
};

function buildUrl(spec: OpenApiSpec, path: string, pathParams: Record<string, string> = {}, query: Record<string, string> = {}): string {
  const base = spec.servers?.[0]?.url ?? "http://127.0.0.1:8080";
  const resolvedPath = path.replace(/\{(\w+)\}/g, (_, key: string) => encodeURIComponent(pathParams[key] ?? `{${key}}`));
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== "") search.set(key, value);
  }
  const suffix = search.toString();
  return `${base}${resolvedPath}${suffix ? `?${suffix}` : ""}`;
}

/**
 * 한 요청을 "서버에 보내는 대신" 명세로 검증하고, 명세의 예시 응답을 돌려준다.
 *
 * - 필수 쿼리 파라미터가 비어 있으면 400 + 필드 목록
 * - 본문이 JSON이 아니면 400 + 파싱 오류
 * - 스키마 검증 실패는 400 + 위반 목록(첫 번째 메시지를 error.message로)
 * - 통과하면 2xx 예시 응답
 */
export function simulateRequest(spec: OpenApiSpec, entry: OperationEntry, input: SimulationInput): SimulationResult {
  const parameters = resolveParameters(spec, entry.operation);
  const query = { ...(input.query ?? {}) };
  const pathParams = { ...(input.pathParams ?? {}) };
  const issues: ValidationIssue[] = [];

  for (const parameter of parameters) {
    if (parameter.in !== "query" || !parameter.name) continue;
    const value = query[parameter.name] ?? "";
    if (parameter.required && value.trim() === "") {
      issues.push({ path: parameter.name, message: "필수 쿼리 파라미터가 비었습니다.", keyword: "required" });
      continue;
    }
    if (value === "") continue;

    const schema = resolveRef(spec, parameter.schema ?? {});
    if (schema.type === "integer" || schema.type === "number") {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || (schema.type === "integer" && !Number.isInteger(numeric))) {
        issues.push({ path: parameter.name, message: `${schema.type}여야 합니다(입력 ${JSON.stringify(value)}).`, keyword: "type" });
      } else {
        issues.push(...validateValue(spec, { ...schema, type: undefined }, numeric, parameter.name));
      }
    } else {
      issues.push(...validateValue(spec, { ...schema, required: undefined, properties: undefined }, value, parameter.name));
    }
  }

  let parsedBody: unknown;
  let rawBody: string | undefined;

  if (input.body !== undefined && input.body.trim() !== "") {
    rawBody = input.body;
    try {
      parsedBody = JSON.parse(input.body);
    } catch (error) {
      issues.push({
        path: "body",
        message: `JSON 파싱에 실패했습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
        keyword: "type",
      });
    }

    const media = entry.operation.requestBody?.content?.["application/json"];
    if (media?.schema && parsedBody !== undefined) {
      issues.push(...validateValue(spec, media.schema, parsedBody, "body"));
    } else if (!media && entry.operation.requestBody?.required) {
      issues.push({ path: "body", message: "이 엔드포인트는 요청 본문이 필요합니다.", keyword: "required" });
    }
  } else if (entry.operation.requestBody?.required) {
    issues.push({ path: "body", message: "요청 본문이 필요합니다.", keyword: "required" });
  }

  const url = buildUrl(spec, entry.path, pathParams, query);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (rawBody !== undefined) headers["Content-Type"] = "application/json";

  const curlParts = [`curl -X ${entry.method.toUpperCase()} '${url}'`];
  for (const [key, value] of Object.entries(headers)) curlParts.push(`  -H '${key}: ${value}'`);
  if (rawBody !== undefined) curlParts.push(`  --data-raw '${rawBody.replace(/'/g, "'\\''")}'`);
  const curl = curlParts.join(" \\\n");

  if (issues.length > 0) {
    const status = 400;
    return {
      ok: false,
      status,
      statusText: STATUS_TEXT[status] ?? "Bad Request",
      body: {
        error: {
          code: "invalid_request",
          message: issues[0]?.message ?? "요청이 올바르지 않습니다.",
          details: issues.map((issue) => ({ path: issue.path, keyword: issue.keyword, message: issue.message })),
        },
      },
      issues,
      request: { method: entry.method.toUpperCase(), url, headers, body: rawBody },
      curl,
    };
  }

  const success = successResponse(entry.operation);
  const status = success ? Number(success.status) : 200;
  const media = success?.response.content?.["application/json"];

  return {
    ok: true,
    status,
    statusText: STATUS_TEXT[status] ?? "OK",
    body: firstExample(media) ?? { message: "명세에 예시 응답이 없습니다." },
    issues: [],
    request: { method: entry.method.toUpperCase(), url, headers, body: rawBody },
    curl,
  };
}

/** 명세 자체의 최소 요건 검사 — `/api-docs`와 단위 테스트가 함께 쓴다. */
export function inspectSpec(spec: OpenApiSpec): { ok: boolean; problems: string[] } {
  const problems: string[] = [];

  if (!/^3\.0\.\d+$/.test(spec.openapi ?? "")) problems.push(`openapi 버전이 3.0.x가 아닙니다: ${spec.openapi}`);
  if (!spec.info?.title) problems.push("info.title이 없습니다.");
  if (!spec.info?.version) problems.push("info.version이 없습니다.");
  if (!spec.paths || Object.keys(spec.paths).length === 0) problems.push("paths가 비어 있습니다.");

  const operations = listOperations(spec);
  if (operations.length === 0) problems.push("오퍼레이션이 하나도 없습니다.");

  for (const entry of operations) {
    if (!entry.operation.responses || Object.keys(entry.operation.responses).length === 0) {
      problems.push(`${entry.method.toUpperCase()} ${entry.path}: responses가 없습니다.`);
    }
    if (!successResponse(entry.operation)) {
      problems.push(`${entry.method.toUpperCase()} ${entry.path}: 2xx 응답이 없습니다.`);
    }
  }

  // 외부 참조 금지 — CDN·다른 파일에 의존하면 오프라인/GitHub Pages에서 깨진다.
  const serialized = JSON.stringify(spec);
  if (/"\$ref"\s*:\s*"(?!#\/)/.test(serialized)) {
    problems.push("외부 $ref 참조가 있습니다. 명세는 자기완결이어야 합니다.");
  }

  return { ok: problems.length === 0, problems };
}
