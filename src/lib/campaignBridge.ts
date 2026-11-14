/**
 * 쿠폰 캠페인 ↔ 정산 대사 연결 (Campaign Bridge)
 *
 * 왜 이 모듈이 필요한가
 * ---------------------
 * 선착순 쿠폰 콘솔(`/flash`)은 "발급이 정확한가"를 보여 주고, 정산 대사 콘솔(`/reconciliation`)은
 * "마켓이 정산을 맞게 했는가"를 보여 준다. 그런데 셀러가 실제로 알고 싶은 것은 그 사이의 한 가지다.
 *
 *     쿠폰으로 할인해 준 돈이 실제 주문·정산에서 그대로 반영되었고, 그 캠페인이 남는 장사였나?
 *
 * 두 화면이 서로 다른 원장을 들고 있으면 이 질문에 답할 수 없다. 그래서 이 모듈이
 * **쿠폰 원장(발급·사용)** 과 **정산서 행(주문번호)** 을 주문번호 하나로 묶고,
 * 할인액을 반영한 순마진과 캠페인별 ROAS를 계산한다.
 *
 * 계산 규칙
 * ---------
 * - 주문의 `listAmount`(쿠폰 적용 전 금액)에서 `discountAmount`를 빼면 소비자 결제액(`paidAmount`)이다.
 *   마켓 정산서의 결제금액도 할인 반영 후 금액이므로, 정산서에서 역산한 할인액
 *   `listAmount - paidAmount`는 쿠폰 원장의 할인액과 같아야 한다. 다르면 그 차액이
 *   "셀러가 더 낸 돈" 또는 "우리가 더 낸 돈"이다.
 * - 순마진은 `실정산액 - 매입원가 - 실배송원가`다. 결제액이 이미 할인 반영 후이므로
 *   이 순마진은 **쿠폰 비용이 차감된 뒤의 값**이다. 할인 반영 전 마진과의 차이가 쿠폰 비용이다.
 * - ROAS는 `귀속 매출 ÷ 미디어 비용`이다. 미디어 비용은 "우리가 실제로 부담한 쿠폰 비용"과
 *   "집행 광고비"의 합이다. 제휴사(partner) 부담 쿠폰은 우리 비용이 아니므로 분자에서 빼고
 *   별도로 표시한다. 분모가 0이면 ROAS는 null이다(0으로 나눈 값을 0으로 적지 않는다).
 *
 * 금액은 전부 원 단위 정수이며 반올림은 `roundWon`(floor(x+0.5)) 하나만 쓴다.
 */

import {
  discountFor,
  roundWon,
  splitBorne,
  toRate,
  type CampaignSpec,
  type CouponTemplateSpec,
  type FundingParty,
  type LedgerEntry,
} from "./flashCouponEngine";
import {
  CHANNEL_CONTRACTS,
  type ContractTerms,
  type MarketChannel,
  type ReconciledRow,
  type SettlementRow,
} from "./reconciliationEngine";

/* ─────────────────────────────────────────────────────────────
 * 1. 주문 연결
 * ───────────────────────────────────────────────────────────── */

/** 쿠폰이 실제로 쓰인 주문. 정산서의 주문번호와 1:1로 매칭되는 키를 갖는다. */
export interface MarketingOrder {
  /** 마켓 주문번호 — 정산서 행과 매칭하는 유일한 키 */
  orderId: string;
  entryId: number;
  campaignId: number;
  campaignCode: string;
  campaignName: string;
  templateId: number;
  templateName: string;
  /** 화면 표시용 마스킹 코드(원문은 원장에 없다) */
  maskedCode: string;
  channel: MarketChannel;
  /** 쿠폰 적용 전 주문금액 */
  listAmount: number;
  /** 쿠폰 할인액 */
  discountAmount: number;
  /** 소비자 결제액 = listAmount - discountAmount */
  paidAmount: number;
  fundedBy: FundingParty;
  orderedAt: number;
  /** KST 기준 주문일(YYYY-MM-DD) */
  orderDate: string;
  /** 귀속 정산 월(YYYY-MM) */
  settlementMonth: string;
}

export interface OrderLinkOptions {
  /** 발급 원장 중 실제 사용(주문 연결)로 이어지는 비율 */
  redemptionRate?: number;
  /** 결정적 난수 시드 */
  seed?: number;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ms → KST 날짜 문자열. 서버(Asia/Seoul) 시간대와 같은 기준을 쓴다. */
export function kstDate(ms: number): { date: string; month: string } {
  const shifted = new Date(ms + 9 * 60 * 60 * 1000);
  const iso = shifted.toISOString();
  return { date: iso.slice(0, 10), month: iso.slice(0, 7) };
}

function channelFor(index: number): MarketChannel {
  return index % 2 === 0 ? "smartstore" : "coupang";
}

function orderIdFor(channel: MarketChannel, orderedAt: number, entryId: number): string {
  const { date } = kstDate(orderedAt);
  const prefix = channel === "smartstore" ? "SS" : channel === "coupang" ? "CP" : "MK";
  return `${prefix}${date.replace(/-/g, "")}-${String(entryId).padStart(6, "0")}`;
}

/**
 * 발급 원장 → 주문 연결 후보.
 *
 * 실서비스에서는 "쿠폰 사용 → 주문 생성"이 마켓 웹훅/주문 API로 들어온다. 이 데모에는 그
 * 웹훅이 없으므로, 같은 입력이면 같은 주문이 나오도록 결정적 난수로 주문을 만든다.
 * 만들어진 주문은 콘솔에서 실제로 `reserve()`·`redeem()`을 호출해 원장 상태를 전이시킨 뒤
 * 저장한다 — 화면에 보이는 `REDEEMED`는 손으로 쓴 글자가 아니라 상태 머신을 통과한 결과다.
 */
export function buildMarketingOrders(
  ledger: readonly LedgerEntry[],
  templates: readonly CouponTemplateSpec[],
  campaigns: readonly CampaignSpec[],
  options: OrderLinkOptions = {},
): MarketingOrder[] {
  const redemptionRate = Math.min(1, Math.max(0, options.redemptionRate ?? 0.62));
  const random = mulberry32(options.seed ?? 20261120);
  const templateIndex = new Map(templates.map((template) => [template.id, template]));
  const campaignIndex = new Map(campaigns.map((campaign) => [campaign.id, campaign]));

  const orders: MarketingOrder[] = [];

  ledger.forEach((entry, index) => {
    // 취소·만료된 쿠폰은 주문에 쓰이지 않았다
    if (entry.status === "CANCELLED" || entry.status === "EXPIRED") return;

    const template = templateIndex.get(entry.templateId);
    const campaign = campaignIndex.get(entry.campaignId);
    if (!template || !campaign) return;

    // 결정적 사용률: 같은 시드·같은 원장이면 같은 주문 집합이 나온다
    if (random() > redemptionRate) return;

    const channel = channelFor(index);
    const spread = (entry.id % 5) * 4_000;
    const listAmount = Math.max(template.minOrderAmount, template.minOrderAmount + 1_000 + spread);
    const discountAmount = discountFor(template, listAmount);
    if (discountAmount <= 0) return;

    const orderedAt = entry.issuedAt + 3 * 60_000 + (entry.id % 17) * 60_000;
    const stamp = kstDate(orderedAt);

    orders.push({
      orderId: orderIdFor(channel, orderedAt, entry.id),
      entryId: entry.id,
      campaignId: campaign.id,
      campaignCode: campaign.code,
      campaignName: campaign.name,
      templateId: template.id,
      templateName: template.name,
      maskedCode: entry.maskedCode,
      channel,
      listAmount,
      discountAmount,
      paidAmount: listAmount - discountAmount,
      fundedBy: template.fundedBy,
      orderedAt,
      orderDate: stamp.date,
      settlementMonth: stamp.month,
    });
  });

  return orders;
}

/* ─────────────────────────────────────────────────────────────
 * 2. 주문 → 정산서 행
 * ───────────────────────────────────────────────────────────── */

/** 쿠폰 주문을 마켓 정산서 형식으로 만든다. 계약 조건대로 정산된 "정상" 행이다. */
export function buildSettlementRowsForOrders(
  orders: readonly MarketingOrder[],
  contracts: Record<MarketChannel, ContractTerms> = CHANNEL_CONTRACTS,
  options: { unitCostRate?: number; sellerShippingCost?: number } = {},
): SettlementRow[] {
  const unitCostRate = options.unitCostRate ?? 0.38;
  const sellerShippingCost = options.sellerShippingCost ?? 2_500;

  return orders.map((order) => {
    const contract = contracts[order.channel] ?? CHANNEL_CONTRACTS[order.channel];
    const commission = roundWon((order.paidAmount * contract.feeRate) / 100);
    const shippingDeduction = contract.outboundShipping;
    const settledAmount = order.paidAmount - commission - shippingDeduction;

    return {
      orderNo: order.orderId,
      channel: order.channel,
      orderDate: order.orderDate,
      productName: order.templateName,
      sku: `CPN-${order.templateId}`,
      quantity: 1,
      paidAmount: order.paidAmount,
      commission,
      shippingDeduction,
      returnFee: 0,
      settledAmount,
      contractFeeRate: contract.feeRate,
      unitCost: roundWon(order.listAmount * unitCostRate),
      sellerShippingCost,
      status: "배송완료",
    } satisfies SettlementRow;
  });
}

/* ─────────────────────────────────────────────────────────────
 * 3. 쿠폰 비용 매칭
 * ───────────────────────────────────────────────────────────── */

export type CouponMatchReason =
  | "MATCHED"
  | "MISSING_SETTLEMENT"
  | "DUPLICATE_SETTLEMENT"
  | "AMOUNT_MISMATCH"
  | "SELLER_OVERBORNE"
  | "PLATFORM_OVERBORNE";

export interface CouponMatchRow {
  orderId: string;
  entryId: number;
  campaignId: number;
  campaignName: string;
  templateName: string;
  maskedCode: string;
  fundedBy: FundingParty;
  /** 쿠폰 원장의 할인액 */
  ledgerDiscount: number;
  /** 정산서에서 역산한 실제 할인 차감액(listAmount - 결제금액) */
  settlementDeduction: number;
  /** 실제 - 원장 (양수면 셀러가 더 부담) */
  variance: number;
  status: "MATCHED" | "DISPUTED";
  reason: CouponMatchReason;
  detail: string;
  sellerBorne: number;
  platformBorne: number;
  partnerBorne: number;
  /** 셀러가 마켓에 돌려받아야 할 금액 */
  recoverable: number;
  /** 우리가 대신 부담하게 된 금액 */
  overborne: number;
  paidAmount: number;
  settledAmount: number;
  /** 쿠폰 비용이 반영된 뒤의 순마진(원) */
  netMargin: number;
  /** 쿠폰 비용 반영 전 순마진(원) = netMargin + 할인액 */
  netMarginBeforeCoupon: number;
}

export interface CouponMatchReport {
  rows: CouponMatchRow[];
  ordersLinked: number;
  matched: number;
  disputed: number;
  missingSettlement: number;
  ledgerDiscount: number;
  settlementDeduction: number;
  sellerBorne: number;
  platformBorne: number;
  partnerBorne: number;
  recoverable: number;
  overborne: number;
}

/** 금액을 1,000원 단위로 읽기 쉽게. 안내 문구용이므로 정확한 값은 옆 숫자를 쓴다. */
function won(value: number): string {
  return `${roundWon(value).toLocaleString("ko-KR")}원`;
}

/**
 * 쿠폰 원장 ↔ 대사된 정산 행 매칭.
 *
 * `rows`는 어떤 입구(데모 생성·파일 업로드·마켓 API)로 들어왔든 대사가 끝난 행 집합이다.
 * 주문번호가 같은 행을 찾아 할인 차감액을 역산하고, 원장 할인액과 비교한다.
 */
export function matchCouponSettlement(
  orders: readonly MarketingOrder[],
  rows: readonly ReconciledRow[],
): CouponMatchReport {
  const byOrderNo = new Map<string, ReconciledRow[]>();
  for (const row of rows) {
    const bucket = byOrderNo.get(row.row.orderNo);
    if (bucket) bucket.push(row);
    else byOrderNo.set(row.row.orderNo, [row]);
  }

  const result: CouponMatchRow[] = [];
  let ledgerDiscount = 0;
  let settlementDeduction = 0;
  let sellerBorne = 0;
  let platformBorne = 0;
  let partnerBorne = 0;
  let recoverable = 0;
  let overborne = 0;
  let missingSettlement = 0;

  for (const order of orders) {
    const matches = byOrderNo.get(order.orderId) ?? [];
    const borne = splitBorne(order.fundedBy, order.discountAmount);

    if (matches.length === 0) {
      missingSettlement += 1;
      result.push({
        orderId: order.orderId,
        entryId: order.entryId,
        campaignId: order.campaignId,
        campaignName: order.campaignName,
        templateName: order.templateName,
        maskedCode: order.maskedCode,
        fundedBy: order.fundedBy,
        ledgerDiscount: order.discountAmount,
        settlementDeduction: 0,
        variance: -order.discountAmount,
        status: "DISPUTED",
        reason: "MISSING_SETTLEMENT",
        detail: "쿠폰이 쓰인 주문이 정산서에 없습니다. 마켓 주문 수집 누락인지 확인해야 합니다.",
        sellerBorne: 0,
        platformBorne: 0,
        partnerBorne: 0,
        recoverable: 0,
        overborne: 0,
        paidAmount: 0,
        settledAmount: 0,
        netMargin: 0,
        netMarginBeforeCoupon: 0,
      });
      continue;
    }

    const target = matches[0] as ReconciledRow;
    const duplicate = matches.length > 1;
    const deduction = Math.max(0, order.listAmount - target.row.paidAmount);
    const variance = deduction - order.discountAmount;

    let reason: CouponMatchReason;
    let detail: string;
    let rowRecoverable = 0;
    let rowOverborne = 0;

    if (duplicate) {
      reason = "DUPLICATE_SETTLEMENT";
      detail = `같은 주문이 정산서에 ${matches.length}번 나타났습니다. 할인액이 중복 차감됐는지 확인해야 합니다.`;
      rowRecoverable = order.discountAmount * (matches.length - 1);
    } else if (variance > 0) {
      reason = order.fundedBy === "SELLER" ? "SELLER_OVERBORNE" : "SELLER_OVERBORNE";
      detail =
        order.fundedBy === "SELLER"
          ? `원장 할인액 ${won(order.discountAmount)}보다 ${won(variance)} 더 차감됐습니다.`
          : `${order.fundedBy === "PARTNER" ? "제휴사" : "플랫폼"} 부담 쿠폰인데 셀러 부담으로 ${won(variance)} 더 차감됐습니다.`;
      rowRecoverable = variance;
    } else if (variance < 0) {
      reason = "PLATFORM_OVERBORNE";
      detail = `정산서 할인 차감액이 원장보다 ${won(-variance)} 적습니다. 차액은 우리가 부담하게 됩니다.`;
      rowOverborne = -variance;
    } else if (target.row.status === "취소" || target.row.status === "반품완료") {
      reason = "AMOUNT_MISMATCH";
      detail = "반품·취소된 주문입니다. 할인액은 일치하지만 매출 인식이 0이므로 마진에서 제외합니다.";
    } else {
      reason = "MATCHED";
      detail = "원장 할인액과 정산서 차감액이 일치합니다.";
    }

    const disputed = reason !== "MATCHED";
    ledgerDiscount += order.discountAmount;
    settlementDeduction += deduction;
    sellerBorne += borne.seller;
    platformBorne += borne.platform;
    partnerBorne += borne.partner;
    recoverable += rowRecoverable;
    overborne += rowOverborne;

    result.push({
      orderId: order.orderId,
      entryId: order.entryId,
      campaignId: order.campaignId,
      campaignName: order.campaignName,
      templateName: order.templateName,
      maskedCode: order.maskedCode,
      fundedBy: order.fundedBy,
      ledgerDiscount: order.discountAmount,
      settlementDeduction: deduction,
      variance,
      status: disputed ? "DISPUTED" : "MATCHED",
      reason,
      detail,
      sellerBorne: borne.seller,
      platformBorne: borne.platform,
      partnerBorne: borne.partner,
      recoverable: rowRecoverable,
      overborne: rowOverborne,
      paidAmount: target.row.paidAmount,
      settledAmount: target.actualSettlement,
      netMargin: target.netMargin,
      netMarginBeforeCoupon: target.netMargin + order.discountAmount,
    });
  }

  return {
    rows: result,
    ordersLinked: orders.length,
    matched: result.filter((row) => row.status === "MATCHED").length,
    disputed: result.filter((row) => row.status === "DISPUTED").length,
    missingSettlement,
    ledgerDiscount,
    settlementDeduction,
    sellerBorne,
    platformBorne,
    partnerBorne,
    recoverable,
    overborne,
  };
}

/* ─────────────────────────────────────────────────────────────
 * 4. 캠페인 성과(순마진·ROAS)
 * ───────────────────────────────────────────────────────────── */

export interface TemplatePerformance {
  templateId: number;
  templateName: string;
  orders: number;
  discount: number;
  revenue: number;
  netMargin: number;
}

export interface CampaignPerformance {
  campaignId: number;
  campaignCode: string;
  campaignName: string;
  /** 정산서와 매칭된 주문 수 */
  orders: number;
  /** 발급된 쿠폰 중 주문으로 이어진 수 */
  linkedOrders: number;
  /** 쿠폰 할인 총액(부담 주체 무관) */
  couponDiscount: number;
  /** 우리(셀러·플랫폼) 부담 쿠폰 비용 */
  ourCouponCost: number;
  /** 제휴사가 부담한 쿠폰 비용 */
  partnerCost: number;
  /** 집행 광고비 */
  adSpend: number;
  /** 미디어 비용 = 우리 쿠폰 비용 + 광고비 (ROAS 분모) */
  mediaCost: number;
  /** 귀속 매출 = 결제금액 합 */
  revenue: number;
  /** 실정산액 합 */
  settledRevenue: number;
  /** 쿠폰 반영 전 순마진 */
  netMarginBeforeCoupon: number;
  /** 쿠폰 반영 후 순마진(실제) */
  netMargin: number;
  /** 쿠폰 반영 후 마진율(%) = 순마진 / 매출 */
  netMarginRate: number;
  /** 광고비까지 차감한 기여이익 = 순마진 - 광고비 */
  contributionAfterAdSpend: number;
  /** ROAS = 귀속 매출 / 미디어 비용. 분모가 0이면 null */
  roas: number | null;
  /** 쿠폰 예산 소진율(%) */
  budgetUsedRate: number;
  /** 쿠폰 비용 회수 지수 = 순마진 / 미디어 비용 */
  marginToCost: number | null;
  byTemplate: TemplatePerformance[];
}

export interface CampaignPerformanceSummary {
  campaigns: CampaignPerformance[];
  totals: Omit<CampaignPerformance, "byTemplate" | "campaignCode" | "campaignName" | "budgetUsedRate" | "linkedOrders">;
  /** 매칭 결과 요약을 그대로 들고 다닌다(패널이 별도 계산을 하지 않도록) */
  match: CouponMatchReport;
}

export interface CampaignLedgerSummary {
  issued: number;
  used: number;
  couponDiscount: number;
  ourCouponCost: number;
  partnerCost: number;
  /** 사용 주문의 결제금액 합(정산 전 원장 기준) */
  revenue: number;
  adSpend: number;
  /** 원장 기준 추정 ROAS. 정산 매칭 전 값이므로 화면에서 "추정"으로 표기한다 */
  estimatedRoas: number | null;
  campaigns: Array<{
    campaignId: number;
    campaignName: string;
    issued: number;
    used: number;
    discount: number;
    revenue: number;
    adSpend: number;
    estimatedRoas: number | null;
  }>;
}

/**
 * 정산 대사 전, 쿠폰 원장만으로 보는 캠페인 현황.
 *
 * 메인 대시보드는 정산서를 들고 있지 않다. 그래서 여기서는 "발급·사용 원장 기준" 숫자만 낸다.
 * ROAS도 결제금액 기준 추정치이며, 확정치는 정산 대사 콘솔에서 주문별 매칭을 거친 값이다.
 */
export function summarizeCampaignLedger(input: {
  ledger: readonly LedgerEntry[];
  orders: readonly MarketingOrder[];
  campaigns: readonly CampaignSpec[];
  campaignSpend?: Record<number, number>;
}): CampaignLedgerSummary {
  const spendMap = input.campaignSpend ?? {};
  const active = input.ledger.filter((entry) => entry.status !== "CANCELLED" && entry.status !== "EXPIRED");

  const buckets = new Map<number, CampaignLedgerSummary["campaigns"][number]>();
  const ensure = (campaignId: number) => {
    const existing = buckets.get(campaignId);
    if (existing) return existing;
    const spec = input.campaigns.find((campaign) => campaign.id === campaignId);
    const created = {
      campaignId,
      campaignName: spec?.name ?? `캠페인 #${campaignId}`,
      issued: 0,
      used: 0,
      discount: 0,
      revenue: 0,
      adSpend: spendMap[campaignId] ?? 0,
      estimatedRoas: null as number | null,
    };
    buckets.set(campaignId, created);
    return created;
  };

  const ourCostByCampaign = new Map<number, number>();

  for (const entry of active) ensure(entry.campaignId).issued += 1;
  for (const order of input.orders) {
    const bucket = ensure(order.campaignId);
    bucket.used += 1;
    bucket.discount += order.discountAmount;
    bucket.revenue += order.paidAmount;
    const borne = splitBorne(order.fundedBy, order.discountAmount);
    ourCostByCampaign.set(order.campaignId, (ourCostByCampaign.get(order.campaignId) ?? 0) + borne.seller + borne.platform);
  }

  const campaigns = [...buckets.values()].map((bucket) => {
    const cost = bucket.adSpend + (ourCostByCampaign.get(bucket.campaignId) ?? 0);
    return {
      ...bucket,
      estimatedRoas: cost > 0 ? Math.round((bucket.revenue / cost) * 100) / 100 : null,
    };
  });

  const totals = campaigns.reduce(
    (acc, campaign) => ({
      issued: acc.issued + campaign.issued,
      used: acc.used + campaign.used,
      discount: acc.discount + campaign.discount,
      revenue: acc.revenue + campaign.revenue,
      adSpend: acc.adSpend + campaign.adSpend,
    }),
    { issued: 0, used: 0, discount: 0, revenue: 0, adSpend: 0 },
  );

  // 우리 부담 비율은 부담 주체별로 정확히 계산한다(추정 ROAS와 달리 이 값은 원장 값 그대로다).
  let ourCouponCost = 0;
  let partnerCost = 0;
  for (const order of input.orders) {
    const borne = splitBorne(order.fundedBy, order.discountAmount);
    ourCouponCost += borne.seller + borne.platform;
    partnerCost += borne.partner;
  }

  const totalCost = totals.adSpend + ourCouponCost;

  return {
    issued: totals.issued,
    used: totals.used,
    couponDiscount: totals.discount,
    ourCouponCost,
    partnerCost,
    revenue: totals.revenue,
    adSpend: totals.adSpend,
    estimatedRoas: totalCost > 0 ? Math.round((totals.revenue / totalCost) * 100) / 100 : null,
    campaigns,
  };
}

export interface CampaignPerformanceInput {
  orders: readonly MarketingOrder[];
  rows: readonly ReconciledRow[];
  campaigns: readonly CampaignSpec[];
  /** 캠페인별 집행 광고비(원) */
  campaignSpend?: Record<number, number>;
}

/**
 * 캠페인별 순마진·ROAS.
 *
 * 매칭되지 않은 쿠폰 주문(정산서 누락)은 매출·마진에 넣지 않는다. 대신 매칭 리포트에서
 * 별도로 보여 준다 — "정산이 안 들어온 주문"을 매출로 세면 캠페인이 좋아 보이기만 한다.
 */
export function summarizeCampaignPerformance(input: CampaignPerformanceInput): CampaignPerformanceSummary {
  const match = matchCouponSettlement(input.orders, input.rows);
  const spendMap = input.campaignSpend ?? {};
  const orderIndex = new Map(input.orders.map((order) => [order.orderId, order]));

  const buckets = new Map<number, CampaignPerformance & { templates: Map<number, TemplatePerformance> }>();

  const ensureBucket = (campaignId: number): CampaignPerformance & { templates: Map<number, TemplatePerformance> } => {
    const existing = buckets.get(campaignId);
    if (existing) return existing;

    const spec = input.campaigns.find((campaign) => campaign.id === campaignId);
    const created = {
      campaignId,
      campaignCode: spec?.code ?? `campaign-${campaignId}`,
      campaignName: spec?.name ?? `캠페인 #${campaignId}`,
      orders: 0,
      linkedOrders: 0,
      couponDiscount: 0,
      ourCouponCost: 0,
      partnerCost: 0,
      adSpend: spendMap[campaignId] ?? 0,
      mediaCost: 0,
      revenue: 0,
      settledRevenue: 0,
      netMarginBeforeCoupon: 0,
      netMargin: 0,
      netMarginRate: 0,
      contributionAfterAdSpend: 0,
      roas: null as number | null,
      budgetUsedRate: 0,
      marginToCost: null as number | null,
      byTemplate: [] as TemplatePerformance[],
      templates: new Map<number, TemplatePerformance>(),
    };
    buckets.set(campaignId, created);

    return created;
  };

  // 발급·연결된 캠페인은 주문이 하나도 매칭되지 않아도 목록에 남긴다(빈 캠페인도 보여야 한다).
  for (const order of input.orders) {
    const bucket = ensureBucket(order.campaignId);
    bucket.linkedOrders += 1;
  }
  for (const campaign of input.campaigns) ensureBucket(campaign.id);

  for (const row of match.rows) {
    if (row.reason === "MISSING_SETTLEMENT") continue;
    const order = orderIndex.get(row.orderId);
    if (!order) continue;

    const bucket = ensureBucket(row.campaignId);
    const templateEntry =
      bucket.templates.get(order.templateId) ??
      ({ templateId: order.templateId, templateName: order.templateName, orders: 0, discount: 0, revenue: 0, netMargin: 0 } satisfies TemplatePerformance);

    bucket.orders += 1;
    bucket.couponDiscount += row.ledgerDiscount;
    bucket.revenue += row.paidAmount;
    bucket.settledRevenue += row.settledAmount;
    bucket.netMargin += row.netMargin;
    bucket.netMarginBeforeCoupon += row.netMarginBeforeCoupon;
    bucket.ourCouponCost += row.sellerBorne + row.platformBorne;
    bucket.partnerCost += row.partnerBorne;

    templateEntry.orders += 1;
    templateEntry.discount += row.ledgerDiscount;
    templateEntry.revenue += row.paidAmount;
    templateEntry.netMargin += row.netMargin;
    bucket.templates.set(order.templateId, templateEntry);
  }

  const campaigns = [...buckets.values()].map((bucket) => {
    const mediaCost = bucket.ourCouponCost + bucket.adSpend;
    const spec = input.campaigns.find((campaign) => campaign.id === bucket.campaignId);
    const byTemplate = [...bucket.templates.values()].sort((a, b) => b.revenue - a.revenue);
    const { templates: _templates, ...rest } = bucket;

    return {
      ...rest,
      mediaCost,
      netMarginRate: toRate(bucket.netMargin, bucket.revenue),
      contributionAfterAdSpend: bucket.netMargin - bucket.adSpend,
      roas: mediaCost > 0 ? Math.round((bucket.revenue / mediaCost) * 100) / 100 : null,
      marginToCost: mediaCost > 0 ? Math.round((bucket.netMargin / mediaCost) * 100) / 100 : null,
      budgetUsedRate: spec && spec.rewardBudget > 0 ? toRate(bucket.couponDiscount, spec.rewardBudget) : 0,
      byTemplate,
    } satisfies CampaignPerformance;
  });

  const totals = campaigns.reduce(
    (acc, campaign) => ({
      campaignId: 0,
      orders: acc.orders + campaign.orders,
      couponDiscount: acc.couponDiscount + campaign.couponDiscount,
      ourCouponCost: acc.ourCouponCost + campaign.ourCouponCost,
      partnerCost: acc.partnerCost + campaign.partnerCost,
      adSpend: acc.adSpend + campaign.adSpend,
      mediaCost: acc.mediaCost + campaign.mediaCost,
      revenue: acc.revenue + campaign.revenue,
      settledRevenue: acc.settledRevenue + campaign.settledRevenue,
      netMarginBeforeCoupon: acc.netMarginBeforeCoupon + campaign.netMarginBeforeCoupon,
      netMargin: acc.netMargin + campaign.netMargin,
      netMarginRate: 0,
      contributionAfterAdSpend: acc.contributionAfterAdSpend + campaign.contributionAfterAdSpend,
      roas: null as number | null,
      marginToCost: null as number | null,
    }),
    {
      campaignId: 0,
      orders: 0,
      couponDiscount: 0,
      ourCouponCost: 0,
      partnerCost: 0,
      adSpend: 0,
      mediaCost: 0,
      revenue: 0,
      settledRevenue: 0,
      netMarginBeforeCoupon: 0,
      netMargin: 0,
      netMarginRate: 0,
      contributionAfterAdSpend: 0,
      roas: null as number | null,
      marginToCost: null as number | null,
    },
  );

  return {
    campaigns,
    totals: {
      ...totals,
      netMarginRate: toRate(totals.netMargin, totals.revenue),
      roas: totals.mediaCost > 0 ? Math.round((totals.revenue / totals.mediaCost) * 100) / 100 : null,
      marginToCost: totals.mediaCost > 0 ? Math.round((totals.netMargin / totals.mediaCost) * 100) / 100 : null,
    },
    match,
  };
}
