import {
  SettlementCsvPipeline,
  type ParseProgress,
  type SettlementParseOptions,
  type SettlementParseResult,
} from "./csvStreamParser";
import type { WorkerResponse } from "./csvWorkerProtocol";
import { detectFormat, type SupportedFormat } from "./settlementUpload";
import { xlsxToCsv } from "./xlsxConvert";

/**
 * 파일 → 정산 행 파서 (브라우저 진입점)
 *
 * 실행 경로를 두 개 둔다.
 *
 *  1) **Web Worker** (기본): 메인 스레드는 파일을 읽지도, 파싱하지도 않는다. 워커가 `file.stream()`을
 *     청크로 읽고 진행률만 postMessage로 흘려보낸다. 10만 행 파싱 중에도 스크롤이 60fps를 유지한다.
 *  2) **메인 스레드 폴백**: 워커 생성이 막힌 환경(일부 구형 브라우저·CSP·테스트)에서는 같은
 *     파이프라인을 메인 스레드에서 청크 단위로 돌린다. 여전히 이벤트 루프에 양보하므로 UI는 살아 있다.
 *
 * 어느 경로를 탔는지 `meta.engine`과 `engineFallbackReason`으로 남긴다. 조용히 느려지는 일이 없도록.
 */

export interface FileParseMeta {
  /** 실제로 사용된 실행 경로 */
  engine: "worker" | "main-thread";
  /** 워커가 실패해 폴백했다면 그 사유 */
  engineFallbackReason?: string;
  /** 원본 파일 형식(엑셀은 변환 후 같은 파이프라인을 탄다) */
  sourceFormat: SupportedFormat;
  /** 엑셀일 때 변환에 사용한 시트 */
  sheetName?: string;
  /** 엑셀 변환 행 수 초과로 잘렸는지 */
  truncated?: boolean;
}

export interface FileParseResult extends SettlementParseResult {
  meta: SettlementParseResult["meta"] & FileParseMeta;
}

export interface FileParseOptions extends SettlementParseOptions {
  /** 워커를 쓰지 않고 메인 스레드에서 파싱 (디버깅용) */
  forceMainThread?: boolean;
  /** 워커 응답 대기 한도(ms) */
  workerTimeoutMs?: number;
}

const DEFAULT_WORKER_TIMEOUT = 120_000;

/** Worker를 만들 수 있는 환경인가 (SSR·구형 브라우저 방어) */
export function canUseWorker(): boolean {
  return typeof Worker !== "undefined" && typeof URL !== "undefined";
}

export function detectFileFormat(file: File): SupportedFormat {
  const format = detectFormat(file.name);
  return format === "xlsx" || format === "tsv" ? format : "csv";
}

/**
 * 파일을 파싱한다. 워커 경로가 실패하면 사유를 남기고 메인 스레드로 자동 폴백한다.
 * (폴백은 "성공"으로 숨기지 않는다 — 사용자에게 어느 경로였는지 보여 준다)
 */
export async function parseSettlementFile(file: File, options: FileParseOptions = {}): Promise<FileParseResult> {
  const { forceMainThread, workerTimeoutMs, ...parseOptions } = options;
  const sourceFormat = detectFileFormat(file);

  if (!forceMainThread && canUseWorker()) {
    try {
      const result = await parseInWorker(file, parseOptions, workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT);
      return { ...result, meta: { ...result.meta, engine: "worker", sourceFormat: result.meta.sourceFormat ?? sourceFormat } };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "워커 실행 실패";
      const result = await parseOnMainThread(file, parseOptions);
      return { ...result, meta: { ...result.meta, engine: "main-thread", sourceFormat, engineFallbackReason: reason } };
    }
  }

  const result = await parseOnMainThread(file, parseOptions);
  return { ...result, meta: { ...result.meta, engine: "main-thread", sourceFormat } };
}

function parseInWorker(
  file: File,
  options: SettlementParseOptions,
  timeoutMs: number,
): Promise<SettlementParseResult> {
  return new Promise<SettlementParseResult>((resolve, reject) => {
    let worker: Worker;
    try {
      // Next.js(webpack 5)는 이 형태를 인식해 워커를 별도 청크로 번들한다.
      worker = new Worker(new URL("../workers/csv.worker.ts", import.meta.url));
    } catch (error) {
      reject(error instanceof Error ? error : new Error("워커 생성 실패"));
      return;
    }

    const requestId = `parse-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    let settled = false;

    const cleanup = (): void => {
      worker.terminate();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`워커 응답 시간 초과(${Math.round(timeoutMs / 1000)}초)`));
    }, timeoutMs);

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (!message || message.requestId !== requestId) return;

      if (message.type === "progress") {
        options.onProgress?.(message.progress as ParseProgress);
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();

      if (message.type === "done") resolve(message.result);
      else reject(new Error(message.message));
    };

    worker.onerror = (event) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error(event.message || "워커에서 오류가 발생했습니다."));
    };

    worker.postMessage({ type: "parse", requestId, file });
  });
}

async function parseOnMainThread(file: File, options: SettlementParseOptions): Promise<SettlementParseResult> {
  const format = detectFileFormat(file);
  const delimiter = options.delimiter ?? (format === "tsv" ? "\t" : ",");
  const startedAt = Date.now();

  if (format === "xlsx") {
    // 워커를 못 쓰는 환경의 폴백 경로. 같은 변환기를 쓰되 결과 메타를 동일하게 남긴다.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const converted = await xlsxToCsv(bytes, {
      onProgress: (ratio) =>
        options.onProgress?.({
          engine: "main-thread",
          stage: "convert",
          percent: Math.round(Math.min(1, Math.max(0, ratio)) * 25),
          processedRows: 0,
          parsedRows: 0,
          errorRows: 0,
          bytesRead: Math.round(file.size * Math.min(1, Math.max(0, ratio))),
          totalBytes: file.size,
          rowsPerSecond: 0,
          elapsedMs: Date.now() - startedAt,
        }),
    });
    const pipeline = new SettlementCsvPipeline(
      converted.csvText.length,
      { ...options, delimiter, onProgress: (progress) => options.onProgress?.({ ...progress, stage: "parse", percent: Math.round(25 + progress.percent * 0.75) }) },
      "main-thread",
    );
    await pipeline.push(converted.csvText);
    const result = pipeline.finish();
    return {
      ...result,
      meta: {
        ...result.meta,
        bytesRead: file.size,
        sourceFormat: "xlsx",
        sheetName: converted.sheetName,
        convertedRowCount: converted.rowCount,
        truncated: converted.truncated,
      },
    };
  }

  const pipeline = new SettlementCsvPipeline(file.size, { ...options, delimiter }, "main-thread");
  const stream = typeof file.stream === "function" ? file.stream() : null;

  if (stream) {
    const decoder = new TextDecoder("utf-8");
    const reader = stream.getReader();
    for (;;) {
      if (pipeline.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (value) await pipeline.push(decoder.decode(value, { stream: true }));
    }
    await pipeline.push(decoder.decode());
  } else {
    await pipeline.push(await file.text());
  }

  const result = pipeline.finish();
  return { ...result, meta: { ...result.meta, sourceFormat: format } };
}
