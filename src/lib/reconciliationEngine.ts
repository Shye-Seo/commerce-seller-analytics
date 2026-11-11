/**
 * 정산 대사(Reconciliation) · 이상 탐지 엔진
 *
 * 왜 이 모듈이 필요한가
 * ---------------------
 * 셀러가 실제로 돈을 잃는 지점은 "마진 계산"이 아니라 **정산서와 판매 원장이 어긋나는 순간**이다.
 * 마켓은 매월 정산서를 주고, 셀러는 그 숫자를 검증 없이 받아들인다. 문제는 다음 네 가지다.
 *
 *   1) 계약 수수료율(예: 3.63%)과 실제 청구 수수료율이 다른 경우
 *   2) 반품 왕복 배송비를 두 번 차감하는 경우
 *   3) 이미 배송 완료된 주문에 반품비를 붙이는 경우
 *   4) 정산액이 기대값보다 적게 들어오는 경우(설명되지 않는 차액)
 *
 * 이 엔진은 **계약 조건으로 기대 정산액을 다시 계산(re-derive)**하고, 실제 정산액과의 차액을
 * **원인별로 귀속(attribution)**시킨다. 단순히 "차액이 있다"가 아니라 "이 3,400원은 수수료
 * 과청구 1,900원 + 반품비 중복 1,500원"이라고 말할 수 있어야 셀러가 마켓에 이의를 제기할 수 있다.
 *
 * 설계 원칙
 * ---------
 * - **순수 함수**: 네트워크·시계·난수에 의존하지 않는다. 같은 입력이면 같은 출력이며, 그래서
 *   금액 근거를 그대로 테스트로 고정할 수 있다.
 * - **정수 원**: 모든 금액은 원 단위 정수로 반올림한다. 부동소수점 누적 오차가 대사 결과를
 *   흔들면 안 된다.
 * - **이중 계산 금지**: 행 단위 손실액은 `기대 정산액 - 실제 정산액`의 양수분(shortfall)을
 *   넘지 않는다. 원인별 금액은 그 shortfall을 나눠 갖는 구조이므로 합계가 부풀지 않는다.
 * - **설명 불가분 분리**: 원인으로 설명되지 않는 차액은 `UNATTRIBUTED_SHORTFALL`로 따로 남긴다.
 *   (반올림 10원 이하는 `ROUNDING_LEAK`으로 분류)
 */

/** 정산서를 발행한 마켓(판매 채널) */
export type MarketChannel = "smartstore" | "coupang" | "elevenst" | "gmarket";

/** 주문 상태 */
export type OrderStatus = "배송완료" | "반품완료" | "취소" | "교환완료";

/**
 * 정산서 한 행.
 *
 * 마켓 정산서에서 그대로 읽어 오는 값(결제금액·수수료·차감액·실정산액)과,
 * 셀러 원장에서 대조용으로 가져오는 값(원가·실배송원가)을 한 행에 모은다.
 * 두 출처를 섞지 않고 필드 이름으로 구분한다.
 */
export interface SettlementRow {
  /** 마켓 주문번호 */
  orderNo: string;
  /** 판매 채널 */
  channel: MarketChannel;
  /** 주문일 (YYYY-MM-DD) */
  orderDate: string;
  /** 판매 상품명 */
  productName: string;
  /** 셀러 내부 SKU */
  sku: string;
  /** 주문 수량 */
  quantity: number;
  /** 소비자 결제금액(원). 반품·취소 건도 "원래 결제됐던 금액"을 유지한다 */
  paidAmount: number;
  /** 마켓이 청구한 판매 수수료(원) */
  commission: number;
  /** 마켓이 추가로 차감한 배송비(원) */
  shippingDeduction: number;
  /** 마켓이 차감한 반품비(원) */
  returnFee: number;
  /** 마켓이 실제로 입금한 정산액(원). 차감 정산이면 음수 */
  settledAmount: number;
  /** 계약서상 판매 수수료율(%) */
  contractFeeRate: number;
  /** 상품 매입원가(원, 1개 기준) */
  unitCost: number;
  /** 셀러가 실제로 부담한 배송원가(원, 주문 단위) */
  sellerShippingCost: number;
  /** 주문 상태 */
  status: OrderStatus;
}

/** 마켓별 계약 조건 */
export interface ContractTerms {
  channel: MarketChannel;
  /** 계약 판매 수수료율(%) */
  feeRate: number;
  /** 계약상 셀러 부담 기본 배송비(원) */
  outboundShipping: number;
  /** 반품 왕복 배송비(원) */
  roundTripReturnFee: number;
}

/**
 * 마켓별 계약 프리셋.
 * 값은 공개된 수수료 정책을 참고한 데모 기준값이며, 실무에서는 계약서 값으로 대체한다.
 */
export const CHANNEL_CONTRACTS: Record<MarketChannel, ContractTerms> = {
  smartstore: { channel: "smartstore", feeRate: 3.63, outboundShipping: 3_000, roundTripReturnFee: 5_000 },
  coupang: { channel: "coupang", feeRate: 10.8, outboundShipping: 0, roundTripReturnFee: 5_600 },
  elevenst: { channel: "elevenst", feeRate: 9, outboundShipping: 3_000, roundTripReturnFee: 5_000 },
  gmarket: { channel: "gmarket", feeRate: 8.5, outboundShipping: 3_000, roundTripReturnFee: 5_000 },
};

/** 이상 탐지 코드 */
export type AnomalyCode =
  | "FEE_OVERCHARGE"
  | "FEE_UNDERCHARGE"
  | "FEE_ON_CANCELED_ORDER"
  | "SHIPPING_OVERCHARGE"
  | "RETURN_FEE_DOUBLE_CHARGED"
  | "RETURN_FEE_ON_SHIPPED_ORDER"
  | "SETTLEMENT_SHORTFALL"
  | "SETTLEMENT_SURPLUS"
  | "ROUNDING_LEAK"
  | "NEGATIVE_MARGIN"
  | "MISSING_LEDGER";

/** 이상 유형 메타데이터(라벨·분류·심각도) — UI와 리포트가 같은 문구를 쓰도록 한 곳에 모은다 */
export interface AnomalyMeta {
  label: string;
  category: "fee" | "logistics" | "settlement" | "margin" | "data";
  severity: "critical" | "warning" | "info";
  description: string;
}

export const ANOMALY_META: Record<AnomalyCode, AnomalyMeta> = {
  FEE_OVERCHARGE: {
    label: "수수료 초과 청구",
    category: "fee",
    severity: "critical",
    description: "실제 청구 수수료가 계약 수수료율로 계산한 금액을 넘습니다.",
  },
  FEE_UNDERCHARGE: {
    label: "수수료 과소 청구",
    category: "fee",
    severity: "info",
    description: "계약보다 적게 청구됐습니다. 나중에 소급 청구될 수 있어 확인이 필요합니다.",
  },
  FEE_ON_CANCELED_ORDER: {
    label: "취소 건 수수료 청구",
    category: "fee",
    severity: "critical",
    description: "취소된 주문에는 판매 수수료가 발생하지 않습니다.",
  },
  SHIPPING_OVERCHARGE: {
    label: "배송비 초과 차감",
    category: "logistics",
    severity: "warning",
    description: "계약 배송비보다 많은 금액이 차감됐습니다.",
  },
  RETURN_FEE_DOUBLE_CHARGED: {
    label: "반품비 중복 차감",
    category: "logistics",
    severity: "critical",
    description: "반품 왕복 배송비를 기준액의 2배 이상 차감했습니다.",
  },
  RETURN_FEE_ON_SHIPPED_ORDER: {
    label: "배송완료 건 반품비",
    category: "logistics",
    severity: "warning",
    description: "반품되지 않은 배송완료 주문에 반품비가 붙었습니다.",
  },
  SETTLEMENT_SHORTFALL: {
    label: "정산 부족(설명 불가)",
    category: "settlement",
    severity: "critical",
    description: "수수료·배송·반품 항목으로 설명되지 않는 정산 부족액입니다.",
  },
  SETTLEMENT_SURPLUS: {
    label: "정산 초과 입금",
    category: "settlement",
    severity: "info",
    description: "기대 정산액보다 많이 입금됐습니다. 다음 정산에서 차감될 수 있습니다.",
  },
  ROUNDING_LEAK: {
    label: "반올림 누수",
    category: "settlement",
    severity: "info",
    description: "10원 이하의 반올림 차이가 반복 누적되고 있습니다.",
  },
  NEGATIVE_MARGIN: {
    label: "역마진(실효 마이너스)",
    category: "margin",
    severity: "critical",
    description: "정산액에서 원가·실배송원가를 빼면 마이너스입니다.",
  },
  MISSING_LEDGER: {
    label: "원장 누락",
    category: "data",
    severity: "warning",
    description: "매입원가가 0이거나 없어 마진 검증을 할 수 없습니다.",
  },
};

/** 행 단위 이상 결과 */
export interface RowAnomaly {
  code: AnomalyCode;
  label: string;
  severity: AnomalyMeta["severity"];
  category: AnomalyMeta["category"];
  /** 사람이 읽는 한 줄 설명 */
  detail: string;
  /** 계약 기준 기대값(원) */
  expected: number;
  /** 정산서 실제값(원) */
  actual: number;
  /** 이 원인으로 귀속된 손실액(원). 원인이어도 정산 차액이 없으면 0 */
  loss: number;
}

/** 대사가 끝난 행 */
export interface ReconciledRow {
  /** 리스트 key로 쓰는 안정적 식별자 */
  id: string;
  row: SettlementRow;
  contract: ContractTerms;
  /** 계약 수수료율로 재계산한 기대 수수료 */
  expectedCommission: number;
  /** 계약 기준 기대 배송비 차감액 */
  expectedShippingDeduction: number;
  /** 계약 기준 기대 반품비 */
  expectedReturnFee: number;
  /** 계약 기준 기대 정산액 */
  expectedSettlement: number;
  /** 정산서 실제 정산액 */
  actualSettlement: number;
  /** 실제 - 기대 (음수면 셀러가 덜 받음) */
  variance: number;
  /** 부족분(0 이상) */
  shortfall: number;
  /** 초과 입금분(0 이상) */
  surplus: number;
  /** 실효 수수료율(%) = 청구 수수료 / 결제금액 */
  effectiveFeeRate: number;
  /** 실효 마진(원) = 정산액 - 원가 - 실배송원가 */
  netMargin: number;
  /** 실효 마진율(%) = 실효 마진 / 결제금액 */
  marginRate: number;
  anomalies: RowAnomaly[];
  /** 이 행에서 확인된 손실액(부족분 이내) */
  loss: number;
  /** 이상이 하나도 없으면 true */
  reconciled: boolean;
}

/** 요약 지표 */
export interface ReconciliationSummary {
  /** 대사한 행 수 */
  totalRows: number;
  /** 이상이 없는 행 수 */
  matchedRows: number;
  /** 이상이 있는 행 수 */
  flaggedRows: number;
  /** 정상 대사율(%) */
  matchedRate: number;
  /** 결제금액 합계 */
  totalPaidAmount: number;
  /** 청구 수수료 합계 */
  totalCommission: number;
  /** 실제 정산액 합계 */
  totalSettledAmount: number;
  /** 기대 정산액 합계 */
  expectedSettlement: number;
  /** 누수 추정 손실액(원인 귀속 합계) */
  totalLeak: number;
  /** 초과 입금 합계 */
  totalSurplus: number;
  /** 역마진 노출액(역마진 행의 마이너스 마진 절대값 합) */
  marginRiskExposure: number;
  /** 역마진 행 수 */
  negativeMarginRows: number;
  /** 원인별 건수 */
  anomalyCounts: Record<AnomalyCode, number>;
  /** 원인별 귀속 손실액 */
  anomalyLoss: Record<AnomalyCode, number>;
  /** 채널별 분해 */
  byChannel: ChannelSummary[];
  /** 손실 상위 SKU */
  topSkusByLoss: SkuLoss[];
  /** 최악 실효 마진율(%) */
  worstMarginRate: number;
}

export interface ChannelSummary {
  channel: MarketChannel;
  rows: number;
  paidAmount: number;
  settledAmount: number;
  leak: number;
  flaggedRows: number;
}

export interface SkuLoss {
  sku: string;
  productName: string;
  rows: number;
  loss: number;
}

/** 대사 결과 전체 */
export interface ReconciliationResult {
  rows: ReconciledRow[];
  summary: ReconciliationSummary;
  meta: ReconciliationMeta;
}

/** 대사 실행 메타(파싱 오류·소요 시간 등) */
export interface ReconciliationMeta {
  /** 파싱 단계에서 격리된 오류 행 수 */
  parseErrorCount: number;
  /** CSV 원본 행 수(헤더 제외) */
  sourceRowCount: number;
  /** 대사 소요 시간(ms) */
  elapsedMs: number;
  /** 초당 처리 건수 */
  rowsPerSecond: number;
  /** 계약 프리셋 출처 */
  contractSource: "preset" | "custom";
}

/** 금액 반올림 — 원 단위 정수. -0 을 만들지 않는다. */
export function roundWon(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value);
  return rounded === 0 ? 0 : rounded;
}

/** 원 단위 정수 나눗셈 결과를 %로. 0 나눗셈은 0으로 둔다. */
export function toRate(numerator: number, denominator: number, digits = 2): number {
  if (!denominator) return 0;
  const factor = 10 ** digits;
  return Math.round((numerator / denominator) * 100 * factor) / factor;
}

/** 행에서 상태별 매출 인식액. 반품·취소는 매출 0(환불)로 본다. */
function recognizedRevenue(row: SettlementRow): number {
  if (row.status === "취소" || row.status === "반품완료") return 0;
  return row.paidAmount;
}

/** 상태별로 반품비가 발생하는 조건 */
function expectedReturnFeeFor(row: SettlementRow, contract: ContractTerms): number {
  if (row.status === "반품완료") return contract.roundTripReturnFee;
  if (row.status === "교환완료") return contract.roundTripReturnFee;
  return 0;
}

/**
 * 한 행을 계약 조건으로 재계산하고 실제 정산액과 대사한다.
 *
 * 손실 귀속 알고리즘
 * ------------------
 * 1. 계약 기준 기대 정산액을 계산한다.
 * 2. `shortfall = max(0, 기대 - 실제)` 를 구한다. 이것이 그 행에서 잃은 돈의 상한이다.
 * 3. 원인별 후보 금액(수수료 초과, 배송비 초과, 반품비 초과, 취소건 수수료)을 계산한다.
 * 4. 후보 금액을 우선순위대로 shortfall에서 차감 배정한다. 배정 합계는 shortfall을 넘지 않는다.
 * 5. 남은 금액이 10원을 넘으면 `SETTLEMENT_SHORTFALL`(설명 불가), 10원 이하면 `ROUNDING_LEAK`.
 *
 * 이 순서 덕분에 "수수료 초과 1,900원 + 반품비 중복 1,500원 + 설명 불가 0원 = 부족분 3,400원"처럼
 * 합계가 맞아떨어지고, 같은 돈을 두 번 세지 않는다.
 */
export function reconcileRow(row: SettlementRow, contracts: Record<MarketChannel, ContractTerms> = CHANNEL_CONTRACTS): ReconciledRow {
  const contract = contracts[row.channel] ?? CHANNEL_CONTRACTS[row.channel];
  const quantity = Math.max(1, Math.round(row.quantity));
  const revenue = recognizedRevenue(row);

  const expectedCommission = roundWon((revenue * contract.feeRate) / 100);
  const expectedShippingDeduction = revenue === 0 ? 0 : contract.outboundShipping;
  const expectedReturnFee = expectedReturnFeeFor(row, contract);

  const expectedSettlement = revenue - expectedCommission - expectedShippingDeduction - expectedReturnFee;
  const actualSettlement = roundWon(row.settledAmount);
  const variance = actualSettlement - expectedSettlement;
  const shortfall = variance < 0 ? -variance : 0;
  const surplus = variance > 0 ? variance : 0;

  const anomalies: RowAnomaly[] = [];

  /** 원인별 후보 금액 — 아직 shortfall에 배정되기 전 단계 */
  const candidates: { code: AnomalyCode; amount: number; expected: number; actual: number; detail: string }[] = [];

  // 1) 수수료: 계약 수수료율 대비 청구액
  const commissionTolerance = Math.max(100, roundWon(expectedCommission * 0.01));
  const commissionDiff = roundWon(row.commission) - expectedCommission;
  if (commissionDiff > commissionTolerance) {
    candidates.push({
      code: "FEE_OVERCHARGE",
      amount: commissionDiff,
      expected: expectedCommission,
      actual: roundWon(row.commission),
      detail: `계약 ${contract.feeRate}% 기준 ${expectedCommission.toLocaleString("ko-KR")}원이어야 하는데 ${roundWon(row.commission).toLocaleString("ko-KR")}원이 청구됐습니다(실효 ${toRate(row.commission, revenue || row.paidAmount)}%).`,
    });
  } else if (commissionDiff < -commissionTolerance) {
    anomalies.push({
      code: "FEE_UNDERCHARGE",
      label: ANOMALY_META.FEE_UNDERCHARGE.label,
      severity: ANOMALY_META.FEE_UNDERCHARGE.severity,
      category: ANOMALY_META.FEE_UNDERCHARGE.category,
      detail: `계약 수수료보다 ${Math.abs(commissionDiff).toLocaleString("ko-KR")}원 적게 청구됐습니다. 소급 청구 가능성이 있습니다.`,
      expected: expectedCommission,
      actual: roundWon(row.commission),
      loss: 0,
    });
  }

  // 2) 취소 건에 수수료가 붙은 경우
  if (row.status === "취소" && roundWon(row.commission) > 0) {
    candidates.push({
      code: "FEE_ON_CANCELED_ORDER",
      amount: roundWon(row.commission),
      expected: 0,
      actual: roundWon(row.commission),
      detail: `취소 주문인데 수수료 ${roundWon(row.commission).toLocaleString("ko-KR")}원이 청구됐습니다.`,
    });
  }

  // 3) 배송비 초과 차감 (매출이 인식된 주문만)
  if (revenue > 0) {
    const shippingOver = roundWon(row.shippingDeduction) - expectedShippingDeduction;
    if (shippingOver > 0) {
      candidates.push({
        code: "SHIPPING_OVERCHARGE",
        amount: shippingOver,
        expected: expectedShippingDeduction,
        actual: roundWon(row.shippingDeduction),
        detail: `계약 배송비 ${expectedShippingDeduction.toLocaleString("ko-KR")}원보다 ${shippingOver.toLocaleString("ko-KR")}원 더 차감됐습니다.`,
      });
    }
  }

  // 4) 반품비 중복 차감 / 배송완료 건 반품비
  const actualReturnFee = roundWon(row.returnFee);
  if (row.status === "반품완료" && actualReturnFee > contract.roundTripReturnFee) {
    const over = actualReturnFee - contract.roundTripReturnFee;
    candidates.push({
      code: "RETURN_FEE_DOUBLE_CHARGED",
      amount: over,
      expected: contract.roundTripReturnFee,
      actual: actualReturnFee,
      detail: `반품 왕복 배송비 기준 ${contract.roundTripReturnFee.toLocaleString("ko-KR")}원인데 ${actualReturnFee.toLocaleString("ko-KR")}원이 차감됐습니다(중복 차감 ${over.toLocaleString("ko-KR")}원).`,
    });
  }
  if (row.status === "배송완료" && actualReturnFee > 0) {
    candidates.push({
      code: "RETURN_FEE_ON_SHIPPED_ORDER",
      amount: actualReturnFee,
      expected: 0,
      actual: actualReturnFee,
      detail: `반품되지 않은 배송완료 주문에 반품비 ${actualReturnFee.toLocaleString("ko-KR")}원이 차감됐습니다.`,
    });
  }

  // 5) shortfall에 원인별 금액을 우선순위대로 배정한다.
  let remaining = shortfall;
  const priority: AnomalyCode[] = [
    "FEE_ON_CANCELED_ORDER",
    "RETURN_FEE_DOUBLE_CHARGED",
    "RETURN_FEE_ON_SHIPPED_ORDER",
    "FEE_OVERCHARGE",
    "SHIPPING_OVERCHARGE",
  ];
  const ordered = [...candidates].sort((a, b) => priority.indexOf(a.code) - priority.indexOf(b.code));
  for (const candidate of ordered) {
    const attributed = Math.min(candidate.amount, remaining);
    remaining -= attributed;
    anomalies.push({
      code: candidate.code,
      label: ANOMALY_META[candidate.code].label,
      severity: ANOMALY_META[candidate.code].severity,
      category: ANOMALY_META[candidate.code].category,
      detail: candidate.detail,
      expected: candidate.expected,
      actual: candidate.actual,
      loss: attributed,
    });
  }

  // 6) 남은 차액: 10원 초과는 설명 불가 부족, 이하는 반올림 누수
  if (remaining > 10) {
    anomalies.push({
      code: "SETTLEMENT_SHORTFALL",
      label: ANOMALY_META.SETTLEMENT_SHORTFALL.label,
      severity: ANOMALY_META.SETTLEMENT_SHORTFALL.severity,
      category: ANOMALY_META.SETTLEMENT_SHORTFALL.category,
      detail: `수수료·배송·반품 항목으로 설명되지 않는 ${remaining.toLocaleString("ko-KR")}원이 부족합니다.`,
      expected: expectedSettlement,
      actual: actualSettlement,
      loss: remaining,
    });
    remaining = 0;
  } else if (remaining > 0) {
    anomalies.push({
      code: "ROUNDING_LEAK",
      label: ANOMALY_META.ROUNDING_LEAK.label,
      severity: ANOMALY_META.ROUNDING_LEAK.severity,
      category: ANOMALY_META.ROUNDING_LEAK.category,
      detail: `반올림 차이 ${remaining.toLocaleString("ko-KR")}원이 발생했습니다.`,
      expected: expectedSettlement,
      actual: actualSettlement,
      loss: remaining,
    });
    remaining = 0;
  }
  if (surplus > 10) {
    anomalies.push({
      code: "SETTLEMENT_SURPLUS",
      label: ANOMALY_META.SETTLEMENT_SURPLUS.label,
      severity: ANOMALY_META.SETTLEMENT_SURPLUS.severity,
      category: ANOMALY_META.SETTLEMENT_SURPLUS.category,
      detail: `기대 정산액보다 ${surplus.toLocaleString("ko-KR")}원 많이 입금됐습니다. 다음 정산에서 차감될 수 있습니다.`,
      expected: expectedSettlement,
      actual: actualSettlement,
      loss: 0,
    });
  }

  // 7) 실효 마진 — 원가·실배송원가를 뺀 실제 남는 돈
  const netMargin = roundWon(actualSettlement - row.unitCost * quantity - row.sellerShippingCost);
  const marginRate = toRate(netMargin, row.paidAmount);

  if (row.unitCost <= 0) {
    anomalies.push({
      code: "MISSING_LEDGER",
      label: ANOMALY_META.MISSING_LEDGER.label,
      severity: ANOMALY_META.MISSING_LEDGER.severity,
      category: ANOMALY_META.MISSING_LEDGER.category,
      detail: "매입원가가 0으로 기록돼 마진을 검증할 수 없습니다.",
      expected: 1,
      actual: 0,
      loss: 0,
    });
  } else if (row.status === "배송완료" && netMargin < 0) {
    anomalies.push({
      code: "NEGATIVE_MARGIN",
      label: ANOMALY_META.NEGATIVE_MARGIN.label,
      severity: ANOMALY_META.NEGATIVE_MARGIN.severity,
      category: ANOMALY_META.NEGATIVE_MARGIN.category,
      detail: `정산액 ${actualSettlement.toLocaleString("ko-KR")}원 - 원가·배송 ${(row.unitCost * quantity + row.sellerShippingCost).toLocaleString("ko-KR")}원 = ${netMargin.toLocaleString("ko-KR")}원(마진율 ${marginRate}%).`,
      expected: 0,
      actual: netMargin,
      loss: 0, // 손실은 이미 shortfall로 집계되므로 중복 계산하지 않는다.
    });
  }

  return {
    id: `${row.channel}:${row.orderNo}`,
    row,
    contract,
    expectedCommission,
    expectedShippingDeduction,
    expectedReturnFee,
    expectedSettlement,
    actualSettlement,
    variance,
    shortfall,
    surplus,
    effectiveFeeRate: toRate(row.commission, row.paidAmount),
    netMargin,
    marginRate,
    anomalies,
    loss: shortfall,
    reconciled: anomalies.length === 0,
  };
}

function emptyAnomalyRecord(): Record<AnomalyCode, number> {
  return {
    FEE_OVERCHARGE: 0,
    FEE_UNDERCHARGE: 0,
    FEE_ON_CANCELED_ORDER: 0,
    SHIPPING_OVERCHARGE: 0,
    RETURN_FEE_DOUBLE_CHARGED: 0,
    RETURN_FEE_ON_SHIPPED_ORDER: 0,
    SETTLEMENT_SHORTFALL: 0,
    SETTLEMENT_SURPLUS: 0,
    ROUNDING_LEAK: 0,
    NEGATIVE_MARGIN: 0,
    MISSING_LEDGER: 0,
  };
}

/** 대사 결과 집계 */
export function summarizeReconciliation(rows: readonly ReconciledRow[]): ReconciliationSummary {
  const anomalyCounts = emptyAnomalyRecord();
  const anomalyLoss = emptyAnomalyRecord();
  const channelMap = new Map<MarketChannel, ChannelSummary>();
  const skuMap = new Map<string, SkuLoss>();

  let totalPaidAmount = 0;
  let totalCommission = 0;
  let totalSettledAmount = 0;
  let expectedSettlement = 0;
  let totalLeak = 0;
  let totalSurplus = 0;
  let marginRiskExposure = 0;
  let negativeMarginRows = 0;
  let matchedRows = 0;
  let worstMarginRate = 0;

  for (const item of rows) {
    const { row } = item;
    totalPaidAmount += row.paidAmount;
    totalCommission += row.commission;
    totalSettledAmount += item.actualSettlement;
    expectedSettlement += item.expectedSettlement;
    totalLeak += item.loss;
    totalSurplus += item.surplus;

    if (item.anomalies.length === 0) matchedRows += 1;
    for (const anomaly of item.anomalies) {
      anomalyCounts[anomaly.code] += 1;
      anomalyLoss[anomaly.code] += anomaly.loss;
    }

    if (row.status === "배송완료" && row.unitCost > 0 && item.netMargin < 0) {
      negativeMarginRows += 1;
      marginRiskExposure += -item.netMargin;
      if (item.marginRate < worstMarginRate) worstMarginRate = item.marginRate;
    }

    const channel = channelMap.get(row.channel) ?? {
      channel: row.channel,
      rows: 0,
      paidAmount: 0,
      settledAmount: 0,
      leak: 0,
      flaggedRows: 0,
    };
    channel.rows += 1;
    channel.paidAmount += row.paidAmount;
    channel.settledAmount += item.actualSettlement;
    channel.leak += item.loss;
    if (item.anomalies.length > 0) channel.flaggedRows += 1;
    channelMap.set(row.channel, channel);

    if (item.anomalies.length > 0) {
      const sku = skuMap.get(row.sku) ?? { sku: row.sku, productName: row.productName, rows: 0, loss: 0 };
      sku.rows += 1;
      sku.loss += item.loss;
      skuMap.set(row.sku, sku);
    }
  }

  const totalRows = rows.length;
  return {
    totalRows,
    matchedRows,
    flaggedRows: totalRows - matchedRows,
    matchedRate: toRate(matchedRows, totalRows),
    totalPaidAmount,
    totalCommission,
    totalSettledAmount,
    expectedSettlement,
    totalLeak,
    totalSurplus,
    marginRiskExposure,
    negativeMarginRows,
    anomalyCounts,
    anomalyLoss,
    byChannel: [...channelMap.values()].sort((a, b) => b.paidAmount - a.paidAmount),
    topSkusByLoss: [...skuMap.values()].sort((a, b) => b.loss - a.loss).slice(0, 5),
    worstMarginRate,
  };
}

export interface ReconcileOptions {
  contracts?: Record<MarketChannel, ContractTerms>;
  /** 파싱 단계에서 격리된 오류 행 수 */
  parseErrorCount?: number;
  /** CSV 원본 행 수 */
  sourceRowCount?: number;
  /** 소요 시간 주입(테스트 결정성) */
  elapsedMs?: number;
}

/** 동기 배치 대사 — 수만 건 이하에서 사용한다. */
export function reconcileSettlement(rows: readonly SettlementRow[], options: ReconcileOptions = {}): ReconciliationResult {
  const contracts = options.contracts ?? CHANNEL_CONTRACTS;
  const reconciled = rows.map((row) => reconcileRow(row, contracts));
  const summary = summarizeReconciliation(reconciled);
  const elapsedMs = options.elapsedMs ?? 0;

  return {
    rows: reconciled,
    summary,
    meta: {
      parseErrorCount: options.parseErrorCount ?? 0,
      sourceRowCount: options.sourceRowCount ?? rows.length,
      elapsedMs,
      rowsPerSecond: elapsedMs > 0 ? Math.round((rows.length / elapsedMs) * 1000) : 0,
      contractSource: options.contracts ? "custom" : "preset",
    },
  };
}

export interface BatchProgress {
  processed: number;
  total: number;
  percent: number;
  rowsPerSecond: number;
  elapsedMs: number;
}

export interface BatchOptions extends ReconcileOptions {
  /** 한 번에 처리할 행 수 */
  batchSize?: number;
  /** 진행률 콜백 */
  onProgress?: (progress: BatchProgress) => void;
  /** 중단 신호 */
  signal?: { aborted: boolean };
  /** 시간 주입(테스트 결정성) */
  now?: () => number;
  /** 배치 사이에 이벤트 루프를 양보할지 여부 */
  yieldToEventLoop?: boolean;
}

/**
 * 비동기 배치 대사.
 *
 * 10만 건을 한 번에 계산하면 메인 스레드가 수 초간 멈춘다. 배치마다 이벤트 루프에 양보하면
 * 진행률 UI가 계속 갱신되고, 사용자는 "멈췄다"고 느끼지 않는다. Web Worker 안에서 호출하면
 * 메인 스레드는 아예 영향을 받지 않는다.
 */
export async function reconcileSettlementInBatches(
  rows: readonly SettlementRow[],
  options: BatchOptions = {},
): Promise<ReconciliationResult> {
  const contracts = options.contracts ?? CHANNEL_CONTRACTS;
  const batchSize = Math.max(1, options.batchSize ?? 2_000);
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const reconciled: ReconciledRow[] = [];
  const total = rows.length;

  for (let index = 0; index < total; index += batchSize) {
    if (options.signal?.aborted) break;
    const end = Math.min(index + batchSize, total);
    for (let cursor = index; cursor < end; cursor += 1) {
      const row = rows[cursor];
      if (!row) continue;
      reconciled.push(reconcileRow(row, contracts));
    }

    const elapsedMs = Math.max(0, now() - startedAt);
    options.onProgress?.({
      processed: end,
      total,
      percent: total === 0 ? 100 : Math.round((end / total) * 100),
      rowsPerSecond: elapsedMs > 0 ? Math.round((end / elapsedMs) * 1000) : 0,
      elapsedMs,
    });

    if (options.yieldToEventLoop !== false) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  const elapsedMs = Math.max(0, now() - startedAt);
  return {
    rows: reconciled,
    summary: summarizeReconciliation(reconciled),
    meta: {
      parseErrorCount: options.parseErrorCount ?? 0,
      sourceRowCount: options.sourceRowCount ?? total,
      elapsedMs,
      rowsPerSecond: elapsedMs > 0 ? Math.round((total / elapsedMs) * 1000) : 0,
      contractSource: options.contracts ? "custom" : "preset",
    },
  };
}

/** 요약에서 "가장 돈이 새는 원인" 한 가지를 뽑는다. 대시보드 문장용. */
export function biggestLeakCause(summary: ReconciliationSummary): { code: AnomalyCode; amount: number } | null {
  let best: { code: AnomalyCode; amount: number } | null = null;
  for (const key of Object.keys(summary.anomalyLoss) as AnomalyCode[]) {
    const amount = summary.anomalyLoss[key];
    if (amount > 0 && (!best || amount > best.amount)) best = { code: key, amount };
  }
  return best;
}
