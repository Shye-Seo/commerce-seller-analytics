import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E 구성
 *
 * 왜 dev 서버가 아니라 프로덕션 빌드를 띄우나
 * --------------------------------------------
 * 검증 대상이 "10만 행을 버티는 화면"이기 때문이다. dev 서버는 요청마다 온디맨드 컴파일을 하므로
 * 첫 페이지 로드가 수십 초 걸리고, 그 시간이 성능 단언(진행률·처리량)의 잡음이 된다. 빌드 산출물을
 * `next start`로 띄우면 사용자가 실제로 받는 번들과 같은 조건에서 돈다.
 *
 * 로컬에서 이미 서버를 띄워 두었다면 `reuseExistingServer`가 그대로 쓴다(재빌드 방지).
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${PORT}`;
const useDevServer = process.env.E2E_DEV_SERVER === "1";

export default defineConfig({
  testDir: "./e2e",
  // 이 스펙은 브라우저에서 10만 행 가상화와 2만 건 배치 대사를 돌린다. 병렬로 늘리면 메모리(512MB대
  // 컨테이너)에서 브라우저가 OOM으로 죽어 "기능 실패"처럼 보인다. 직렬이 정직하다.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    launchOptions: {
      // 컨테이너의 /dev/shm은 기본 64MB다. 그대로 두면 Chromium이 렌더러에서 죽는다.
      args: ["--disable-dev-shm-usage"],
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
  ],
  webServer: {
    command: useDevServer ? `npm run dev -- --port ${PORT}` : `npm run build && npm run start -- --port ${PORT}`,
    url: `${baseURL}/reconciliation`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    env: { NEXT_TELEMETRY_DISABLED: "1" },
  },
});
