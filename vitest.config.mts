import { defineConfig } from "vitest/config";

// 마진 계산 로직은 UI와 분리된 순수 함수이므로 DOM 환경 없이 node 환경에서 검증한다.
export default defineConfig({
  // vitest 는 내부적으로 vite dev server 를 띄운다. 호스트를 명시하지 않으면 `localhost` 를
  // DNS 로 해석하는데, /etc/hosts 가 없는 컨테이너나 사내 DNS 환경에서는 ENOTFOUND 로
  // 시작 단계에서 죽는다. 루프백 IP 를 고정해 실행 환경에 의존하지 않게 한다.
  server: {
    host: "127.0.0.1",
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    reporters: "default",
  },
});
