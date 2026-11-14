"use client";

/**
 * 알림톡 발송 콘솔 (시뮬레이터)
 *
 * 정산 이상을 카카오 알림톡으로 보내는 흐름을 브라우저에서 그대로 돌려 본다. 실제 SENS 호출은
 * 자격 증명·검수 템플릿이 필요하므로 일어나지 않으며, 화면 곳곳에 그 사실을 표시한다.
 *
 * 이 패널이 보여 주는 것
 *   · 카카오톡 말풍선 미리보기 — 템플릿 변수로 채운 실제 본문
 *   · 발송 이력 타임라인 — queued → accepted(202) → delivered/failed, 시도 횟수, 오류 코드
 *   · 중복 차단 — 같은 주문·같은 원인으로 두 번 발송하면 skip으로 남는다
 *   · 실패 재시도 — 재시도 가능한 오류(429)는 성공하고, 템플릿·서명 오류는 그대로 남는다
 */

import { useMemo, useState } from "react";
import {
  ALIMTALK_TEMPLATES,
  MAX_SEND_ATTEMPTS,
  SEND_SCENARIOS,
  SensSimulator,
  collectCriticalAlerts,
  dispatchAnomalyAlerts,
  dispatchBatchSummary,
  normalizeRecipientPhone,
  retryAlimtalk,
  summarizeAlimtalkLogs,
  type AlimtalkLogEntry,
  type SendScenario,
} from "@/lib/alimtalkSimulator";
import { alimtalkLogStore, useAlimtalkLogs } from "@/lib/alimtalkLogStore";
import { formatWon } from "@/lib/format";
import { biggestLeakCause, type ReconciledRow, type ReconciliationSummary } from "@/lib/reconciliationEngine";

interface Props {
  rows: readonly ReconciledRow[];
  summary: ReconciliationSummary | null;
  batchId: string;
  datasetLabel: string;
}

const TENANT_ID = 1;
const PLUS_FRIEND_ID = "@sellerscope";

const timeFormatter = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function statusChip(status: AlimtalkLogEntry["status"]): { label: string; className: string } {
  switch (status) {
    case "accepted":
      return { label: "accepted 202", className: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" };
    case "delivered":
      return { label: "delivered 0000", className: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" };
    case "fallback_sent":
      return { label: "SMS 대체", className: "border-sky-400/30 bg-sky-400/10 text-sky-300" };
    case "sent":
      return { label: "성공 불확실 3005", className: "border-amber-400/30 bg-amber-400/10 text-amber-300" };
    case "failed":
      return { label: "failed", className: "border-rose-400/30 bg-rose-400/10 text-rose-300" };
    default:
      return { label: "queued", className: "border-white/15 bg-white/[0.04] text-slate-300" };
  }
}

export default function AlimtalkConsole({ rows, summary, batchId, datasetLabel }: Props) {
  const logs = useAlimtalkLogs();
  const [phone, setPhone] = useState("010-1234-5678");
  const [scenario, setScenario] = useState<SendScenario>("success");
  const [notice, setNotice] = useState<{ tone: "info" | "warn" | "error" | "success"; text: string } | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const stats = useMemo(() => summarizeAlimtalkLogs(logs), [logs]);
  const criticalAlerts = useMemo(() => collectCriticalAlerts(rows), [rows]);
  const preview = useMemo(() => {
    if (logs.length === 0) return null;
    return logs.find((entry) => entry.id === previewId) ?? logs[logs.length - 1] ?? null;
  }, [logs, previewId]);

  const scenarioMeta = SEND_SCENARIOS.find((item) => item.id === scenario) ?? SEND_SCENARIOS[0]!;

  function recipient() {
    try {
      return normalizeRecipientPhone(phone);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "수신 번호를 확인해 주세요." });
      return null;
    }
  }

  function handleSendAnomalies() {
    const to = recipient();
    if (!to) return;

    if (criticalAlerts.length === 0) {
      setNotice({ tone: "info", text: "발송 대상이 없습니다. 현재 대사 결과에 심각(critical) 이상이 없습니다." });
      return;
    }

    // 한 번에 너무 많이 쌓이면 타임라인이 읽히지 않는다. 데모에서는 최대 8건만 보낸다.
    const batch = criticalAlerts.slice(0, 8);
    const gateway = new SensSimulator({ scenario });
    const result = dispatchAnomalyAlerts({
      logs,
      alerts: batch,
      to,
      config: { tenantId: TENANT_ID, plusFriendId: PLUS_FRIEND_ID, consoleUrl: "/reconciliation" },
      gateway,
      now: Date.now(),
      batchId,
    });

    alimtalkLogStore().write(result.logs);
    setPreviewId(result.logs[result.logs.length - 1]?.id ?? null);
    setNotice({
      tone: result.failed > 0 ? "warn" : result.sent > 0 ? "success" : "info",
      text:
        `대상 ${batch.length}건 · 발송 ${result.sent} · 중복 차단 ${result.skipped} · 실패 ${result.failed}` +
        (result.errors[0] ? ` — ${result.errors[0]}` : "") +
        (criticalAlerts.length > batch.length ? ` (전체 ${criticalAlerts.length}건 중 8건만 시뮬레이션)` : ""),
    });
  }

  function handleSendSummary() {
    const to = recipient();
    if (!to) return;
    if (!summary) {
      setNotice({ tone: "info", text: "대사 결과가 아직 없습니다." });
      return;
    }

    const top = biggestLeakCause(summary);
    const gateway = new SensSimulator({ scenario });
    const result = dispatchBatchSummary({
      logs,
      summary: {
        totalRows: summary.totalRows,
        flaggedRows: summary.flaggedRows,
        totalLeak: summary.totalLeak,
        topCause: top ? `${top.code} ${formatWon(top.amount)}` : null,
      },
      to,
      config: { tenantId: TENANT_ID, plusFriendId: PLUS_FRIEND_ID, consoleUrl: "/reconciliation" },
      gateway,
      now: Date.now(),
      batchId,
      batchLabel: datasetLabel,
    });

    alimtalkLogStore().write(result.logs);
    setPreviewId(result.logs[result.logs.length - 1]?.id ?? null);
    setNotice({
      tone: result.failed > 0 ? "warn" : result.skipped > 0 ? "info" : "success",
      text:
        result.skipped > 0
          ? "이미 같은 배치의 요약 알림을 보냈습니다(dedupe_key 일치) — 다시 보내지 않았습니다."
          : result.failed > 0
            ? `요약 발송 실패 — ${result.errors[0] ?? "알 수 없는 오류"}`
            : "배치 요약 알림을 1통 기록했습니다.",
    });
  }

  function handleRetry(entry: AlimtalkLogEntry) {
    const gateway = new SensSimulator({ scenario: entry.statusCode === "429" ? "success" : scenario });
    const result = retryAlimtalk({ logs, logId: entry.id, gateway, now: Date.now() });
    alimtalkLogStore().write(result.logs);

    if (result.reason) {
      setNotice({ tone: "info", text: result.reason });
      return;
    }
    const updated = result.log;
    setNotice({
      tone: updated?.status === "failed" ? "warn" : "success",
      text:
        updated?.status === "failed"
          ? `재시도 ${updated.attempts}회차 실패 — ${updated.error ?? "오류"}`
          : `재시도 성공 — ${updated?.status} (${updated?.attempts}회차)`,
    });
  }

  const hasLogs = logs.length > 0;

  return (
    <section className="card p-4" id="alimtalk" data-testid="alimtalk-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400/80">Naver Cloud SENS · Alimtalk</p>
          <h2 className="mt-1 text-[13.5px] font-semibold text-white">정산 이상 알림톡 발송 콘솔</h2>
          <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-slate-500">
            백엔드에 구현된 발송 오케스트레이션(중복 차단 → queued 적재 → SENS 호출 → accepted/failed)을 브라우저에서 같은
            순서로 돌려 봅니다. 템플릿은 카카오 검수본 형식({ALIMTALK_TEMPLATES.SS_ANOMALY_CRITICAL.code}, {ALIMTALK_TEMPLATES.SS_BATCH_SUMMARY.code})만 씁니다.
          </p>
        </div>
        <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-[10px] font-medium text-amber-300" data-testid="alimtalk-simulation-badge">
          시뮬레이션 · 실제 발송 없음
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-slate-500">수신 번호 (+82 허용)</span>
          <input
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            inputMode="tel"
            className="w-40 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-[12px] tabular-nums text-slate-200 outline-none focus:border-emerald-400/50"
            aria-label="알림톡 수신 번호"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-slate-500">SENS 응답 시나리오</span>
          <select
            value={scenario}
            onChange={(event) => setScenario(event.target.value as SendScenario)}
            className="w-56 rounded-lg border border-white/[0.08] bg-[#0A0F1C] px-2.5 py-1.5 text-[12px] text-slate-200 outline-none focus:border-emerald-400/50"
            aria-label="SENS 응답 시나리오"
          >
            {SEND_SCENARIOS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={handleSendAnomalies}
          data-testid="alimtalk-send"
          className="rounded-lg bg-emerald-500 px-3 py-2 text-[12px] font-semibold text-ink-950 transition hover:bg-emerald-400"
        >
          이상 알림 발송 (critical {criticalAlerts.length}건)
        </button>
        <button
          type="button"
          onClick={handleSendSummary}
          data-testid="alimtalk-summary-send"
          className="rounded-lg border border-white/[0.1] bg-white/[0.03] px-3 py-2 text-[12px] font-medium text-slate-200 transition hover:border-white/25 hover:text-white"
        >
          배치 요약 발송
        </button>
        <button
          type="button"
          onClick={() => {
            alimtalkLogStore().clear();
            setPreviewId(null);
            setNotice({ tone: "info", text: "발송 이력을 비웠습니다." });
          }}
          disabled={!hasLogs}
          className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 text-[11px] text-slate-500 transition enabled:hover:border-rose-400/40 enabled:hover:text-rose-300 disabled:opacity-40"
        >
          이력 비우기
        </button>
        <span className="text-[10.5px] text-slate-600">{scenarioMeta.hint}</span>
      </div>

      {notice && (
        <div
          role="status"
          className={`mt-3 rounded-lg border px-3 py-2 text-[11.5px] leading-relaxed ${
            notice.tone === "error"
              ? "border-rose-400/25 bg-rose-400/[0.07] text-rose-200"
              : notice.tone === "warn"
                ? "border-amber-400/25 bg-amber-400/[0.07] text-amber-200"
                : notice.tone === "success"
                  ? "border-emerald-400/25 bg-emerald-400/[0.07] text-emerald-200"
                  : "border-white/[0.08] bg-white/[0.03] text-slate-300"
          }`}
        >
          {notice.text}
        </div>
      )}

      <div className="mt-3 grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div>
          <p className="mb-1.5 text-[10.5px] text-slate-500">카카오톡 말풍선 미리보기</p>
          <div className="rounded-2xl bg-[#B2C7D9] p-2.5" data-testid="alimtalk-bubble">
            <div className="flex items-center gap-1.5 px-1 pb-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-[#FEE500] text-[9px] font-bold text-[#3C1E1E]">S</span>
              <span className="text-[10.5px] font-semibold text-[#1F2C3D]">{PLUS_FRIEND_ID}</span>
              <span className="rounded-sm bg-[#8FA6B8] px-1 text-[8.5px] text-white">알림톡</span>
            </div>
            {preview ? (
              <>
                <div className="rounded-xl rounded-tl-sm bg-white px-3 py-2.5">
                  <p className="whitespace-pre-wrap text-[11px] leading-[1.5] text-[#191919]">{preview.content}</p>
                </div>
                <p className="mt-1 px-0.5 text-[9px] text-[#1F2C3D]/70">{timeFormatter.format(preview.createdAt)}</p>
              </>
            ) : (
              <div className="rounded-xl rounded-tl-sm bg-white px-3 py-6 text-center">
                <p className="text-[10.5px] leading-relaxed text-slate-500">
                  발송 버튼을 누르면 템플릿 변수로 채운 실제 본문이 여기에 나타납니다.
                </p>
              </div>
            )}
          </div>
          <div className="mt-2 rounded-lg border border-white/[0.05] bg-white/[0.015] px-2.5 py-2 text-[10px] leading-relaxed text-slate-500">
            본문은 카카오에 검수된 템플릿과 같은 형식이며, 변수에는 개행을 넣지 않습니다. 상한은 1,000자입니다.
            서명(x-ncp-apigw-signature-v2)은 서버에서 HMAC-SHA256으로 만들고, 이 화면은 그 값을 흉내 내지 않습니다.
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10.5px] text-slate-500">발송 이력 타임라인</p>
            <p className="text-[10px] tabular-nums text-slate-600">
              총 {stats.total}건 · 성공 {stats.accepted} · 실패 {stats.failed} · 불확실 {stats.uncertain} · 성공률 {stats.successRate}%
            </p>
          </div>

          <div className="max-h-[380px] space-y-1.5 overflow-y-auto pr-1 thin-scrollbar" data-testid="alimtalk-timeline">
            {!hasLogs ? (
              <div className="rounded-lg border border-dashed border-white/[0.08] px-3 py-8 text-center text-[11px] text-slate-500">
                발송 이력이 없습니다. 이상 알림이나 배치 요약을 한 번 보내 보세요.
              </div>
            ) : (
              [...logs].reverse().map((entry) => {
                const chip = statusChip(entry.status);
                const template = ALIMTALK_TEMPLATES[entry.templateCode];
                return (
                  <div
                    key={entry.id}
                    className={`rounded-lg border px-2.5 py-2 transition ${
                      preview?.id === entry.id ? "border-emerald-400/30 bg-emerald-400/[0.04]" : "border-white/[0.05] bg-white/[0.015]"
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setPreviewId(entry.id)}
                        className="text-[10px] tabular-nums text-slate-400 transition hover:text-slate-200"
                      >
                        {timeFormatter.format(entry.createdAt)}
                      </button>
                      <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${chip.className}`} data-testid="alimtalk-status">
                        {chip.label}
                      </span>
                      <span className="text-[9.5px] text-slate-500">{template?.label ?? entry.templateCode}</span>
                      <span className="text-[9px] text-slate-600">
                        {entry.recipientMasked} · 시도 {entry.attempts}/{MAX_SEND_ATTEMPTS}
                      </span>
                      {entry.orderNo && <span className="font-mono text-[9px] text-slate-600">{entry.orderNo}</span>}
                      {entry.status === "failed" && (
                        <button
                          type="button"
                          onClick={() => handleRetry(entry)}
                          className="ml-auto rounded border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[9px] text-amber-200 transition hover:bg-amber-400/20"
                        >
                          재시도
                        </button>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-1 text-[10.5px] text-slate-500">{entry.content.split("\n")[0]}</p>
                    {entry.error && <p className="mt-0.5 text-[10px] text-rose-300/90">{entry.error}</p>}
                  </div>
                );
              })
            )}
          </div>

          <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
            상태 전이는 DB 스키마와 같습니다: queued → accepted(202) → delivered(0000) / failed. 3005(수신 결과 불확실)는 성공으로
            세지 않고 sent로 남깁니다. 재시도는 {MAX_SEND_ATTEMPTS}회까지이며, 템플릿·서명 오류는 재시도해도 성공하지 않습니다.
            이력은 브라우저에만 저장되고 서버로 전송되지 않습니다.
          </p>
        </div>
      </div>
    </section>
  );
}
