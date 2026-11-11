"use client";

import { useCallback, useRef, useState } from "react";
import type { FileParseResult } from "@/lib/settlementFileParser";
import { parseSettlementFile } from "@/lib/settlementFileParser";
import { formatThroughput } from "@/lib/csvStreamParser";
import {
  DEFAULT_UPLOAD_LIMITS,
  describeMultiFileDrop,
  formatBytes,
  UPLOAD_ACCEPT,
  validateUploadFile,
  type UploadIssue,
} from "@/lib/settlementUpload";

/**
 * 정산 파일 드래그앤드롭 업로더
 *
 * 왜 컴포넌트로 분리했나
 * ---------------------
 * 파일 선택은 "input 하나"로 끝나지 않는다. 검증(0바이트·확장자·크기·가짜 xlsx), 드롭 상태,
 * 워커 파싱 진행률(엑셀은 변환 → 파싱 2단계), 파싱 통계, 실패 사유 안내가 한 덩어리다.
 * 대사 콘솔은 대사 결과에 집중하고, 이 컴포넌트는 **파일이 들어오는 입구**만 책임진다.
 *
 * 소유권 경계
 * ----------
 * - 이 컴포넌트: 파일 검증, 파싱, 진행률/통계 표시
 * - 부모(콘솔): 파싱 결과를 받아 대사 실행·권한·감사 로그
 * 파싱은 여기서 끝나고 `onParsed`로 넘긴다. 부모는 파싱 성공을 다시 검사하지 않는다.
 */

export interface UploaderNotice {
  tone: "info" | "warn" | "error" | "success";
  text: string;
}

interface Props {
  /** 대사 진행 중에는 새 파일을 받지 않는다(두 작업이 같은 화면 상태를 덮어쓰지 않도록) */
  disabled?: boolean;
  onParsed: (result: FileParseResult, file: File) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  onNotice?: (notice: UploaderNotice) => void;
}

interface ParseSnapshot {
  fileName: string;
  sizeLabel: string;
  sourceFormat: string;
  engine: string;
  rows: number;
  errorRows: number;
  duplicates: number;
  elapsedMs: number;
  rowsPerSecond: number;
  sheetName?: string;
  truncated: boolean;
}

export default function ReconciliationFileUploader({ disabled = false, onParsed, onBusyChange, onNotice }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<"idle" | "validating" | "parsing" | "done">("idle");
  const [percent, setPercent] = useState(0);
  const [statusText, setStatusText] = useState("CSV·엑셀 파일을 끌어다 놓거나 눌러서 선택하세요");
  const [issue, setIssue] = useState<UploadIssue | null>(null);
  const [snapshot, setSnapshot] = useState<ParseSnapshot | null>(null);
  const [localNotice, setLocalNotice] = useState<string | null>(null);

  const notify = useCallback(
    (notice: UploaderNotice) => {
      onNotice?.(notice);
      if (notice.tone === "warn" || notice.tone === "error") setLocalNotice(notice.text);
    },
    [onNotice],
  );

  const runFile = useCallback(
    async (file: File) => {
      if (disabled || busy) return;
      setIssue(null);
      setSnapshot(null);
      setLocalNotice(null);
      setStage("validating");
      setPercent(0);
      setStatusText(`${file.name} 검사 중`);

      const validation = await validateUploadFile({
        name: file.name,
        size: file.size,
        type: file.type,
        readHead: async () => new Uint8Array(await file.slice(0, 8).arrayBuffer()),
      });

      if (!validation.ok || !validation.format) {
        setStage("idle");
        setIssue(validation.issue ?? { code: "UNSUPPORTED_EXTENSION", message: "이 파일은 읽을 수 없습니다.", hint: "" });
        setStatusText("파일을 읽을 수 없습니다");
        return;
      }

      for (const warning of validation.warnings) notify({ tone: "info", text: warning });

      setStage("parsing");
      setBusy(true);
      onBusyChange?.(true);
      setPercent(2);
      setStatusText("Web Worker에서 파싱 준비 중");

      try {
        const parsed = await parseSettlementFile(file, {
          delimiter: validation.format === "tsv" ? "\t" : ",",
          onProgress: (progress) => {
            setPercent(Math.max(2, Math.min(99, progress.percent)));
            const phase =
              progress.stage === "convert"
                ? "엑셀 해제·시트 변환"
                : progress.engine === "worker"
                  ? "Web Worker 파싱"
                  : "메인 스레드 파싱";
            setStatusText(
              `${phase} · ${progress.processedRows.toLocaleString("ko-KR")}행 · ${formatThroughput(progress.rowsPerSecond)}`,
            );
          },
        });

        setPercent(100);
        setStage("done");
        setStatusText(`${parsed.rows.length.toLocaleString("ko-KR")}행 파싱 완료`);
        setSnapshot({
          fileName: file.name,
          sizeLabel: formatBytes(parsed.meta.bytesRead || file.size),
          sourceFormat: parsed.meta.sourceFormat ?? validation.format,
          engine: parsed.meta.engine,
          rows: parsed.rows.length,
          errorRows: parsed.errorCount,
          duplicates: parsed.meta.duplicateOrderCount,
          elapsedMs: parsed.meta.elapsedMs,
          rowsPerSecond: parsed.meta.rowsPerSecond,
          sheetName: parsed.meta.sheetName,
          truncated: Boolean(parsed.meta.truncated),
        });

        await onParsed(parsed, file);
      } catch (error) {
        setStage("idle");
        setPercent(0);
        setStatusText("파싱 실패");
        const message = error instanceof Error ? error.message : "알 수 없는 오류";
        setIssue({ code: "UNSUPPORTED_EXTENSION", message, hint: "파일 형식과 인코딩(UTF-8)을 확인해 주세요." });
      } finally {
        setBusy(false);
        onBusyChange?.(false);
      }
    },
    [busy, disabled, notify, onBusyChange, onParsed],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      const multi = describeMultiFileDrop(files.length);
      if (multi) setLocalNotice(multi);
      const file = files[0];
      if (file) void runFile(file);
    },
    [runFile],
  );

  const openPicker = useCallback(() => {
    if (disabled || busy) return;
    inputRef.current?.click();
  }, [busy, disabled]);

  const stateLabel = stage === "parsing" ? "파싱 중" : stage === "validating" ? "검사 중" : stage === "done" ? "완료" : "대기";

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400/80">File intake</p>
          <p className="mt-1 text-[12.5px] text-slate-300">마켓 정산서 파일을 그대로 올리면 ①검증 ②파싱 ③대사까지 이어집니다.</p>
        </div>
        <span className="rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[10px] text-slate-400">
          최대 {formatBytes(DEFAULT_UPLOAD_LIMITS.maxBytes)} · CSV · TSV · XLSX
        </span>
      </div>

      <div
        role="button"
        tabIndex={0}
        aria-label="정산 파일을 끌어다 놓거나 눌러서 선택"
        aria-disabled={disabled || busy}
        onClick={openPicker}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openPicker();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled && !busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={`mt-3 rounded-xl border border-dashed px-4 py-6 text-center transition ${
          disabled || busy
            ? "cursor-not-allowed border-white/[0.06] bg-white/[0.01] opacity-60"
            : dragging
              ? "cursor-copy border-emerald-400/70 bg-emerald-400/[0.08]"
              : "cursor-pointer border-white/[0.14] bg-white/[0.02] hover:border-emerald-400/40 hover:bg-emerald-400/[0.04]"
        }`}
      >
        <p className="text-[13px] font-medium text-slate-200">
          {dragging ? "여기에 놓으면 바로 파싱합니다" : "정산서 파일을 이 영역에 끌어다 놓으세요"}
        </p>
        <p className="mt-1 text-[11px] text-slate-500">
          스마트스토어·쿠팡 정산 내역 원본 · 엑셀(.xlsx)은 변환 없이 그대로 인식합니다 · 클릭해서 선택도 가능
        </p>
        <p className="mt-2 text-[10px] text-slate-600">파일은 브라우저 안에서만 처리되며 서버로 전송되지 않습니다.</p>
        <input
          ref={inputRef}
          type="file"
          accept={UPLOAD_ACCEPT}
          className="sr-only"
          disabled={disabled || busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void runFile(file);
          }}
        />
      </div>

      {(stage !== "idle" || percent > 0) && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-[10.5px] text-slate-500">
            <span className="tabular-nums">{statusText}</span>
            <span className="tabular-nums">
              {stateLabel} · {percent}%
            </span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className={`h-full rounded-full transition-[width] duration-200 ${issue ? "bg-rose-400" : "bg-emerald-400/80"}`}
              style={{ width: `${Math.max(2, percent)}%` }}
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="파일 파싱 진행률"
            />
          </div>
        </div>
      )}

      {issue && (
        <div className="mt-3 rounded-lg border border-rose-400/25 bg-rose-400/[0.07] px-3 py-2 text-[11px] leading-relaxed text-rose-200">
          <p className="font-medium">{issue.message}</p>
          {issue.hint && <p className="mt-0.5 text-rose-200/80">{issue.hint}</p>}
        </div>
      )}

      {localNotice && !issue && (
        <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-[11px] text-amber-200">{localNotice}</p>
      )}

      {snapshot && (
        <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3 xl:grid-cols-6">
          <Stat label="읽은 행" value={`${snapshot.rows.toLocaleString("ko-KR")}행`} />
          <Stat label="격리 오류" value={`${snapshot.errorRows.toLocaleString("ko-KR")}건`} tone={snapshot.errorRows > 0 ? "warn" : "normal"} />
          <Stat label="중복 주문" value={`${snapshot.duplicates.toLocaleString("ko-KR")}건`} tone={snapshot.duplicates > 0 ? "warn" : "normal"} />
          <Stat label="처리 속도" value={formatThroughput(snapshot.rowsPerSecond)} />
          <Stat
            label="실행 경로"
            value={snapshot.engine === "worker" ? "Web Worker" : "메인 스레드"}
            hint={`${(snapshot.elapsedMs / 1000).toFixed(2)}초 · ${snapshot.sizeLabel}`}
          />
          <Stat
            label="원본 형식"
            value={snapshot.sourceFormat === "xlsx" ? "엑셀" : snapshot.sourceFormat.toUpperCase()}
            hint={snapshot.sheetName ? `시트 ${snapshot.sheetName}` : undefined}
          />
        </div>
      )}

      {snapshot?.truncated && (
        <p className="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-[11px] text-amber-200">
          파일이 처리 상한(20만 행)을 넘어 앞부분만 읽었습니다. 정산 기간을 나눠 업로드해 주세요.
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
