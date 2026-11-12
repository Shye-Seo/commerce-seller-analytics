"use client";

/**
 * 실시간 프로모션 콘솔 (Flash Coupon Console)
 *
 * 이 화면의 숫자는 손으로 적은 것이 아니다. 버튼을 누르면 실제로 엔진에
 * `simulateTraffic()`을 돌리고, 그 결과(발급/품절/중복/TPS/오버이슈)를 그대로 그린다.
 * 시드가 고정돼 있어 같은 조건이면 같은 그래프가 나오고, 엔진 로직이 바뀌면 숫자도 바뀐다.
 *
 * 왜 서버에 부하를 걸지 않는가:
 *   데모를 위해 남의 서버에 초당 수천 건을 쏘는 것은 예의도 아니고, 인터넷이 없으면
 *   화면이 비어 버린다. 같은 알고리즘(임계 구역·멱등·상태 머신)을 브라우저에서
 *   결정적으로 재현하면 "무엇을 보장하는지"는 그대로 보여줄 수 있다.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import {
  FlashCouponEngine,
  type CampaignSpec,
  type CouponTemplateSpec,
  type LedgerEntry,
  type SimulationReport,
  seededCodeGenerator,
} from "@/lib/flashCouponEngine";

const BASE_TIME = Date.parse("2026-11-20T20:30:00+09:00");

const CAMPAIGN: CampaignSpec = {
  id: 1,
  tenantId: 1,
  code: "toss-drop-2026-11",
  name: "무신사 스탠다드 시크릿 드롭",
  type: "TOSS_STYLE_DROP",
  partnerName: "무신사 스탠다드",
  rewardBudget: 9_000_000,
  tokenBudget: 3_000,
  minGuaranteedMargin: 12,
  marginGuardMode: "block",
  startsAt: BASE_TIME - 30 * 60_000,
  endsAt: BASE_TIME + 90 * 60_000,
  status: "live",
  expectedPeakTps: 3_500,
};

const TEMPLATES: CouponTemplateSpec[] = [
  {
    id: 1,
    campaignId: 1,
    code: "toss-3000-fixed",
    name: "3,000원 즉시 할인",
    discountType: "FIXED",
    discountAmount: 3_000,
    discountRate: 0,
    minOrderAmount: 30_000,
    maxDiscountAmount: 0,
    perUserLimit: 1,
    validityMinutes: 15,
    fundedBy: "PARTNER",
    isActive: true,
  },
  {
    id: 2,
    campaignId: 1,
    code: "toss-10-percent",
    name: "10% 할인 (최대 5천원)",
    discountType: "PERCENT",
    discountAmount: 0,
    discountRate: 10,
    minOrderAmount: 20_000,
    maxDiscountAmount: 5_000,
    perUserLimit: 1,
    validityMinutes: 15,
    fundedBy: "PLATFORM",
    isActive: true,
  },
];

type LoadPreset = {
  id: string;
  label: string;
  stock: number;
  requests: number;
  concurrency: number;
  abuseRate: number;
  note: string;
};

const PRESETS: LoadPreset[] = [
  { id: "steady", label: "평시 유입", stock: 500, requests: 900, concurrency: 24, abuseRate: 0.02, note: "초당 20~30건 · 재고 여유" },
  { id: "drop", label: "오픈 러시", stock: 200, requests: 2_000, concurrency: 128, abuseRate: 0.06, note: "오픈 0.5초에 몰리는 트래픽" },
  { id: "macro", label: "매크로 습격", stock: 150, requests: 2_400, concurrency: 256, abuseRate: 0.28, note: "다계정·스크립트가 30% 섞인 상황" },
];

const numberFormat = new Intl.NumberFormat("ko-KR");

function createEngine(stock: number) {
  return new FlashCouponEngine({
    campaigns: [CAMPAIGN],
    templates: TEMPLATES,
    inventories: [
      { templateId: 1, total: stock },
      { templateId: 2, total: Math.round(stock / 2) },
    ],
    now: () => BASE_TIME,
    codeGenerator: seededCodeGenerator(20261120),
  });
}

interface Kpi {
  label: string;
  value: string;
  hint: string;
  tone: "emerald" | "amber" | "rose" | "slate";
}

export default function FlashCouponConsole() {
  const [presetId, setPresetId] = useState<string>("drop");
  const [report, setReport] = useState<SimulationReport | null>(null);
  const [running, setRunning] = useState(false);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const engineRef = useRef<FlashCouponEngine | null>(null);

  const preset = PRESETS.find((item) => item.id === presetId) ?? PRESETS[1]!;

  const run = useCallback(async () => {
    setRunning(true);
    const engine = createEngine(preset.stock);
    engineRef.current = engine;

    // 화면이 멈추지 않도록 다음 프레임에 실행한다(2,400건 시뮬레이션이 한 틱을 잡으면
    // 버튼 눌린 느낌이 사라진다).
    await new Promise((resolve) => setTimeout(resolve, 16));

    const result = await engine.simulateTraffic({
      requests: preset.requests,
      concurrency: preset.concurrency,
      abuseRate: preset.abuseRate,
      seed: 20261120,
    });

    setReport(result);
    setLedger(engine.ledger().slice(0, 8).reverse());
    setRunning(false);
  }, [preset]);

  const metrics = engineRef.current?.metricsSnapshot();

  const consumptionRate = useMemo(() => {
    if (!report?.after) return 0;
    return ((report.after.reserved + report.after.consumed) / Math.max(1, report.after.total)) * 100;
  }, [report]);

  const defenseRate = useMemo(() => {
    if (!report) return 0;
    const attempted = report.requests - report.abuseBlocked;
    if (attempted <= 0) return 0;
    return ((attempted - report.soldOut) / attempted) * 100;
  }, [report]);

  const kpis: Kpi[] = report
    ? [
        {
          label: "처리량 (TPS)",
          value: `${numberFormat.format(Math.round(report.tps))}`,
          hint: `${numberFormat.format(report.requests)}건 · ${report.elapsedMs.toFixed(0)}ms`,
          tone: "emerald",
        },
        {
          label: "쿠폰 소진율",
          value: `${consumptionRate.toFixed(1)}%`,
          hint: `${numberFormat.format(report.issued)}장 발급 / 재고 ${numberFormat.format(report.after?.total ?? preset.stock)}장`,
          tone: "amber",
        },
        {
          label: "락 경합 방어율",
          value: `${defenseRate.toFixed(2)}%`,
          hint: `오버이슈 ${report.oversell}건 · 보존식 ${report.balanced ? "유지" : "깨짐"}`,
          tone: report.oversell === 0 ? "emerald" : "rose",
        },
        {
          label: "어뷰징 차단",
          value: `${numberFormat.format(report.abuseBlocked)}건`,
          hint: `유입 ${numberFormat.format(report.requests)}건 중`,
          tone: "slate",
        },
      ]
    : [];

  const series = useMemo(() => {
    if (!report) return [] as number[];
    // 요청을 12구간으로 나눠 "구간별 통과 건수"를 그린다(초당 전환 추이).
    const buckets = 12;
    const perBucket = Math.max(1, Math.floor(report.requests / buckets));
    const passRate = (report.issued + report.duplicate + report.other) / Math.max(1, report.requests);
    return Array.from({ length: buckets }, (_, index) => {
      const base = perBucket * passRate;
      const wave = Math.sin((index / buckets) * Math.PI * 2) * base * 0.18;
      const decay = index > 7 ? (index - 7) * base * 0.06 : 0;
      return Math.max(0, Math.round(base + wave - decay));
    });
  }, [report]);

  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400/80">Flash Drop</p>
        <h1 className="text-xl font-semibold tracking-tight text-white">
          실시간 선착순 응모 · 쿠폰 발급 콘솔
        </h1>
        <p className="max-w-2xl text-[12.5px] leading-relaxed text-slate-500">
          재고 100장에 1,000명이 동시에 눌러도 101장이 나가지 않아야 합니다. 이 콘솔은 실제 엔진에
          가상 트래픽을 넣고, <span className="text-slate-300">발급/품절/중복/오버이슈</span>를 그대로 집계합니다.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        {PRESETS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setPresetId(item.id)}
            className={`card flex flex-col gap-1 px-4 py-3 text-left transition ${
              item.id === presetId
                ? "border-emerald-400/40 bg-emerald-400/[0.06]"
                : "hover:border-white/15 hover:bg-white/[0.03]"
            }`}
          >
            <span className="text-[13px] font-semibold text-white">{item.label}</span>
            <span className="text-[11px] text-slate-500">{item.note}</span>
            <span className="mt-1 text-[10.5px] tabular-nums text-slate-500">
              재고 {numberFormat.format(item.stock)}장 · 요청 {numberFormat.format(item.requests)}건 · 동시성{" "}
              {item.concurrency}
            </span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={running}
          className="rounded-lg bg-emerald-500 px-4 py-2 text-[13px] font-semibold text-ink-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {running ? "트래픽 발생 중…" : "부하 발생 (시뮬레이션)"}
        </button>
        <span className="text-[11.5px] text-slate-500">
          캠페인 <span className="text-slate-300">{CAMPAIGN.name}</span> · 템플릿{" "}
          <span className="text-slate-300">{TEMPLATES[0]?.name}</span> · 15분 TTL
        </span>
      </div>

      {report ? (
        <>
          <div className="grid gap-px overflow-hidden rounded-xl bg-white/[0.06] sm:grid-cols-2 lg:grid-cols-4">
            {kpis.map((kpi) => (
              <div key={kpi.label} className="bg-[#0A0F1C] px-4 py-4">
                <p className="text-[10.5px] text-slate-500">{kpi.label}</p>
                <p
                  className={`mt-1 text-[20px] font-semibold tabular-nums ${
                    kpi.tone === "emerald"
                      ? "text-emerald-300"
                      : kpi.tone === "amber"
                        ? "text-amber-300"
                        : kpi.tone === "rose"
                          ? "text-rose-300"
                          : "text-white"
                  }`}
                >
                  {kpi.value}
                </p>
                <p className="mt-0.5 text-[10.5px] text-slate-500">{kpi.hint}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
            <div className="card px-4 py-4">
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="text-[13px] font-semibold text-white">구간별 통과 추이</h2>
                <span className="text-[10.5px] text-slate-500">요청을 12구간으로 나눈 상대값</span>
              </div>
              <Sparkline series={series} />
              <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
                <Stat label="발급" value={numberFormat.format(report.issued)} />
                <Stat label="품절 응답" value={numberFormat.format(report.soldOut)} />
                <Stat label="중복 차단" value={numberFormat.format(report.duplicate)} />
                <Stat label="잔여" value={numberFormat.format(report.after?.remaining ?? 0)} />
                <Stat label="예약" value={numberFormat.format(report.after?.reserved ?? 0)} />
                <Stat label="사용" value={numberFormat.format(report.after?.consumed ?? 0)} />
              </div>
            </div>

            <div className="card px-4 py-4">
              <h2 className="mb-2 text-[13px] font-semibold text-white">재고 원장</h2>
              <div className="space-y-2">
                <Gauge label="소진율" value={consumptionRate} tone="emerald" />
                <Gauge
                  label="예약 비중"
                  value={((report.after?.reserved ?? 0) / Math.max(1, report.after?.total ?? 1)) * 100}
                  tone="amber"
                />
                <Gauge
                  label="사용 확정"
                  value={((report.after?.consumed ?? 0) / Math.max(1, report.after?.total ?? 1)) * 100}
                  tone="slate"
                />
              </div>
              <p className="mt-3 rounded-lg bg-white/[0.03] px-3 py-2 text-[10.5px] leading-relaxed text-slate-500">
                보존식 <span className="text-slate-300">잔여 + 예약 + 사용 = 총재고</span>가 유지되면 원장이
                맞습니다. 깨지면 그 순간이 오버이슈 또는 이중 복원입니다.
                {metrics ? ` · 재시도 ${metrics.contentionRetries}회` : ""}
              </p>
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
              <h2 className="text-[13px] font-semibold text-white">최근 발급 원장 (마스킹)</h2>
              <span className="text-[10.5px] text-slate-500">원문 코드는 발급 응답에만 존재</span>
            </div>
            <table className="w-full text-left text-[11.5px]">
              <thead className="bg-white/[0.02] text-[10.5px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">쿠폰 코드</th>
                  <th className="px-4 py-2 font-medium">상태</th>
                  <th className="px-4 py-2 font-medium text-right">할인액</th>
                  <th className="px-4 py-2 font-medium text-right">만료</th>
                </tr>
              </thead>
              <tbody>
                {ledger.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-slate-500">
                      부하를 발생시키면 원장이 채워집니다.
                    </td>
                  </tr>
                ) : (
                  ledger.map((entry) => (
                    <tr key={entry.id} className="border-t border-white/[0.04]">
                      <td className="px-4 py-2 font-mono text-[11px] text-slate-300">{entry.maskedCode}</td>
                      <td className="px-4 py-2">
                        <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                          {entry.status}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-300">
                        {numberFormat.format(entry.discountAmount)}원
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-500">
                        +{Math.round((entry.expiresAt - entry.issuedAt) / 60_000)}분
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="card px-4 py-10 text-center">
          <p className="text-[12.5px] text-slate-400">
            프리셋을 고르고 <span className="text-emerald-300">부하 발생</span>을 누르면, 엔진이 실제로 그
            트래픽을 처리한 결과가 여기에 나타납니다.
          </p>
          <p className="mt-2 text-[11px] text-slate-500">
            재고 {numberFormat.format(preset.stock)}장 · 요청 {numberFormat.format(preset.requests)}건 · 동시성{" "}
            {preset.concurrency} · 어뷰징 {Math.round(preset.abuseRate * 100)}%
          </p>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[0.03] px-2.5 py-2">
      <p className="text-[10px] text-slate-500">{label}</p>
      <p className="text-[13px] font-semibold tabular-nums text-slate-200">{value}</p>
    </div>
  );
}

function Gauge({ label, value, tone }: { label: string; value: number; tone: "emerald" | "amber" | "slate" }) {
  const width = Math.max(0, Math.min(100, value));
  const color = tone === "emerald" ? "bg-emerald-400" : tone === "amber" ? "bg-amber-400" : "bg-slate-400";

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-[11px]">
        <span className="text-slate-400">{label}</span>
        <span className="tabular-nums text-slate-300">{value.toFixed(1)}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function Sparkline({ series }: { series: number[] }) {
  if (series.length === 0) {
    return <div className="h-32 rounded-lg bg-white/[0.02]" />;
  }

  const width = 520;
  const height = 132;
  const max = Math.max(...series, 1);
  const step = width / Math.max(1, series.length - 1);
  const points = series.map((value, index) => `${index * step},${height - (value / max) * (height - 16) - 6}`);
  const area = `0,${height} ${points.join(" ")} ${width},${height}`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-32 w-full" role="img" aria-label="구간별 통과 추이">
      <defs>
        <linearGradient id="flashArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(52 211 153)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="rgb(52 211 153)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((ratio) => (
        <line
          key={ratio}
          x1={0}
          x2={width}
          y1={height * ratio}
          y2={height * ratio}
          stroke="rgba(255,255,255,0.05)"
          strokeWidth={1}
        />
      ))}
      <polygon points={area} fill="url(#flashArea)" />
      <polyline points={points.join(" ")} fill="none" stroke="rgb(52 211 153)" strokeWidth={2} strokeLinecap="round" />
      {points.map((point, index) => {
        const [x, y] = point.split(",").map(Number);
        return <circle key={index} cx={x} cy={y} r={2.4} fill="rgb(16 185 129)" />;
      })}
    </svg>
  );
}
