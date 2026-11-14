/**
 * 실시간 선착순 쿠폰 발급 엔진 (Flash Coupon Engine)
 *
 * 이 모듈은 "토스형 선착순 드롭"의 서버 로직을 프론트엔드/Node에서 그대로 돌려볼 수 있게
 * 옮긴 것이다. 서버(PHP) 구현과 **같은 규칙**을 쓰며, 두 구현이 다른 숫자를 내면
 * 테스트가 먼저 깨진다.
 *
 * 왜 브라우저/Node에 엔진이 또 필요한가
 * -------------------------------------
 * 데모 화면에서 "초당 몇 건이 들어오면 어떻게 되는가"를 보여주려면, 실제로 그 부하를
 * 만들어내는 시뮬레이터가 필요하다. 서버에 부하를 걸어 보여주는 데모는 (1) 인터넷이
 * 필요하고 (2) 남의 서버에 과도한 부하 트래픽을 보내는 일이 된다. 그래서 **같은 알고리즘을
 * 클라이언트에서 결정적으로 재현**하고, 그 결과(오버이슈 0건, 소진율, 락 경합)를
 * 화면에 보여준다.
 *
 * 이 엔진이 지키는 세 가지 불변식
 * -----------------------------
 * 1) **오버이슈 0건** — 재고 차감은 원자적 임계 구역(AsyncMutex) 안에서만 한다.
 *    임계 구역 안에서 마이크로태스크를 한 번 양보(`await Promise.resolve()`)하기 때문에,
 *    뮤텍스가 없으면 1,000건 동시 요청에서 반드시 오버이슈가 난다. 테스트는 그 사실을
 *    "뮤텍스가 있을 때 0건"으로 증명한다.
 * 2) **멱등 발급** — 같은 `idempotencyKey`는 같은 쿠폰을 돌려주고, 같은 사용자는 두 장을
 *    받을 수 없다(원장의 `(templateId, userHash)` 유일성).
 * 3) **원장 상태는 단방향** — ISSUED → RESERVED → REDEEMED → SETTLED.
 *    되돌리는 전이(예: REDEEMED → ISSUED)는 없다. 잘못된 사용은 CANCELLED로 남긴다.
 *
 * 금액은 전부 원 단위 정수이고, 반올림은 JS `Math.round`(floor(x + 0.5))로 고정한다.
 * PHP의 `Money::round`와 같은 식이다.
 */

/* ─────────────────────────────────────────────────────────────
 * 1. 타입
 * ───────────────────────────────────────────────────────── */

export type FlashCampaignStatus = "draft" | "scheduled" | "live" | "paused" | "ended" | "settled";

export type CouponStatus = "ISSUED" | "RESERVED" | "REDEEMED" | "SETTLED" | "CANCELLED" | "EXPIRED";

export type DiscountType = "FIXED" | "PERCENT";

export type FundingParty = "SELLER" | "PLATFORM" | "PARTNER";

export type MarginGuardMode = "block" | "warn";

export interface CampaignSpec {
  id: number;
  tenantId: number;
  code: string;
  name: string;
  type: "FLASH_DEAL" | "BRAND_DROP" | "TOSS_STYLE_DROP" | "WELCOME";
  partnerName?: string;
  /** 총 발행 예산(원) */
  rewardBudget: number;
  /** 발행 장수 상한 */
  tokenBudget: number;
  /** 최소 보장 마진율(%) */
  minGuaranteedMargin: number;
  marginGuardMode: MarginGuardMode;
  startsAt: number;
  endsAt: number;
  status: FlashCampaignStatus;
  /** 오픈 시각 예상 TPS — 대시보드의 기준선 */
  expectedPeakTps: number;
}

export interface CouponTemplateSpec {
  id: number;
  campaignId: number;
  code: string;
  name: string;
  discountType: DiscountType;
  /** 정액 할인액(원) */
  discountAmount: number;
  /** 정률 할인율(%) */
  discountRate: number;
  minOrderAmount: number;
  /** 정률 쿠폰의 최대 할인액(원). PERCENT면 반드시 > 0 */
  maxDiscountAmount: number;
  perUserLimit: number;
  validityMinutes: number;
  fundedBy: FundingParty;
  isActive: boolean;
}

export interface InventoryState {
  templateId: number;
  total: number;
  remaining: number;
  reserved: number;
  consumed: number;
  /** 낙관적 락 버전 */
  version: number;
  lastIssuedAt?: number;
}

export interface LedgerEntry {
  id: number;
  campaignId: number;
  templateId: number;
  userHash: string;
  codeHash: string;
  maskedCode: string;
  status: CouponStatus;
  discountAmount: number;
  orderAmount: number;
  orderId?: string;
  idempotencyKey: string;
  issuedAt: number;
  expiresAt: number;
  reservedAt?: number;
  redeemedAt?: number;
  settledAt?: number;
  cancelReason?: string;
}

export interface MarginInput {
  orderAmount: number;
  productCost: number;
  shippingCost?: number;
  feeRatePct?: number;
}

export interface MarginAssessment {
  evaluated: boolean;
  orderAmount: number;
  discountAmount: number;
  netSettlement: number;
  projectedMargin: number;
  projectedMarginRate: number;
  minimumMarginRate: number;
}

export type IssueOutcome =
  | "ISSUED"
  | "IDEMPOTENT_REPLAY"
  | "SOLD_OUT"
  | "DUPLICATE_CLAIM"
  | "MARGIN_GUARD_BLOCKED"
  | "CAMPAIGN_CLOSED"
  | "TEMPLATE_INACTIVE"
  | "BUDGET_EXHAUSTED"
  | "INVENTORY_CONFLICT"
  | "INVALID_REQUEST";

export interface IssueRequest {
  campaignId: number;
  templateId: number;
  userHash: string;
  idempotencyKey: string;
  /** 요청 시각(ms). 생략하면 엔진 시계 */
  now?: number;
  margin?: MarginInput;
}

export interface IssueResponse {
  outcome: IssueOutcome;
  entry?: LedgerEntry;
  /** 발급 순간에만 채워진다(원장·재전송 응답에는 없다) */
  plainCode?: string;
  margin: MarginAssessment;
  inventory?: InventoryState;
  reason: string;
  attempts: number;
  /** 임계 구역 대기/재시도로 소비한 시간(ms) */
  lockWaitMs?: number;
}

export interface EngineMetrics {
  attempts: number;
  issued: number;
  replayed: number;
  soldOut: number;
  duplicate: number;
  marginBlocked: number;
  budgetExhausted: number;
  closed: number;
  contentionRetries: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
}

/* ─────────────────────────────────────────────────────────────
 * 2. 순수 함수(할인·마진·상태 머신)
 * ───────────────────────────────────────────────────────── */

/** JS의 Math.round는 floor(x + 0.5)다. PHP `Money::round`와 동일 규칙. */
export function roundWon(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.floor(value + 0.5);
}

export function toRate(numerator: number, denominator: number, digits = 2): number {
  if (denominator === 0) return 0;
  const factor = 10 ** digits;
  return Math.floor((numerator / denominator) * 100 * factor + 0.5) / factor;
}

/**
 * 쿠폰 할인액(원).
 *
 * 경계 규칙
 *  - 주문금액 < 최소주문금액 → 0원
 *  - 정액: 할인액이 주문금액을 넘지 않는다(음수 결제 방지)
 *  - 정률: 최대 할인액 상한을 반드시 적용한다(무제한 정률은 사고)
 */
export function discountFor(template: CouponTemplateSpec, orderAmount: number): number {
  if (orderAmount <= 0 || orderAmount < template.minOrderAmount) return 0;

  if (template.discountType === "FIXED") {
    return Math.min(template.discountAmount, orderAmount);
  }

  const raw = roundWon((orderAmount * template.discountRate) / 100);
  const capped = template.maxDiscountAmount > 0 ? Math.min(raw, template.maxDiscountAmount) : raw;

  return Math.max(0, Math.min(capped, orderAmount));
}

/**
 * 가드레일 평가용 "가정 장바구니".
 *
 * 정액 쿠폰은 최소 장바구니에서 마진이 가장 나쁘고, 정률 쿠폰은 할인 상한에 닿는
 * 장바구니부터 마진율이 더 떨어진다. 그래서 정률은 `상한 / 할인율`을 가정한다.
 */
export function assumedOrderAmountForGuard(template: CouponTemplateSpec): number {
  const minimum = Math.max(1, template.minOrderAmount);
  if (template.discountType === "PERCENT" && template.discountRate > 0 && template.maxDiscountAmount > 0) {
    return Math.max(minimum, Math.ceil((template.maxDiscountAmount * 100) / template.discountRate));
  }
  return minimum;
}

export function assessMargin(
  template: CouponTemplateSpec,
  input: MarginInput,
  minimumMarginRate: number,
): MarginAssessment {
  if (!(input.orderAmount > 0) || !(input.productCost > 0)) {
    return {
      evaluated: false,
      orderAmount: input.orderAmount,
      discountAmount: 0,
      netSettlement: 0,
      projectedMargin: 0,
      projectedMarginRate: 0,
      minimumMarginRate,
    };
  }

  const orderAmount = input.orderAmount;
  const feeRatePct = input.feeRatePct ?? 0;
  const shippingCost = input.shippingCost ?? 0;
  const commission = roundWon((orderAmount * feeRatePct) / 100);
  const netSettlement = orderAmount - commission - shippingCost;
  const discount = discountFor(template, orderAmount);
  const projectedMargin = netSettlement - discount - input.productCost;

  return {
    evaluated: true,
    orderAmount,
    discountAmount: discount,
    netSettlement,
    projectedMargin,
    projectedMarginRate: toRate(projectedMargin, orderAmount),
    minimumMarginRate,
  };
}

export function marginPasses(assessment: MarginAssessment): boolean {
  if (!assessment.evaluated) return true;
  return assessment.projectedMargin >= 0 && assessment.projectedMarginRate >= assessment.minimumMarginRate;
}

const ALLOWED_TRANSITIONS: Record<CouponStatus, CouponStatus[]> = {
  ISSUED: ["RESERVED", "CANCELLED", "EXPIRED"],
  RESERVED: ["REDEEMED", "CANCELLED", "EXPIRED"],
  REDEEMED: ["SETTLED"],
  SETTLED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export function canTransition(from: CouponStatus, to: CouponStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: CouponStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

export function holdsInventory(status: CouponStatus): boolean {
  return status === "ISSUED" || status === "RESERVED";
}

/** 16자리 코드의 표시용 마스킹(앞 4 + 별표 8 + 끝 4). 원문은 저장하지 않는다. */
export function maskCouponCode(code: string): string {
  if (code.length < 8) return "****************";
  return `${code.slice(0, 4)}${"*".repeat(8)}${code.slice(-4)}`;
}

/* ─────────────────────────────────────────────────────────────
 * 3. 코드 생성·해시
 * ───────────────────────────────────────────────────────── */

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type CodeGenerator = () => string;

/** 결정적 난수(mulberry32). 테스트·시뮬레이터가 같은 결과를 재현할 수 있게 한다. */
export function seededCodeGenerator(seed: number): CodeGenerator {
  let state = seed >>> 0;
  return () => {
    let code = "";
    for (let i = 0; i < 16; i++) {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      code += CODE_ALPHABET[Math.floor(value * CODE_ALPHABET.length)] ?? "A";
    }
    return code;
  };
}

export const randomCodeGenerator: CodeGenerator = () => {
  const bytes = new Uint8Array(16);
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let code = "";
  for (let i = 0; i < 16; i++) {
    code += CODE_ALPHABET[(bytes[i] ?? 0) % CODE_ALPHABET.length];
  }
  return code;
};

/**
 * SHA-256 hex. 브라우저는 SubtleCrypto(비동기)뿐이라, 원장 해시는 동기 경로에서
 * 계산할 수 있도록 FNV-1a 128비트 확장을 쓴다(데모 한정).
 *
 * 운영에서는 서버(PHP `hash('sha256', …)`)가 해시를 만들고 클라이언트는 받기만 하므로,
 * 이 함수는 "원문을 원장에 남기지 않는다"는 규칙을 데모에서도 지키기 위한 장치다.
 */
export function couponCodeHash(code: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < code.length; i++) {
    const c = code.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  const part = (h: number) => h.toString(16).padStart(8, "0");
  return (part(h1) + part(h2) + part(h1 ^ h2) + part((h1 + h2) >>> 0)).padEnd(64, "0");
}

/* ─────────────────────────────────────────────────────────────
 * 4. 비동기 뮤텍스 — 임계 구역
 * ───────────────────────────────────────────────────────── */

/**
 * 키별 비동기 뮤텍스.
 *
 * 왜 필요한가: 이 엔진의 `issue()`는 async다. 두 요청이 `await` 지점에서 교차하면
 * 둘 다 "잔여 1"을 읽고 둘 다 차감해 재고가 -1이 된다. JS가 단일 스레드라는 사실은
 * **동기 코드**에서만 원자성을 보장하지, await를 사이에 둔 트랜잭션에서는 아무것도
 * 보장하지 않는다. 운영에서는 이 역할을 DB의 조건부 UPDATE(InnoDB 행 락)가 한다.
 */
export class AsyncMutex {
  private tails = new Map<string, Promise<void>>();

  async run<T>(key: string, critical: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();

    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.tails.set(
      key,
      previous.then(() => current),
    );

    await previous;
    try {
      return await critical();
    } finally {
      release();
      if (this.tails.get(key) === undefined) this.tails.delete(key);
    }
  }
}

/* ─────────────────────────────────────────────────────────────
 * 5. 정산 대사 타입
 * ───────────────────────────────────────────────────────── */

export interface SettlementLine {
  /** 쇼핑몰 정산서의 쿠폰 코드(마스킹 또는 해시) */
  couponRef: string;
  /** 쇼핑몰이 차감한 금액(원) */
  mallDiscountAmount: number;
  settlementMonth: string;
  mallSettlementRef: string;
  storeId: number;
}

export type VarianceReason =
  | "MATCHED"
  | "SELLER_OVERBORNE"
  | "PLATFORM_OVERBORNE"
  | "UNKNOWN_COUPON"
  | "DUPLICATE_DISCOUNT"
  | "AMOUNT_MISMATCH";

export interface ReconciliationRow {
  couponRef: string;
  issuedCouponId?: number;
  status: "PENDING" | "MATCHED" | "DISPUTED";
  mallDiscountAmount: number;
  sellerBorne: number;
  platformBorne: number;
  partnerBorne: number;
  variance: number;
  reason: VarianceReason;
  detail: string;
}

export interface ReconciliationReport {
  rows: ReconciliationRow[];
  matched: number;
  disputed: number;
  unknown: number;
  /** 쇼핑몰이 더 뺀 금액(셀러가 돌려받아야 할 돈) */
  sellerRecoverable: number;
  /** 우리가 더 부담한 금액(플랫폼 손실) */
  platformOverborne: number;
}

/* ─────────────────────────────────────────────────────────────
 * 6. 엔진
 * ───────────────────────────────────────────────────────── */

export interface EngineOptions {
  campaigns: CampaignSpec[];
  templates: CouponTemplateSpec[];
  inventories: Array<{ templateId: number; total: number }>;
  now: () => number;
  codeGenerator?: CodeGenerator;
  /** 임계 구역 안에서 마이크로태스크를 양보해 실제 경합을 재현한다(기본 true) */
  yieldInsideCriticalSection?: boolean;
}

export class FlashCouponEngine {
  private campaigns = new Map<number, CampaignSpec>();

  private templates = new Map<number, CouponTemplateSpec>();

  private inventories = new Map<number, InventoryState>();

  private entries: LedgerEntry[] = [];

  private nextEntryId = 1;

  private codeIndex = new Map<string, LedgerEntry>();

  private idempotencyIndex = new Map<string, LedgerEntry>();

  private userIndex = new Map<string, LedgerEntry>();

  private mutex = new AsyncMutex();

  private metrics: EngineMetrics = {
    attempts: 0,
    issued: 0,
    replayed: 0,
    soldOut: 0,
    duplicate: 0,
    marginBlocked: 0,
    budgetExhausted: 0,
    closed: 0,
    contentionRetries: 0,
    avgLatencyMs: 0,
    maxLatencyMs: 0,
  };

  private totalLatency = 0;

  private readonly nowFn: () => number;

  private readonly codeGenerator: CodeGenerator;

  private readonly yieldInside: boolean;

  constructor(options: EngineOptions) {
    options.campaigns.forEach((campaign) => this.campaigns.set(campaign.id, campaign));
    options.templates.forEach((template) => this.templates.set(template.id, template));
    options.inventories.forEach((inventory) => {
      this.inventories.set(inventory.templateId, {
        templateId: inventory.templateId,
        total: inventory.total,
        remaining: inventory.total,
        reserved: 0,
        consumed: 0,
        version: 0,
      });
    });
    this.nowFn = options.now;
    this.codeGenerator = options.codeGenerator ?? randomCodeGenerator;
    this.yieldInside = options.yieldInsideCriticalSection ?? true;
  }

  campaign(id: number): CampaignSpec | undefined {
    return this.campaigns.get(id);
  }

  template(id: number): CouponTemplateSpec | undefined {
    return this.templates.get(id);
  }

  inventory(templateId: number): InventoryState | undefined {
    const state = this.inventories.get(templateId);
    return state ? { ...state } : undefined;
  }

  ledger(): LedgerEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  findEntry(id: number): LedgerEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  findByIdempotencyKey(key: string): LedgerEntry | undefined {
    return this.idempotencyIndex.get(key);
  }

  metricsSnapshot(): EngineMetrics {
    return {
      ...this.metrics,
      avgLatencyMs: this.metrics.attempts === 0 ? 0 : this.totalLatency / this.metrics.attempts,
    };
  }

  /**
   * 쿠폰 발급(핫패스).
   *
   * 순서: 멱등 재전송 → 캠페인/템플릿 → 중복 수령 → 예산 → 마진 가드 → 재고 → 원장 INSERT
   * 이 순서를 바꾸면 "가드레일에서 막힌 요청이 재고를 깎는" 유령 소진이 생긴다.
   */
  async issue(request: IssueRequest): Promise<IssueResponse> {
    const startedAt = performanceNow();
    const now = request.now ?? this.nowFn();

    const result = await this.mutex.run(`template:${request.templateId}`, async () => {
      if (this.yieldInside) {
        // 실제 경합 재현: 임계 구역 안에서 한 번 양보한다. 뮤텍스가 없으면 여기서 교차한다.
        await Promise.resolve();
      }
      return this.issueCritical(request, now);
    });

    const latency = performanceNow() - startedAt;
    this.metrics.attempts += 1;
    this.totalLatency += latency;
    this.metrics.maxLatencyMs = Math.max(this.metrics.maxLatencyMs, latency);
    this.trackOutcome(result.outcome);
    if (result.attempts > 1) this.metrics.contentionRetries += result.attempts - 1;

    return { ...result, lockWaitMs: latency };
  }

  private issueCritical(request: IssueRequest, now: number): IssueResponse {
    const baseMargin: MarginAssessment = {
      evaluated: false,
      orderAmount: 0,
      discountAmount: 0,
      netSettlement: 0,
      projectedMargin: 0,
      projectedMarginRate: 0,
      minimumMarginRate: 0,
    };

    if (
      !Number.isInteger(request.campaignId) ||
      !Number.isInteger(request.templateId) ||
      request.userHash.length < 16 ||
      !request.idempotencyKey
    ) {
      return this.reject("INVALID_REQUEST", "요청 값이 올바르지 않습니다.", baseMargin);
    }

    // ① 멱등 재전송 — 같은 키면 같은 쿠폰(원문 코드는 다시 보내지 않는다)
    const replay = this.idempotencyIndex.get(request.idempotencyKey);
    if (replay) {
      return {
        outcome: "IDEMPOTENT_REPLAY",
        entry: { ...replay },
        margin: baseMargin,
        reason: "같은 멱등 키의 재전송 — 기존 쿠폰을 반환했습니다.",
        attempts: 1,
      };
    }

    // ② 캠페인·템플릿
    const campaign = this.campaigns.get(request.campaignId);
    if (!campaign) return this.reject("CAMPAIGN_CLOSED", "캠페인을 찾을 수 없습니다.", baseMargin);

    const template = this.templates.get(request.templateId);
    if (!template || template.campaignId !== campaign.id) {
      return this.reject("TEMPLATE_INACTIVE", "캠페인에 속하지 않는 템플릿입니다.", baseMargin);
    }

    if (campaign.status !== "live") {
      return this.reject("CAMPAIGN_CLOSED", `캠페인이 ${campaign.status} 상태입니다.`, baseMargin);
    }
    if (now < campaign.startsAt || now >= campaign.endsAt) {
      return this.reject("CAMPAIGN_CLOSED", "응모 가능 시간이 아닙니다.", baseMargin);
    }
    if (!template.isActive) {
      return this.reject("TEMPLATE_INACTIVE", "종료된 쿠폰 템플릿입니다.", baseMargin);
    }

    // ③ 중복 수령
    const userKey = `${template.id}:${request.userHash}`;
    if (this.userIndex.has(userKey)) {
      return this.reject("DUPLICATE_CLAIM", "이미 이 쿠폰을 받은 사용자입니다.", baseMargin);
    }

    // ④ 예산 상한
    const active = this.entries.filter(
      (entry) => entry.campaignId === campaign.id && entry.status !== "CANCELLED" && entry.status !== "EXPIRED",
    );
    const discountTotal = active.reduce((sum, entry) => sum + entry.discountAmount, 0);
    if (
      (campaign.tokenBudget > 0 && active.length >= campaign.tokenBudget) ||
      (campaign.rewardBudget > 0 && discountTotal >= campaign.rewardBudget)
    ) {
      return this.reject("BUDGET_EXHAUSTED", "캠페인 발행 예산/장수 상한을 모두 사용했습니다.", baseMargin);
    }

    // ⑤ 마진 가드레일 — 가정 장바구니 기준(가장 불리한 지점)
    const assumedOrder = request.margin?.orderAmount && request.margin.orderAmount > 0
      ? request.margin.orderAmount
      : assumedOrderAmountForGuard(template);
    const marginInput: MarginInput = {
      orderAmount: assumedOrder,
      productCost: request.margin?.productCost ?? 0,
      shippingCost: request.margin?.shippingCost ?? 0,
      feeRatePct: request.margin?.feeRatePct ?? 0,
    };
    const margin = assessMargin(template, marginInput, campaign.minGuaranteedMargin);

    if (!marginPasses(margin) && campaign.marginGuardMode === "block") {
      return this.reject("MARGIN_GUARD_BLOCKED", marginExplanation(margin), margin);
    }

    // ⑥ 재고 — 조건부 차감(임계 구역 안이므로 원자적)
    const inventory = this.inventories.get(template.id);
    if (!inventory || inventory.remaining < 1) {
      return this.reject("SOLD_OUT", "준비된 수량이 모두 소진되었습니다.", margin, undefined, inventory);
    }

    inventory.remaining -= 1;
    inventory.reserved += 1;
    inventory.version += 1;
    inventory.lastIssuedAt = now;

    // ⑦ 원장 INSERT
    const plainCode = this.codeGenerator();
    const entry: LedgerEntry = {
      id: this.nextEntryId++,
      campaignId: campaign.id,
      templateId: template.id,
      userHash: request.userHash,
      codeHash: couponCodeHash(plainCode),
      maskedCode: maskCouponCode(plainCode),
      status: "ISSUED",
      discountAmount: template.discountType === "FIXED" ? template.discountAmount : 0,
      orderAmount: 0,
      idempotencyKey: request.idempotencyKey,
      issuedAt: now,
      expiresAt: now + template.validityMinutes * 60_000,
    };

    this.entries.push(entry);
    this.idempotencyIndex.set(request.idempotencyKey, entry);
    this.userIndex.set(userKey, entry);
    this.codeIndex.set(entry.codeHash, entry);

    return {
      outcome: "ISSUED",
      entry: { ...entry },
      plainCode,
      margin,
      inventory: { ...inventory },
      reason: "",
      attempts: 1,
    };
  }

  /** 주문에 묶기(ISSUED → RESERVED). 이 시점에 할인액이 확정된다. */
  reserve(
    entryId: number,
    input: { orderAmount: number; orderId: string; now?: number; margin?: Omit<MarginInput, "orderAmount"> },
  ): { ok: boolean; reason: string; entry?: LedgerEntry; margin?: MarginAssessment } {
    const entry = this.entries.find((item) => item.id === entryId);
    if (!entry) return { ok: false, reason: "쿠폰을 찾을 수 없습니다." };

    const now = input.now ?? this.nowFn();

    if (!canTransition(entry.status, "RESERVED")) {
      return { ok: false, reason: `${entry.status} 상태에서는 주문에 묶을 수 없습니다.` };
    }
    if (now >= entry.expiresAt) {
      this.expire(entryId, now);
      return { ok: false, reason: "만료된 쿠폰입니다." };
    }

    const template = this.templates.get(entry.templateId);
    const campaign = this.campaigns.get(entry.campaignId);
    if (!template || !campaign) return { ok: false, reason: "쿠폰 템플릿/캠페인을 찾을 수 없습니다." };

    const discount = discountFor(template, input.orderAmount);
    if (discount === 0 && input.orderAmount > 0) {
      return {
        ok: false,
        reason: `최소 주문금액(${template.minOrderAmount.toLocaleString("ko-KR")}원)을 충족하지 않아 이 쿠폰을 쓸 수 없습니다.`,
      };
    }

    const margin = assessMargin(
      template,
      {
        orderAmount: input.orderAmount,
        productCost: input.margin?.productCost ?? 0,
        shippingCost: input.margin?.shippingCost ?? 0,
        feeRatePct: input.margin?.feeRatePct ?? 0,
      },
      campaign.minGuaranteedMargin,
    );

    if (!marginPasses(margin) && campaign.marginGuardMode === "block") {
      return { ok: false, reason: marginExplanation(margin), margin };
    }

    entry.status = "RESERVED";
    entry.orderAmount = input.orderAmount;
    entry.orderId = input.orderId;
    entry.discountAmount = discount;
    entry.reservedAt = now;

    return { ok: true, reason: "", entry: { ...entry }, margin };
  }

  /** 사용 확정(RESERVED → REDEEMED). 예약 재고를 사용 재고로 옮긴다. */
  redeem(entryId: number, now?: number): { ok: boolean; reason: string; entry?: LedgerEntry } {
    const entry = this.entries.find((item) => item.id === entryId);
    if (!entry) return { ok: false, reason: "쿠폰을 찾을 수 없습니다." };

    const at = now ?? this.nowFn();
    if (!canTransition(entry.status, "REDEEMED")) {
      return { ok: false, reason: `${entry.status} 상태에서는 사용 처리할 수 없습니다.` };
    }
    if (at >= entry.expiresAt) {
      this.expire(entryId, at);
      return { ok: false, reason: "만료된 쿠폰입니다." };
    }

    entry.status = "REDEEMED";
    entry.redeemedAt = at;

    const inventory = this.inventories.get(entry.templateId);
    if (inventory && inventory.reserved > 0) {
      inventory.reserved -= 1;
      inventory.consumed += 1;
      inventory.version += 1;
    }

    return { ok: true, reason: "", entry: { ...entry } };
  }

  /** 정산 반영(REDEEMED → SETTLED). 재고는 변하지 않는다. */
  settle(entryId: number, now?: number): { ok: boolean; reason: string; entry?: LedgerEntry } {
    const entry = this.entries.find((item) => item.id === entryId);
    if (!entry) return { ok: false, reason: "쿠폰을 찾을 수 없습니다." };
    if (!canTransition(entry.status, "SETTLED")) {
      return { ok: false, reason: `${entry.status} 상태에서는 정산할 수 없습니다.` };
    }

    entry.status = "SETTLED";
    entry.settledAt = now ?? this.nowFn();

    return { ok: true, reason: "", entry: { ...entry } };
  }

  /** 취소(ISSUED/RESERVED → CANCELLED). 재고를 정확히 1장 복원한다. */
  cancel(entryId: number, reason: string, now?: number): { ok: boolean; reason: string; entry?: LedgerEntry } {
    const entry = this.entries.find((item) => item.id === entryId);
    if (!entry) return { ok: false, reason: "쿠폰을 찾을 수 없습니다." };

    const from = entry.status;
    if (!canTransition(from, "CANCELLED")) {
      return { ok: false, reason: `${from} 상태는 취소할 수 없습니다(사용·정산된 쿠폰은 정정 이력으로 남깁니다).` };
    }

    entry.status = "CANCELLED";
    entry.cancelReason = reason;
    entry.reservedAt = entry.reservedAt ?? (now ?? this.nowFn());

    if (holdsInventory(from)) {
      const inventory = this.inventories.get(entry.templateId);
      if (inventory && inventory.reserved > 0) {
        inventory.reserved -= 1;
        inventory.remaining += 1;
        inventory.version += 1;
      }
    }

    return { ok: true, reason: "", entry: { ...entry } };
  }

  /** 만료(ISSUED/RESERVED → EXPIRED). 만료 시각이 지난 것만 처리한다. */
  expire(entryId: number, now?: number): { ok: boolean; reason: string; entry?: LedgerEntry } {
    const entry = this.entries.find((item) => item.id === entryId);
    if (!entry) return { ok: false, reason: "쿠폰을 찾을 수 없습니다." };

    const at = now ?? this.nowFn();
    if (!canTransition(entry.status, "EXPIRED")) {
      return { ok: false, reason: `${entry.status} 상태는 만료 처리 대상이 아닙니다.` };
    }
    if (at < entry.expiresAt) {
      return { ok: false, reason: "아직 만료 시각이 지나지 않았습니다." };
    }

    const from = entry.status;
    entry.status = "EXPIRED";

    if (holdsInventory(from)) {
      const inventory = this.inventories.get(entry.templateId);
      if (inventory && inventory.reserved > 0) {
        inventory.reserved -= 1;
        inventory.remaining += 1;
        inventory.version += 1;
      }
    }

    return { ok: true, reason: "", entry: { ...entry } };
  }

  /** 만료 스윕 배치(운영에서는 10초 주기). */
  sweepExpired(now?: number, limit = 500): { expired: number; failed: number; scanned: number } {
    const at = now ?? this.nowFn();
    const due = this.entries
      .filter((entry) => holdsInventory(entry.status) && at >= entry.expiresAt)
      .slice(0, limit);

    let expired = 0;
    let failed = 0;
    for (const entry of due) {
      const result = this.expire(entry.id, at);
      if (result.ok) expired += 1;
      else failed += 1;
    }

    return { expired, failed, scanned: due.length };
  }

  /**
   * 쿠폰 원장 ↔ 쇼핑몰 정산서 대사.
   *
   * 부담 주체 3분할의 합이 쇼핑몰 차감액과 같아야 한다. 어긋나면 그 차액이
   * "셀러가 더 낸 돈"인지 "우리가 더 낸 돈"인지 판정해 이의 제기 근거를 만든다.
   */
  reconcile(lines: SettlementLine[]): ReconciliationReport {
    const rows: ReconciliationRow[] = [];
    const seen = new Set<string>();
    let sellerRecoverable = 0;
    let platformOverborne = 0;

    for (const line of lines) {
      const entry = this.codeIndex.get(line.couponRef) ?? this.entries.find((item) => item.codeHash === line.couponRef);
      const duplicateKey = `${line.settlementMonth}:${line.couponRef}`;

      if (!entry) {
        rows.push({
          couponRef: line.couponRef,
          status: "DISPUTED",
          mallDiscountAmount: line.mallDiscountAmount,
          sellerBorne: 0,
          platformBorne: 0,
          partnerBorne: 0,
          variance: line.mallDiscountAmount,
          reason: "UNKNOWN_COUPON",
          detail: "우리 원장에 없는 쿠폰 코드가 정산서에 청구됐습니다(위조·타사 쿠폰 혼입 의심).",
        });
        continue;
      }

      if (seen.has(duplicateKey)) {
        rows.push({
          couponRef: line.couponRef,
          issuedCouponId: entry.id,
          status: "DISPUTED",
          mallDiscountAmount: line.mallDiscountAmount,
          sellerBorne: 0,
          platformBorne: 0,
          partnerBorne: 0,
          variance: line.mallDiscountAmount,
          reason: "DUPLICATE_DISCOUNT",
          detail: "같은 쿠폰이 한 정산서에서 두 번 차감됐습니다.",
        });
        continue;
      }
      seen.add(duplicateKey);

      const template = this.templates.get(entry.templateId);
      const fundedBy = template?.fundedBy ?? "SELLER";
      const borne = splitBorne(fundedBy, entry.discountAmount);
      const variance = line.mallDiscountAmount - entry.discountAmount;

      let row: ReconciliationRow;
      if (variance === 0) {
        row = {
          couponRef: line.couponRef,
          issuedCouponId: entry.id,
          status: "MATCHED",
          mallDiscountAmount: line.mallDiscountAmount,
          sellerBorne: borne.seller,
          platformBorne: borne.platform,
          partnerBorne: borne.partner,
          variance: 0,
          reason: "MATCHED",
          detail: "부담 주체 3분할 합계가 쇼핑몰 차감액과 일치합니다.",
        };
      } else if (variance > 0 && fundedBy !== "SELLER") {
        row = {
          couponRef: line.couponRef,
          issuedCouponId: entry.id,
          status: "DISPUTED",
          mallDiscountAmount: line.mallDiscountAmount,
          sellerBorne: line.mallDiscountAmount,
          platformBorne: 0,
          partnerBorne: 0,
          variance,
          reason: "SELLER_OVERBORNE",
          detail: `${fundedBy === "PARTNER" ? "제휴사" : "플랫폼"} 부담 쿠폰인데 쇼핑몰이 셀러 부담으로 ${variance.toLocaleString("ko-KR")}원 더 차감했습니다.`,
        };
        sellerRecoverable += variance;
      } else if (variance > 0) {
        row = {
          couponRef: line.couponRef,
          issuedCouponId: entry.id,
          status: "DISPUTED",
          mallDiscountAmount: line.mallDiscountAmount,
          sellerBorne: borne.seller,
          platformBorne: borne.platform,
          partnerBorne: borne.partner,
          variance,
          reason: "SELLER_OVERBORNE",
          detail: `셀러 부담 쿠폰의 차감액이 원장보다 ${variance.toLocaleString("ko-KR")}원 많습니다.`,
        };
        sellerRecoverable += variance;
      } else if (variance < 0 && fundedBy !== "SELLER") {
        row = {
          couponRef: line.couponRef,
          issuedCouponId: entry.id,
          status: "DISPUTED",
          mallDiscountAmount: line.mallDiscountAmount,
          sellerBorne: line.mallDiscountAmount,
          platformBorne: 0,
          partnerBorne: 0,
          variance,
          reason: "PLATFORM_OVERBORNE",
          detail: `쇼핑몰 차감액이 원장보다 ${Math.abs(variance).toLocaleString("ko-KR")}원 적습니다. 차액은 우리(플랫폼)가 부담하게 됩니다.`,
        };
        platformOverborne += Math.abs(variance);
      } else {
        row = {
          couponRef: line.couponRef,
          issuedCouponId: entry.id,
          status: "DISPUTED",
          mallDiscountAmount: line.mallDiscountAmount,
          sellerBorne: borne.seller,
          platformBorne: borne.platform,
          partnerBorne: borne.partner,
          variance,
          reason: "AMOUNT_MISMATCH",
          detail: `쇼핑몰 차감액이 원장과 ${Math.abs(variance).toLocaleString("ko-KR")}원 다릅니다. 부분 차감 여부를 확인해야 합니다.`,
        };
      }

      rows.push(row);
    }

    return {
      rows,
      matched: rows.filter((row) => row.status === "MATCHED").length,
      disputed: rows.filter((row) => row.status === "DISPUTED").length,
      unknown: rows.filter((row) => row.reason === "UNKNOWN_COUPON").length,
      sellerRecoverable,
      platformOverborne,
    };
  }

  /**
   * 가상 트래픽 시뮬레이터.
   *
   * 실제로 N건을 동시에 발급해 보고 결과를 집계한다. 데모 화면의 "초당 TPS / 오버이슈 0건 /
   * 락 경합 방어율" 숫자가 여기서 나온다.
   */
  async simulateTraffic(options: {
    requests: number;
    concurrency?: number;
    campaignId?: number;
    templateId?: number;
    abuseRate?: number;
    seed?: number;
  }): Promise<SimulationReport> {
    const concurrency = Math.max(1, options.concurrency ?? 64);
    const campaignId = options.campaignId ?? [...this.campaigns.keys()][0];
    const templateId = options.templateId ?? [...this.templates.keys()][0];
    const abuseRate = options.abuseRate ?? 0;
    const random = mulberry32(options.seed ?? 42);

    const before = this.inventory(templateId);
    const startedAt = performanceNow();

    let issued = 0;
    let soldOut = 0;
    let duplicate = 0;
    let abuseBlocked = 0;
    let other = 0;

    const makeRequest = (index: number): IssueRequest => {
      const userSeed = `sim-${templateId}-${index}`;
      return {
        campaignId,
        templateId,
        userHash: `user-${index.toString(36).padStart(20, "0")}`,
        idempotencyKey: `sim-key-${templateId}-${index}`,
        now: this.nowFn(),
      };
    };

    const ignored = new Set<number>();
    if (abuseRate > 0) {
      for (let index = 0; index < options.requests; index++) {
        if (random() < abuseRate) {
          ignored.add(index);
          abuseBlocked += 1;
        }
      }
    }

    // 어뷰징으로 걸러진 요청은 발급 경로에 도달하지 않는다(운영에서도 게이트웨이/응모 단계에서 잘린다).
    const live = Array.from({ length: options.requests }, (_, index) => index).filter((index) => !ignored.has(index));

    for (let batchStart = 0; batchStart < live.length; batchStart += concurrency) {
      const batch = live.slice(batchStart, batchStart + concurrency);
      const responses = await Promise.all(batch.map((index) => this.issue(makeRequest(index))));

      responses.forEach((response) => {
        switch (response.outcome) {
          case "ISSUED":
            issued += 1;
            break;
          case "SOLD_OUT":
            soldOut += 1;
            break;
          case "DUPLICATE_CLAIM":
            duplicate += 1;
            break;
          default:
            other += 1;
        }
      });
    }

    const elapsedMs = Math.max(0.001, performanceNow() - startedAt);
    const after = this.inventory(templateId);

    return {
      requests: options.requests,
      elapsedMs,
      tps: (options.requests / elapsedMs) * 1000,
      issued,
      soldOut,
      duplicate,
      abuseBlocked,
      other,
      oversell: after ? Math.max(0, after.reserved + after.consumed - after.total) : 0,
      before: before ?? null,
      after: after ?? null,
      balanced: after ? after.remaining + after.reserved + after.consumed === after.total : false,
    };
  }

  private reject(
    outcome: IssueOutcome,
    reason: string,
    margin: MarginAssessment,
    entry?: LedgerEntry,
    inventory?: InventoryState,
  ): IssueResponse {
    return { outcome, reason, margin, entry, inventory: inventory ? { ...inventory } : undefined, attempts: 1 };
  }

  private trackOutcome(outcome: IssueOutcome): void {
    switch (outcome) {
      case "ISSUED":
        this.metrics.issued += 1;
        break;
      case "IDEMPOTENT_REPLAY":
        this.metrics.replayed += 1;
        break;
      case "SOLD_OUT":
        this.metrics.soldOut += 1;
        break;
      case "DUPLICATE_CLAIM":
        this.metrics.duplicate += 1;
        break;
      case "MARGIN_GUARD_BLOCKED":
        this.metrics.marginBlocked += 1;
        break;
      case "BUDGET_EXHAUSTED":
        this.metrics.budgetExhausted += 1;
        break;
      case "CAMPAIGN_CLOSED":
      case "TEMPLATE_INACTIVE":
        this.metrics.closed += 1;
        break;
      default:
        break;
    }
  }
}

export interface SimulationReport {
  requests: number;
  elapsedMs: number;
  tps: number;
  issued: number;
  soldOut: number;
  duplicate: number;
  abuseBlocked: number;
  other: number;
  oversell: number;
  before: InventoryState | null;
  after: InventoryState | null;
  balanced: boolean;
}

/* ─────────────────────────────────────────────────────────────
 * 7. 보조 함수
 * ───────────────────────────────────────────────────────── */

export function splitBorne(
  fundedBy: FundingParty,
  amount: number,
): { seller: number; platform: number; partner: number } {
  switch (fundedBy) {
    case "PLATFORM":
      return { seller: 0, platform: amount, partner: 0 };
    case "PARTNER":
      return { seller: 0, platform: 0, partner: amount };
    default:
      return { seller: amount, platform: 0, partner: 0 };
  }
}

export function marginExplanation(assessment: MarginAssessment): string {
  if (!assessment.evaluated) return "마진 가드레일: 원가/주문금액이 없어 평가하지 않았습니다.";
  return `주문 ${assessment.orderAmount.toLocaleString("ko-KR")}원 · 할인 ${assessment.discountAmount.toLocaleString("ko-KR")}원 · 정산 ${assessment.netSettlement.toLocaleString("ko-KR")}원 · 예상 마진 ${assessment.projectedMargin.toLocaleString("ko-KR")}원(${assessment.projectedMarginRate.toFixed(2)}%) / 하한 ${assessment.minimumMarginRate.toFixed(2)}%`;
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

function performanceNow(): number {
  const perf = (globalThis as { performance?: { now: () => number } }).performance;
  return perf?.now ? perf.now() : Date.now();
}
