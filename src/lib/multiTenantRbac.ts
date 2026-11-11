/**
 * 멀티 테넌트 · RBAC(역할 기반 접근 제어) 시뮬레이터
 *
 * 왜 필요한가
 * -----------
 * B2B 정산 도구는 "한 사업자"를 위해 만들지 않는다. 본사·지사·위탁사가 같은 데이터에 접근하지만
 * 보아야 하는 범위는 다르다. 대표는 전체 정산액을 봐야 하고, 정산 담당자는 원가와 세무를 보되
 * 다른 법인의 매출은 못 본다. MD는 매출·키워드만 보면 되고, 원가와 정산액은 마스킹되어야 한다.
 *
 * 이 모듈은 그 규칙을 **UI 밖으로 꺼내** 순수 함수로 고정한다. 화면에서 조건문으로 권한을
 * 검사하면 화면이 늘어날 때마다 규칙이 복제되고, 결국 한 화면에서 새어 나간다.
 *
 * 감사 로그(Audit Trail)
 * ----------------------
 * "누가 언제 어떤 금액을 열람/반출했는가"는 B2B 계약의 필수 조항이다. 각 이벤트는 이전 이벤트의
 * 해시를 포함하는 **해시 체인**으로 연결해, 중간 이벤트를 지우거나 고치면 `verify()`가 깨진
 * 지점을 찾아낸다. (블록체인이 아니라 변조 흔적을 남기는 가벼운 장치다)
 */

/** 법인(테넌트) 구분 */
export type TenantTier = "HQ" | "BRANCH" | "CONSIGNMENT";

export interface Tenant {
  id: string;
  name: string;
  /** 사업자등록번호 */
  businessNo: string;
  tier: TenantTier;
  /** 상위 법인 id (본사는 null) */
  parentId: string | null;
  /** 정산 주기 표기 */
  settlementCycle: string;
  /** 연결된 셀러 수 */
  seatCount: number;
}

/**
 * 데모 테넌트.
 * 실제 서비스라면 DB의 조직 테이블이 되고, 여기서는 화면과 테스트가 함께 쓰는 고정 시드다.
 */
export const DEMO_TENANTS: Tenant[] = [
  {
    id: "tn-hq",
    name: "본사 스토어 (주식회사 숭구리커머스)",
    businessNo: "123-45-67890",
    tier: "HQ",
    parentId: null,
    settlementCycle: "월 1회 · 익월 10일",
    seatCount: 14,
  },
  {
    id: "tn-busan",
    name: "부산 지사 (문현 물류센터)",
    businessNo: "234-56-78901",
    tier: "BRANCH",
    parentId: "tn-hq",
    settlementCycle: "월 2회 · 10일/25일",
    seatCount: 6,
  },
  {
    id: "tn-partner",
    name: "위탁사 (협력 셀러 12곳)",
    businessNo: "345-67-89012",
    tier: "CONSIGNMENT",
    parentId: "tn-hq",
    settlementCycle: "월 1회 · 익월 15일",
    seatCount: 12,
  },
];

/** 역할 */
export type RoleId = "MASTER_ADMIN" | "SETTLEMENT_MANAGER" | "OPERATION_MD";

/** 권한 식별자 */
export type PermissionId =
  | "tenant.switch"
  | "settlement.amount"
  | "settlement.masked"
  | "cost.read"
  | "export.csv"
  | "reconcile.run"
  | "audit.read"
  | "member.manage";

/** 마스킹 수준 */
export type MaskLevel = "none" | "partial" | "full";

export interface RoleDefinition {
  id: RoleId;
  label: string;
  /** 좁은 배지용 라벨 */
  shortLabel: string;
  description: string;
  permissions: PermissionId[];
  /** 접근 가능한 테넌트 범위 */
  tenantScope: "all-tenants" | "own-tenant";
  /** 정산 금액 기본 마스킹 수준 */
  amountMask: MaskLevel;
}

/**
 * 역할 정의.
 * 권한은 "추가"가 아니라 "열거"로 적는다. 새 화면을 만들 때 이 목록에 없으면 기본이 거부다
 * (deny by default). 그래야 새 기능이 조용히 열리지 않는다.
 */
export const ROLES: Record<RoleId, RoleDefinition> = {
  MASTER_ADMIN: {
    id: "MASTER_ADMIN",
    label: "대표 관리자",
    shortLabel: "대표",
    description: "전 테넌트 정산·원가·감사 로그 열람, 반출, 구성원 관리까지 가능합니다.",
    permissions: [
      "tenant.switch",
      "settlement.amount",
      "cost.read",
      "export.csv",
      "reconcile.run",
      "audit.read",
      "member.manage",
    ],
    tenantScope: "all-tenants",
    amountMask: "none",
  },
  SETTLEMENT_MANAGER: {
    id: "SETTLEMENT_MANAGER",
    label: "정산 담당자",
    shortLabel: "정산",
    description: "소속 법인의 정산액·원가를 열람하고 대사를 실행·반출합니다. 다른 법인으로 전환할 수 없습니다.",
    permissions: ["settlement.amount", "cost.read", "export.csv", "reconcile.run"],
    tenantScope: "own-tenant",
    amountMask: "none",
  },
  OPERATION_MD: {
    id: "OPERATION_MD",
    label: "운영 MD",
    shortLabel: "MD",
    description: "매출·판매 흐름은 보되 정산액은 부분 마스킹, 원가는 차단됩니다. 반출 권한은 없습니다.",
    permissions: ["settlement.masked", "reconcile.run"],
    tenantScope: "own-tenant",
    amountMask: "partial",
  },
};

export const ROLE_LIST: RoleDefinition[] = [ROLES.MASTER_ADMIN, ROLES.SETTLEMENT_MANAGER, ROLES.OPERATION_MD];

/** 권한이 있는지만 묻는다. */
export function can(role: RoleId, permission: PermissionId): boolean {
  return ROLES[role].permissions.includes(permission);
}

/** 민감 필드 */
export type SensitiveField = "settledAmount" | "commission" | "netMargin" | "unitCost" | "businessNo";

/** 필드별로 이 역할이 어느 수준까지 볼 수 있는가 */
export function resolveFieldMask(role: RoleId, field: SensitiveField): MaskLevel {
  const definition = ROLES[role];
  switch (field) {
    case "businessNo":
      // 사업자번호는 정산 담당자도 소속 법인 것만 전체 열람한다. MD에게는 항상 가린다.
      return role === "OPERATION_MD" ? "full" : "partial";
    case "unitCost":
      return definition.permissions.includes("cost.read") ? "none" : "full";
    case "netMargin":
      return definition.permissions.includes("settlement.amount") ? "none" : "partial";
    case "settledAmount":
    case "commission":
      return definition.amountMask;
    default:
      return "full";
  }
}

/** 금액 마스킹. 부분 마스킹은 자릿수 규모만 남기고 뒤를 가린다. */
export function maskAmount(value: number, level: MaskLevel): string {
  if (!Number.isFinite(value)) return "—";
  if (level === "none") return `${value < 0 ? "-" : ""}${new Intl.NumberFormat("ko-KR").format(Math.abs(Math.round(value)))}원`;
  if (level === "full") return "₩ ●●●●●";

  const rounded = Math.round(Math.abs(value));
  const digits = String(rounded);
  if (digits.length <= 2) return "₩ ●●";
  // 맨 앞 한 자리만 남긴다. 금액 규모(만/십만/백만)는 알 수 있지만 정확한 값은 복원할 수 없다.
  const masked = digits.slice(0, 1) + "*".repeat(digits.length - 1);
  // 자릿수 구분은 숫자와 마스크 문자를 섞은 문자열에도 그대로 적용한다.
  const groups: string[] = [];
  for (let cursor = masked.length; cursor > 0; cursor -= 3) {
    groups.unshift(masked.slice(Math.max(0, cursor - 3), cursor));
  }
  return `${value < 0 ? "-" : ""}₩ ${groups.join(",")}`;
}

/** 사업자번호 마스킹: 123-**-***90 처럼 가운데를 가린다 */
export function maskBusinessNo(value: string, level: MaskLevel): string {
  if (level === "none") return value;
  if (level === "full") return "***-**-*****";
  const compact = value.replace(/[^\d]/g, "");
  if (compact.length !== 10) return "***-**-*****";
  return `${compact.slice(0, 3)}-**-***${compact.slice(-2)}`;
}

export type AccessAction = PermissionId | "audit.append";

export interface AccessRequest {
  role: RoleId;
  /** 사용자가 현재 보고 있는(활성) 테넌트 */
  activeTenantId: string;
  /** 접근하려는 대상 테넌트. 생략하면 활성 테넌트로 본다. */
  targetTenantId?: string;
  action: AccessAction;
}

export type DenyCode =
  | "ROLE_NOT_ALLOWED"
  | "TENANT_OUT_OF_SCOPE"
  | "TENANT_UNKNOWN"
  | "NOT_AUTHENTICATED";

export interface AccessDecision {
  allowed: boolean;
  code: DenyCode | "ALLOWED";
  reason: string;
}

/**
 * 권한 판정. 화면·내보내기·감사 로그가 모두 이 함수 하나를 통과한다.
 * 판정 사유를 문장으로 돌려주기 때문에, 거부 화면에 "왜 안 되는지"를 그대로 쓸 수 있다.
 */
export function authorize(request: AccessRequest, tenants: readonly Tenant[] = DEMO_TENANTS): AccessDecision {
  const role = ROLES[request.role];
  if (!role) {
    return { allowed: false, code: "NOT_AUTHENTICATED", reason: "역할이 지정되지 않았습니다." };
  }

  const targetId = request.targetTenantId ?? request.activeTenantId;
  const target = tenants.find((tenant) => tenant.id === targetId);
  if (!target) {
    return { allowed: false, code: "TENANT_UNKNOWN", reason: `존재하지 않는 법인입니다(${targetId}).` };
  }

  // 테넌트 범위: 전 테넌트 권한이 없으면 활성 테넌트 밖으로 나갈 수 없다.
  if (role.tenantScope === "own-tenant" && targetId !== request.activeTenantId) {
    return {
      allowed: false,
      code: "TENANT_OUT_OF_SCOPE",
      reason: `${role.label}는 ${target.name} 데이터에 접근할 수 없습니다. 소속 법인 데이터만 열람합니다.`,
    };
  }

  if (request.action === "audit.append") {
    // 감사 로그 적재는 모든 인증된 역할이 할 수 있다(거부 기록도 남아야 하므로).
    return { allowed: true, code: "ALLOWED", reason: "감사 로그는 모든 역할이 기록할 수 있습니다." };
  }

  if (!role.permissions.includes(request.action)) {
    return {
      allowed: false,
      code: "ROLE_NOT_ALLOWED",
      reason: `${role.label}에게는 '${ACTION_LABELS[request.action]}' 권한이 없습니다.`,
    };
  }

  return { allowed: true, code: "ALLOWED", reason: `${role.label} 권한으로 허용되었습니다.` };
}

export const ACTION_LABELS: Record<PermissionId, string> = {
  "tenant.switch": "법인 전환",
  "settlement.amount": "정산 금액 열람",
  "settlement.masked": "마스킹된 정산 금액 열람",
  "cost.read": "매입원가 열람",
  "export.csv": "CSV 반출",
  "reconcile.run": "대사 실행",
  "audit.read": "감사 로그 열람",
  "member.manage": "구성원 관리",
};

/* ------------------------------------------------------------------ */
/* 감사 로그                                                           */
/* ------------------------------------------------------------------ */

export type AuditAction =
  | "TENANT_SWITCH"
  | "ROLE_CHANGE"
  | "RECONCILE_RUN"
  | "VIEW_ANOMALY"
  | "VIEW_ROW"
  | "EXPORT_CSV"
  | "AUDIT_VIEW";

export type AuditOutcome = "allowed" | "denied";

export interface AuditEvent {
  /** 순번(1부터) */
  seq: number;
  /** ISO 시각 */
  at: string;
  role: RoleId;
  tenantId: string;
  action: AuditAction;
  /** 대상(주문번호, 파일명 등) */
  target: string;
  detail: string;
  outcome: AuditOutcome;
  /** 이 이벤트의 해시 */
  hash: string;
  /** 직전 이벤트의 해시(체인의 시작은 "genesis") */
  prevHash: string;
}

export interface AuditAppendInput {
  at: number;
  role: RoleId;
  tenantId: string;
  action: AuditAction;
  target: string;
  detail?: string;
  outcome?: AuditOutcome;
}

/** FNV-1a 32bit — 의존성 없는 결정적 해시 */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * 변조 흔적을 남기는 감사 로그.
 * 이벤트를 지우면 뒤 이벤트의 prevHash가 끊어져 `verify()`가 실패한다.
 */
export class AuditTrail {
  private events: AuditEvent[] = [];

  constructor(seed: readonly AuditEvent[] = []) {
    this.events = seed.map((event) => ({ ...event }));
  }

  get size(): number {
    return this.events.length;
  }

  /** 로그 추가. 반환값은 해시가 붙은 완성 이벤트. */
  append(input: AuditAppendInput): AuditEvent {
    const previous = this.events[this.events.length - 1];
    const seq = this.events.length + 1;
    const prevHash = previous?.hash ?? "genesis";
    const payload = {
      seq,
      at: new Date(input.at).toISOString(),
      role: input.role,
      tenantId: input.tenantId,
      action: input.action,
      target: input.target,
      detail: input.detail ?? "",
      outcome: input.outcome ?? "allowed",
      prevHash,
    };
    const hash = fnv1a(JSON.stringify(payload));
    const event: AuditEvent = { ...payload, hash };
    this.events.push(event);
    return event;
  }

  list(): readonly AuditEvent[] {
    return this.events;
  }

  /** 최근 n개 (최신이 뒤) */
  recent(count = 8): AuditEvent[] {
    return this.events.slice(-Math.max(0, count));
  }

  /** 체인 무결성 검증. 깨진 첫 인덱스(0-based)를 돌려준다. */
  verify(): { valid: boolean; brokenIndex: number | null } {
    let prevHash = "genesis";
    for (let index = 0; index < this.events.length; index += 1) {
      const event = this.events[index];
      if (!event) return { valid: false, brokenIndex: index };
      const payload = {
        seq: event.seq,
        at: event.at,
        role: event.role,
        tenantId: event.tenantId,
        action: event.action,
        target: event.target,
        detail: event.detail,
        outcome: event.outcome,
        prevHash,
      };
      if (event.prevHash !== prevHash) return { valid: false, brokenIndex: index };
      if (fnv1a(JSON.stringify(payload)) !== event.hash) return { valid: false, brokenIndex: index };
      prevHash = event.hash;
    }
    return { valid: true, brokenIndex: null };
  }

  /** 반출용 CSV. `audit.read` 권한이 없으면 거부한다. */
  toCsv(role: RoleId): string {
    const decision = authorize({ role, activeTenantId: "tn-hq", action: "audit.read" });
    if (!decision.allowed) throw new Error(decision.reason);

    const header = "seq,at,role,tenantId,action,target,outcome,detail,hash";
    const lines = this.events.map((event) =>
      [event.seq, event.at, event.role, event.tenantId, event.action, event.target, event.outcome, event.detail, event.hash]
        .map((value) => {
          const text = String(value);
          return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(","),
    );
    return [header, ...lines].join("\n");
  }
}
