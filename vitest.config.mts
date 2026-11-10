import { defineConfig } from "vitest/config";

// 마진 계산 로직은 UI와 분리된 순수 함수이므로 DOM 환경 없이 node 환경에서 검증한다.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    reporters: "default",
  },
});
