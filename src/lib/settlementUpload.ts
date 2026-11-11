/**
 * 정산서 업로드 검증 규칙
 *
 * 드래그앤드롭은 "아무 파일이나 떨어뜨릴 수 있다"는 뜻이기도 하다. 스크린샷, PDF, 3년 전
 * 백업 zip, 0바이트 파일이 전부 들어온다. 검증을 서버에 맡기면 이미 10MB를 올린 뒤에
 * 거절당하므로, 브라우저에서 **파일을 읽기 전에** 판정한다.
 *
 * 규칙을 별도 모듈로 둔 이유: 컴포넌트(React)와 워커, 테스트가 같은 규칙을 본다.
 * 화면에서 통과한 파일이 파서에서 실패하는 일이 없어야 한다.
 */

export type SupportedFormat = "csv" | "tsv" | "xlsx";

export interface UploadLimits {
  /** 하드 리밋. 넘으면 거절. */
  maxBytes: number;
  /** 경고 리밋. 넘으면 "느릴 수 있음"을 알린다. */
  warnBytes: number;
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxBytes: 50 * 1024 * 1024,
  warnBytes: 20 * 1024 * 1024,
};

/** 파일 선택 대화상자에 넘기는 accept 값 */
export const UPLOAD_ACCEPT = ".csv,.tsv,.txt,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type UploadIssueCode =
  | "EMPTY_FILE"
  | "TOO_LARGE"
  | "UNSUPPORTED_EXTENSION"
  | "LEGACY_EXCEL"
  | "BROKEN_XLSX";

export interface UploadIssue {
  code: UploadIssueCode;
  message: string;
  /** 사용자가 지금 할 수 있는 행동 */
  hint: string;
}

export interface UploadValidation {
  ok: boolean;
  /** 검증을 통과했을 때의 형식 */
  format?: SupportedFormat;
  issue?: UploadIssue;
  /** 통과했지만 미리 알려야 하는 것들 */
  warnings: string[];
  sizeLabel: string;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`;
}

/** 확장자로 형식을 판정한다. 확장자가 없으면 null. */
export function detectFormat(fileName: string): SupportedFormat | "xls" | null {
  const lower = fileName.trim().toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  const extension = lower.slice(dot);
  if (extension === ".csv") return "csv";
  if (extension === ".tsv" || extension === ".tab") return "tsv";
  if (extension === ".txt") return "csv";
  if (extension === ".xlsx" || extension === ".xlsm") return "xlsx";
  if (extension === ".xls") return "xls";
  return null;
}

export interface UploadCandidate {
  name: string;
  size: number;
  type?: string;
  /** 앞 몇 바이트를 읽는 함수(없으면 매직바이트 검사를 건너뛴다) */
  readHead?: () => Promise<Uint8Array>;
}

/**
 * 파일 검증. `readHead`가 있으면 ZIP 매직바이트(PK\x03\x04)까지 확인한다.
 * .xlsx인데 실제로는 HTML 오류 페이지(ZIP 아님)인 경우가 실제로 흔하다(마켓 다운로드 실패).
 */
export async function validateUploadFile(
  candidate: UploadCandidate,
  limits: UploadLimits = DEFAULT_UPLOAD_LIMITS,
): Promise<UploadValidation> {
  const warnings: string[] = [];
  const sizeLabel = formatBytes(candidate.size);

  if (candidate.size <= 0) {
    return {
      ok: false,
      warnings,
      sizeLabel,
      issue: {
        code: "EMPTY_FILE",
        message: "파일이 비어 있습니다(0바이트).",
        hint: "마켓에서 정산서를 다시 내려받아 주세요. 다운로드가 중간에 끊기면 0바이트 파일이 만들어집니다.",
      },
    };
  }

  if (candidate.size > limits.maxBytes) {
    return {
      ok: false,
      warnings,
      sizeLabel,
      issue: {
        code: "TOO_LARGE",
        message: `파일이 너무 큽니다(${sizeLabel}). 한 번에 ${formatBytes(limits.maxBytes)}까지 처리합니다.`,
        hint: "정산 기간을 나눠서(예: 3개월씩) 업로드하면 같은 결과를 얻을 수 있습니다.",
      },
    };
  }

  const format = detectFormat(candidate.name);

  if (format === "xls") {
    return {
      ok: false,
      warnings,
      sizeLabel,
      issue: {
        code: "LEGACY_EXCEL",
        message: "구형 엑셀(.xls)은 지원하지 않습니다.",
        hint: "엑셀에서 'Excel 통합 문서(.xlsx)' 또는 'CSV UTF-8'로 저장한 뒤 다시 올려 주세요.",
      },
    };
  }

  if (!format) {
    return {
      ok: false,
      warnings,
      sizeLabel,
      issue: {
        code: "UNSUPPORTED_EXTENSION",
        message: "정산서 형식이 아닙니다. CSV(.csv) 또는 엑셀(.xlsx) 파일만 읽습니다.",
        hint: "마켓 판매자센터의 '정산 내역 다운로드'에서 받은 원본 파일을 올려 주세요.",
      },
    };
  }

  if (format === "xlsx" && candidate.readHead) {
    const head = await candidate.readHead();
    const isZip = head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07) && (head[3] === 0x04 || head[3] === 0x06 || head[3] === 0x08);
    if (!isZip) {
      return {
        ok: false,
        warnings,
        sizeLabel,
        issue: {
          code: "BROKEN_XLSX",
          message: "확장자는 .xlsx지만 실제 엑셀 파일이 아닙니다.",
          hint: "다운로드가 실패해 오류 페이지가 저장된 경우가 많습니다. 마켓에서 다시 내려받아 주세요.",
        },
      };
    }
  }

  if (candidate.size > limits.warnBytes) {
    warnings.push(
      `${sizeLabel} 파일입니다. 파싱에 수 초 걸릴 수 있지만, Web Worker에서 처리하므로 화면은 그대로 쓸 수 있습니다.`,
    );
  }
  if (format === "tsv") {
    warnings.push("탭 구분 파일입니다. 탭을 구분자로 읽습니다.");
  }

  return { ok: true, format, warnings, sizeLabel };
}

/** 드롭된 항목이 여러 개일 때 첫 파일만 쓰는 이유를 문장으로 남긴다(조용한 무시 금지). */
export function describeMultiFileDrop(count: number): string | null {
  if (count <= 1) return null;
  return `파일 ${count}개가 감지되었습니다. 대사는 한 번에 한 파일 기준이므로 첫 번째 파일만 사용합니다.`;
}
