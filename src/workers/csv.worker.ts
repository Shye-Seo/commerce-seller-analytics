import { SettlementCsvPipeline } from "../lib/csvStreamParser";
import type { WorkerParseRequest, WorkerResponse } from "../lib/csvWorkerProtocol";

/**
 * 정산 CSV 파싱 워커
 *
 * 이 파일은 **메인 스레드가 아니라 워커 스레드에서** 실행된다. 그래서 10만 행을 파싱하는 동안
 * 화면은 스크롤·버튼 클릭에 계속 반응한다. 워커 안에서도 `file.stream()` 청크를 읽어
 * 한 번에 파일 전체 문자열을 만들지 않는다(브라우저 힙이 아닌 워커 힙에서만 조금씩 소비).
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

scope.onmessage = (event) => {
  const request = event.data;
  if (!request || request.type !== "parse") return;
  void handleParse(request);
};

async function handleParse(request: WorkerParseRequest): Promise<void> {
  const { requestId, file } = request;

  try {
    const pipeline = new SettlementCsvPipeline(
      file.size,
      {
        onProgress: (progress) => scope.postMessage({ type: "progress", requestId, progress }),
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

    scope.postMessage({ type: "done", requestId, result: pipeline.finish() });
  } catch (error) {
    scope.postMessage({
      type: "error",
      requestId,
      message: error instanceof Error ? error.message : "워커 파싱 중 알 수 없는 오류",
    });
  }
}
