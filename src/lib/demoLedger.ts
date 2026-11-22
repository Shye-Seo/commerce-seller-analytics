import { DEMO_TENANTS } from "./multiTenantRbac";
import { reconcileSettlement, type ReconciliationResult } from "./reconciliationEngine";
import { generateSettlementRows } from "./settlementFixtures";

/**
 * 데모 원장 한 곳에서 만들기
 *
 * 개요의 지표와 정산 화면의 대사 결과가 **같은 숫자**여야 한다. 같은 원장을 각자 만들면
 * 행 수(2,000 vs 20,000)나 시드가 달라져, 개요에서 본 누수 금액과 정산 화면의 누수 금액이
 * 어긋난다. 그래서 데모 원장의 크기·테넌트 시드·대사 결과를 이 모듈 하나로 모으고, 결과는
 * 메모이즈해 빌드와 브라우저에서 한 번만 계산한다.
 *
 * 화면은 계산하지 않고 이 값을 보여 주기만 한다.
 */

/** 정산 화면이 처음 여는 원장 크기 */
export const DEMO_ROW_COUNT = 20_000;

/** 테넌트마다 다른 원장을 갖도록 시드를 파생한다(같은 테넌트면 항상 같은 원장). */
export function seedForTenant(tenantId: string): number {
  let sum = 20261111;
  for (let index = 0; index < tenantId.length; index += 1) sum = (sum * 31 + tenantId.charCodeAt(index)) >>> 0;
  return sum;
}

export const PRIMARY_TENANT_ID = DEMO_TENANTS[0]?.id ?? "tn-hq";

const cache = new Map<string, ReconciliationResult>();

/** 데모 원장(2만 건)을 대사한 결과. 첫 호출 때만 계산하고 이후는 같은 객체를 돌려준다. */
export function demoReconciliation(tenantId: string = PRIMARY_TENANT_ID): ReconciliationResult {
  const cached = cache.get(tenantId);
  if (cached) return cached;
  const result = reconcileSettlement(generateSettlementRows({ count: DEMO_ROW_COUNT, seed: seedForTenant(tenantId) }));
  cache.set(tenantId, result);
  return result;
}
