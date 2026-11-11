import { SettlementCsvPipeline, type ParseProgress } from "../lib/csvStreamParser";
import type { WorkerParseRequest, WorkerResponse } from "../lib/csvWorkerProtocol";
import { detectFormat } from "../lib/settlementUpload";
import { xlsxToCsv } from "../lib/xlsxConvert";

/**
 * 정산서 파싱 워커
 *
 * 이 파일은 **메인 스레드가 아니라 워커 스레드에서** 실행된다. 그래서 10만 행을 파싱하는 동안
 * 화면은 스크롤·버튼 클릭에 계속 반응한다. 워커 안에서도 `file.stream()` 청크를 읽어
 * 한 번에 파일 전체 문자열을 만들지 않는다(브라우저 힙이 아닌 워커 힙에서만 조금씩 소비).
 *
 * 엑셀(.xlsx)도 같은 워커에서 처리한다. ZIP 해제와 XML 파싱은 CPU를 쓰는 작업이라
 * 메인 스레드에서 하면 스크롤이 끊긴다. 변환 결과는 CSV 문자열이므로 이후 경로는 동일하다.
 * 진행률은 변환 0~25%, 파싱 25~100%로 나눠 한 개의 프로그레스 바로 보여 준다.
 *
 * `self`를 DedicatedWorkerGlobalScope로 단언하는 이유: 이 프로젝트의 tsconfig는 DOM 라이브러리를
 * 쓰고 있어 WebWorker 라이브러리를 함께 넣으면 선언이 충돌한다. 워커에서 실제로 쓰는 두 멤버만
 * 좁은 타입으로 선언해 충돌 없이 안전하게 쓴다.
 */

interface WorkerScope {
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: { data: WorkerParseRequest }) => void) | null;
}

const scope = self as unknown as WorkerScope;

/** 엑셀 변환 단계가 차지하는 진행률 비중 */
const CONVERT_SHARE = 0.25;

scope.onmessage = (event) => {
  const request = event.data;
  if (!request || request.type !== "parse") return;
  void handleParse(request);
};

async function handleParse(request: WorkerParseRequest): Promise<void> {
  const { requestId, file } = request;

  try {
    const format = detectFormat(file.name);
    const sourceFormat = format === "xlsx" || format === "tsv" ? format : "csv";
    const delimiter = format === "tsv" ? "\t" : ",";
    const startedAt = Date.now();
    const emit = (progress: ParseProgress): void => scope.postMessage({ type: "progress", requestId, progress });

    if (format === "xlsx") {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const converted = await xlsxToCsv(bytes, {
        onProgress: (ratio) => {
          const clamped = Math.min(1, Math.max(0, ratio));
          emit({
            engine: "worker",
            stage: "convert",
            percent: Math.round(clamped * CONVERT_SHARE * 100),
            processedRows: 0,
            parsedRows: 0,
            errorRows: 0,
            bytesRead: Math.round(file.size * clamped),
            totalBytes: file.size,
            rowsPerSecond: 0,
            elapsedMs: Date.now() - startedAt,
          });
        },
      });

      // 변환된 CSV 문자열을 그대로 파이프라인에 넣는다. 이후 경로는 CSV 업로드와 동일하다.
      const pipeline = new SettlementCsvPipeline(
        converted.csvText.length,
        {
          delimiter,
          onProgress: (progress) => emit(scaleAfterConvert(progress)),
        },
        "worker",
      );
      await pipeline.push(converted.csvText);
      const result = pipeline.finish();
      scope.postMessage({
        type: "done",
        requestId,
        result: {
          ...result,
          meta: {
            ...result.meta,
            bytesRead: file.size,
            sourceFormat: "xlsx",
            sheetName: converted.sheetName,
            convertedRowCount: converted.rowCount,
            truncated: converted.truncated,
          },
        },
      });
      return;
    }

    const pipeline = new SettlementCsvPipeline(
      file.size,
      {
        delimiter,
        onProgress: emit,
      },
      "worker",
    );

    const decoder = new TextDecoder("utf-8");
    const stream = typeof file.stream === "function" ? file.stream() : null;

    if (stream) {
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) await pipeline.push(decoder.decode(value, { stream: true }));
      }
      await pipeline.push(decoder.decode());
    } else {
      // 아주 오래된 브라우저 폴백: 워커 안에서 전체 텍스트를 읽는다(메인 스레드는 여전히 안전).
      await pipeline.push(await file.text());
    }

    const result = pipeline.finish();
    scope.postMessage({
      type: "done",
      requestId,
      result: { ...result, meta: { ...result.meta, sourceFormat } },
    });
  } catch (error) {
    scope.postMessage({
      type: "error",
      requestId,
      message: error instanceof Error ? error.message : "워커 파싱 중 알 수 없는 오류",
    });
  }
}

/** 변환 단계(0~25%)를 마친 뒤의 파싱 진행률을 전체 구간(25~100%)으로 늘려 잡는다. */
function scaleAfterConvert(progress: ParseProgress): ParseProgress {
  return {
    ...progress,
    stage: "parse",
    percent: Math.round(CONVERT_SHARE * 100 + progress.percent * (1 - CONVERT_SHARE)),
  };
}
