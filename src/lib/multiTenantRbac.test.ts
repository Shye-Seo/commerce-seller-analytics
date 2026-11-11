import { describe, expect, it } from "vitest";
import {
  ACTION_LABELS,
  AuditTrail,
  authorize,
  can,
  DEMO_TENANTS,
  maskAmount,
  maskBusinessNo,
  resolveFieldMask,
  ROLES,
  type AuditEvent,
} from "./multiTenantRbac";

describe("can · 역할별 권한", () => {
  it("대표 관리자는 모든 권한을 갖는다", () => {
    expect(can("MASTER_ADMIN", "export.csv")).toBe(true);
    expect(can("MASTER_ADMIN", "audit.read")).toBe(true);
    expect(can("MASTER_ADMIN", "member.manage")).toBe(true);
  });

  it("정산 담당자는 반출은 되고 감사 로그·구성원 관리는 안 된다", () => {
    expect(can("SETTLEMENT_MANAGER", "export.csv")).toBe(true);
    expect(can("SETTLEMENT_MANAGER", "audit.read")).toBe(false);
    expect(can("SETTLEMENT_MANAGER", "member.manage")).toBe(false);
  });

  it("운영 MD는 반출·원가 열람 권한이 없다", () => {
    expect(can("OPERATION_MD", "export.csv")).toBe(false);
    expect(can("OPERATION_MD", "cost.read")).toBe(false);
    expect(can("OPERATION_MD", "settlement.masked")).toBe(true);
  });
});

describe("authorize · 접근 판정", () => {
  it("소속 법인 데이터는 허용한다", () => {
    const decision = authorize({ role: "SETTLEMENT_MANAGER", activeTenantId: "tn-busan", action: "settlement.amount" });
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBe("ALLOWED");
  });

  it("소속 법인 밖으로는 나갈 수 없다", () => {
    const decision = authorize({
      role: "SETTLEMENT_MANAGER",
      activeTenantId: "tn-busan",
      targetTenantId: "tn-partner",
      action: "settlement.amount",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("TENANT_OUT_OF_SCOPE");
    expect(decision.reason).toContain("위탁사");
  });

  it("대표 관리자는 법인을 넘어 조회할 수 있다", () => {
    const decision = authorize({
      role: "MASTER_ADMIN",
      activeTenantId: "tn-hq",
      targetTenantId: "tn-partner",
      action: "settlement.amount",
    });
    expect(decision.allowed).toBe(true);
  });

  it("MD의 CSV 반출은 권한 사유와 함께 거부된다", () => {
    const decision = authorize({ role: "OPERATION_MD", activeTenantId: "tn-hq", action: "export.csv" });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("ROLE_NOT_ALLOWED");
    expect(decision.reason).toContain(ACTION_LABELS["export.csv"]);
  });

  it("존재하지 않는 법인은 거부한다", () => {
    const decision = authorize({ role: "MASTER_ADMIN", activeTenantId: "tn-ghost", action: "settlement.amount" });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("TENANT_UNKNOWN");
  });

  it("거부된 요청도 감사 로그 적재는 허용한다", () => {
    const decision = authorize({ role: "OPERATION_MD", activeTenantId: "tn-hq", action: "audit.append" });
    expect(decision.allowed).toBe(true);
  });
});

describe("마스킹", () => {
  it("전체 열람은 원 단위 숫자를 그대로 보여 준다", () => {
    expect(maskAmount(1_234_567, "none")).toBe("1,234,567원");
    expect(maskAmount(-5_000, "none")).toBe("-5,000원");
  });

  it("부분 마스킹은 자릿수 규모만 남기고 뒤를 가린다", () => {
    const masked = maskAmount(1_234_567, "partial");
    expect(masked).toBe("₩ 1,***,***");
    expect(masked).not.toContain("567");
    expect(masked).not.toContain("234");
  });

  it("완전 마스킹은 어떤 숫자도 노출하지 않는다", () => {
    const masked = maskAmount(98_765_432, "full");
    expect(masked).toBe("₩ ●●●●●");
    expect(masked).not.toMatch(/\d/);
  });

  it("소액·음수도 안전하게 마스킹한다", () => {
    expect(maskAmount(7, "partial")).toBe("₩ ●●");
    expect(maskAmount(-1_234_567, "partial").startsWith("-")).toBe(true);
  });

  it("MD는 원가를 볼 수 없고 정산액은 부분 마스킹된다", () => {
    expect(resolveFieldMask("OPERATION_MD", "unitCost")).toBe("full");
    expect(resolveFieldMask("OPERATION_MD", "settledAmount")).toBe("partial");
    expect(resolveFieldMask("OPERATION_MD", "netMargin")).toBe("partial");
    expect(resolveFieldMask("SETTLEMENT_MANAGER", "settledAmount")).toBe("none");
    expect(resolveFieldMask("SETTLEMENT_MANAGER", "unitCost")).toBe("none");
  });

  it("사업자번호는 가운데를 가린다", () => {
    expect(maskBusinessNo("123-45-67890", "none")).toBe("123-45-67890");
    expect(maskBusinessNo("123-45-67890", "partial")).toBe("123-**-***90");
    expect(maskBusinessNo("123-45-67890", "full")).toBe("***-**-*****");
    expect(maskBusinessNo("12345", "partial")).toBe("***-**-*****");
  });
});

describe("AuditTrail · 해시 체인", () => {
  const base = { at: Date.parse("2026-11-11T09:00:00Z"), role: "MASTER_ADMIN" as const, tenantId: "tn-hq" };

  function seeded(): AuditTrail {
    const trail = new AuditTrail();
    trail.append({ ...base, action: "ROLE_CHANGE", target: "MASTER_ADMIN", detail: "로그인" });
    trail.append({ ...base, at: base.at + 1_000, action: "RECONCILE_RUN", target: "2026-10 정산서.csv" });
    trail.append({ ...base, at: base.at + 2_000, action: "EXPORT_CSV", target: "settlement.csv" });
    return trail;
  }

  it("이벤트를 순번과 해시로 연결한다", () => {
    const trail = seeded();
    const events = trail.list();

    expect(events).toHaveLength(3);
    expect(events[0]?.seq).toBe(1);
    expect(events[0]?.prevHash).toBe("genesis");
    expect(events[1]?.prevHash).toBe(events[0]?.hash);
    expect(events[2]?.prevHash).toBe(events[1]?.hash);
    expect(events[0]?.hash).toHaveLength(8);
  });

  it("체인 무결성을 검증한다", () => {
    expect(seeded().verify()).toEqual({ valid: true, brokenIndex: null });
  });

  it("중간 이벤트를 변조하면 깨진 위치를 찾아낸다", () => {
    const trail = seeded();
    const tampered = trail.list().map((event) => ({ ...event })) as AuditEvent[];
    const target = tampered[1];
    if (target) target.detail = "내역 삭제";

    const broken = new AuditTrail(tampered);
    expect(broken.verify().valid).toBe(false);
    expect(broken.verify().brokenIndex).toBe(1);
  });

  it("이벤트를 지우면 다음 이벤트의 prevHash가 끊어진다", () => {
    const trail = seeded();
    const truncated = [trail.list()[0], trail.list()[2]] as AuditEvent[];
    const broken = new AuditTrail(truncated);
    expect(broken.verify().valid).toBe(false);
    expect(broken.verify().brokenIndex).toBe(1);
  });

  it("거부된 시도도 outcome=denied로 남는다", () => {
    const trail = new AuditTrail();
    const event = trail.append({ ...base, role: "OPERATION_MD", action: "EXPORT_CSV", target: "x.csv", outcome: "denied" });
    expect(event.outcome).toBe("denied");
    expect(trail.recent(1)[0]?.hash).toBe(event.hash);
  });

  it("CSV 반출은 audit.read 권한자만 가능하다", () => {
    const trail = seeded();
    expect(() => trail.toCsv("OPERATION_MD")).toThrow(/권한이 없습니다/);

    const csv = trail.toCsv("MASTER_ADMIN");
    const lines = csv.split("\n");
    expect(lines[0]).toContain("seq,at,role");
    expect(lines).toHaveLength(4);
  });

  it("데모 테넌트는 본사-지사-위탁사 계층을 이룬다", () => {
    expect(DEMO_TENANTS).toHaveLength(3);
    expect(DEMO_TENANTS.filter((tenant) => tenant.parentId === "tn-hq")).toHaveLength(2);
    expect(DEMO_TENANTS[0]?.tier).toBe("HQ");
    expect(ROLES.MASTER_ADMIN.tenantScope).toBe("all-tenants");
  });
});
