import type { ParseProgress, SettlementParseResult } from "./csvStreamParser";

/**
 * 메인 스레드 ↔ Web Worker 메시지 규약.
 *
 * 왜 별도 파일인가
 * ----------------
 * 요청/응답 타입을 한 곳에 두면 워커 코드와 호출 코드가 같은 타입을 공유한다. 워커는
 * `postMessage`로 아무 객체나 보낼 수 있어서, 규약을 고정하지 않으면 조용히 어긋난다.
 */

export interface WorkerParseRequest {
  type: "parse";
  requestId: string;
  /** File은 구조적 복제(structured clone)로 워커에 전달된다. 원본은 그대로 남는다. */
  file: File;
}

export type WorkerResponse =
  | { type: "progress"; requestId: string; progress: ParseProgress }
  | { type: "done"; requestId: string; result: SettlementParseResult }
  | { type: "error"; requestId: string; message: string };
