/**
 * 데모용 지난 2개월 요약 생성
 *
 * 저장된 이력이 없는 방문자에게 "전월 대비" 화면이 무엇을 보여 주는지 보여 주려면 지난달 데이터가
 * 필요하다. 이 모듈은 대사 엔진과 같은 고정 시드 생성기(`settlementFixtures`)로 지난 두 달 정산
 * 원장을 만들고, 실제 대사 엔진으로 계산한 요약을 스냅숏으로 돌려준다.
 *
 * **샘플이라는 사실을 값에 새긴다.** `source`가 `demo`이고 `label`에도 표시되므로, 화면과 저장소
 * 어디에서도 실제 정산 이력과 섞이지 않는다. 비교 계산은 같지만 출처 표시는 다르게 남긴다.
 */

import { reconcileSettlement } from "./reconciliationEngine";
import { generateSettlementRows, type AnomalyRates } from "./settlementFixtures";
import { shiftMonth } from "./periodComparison";
import { createSnapshot, type SettlementMonthSnapshot } from "./settlementHistory";

export interface DemoMonthPlan {
  /** 이번 달 기준 몇 개월 전인지 */
  offset: number;
  /** 화면에 붙는 설명 */
  label: string;
  anomalyRates: Partial<AnomalyRates>;
}

/**
 * 두 달의 서사: 두 달 전은 반품비 중복 차감이 많았고, 지난달은 수수료 초과 청구가 늘었다.
 * 두 달을 같은 비율로 만들면 비교 표가 "변화 없음"만 보여 주므로, 원인별로 방향을 다르게 둔다.
 */
export const DEMO_MONTH_PLANS: DemoMonthPlan[] = [
  {
    offset: -2,
    label: "데모 샘플 · 두 달 전(반품비 중복 차감이 많은 달)",
    anomalyRates: {
      feeOvercharge: 0.05,
      duplicateReturnFee: 0.09,
      returnFeeOnShipped: 0.05,
      shippingOvercharge: 0.05,
      feeUndercharge: 0.01,
      roundingLeak: 0.03,
      negativeMargin: 0.06,
    },
  },
  {
    offset: -1,
    label: "데모 샘플 · 지난달(수수료 초과 청구가 늘어난 달)",
    anomalyRates: {
      feeOvercharge: 0.12,
      duplicateReturnFee: 0.03,
      returnFeeOnShipped: 0.02,
      shippingOvercharge: 0.07,
      feeUndercharge: 0.01,
      roundingLeak: 0.03,
      negativeMargin: 0.06,
    },
  },
];

/** YYYY-MM의 말일 (YYYY-MM-DD) */
export function monthEndDate(month: string): string {
  const [yearText, monthText] = month.split("-");
  const year = Number(yearText);
  const monthOfYear = Number(monthText);
  const lastDay = new Date(year, monthOfYear, 0).getDate();
  return `${month}-${String(lastDay).padStart(2, "0")}`;
}

/** 달마다 다른 시드를 만들되, 같은 (테넌트, 달)이면 항상 같은 원장이 나오게 한다. */
function seedFor(tenantId: string, month: string, base: number): number {
  let sum = base;
  const source = `${tenantId}:${month}`;
  for (let index = 0; index < source.length; index += 1) {
    sum = (sum * 31 + source.charCodeAt(index)) >>> 0;
  }
  return sum;
}

/**
 * 지난 2개월 샘플 스냅숏.
 *
 * @param tenantId 대상 테넌트
 * @param currentMonth 이번 달(YYYY-MM). 데모 원장의 기준일과 같은 달을 넘긴다.
 */
export function buildDemoHistory(
  tenantId: string,
  currentMonth: string,
  options: { rows?: number } = {},
): SettlementMonthSnapshot[] {
  const rows = Math.max(120, Math.trunc(options.rows ?? 600));
  return DEMO_MONTH_PLANS.map((plan) => {
    const month = shiftMonth(currentMonth, plan.offset);
    const settlementRows = generateSettlementRows({
      count: rows,
      seed: seedFor(tenantId, month, 20261111),
      snapshotDate: monthEndDate(month),
      windowDays: 31,
      anomalyRates: plan.anomalyRates,
    });
    const result = reconcileSettlement(settlementRows);
    return createSnapshot({
      tenantId,
      month,
      summary: result.summary,
      source: "demo",
      label: plan.label,
    });
  });
}
