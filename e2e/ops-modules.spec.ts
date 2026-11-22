import { expect, test, type Page } from "@playwright/test";

/**
 * 실전 운영 모듈 3종 E2E
 *
 * 단위 테스트는 계산 규칙(수수료·ROAS·정산 기한·발주량)을 고정한다. 이 스펙은 그 계산이
 * **화면에서 입력에 반응하는지**를 본다. 세 화면 모두 "같은 데이터, 다른 조건"을 다루므로
 * 검증 포인트도 같다 — 조건을 바꾸면 숫자와 목록이 함께 바뀌고, 필터가 목록을 좁힌다.
 */

function wonToNumber(text: string): number {
  const digits = text.replace(/[^0-9-]/g, "");
  return Number(digits);
}

async function readNumber(page: Page, testId: string): Promise<number> {
  return wonToNumber(await page.getByTestId(testId).innerText());
}

test.describe("실수령 순수익 계산기", () => {
  test("카테고리를 바꾸면 수수료율과 통장 순수익이 함께 바뀐다", async ({ page }) => {
    await page.goto("/payout");
    await expect(page.getByRole("heading", { name: /통장에 실제로 남는 순수익/ })).toBeVisible();

    const initial = await readNumber(page, "payout-net-cash");
    expect(initial).not.toBe(0);

    // 생활·주방(4.5%) → 패션의류(6.0%)로 올리면 수수료가 늘어 순수익이 줄어야 한다.
    await page.getByTestId("payout-category-select").selectOption("fashion");
    await expect(page.getByTestId("payout-category-table")).toContainText("패션의류·잡화");
    const afterFashion = await readNumber(page, "payout-net-cash");
    expect(afterFashion).toBeLessThan(initial);

    // 디지털(3.63%)은 생활·주방보다 요율이 낮아 순수익이 더 커진다.
    await page.getByTestId("payout-category-select").selectOption("digital");
    const afterDigital = await readNumber(page, "payout-net-cash");
    expect(afterDigital).toBeGreaterThan(initial);
  });

  test("ROAS를 낮추면 광고비가 늘고 순수익이 줄며, 손익분기 ROAS가 표시된다", async ({ page }) => {
    await page.goto("/payout");

    const atDefault = await readNumber(page, "payout-net-cash");
    const adAtDefault = await readNumber(page, "payout-ad-spend");

    await page.getByTestId("payout-roas").fill("2");
    await expect(page.getByTestId("payout-roas-chart")).toBeVisible();
    const atTwo = await readNumber(page, "payout-net-cash");
    const adAtTwo = await readNumber(page, "payout-ad-spend");

    expect(adAtTwo).toBeGreaterThan(adAtDefault);
    expect(atTwo).toBeLessThan(atDefault);

    await expect(page.getByTestId("payout-breakeven-roas")).toContainText("배");

    // 광고를 끄면 광고비가 0이 되고 순수익이 최대가 된다.
    await page.getByTestId("payout-roas").fill("0");
    expect(await readNumber(page, "payout-ad-spend")).toBe(0);
    expect(await readNumber(page, "payout-net-cash")).toBeGreaterThan(atDefault);
  });

  test("정산서 금액을 넣으면 예상 정산금과의 차액을 대조한다", async ({ page }) => {
    await page.goto("/payout");

    const expectedText = await page.getByTestId("payout-expected-settlement").innerText();
    const expected = wonToNumber(expectedText);
    expect(expected).toBeGreaterThan(0);

    await page.getByTestId("payout-settlement").fill(String(expected - 300_000));
    const gap = page.getByTestId("payout-settlement-gap");
    await expect(gap).toContainText("정산서");
    await expect(gap).toContainText("예상 대비");
    // 30만 원 부족이므로 음수 차액이 표시된다.
    await expect(gap).toContainText("-300,000원");
  });
});

test.describe("정산 누락·지연 감지기", () => {
  test("위험·경고만 기본으로 보여 주고, 위험 필터는 위험 건만 남긴다", async ({ page }) => {
    await page.goto("/settlement-watch");
    await expect(page.getByRole("heading", { name: /아직 안 들어온 돈을 찾습니다/ })).toBeVisible();

    const riskCount = wonToNumber(await page.getByTestId("watch-risk-count").innerText());
    const warningCount = wonToNumber(await page.getByTestId("watch-warning-count").innerText());
    expect(riskCount).toBeGreaterThan(0);
    expect(warningCount).toBeGreaterThan(0);

    const rows = page.getByTestId("watch-row");
    await expect(rows).toHaveCount(riskCount + warningCount);

    await page.getByTestId("watch-filter-risk").click();
    await expect(rows).toHaveCount(riskCount);
    await expect(rows.first()).toContainText("위험");

    await page.getByTestId("watch-filter-warning").click();
    await expect(rows).toHaveCount(warningCount);

    // 전체로 넓히면 감시 대상 전부가 나온다.
    await page.getByTestId("watch-filter-all").click();
    expect(await rows.count()).toBeGreaterThan(riskCount + warningCount);
  });

  test("채널 필터와 운영 알림 문구가 같은 결과를 가리킨다", async ({ page }) => {
    await page.goto("/settlement-watch");
    await page.getByTestId("watch-filter-all").click();

    await page.getByTestId("watch-channel-select").selectOption("coupang");
    const rows = page.getByTestId("watch-row");
    const coupangRows = await rows.count();
    expect(coupangRows).toBeGreaterThan(0);
    for (let index = 0; index < Math.min(coupangRows, 5); index += 1) {
      await expect(rows.nth(index)).toContainText("쿠팡");
    }

    const preview = page.getByTestId("watch-alert-preview");
    await expect(preview).toContainText("정산 누락·지연");
    await expect(preview).toContainText("위험");
    await expect(preview).toContainText("최장 경과");
  });
});

test.describe("품절 임박 · 발주량 계산기", () => {
  test("수요 가정을 올리면 발주량이 늘고, 내리면 줄어든다", async ({ page }) => {
    await page.goto("/inventory");
    await expect(page.getByRole("heading", { name: /언제 끊기고 오늘 얼마를 발주할지/ })).toBeVisible();

    const critical = wonToNumber(await page.getByTestId("inventory-critical-count").innerText());
    expect(critical).toBeGreaterThan(0);

    const baseQty = wonToNumber(await page.getByTestId("inventory-total-qty").innerText());
    expect(baseQty).toBeGreaterThan(0);

    await page.getByTestId("inventory-demand-slider").fill("60");
    await expect(page.getByTestId("inventory-demand-value")).toContainText("+60%");
    const liftedQty = wonToNumber(await page.getByTestId("inventory-total-qty").innerText());
    expect(liftedQty).toBeGreaterThan(baseQty);

    await page.getByTestId("inventory-demand-slider").fill("-30");
    const reducedQty = wonToNumber(await page.getByTestId("inventory-total-qty").innerText());
    expect(reducedQty).toBeLessThan(baseQty);
  });

  test("안전재고를 늘리면 발주량이 늘고, 상태 필터가 목록을 좁힌다", async ({ page }) => {
    await page.goto("/inventory");

    const baseQty = wonToNumber(await page.getByTestId("inventory-total-qty").innerText());
    await page.getByTestId("inventory-safety-slider").fill("2");
    await expect(page.getByTestId("inventory-safety-value")).toContainText("2.0배");
    const saferQty = wonToNumber(await page.getByTestId("inventory-total-qty").innerText());
    expect(saferQty).toBeGreaterThan(baseQty);

    await page.getByTestId("inventory-filter-all").click();
    const allRows = await page.getByTestId("inventory-row").count();
    await page.getByTestId("inventory-filter-critical").click();
    const criticalRows = await page.getByTestId("inventory-row").count();
    expect(criticalRows).toBeLessThan(allRows);
    expect(criticalRows).toBeGreaterThan(0);
  });

  test("발주서 CSV를 내려받으면 헤더와 SKU가 들어 있다", async ({ page }) => {
    await page.goto("/inventory");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("inventory-csv").click(),
    ]);
    expect(download.suggestedFilename()).toContain("발주서");
    expect(download.suggestedFilename().endsWith(".csv")).toBe(true);

    const preview = await page.getByTestId("inventory-notice").innerText();
    expect(preview).toContain("품절 임박");
  });
});

test.describe("홈 운영 모듈 진입", () => {
  test("운영 모듈 목록의 각 행이 실제 화면으로 연결된다", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "운영 모듈" })).toBeVisible();

    await expect(page.getByTestId("ops-card-payout")).toContainText("월 순수익");
    await expect(page.getByTestId("ops-card-settlement-watch")).toContainText("미수 금액");
    await expect(page.getByTestId("ops-card-inventory")).toContainText("위험 SKU");

    await page.getByTestId("ops-card-inventory").click();
    await expect(page).toHaveURL(/\/inventory/);
    await expect(page.getByTestId("inventory-critical-count")).toBeVisible();
  });
});
