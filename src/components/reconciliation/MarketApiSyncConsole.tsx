"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MARKET_API_META,
  MarketApiConnector,
  MarketApiError,
  createCredentialStore,
  defaultSettlementMonth,
  maskCredentials,
  monthRange,
  runSettlementIntake,
  sandboxLedgerFor,
  type ConnectionProbe,
  type IntakeResult,
  type MarketApiCredentials,
  type MarketApiProvider,
  type StoredCredentials,
} from "@/lib/marketApiConnector";
import { authorize, type RoleId } from "@/lib/multiTenantRbac";
import { formatThroughput } from "@/lib/csvStreamParser";
import { formatWon } from "@/lib/format";

/**
 * 마켓 정산 API 수집 콘솔
 *
 * 이 패널이 책임지는 것
 *  1. 자격 증명 입력·저장(선택)·마스킹 표시
 *  2. 정산월 선택과 연결 확인(인증 + 첫 페이지)
 *  3. 수집 → 셀러 원장 결합 → 대사 실행까지의 진행률
 *  4. 실패를 "무엇이 잘못됐고 무엇을 하면 되는지"로 번역해 보여 주기
 *
 * 대사 결과를 화면에 반영하는 일은 부모(콘솔)가 한다. 이 패널은 파이프라인만 돌리고 결과를 넘긴다
 * — 파일 업로더와 같은 소유권 경계다.
 */

export type ApiPanelNotice = { tone: "info" | "warn" | "error" | "success"; text: string };

interface Props {
  role: RoleId;
  tenantId: string;
  disabled?: boolean;
  onCollected: (result: IntakeResult) => void;
  onBusyChange?: (busy: boolean) => void;
  onNotice?: (notice: ApiPanelNotice) => void;
  onAudit?: (target: string, detail: string, outcome?: "allowed" | "denied") => void;
}

type Phase = "idle" | "probing" | "collecting" | "done" | "error";

interface DisplayError {
  code: string;
  title: string;
  message: string;
  hint: string;
  status: number | null;
}

const PROVIDERS: MarketApiProvider[] = ["smartstore", "coupang"];

const SANDBOX_CREDENTIALS: Record<MarketApiProvider, { clientId: string; clientSecret: string; vendorId?: string }> = {
  smartstore: { clientId: "sandbox-app-id", clientSecret: "$2a$10$sandboxabcdefghijklmnopqrstuvwxyz0123456789ABCDE" },
  coupang: { clientId: "sandbox-access-key", clientSecret: "sandbox-secret-key", vendorId: "sandbox-vendor" },
};

/** 환경변수로 프록시를 지정하면 실연동 경로를 쓴다(브라우저 직접 호출은 CORS로 막힌다). */
const PROXY_BASE = process.env.NEXT_PUBLIC_MARKET_API_PROXY?.trim() || undefined;

function toDisplayError(error: unknown): DisplayError {
  if (error instanceof MarketApiError) {
    const display = error.toDisplay();
    return { code: display.code, title: display.title, message: display.message, hint: display.hint, status: display.status };
  }
  return {
    code: "INTERNAL",
    title: "수집 실패",
    message: error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.",
    hint: "잠시 뒤 다시 시도해 주세요. 계속 실패하면 브라우저 콘솔의 네트워크 로그를 확인해 주세요.",
    status: null,
  };
}

export default function MarketApiSyncConsole({ role, tenantId, disabled = false, onCollected, onBusyChange, onNotice, onAudit }: Props) {
  const storeRef = useRef(createCredentialStore());
  const [provider, setProvider] = useState<MarketApiProvider>("smartstore");
  const [sandbox, setSandbox] = useState(true);
  const [month, setMonth] = useState(() => defaultSettlementMonth());
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [persist, setPersist] = useState(false);
  const [stored, setStored] = useState<StoredCredentials | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [percent, setPercent] = useState(0);
  const [statusText, setStatusText] = useState("정산월을 고르고 수집을 시작하세요");
  const [probe, setProbe] = useState<ConnectionProbe | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);
  const [result, setResult] = useState<IntakeResult | null>(null);

  const busy = phase === "probing" || phase === "collecting";
  const meta = MARKET_API_META[provider];

  const credentials = useMemo<MarketApiCredentials>(() => {
    const fallback = sandbox ? SANDBOX_CREDENTIALS[provider] : null;
    return {
      provider,
      clientId: clientId.trim() || fallback?.clientId || "",
      clientSecret: clientSecret.trim() || fallback?.clientSecret || "",
      vendorId: vendorId.trim() || fallback?.vendorId,
      sandbox,
    };
  }, [clientId, clientSecret, provider, sandbox, vendorId]);

  const publicView = useMemo(() => maskCredentials(credentials), [credentials]);

  // 저장된 프로필 불러오기. 시크릿은 "저장을 선택한 경우"에만 돌아온다.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const record = await storeRef.current.load(provider);
      if (cancelled) return;
      setStored(record ?? null);
      if (record) {
        setClientId(record.clientId);
        setVendorId(record.vendorId ?? "");
        setClientSecret(record.clientSecret ?? "");
        setPersist(record.secretPersisted);
        setSandbox(record.sandbox);
        setStatusText(`${meta.label} 저장된 연결 정보를 불러왔습니다`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider, meta.label]);

  const guard = useCallback((): boolean => {
    const decision = authorize({ role, activeTenantId: tenantId, action: "reconcile.run" });
    if (!decision.allowed) {
      setError({ code: decision.code, title: "권한이 없습니다", message: decision.reason, hint: "대사 실행 권한이 있는 역할로 전환해 주세요.", status: null });
      onAudit?.(`${meta.label} API 수집`, decision.reason, "denied");
      return false;
    }
    return true;
  }, [meta.label, onAudit, role, tenantId]);

  const saveProfile = useCallback(async () => {
    try {
      monthRange(month);
    } catch (caught) {
      setError(toDisplayError(caught));
      return;
    }
    await storeRef.current.save({
      provider,
      clientId: credentials.clientId,
      clientSecret: persist ? credentials.clientSecret : undefined,
      secretPersisted: persist && Boolean(credentials.clientSecret),
      vendorId: credentials.vendorId,
      sandbox,
      savedAt: new Date().toISOString(),
    });
    const record = await storeRef.current.load(provider);
    setStored(record ?? null);
    onNotice?.({
      tone: "success",
      text: persist
        ? `${meta.label} 연결 정보를 이 브라우저에 저장했습니다. 공용 PC에서는 저장하지 마세요.`
        : `${meta.label} 연결 정보를 저장했습니다(시크릿은 이 탭을 닫으면 사라집니다).`,
    });
    onAudit?.(`${meta.label} 자격 증명`, persist ? "브라우저 저장(시크릿 포함)" : "브라우저 저장(시크릿 제외)");
  }, [credentials, meta.label, month, onAudit, onNotice, persist, provider, sandbox]);

  const clearProfile = useCallback(async () => {
    await storeRef.current.remove(provider);
    setStored(null);
    setClientId("");
    setClientSecret("");
    setVendorId("");
    setPersist(false);
    setProbe(null);
    setStatusText("저장된 연결 정보를 삭제했습니다");
    onNotice?.({ tone: "info", text: `${meta.label} 연결 정보를 삭제했습니다.` });
    onAudit?.(`${meta.label} 자격 증명`, "브라우저 저장 삭제");
  }, [meta.label, onAudit, onNotice, provider]);

  const buildConnector = useCallback(
    () => new MarketApiConnector({ credentials, proxyBaseUrl: PROXY_BASE }),
    [credentials],
  );

  const runProbe = useCallback(async () => {
    if (!guard()) return;
    if (disabled || busy) return;
    setError(null);
    setProbe(null);
    setResult(null);
    setPhase("probing");
    setPercent(12);
    setStatusText(`${meta.label}에 인증하고 첫 페이지를 확인하는 중`);
    onBusyChange?.(true);
    try {
      const outcome = await buildConnector().probe({ month });
      setProbe(outcome);
      setPercent(100);
      if (outcome.ok) {
        setPhase("done");
        setStatusText(outcome.message);
        onAudit?.(`${meta.label} 연결 확인`, `${outcome.message} · ${outcome.latencyMs}ms`);
      } else {
        setPhase("error");
        setStatusText("연결 확인 실패");
        setError({ code: "AUTH", title: `${meta.label} 연결 확인 실패`, message: outcome.message, hint: "키·시크릿과 정산 조회 권한을 확인해 주세요.", status: outcome.status || null });
      }
    } catch (caught) {
      const display = toDisplayError(caught);
      setError(display);
      setPhase("error");
      setPercent(0);
      setStatusText(display.message);
    } finally {
      onBusyChange?.(false);
    }
  }, [busy, buildConnector, disabled, guard, meta.label, month, onAudit, onBusyChange]);

  const runCollect = useCallback(async () => {
    if (!guard()) return;
    if (disabled || busy) return;
    if (!sandbox && !PROXY_BASE) {
      setError({
        code: "CONFIG",
        title: "실연동 경로가 설정되지 않았습니다",
        message: "마켓 API는 브라우저 직접 호출(CORS)을 허용하지 않습니다.",
        hint: "서버 프록시를 붙이고 NEXT_PUBLIC_MARKET_API_PROXY를 설정하면 실연동이 켜집니다. 지금은 샌드박스 모드로 전체 흐름을 확인할 수 있습니다.",
        status: null,
      });
      return;
    }
    setError(null);
    setResult(null);
    setProbe(null);
    setPhase("collecting");
    setPercent(6);
    setStatusText("수집 준비");
    onBusyChange?.(true);
    try {
      const outcome = await runSettlementIntake(buildConnector(), {
        month,
        ledger: sandbox ? sandboxLedgerFor(provider, month) : undefined,
        pageSize: 500,
        onProgress: (step) => {
          setPercent(Math.max(4, Math.min(99, step.percent)));
          setStatusText(step.message);
        },
      });
      setResult(outcome);
      setPhase("done");
      setPercent(100);
      setStatusText(`${outcome.rows.length.toLocaleString("ko-KR")}건 수집 · 대사 완료`);
      onCollected(outcome);
      onAudit?.(
        `${meta.label} API ${month}`,
        `${outcome.records.length.toLocaleString("ko-KR")}건 · ${outcome.meta.pages}페이지 · 누수 ${formatWon(outcome.reconciled.summary.totalLeak)}`,
      );
      onNotice?.({
        tone: "success",
        text: `${meta.label} ${month} 정산 ${outcome.records.length.toLocaleString("ko-KR")}건을 수집해 대사했습니다. 누수 ${formatWon(outcome.reconciled.summary.totalLeak)}를 찾았습니다.`,
      });
    } catch (caught) {
      const display = toDisplayError(caught);
      setError(display);
      setPhase("error");
      setPercent(0);
      setStatusText(display.message);
      onNotice?.({ tone: "error", text: `${display.title}: ${display.message}` });
    } finally {
      onBusyChange?.(false);
    }
  }, [busy, buildConnector, disabled, guard, meta.label, month, onAudit, onBusyChange, onCollected, onNotice, provider, sandbox]);

  const phaseLabel = phase === "probing" ? "확인 중" : phase === "collecting" ? "수집 중" : phase === "done" ? "완료" : phase === "error" ? "실패" : "대기";

  return (
    <section className="card p-4" data-testid="market-api-panel" aria-label="마켓 정산 API 자동 수집">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400/80">API 자동 수집</p>
          <p className="mt-1 text-[12.5px] text-slate-300">마켓 API에서 정산 내역을 직접 받아 원장과 대사합니다.</p>
          <p className="mt-0.5 text-[10.5px] leading-relaxed text-slate-500">
            샌드박스는 네트워크 없이 그 달의 정산 내역을 재현합니다. 시크릿은 입력 후 마스킹되어 다시 표시되지 않습니다.
          </p>
        </div>
        <span
          className={`rounded-md border px-2 py-1 text-[10px] ${
            sandbox ? "border-indigo-400/30 bg-indigo-400/10 text-indigo-200" : "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
          }`}
          data-testid="api-mode-badge"
        >
          {sandbox ? "샌드박스 모드 · 네트워크 없음" : "실연동 모드"}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {PROVIDERS.map((key) => {
          const active = key === provider;
          return (
            <button
              key={key}
              type="button"
              onClick={() => {
                if (busy) return;
                setProvider(key);
                setError(null);
                setProbe(null);
                setResult(null);
                setStatusText("정산월을 고르고 수집을 시작하세요");
              }}
              aria-pressed={active}
              data-testid={`api-provider-${key}`}
              className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition ${
                active
                  ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
                  : "border-white/[0.08] bg-white/[0.03] text-slate-400 hover:border-white/20 hover:text-slate-200"
              }`}
            >
              {MARKET_API_META[key].label}
              <span className="ml-1 text-[10px] opacity-60">{MARKET_API_META[key].authKind === "hmac-sha256" ? "HMAC" : "OAuth2"}</span>
            </button>
          );
        })}
        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-slate-400">
          <input
            type="checkbox"
            checked={sandbox}
            disabled={busy}
            onChange={(event) => setSandbox(event.target.checked)}
            data-testid="api-sandbox-toggle"
            className="h-3.5 w-3.5 rounded border-white/20 bg-white/5 text-emerald-400"
          />
          샌드박스
        </label>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <label className="block">
          <span className="text-[10px] text-slate-500">정산월</span>
          <input
            type="month"
            value={month}
            disabled={busy}
            onChange={(event) => setMonth(event.target.value || defaultSettlementMonth())}
            data-testid="api-month"
            className="mt-0.5 w-full rounded-lg border border-white/[0.08] bg-ink-900 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-emerald-400/50"
          />
        </label>
        <label className="block">
          <span className="text-[10px] text-slate-500">{provider === "coupang" ? "Access Key" : "애플리케이션 ID"}</span>
          <input
            value={clientId}
            disabled={busy}
            onChange={(event) => setClientId(event.target.value)}
            placeholder={sandbox ? SANDBOX_CREDENTIALS[provider].clientId : meta.secretHint}
            data-testid="api-client-id"
            autoComplete="off"
            spellCheck={false}
            className="mt-0.5 w-full rounded-lg border border-white/[0.08] bg-ink-900 px-2 py-1.5 font-mono text-[11px] text-slate-200 outline-none focus:border-emerald-400/50"
          />
        </label>
        <label className="block">
          <span className="text-[10px] text-slate-500">{provider === "coupang" ? "Secret Key" : "시크릿"}</span>
          <input
            type="password"
            value={clientSecret}
            disabled={busy}
            onChange={(event) => setClientSecret(event.target.value)}
            placeholder={sandbox ? "샌드박스는 예시 키로 동작" : "시크릿을 입력하세요"}
            data-testid="api-client-secret"
            autoComplete="new-password"
            className="mt-0.5 w-full rounded-lg border border-white/[0.08] bg-ink-900 px-2 py-1.5 font-mono text-[11px] text-slate-200 outline-none focus:border-emerald-400/50"
          />
        </label>
        <label className="block">
          <span className="text-[10px] text-slate-500">{provider === "coupang" ? "업체코드(vendorId)" : "스토어 구분"}</span>
          {provider === "coupang" ? (
            <input
              value={vendorId}
              disabled={busy}
              onChange={(event) => setVendorId(event.target.value)}
              placeholder={sandbox ? SANDBOX_CREDENTIALS.coupang.vendorId : "예: A00123456"}
              data-testid="api-vendor-id"
              autoComplete="off"
              className="mt-0.5 w-full rounded-lg border border-white/[0.08] bg-ink-900 px-2 py-1.5 font-mono text-[11px] text-slate-200 outline-none focus:border-emerald-400/50"
            />
          ) : (
            <p className="mt-0.5 rounded-lg border border-white/[0.05] bg-white/[0.015] px-2 py-1.5 text-[10.5px] text-slate-500">
              내 스토어 앱 · type=SELF
            </p>
          )}
        </label>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[10.5px] text-slate-500">
        <span className="tabular-nums">
          {publicView.hasSecret ? `키 ${publicView.clientIdMasked} · 시크릿 ${publicView.secretMasked}` : "키가 아직 입력되지 않았습니다"}
        </span>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={persist}
            disabled={busy}
            onChange={(event) => setPersist(event.target.checked)}
            data-testid="api-persist-toggle"
            className="h-3.5 w-3.5 rounded border-white/20 bg-white/5 text-emerald-400"
          />
          이 브라우저에 저장(시크릿 포함)
        </label>
        <button type="button" onClick={() => void saveProfile()} disabled={busy} className="text-emerald-300/90 transition hover:text-emerald-200 disabled:opacity-40">
          저장
        </button>
        {stored && (
          <button type="button" onClick={() => void clearProfile()} disabled={busy} className="text-slate-400 transition hover:text-rose-300 disabled:opacity-40">
            저장 삭제
          </button>
        )}
        <span className="ml-auto">{meta.label} · {meta.authKind === "hmac-sha256" ? "CEA HMAC-SHA256 서명" : "OAuth2 + bcrypt 전자서명"}</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => void runProbe()}
          disabled={disabled || busy}
          data-testid="api-probe"
          className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-medium text-slate-300 transition enabled:hover:border-white/20 enabled:hover:text-white disabled:opacity-40"
        >
          연결 테스트
        </button>
        <button
          type="button"
          onClick={() => void runCollect()}
          disabled={disabled || busy}
          data-testid="api-collect"
          className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-200 transition enabled:hover:border-emerald-400/60 enabled:hover:bg-emerald-400/15 disabled:opacity-40"
        >
          정산 수집 + 대사 실행
        </button>
        {busy && <span className="text-[10.5px] tabular-nums text-emerald-300/80">{phaseLabel}…</span>}
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between text-[10.5px] text-slate-500">
          <span className="tabular-nums" data-testid="api-status">
            {statusText}
          </span>
          <span className="tabular-nums">
            {phaseLabel} · {percent}%
          </span>
        </div>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className={`h-full rounded-full transition-[width] duration-300 ${phase === "error" ? "bg-rose-400" : "bg-emerald-400/80"}`}
            style={{ width: `${Math.max(2, percent)}%` }}
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="API 수집 진행률"
            data-testid="api-progress"
          />
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-rose-400/25 bg-rose-400/[0.07] px-3 py-2 text-[11px] leading-relaxed text-rose-200" data-testid="api-error" role="alert">
          <p className="font-semibold">
            {error.title}
            {error.status ? <span className="ml-1 font-mono text-[10px] opacity-70">HTTP {error.status}</span> : null}
            <span className="ml-1 rounded bg-rose-400/10 px-1 font-mono text-[9.5px] uppercase opacity-80">{error.code}</span>
          </p>
          <p className="mt-0.5">{error.message}</p>
          <p className="mt-1 text-rose-200/75">{error.hint}</p>
        </div>
      )}

      {probe?.ok && !result && (
        <p className="mt-3 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.06] px-3 py-2 text-[11px] text-emerald-200" data-testid="api-probe-result">
          {probe.message} · {probe.latencyMs}ms · {probe.sandbox ? "샌드박스" : "실연동"}
        </p>
      )}

      {result && (
        <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3 xl:grid-cols-6" data-testid="api-result">
          <Stat label="수집 건수" value={`${result.records.length.toLocaleString("ko-KR")}건`} />
          <Stat label="페이지" value={`${result.meta.pages}회`} hint={`버린 행 ${result.meta.droppedRecords}건`} />
          <Stat label="원장 결합" value={`${result.meta.ledgerHits.toLocaleString("ko-KR")}건`} tone={result.meta.ledgerMisses > 0 ? "warn" : "normal"} hint={`누락 ${result.meta.ledgerMisses}건`} />
          <Stat label="이상 징후" value={`${result.reconciled.summary.flaggedRows.toLocaleString("ko-KR")}건`} tone="warn" />
          <Stat label="누수" value={formatWon(result.reconciled.summary.totalLeak)} tone="warn" />
          <Stat label="소요" value={`${(result.meta.elapsedMs / 1000).toFixed(2)}초`} hint={formatThroughput(Math.round((result.rows.length / Math.max(1, result.meta.elapsedMs)) * 1000))} />
        </div>
      )}

      {!sandbox && (
        <p className="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-[10.5px] leading-relaxed text-amber-200">
          실연동은 서버 프록시가 필요합니다. 마켓 API는 브라우저 직접 호출(CORS)을 허용하지 않으며, 자격 증명도 브라우저에
          두지 않는 구성이 권장됩니다. 이 데모 빌드는 <code className="font-mono">NEXT_PUBLIC_MARKET_API_PROXY</code>가 없으면
          실연동을 시작하지 않습니다.
        </p>
      )}
    </section>
  );
}

function Stat({ label, value, hint, tone = "normal" }: { label: string; value: string; hint?: string; tone?: "normal" | "warn" }) {
  return (
    <div className="rounded-lg border border-white/[0.05] bg-white/[0.015] px-2.5 py-1.5">
      <p className="text-[9.5px] text-slate-500">{label}</p>
      <p className={`mt-0.5 text-[12px] font-semibold tabular-nums ${tone === "warn" ? "text-amber-300" : "text-slate-200"}`}>{value}</p>
      {hint && <p className="mt-0.5 truncate text-[9.5px] text-slate-600">{hint}</p>}
    </div>
  );
}
