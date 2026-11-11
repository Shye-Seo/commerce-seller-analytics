/**
 * 정산 불일치 소명 리포트 생성기
 *
 * 문제
 * ----
 * 대사 엔진이 "수수료 1,900원 초과 청구"를 찾아냈다고 해도, 셀러가 마켓에 실제로 돈을
 * 돌려받으려면 **고객센터에 접수할 수 있는 형식**으로 바꿔야 한다. 실무에서 이 단계가
 * 가장 자주 무너진다.
 *
 *   - 스마트스토어 1:1 문의는 정해진 열(주문번호·상품명·청구/계약 수수료·차액)을 요구한다.
 *   - 쿠팡 WING 정산 문의는 업체코드와 정산월, 문의구분을 따로 받는다.
 *   - 마켓은 "왜 이 금액이 틀렸는지"를 계약 근거로 요구한다. "이상해요"는 반려된다.
 *   - 한 파일에 300건을 넣으면 담당자가 읽지 않는다. 금액순으로 정렬하고 상위만 접수한다.
 *
 * 이 모듈이 하는 일
 * -----------------
 *  1. **청구 가능한 불일치만 고른다.** 역마진·반올림 누수·과소 청구는 셀러가 마켓에
 *     청구할 근거가 없다(역마진은 사업 판단 문제, 과소 청구는 오히려 소급 청구 위험).
 *     청구 가능 코드만 남기고, 금액 하한과 건수 상한을 적용한다.
 *  2. **플랫폼별 규격 CSV**를 만든다. 스마트스토어/쿠팡/기타(11번가·G마켓) 3종.
 *     한국어 엑셀에서 바로 열리도록 UTF-8 BOM + CRLF를 쓴다.
 *  3. **인쇄용 HTML**(A4)을 만든다. 브라우저 인쇄 → PDF 저장으로 그대로 첨부할 수 있다.
 *  4. 모든 계산은 순수 함수다. 금액은 이미 대사 엔진이 원 단위 정수로 확정했고,
 *     여기서는 **다시 계산하지 않고 고르고 합산한다**(이중 계산 금지).
 */

import { ANOMALY_META, type AnomalyCode, type MarketChannel, type ReconciledRow } from "./reconciliationEngine";

/* ------------------------------------------------------------------ */
/* 청구 정책                                                           */
/* ------------------------------------------------------------------ */

/**
 * 마켓에 청구(소명 요청)할 수 있는 원인.
 * 여기 없는 코드는 "셀러가 손해를 봤다"는 사실은 맞지만 **계약 위반이 아니므로**
 * 고객센터 접수 대상이 아니다. 리포트에 섞으면 담당자가 전체를 반려한다.
 */
export const CLAIMABLE_CODES: readonly AnomalyCode[] = [
  "FEE_OVERCHARGE",
  "FEE_ON_CANCELED_ORDER",
  "SHIPPING_OVERCHARGE",
  "RETURN_FEE_DOUBLE_CHARGED",
  "RETURN_FEE_ON_SHIPPED_ORDER",
  "SETTLEMENT_SHORTFALL",
];

/** 청구 대상이 아닌 원인과 그 이유 — UI 툴팁과 리포트 각주에 그대로 쓴다. */
export const NON_CLAIMABLE_REASONS: Partial<Record<AnomalyCode, string>> = {
  FEE_UNDERCHARGE: "계약보다 적게 청구된 건입니다. 청구 대상이 아니라 소급 청구 위험 확인 대상입니다.",
  SETTLEMENT_SURPLUS: "초과 입금 건입니다. 다음 정산에서 차감될 수 있어 별도 확인이 필요합니다.",
  ROUNDING_LEAK: "10원 이하 반올림 차이입니다. 건별 청구 실익이 없습니다.",
  NEGATIVE_MARGIN: "원가·배송원가 대비 역마진입니다. 마켓의 계약 위반이 아니라 판매 조건 문제입니다.",
  MISSING_LEDGER: "매입원가가 없어 마진을 검증할 수 없는 데이터 문제입니다.",
};

export interface ClaimSelectionOptions {
  /** 이 금액 미만 불일치는 접수하지 않는다(원). 기본 1,000원 — 문의 1건의 행정 비용이 더 크다. */
  minAmount?: number;
  /** 접수할 최대 건수(금액 내림차순). 기본 50건 — 담당자가 읽는 분량. */
  maxLines?: number;
  /** 청구 사유 필터. 기본은 CLAIMABLE_CODES 전체. */
  codes?: readonly AnomalyCode[];
  /** 특정 채널만. 비우면 전체. */
  channels?: readonly MarketChannel[];
}

export const DEFAULT_CLAIM_OPTIONS: Required<Omit<ClaimSelectionOptions, "channels">> = {
  minAmount: 1_000,
  maxLines: 50,
  codes: CLAIMABLE_CODES,
};

/** 소명 리포트가 향하는 접수 창구 */
export type ClaimPlatform = "smartstore" | "coupang" | "other";

export const CLAIM_PLATFORM_META: Record<ClaimPlatform, { label: string; desk: string; channels: MarketChannel[] }> = {
  smartstore: { label: "스마트스토어", desk: "네이버 스마트스토어 판매자센터 · 1:1 문의(정산)", channels: ["smartstore"] },
  coupang: { label: "쿠팡", desk: "쿠팡 WING · 고객센터 문의(정산/수수료)", channels: ["coupang"] },
  other: { label: "11번가·G마켓", desk: "셀러센터 · 정산 문의(통합 양식)", channels: ["elevenst", "gmarket"] },
};

export function platformOfChannel(channel: MarketChannel): ClaimPlatform {
  if (channel === "smartstore") return "smartstore";
  if (channel === "coupang") return "coupang";
  return "other";
}

/* ------------------------------------------------------------------ */
/* 리포트 모델                                                         */
/* ------------------------------------------------------------------ */

/** 접수 1건 = 주문 1건. 마켓은 주문 단위로 확인하기 때문에 행 단위로 묶는다. */
export interface ClaimLine {
  id: string;
  orderNo: string;
  productName: string;
  orderDate: string;
  channel: MarketChannel;
  platform: ClaimPlatform;
  /** 청구 금액(원) = 선택된 원인의 귀속 손실 합계 */
  claimAmount: number;
  /** 이 주문의 총 정산 부족액(설명 불가분 포함) */
  shortfall: number;
  actualSettlement: number;
  expectedSettlement: number;
  /** 실제 - 기대 */
  variance: number;
  /** 1순위 원인(금액이 가장 큰 원인) */
  primaryCode: AnomalyCode;
  reasons: Array<{ code: AnomalyCode; label: string; amount: number }>;
  /** 마켓 담당자에게 그대로 보낼 수 있는 근거 문장 */
  evidence: string;
  contractFeeRate: number;
  effectiveFeeRate: number;
}

export interface ClaimPlatformSummary {
  platform: ClaimPlatform;
  label: string;
  desk: string;
  lines: number;
  amount: number;
  rows: number;
}

export interface ClaimReport {
  generatedAt: string;
  /** 대사한 전체 주문 수(리포트 신뢰도 표시용) */
  scannedRows: number;
  /** 청구 대상으로 선택된 건수/금액 */
  lines: ClaimLine[];
  totalAmount: number;
  /** 후보 중 금액 하한 미만이라 제외된 건수 */
  belowThreshold: number;
  /** maxLines 초과로 잘라낸 건수(금액 내림차순 꼬리) */
  truncated: number;
  /** 선택되지 않은(청구 불가) 원인별 금액 — 참고용 */
  excluded: Array<{ code: AnomalyCode; label: string; count: number; amount: number }>;
  byReason: Array<{ code: AnomalyCode; label: string; lines: number; amount: number }>;
  byPlatform: ClaimPlatformSummary[];
  options: { minAmount: number; maxLines: number; codes: AnomalyCode[] };
}

/* ------------------------------------------------------------------ */
/* 선택                                                                */
/* ------------------------------------------------------------------ */

function claimReasons(row: ReconciledRow, codes: readonly AnomalyCode[]): Array<{ code: AnomalyCode; label: string; amount: number }> {
  return row.anomalies
    .filter((anomaly) => anomaly.loss > 0 && codes.includes(anomaly.code))
    .map((anomaly) => ({ code: anomaly.code, label: ANOMALY_META[anomaly.code].label, amount: anomaly.loss }))
    .sort((a, b) => b.amount - a.amount);
}

/**
 * 대사 결과에서 "지금 마켓에 접수할 목록"을 고른다.
 *
 * 정렬 기준은 `청구 금액 내림차순`이다. 담당자는 위에서부터 읽고, 셀러는 상위 N건만
 * 접수해도 손실의 대부분을 회수한다(파레토). 동률이면 주문일이 빠른 쪽을 앞세운다.
 */
export function buildClaimReport(
  rows: readonly ReconciledRow[],
  options: ClaimSelectionOptions & { generatedAt?: string } = {},
): ClaimReport {
  const codes = options.codes && options.codes.length > 0 ? options.codes : CLAIMABLE_CODES;
  const minAmount = Math.max(0, options.minAmount ?? DEFAULT_CLAIM_OPTIONS.minAmount);
  const maxLines = Math.max(1, options.maxLines ?? DEFAULT_CLAIM_OPTIONS.maxLines);

  const candidates: ClaimLine[] = [];
  let belowThreshold = 0;

  // 청구 불가 원인의 금액은 따로 집계한다. 리포트 각주에 "이건 왜 안 넣었는지"를 쓴다.
  const excludedMap = new Map<AnomalyCode, { count: number; amount: number }>();
  const allCodes = new Set<AnomalyCode>();

  for (const row of rows) {
    for (const anomaly of row.anomalies) allCodes.add(anomaly.code);
    if (options.channels && !options.channels.includes(row.row.channel)) continue;

    const reasons = claimReasons(row, codes);
    if (reasons.length === 0) continue;

    const amount = reasons.reduce((sum, reason) => sum + reason.amount, 0);
    if (amount < minAmount) {
      belowThreshold += 1;
      continue;
    }

    const primary = reasons[0] as { code: AnomalyCode; label: string; amount: number };
    candidates.push({
      id: row.id,
      orderNo: row.row.orderNo,
      productName: row.row.productName,
      orderDate: row.row.orderDate,
      channel: row.row.channel,
      platform: platformOfChannel(row.row.channel),
      claimAmount: amount,
      shortfall: row.shortfall,
      actualSettlement: row.actualSettlement,
      expectedSettlement: row.expectedSettlement,
      variance: row.variance,
      primaryCode: primary.code,
      reasons,
      evidence: buildEvidence(row, reasons),
      contractFeeRate: row.contract.feeRate,
      effectiveFeeRate: row.effectiveFeeRate,
    });
  }

  for (const code of allCodes) {
    if (codes.includes(code)) continue;
    let count = 0;
    let amount = 0;
    for (const row of rows) {
      for (const anomaly of row.anomalies) {
        if (anomaly.code !== code) continue;
        count += 1;
        amount += anomaly.loss;
      }
    }
    excludedMap.set(code, { count, amount });
  }

  candidates.sort((a, b) => b.claimAmount - a.claimAmount || a.orderDate.localeCompare(b.orderDate));

  const selected = candidates.slice(0, maxLines);
  const truncated = candidates.length - selected.length;

  const byReasonMap = new Map<AnomalyCode, { lines: number; amount: number }>();
  for (const line of selected) {
    for (const reason of line.reasons) {
      const entry = byReasonMap.get(reason.code) ?? { lines: 0, amount: 0 };
      entry.lines += 1;
      entry.amount += reason.amount;
      byReasonMap.set(reason.code, entry);
    }
  }

  const byPlatform = (Object.keys(CLAIM_PLATFORM_META) as ClaimPlatform[]).map((platform) => {
    const meta = CLAIM_PLATFORM_META[platform];
    const platformLines = selected.filter((line) => line.platform === platform);
    return {
      platform,
      label: meta.label,
      desk: meta.desk,
      lines: platformLines.length,
      amount: platformLines.reduce((sum, line) => sum + line.claimAmount, 0),
      rows: platformLines.length,
    };
  });

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    scannedRows: rows.length,
    lines: selected,
    totalAmount: selected.reduce((sum, line) => sum + line.claimAmount, 0),
    belowThreshold,
    truncated,
    excluded: [...excludedMap.entries()]
      .map(([code, value]) => ({ code, label: ANOMALY_META[code].label, ...value }))
      .filter((entry) => entry.count > 0)
      .sort((a, b) => b.amount - a.amount),
    byReason: [...byReasonMap.entries()]
      .map(([code, value]) => ({ code, label: ANOMALY_META[code].label, ...value }))
      .sort((a, b) => b.amount - a.amount),
    byPlatform,
    options: { minAmount, maxLines, codes: [...codes] },
  };
}

/** 담당자가 근거를 바로 확인할 수 있는 한 문장. 원인별 상세 문장을 이어 붙인다. */
function buildEvidence(row: ReconciledRow, reasons: Array<{ code: AnomalyCode; amount: number }>): string {
  const details = reasons
    .map((reason) => {
      const anomaly = row.anomalies.find((entry) => entry.code === reason.code);
      return anomaly ? `${anomaly.label}(${formatWonPlain(reason.amount)}): ${anomaly.detail}` : `${ANOMALY_META[reason.code].label} ${formatWonPlain(reason.amount)}`;
    })
    .join(" / ");
  const unattributed = row.shortfall - reasons.reduce((sum, reason) => sum + reason.amount, 0);
  const tail =
    unattributed > 0
      ? ` 그 외 원인 미상 차액 ${formatWonPlain(unattributed)}.`
      : "";
  return `${details}. 계약 수수료율 ${row.contract.feeRate}% 기준 기대 정산액 ${formatWonPlain(row.expectedSettlement)}원, 실제 입금 ${formatWonPlain(row.actualSettlement)}원.${tail}`;
}

/** 12,345원 (리포트 문장용 — 원 기호 없이) */
function formatWonPlain(value: number): string {
  return Math.round(value).toLocaleString("ko-KR");
}

/* ------------------------------------------------------------------ */
/* 플랫폼별 CSV                                                        */
/* ------------------------------------------------------------------ */

/** 엑셀이 한국어 CSV를 바로 열도록 붙이는 BOM. 없으면 한글이 깨져 보인다. */
export const UTF8_BOM = "\uFEFF";

/** 엑셀/윈도우 줄바꿈. `\n`만 쓰면 일부 엑셀에서 한 줄로 붙는다. */
const CRLF = "\r\n";

/**
 * CSV 셀 인용 + 수식 인젝션 방지.
 *
 * 셀 값이 `=`, `+`, `-`, `@`로 시작하면 엑셀이 수식으로 해석한다. 상품명이
 * `=HYPERLINK(...)`인 악성 정산서를 그대로 내보내면 담당자 PC에서 실행될 수 있으므로
 * 텍스트 셀은 앞에 작은따옴표를 붙여 문자열로 고정한다.
 * 금액 열은 숫자여야 하므로 인젝션 처리하지 않고(라벨/텍스트 열에만 적용),
 * 음수 부호가 있는 금액은 그대로 숫자로 내보낸다.
 */
export function csvCell(value: string | number | null | undefined, kind: "text" | "number" = "text"): string {
  if (value === null || value === undefined) return "";
  if (kind === "number") {
    const numeric = typeof value === "number" ? value : Number(String(value).replace(/[^\d.-]/g, ""));
    return Number.isFinite(numeric) ? String(Math.round(numeric)) : "0";
  }
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvRows(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): string {
  const lines = [header.map((cell) => csvCell(cell)).join(",")];
  for (const row of rows) {
    lines.push(row.map((cell) => csvCell(cell)).join(","));
  }
  return `${UTF8_BOM}${lines.join(CRLF)}${CRLF}`;
}

function reasonText(line: ClaimLine): string {
  return line.reasons.map((reason) => reason.label).join(" / ");
}

/**
 * 스마트스토어 판매자센터 1:1 문의(정산) 양식.
 * 판매자센터가 요구하는 항목(문의유형·스토어명·사업자번호·주문번호·상품명·주문일)을 앞에 두고,
 * 담당자가 검산할 수 있도록 청구/계약/차액을 뒤에 붙인다.
 */
function smartstoreCsv(report: ClaimReport, context: ReportContext): string {
  const header = [
    "문의유형",
    "스토어명",
    "사업자번호",
    "주문번호",
    "상품명",
    "주문일",
    "기대정산액",
    "실제입금액",
    "차액(환불요청)",
    "문의내용",
  ];
  const rows = report.lines
    .filter((line) => line.platform === "smartstore")
    .map((line) => [
      "정산/수수료",
      context.tenantName ?? "셀러",
      context.businessNo ?? "",
      line.orderNo,
      line.productName,
      line.orderDate,
      line.expectedSettlement,
      line.actualSettlement,
      line.claimAmount,
      `${line.orderDate} 주문(${line.productName})의 정산에서 ${reasonText(line)}이 확인되어 ${line.claimAmount.toLocaleString("ko-KR")}원 환불을 요청합니다. 계약 수수료율 ${line.contractFeeRate}% 기준 기대 정산액은 ${line.expectedSettlement.toLocaleString("ko-KR")}원, 실제 입금액은 ${line.actualSettlement.toLocaleString("ko-KR")}원입니다.`,
    ]);
  return csvRows(header, rows);
}

/** 쿠팡 WING 고객센터 문의(정산/수수료) 양식 — 업체코드와 정산월을 별도로 받는다. */
function coupangCsv(report: ClaimReport, context: ReportContext): string {
  const header = ["문의구분", "업체명", "업체코드", "정산월", "주문번호", "상품명", "청구금액", "정상금액", "차액", "문의내용"];
  const rows = report.lines
    .filter((line) => line.platform === "coupang")
    .map((line) => [
      "정산-수수료",
      context.tenantName ?? "셀러",
      context.businessNo ?? "",
      line.orderDate.slice(0, 7),
      line.orderNo,
      line.productName,
      line.actualSettlement,
      line.expectedSettlement,
      line.claimAmount,
      `${line.orderNo} 건 정산 내역에서 ${reasonText(line)}이 확인되었습니다. 계약 기준 기대 정산액 ${line.expectedSettlement.toLocaleString("ko-KR")}원 대비 ${line.actualSettlement.toLocaleString("ko-KR")}원이 입금되어 ${line.claimAmount.toLocaleString("ko-KR")}원 정정을 요청합니다.`,
    ]);
  return csvRows(header, rows);
}

/** 11번가·G마켓 등 그 외 채널용 통합 양식(마켓명 열을 포함). */
function otherCsv(report: ClaimReport, context: ReportContext): string {
  const header = ["마켓", "업체명", "주문번호", "주문일", "상품명", "청구금액", "정상금액", "차액", "사유", "근거"];
  const rows = report.lines
    .filter((line) => line.platform === "other")
    .map((line) => [
      CHANNEL_LABEL[line.channel] ?? line.channel,
      context.tenantName ?? "셀러",
      line.orderNo,
      line.orderDate,
      line.productName,
      line.actualSettlement,
      line.expectedSettlement,
      line.claimAmount,
      reasonText(line),
      line.evidence,
    ]);
  return csvRows(header, rows);
}

export const CHANNEL_LABEL: Record<MarketChannel, string> = {
  smartstore: "스마트스토어",
  coupang: "쿠팡",
  elevenst: "11번가",
  gmarket: "G마켓",
};

export interface ReportContext {
  /** 리포트에 찍히는 상호(테넌트명) */
  tenantName?: string;
  /** 사업자등록번호 — 고객센터가 계정을 특정하는 데 쓴다 */
  businessNo?: string;
  /** 기준 기간 표기(ex. "2026-08-01 ~ 2026-10-31") */
  period?: string;
  /** 원본 파일명(증빙 추적용) */
  sourceFileName?: string;
}

/** 선택된 플랫폼의 CSV 본문. 해당 채널 건이 없으면 `null`. */
export function toPlatformClaimCsv(platform: ClaimPlatform, report: ClaimReport, context: ReportContext = {}): string | null {
  const count = report.lines.filter((line) => line.platform === platform).length;
  if (count === 0) return null;
  if (platform === "smartstore") return smartstoreCsv(report, context);
  if (platform === "coupang") return coupangCsv(report, context);
  return otherCsv(report, context);
}

/** 다운로드 파일명: 소명요청_쿠팡_2026-11-11_12건.csv */
export function claimCsvFileName(platform: ClaimPlatform, report: ClaimReport): string {
  const meta = CLAIM_PLATFORM_META[platform];
  const date = report.generatedAt.slice(0, 10);
  const safeLabel = meta.label.replace(/[^\w가-힣]+/g, "-");
  return `소명요청_${safeLabel}_${date}_${report.lines.filter((line) => line.platform === platform).length}건.csv`;
}

/* ------------------------------------------------------------------ */
/* 인쇄용 HTML (→ PDF)                                                 */
/* ------------------------------------------------------------------ */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 인쇄용 A4 문서. 브라우저에서 "인쇄 → PDF로 저장" 하면 고객센터 첨부용 PDF가 된다.
 *
 * 서버 없이 PDF를 만드는 이유: 이 앱은 정적 배포(Vercel)이고, PDF 생성에는 폰트 임베딩이
 * 필요하다. 브라우저의 인쇄 엔진이 이미 한글 폰트와 페이지 나눔을 처리하므로, 같은 결과를
 * 의존성 0으로 얻는다. 화면에 보이는 숫자와 인쇄물의 숫자는 같은 리포트 객체에서 나온다.
 */
export function buildPrintHtml(report: ClaimReport, context: ReportContext = {}): string {
  const generated = new Date(report.generatedAt);
  const generatedText = Number.isNaN(generated.getTime())
    ? report.generatedAt
    : `${generated.getFullYear()}-${String(generated.getMonth() + 1).padStart(2, "0")}-${String(generated.getDate()).padStart(2, "0")} ${String(generated.getHours()).padStart(2, "0")}:${String(generated.getMinutes()).padStart(2, "0")}`;

  const reasonRows = report.byReason
    .map(
      (reason) =>
        `<tr><td>${escapeHtml(reason.label)}</td><td class="num">${reason.lines.toLocaleString("ko-KR")}</td><td class="num">${reason.amount.toLocaleString("ko-KR")}원</td></tr>`,
    )
    .join("");

  const platformRows = report.byPlatform
    .filter((platform) => platform.lines > 0)
    .map(
      (platform) =>
        `<tr><td>${escapeHtml(platform.label)}</td><td>${escapeHtml(platform.desk)}</td><td class="num">${platform.lines.toLocaleString("ko-KR")}</td><td class="num">${platform.amount.toLocaleString("ko-KR")}원</td></tr>`,
    )
    .join("");

  const detailRows = report.lines
    .map((line, index) => {
      const reasons = line.reasons.map((reason) => `${escapeHtml(reason.label)} ${reason.amount.toLocaleString("ko-KR")}원`).join("<br />");
      return `<tr>
        <td class="num">${index + 1}</td>
        <td>${escapeHtml(line.orderNo)}</td>
        <td class="prod">${escapeHtml(line.productName)}</td>
        <td>${escapeHtml(line.orderDate)}</td>
        <td>${escapeHtml(CHANNEL_LABEL[line.channel] ?? line.channel)}</td>
        <td>${reasons}</td>
        <td class="num">${line.expectedSettlement.toLocaleString("ko-KR")}</td>
        <td class="num">${line.actualSettlement.toLocaleString("ko-KR")}</td>
        <td class="num strong">${line.claimAmount.toLocaleString("ko-KR")}</td>
      </tr>`;
    })
    .join("");

  const excludedNotes = report.excluded
    .map((entry) => `<li><strong>${escapeHtml(entry.label)}</strong> ${entry.count.toLocaleString("ko-KR")}건 · ${entry.amount.toLocaleString("ko-KR")}원 — ${escapeHtml(NON_CLAIMABLE_REASONS[entry.code] ?? "청구 대상이 아닙니다.")}</li>`)
    .join("");

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>정산 불일치 소명 요청서 · ${escapeHtml(context.tenantName ?? "셀러")}</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #111827; background: #fff;
    font: 11px/1.55 -apple-system, BlinkMacSystemFont, "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; }
  h1 { font-size: 19px; margin: 0 0 2px; letter-spacing: -0.02em; }
  .sub { color: #6b7280; font-size: 10.5px; margin: 0 0 14px; }
  .meta { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
  .meta th, .meta td { border: 1px solid #e5e7eb; padding: 5px 8px; font-size: 10.5px; text-align: left; }
  .meta th { background: #f9fafb; color: #4b5563; font-weight: 600; width: 90px; }
  h2 { font-size: 12px; margin: 18px 0 6px; padding-bottom: 4px; border-bottom: 1.5px solid #111827; }
  table.data { width: 100%; border-collapse: collapse; }
  table.data th, table.data td { border: 1px solid #e5e7eb; padding: 4px 6px; font-size: 9.5px; vertical-align: top; }
  table.data th { background: #f3f4f6; font-weight: 600; color: #374151; white-space: nowrap; }
  table.data td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  table.data td.prod { max-width: 150px; }
  table.data td.strong { font-weight: 700; }
  table.data tr { page-break-inside: avoid; }
  .totals { margin-top: 8px; text-align: right; font-size: 12px; }
  .totals b { font-size: 15px; }
  .notes { margin: 10px 0 0; padding-left: 16px; color: #4b5563; font-size: 9.5px; }
  .notes li { margin-bottom: 3px; }
  .sign { margin-top: 22px; font-size: 10.5px; color: #374151; }
  .sign .line { display: inline-block; min-width: 160px; border-bottom: 1px solid #9ca3af; }
  .foot { margin-top: 18px; padding-top: 8px; border-top: 1px dashed #d1d5db; color: #9ca3af; font-size: 9px; }
</style>
</head>
<body>
  <h1>정산 불일치 소명 요청서</h1>
  <p class="sub">계약 조건으로 재계산한 기대 정산액과 실제 입금액의 차이를 주문 단위로 정리했습니다. 별첨 CSV와 동일한 내용입니다.</p>

  <table class="meta">
    <tr><th>요청자</th><td>${escapeHtml(context.tenantName ?? "셀러")}${context.businessNo ? ` (사업자번호 ${escapeHtml(context.businessNo)})` : ""}</td>
        <th>작성일시</th><td>${escapeHtml(generatedText)}</td></tr>
    <tr><th>대상 기간</th><td>${escapeHtml(context.period ?? "정산서 기준")}</td>
        <th>검토 주문</th><td>${report.scannedRows.toLocaleString("ko-KR")}건</td></tr>
    <tr><th>증빙 원본</th><td colspan="3">${escapeHtml(context.sourceFileName ?? "정산서 업로드 파일")}</td></tr>
  </table>

  <h2>1. 청구 요약</h2>
  <table class="data">
    <tr><th>구분</th><th>접수 창구</th><th>건수</th><th>청구 금액</th></tr>
    ${platformRows || '<tr><td colspan="4">청구 대상 건이 없습니다.</td></tr>'}
  </table>
  <div class="totals">합계 ${report.lines.length.toLocaleString("ko-KR")}건 · <b>${report.totalAmount.toLocaleString("ko-KR")}원</b></div>

  ${
    reasonRows
      ? `<h2>2. 원인별 청구 금액</h2>
  <table class="data">
    <tr><th>원인</th><th>건수</th><th>금액</th></tr>
    ${reasonRows}
  </table>`
      : ""
  }

  <h2>3. 주문별 상세</h2>
  <table class="data">
    <tr>
      <th>#</th><th>주문번호</th><th>상품명</th><th>주문일</th><th>채널</th>
      <th>청구 사유</th><th>기대 정산액</th><th>실제 입금액</th><th>청구액</th>
    </tr>
    ${detailRows || '<tr><td colspan="9">청구 대상 건이 없습니다.</td></tr>'}
  </table>

  ${
    excludedNotes
      ? `<h2>4. 청구에서 제외한 항목</h2>
  <ul class="notes">${excludedNotes}</ul>`
      : ""
  }

  <h2>${excludedNotes ? "5" : "4"}. 산정 기준</h2>
  <ul class="notes">
    <li>기대 정산액 = 결제금액 − (결제금액 × 계약 수수료율) − 계약 배송비 − 계약 반품비. 마켓별 계약 프리셋을 기준으로 재계산했습니다.</li>
    <li>청구액은 해당 주문의 정산 부족액을 넘지 않습니다. 같은 금액을 두 번 청구하지 않습니다.</li>
    <li>금액 하한 ${report.options.minAmount.toLocaleString("ko-KR")}원 미만 ${report.belowThreshold.toLocaleString("ko-KR")}건은 행정 비용 대비 실익이 없어 제외했습니다.</li>
    ${report.truncated > 0 ? `<li>금액 상위 ${report.options.maxLines}건만 접수합니다. 나머지 ${report.truncated.toLocaleString("ko-KR")}건은 2차 접수 대상입니다.</li>` : ""}
    <li>본 문서는 판매자 원장과 계약 조건으로 계산한 추정치이며, 마켓의 최종 정산 확인 결과에 따라 금액이 달라질 수 있습니다.</li>
  </ul>

  <div class="sign">
    위 금액의 정정을 요청합니다. &nbsp;&nbsp; 요청자 <span class="line"></span> (인)
  </div>
  <p class="foot">SellerScope · 정산 대사 리포트 · ${escapeHtml(report.generatedAt)} 자동 생성</p>
</body>
</html>`;
}

/** 인쇄용 파일명(내려받기용). */
export function claimPrintFileName(report: ClaimReport): string {
  const date = report.generatedAt.slice(0, 10);
  return `소명요청서_${date}_${report.lines.length}건.html`;
}

/* ------------------------------------------------------------------ */
/* 요약 문장                                                           */
/* ------------------------------------------------------------------ */

/** 화면 상단에 한 줄로 쓰는 요약. 리포트가 비었을 때와 아닐 때를 구분한다. */
export function describeClaimReport(report: ClaimReport): string {
  if (report.lines.length === 0) {
    return `청구 가능한 불일치가 없습니다(금액 하한 ${report.options.minAmount.toLocaleString("ko-KR")}원). 검토 ${report.scannedRows.toLocaleString("ko-KR")}건.`;
  }
  const platforms = report.byPlatform
    .filter((platform) => platform.lines > 0)
    .map((platform) => `${platform.label} ${platform.lines}건`)
    .join(" · ");
  return `${report.lines.length.toLocaleString("ko-KR")}건 · ${report.totalAmount.toLocaleString("ko-KR")}원 청구 가능 (${platforms})`;
}
