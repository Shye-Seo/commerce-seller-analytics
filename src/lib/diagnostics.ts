import { RETURN_HANDLING_RATE, calculateMargin, recommendSellingPrice } from "./calculator";
import { formatCount, formatPercent, formatWon } from "./format";
import type { MarginBreakdown, MarginInput } from "./types";

/**
 * 마진 진단 · 액션 플랜 엔진.
 *
 * 이 모듈은 "AI"라는 이름을 쓰지만 외부 LLM을 호출하지 않는다. 셀러가 이미 화면에
 * 입력한 숫자만으로 결정론적인 진단을 만들기 때문이다. 그 이유는 세 가지다.
 *
 * 1) 같은 입력에 같은 답이 나와야 한다. 서버 렌더와 클라이언트 렌더가 다른 문장을
 *    만들면 하이드레이션 오류가 나고, 포트폴리오 데모에서 "새로고침하면 조언이 바뀐다"는
 *    신뢰 문제가 생긴다.
 * 2) 숫자의 근거를 문장마다 되짚을 수 있어야 한다. "월 +18만 원"이라는 처방이 어떤
 *    계산식에서 나왔는지 설명할 수 없는 조언은 셀러에게 쓸모가 없다.
 * 3) API 키·토큰 비용·응답 지연 없이 정적 배포본에서도 그대로 동작해야 한다.
 *
 * 따라서 여기서는 "규칙 기반 진단 엔진"으로 구현하고, 화면에서도 그렇게 표기한다.
 * 다만 점수 가중치·기준선·문장 생성 규칙을 한곳에 모아 두었으므로, 나중에 LLM을
 * 붙이더라도 이 모듈이 만든 구조화된 진단을 프롬프트의 근거 데이터로 그대로 넘길 수 있다.
 */

/** 진단 등급 */
export type MarginGrade = "우수" | "주의" | "위험";

/** 액션의 긴급도 */
export type ActionPriority = "critical" | "recommended" | "maintain";

/**
 * 액션의 금액 성격.
 * - saving: 지금 새고 있는 비용을 줄여 회수하는 금액
 * - upside: 판매가·판매량을 조정해 추가로 만드는 금액
 * - headroom: 이미 확보한 여유(방어 여력) — 당장의 이익 증가는 아님
 * - neutral: 금액 효과 없음(정보성)
 */
export type ImpactKind = "saving" | "upside" | "headroom" | "neutral";

export interface CostRatioItem {
  key:
    | "productCost"
    | "commission"
    | "paymentFee"
    | "shippingCost"
    | "adCost"
    | "expectedReturnLoss";
  label: string;
  amount: number;
  /** 판매가 대비 비율(%) */
  ratio: number;
  /** 권장 상한(%) */
  benchmark: number;
  status: "ok" | "watch" | "over";
}

export interface ScoreItem {
  key: "margin" | "ads" | "returns" | "coverage";
  label: string;
  /** 0~100 */
  score: number;
  /** 종합 점수에서 차지하는 가중치(%) */
  weight: number;
  /** 기준 대비 실제 값을 한 줄로 */
  detail: string;
}

export interface DiagnosticAction {
  id: "cps" | "pricing" | "breakeven" | "returns";
  title: string;
  detail: string;
  priority: ActionPriority;
  /** 처방을 적용했을 때의 월 단위 금액 효과(원) */
  impactMonthly: number;
  impactKind: ImpactKind;
  /** 카드 우측 상단에 붙는 핵심 수치 */
  metric: string;
}

export interface MarginDiagnosis {
  /** 0~100 종합 점수 */
  score: number;
  grade: MarginGrade;
  headline: string;
  summary: string;
  costRatios: CostRatioItem[];
  scoreBreakdown: ScoreItem[];
  actions: DiagnosticAction[];
  /** 목표 마진(25%)을 확보하는 판매가 */
  targetPrice: number;
  /** 반품률 1%p 개선 시 월 개선액 */
  returnUpliftPerPoint: number;
}

/** 목표 마진율(%) */
export const TARGET_MARGIN_RATE = 25;
/** 광고비(CPS) 권장 상한 — 판매가 대비 % */
export const CPS_CEILING_RATE = 10;
/** 반품률 권장 상한(%) */
export const RECOMMENDED_RETURN_RATE = 5;

/** 종합 점수 등급 경계 */
const GRADE_GOOD = 80;
const GRADE_WATCH = 60;

/** 점수 가중치 합은 100 */
const WEIGHTS = {
  margin: 45,
  ads: 20,
  returns: 15,
  coverage: 20,
} as const;

/**
 * 비용 항목별 권장 상한(판매가 대비 %).
 * 카테고리마다 다르지만, "이 선을 넘으면 광고를 켤수록 남는 게 없다"는 실무 감각을
 * 기준선으로 고정했다. 화면에는 "권장 상한"이라고만 표기하고 절대 기준으로 쓰지 않는다.
 */
const COST_BENCHMARKS: ReadonlyArray<Pick<CostRatioItem, "key" | "label" | "benchmark">> = [
  { key: "productCost", label: "상품 원가", benchmark: 45 },
  { key: "commission", label: "판매 수수료", benchmark: 10 },
  { key: "paymentFee", label: "결제 수수료", benchmark: 4 },
  { key: "shippingCost", label: "배송비", benchmark: 12 },
  { key: "adCost", label: "광고비", benchmark: CPS_CEILING_RATE },
  { key: "expectedReturnLoss", label: "반품 손실", benchmark: 2.5 },
];

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * 선형 구간 점수.
 * `best`에서 100점, `worst`에서 0점이 되도록 1차 보간하고 0~100으로 자른다.
 * best가 worst보다 작아도(값이 작을수록 좋은 지표) 같은 식이 성립한다.
 */
function linearScore(value: number, best: number, worst: number): number {
  if (!Number.isFinite(value)) return 0;
  if (best === worst) return 100;
  return clamp(((value - worst) / (best - worst)) * 100, 0, 100);
}

function buildCostRatios(result: MarginBreakdown): CostRatioItem[] {
  const price = result.sellingPrice;

  return COST_BENCHMARKS.map(({ key, label, benchmark }) => {
    const amount = result[key];
    const ratio = price > 0 ? (amount / price) * 100 : 0;
    const status: CostRatioItem["status"] =
      ratio <= benchmark ? "ok" : ratio <= benchmark * 1.3 ? "watch" : "over";

    return { key, label, amount, ratio, benchmark, status };
  });
}

/**
 * 고정비 회수 여력(배수).
 * 3배 이상이면 "판매량이 절반으로 줄어도 버틴다"는 뜻이고, 1배 미만이면 고정비를
 * 회수하지 못한다. 고정비가 0이면 회수선 자체가 없으므로 Infinity로 둔다.
 */
function coverageMultiple(input: MarginInput, result: MarginBreakdown): number {
  if (!Number.isFinite(result.breakEvenUnits)) return 0;
  if (result.breakEvenUnits === 0) return Number.POSITIVE_INFINITY;
  return input.monthlyUnits / result.breakEvenUnits;
}

function buildScoreBreakdown(
  input: MarginInput,
  result: MarginBreakdown,
  coverage: number,
): ScoreItem[] {
  return [
    {
      key: "margin",
      label: "마진율",
      // 30% 이상이면 만점, 0% 이하면 0점
      score: linearScore(result.marginRate, 30, 0),
      weight: WEIGHTS.margin,
      detail: `마진율 ${formatPercent(result.marginRate)} / 기준 30%`,
    },
    {
      key: "ads",
      label: "광고 효율",
      // 판매가 대비 6% 이하면 만점, 18% 이상이면 0점
      score: linearScore(
        result.sellingPrice > 0 ? (result.adCost / result.sellingPrice) * 100 : 0,
        6,
        18,
      ),
      weight: WEIGHTS.ads,
      detail: `CPS ${formatPercent(
        result.sellingPrice > 0 ? (result.adCost / result.sellingPrice) * 100 : 0,
      )} / 상한 ${CPS_CEILING_RATE}%`,
    },
    {
      key: "returns",
      label: "반품 안정성",
      // 2% 이하면 만점, 15% 이상이면 0점
      score: linearScore(clamp(input.returnRate, 0, 100), 2, 15),
      weight: WEIGHTS.returns,
      detail: `반품률 ${formatPercent(clamp(input.returnRate, 0, 100))} / 권장 ${RECOMMENDED_RETURN_RATE}%`,
    },
    {
      key: "coverage",
      label: "고정비 회수",
      // 3배 이상이면 만점, 1배 이하면 0점
      score: linearScore(coverage, 3, 1),
      weight: WEIGHTS.coverage,
      detail: Number.isFinite(coverage)
        ? `회수 여력 ${coverage.toFixed(1)}배 / 기준 3.0배`
        : "고정비 없음 · 회수선 없음",
    },
  ];
}

function buildSummary(
  diagnosis: {
    result: MarginBreakdown;
    cpsRatio: number;
    coverage: number;
    returnRate: number;
    grade: MarginGrade;
  },
): string {
  const { result, cpsRatio, coverage, returnRate, grade } = diagnosis;
  const issues: string[] = [];

  if (result.netProfitPerUnit < 0) {
    issues.push(
      `건당 ${formatWon(result.netProfitPerUnit)}으로 이미 적자입니다. 판매가 인상이 다른 어떤 개선보다 먼저입니다.`,
    );
  } else if (result.marginRate < 12) {
    issues.push(
      `마진율 ${formatPercent(result.marginRate)}는 판매 1건의 여유가 12% 미만이라는 뜻입니다.`,
    );
  }

  if (cpsRatio > CPS_CEILING_RATE) {
    issues.push(
      `광고비가 판매가의 ${formatPercent(cpsRatio)}로 권장 상한 ${CPS_CEILING_RATE}%를 넘어 이익을 가장 많이 가져가고 있습니다.`,
    );
  }

  if (returnRate > RECOMMENDED_RETURN_RATE) {
    issues.push(
      `반품률 ${formatPercent(returnRate)}는 건당 ${formatWon(result.expectedReturnLoss)}의 기대 손실을 만들고 있습니다.`,
    );
  }

  if (coverage < 1) {
    issues.push(
      `월 판매량이 고정비 회수선(${formatCount(result.breakEvenUnits)})에 닿지 못해 매달 고정비만큼 손실이 쌓입니다.`,
    );
  } else if (coverage < 1.5) {
    issues.push(
      `고정비 회수 여력이 ${coverage.toFixed(1)}배로, 판매량이 조금만 줄어도 적자로 넘어갑니다.`,
    );
  }

  if (issues.length === 0) {
    return "마진율·광고 효율·반품률·고정비 회수 네 축이 모두 권장 범위 안에 있습니다. 지금은 가격을 건드리기보다 판매량을 늘리는 쪽이 안전합니다.";
  }

  if (grade === "우수") {
    issues.push("점수는 높지만 위 항목은 다음 캠페인 전에 정리해 두는 편이 좋습니다.");
  }

  return issues.join(" ");
}

/**
 * 마진 진단 본체.
 *
 * 입력값 하나만 받아 계산·진단·처방을 모두 파생시킨다. 화면에서 별도 상태를 두지 않으므로
 * "슬라이더를 움직였는데 처방전은 그대로"인 상태가 구조적으로 생기지 않는다.
 */
export function diagnoseMargin(input: MarginInput): MarginDiagnosis {
  const result = calculateMargin(input);
  const costRatios = buildCostRatios(result);
  const cpsRatio = result.sellingPrice > 0 ? (result.adCost / result.sellingPrice) * 100 : 0;
  const coverage = coverageMultiple(input, result);
  const scoreBreakdown = buildScoreBreakdown(input, result, coverage);

  const weighted = scoreBreakdown.reduce(
    (total, item) => total + item.score * (item.weight / 100),
    0,
  );
  const score = Math.round(clamp(weighted, 0, 100));
  const grade: MarginGrade = score >= GRADE_GOOD ? "우수" : score >= GRADE_WATCH ? "주의" : "위험";

  const headline =
    result.netProfitPerUnit < 0
      ? `종합 ${score}점 · 건당 ${formatWon(result.netProfitPerUnit)} — 지금 조건은 팔수록 손해입니다`
      : grade === "우수"
        ? `종합 ${score}점 · 마진 ${formatPercent(result.marginRate)} — 지금 구조는 충분히 방어됩니다`
        : grade === "주의"
          ? `종합 ${score}점 · 마진 ${formatPercent(result.marginRate)} — 남는 구조지만 여유가 얇습니다`
          : `종합 ${score}점 · 마진 ${formatPercent(result.marginRate)} — 비용 구조부터 손봐야 합니다`;

  const summary = buildSummary({
    result,
    cpsRatio,
    coverage,
    returnRate: clamp(input.returnRate, 0, 100),
    grade,
  });

  const monthlyUnits = Math.max(input.monthlyUnits, 0);
  const actions: DiagnosticAction[] = [];

  // 1) 광고비(CPS) 비중
  const cpsCeilingAmount = result.sellingPrice * (CPS_CEILING_RATE / 100);
  if (result.sellingPrice <= 0) {
    // 판매가를 비우는 순간(입력 중 0원)에는 비중 자체가 정의되지 않는다.
    actions.push({
      id: "cps",
      title: "판매가를 입력하면 광고비 비중을 진단합니다",
      detail: `판매가가 0원이라 CPS를 판매가 대비 비중으로 계산할 수 없습니다. 판매가를 입력하면 권장 상한 ${formatPercent(CPS_CEILING_RATE, 0)}와 비교해 절감액을 계산해 드립니다.`,
      priority: "maintain",
      impactMonthly: 0,
      impactKind: "neutral",
      metric: "CPS —",
    });
  } else if (result.adCost > cpsCeilingAmount && result.adCost > 0) {
    const savingPerUnit = result.adCost - cpsCeilingAmount;
    actions.push({
      id: "cps",
      title: "광고비(CPS) 비중 초과 — 키워드 효율부터 개선",
      detail: `건당 광고비 ${formatWon(result.adCost)}은 판매가의 ${formatPercent(cpsRatio)}로 상한 ${CPS_CEILING_RATE}%를 넘습니다. 전환율이 낮은 키워드를 끄고 상위 전환 키워드로 예산을 몰아 CPS를 ${formatWon(cpsCeilingAmount)} 이하로 낮추세요.`,
      priority: cpsRatio >= 15 ? "critical" : "recommended",
      impactMonthly: Math.round(savingPerUnit * monthlyUnits),
      impactKind: "saving",
      metric: `CPS ${formatPercent(cpsRatio)}`,
    });
  } else {
    actions.push({
      id: "cps",
      title: "광고비(CPS) 비중 안정 — 10% 방어선 유지",
      detail: `건당 광고비가 판매가의 ${formatPercent(cpsRatio)}로 상한 ${CPS_CEILING_RATE}% 안에 있습니다. 광고를 늘릴 때는 CPS가 ${formatWon(cpsCeilingAmount)}을 넘지 않는 선에서, 키워드별 전환율을 먼저 확인하고 예산을 배분하세요.`,
      priority: "maintain",
      impactMonthly: Math.round(Math.max(cpsCeilingAmount - result.adCost, 0) * monthlyUnits),
      impactKind: "headroom",
      metric: `CPS ${formatPercent(cpsRatio)}`,
    });
  }

  // 2) 목표 마진(25%)을 확보하는 판매가
  const targetPrice = recommendSellingPrice(input, TARGET_MARGIN_RATE);
  if (!Number.isFinite(targetPrice)) {
    actions.push({
      id: "pricing",
      title: "수수료 구조상 목표 마진 확보 불가",
      detail: `수수료율 합이 ${formatPercent(result.effectiveFeeRate, 2)}로 목표 마진 ${TARGET_MARGIN_RATE}%와 합치면 100%를 넘습니다. 판매가를 올려도 남지 않으므로 수수료가 낮은 채널로 옮기거나 카테고리를 조정해야 합니다.`,
      priority: "critical",
      impactMonthly: 0,
      impactKind: "neutral",
      metric: "계산 불가",
    });
  } else if (targetPrice > result.sellingPrice) {
    const atTarget = calculateMargin({ ...input, sellingPrice: targetPrice });
    const gainPerUnit = atTarget.netProfitPerUnit - result.netProfitPerUnit;
    actions.push({
      id: "pricing",
      title: `목표 마진 ${TARGET_MARGIN_RATE}%까지 ${formatWon(targetPrice - result.sellingPrice)} 인상 여지`,
      detail: `현재 판매가 ${formatWon(result.sellingPrice)}에서는 마진이 ${formatPercent(result.marginRate)}입니다. 같은 비용 구조를 유지하면서 ${formatWon(targetPrice)}로 올리면 마진 ${formatPercent(atTarget.marginRate)}를 확보하고, 건당 ${formatWon(gainPerUnit)}이 더 남습니다.`,
      priority: result.netProfitPerUnit < 0 ? "critical" : "recommended",
      impactMonthly: Math.round(gainPerUnit * monthlyUnits),
      impactKind: "upside",
      metric: formatWon(targetPrice),
    });
  } else {
    actions.push({
      id: "pricing",
      title: `목표 마진 ${TARGET_MARGIN_RATE}% 달성 — 가격 인하 여력 ${formatWon(result.sellingPrice - targetPrice)}`,
      detail: `목표 판매가 ${formatWon(targetPrice)}보다 ${formatWon(result.sellingPrice - targetPrice)} 높게 판매 중입니다. 지금 가격을 유지해도 목표 마진은 확보되므로, 인하 여력은 전환율이 낮은 구간의 가격 테스트에만 쓰는 편이 좋습니다.`,
      priority: "maintain",
      impactMonthly: 0,
      impactKind: "neutral",
      metric: formatWon(targetPrice),
    });
  }

  // 3) 손익분기 판매량 돌파 전략
  const dailyRequired = Number.isFinite(result.breakEvenUnits) ? result.breakEvenUnits / 30 : null;
  const dailyCurrent = monthlyUnits / 30;
  if (!Number.isFinite(result.breakEvenUnits)) {
    actions.push({
      id: "breakeven",
      title: "판매량으로는 고정비를 회수할 수 없음",
      detail: `건당 순이익이 ${formatWon(result.netProfitPerUnit)}이라 한 건 팔 때마다 손실이 쌓입니다. 판매량을 늘리는 전략은 역효과이므로, 판매가 인상이나 원가·광고비 절감이 먼저입니다.`,
      priority: "critical",
      impactMonthly: 0,
      impactKind: "neutral",
      metric: "회수 불가",
    });
  } else if (result.breakEvenUnits === 0) {
    actions.push({
      id: "breakeven",
      title: "월 고정비 없음 — 회수선 없이 이익이 쌓이는 구조",
      detail: `고정비가 0원이라 손익분기 판매량이 없습니다. 판매 1건이 곧 이익이므로, 지금은 재고 회전과 판매량 확대에 집중할 수 있습니다.`,
      priority: "maintain",
      impactMonthly: 0,
      impactKind: "neutral",
      metric: "고정비 0원",
    });
  } else if (monthlyUnits >= result.breakEvenUnits) {
    actions.push({
      id: "breakeven",
      title: `고정비 회수선 돌파 — 일 ${(dailyCurrent - (dailyRequired ?? 0)).toFixed(1)}건 여유`,
      detail: `월 고정비(${formatWon(input.monthlyFixedCost)})를 회수하는 판매량은 월 ${result.breakEvenUnits}건(일 ${(dailyRequired ?? 0).toFixed(1)}건)입니다. 현재 월 ${monthlyUnits}건이면 ${coverage.toFixed(1)}배로, 판매량이 ${formatPercent((1 - result.breakEvenUnits / monthlyUnits) * 100)} 줄어도 적자로 넘어가지 않습니다.`,
      priority: "maintain",
      impactMonthly: Math.round((monthlyUnits - result.breakEvenUnits) * result.netProfitPerUnit),
      impactKind: "headroom",
      metric: `여력 ${coverage.toFixed(1)}배`,
    });
  } else {
    const shortfall = result.breakEvenUnits - monthlyUnits;
    actions.push({
      id: "breakeven",
      title: `고정비 회수까지 월 ${Math.ceil(shortfall)}건 부족`,
      detail: `일평균 ${(dailyRequired ?? 0).toFixed(1)}건을 팔아야 고정비를 회수하는데 현재는 ${dailyCurrent.toFixed(1)}건입니다. 일 ${(dailyRequired !== null ? dailyRequired - dailyCurrent : 0).toFixed(1)}건을 더 팔거나, 월 비용(고정비 또는 광고비)을 ${formatWon(shortfall * result.netProfitPerUnit)}만큼 줄여야 회수선에 닿습니다.`,
      priority: "critical",
      impactMonthly: 0,
      impactKind: "neutral",
      metric: `월 ${Math.ceil(shortfall)}건 부족`,
    });
  }

  // 4) 반품률 1%p 개선 시뮬레이션
  const lossPerReturnPoint =
    result.sellingPrice > 0
      ? 0.01 * (result.shippingCost * 2 + result.productCost * RETURN_HANDLING_RATE)
      : 0;
  const returnUpliftPerPoint = Math.round(lossPerReturnPoint * monthlyUnits);
  const returnRate = clamp(input.returnRate, 0, 100);

  if (returnRate > 0) {
    actions.push({
      id: "returns",
      title: `반품률 1%p 개선 시 월 ${formatWon(returnUpliftPerPoint)} 추가`,
      detail: `반품 1건당 손실은 왕복 배송비 ${formatWon(result.shippingCost * 2)}과 원가의 ${formatPercent(RETURN_HANDLING_RATE * 100, 0)}(${formatWon(result.productCost * RETURN_HANDLING_RATE)})를 합쳐 ${formatWon(result.shippingCost * 2 + result.productCost * RETURN_HANDLING_RATE)}입니다. 반품률을 ${formatPercent(returnRate)}에서 1%p 낮추면 건당 ${formatWon(lossPerReturnPoint)}이 돌아옵니다.`,
      priority: returnRate >= 15 ? "critical" : returnRate > RECOMMENDED_RETURN_RATE ? "recommended" : "maintain",
      impactMonthly: returnUpliftPerPoint,
      impactKind: "saving",
      metric: `반품률 ${formatPercent(returnRate)}`,
    });
  } else {
    actions.push({
      id: "returns",
      title: "반품률 0% — 반품 손실 없음",
      detail: `반품률이 0%라 기대 반품 손실이 발생하지 않습니다. 다만 실제 반품이 한 건이라도 생기면 왕복 배송비와 재판매 가치 하락이 바로 손실이므로, 사이즈·색상 정보를 상세페이지에 먼저 보강하세요.`,
      priority: "maintain",
      impactMonthly: 0,
      impactKind: "neutral",
      metric: "반품률 0%",
    });
  }

  return {
    score,
    grade,
    headline,
    summary,
    costRatios,
    scoreBreakdown,
    actions,
    targetPrice,
    returnUpliftPerPoint,
  };
}
