"use client";

import { useMemo, useState } from "react";
import {
  ALERT_RULE_LIST,
  composeRuleAlertPreview,
  type AlertEvaluation,
  type AlertHit,
  type AlertRuleConfig,
  type AlertRuleId,
} from "@/lib/alertRules";
import type { ReconciledRow } from "@/lib/reconciliationEngine";
import { formatWon } from "@/lib/format";

/**
 * 정산 이상징후 경보 룰 빌더 (화면)
 *
 * 룰을 켜고 끄면 콘솔이 같은 정산 데이터를 다시 평가하고, 그 결과가 표(table)의 행 하이라이트와
 * 이 패널의 건수에 동시에 반영된다. 여기서 계산하지 않고 `evaluateAlertRules`의 결과만 그린다.
 *
 * 알림톡 미리보기는 **실제 발송에 쓰는 것과 같은 합성 함수**(`composeAnomalyContent`)를 태운다.
 * 미리보기용 문구를 따로 만들면 검수 템플릿과 화면이 어긋나기 때문이다.
 */

const CHANNEL_LABEL: Record<string, string> = {
  smartstore: "스마트스토어",
  coupang: "쿠팡",
  elevenst: "11번가",
  gmarket: "G마켓",
};

const TONE: Record<string, string> = {
  critical: "border-rose-400/25 bg-rose-400/[0.05]",
  warning: "border-amber-400/25 bg-amber-400/[0.05]",
};

export interface AlertRuleBuilderPanelProps {
  rules: AlertRuleConfig[];
  onRulesChange: (next: AlertRuleConfig[]) => void;
  evaluation: AlertEvaluation;
  rows: readonly ReconciledRow[];
  tenantName: string;
  onSelect: (row: ReconciledRow) => void;
  /** 업로드·API 수집처럼 정산 입금일이 없는 데이터에 대한 안내 */
  dataNote?: string;
}

function RuleCard({
  id,
  config,
  result,
  onChange,
}: {
  id: AlertRuleId;
  config: AlertRuleConfig;
  result: AlertEvaluation["results"][number];
  onChange: (next: AlertRuleConfig) => void;
}) {
  const meta = ALERT_RULE_LIST.find((rule) => rule.id === id)!;
  return (
    <div
      className={`rounded-xl border px-3.5 py-3 transition ${
        config.enabled ? TONE[meta.severity] : "border-white/[0.05] bg-white/[0.012]"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold text-slate-100">{meta.label}</p>
          <p className="mt-0.5 text-[10.5px] leading-snug text-slate-500">{meta.description}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={config.enabled}
          aria-label={`${meta.label} 룰 ${config.enabled ? "끄기" : "켜기"}`}
          data-testid={`alert-rule-toggle-${id}`}
          onClick={() => onChange({ ...config, enabled: !config.enabled })}
          className={`relative h-5 w-9 shrink-0 rounded-full border transition ${
            config.enabled
              ? "border-emerald-400/40 bg-emerald-400/30"
              : "border-white/[0.12] bg-white/[0.06]"
          }`}
        >
          <span
            className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all ${
              config.enabled ? "left-[18px]" : "left-0.5"
            }`}
          />
        </button>
      </div>

      <div className="mt-2.5 flex items-end justify-between gap-3">
        <label className="flex items-center gap-1.5 text-[10.5px] text-slate-400">
          임계값
          <input
            type="number"
            inputMode="decimal"
            min={meta.min}
            max={meta.max}
            step={meta.step}
            value={config.threshold}
            aria-label={`${meta.label} 임계값`}
            data-testid={`alert-rule-threshold-${id}`}
            onChange={(event) => onChange({ ...config, threshold: Number(event.target.value) })}
            className="w-16 rounded-md border border-white/[0.1] bg-white/[0.04] px-1.5 py-0.5 text-right text-[11px] tabular-nums text-white outline-none focus:border-emerald-400/50"
          />
          {meta.unit}
        </label>

        <div className="text-right">
          <p
            className={`text-[13px] font-semibold tabular-nums ${
              config.enabled && result.rowsAffected > 0 ? "text-amber-200" : "text-slate-400"
            }`}
            data-testid={`alert-hits-${id}`}
          >
            {config.enabled ? `${result.rowsAffected.toLocaleString("ko-KR")}건` : "꺼짐"}
          </p>
          <p className="text-[10px] tabular-nums text-slate-500">
            {config.enabled
              ? result.amountAtRisk > 0
                ? `노출 ${formatWon(result.amountAtRisk)}`
                : `평가 ${result.evaluatedRows.toLocaleString("ko-KR")}건`
              : "다시 켜면 즉시 재평가"}
          </p>
        </div>
      </div>

      {result.skippedReason ? (
        <p className="mt-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1 text-[10px] leading-snug text-slate-500">
          {result.skippedReason}
        </p>
      ) : null}
    </div>
  );
}

export default function AlertRuleBuilderPanel({
  rules,
  onRulesChange,
  evaluation,
  rows,
  tenantName,
  onSelect,
  dataNote,
}: AlertRuleBuilderPanelProps) {
  const [selectedOrder, setSelectedOrder] = useState<string | null>(null);

  const rowByOrder = useMemo(() => {
    const map = new Map<string, ReconciledRow>();
    for (const item of rows) map.set(item.row.orderNo, item);
    return map;
  }, [rows]);

  const topHits = evaluation.hits.slice(0, 6);
  const previewHit: AlertHit | null =
    topHits.find((hit) => hit.orderNo === selectedOrder) ?? topHits[0] ?? null;
  const preview = previewHit ? composeRuleAlertPreview(previewHit, tenantName) : null;

  const updateRule = (next: AlertRuleConfig): void => {
    onRulesChange(rules.map((rule) => (rule.id === next.id ? next : rule)));
  };

  const pickHit = (hit: AlertHit): void => {
    setSelectedOrder(hit.orderNo);
    const target = rowByOrder.get(hit.orderNo);
    if (target) onSelect(target);
  };

  return (
    <section
      className="card p-4"
      aria-label="정산 이상징후 경보 룰 빌더"
      data-testid="alert-rule-builder"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400/80">
            Alert rules
          </p>
          <h2 className="mt-1 text-[15px] font-semibold tracking-tight text-white">
            내 기준으로 거른 뒤, 위반 행만 바로 확인
          </h2>
          <p className="mt-1 max-w-2xl text-[11.5px] leading-relaxed text-slate-500">
            룰을 켜고 임계값을 바꾸면 같은 정산 데이터를 다시 평가합니다. 위반 행은 아래 표에서 왼쪽
            색선으로 표시되고, 클릭하면 상세 드로어가 열립니다. 알림은 알림톡 콘솔의 검수 템플릿으로
            합성해 미리 봅니다.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-right">
          <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5">
            <p className="text-[9.5px] text-slate-500">활성 룰</p>
            <p className="text-[12.5px] font-semibold tabular-nums text-white">
              {evaluation.enabledCount}/{rules.length}
            </p>
          </div>
          <div className="rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-2.5 py-1.5">
            <p className="text-[9.5px] text-slate-500">위반 행</p>
            <p
              className="text-[12.5px] font-semibold tabular-nums text-amber-200"
              data-testid="alert-total-hits"
            >
              {evaluation.hits.length.toLocaleString("ko-KR")}
            </p>
          </div>
          <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5">
            <p className="text-[9.5px] text-slate-500">노출 금액</p>
            <p className="text-[12.5px] font-semibold tabular-nums text-white">
              {formatWon(evaluation.totalAmountAtRisk)}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-3.5 grid gap-2 md:grid-cols-3">
        {ALERT_RULE_LIST.map((meta) => {
          const config = rules.find((rule) => rule.id === meta.id) ?? {
            id: meta.id,
            enabled: false,
            threshold: meta.defaultThreshold,
          };
          const result = evaluation.results.find((item) => item.id === meta.id) ?? {
            id: meta.id,
            label: meta.label,
            enabled: false,
            threshold: config.threshold,
            unit: meta.unit,
            hits: [],
            rowsAffected: 0,
            amountAtRisk: 0,
            evaluatedRows: 0,
          };
          return (
            <RuleCard
              key={meta.id}
              id={meta.id}
              config={config}
              result={result}
              onChange={updateRule}
            />
          );
        })}
      </div>

      <div className="mt-3.5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
        <div className="rounded-xl border border-white/[0.06]">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-2">
            <p className="text-[11.5px] font-semibold text-slate-200">위반 상위 건</p>
            <p className="text-[10px] text-slate-500">노출 금액 순 · 클릭하면 표에서 선택</p>
          </div>
          {topHits.length === 0 ? (
            <p className="px-3 py-6 text-center text-[11.5px] text-slate-500">
              현재 켜 둔 룰에서 위반이 없습니다. 임계값을 낮추거나 룰을 켜면 바로 다시 계산됩니다.
            </p>
          ) : (
            <ul className="divide-y divide-white/[0.04]">
              {topHits.map((hit) => {
                const active = previewHit?.orderNo === hit.orderNo;
                return (
                  <li key={`${hit.ruleId}-${hit.orderNo}`}>
                    <button
                      type="button"
                      onClick={() => pickHit(hit)}
                      data-testid="alert-hit-row"
                      className={`flex w-full items-start justify-between gap-3 px-3 py-2 text-left transition ${
                        active ? "bg-emerald-400/[0.07]" : "hover:bg-white/[0.03]"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span
                            className={`rounded border px-1 py-0.5 text-[9.5px] font-medium ${
                              hit.severity === "critical"
                                ? "border-rose-400/30 bg-rose-400/10 text-rose-300"
                                : "border-amber-400/30 bg-amber-400/10 text-amber-300"
                            }`}
                          >
                            {hit.ruleLabel}
                          </span>
                          <span className="font-mono text-[10px] text-slate-400">{hit.orderNo}</span>
                          <span className="text-[10px] text-slate-600">
                            {CHANNEL_LABEL[hit.channel] ?? hit.channel}
                          </span>
                        </span>
                        <span className="mt-0.5 block truncate text-[10.5px] text-slate-500">
                          {hit.detail}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block text-[11px] font-semibold tabular-nums text-slate-200">
                          {hit.metric}
                          {hit.unit}
                        </span>
                        <span className="block text-[9.5px] tabular-nums text-slate-500">
                          {hit.amountAtRisk > 0 ? formatWon(hit.amountAtRisk) : "금액 영향 없음"}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-white/[0.015] p-3">
          <div className="flex items-center justify-between">
            <p className="text-[11.5px] font-semibold text-slate-200">SENS 알림톡 미리보기</p>
            <span className="rounded border border-white/[0.08] px-1.5 py-0.5 text-[9px] text-slate-500">
              SS_ANOMALY_CRITICAL
            </span>
          </div>
          {preview ? (
            <>
              <div className="mt-2 rounded-xl rounded-tl-sm border border-white/[0.08] bg-[#1b1d21] px-3 py-2.5">
                <p className="whitespace-pre-line text-[11px] leading-relaxed text-slate-200" data-testid="alert-preview">
                  {preview}
                </p>
              </div>
              <p className="mt-2 text-[10px] leading-snug text-slate-500">
                실제 발송은 아래 알림톡 콘솔에서 합니다. 룰마다 새 템플릿을 만들면 검수를 다시 받아야
                하므로, 검수된 템플릿의 변수에 룰 이름과 근거를 넣는 방식입니다.
              </p>
            </>
          ) : (
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              위반 건이 생기면 이 자리에 알림톡 본문이 나타납니다.
            </p>
          )}
        </div>
      </div>

      <p className="mt-3 text-[10px] leading-relaxed text-slate-600">
        {dataNote ??
          "정산 입금일은 데모 원장에서 마켓 정산 주기(D+n 영업일)로 시뮬레이션한 값입니다. 쿠폰 부담률은 선착순 드롭 콘솔에서 사용된 쿠폰 원장과 주문번호로 맞춘 값만 계산합니다."}
      </p>
    </section>
  );
}
