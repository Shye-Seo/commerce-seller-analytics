"use client";

import { useMemo, useState } from "react";
import { can, type RoleId } from "@/lib/multiTenantRbac";
import { formatWon } from "@/lib/format";
import type { ReconciledRow } from "@/lib/reconciliationEngine";
import {
  buildClaimReport,
  buildPrintHtml,
  claimCsvFileName,
  claimPrintFileName,
  describeClaimReport,
  NON_CLAIMABLE_REASONS,
  toPlatformClaimCsv,
  type ClaimPlatform,
  CLAIM_PLATFORM_META,
} from "@/lib/reconciliationReport";

/**
 * 정산 불일치 소명 리포트 패널
 *
 * 대사 결과를 "고객센터에 실제로 접수할 수 있는 문서"로 바꾸는 마지막 단계다.
 * 화면에서 조절하는 것은 딱 세 가지다.
 *
 *   - 접수 창구(스마트스토어 / 쿠팡 / 11번가·G마켓): 마켓마다 요구하는 열이 다르다.
 *   - 최소 금액: 1,000원 미만은 문의 1건의 행정 비용이 더 크다.
 *   - 최대 건수: 담당자가 읽는 분량(기본 50건). 나머지는 2차 접수로 남긴다.
 *
 * 반출은 `export.csv` 권한을 통과해야 하고, 실제로 내려받은 사실은 콘솔의 해시체인 감사
 * 로그에 남긴다(`onAudit`). 화면이 권한을 판단하되, 감사 기록은 콘솔이 소유한다.
 */

const MIN_AMOUNT_OPTIONS = [0, 1_000, 5_000, 10_000];
const MAX_LINE_OPTIONS = [20, 50, 100, 200];

interface Props {
  rows: ReconciledRow[];
  role: RoleId;
  tenantName: string;
  businessNo?: string;
  period?: string;
  sourceFileName?: string;
  disabled?: boolean;
  /** 반출 성공/거부를 감사 로그에 남긴다 */
  onAudit: (target: string, detail: string, outcome: "allowed" | "denied") => void;
  onNotice: (notice: { tone: "info" | "warn" | "error" | "success"; text: string }) => void;
}

function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export default function ReconciliationClaimPanel({
  rows,
  role,
  tenantName,
  businessNo,
  period,
  sourceFileName,
  disabled = false,
  onAudit,
  onNotice,
}: Props) {
  const [platform, setPlatform] = useState<ClaimPlatform>("smartstore");
  const [minAmount, setMinAmount] = useState(1_000);
  const [maxLines, setMaxLines] = useState(50);

  // 리포트는 rows/필터가 바뀔 때만 다시 만든다. 그래야 작성 시각과 파일명이 렌더마다 흔들리지 않는다.
  const report = useMemo(() => buildClaimReport(rows, { minAmount, maxLines }), [rows, minAmount, maxLines]);

  const allowed = can(role, "export.csv");
  const platformLines = report.lines.filter((line) => line.platform === platform);
  const platformAmount = platformLines.reduce((sum, line) => sum + line.claimAmount, 0);
  const context = { tenantName, businessNo, period, sourceFileName };

  const guard = (label: string): boolean => {
    if (!allowed) {
      const text = "현재 역할에는 반출 권한이 없습니다. 대표 또는 정산 담당자로 전환해 주세요.";
      onAudit(label, "권한 없음", "denied");
      onNotice({ tone: "warn", text });
      return false;
    }
    if (platformLines.length === 0) {
      onNotice({ tone: "info", text: `${CLAIM_PLATFORM_META[platform].label} 접수 대상 건이 없습니다. 금액 하한을 낮춰 보세요.` });
      return false;
    }
    return true;
  };

  const handleCsv = (): void => {
    if (!guard("소명 CSV")) return;
    const csv = toPlatformClaimCsv(platform, report, context);
    if (!csv) return;
    const filename = claimCsvFileName(platform, report);
    downloadText(filename, csv, "text/csv;charset=utf-8");
    onAudit(filename, `${CLAIM_PLATFORM_META[platform].label} ${platformLines.length}건 · ${formatWon(platformAmount)}`, "allowed");
    onNotice({ tone: "success", text: `${CLAIM_PLATFORM_META[platform].label} 소명 CSV ${platformLines.length}건을 내려받았습니다.` });
  };

  const handlePrint = (): void => {
    if (!guard("소명 요청서")) return;
    const html = buildPrintHtml(report, context);
    const filename = claimPrintFileName(report);
    let printed = false;
    try {
      const opened = window.open("", "_blank", "noopener,width=920,height=1200");
      if (opened) {
        opened.document.open();
        opened.document.write(html);
        opened.document.close();
        // 폰트/레이아웃이 준비된 뒤 인쇄 대화상자를 연다. 사용자는 여기서 "PDF로 저장"을 고른다.
        window.setTimeout(() => {
          opened.focus();
          opened.print();
        }, 350);
        printed = true;
      }
    } catch {
      printed = false;
    }

    if (!printed) {
      // 팝업이 차단된 경우에도 결과물은 가져갈 수 있어야 한다.
      downloadText(filename, html, "text/html;charset=utf-8");
      onNotice({ tone: "info", text: "팝업이 차단되어 인쇄용 HTML로 저장했습니다. 브라우저에서 열어 인쇄 → PDF 저장을 선택하세요." });
    } else {
      onNotice({ tone: "info", text: "인쇄 창에서 '대상: PDF로 저장'을 선택하면 첨부용 PDF가 됩니다." });
    }
    onAudit(filename, `소명 요청서 ${report.lines.length}건 · ${formatWon(report.totalAmount)}`, "allowed");
  };

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400/80">Claim report</p>
          <p className="mt-1 text-[12.5px] text-slate-200">정산 불일치 소명 리포트</p>
          <p className="mt-0.5 text-[10.5px] leading-relaxed text-slate-500">
            계약 위반으로 청구할 수 있는 건만 골라 마켓 고객센터 규격 CSV와 인쇄용 요청서(PDF)로 만듭니다.
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-slate-500">청구 가능</p>
          <p className="text-[18px] font-semibold tabular-nums text-emerald-300">{formatWon(report.totalAmount)}</p>
          <p className="text-[10px] tabular-nums text-slate-500">{report.lines.length.toLocaleString("ko-KR")}건</p>
        </div>
      </div>

      <p className="mt-2 rounded-lg border border-white/[0.05] bg-white/[0.015] px-2.5 py-1.5 text-[10.5px] tabular-nums text-slate-400">
        {describeClaimReport(report)}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {(Object.keys(CLAIM_PLATFORM_META) as ClaimPlatform[]).map((key) => {
          const meta = CLAIM_PLATFORM_META[key];
          const count = report.lines.filter((line) => line.platform === key).length;
          const active = platform === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setPlatform(key)}
              aria-pressed={active}
              className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition ${
                active
                  ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
                  : "border-white/[0.08] bg-white/[0.03] text-slate-400 hover:border-white/20 hover:text-slate-200"
              }`}
            >
              {meta.label}
              <span className="ml-1 tabular-nums text-[10px] opacity-70">{count}</span>
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-[10px] text-slate-600">{CLAIM_PLATFORM_META[platform].desk}</p>

      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
        <label className="block">
          <span className="text-[10px] text-slate-500">최소 청구 금액</span>
          <select
            value={minAmount}
            onChange={(event) => setMinAmount(Number(event.target.value))}
            className="mt-0.5 w-full rounded-lg border border-white/[0.08] bg-ink-900 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-emerald-400/50"
          >
            {MIN_AMOUNT_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {value === 0 ? "제한 없음" : `${value.toLocaleString("ko-KR")}원 이상`}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] text-slate-500">최대 접수 건수</span>
          <select
            value={maxLines}
            onChange={(event) => setMaxLines(Number(event.target.value))}
            className="mt-0.5 w-full rounded-lg border border-white/[0.08] bg-ink-900 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-emerald-400/50"
          >
            {MAX_LINE_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {value}건 (금액 상위)
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={handleCsv}
          disabled={disabled}
          data-testid="claim-csv"
          className="mt-auto rounded-lg bg-emerald-400 px-3 py-1.5 text-[11px] font-semibold text-ink-950 transition enabled:hover:bg-emerald-300 disabled:opacity-40"
        >
          접수용 CSV
        </button>
        <button
          type="button"
          onClick={handlePrint}
          disabled={disabled}
          data-testid="claim-pdf"
          className="mt-auto rounded-lg border border-white/[0.12] bg-white/[0.04] px-3 py-1.5 text-[11px] font-medium text-slate-200 transition enabled:hover:border-white/25 enabled:hover:text-white disabled:opacity-40"
        >
          인쇄용 PDF
        </button>
      </div>

      {!allowed && (
        <p className="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-2.5 py-1.5 text-[10.5px] text-amber-200">
          현재 역할({role})은 반출 권한이 없습니다. 리포트는 볼 수 있지만 내려받기는 대표·정산 담당자만 가능합니다.
        </p>
      )}

      {platformLines.length > 0 ? (
        <div className="mt-3 overflow-hidden rounded-lg border border-white/[0.05]">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-white/[0.03] text-[9.5px] uppercase tracking-wide text-slate-500">
                <th className="px-2 py-1 font-medium">주문번호</th>
                <th className="px-2 py-1 font-medium">사유</th>
                <th className="px-2 py-1 text-right font-medium">청구액</th>
              </tr>
            </thead>
            <tbody>
              {platformLines.slice(0, 5).map((line) => (
                <tr key={line.id} className="border-t border-white/[0.04] text-[10.5px]">
                  <td className="px-2 py-1 tabular-nums text-slate-300">{line.orderNo}</td>
                  <td className="px-2 py-1 text-slate-500">
                    {line.reasons.map((reason) => reason.label).join(" / ")}
                    {line.reasons.length > 1 && <span className="ml-1 text-[9px] text-slate-600">외 {line.reasons.length - 1}</span>}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-rose-300">{formatWon(line.claimAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-white/[0.04] bg-white/[0.01] px-2 py-1 text-[9.5px] text-slate-600">
            {platformLines.length > 5
              ? `상위 5건 미리보기 · 나머지 ${platformLines.length - 5}건은 파일에 포함됩니다`
              : `${platformLines.length}건 전부 포함됩니다`}
            {report.truncated > 0 ? ` · 전체 후보 중 ${report.truncated}건은 2차 접수 대상` : ""}
          </p>
        </div>
      ) : (
        <p className="mt-3 rounded-lg border border-white/[0.05] bg-white/[0.015] px-2.5 py-2 text-[10.5px] text-slate-500">
          이 창구로 접수할 건이 없습니다. 금액 하한을 낮추면 소액 건까지 확인할 수 있습니다.
        </p>
      )}

      {report.excluded.length > 0 && (
        <details className="mt-2 rounded-lg border border-white/[0.05] bg-white/[0.015] px-2.5 py-1.5">
          <summary className="cursor-pointer text-[10.5px] text-slate-400">
            청구에서 제외한 항목 {report.excluded.length}종 (손해는 있지만 계약 위반이 아닙니다)
          </summary>
          <ul className="mt-1 space-y-0.5">
            {report.excluded.slice(0, 4).map((entry) => (
              <li key={entry.code} className="text-[10px] leading-relaxed text-slate-500">
                <span className="text-slate-400">{entry.label}</span> {entry.count}건 · {formatWon(entry.amount)} —{" "}
                {NON_CLAIMABLE_REASONS[entry.code] ?? "청구 대상이 아닙니다."}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
