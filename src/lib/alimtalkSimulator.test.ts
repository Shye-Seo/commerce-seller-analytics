import { describe, expect, it } from "vitest";
import {
  ALIMTALK_MAX_CONTENT_LENGTH,
  MAX_ALERTS_PER_ORDER,
  MAX_SEND_ATTEMPTS,
  SEND_SCENARIOS,
  SensSimulatedError,
  SensSimulator,
  collectCriticalAlerts,
  composeAnomalyContent,
  composeSummaryContent,
  dedupeKeyForAnomaly,
  dedupeKeyForSummary,
  dispatchAnomalyAlerts,
  dispatchBatchSummary,
  normalizeRecipientPhone,
  retryAlimtalk,
  summarizeAlimtalkLogs,
  templateLine,
  type AlimtalkLogEntry,
} from "./alimtalkSimulator";
import { reconcileSettlement } from "./reconciliationEngine";
import { generateSettlementRows } from "./settlementFixtures";

const PHONE = normalizeRecipientPhone("010-1234-5678");

function baseLog(overrides: Partial<AlimtalkLogEntry> = {}): AlimtalkLogEntry {
  return {
    id: "alt-00001",
    dedupeKey: dedupeKeyForAnomaly(1, "SS2026100001", "FEE_OVERCHARGE"),
    tenantId: 1,
    tenantName: "셀러스코프 데모",
    batchId: "batch-test",
    templateCode: "SS_ANOMALY_CRITICAL",
    plusFriendId: "@sellerscope",
    recipientDigits: PHONE.digits,
    recipientMasked: PHONE.masked,
    orderNo: "SS2026100001",
    anomalyCode: "FEE_OVERCHARGE",
    content: "[셀러스코프 데모] 정산 이상 감지 - 수수료 초과 청구",
    status: "queued",
    attempts: 0,
    createdAt: 1,
    updatedAt: 1,
    simulated: true,
    ...overrides,
  };
}

describe("normalizeRecipientPhone", () => {
  it("하이픈·공백을 제거하고 마스킹 표기를 만든다", () => {
    expect(normalizeRecipientPhone("010-1234-5678")).toEqual({ digits: "01012345678", masked: "010-****-5678" });
    expect(normalizeRecipientPhone(" 010 9876 5432 ")).toEqual({ digits: "01098765432", masked: "010-****-5432" });
  });

  it("+82·0082 표기를 국내 형식으로 되돌린다", () => {
    expect(normalizeRecipientPhone("+821012345678").digits).toBe("01012345678");
    expect(normalizeRecipientPhone("00821012345678").digits).toBe("01012345678");
    expect(normalizeRecipientPhone("821012345678").digits).toBe("01012345678");
  });

  it("국내 휴대폰 형식이 아니면 즉시 실패한다", () => {
    expect(() => normalizeRecipientPhone("02-123-4567")).toThrow(/국내 휴대폰/);
    expect(() => normalizeRecipientPhone("010-1234")).toThrow(/국내 휴대폰/);
  });
});

describe("템플릿 본문 합성", () => {
  it("이상 알림 본문은 PHP composer와 같은 형식이다", () => {
    const content = composeAnomalyContent({
      tenantName: "셀러스코프 데모",
      orderNo: "SS2026100001",
      productName: "데일리 코튼 셔츠",
      anomalyCode: "FEE_OVERCHARGE",
      anomalyLabel: "수수료 초과 청구",
      expected: 3_229,
      actual: 3_900,
      loss: 671,
      detail: "계약 10.8% 기준 3,229원이어야 하는데 3,900원이 청구됐습니다.",
    });

    expect(content).toBe(
      [
        "[셀러스코프 데모] 정산 이상 감지 - 수수료 초과 청구",
        "주문 SS2026100001 · 데일리 코튼 셔츠",
        "기대 3,229원 / 정산 3,900원",
        "추정 손실 671원",
        "계약 10.8% 기준 3,229원이어야 하는데 3,900원이 청구됐습니다.",
        "정산 담당자 확인이 필요합니다.",
      ].join("\n"),
    );
  });

  it("변수에는 개행을 넣지 않고 길면 자른다", () => {
    expect(templateLine("첫 줄\n둘째 줄")).toBe("첫 줄 둘째 줄");
    expect(templateLine("가".repeat(100), 10)).toBe(`${"가".repeat(9)}…`);
  });

  it("요약 본문은 최대 원인이 없으면 '없음'으로 적는다", () => {
    const content = composeSummaryContent({
      tenantName: "셀러스코프 데모",
      batchLabel: "데모 원장",
      totalRows: 1_200,
      flaggedRows: 0,
      totalLeak: 0,
      topCause: null,
    });

    expect(content).toContain("대상 1,200건 · 이상 0건");
    expect(content).toContain("최대 원인 없음");
    expect(content).toContain("추정 손실 0원");
  });

  it("본문은 1,000자를 넘지 않는다", () => {
    const content = composeAnomalyContent({
      tenantName: "x".repeat(100),
      orderNo: "O".repeat(100),
      productName: "y".repeat(100),
      anomalyCode: "SETTLEMENT_SHORTFALL",
      anomalyLabel: "z".repeat(100),
      expected: 1,
      actual: 0,
      loss: 1,
      detail: "d".repeat(5_000),
    });

    expect(content.length).toBeLessThanOrEqual(ALIMTALK_MAX_CONTENT_LENGTH);
  });
});

describe("SensSimulator", () => {
  const message = { to: PHONE.digits, content: "테스트", templateCode: "SS_ANOMALY_CRITICAL" as const, plusFriendId: "@sellerscope" };

  it("정상 시나리오는 accepted(202)와 요청·메시지 아이디를 돌려준다", () => {
    const result = new SensSimulator({ scenario: "success", seed: "fixed" }).send(message);
    expect(result.status).toBe("accepted");
    expect(result.statusCode).toBe("0000");
    expect(result.requestId).toMatch(/^req-/);
    expect(result.messageId).toMatch(/^msg-/);
    expect(result.simulated).toBe(true);
  });

  it("3005(수신 결과 불확실)는 성공으로 세지 않고 sent로 남긴다", () => {
    const result = new SensSimulator({ scenario: "ack-timeout" }).send(message);
    expect(result.status).toBe("sent");
    expect(result.statusCode).toBe("3005");
  });

  it("템플릿 불일치는 3016으로 실패하고 재시도 불가로 표시된다", () => {
    try {
      new SensSimulator({ scenario: "template-mismatch" }).send(message);
      throw new Error("예외가 발생해야 한다");
    } catch (error) {
      expect(error).toBeInstanceOf(SensSimulatedError);
      expect((error as SensSimulatedError).code).toBe("3016");
      expect((error as SensSimulatedError).retryable).toBe(false);
    }
  });

  it("빈 본문은 발송 전에 거부한다", () => {
    expect(() => new SensSimulator().send({ ...message, content: "   " })).toThrow(/본문이 비어/);
  });

  it("시나리오 목록에 6가지 응답이 있다", () => {
    expect(SEND_SCENARIOS.map((item) => item.id)).toEqual([
      "success",
      "ack-timeout",
      "template-mismatch",
      "auth-failure",
      "rate-limit",
      "sms-failover",
    ]);
  });
});

describe("dispatchAnomalyAlerts", () => {
  const alerts = [
    {
      tenantName: "셀러스코프 데모",
      orderNo: "SS2026100001",
      productName: "데일리 코튼 셔츠",
      anomalyCode: "FEE_OVERCHARGE" as const,
      anomalyLabel: "수수료 초과 청구",
      expected: 3_229,
      actual: 3_900,
      loss: 671,
      detail: "수수료가 더 청구됐습니다.",
    },
  ];

  it("발송 성공 시 accepted 이력을 남기고 attempts=1이다", () => {
    const result = dispatchAnomalyAlerts({
      logs: [],
      alerts,
      to: PHONE,
      config: { tenantId: 1, plusFriendId: "@sellerscope" },
      gateway: new SensSimulator({ scenario: "success" }),
      now: 1_000,
      batchId: "batch-1",
    });

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]?.status).toBe("accepted");
    expect(result.logs[0]?.attempts).toBe(1);
    expect(result.logs[0]?.recipientMasked).toBe("010-****-5678");
  });

  it("같은 주문·같은 원인은 dedupe_key로 두 번 보내지 않는다", () => {
    const first = dispatchAnomalyAlerts({
      logs: [],
      alerts,
      to: PHONE,
      config: { tenantId: 1, plusFriendId: "@sellerscope" },
      gateway: new SensSimulator(),
      now: 1_000,
      batchId: "batch-1",
    });

    const second = dispatchAnomalyAlerts({
      logs: first.logs,
      alerts,
      to: PHONE,
      config: { tenantId: 1, plusFriendId: "@sellerscope" },
      gateway: new SensSimulator(),
      now: 2_000,
      batchId: "batch-1",
    });

    expect(second.sent).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.logs).toHaveLength(1);
  });

  it("실패하면 failed로 남고 오류 코드가 기록된다", () => {
    const result = dispatchAnomalyAlerts({
      logs: [],
      alerts,
      to: PHONE,
      config: { tenantId: 1, plusFriendId: "@sellerscope" },
      gateway: new SensSimulator({ scenario: "template-mismatch" }),
      now: 1_000,
      batchId: "batch-1",
    });

    expect(result.failed).toBe(1);
    expect(result.errors[0]).toMatch(/3016/);
    expect(result.logs[0]?.status).toBe("failed");
    expect(result.logs[0]?.statusCode).toBe("3016");
  });

  it("배치 요약은 같은 배치에 한 통만 나간다", () => {
    const summary = { totalRows: 100, flaggedRows: 5, totalLeak: 24_000, topCause: "FEE_OVERCHARGE 24,000원" };
    const first = dispatchBatchSummary({
      logs: [],
      summary,
      to: PHONE,
      config: { tenantId: 1, plusFriendId: "@sellerscope" },
      gateway: new SensSimulator(),
      now: 1_000,
      batchId: "batch-1",
      batchLabel: "데모 원장",
    });
    const second = dispatchBatchSummary({
      logs: first.logs,
      summary,
      to: PHONE,
      config: { tenantId: 1, plusFriendId: "@sellerscope" },
      gateway: new SensSimulator(),
      now: 2_000,
      batchId: "batch-1",
      batchLabel: "데모 원장",
    });

    expect(first.sent).toBe(1);
    expect(second.skipped).toBe(1);
    expect(dedupeKeyForSummary(1, "batch-1")).toContain("summary:1:batch-1");
  });
});

describe("retryAlimtalk", () => {
  it("일시 오류(429)는 재시도에서 성공한다", () => {
    const logs = [baseLog({ status: "failed", attempts: 1, statusCode: "429", error: "Too many requests" })];
    const result = retryAlimtalk({ logs, logId: "alt-00001", gateway: new SensSimulator({ scenario: "success" }), now: 5 });

    expect(result.log?.status).toBe("accepted");
    expect(result.log?.attempts).toBe(2);
    expect(result.log?.error).toBeUndefined();
  });

  it("템플릿 오류는 재시도해도 실패로 남는다", () => {
    const logs = [baseLog({ status: "failed", attempts: 1, statusCode: "3016" })];
    const result = retryAlimtalk({ logs, logId: "alt-00001", gateway: new SensSimulator({ scenario: "template-mismatch" }), now: 5 });

    expect(result.log?.status).toBe("failed");
    expect(result.log?.attempts).toBe(2);
    expect(result.log?.statusCode).toBe("3016");
  });

  it(`재시도는 ${MAX_SEND_ATTEMPTS}회를 넘지 않는다`, () => {
    const logs = [baseLog({ status: "failed", attempts: MAX_SEND_ATTEMPTS })];
    const result = retryAlimtalk({ logs, logId: "alt-00001", gateway: new SensSimulator(), now: 5 });

    expect(result.reason).toMatch(/상한/);
    expect(result.log?.attempts).toBe(MAX_SEND_ATTEMPTS);
  });

  it("이미 발송이 끝난 건은 재시도하지 않는다", () => {
    const logs = [baseLog({ status: "accepted", attempts: 1 })];
    const result = retryAlimtalk({ logs, logId: "alt-00001", gateway: new SensSimulator(), now: 5 });
    expect(result.reason).toMatch(/이미 발송/);
  });
});

describe("collectCriticalAlerts", () => {
  it("심각도 critical만 모으고 주문당 상한을 지킨다", () => {
    const reconciled = reconcileSettlement(generateSettlementRows({ count: 300, seed: 20261111 }));
    const alerts = collectCriticalAlerts(reconciled.rows);

    expect(alerts.length).toBeGreaterThan(0);

    const perOrder = new Map<string, number>();
    for (const alert of alerts) {
      perOrder.set(alert.orderNo, (perOrder.get(alert.orderNo) ?? 0) + 1);
    }
    for (const count of perOrder.values()) {
      expect(count).toBeLessThanOrEqual(MAX_ALERTS_PER_ORDER);
    }
  });
});

describe("summarizeAlimtalkLogs", () => {
  it("성공률은 확정 성공만 세고 3005(불확실)는 제외한다", () => {
    const stats = summarizeAlimtalkLogs([
      baseLog({ id: "a", status: "accepted" }),
      baseLog({ id: "b", status: "sent" }),
      baseLog({ id: "c", status: "failed" }),
      baseLog({ id: "d", status: "queued" }),
    ]);

    expect(stats.total).toBe(4);
    expect(stats.accepted).toBe(1);
    expect(stats.uncertain).toBe(1);
    expect(stats.queued).toBe(1);
    expect(stats.successRate).toBe(33.3);
  });
});
