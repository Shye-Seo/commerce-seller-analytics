"use client";

/**
 * 인터랙티브 API 문서 (`/api-docs`)
 *
 * Swagger UI 같은 외부 CDN에 의존하지 않는다. 명세 파일(`public/openapi.json`) 하나를 브라우저가
 * 읽어 직접 그린다 — GitHub Pages처럼 별도 서버가 없는 정적 배포에서도 문서가 그대로 뜨고,
 * 네트워크가 막혀도(명세는 같은 출처) 화면이 비지 않는다.
 *
 * "Try it out"은 서버를 호출하지 않는다. 대신
 *   1. 명세로 요청을 검증하고(필수 값·타입·enum·1~5,000행 상한)
 *   2. 명세에 적힌 예시 응답을 보여 준다.
 * 실제 호출은 로컬에서 `php -S 127.0.0.1:8080 -t backend/public`로 띄운 뒤 아래 curl을 실행한다.
 * 화면은 이 경계를 숨기지 않고 배지로 표시한다.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Header from "@/components/Header";
import {
  firstExample,
  inspectSpec,
  listOperations,
  resolveParameters,
  resolveRef,
  simulateRequest,
  type JsonSchema,
  type OpenApiSpec,
  type OperationEntry,
  type SimulationResult,
} from "@/lib/openapiSimulator";

const METHOD_STYLES: Record<string, string> = {
  get: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  post: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  put: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  patch: "border-violet-400/30 bg-violet-400/10 text-violet-300",
  delete: "border-rose-400/30 bg-rose-400/10 text-rose-300",
};

function MethodBadge({ method }: { method: string }) {
  return (
    <span className={`inline-flex w-14 justify-center rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${METHOD_STYLES[method] ?? "border-white/15 bg-white/5 text-slate-300"}`}>
      {method}
    </span>
  );
}

function SchemaTree({ spec, schema, depth = 0 }: { spec: OpenApiSpec; schema?: JsonSchema; depth?: number }) {
  const resolved = resolveRef(spec, schema ?? {});
  if (!resolved || Object.keys(resolved).length === 0) {
    return <p className="text-[11px] text-slate-600">스키마 정보 없음</p>;
  }

  const entries = Object.entries(resolved.properties ?? {});
  const required = new Set(resolved.required ?? []);

  return (
    <div className={depth === 0 ? "" : "mt-1 border-l border-white/[0.06] pl-3"}>
      {resolved.type && (
        <p className="text-[10.5px] text-slate-500">
          {resolved.type}
          {resolved.format ? ` (${resolved.format})` : ""}
          {resolved.nullable ? " · nullable" : ""}
          {resolved.minItems !== undefined || resolved.maxItems !== undefined ? ` · ${resolved.minItems ?? 0}~${resolved.maxItems ?? "∞"}개` : ""}
        </p>
      )}
      {resolved.enum && (
        <p className="mt-0.5 text-[10.5px] text-slate-500">
          enum: {resolved.enum.map((value) => String(value)).join(" | ")}
        </p>
      )}

      {entries.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {entries.map(([key, child]) => {
            const childResolved = resolveRef(spec, child);
            const isObject = childResolved.type === "object" || Boolean(childResolved.properties);
            const isArray = childResolved.type === "array";
            return (
              <div key={key}>
                <p className="text-[11px] leading-relaxed">
                  <span className="font-mono text-slate-200">{key}</span>
                  <span className="ml-1 text-slate-500">{childResolved.type ?? (isObject ? "object" : "")}</span>
                  {required.has(key) && <span className="ml-1 rounded bg-rose-400/10 px-1 text-[9px] text-rose-300">required</span>}
                  {childResolved.description && <span className="ml-1 text-[10px] text-slate-600">— {childResolved.description}</span>}
                </p>
                {depth < 2 && (isObject || isArray) && (
                  <SchemaTree spec={spec} schema={isArray ? childResolved.items : childResolved} depth={depth + 1} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-lg border border-white/[0.06] bg-[#070B16] px-3 py-2 text-[10.5px] leading-relaxed text-slate-300 thin-scrollbar">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export default function ApiDocsConsole() {
  const [spec, setSpec] = useState<OpenApiSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState<Record<string, string>>({});
  const [body, setBody] = useState("");
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    fetch(`${base}/openapi.json`)
      .then((response) => {
        if (!response.ok) throw new Error(`명세를 불러오지 못했습니다(HTTP ${response.status})`);
        return response.json() as Promise<OpenApiSpec>;
      })
      .then((parsed) => setSpec(parsed))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "명세를 불러오지 못했습니다"));
  }, []);

  const operations = useMemo(() => (spec ? listOperations(spec) : []), [spec]);
  const inspection = useMemo(() => (spec ? inspectSpec(spec) : null), [spec]);
  const grouped = useMemo(() => {
    const map = new Map<string, OperationEntry[]>();
    for (const entry of operations) {
      const list = map.get(entry.tag) ?? [];
      list.push(entry);
      map.set(entry.tag, list);
    }
    return [...map.entries()];
  }, [operations]);

  const selected = operations.find((entry) => entry.operationId === selectedId) ?? operations[0] ?? null;

  const primeInputs = useCallback(
    (entry: OperationEntry | null) => {
      if (!spec || !entry) return;
      const nextQuery: Record<string, string> = {};
      for (const parameter of resolveParameters(spec, entry.operation)) {
        if (parameter.in !== "query" || !parameter.name) continue;
        const schema = resolveRef(spec, parameter.schema ?? {});
        const value = schema.example ?? schema.default ?? (schema.enum?.[0] as string | undefined) ?? "";
        nextQuery[parameter.name] = value === undefined ? "" : String(value);
      }
      setQuery(nextQuery);

      const media = entry.operation.requestBody?.content?.["application/json"];
      const example = firstExample(media);
      setBody(example === undefined ? "" : JSON.stringify(example, null, 2));
      setResult(null);
    },
    [spec],
  );

  useEffect(() => {
    primeInputs(selected);
  }, [selected, primeInputs]);

  function runSimulation(entry: OperationEntry) {
    if (!spec) return;
    setResult(simulateRequest(spec, entry, { query, body }));
    setCopied(false);
  }

  async function copyCurl(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="min-h-screen">
      <Header />

      <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8" data-testid="api-docs-page">
        <section className="mb-6">
          <span className="chip">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
            OpenAPI 3.0 · 브라우저 내 시뮬레이션
          </span>
          <h1 className="mt-4 max-w-3xl text-[26px] font-semibold leading-[1.32] tracking-tight text-white sm:text-[32px]">
            정산 대사 API 명세와 <span className="text-emerald-300">요청 검증</span>
          </h1>
          <p className="mt-3 max-w-3xl text-[13px] leading-relaxed text-slate-400">
            이 페이지는 <code className="rounded bg-white/[0.06] px-1 py-0.5 text-[12px] text-slate-300">public/openapi.json</code>을 그대로 읽어 그립니다.
            엔드포인트를 고르면 요청·응답 스키마와 예시를 보고, 파라미터·본문을 바꿔 명세 기준 검증 결과를 확인할 수 있습니다.
            서버로 요청을 보내지는 않습니다(정적 배포에는 백엔드가 없습니다).
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {[
              `${operations.length}개 엔드포인트`,
              spec?.info?.version ? `API v${spec.info.version}` : "명세 로딩 중",
              "외부 CDN 미사용",
              "요청 스키마 검증",
              "예시 응답",
            ].map((badge) => (
              <span key={badge} className="rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[10.5px] font-medium text-slate-400">
                {badge}
              </span>
            ))}
          </div>
        </section>

        {error && (
          <div className="mb-4 rounded-xl border border-rose-400/25 bg-rose-400/[0.07] px-3.5 py-2.5 text-[12px] text-rose-200">
            {error} — `npm run dev` 또는 정적 배포 환경에서 `openapi.json`이 같은 경로에 있는지 확인해 주세요.
          </div>
        )}

        {inspection && !inspection.ok && (
          <div className="mb-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] px-3.5 py-2.5 text-[11.5px] text-amber-200">
            명세 자체 점검에서 문제가 발견되었습니다: {inspection.problems.join(" / ")}
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[264px_minmax(0,1fr)]">
          <aside className="lg:sticky lg:top-20 lg:self-start">
            <div className="card p-3">
              <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Endpoints</p>
              <div className="space-y-2" data-testid="api-op-list">
                {grouped.map(([tag, entries]) => (
                  <div key={tag}>
                    <p className="px-1 pt-1 text-[10px] font-medium text-slate-400">{spec?.tags?.find((item) => item.name === tag)?.description ?? tag}</p>
                    <ul className="mt-1 space-y-0.5">
                      {entries.map((entry) => {
                        const active = entry.operationId === selected?.operationId;
                        return (
                          <li key={entry.operationId}>
                            <button
                              type="button"
                              onClick={() => setSelectedId(entry.operationId)}
                              className={`flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1.5 text-left transition ${
                                active ? "bg-emerald-400/[0.08] text-emerald-100" : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
                              }`}
                            >
                              <MethodBadge method={entry.method} />
                              <span className="truncate font-mono text-[10.5px]">{entry.path}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
                {operations.length === 0 && !error && <p className="px-1 py-3 text-[11px] text-slate-500">명세를 불러오는 중입니다…</p>}
              </div>
            </div>

            <div className="card mt-3 p-3 text-[10.5px] leading-relaxed text-slate-500">
              <p className="font-medium text-slate-300">로컬 백엔드 실행</p>
              <pre className="mt-1.5 overflow-x-auto rounded bg-[#070B16] px-2 py-1.5 text-[10px] text-slate-300">php -S 127.0.0.1:8080 -t backend/public</pre>
              <p className="mt-2">MySQL이 필요하면 `docker compose up -d` 후 `php backend/bin/migrate.php`를 먼저 실행합니다.</p>
            </div>
          </aside>

          <div className="space-y-4">
            {selected && spec && (
              <>
                <section className="card p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <MethodBadge method={selected.method} />
                    <code className="text-[14px] font-semibold text-white">{selected.path}</code>
                    <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[10px] text-slate-400">{selected.operationId}</span>
                  </div>
                  <p className="mt-2 text-[13px] font-medium text-slate-200">{selected.operation.summary}</p>
                  {selected.operation.description && (
                    <p className="mt-1 whitespace-pre-wrap text-[11.5px] leading-relaxed text-slate-500">{selected.operation.description}</p>
                  )}

                  {(() => {
                    const parameters = resolveParameters(spec, selected.operation);
                    if (parameters.length === 0) return null;
                    return (
                      <div className="mt-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Parameters</p>
                        <table className="mt-1 w-full text-left text-[11px]">
                          <thead className="text-[10px] text-slate-600">
                            <tr>
                              <th className="py-1 font-medium">이름</th>
                              <th className="py-1 font-medium">위치</th>
                              <th className="py-1 font-medium">타입</th>
                              <th className="py-1 font-medium">설명</th>
                            </tr>
                          </thead>
                          <tbody>
                            {parameters.map((parameter) => (
                              <tr key={`${parameter.in}-${parameter.name}`} className="border-t border-white/[0.04]">
                                <td className="py-1 font-mono text-slate-200">
                                  {parameter.name}
                                  {parameter.required && <span className="ml-1 text-[9px] text-rose-300">required</span>}
                                </td>
                                <td className="py-1 text-slate-500">{parameter.in}</td>
                                <td className="py-1 text-slate-500">
                                  {parameter.schema?.type}
                                  {parameter.schema?.enum ? ` (${parameter.schema.enum.join("|")})` : ""}
                                </td>
                                <td className="py-1 text-slate-500">{parameter.description}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })()}

                  {selected.operation.requestBody && (
                    <div className="mt-3">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                        Request body {selected.operation.requestBody.required ? "(required)" : ""}
                      </p>
                      <div className="mt-1 rounded-lg border border-white/[0.05] bg-white/[0.015] px-2.5 py-2">
                        <SchemaTree spec={spec} schema={selected.operation.requestBody.content?.["application/json"]?.schema} />
                      </div>
                    </div>
                  )}

                  <div className="mt-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Responses</p>
                    <div className="mt-1 space-y-1.5">
                      {Object.entries(selected.operation.responses ?? {}).map(([code, response]) => (
                        <details key={code} className="rounded-lg border border-white/[0.05] bg-white/[0.015] px-2.5 py-1.5">
                          <summary className="cursor-pointer text-[11px] text-slate-300">
                            <span className={`mr-1.5 rounded px-1 text-[10px] ${code.startsWith("2") ? "bg-emerald-400/10 text-emerald-300" : "bg-rose-400/10 text-rose-300"}`}>{code}</span>
                            {response.description}
                          </summary>
                          <div className="mt-1.5">
                            <SchemaTree spec={spec} schema={response.content?.["application/json"]?.schema} />
                          </div>
                        </details>
                      ))}
                    </div>
                  </div>
                </section>

                <section className="card p-4" data-testid="api-try-panel">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400/80">Try it out</p>
                      <p className="mt-1 text-[11px] text-slate-500">
                        요청 값을 바꾸고 검증해 보세요. 서버 호출 없이 명세 기준 검증과 예시 응답을 보여 줍니다.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => primeInputs(selected)}
                      className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-[11px] text-slate-400 transition hover:border-white/20 hover:text-white"
                    >
                      예시로 되돌리기
                    </button>
                  </div>

                  {(() => {
                    const parameters = resolveParameters(spec, selected.operation).filter((parameter) => parameter.in === "query");
                    if (parameters.length === 0) return null;
                    return (
                      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                        {parameters.map((parameter) => (
                          <label key={parameter.name} className="flex flex-col gap-1">
                            <span className="text-[10px] text-slate-500">
                              {parameter.name}
                              {parameter.required ? <span className="ml-1 text-rose-300">*</span> : null}
                            </span>
                            <input
                              value={query[parameter.name ?? ""] ?? ""}
                              onChange={(event) => setQuery((previous) => ({ ...previous, [parameter.name ?? ""]: event.target.value }))}
                              placeholder={parameter.schema?.example !== undefined ? String(parameter.schema.example) : ""}
                              className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-[11.5px] text-slate-200 outline-none focus:border-emerald-400/50"
                              aria-label={`${parameter.name} 값`}
                            />
                          </label>
                        ))}
                      </div>
                    );
                  })()}

                  {selected.operation.requestBody && (
                    <label className="mt-3 flex flex-col gap-1">
                      <span className="text-[10px] text-slate-500">요청 본문 (JSON)</span>
                      <textarea
                        value={body}
                        onChange={(event) => setBody(event.target.value)}
                        rows={12}
                        spellCheck={false}
                        className="w-full rounded-lg border border-white/[0.08] bg-[#070B16] px-3 py-2 font-mono text-[10.5px] leading-relaxed text-slate-300 outline-none focus:border-emerald-400/50"
                        aria-label="요청 본문"
                      />
                    </label>
                  )}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => runSimulation(selected)}
                      data-testid="api-try-submit"
                      className="rounded-lg bg-emerald-500 px-3.5 py-2 text-[12px] font-semibold text-ink-950 transition hover:bg-emerald-400"
                    >
                      요청 검증 · 예시 응답
                    </button>
                    <span className="text-[10.5px] text-slate-600">
                      {selected.method.toUpperCase()} {selected.path} · 시뮬레이션
                    </span>
                  </div>

                  {result && (
                    <div className="mt-3 space-y-2" data-testid="api-try-result">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold tabular-nums ${
                            result.ok ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" : "border-rose-400/30 bg-rose-400/10 text-rose-300"
                          }`}
                        >
                          {result.status} {result.statusText}
                        </span>
                        <span className="text-[10.5px] text-slate-500">
                          {result.ok ? "명세 검증 통과 · 예시 응답" : `검증 실패 ${result.issues.length}건`}
                        </span>
                        <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-[9.5px] text-amber-300">실제 호출 아님</span>
                      </div>

                      {result.issues.length > 0 && (
                        <ul className="space-y-0.5 rounded-lg border border-rose-400/20 bg-rose-400/[0.05] px-3 py-2 text-[10.5px] text-rose-200">
                          {result.issues.map((issue, index) => (
                            <li key={`${issue.path}-${index}`}>
                              <span className="font-mono text-rose-300">{issue.path}</span> — {issue.message}
                            </li>
                          ))}
                        </ul>
                      )}

                      <JsonBlock value={result.body} />

                      <details className="rounded-lg border border-white/[0.05] bg-white/[0.015] px-2.5 py-1.5">
                        <summary className="cursor-pointer text-[10.5px] text-slate-400">curl로 실제 호출하기</summary>
                        <pre className="mt-1.5 overflow-x-auto rounded bg-[#070B16] px-2 py-1.5 text-[10px] leading-relaxed text-slate-300">{result.curl}</pre>
                        <button
                          type="button"
                          onClick={() => void copyCurl(result.curl)}
                          className="mt-1.5 rounded border border-white/[0.1] bg-white/[0.03] px-2 py-1 text-[10px] text-slate-300 transition hover:border-white/25"
                        >
                          {copied ? "복사됨" : "명령 복사"}
                        </button>
                      </details>
                    </div>
                  )}
                </section>
              </>
            )}

            <p className="pb-6 text-[10.5px] leading-relaxed text-slate-600">
              이 문서는 저장소의 <code className="text-slate-500">public/openapi.json</code>을 단일 소스로 씁니다. 명세를 고치면 페이지가 그대로
              반영하고, 단위 테스트가 `backend/public/index.php`의 라우트와 명세 경로가 어긋나지 않았는지 확인합니다.
              인증·레이트 리밋·SENS 실발송은 운영 배포 단계의 항목이며, 현재 명세는 로컬 데모 범위입니다.
            </p>
          </div>
        </div>
      </main>

      <footer className="border-t border-white/[0.06] bg-ink-900/40">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-5 text-[11px] text-slate-500 sm:px-6 lg:px-8">
          <span>서승혜 · Commerce SaaS Engineer · API 문서</span>
          <span className="flex gap-3">
            <Link href="/" className="transition hover:text-slate-200">
              대시보드
            </Link>
            <Link href="/reconciliation" className="transition hover:text-slate-200">
              정산 대사 콘솔
            </Link>
            <a href="https://github.com/Shye-Seo/commerce-seller-analytics" target="_blank" rel="noreferrer noopener" className="transition hover:text-slate-200">
              GitHub
            </a>
          </span>
        </div>
      </footer>
    </div>
  );
}
