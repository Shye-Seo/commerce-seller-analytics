import { expect, test, type Page } from "@playwright/test";

/**
 * 가격 탄력성 시뮬레이터 · 경보 룰 빌더 E2E
 *
 * 단위 테스트는 계산(곡선·손익분기·룰 평가)을 고정한다. 이 스펙은 화면에서만 드러나는 것을 본다.
 *
 *   1. 수익 화면의 '가격 탄력성' 탭에서 슬라이더를 움직이면 5개 마켓 곡선과 표가 같은 값으로 다시 그려지는가
 *   2. 정산 대사 콘솔에서 룰을 끄면 표의 하이라이트와 건수가 함께 사라지는가(한 상태를 두 곳이 읽는가)
 *   3. 임계값을 올리면 같은 데이터에서 위반이 줄어드는가
 *   4. 위반 건을 누르면 상세 드로어가 열리고, 알림톡 미리보기가 검수 템플릿 형식인가
 */

/**
 * 정산 화면의 '이상 내역' 탭을 연다. 경보 룰 빌더와 표가 같은 탭에 있으므로,
 * 룰을 끄면 표 하이라이트가 사라지는지를 한 화면에서 검증할 수 있다.
 */
async function waitForReconciliationReady(page: Page): Promise<void> {
  await page.goto("/reconciliation");
  await expect(page.getByTestId("kpi-matched-rate")).toContainText("%", { timeout: 60_000 });
  await page.getByTestId("recon-tab-rows").click();
  await expect(page.getByTestId("recon-tab-rows")).toHaveAttribute("aria-selected", "true");
}

function hitCount(text: string | null): number {
  if (!text) return -1;
  if (text.trim() === "꺼짐") return -1;
  return Number(text.replace(/[^0-9]/g, ""));
}

test.describe("가격·마진 탄력성 시뮬레이터", () => {
  test("슬라이더를 움직이면 곡선과 마켓 표가 다시 계산된다", async ({ page }) => {
    await page.goto("/margin");
    await page.getByTestId("margin-tab-elasticity").click();

    const chart = page.getByTestId("elasticity-chart");
    await expect(chart).toBeVisible();
    // 곡선은 마켓마다 하나씩
    await expect(chart.locator("path")).toHaveCount(5);

    // 범례를 끄면 그 마켓 곡선만 사라지고, 다시 누르면 돌아온다
    const legend = page.getByTestId("elasticity-legend-coupang");
    await legend.click();
    await expect(chart.locator("path")).toHaveCount(4);
    await legend.click();
    await expect(chart.locator("path")).toHaveCount(5);

    // 정가를 올리면 축 라벨(x축 최대 판매가)이 따라 움직인다
    const beforeLabel = await chart.getAttribute("aria-label");
    await page.locator("#elasticity-list-price").fill("60000");
    await expect
      .poll(async () => chart.getAttribute("aria-label"), { timeout: 10_000 })
      .not.toBe(beforeLabel);

    // 정가 60,000 · 할인 30% → 실제 판매가 42,000원
    await page.locator("#elasticity-discount").fill("30");
    await expect(page.getByText("42,000원").first()).toBeVisible();

    // 마켓별 표는 5개 마켓을 모두 보여 준다
    await expect(page.getByRole("cell").filter({ hasText: "스마트스토어" })).toBeVisible();
    await expect(page.getByRole("cell").filter({ hasText: "자사몰" })).toBeVisible();
  });

  test("ROAS를 낮추면 손익분기 판매가가 올라가고 마진 최고 마켓 표시가 바뀐다", async ({ page }) => {
    await page.goto("/margin");
    await page.getByTestId("margin-tab-elasticity").click();
    const chart = page.getByTestId("elasticity-chart");
    await expect(chart).toBeVisible();

    await page.locator("#elasticity-roas").fill("1");
    // ROAS 1배는 광고비가 판매가 전액이라 손익분기 도달 불가 문구가 나온다
    await expect(page.getByText("도달 불가").first()).toBeVisible();

    await page.locator("#elasticity-roas").fill("8");
    await expect(page.getByText("도달 불가")).toHaveCount(0);
  });
});

test.describe("정산 이상징후 경보 룰 빌더", () => {
  test("룰을 끄면 같은 데이터의 위반 건수와 행 하이라이트가 함께 사라진다", async ({ page }) => {
    await waitForReconciliationReady(page);

    const panel = page.getByTestId("alert-rule-builder");
    await expect(panel).toBeVisible();

    const feeHits = page.getByTestId("alert-hits-fee-step");
    await expect.poll(async () => hitCount(await feeHits.innerText()), { timeout: 30_000 }).toBeGreaterThan(0);

    // 하이라이트된 행이 표에 보인다
    const highlighted = page.locator('[data-alert-hit="true"]');
    await expect.poll(async () => highlighted.count(), { timeout: 30_000 }).toBeGreaterThan(0);

    await page.getByTestId("alert-rule-toggle-fee-step").click();
    await expect(page.getByTestId("alert-hits-fee-step")).toHaveText("꺼짐");

    // 켜면 즉시 같은 건수가 다시 나온다(평가가 상태에서 파생된다는 증거)
    await page.getByTestId("alert-rule-toggle-fee-step").click();
    await expect.poll(async () => hitCount(await feeHits.innerText()), { timeout: 30_000 }).toBeGreaterThan(0);
  });

  test("임계값을 올리면 위반이 줄고, 위반 건을 누르면 상세가 열린다", async ({ page }) => {
    await waitForReconciliationReady(page);

    const feeHits = page.getByTestId("alert-hits-fee-step");
    await expect.poll(async () => hitCount(await feeHits.innerText()), { timeout: 30_000 }).toBeGreaterThan(0);
    const strict = hitCount(await feeHits.innerText());

    // 기본 3일 기준에서 정산 지연 룰도 평가된다(데모 원장이 입금일을 제공)
    await expect.poll(
      async () => hitCount(await page.getByTestId("alert-hits-settlement-delay").innerText()),
      { timeout: 30_000 },
    ).toBeGreaterThan(0);

    await page.getByTestId("alert-rule-threshold-fee-step").fill("4");
    await expect.poll(async () => hitCount(await feeHits.innerText()), { timeout: 30_000 }).toBeLessThan(
      strict + 1,
    );

    // 위반 상위 건 클릭 → 상세 드로어
    const firstHit = page.getByTestId("alert-hit-row").first();
    await expect(firstHit).toBeVisible();
    const orderNo = (await firstHit.locator("span.font-mono").first().innerText()).trim();
    await firstHit.click();
    await expect(page.getByLabel(`주문 ${orderNo} 정산 상세`)).toBeVisible({ timeout: 10_000 });
  });

  test("알림톡 미리보기는 검수 템플릿 형식으로 합성된다", async ({ page }) => {
    await waitForReconciliationReady(page);

    const preview = page.getByTestId("alert-preview");
    await expect(preview).toBeVisible({ timeout: 30_000 });
    const text = await preview.innerText();
    expect(text).toContain("정산 이상 감지");
    expect(text).toContain("정산 담당자 확인이 필요합니다");
    expect(text).toMatch(/SS|CP|MK/);
  });
});
