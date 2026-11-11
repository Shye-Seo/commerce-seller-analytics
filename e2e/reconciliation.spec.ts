import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * 정산 대사 콘솔 E2E
 * ------------------
 * 단위 테스트는 엔진(금액 계산)을 고정한다. 이 스펙은 **브라우저에서만 드러나는 것**을 검증한다.
 *
 *   1. 파일 업로드 → Web Worker 파싱 → 대사 → 가상화 테이블 렌더링이 실제로 이어지는가
 *   2. 필터가 화면의 행 집합을 바꾸고, 그 행들이 정말 그 원인인가
 *   3. 소명 리포트 다운로드가 브라우저 다운로드로 도달하는가(파일명·본문 헤더)
 *   4. 마켓 API 탭의 샌드박스 수집이 같은 대사 파이프라인으로 결과를 내는가
 *
 * 픽스처는 앱 코드로 만들지 않고 여기서 직접 CSV를 쓴다. 앱의 직렬화기를 그대로 쓰면
 * "쓰는 쪽과 읽는 쪽이 같은 버그"를 못 잡는다. 외부에서 온 정산서를 흉내 내는 것이 목적이다.
 */

const HEADER = [
  "주문번호",
  "채널",
  "주문일",
  "상품명",
  "SKU",
  "수량",
  "결제금액",
  "마켓수수료",
  "배송비차감액",
  "반품비",
  "실정산액",
  "계약수수료율",
  "매입원가",
  "실배송원가",
  "주문상태",
].join(",");

const FEE_RATE = { smartstore: 3.63, coupang: 10.8 } as const;
const ROW_COUNT = 240;

/** 결정론적 정산서 픽스처. 이상 징후를 알려진 비율로 심는다(기대 건수를 스펙에서 계산할 수 있다). */
function buildSettlementCsv(): { csv: string; feeOvercharge: number; returns: number; shortfalls: number } {
  const lines: string[] = [HEADER];
  let feeOvercharge = 0;
  let returns = 0;
  let shortfalls = 0;

  for (let index = 0; index < ROW_COUNT; index += 1) {
    const channel = index % 2 === 0 ? "smartstore" : "coupang";
    const rate = FEE_RATE[channel];
    const quantity = index % 5 === 0 ? 2 : 1;
    const paidAmount = 9_900 + (index % 17) * 1_000;
    const revenue = paidAmount;
    let commission = Math.round((revenue * rate) / 100);
    const shippingDeduction = channel === "smartstore" ? 3_000 : 0;
    let returnFee = 0;
    let status = "배송완료";

    // 12건마다 수수료 20% 초과 청구
    if (index % 12 === 3) {
      commission += Math.max(120, Math.round(commission * 0.2));
      feeOvercharge += 1;
    }
    // 15건마다 반품비를 왕복 기준액의 1.6배로 중복 차감
    if (index % 15 === 7) {
      status = "반품완료";
      returnFee = channel === "smartstore" ? 8_000 : 8_960;
      returns += 1;
    }
    let settledAmount = (status === "반품완료" ? 0 : revenue) - commission - shippingDeduction - returnFee;

    // 18건마다 원인 미상 정산 부족
    if (index % 18 === 11) {
      settledAmount -= 2_400;
      shortfalls += 1;
    }

    lines.push(
      [
        `${channel === "smartstore" ? "SS" : "CP"}2026${String(index).padStart(8, "0")}`,
        channel,
        `2026-10-${String((index % 28) + 1).padStart(2, "0")}`,
        `픽스처 상품 ${index % 7}`,
        `FX-SKU-${String(index % 7).padStart(2, "0")}`,
        quantity,
        paidAmount,
        commission,
        shippingDeduction,
        returnFee,
        settledAmount,
        rate,
        4_000 + (index % 5) * 500,
        2_800,
        status,
      ].join(","),
    );
  }

  return { csv: `\uFEFF${lines.join("\r\n")}`, feeOvercharge, returns, shortfalls, };
}

let fixturePath = "";

test.beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "csa-e2e-"));
  fixturePath = join(dir, "settlement-fixture.csv");
  writeFileSync(fixturePath, buildSettlementCsv().csv, "utf8");
});

/** 초기 데모 원장(2만 건)이 대사를 마칠 때까지 기다린다. 그 전에는 업로더가 비활성이다. */
async function waitForDemoReady(page: Page): Promise<void> {
  await page.goto("/reconciliation");
  await expect(page.getByTestId("kpi-matched-rate")).toContainText("%", { timeout: 45_000 });
  await expect(page.getByTestId("settlement-file-input")).toBeEnabled({ timeout: 45_000 });
}

async function rowCount(page: Page): Promise<number> {
  const attribute = await page.getByTestId("vtable-scroll").getAttribute("data-row-count");
  return Number(attribute ?? "-1");
}

test.describe("정산서 파일 업로드 → 대사", () => {
  test("업로드한 정산서가 파싱·대사되어 가상화 테이블과 KPI에 반영된다", async ({ page }) => {
    await waitForDemoReady(page);

    await page.getByTestId("settlement-file-input").setInputFiles(fixturePath);

    // 파싱 완료 문구는 업로더가 소유한다(진행률 → 완료)
    await expect(page.getByText(`${ROW_COUNT}행 파싱 완료`)).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("dataset-label")).toContainText("settlement-fixture.csv");
    await expect(page.getByTestId("dataset-label")).toBeVisible();

    await expect.poll(() => rowCount(page), { timeout: 30_000 }).toBe(ROW_COUNT);
    await expect(page.getByTestId("vtable-total")).toContainText(`${ROW_COUNT}행`);
    await expect(page.getByTestId("kpi-matched-rate")).toContainText("%");

    // 정상 대사율이 100%일 수는 없다 — 이상을 심었으므로.
    const matched = await page.getByTestId("kpi-matched-rate").locator("p").nth(1).innerText();
    expect(matched).toMatch(/%$/);
    expect(matched).not.toBe("100.0%");
    await expect(page.getByText("Data pipeline")).toBeVisible();
  });

  test("이상 필터를 누르면 해당 원인의 행만 남는다", async ({ page }) => {
    await waitForDemoReady(page);
    await page.getByTestId("settlement-file-input").setInputFiles(fixturePath);
    await expect.poll(() => rowCount(page), { timeout: 45_000 }).toBe(ROW_COUNT);

    const feeButton = page.getByTestId("vtable-filter-fee");
    await expect(feeButton).toHaveAttribute("aria-pressed", "false");
    await feeButton.click();
    await expect(feeButton).toHaveAttribute("aria-pressed", "true");

    await expect.poll(() => rowCount(page), { timeout: 15_000 }).toBeGreaterThan(0);
    const filtered = await rowCount(page);
    expect(filtered).toBeLessThan(ROW_COUNT);

    // 보이는 행의 상태 배지에 '정상'이 없어야 필터가 실제로 걸린 것이다.
    const badges = await page.locator('[data-testid="vtable-scroll"] tbody tr td:first-child span').allInnerTexts();
    expect(badges.length).toBeGreaterThan(0);
    expect(badges.some((text) => text.includes("정상"))).toBe(false);

    // 전체로 돌아오면 행 집합이 복원된다
    await page.getByTestId("vtable-filter-all").click();
    await expect.poll(() => rowCount(page), { timeout: 15_000 }).toBe(ROW_COUNT);
  });

  test("소명 리포트 CSV를 내려받으면 마켓 접수 양식 헤더가 들어 있다", async ({ page }) => {
    await waitForDemoReady(page);
    await page.getByTestId("settlement-file-input").setInputFiles(fixturePath);
    await expect.poll(() => rowCount(page), { timeout: 45_000 }).toBe(ROW_COUNT);

    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("claim-csv").click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^소명요청_스마트스토어_\d{4}-\d{2}-\d{2}_\d+건\.csv$/);

    const path = await download.path();
    expect(path).toBeTruthy();
    const content = readFileSync(path as string, "utf8");
    expect(content).toContain("문의유형");
    expect(content).toContain("주문번호");
    expect(content).toContain("차액(환불요청)");
    expect(content.split(/\r?\n/).length).toBeGreaterThan(1);
  });
});

test.describe("마켓 API 자동 수집", () => {
  test("샌드박스 수집이 대사까지 이어져 화면에 반영된다", async ({ page }) => {
    await waitForDemoReady(page);

    await page.getByTestId("intake-tab-api").click();
    await expect(page.getByTestId("market-api-panel")).toBeVisible();
    await expect(page.getByTestId("api-mode-badge")).toContainText("샌드박스");

    // 샌드박스는 예시 키로 동작하므로 자격 증명 입력 없이 진행된다(실연동은 키가 필수)
    await page.getByTestId("api-collect").click();

    await expect(page.getByTestId("api-progress")).toBeVisible();
    await expect(page.getByTestId("api-result")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("api-status")).toContainText("대사 완료");

    await expect(page.getByTestId("dataset-label")).toContainText("API");
    await expect.poll(() => rowCount(page), { timeout: 30_000 }).toBe(1_200);
    await expect(page.getByTestId("vtable-total")).toContainText("1,200행");
    await expect(page.getByTestId("api-error")).toHaveCount(0);
  });

  test("연결 테스트는 인증과 첫 페이지를 확인하고 결과를 보여 준다", async ({ page }) => {
    await waitForDemoReady(page);
    await page.getByTestId("intake-tab-api").click();
    await page.getByTestId("api-probe").click();
    await expect(page.getByTestId("api-probe-result")).toContainText("연결 성공", { timeout: 45_000 });
  });
});
