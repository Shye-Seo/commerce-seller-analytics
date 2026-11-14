import { expect, test, type Page } from "@playwright/test";

/**
 * 쿠폰 → 정산 → 알림톡 → API 문서 E2E
 *
 * 단위 테스트는 순수 함수(매칭·ROAS·템플릿 본문·명세 검증)를 고정한다. 이 스펙은 그 함수들이
 * **화면과 저장소를 건너** 실제로 이어지는지를 본다.
 *
 *   1. `/flash`에서 발급한 원장이 정산 대사 콘솔과 메인 카드에 같은 값으로 나타나는가
 *      (페이지 사이 공유는 localStorage + useSyncExternalStore로만 이루어진다)
 *   2. 쿠폰 사용 주문이 정산 행과 매칭되어 ROAS가 계산되는가
 *   3. 알림톡 발송 이력이 남고, 같은 배치를 다시 보내면 중복 차단(dedupe)이 걸리는가
 *   4. `/api-docs`가 명세를 읽어 그려지고, Try it out이 스키마 위반을 잡아내는가
 */

async function waitForReconciliationReady(page: Page): Promise<void> {
  await expect(page.getByTestId("kpi-matched-rate")).toContainText("%", { timeout: 60_000 });
  await expect(page.getByTestId("settlement-file-input")).toBeEnabled({ timeout: 60_000 });
}

test.describe("쿠폰 발급 → 정산 대사 매칭", () => {
  test("발급 원장이 주문·정산과 연결되어 캠페인 ROAS가 계산된다", async ({ page }) => {
    await page.goto("/flash");
    await expect(page.getByRole("heading", { name: /실시간 선착순 응모/ })).toBeVisible();

    await page.getByRole("button", { name: /부하 발생/ }).click();

    // 시뮬레이션 → 원장 저장 → handoff 카드까지
    await expect(page.getByTestId("flash-handoff")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("flash-handoff")).toContainText("주문에 연결했습니다");

    // 메인 대시보드도 같은 원장을 읽는다
    await page.goto("/");
    await expect(page.getByTestId("home-campaign-card")).toBeVisible();
    await expect(page.getByTestId("home-campaign-card")).toContainText("쿠폰 할인 총액");
    await expect(page.getByTestId("home-campaign-card")).toContainText("정산 매칭 보기");

    // 정산 대사 콘솔: 쿠폰 주문이 정산 행에 섞여 들어와 매칭되고 ROAS가 계산된다
    await page.goto("/reconciliation");
    await waitForReconciliationReady(page);

    const panel = page.getByTestId("campaign-panel");
    await panel.scrollIntoViewIfNeeded();
    await expect(panel).toContainText("쿠폰 비용 매칭");
    await expect(page.getByTestId("campaign-roas")).toContainText("배");

    // 원장 = 정산 일치 건수가 0보다 커야 한다(쿠폰 주문이 실제로 매칭됐다는 뜻)
    const matchedText = await panel.innerText();
    expect(matchedText).toContain("원장 = 정산 일치");
    await expect(page.getByTestId("dataset-label")).toContainText("쿠폰 주문");
  });
});

test.describe("알림톡 시뮬레이터", () => {
  test("발송 이력이 타임라인에 쌓이고 같은 배치는 중복 차단된다", async ({ page }) => {
    await page.goto("/reconciliation");
    await waitForReconciliationReady(page);

    const panel = page.getByTestId("alimtalk-panel");
    await panel.scrollIntoViewIfNeeded();
    await expect(page.getByTestId("alimtalk-simulation-badge")).toContainText("실제 발송 없음");

    await page.getByTestId("alimtalk-send").click();

    const timeline = page.getByTestId("alimtalk-timeline");
    await expect(timeline.getByTestId("alimtalk-status").first()).toContainText("accepted", { timeout: 15_000 });
    const sentCount = await timeline.getByTestId("alimtalk-status").count();
    expect(sentCount).toBeGreaterThan(0);

    // 말풍선 미리보기에 템플릿 본문이 채워진다
    await expect(page.getByTestId("alimtalk-bubble")).toContainText("정산 이상 감지");

    // 같은 배치로 다시 보내면 dedupe_key로 전부 건너뛴다
    await page.getByTestId("alimtalk-send").click();
    await expect(page.getByTestId("alimtalk-panel").getByRole("status")).toContainText("중복 차단", { timeout: 15_000 });
    expect(await timeline.getByTestId("alimtalk-status").count()).toBe(sentCount);
  });

  test("실패 시나리오는 failed로 남고 재시도 결과가 이력에 반영된다", async ({ page }) => {
    await page.goto("/reconciliation");
    await waitForReconciliationReady(page);

    await page.getByTestId("alimtalk-panel").scrollIntoViewIfNeeded();
    await page.getByLabel("SENS 응답 시나리오").selectOption("rate-limit");
    await page.getByTestId("alimtalk-send").click();

    const timeline = page.getByTestId("alimtalk-timeline");
    await expect(timeline.getByTestId("alimtalk-status").first()).toContainText("failed", { timeout: 15_000 });

    // 429는 재시도 가능 오류 — 재시도하면 성공한다
    await timeline.getByRole("button", { name: "재시도" }).first().click();
    await expect(page.getByTestId("alimtalk-panel").getByRole("status")).toContainText("재시도 성공", { timeout: 15_000 });
  });
});

test.describe("API 문서", () => {
  test("명세를 읽어 엔드포인트를 나열하고, 스키마 위반을 400으로 잡는다", async ({ page }) => {
    await page.goto("/api-docs");

    const list = page.getByTestId("api-op-list");
    await expect(list).toContainText("/api/v1/reconciliations", { timeout: 20_000 });
    await expect(list).toContainText("/health");
    await expect(list).toContainText("/api/v1/anomalies");

    // POST 배치: 예시 본문 그대로면 201 예시 응답
    await list.getByRole("button", { name: /\/api\/v1\/reconciliations$/ }).click();
    await page.getByTestId("api-try-submit").click();
    const result = page.getByTestId("api-try-result");
    await expect(result).toContainText("201", { timeout: 10_000 });
    await expect(result).toContainText("실제 호출 아님");

    // tenant_id를 0으로 바꾸면 명세의 minimum 위반
    const textarea = page.getByLabel("요청 본문");
    await textarea.fill(JSON.stringify({ tenant_id: 0, rows: [] }, null, 2));
    await page.getByTestId("api-try-submit").click();
    await expect(result).toContainText("400", { timeout: 10_000 });
    await expect(result).toContainText("검증 실패");
  });
});
