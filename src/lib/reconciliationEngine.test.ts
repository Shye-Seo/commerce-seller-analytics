import { describe, expect, it } from "vitest";
import {
  ANOMALY_META,
  biggestLeakCause,
  CHANNEL_CONTRACTS,
  reconcileRow,
  reconcileSettlement,
  reconcileSettlementInBatches,
  roundWon,
  summarizeReconciliation,
  toRate,
  type ContractTerms,
  type MarketChannel,
  type SettlementRow,
} from "./reconciliationEngine";
import { generateSettlementRows } from "./settlementFixtures";

/** 계약대로 정산된 기준 행 (스마트스토어, 결제 27,900원) */
function cleanRow(overrides: Partial<SettlementRow> = {}): SettlementRow {
  const base: SettlementRow = {
    orderNo: "SS0001",
    channel: "smartstore",
    orderDate: "2026-10-15",
    productName: "소이 캔들 200g · 우드윅",
    sku: "SG-CANDLE-01",
    quantity: 1,
    paidAmount: 27_900,
    commission: 1_013, // 27,900 × 3.63% = 1,012.77 → 1,013
    shippingDeduction: 3_000,
    returnFee: 0,
    settledAmount: 23_887, // 27,900 - 1,013 - 3,000
    contractFeeRate: 3.63,
    unitCost: 12_800,
    sellerShippingCost: 2_800,
    status: "배송완료",
  };
  return { ...base, ...overrides };
}

describe("roundWon · toRate", () => {
  it("원 단위로 반올림하고 -0을 만들지 않는다", () => {
    expect(roundWon(1012.77)).toBe(1013);
    expect(roundWon(0.4)).toBe(0);
    expect(Object.is(roundWon(-0.4), 0)).toBe(true);
    expect(roundWon(Number.NaN)).toBe(0);
  });

  it("0으로 나누면 0을 돌려준다", () => {
    expect(toRate(100, 0)).toBe(0);
    expect(toRate(1, 3)).toBe(33.33);
  });
});

describe("reconcileRow · 정상 정산", () => {
  it("계약대로 정산된 행은 이상 없이 통과하고 마진이 계산된다", () => {
    const result = reconcileRow(cleanRow());

    expect(result.expectedCommission).toBe(1_013);
    expect(result.expectedShippingDeduction).toBe(3_000);
    expect(result.expectedSettlement).toBe(23_887);
    expect(result.variance).toBe(0);
    expect(result.shortfall).toBe(0);
    expect(result.loss).toBe(0);
    expect(result.anomalies).toEqual([]);
    expect(result.reconciled).toBe(true);
    expect(result.netMargin).toBe(8_287); // 23,887 - 12,800 - 2,800
    expect(result.marginRate).toBe(29.7);
  });

  it("실효 수수료율은 청구 수수료를 결제금액으로 나눈 값이다", () => {
    const result = reconcileRow(cleanRow());
    expect(result.effectiveFeeRate).toBe(3.63);
  });
});

describe("reconcileRow · 수수료 이상", () => {
  it("계약 수수료율을 넘게 청구하면 초과분을 손실로 귀속한다", () => {
    // 1,313원 청구 = 계약(1,013) 대비 +300원, 정산액도 300원 적게 입금
    const result = reconcileRow(cleanRow({ commission: 1_313, settledAmount: 23_587 }));
    const anomaly = result.anomalies.find((item) => item.code === "FEE_OVERCHARGE");

    expect(anomaly).toBeDefined();
    expect(anomaly?.loss).toBe(300);
    expect(anomaly?.expected).toBe(1_013);
    expect(anomaly?.actual).toBe(1_313);
    expect(result.shortfall).toBe(300);
    expect(result.loss).toBe(300);
    expect(result.reconciled).toBe(false);
  });

  it("계약보다 적게 청구하면 과소 청구로 표시하되 손실은 0이다", () => {
    const result = reconcileRow(cleanRow({ commission: 500, settledAmount: 24_400 }));
    const anomaly = result.anomalies.find((item) => item.code === "FEE_UNDERCHARGE");

    expect(anomaly).toBeDefined();
    expect(anomaly?.severity).toBe("info");
    expect(anomaly?.loss).toBe(0);
    expect(result.shortfall).toBe(0);
  });

  it("100원 이하의 수수료 차이는 반올림 허용 범위로 본다", () => {
    const result = reconcileRow(cleanRow({ commission: 1_080, settledAmount: 23_820 }));
    expect(result.anomalies.some((item) => item.code === "FEE_OVERCHARGE")).toBe(false);
  });

  it("취소 주문에 수수료가 붙으면 전액을 손실로 잡는다", () => {
    const result = reconcileRow(
      cleanRow({ status: "취소", paidAmount: 20_000, commission: 2_000, shippingDeduction: 0, settledAmount: -2_000 }),
    );
    const anomaly = result.anomalies.find((item) => item.code === "FEE_ON_CANCELED_ORDER");

    expect(anomaly?.loss).toBe(2_000);
    expect(anomaly?.expected).toBe(0);
    expect(result.expectedSettlement).toBe(0);
    expect(result.loss).toBe(2_000);
  });
});

describe("reconcileRow · 배송·반품 이상", () => {
  it("반품 왕복 배송비를 2배 차감하면 초과분을 중복 차감으로 잡는다", () => {
    const result = reconcileRow(
      cleanRow({
        channel: "coupang",
        status: "반품완료",
        paidAmount: 30_000,
        commission: 0,
        shippingDeduction: 0,
        returnFee: 11_200,
        settledAmount: -11_200,
        contractFeeRate: CHANNEL_CONTRACTS.coupang.feeRate,
      }),
    );
    const anomaly = result.anomalies.find((item) => item.code === "RETURN_FEE_DOUBLE_CHARGED");

    expect(result.expectedReturnFee).toBe(5_600);
    expect(anomaly?.loss).toBe(5_600);
    expect(result.expectedSettlement).toBe(-5_600);
    expect(result.actualSettlement).toBe(-11_200);
    expect(result.shortfall).toBe(5_600);
  });

  it("배송완료 주문에 반품비가 붙으면 그 금액을 손실로 잡는다", () => {
    const result = reconcileRow(cleanRow({ returnFee: 3_000, settledAmount: 20_887 }));
    const anomaly = result.anomalies.find((item) => item.code === "RETURN_FEE_ON_SHIPPED_ORDER");

    expect(anomaly?.loss).toBe(3_000);
    expect(result.shortfall).toBe(3_000);
  });

  it("계약 배송비보다 많이 차감하면 초과분을 잡는다", () => {
    const result = reconcileRow(cleanRow({ shippingDeduction: 5_500, settledAmount: 21_387 }));
    const anomaly = result.anomalies.find((item) => item.code === "SHIPPING_OVERCHARGE");

    expect(anomaly?.loss).toBe(2_500);
    expect(anomaly?.expected).toBe(3_000);
    expect(anomaly?.actual).toBe(5_500);
  });

  it("쿠팡처럼 계약 배송비가 0원인 채널은 0원 초과분을 모두 차감으로 본다", () => {
    const result = reconcileRow(
      cleanRow({
        channel: "coupang",
        paidAmount: 30_000,
        commission: 3_240,
        shippingDeduction: 3_000,
        settledAmount: 23_760,
        contractFeeRate: CHANNEL_CONTRACTS.coupang.feeRate,
      }),
    );
    const anomaly = result.anomalies.find((item) => item.code === "SHIPPING_OVERCHARGE");
    expect(anomaly?.loss).toBe(3_000);
  });
});

describe("reconcileRow · 정산 차액", () => {
  it("원인으로 설명되지 않는 부족액은 SETTLEMENT_SHORTFALL로 남긴다", () => {
    const result = reconcileRow(cleanRow({ settledAmount: 22_387 }));
    const anomaly = result.anomalies.find((item) => item.code === "SETTLEMENT_SHORTFALL");

    expect(anomaly?.loss).toBe(1_500);
    expect(anomaly?.detail).toContain("1,500");
    expect(result.loss).toBe(1_500);
  });

  it("10원 이하 차이는 반올림 누수로 분류한다", () => {
    const result = reconcileRow(cleanRow({ settledAmount: 23_884 }));
    const anomaly = result.anomalies.find((item) => item.code === "ROUNDING_LEAK");

    expect(anomaly?.loss).toBe(3);
    expect(result.anomalies.some((item) => item.code === "SETTLEMENT_SHORTFALL")).toBe(false);
  });

  it("기대보다 많이 입금되면 초과 입금으로 표시하고 손실은 0이다", () => {
    const result = reconcileRow(cleanRow({ settledAmount: 28_887 }));
    const anomaly = result.anomalies.find((item) => item.code === "SETTLEMENT_SURPLUS");

    expect(anomaly).toBeDefined();
    expect(result.surplus).toBe(5_000);
    expect(result.loss).toBe(0);
  });
});

describe("reconcileRow · 마진 이상", () => {
  it("정산액이 원가·배송원가보다 적으면 역마진으로 표시한다", () => {
    const result = reconcileRow(
      cleanRow({
        paidAmount: 10_000,
        commission: 363,
        shippingDeduction: 3_000,
        settledAmount: 6_637,
        unitCost: 9_000,
        sellerShippingCost: 2_500,
      }),
    );
    const anomaly = result.anomalies.find((item) => item.code === "NEGATIVE_MARGIN");

    expect(anomaly).toBeDefined();
    expect(result.netMargin).toBe(-4_863); // 6,637 - 9,000 - 2,500
    expect(result.marginRate).toBeLessThan(0);
    // 역마진은 노출액이지 추가 손실이 아니다. 손실은 정산 차액(0)만 센다.
    expect(result.loss).toBe(0);
  });

  it("반품 건은 마진이 마이너스여도 역마진으로 중복 표시하지 않는다", () => {
    const result = reconcileRow(
      cleanRow({ status: "반품완료", commission: 0, shippingDeduction: 0, returnFee: 5_000, settledAmount: -5_000 }),
    );
    expect(result.anomalies.some((item) => item.code === "NEGATIVE_MARGIN")).toBe(false);
  });

  it("매입원가가 0이면 원장 누락으로 표시한다", () => {
    const result = reconcileRow(cleanRow({ unitCost: 0 }));
    expect(result.anomalies.some((item) => item.code === "MISSING_LEDGER")).toBe(true);
    expect(result.reconciled).toBe(false);
    expect(result.loss).toBe(0);
  });
});

describe("reconcileRow · 손실 이중 계산 금지", () => {
  it("여러 원인이 겹쳐도 원인별 손실 합계가 부족분을 넘지 않는다", () => {
    // 수수료 +300, 배송비 +2,500, 반품비 +3,000 → 부족분은 5,800원
    const result = reconcileRow(
      cleanRow({
        commission: 1_313,
        shippingDeduction: 5_500,
        returnFee: 3_000,
        settledAmount: 23_887 - 5_800,
      }),
    );
    const anomalyLossSum = result.anomalies.reduce((sum, item) => sum + item.loss, 0);

    expect(result.shortfall).toBe(5_800);
    expect(anomalyLossSum).toBe(5_800);
    expect(result.loss).toBe(5_800);
    expect(result.anomalies.length).toBeGreaterThanOrEqual(3);
  });

  it("원인 금액이 부족분보다 크면 부족분까지만 귀속한다", () => {
    // 수수료는 +300원 초과인데 정산은 100원만 부족한 경우
    const result = reconcileRow(cleanRow({ commission: 1_313, settledAmount: 23_787 }));
    const anomaly = result.anomalies.find((item) => item.code === "FEE_OVERCHARGE");

    expect(result.shortfall).toBe(100);
    expect(anomaly?.loss).toBe(100);
  });
});

describe("summarizeReconciliation", () => {
  const rows = reconcileSettlement([
    cleanRow({ orderNo: "A1" }),
    cleanRow({ orderNo: "A2", settledAmount: 23_887 }),
    cleanRow({ orderNo: "A3", channel: "coupang", contractFeeRate: 10.8, commission: 3_013, shippingDeduction: 0, settledAmount: 24_887, sku: "SG-MUG-01" }),
    cleanRow({ orderNo: "A4", settledAmount: 22_387, sku: "SG-BAG-01" }),
  ]);

  it("정상 대사율과 합계를 계산한다", () => {
    expect(rows.summary.totalRows).toBe(4);
    expect(rows.summary.matchedRows).toBe(3);
    expect(rows.summary.flaggedRows).toBe(1);
    expect(rows.summary.matchedRate).toBe(75);
    expect(rows.summary.totalLeak).toBe(1_500);
    expect(rows.summary.totalPaidAmount).toBe(27_900 * 4);
  });

  it("채널별로 분해하고 손실 상위 SKU를 뽑는다", () => {
    const channels = rows.summary.byChannel.map((item) => item.channel);
    expect(channels).toContain("smartstore");
    expect(channels).toContain("coupang");
    expect(rows.summary.topSkusByLoss[0]?.sku).toBe("SG-BAG-01");
    expect(rows.summary.topSkusByLoss[0]?.loss).toBe(1_500);
  });

  it("가장 큰 누수 원인을 한 가지로 집는다", () => {
    const biggest = biggestLeakCause(rows.summary);
    expect(biggest?.code).toBe("SETTLEMENT_SHORTFALL");
    expect(biggest?.amount).toBe(1_500);
  });

  it("역마진 노출액은 별도로 집계한다", () => {
    const withMargin = reconcileSettlement([
      cleanRow({ paidAmount: 10_000, commission: 363, settledAmount: 6_637, unitCost: 9_000, sellerShippingCost: 2_500 }),
    ]);
    expect(withMargin.summary.negativeMarginRows).toBe(1);
    expect(withMargin.summary.marginRiskExposure).toBe(4_863);
    expect(withMargin.summary.worstMarginRate).toBeLessThan(0);
  });
});

describe("reconcileSettlement · 계약 오버라이드", () => {
  it("커스텀 계약을 주면 그 수수료율로 기대값을 다시 계산한다", () => {
    const contracts: Record<MarketChannel, ContractTerms> = {
      ...CHANNEL_CONTRACTS,
      smartstore: { ...CHANNEL_CONTRACTS.smartstore, feeRate: 5, outboundShipping: 2_500 },
    };
    const result = reconcileSettlement([cleanRow()], { contracts });

    expect(result.rows[0]?.contract.feeRate).toBe(5);
    expect(result.rows[0]?.expectedCommission).toBe(1_395); // 27,900 × 5%
    expect(result.meta.contractSource).toBe("custom");
  });
});

describe("reconcileSettlementInBatches", () => {
  const sample = generateSettlementRows({ count: 2_500, seed: 11 });

  it("배치로 나눠도 한 번에 계산한 결과와 같다", async () => {
    const batched = await reconcileSettlementInBatches(sample, { batchSize: 400, yieldToEventLoop: false });
    const single = reconcileSettlement(sample);

    expect(batched.rows.length).toBe(sample.length);
    expect(batched.summary).toEqual(single.summary);
  });

  it("진행률이 단조 증가하고 100%에서 끝난다", async () => {
    const percents: number[] = [];
    await reconcileSettlementInBatches(sample, {
      batchSize: 500,
      yieldToEventLoop: false,
      onProgress: (progress) => percents.push(progress.percent),
    });

    expect(percents.length).toBe(5);
    expect(percents[percents.length - 1]).toBe(100);
    for (let index = 1; index < percents.length; index += 1) {
      expect(percents[index]).toBeGreaterThanOrEqual(percents[index - 1] ?? 0);
    }
  });

  it("중단 신호를 받으면 그 지점까지만 처리한다", async () => {
    const signal = { aborted: false };
    const result = await reconcileSettlementInBatches(sample, {
      batchSize: 500,
      yieldToEventLoop: false,
      signal,
      onProgress: (progress) => {
        if (progress.processed >= 1_000) signal.aborted = true;
      },
    });

    expect(result.rows.length).toBe(1_000);
    expect(result.summary.totalRows).toBe(1_000);
  });
});

describe("데모 데이터 · 이상 복원력", () => {
  const rows = generateSettlementRows({ count: 4_000, seed: 7 });
  const result = reconcileSettlement(rows);

  it("같은 시드면 언제나 같은 데이터가 나온다", () => {
    const again = generateSettlementRows({ count: 400, seed: 7 });
    expect(again.slice(0, 3)).toEqual(rows.slice(0, 3));
  });

  it("주입한 이상이 실제로 탐지되고 손실이 집계된다", () => {
    expect(result.summary.totalRows).toBe(4_000);
    expect(result.summary.totalLeak).toBeGreaterThan(0);
    expect(result.summary.anomalyCounts.FEE_OVERCHARGE).toBeGreaterThan(0);
    expect(result.summary.anomalyCounts.NEGATIVE_MARGIN).toBeGreaterThan(0);
    expect(result.summary.anomalyCounts.FEE_ON_CANCELED_ORDER).toBeGreaterThan(0);
    expect(result.summary.matchedRate).toBeGreaterThan(30);
    expect(result.summary.matchedRate).toBeLessThan(100);
  });

  it("모든 행에서 원인별 손실 합계가 부족분과 정확히 같다(이중 계산 없음)", () => {
    for (const item of result.rows) {
      const anomalyLossSum = item.anomalies.reduce((sum, anomaly) => sum + anomaly.loss, 0);
      expect(anomalyLossSum).toBe(item.loss);
      expect(item.loss).toBe(item.shortfall);
    }
  });

  it("모든 이상 코드는 메타데이터(라벨·심각도)를 갖는다", () => {
    const used = new Set(result.rows.flatMap((item) => item.anomalies.map((anomaly) => anomaly.code)));
    for (const code of used) {
      expect(ANOMALY_META[code].label.length).toBeGreaterThan(0);
      expect(["critical", "warning", "info"]).toContain(ANOMALY_META[code].severity);
    }
  });

  it("이상이 없는 행은 정산 차액이 10원 이하다", () => {
    const clean = result.rows.filter((item) => item.reconciled);
    expect(clean.length).toBeGreaterThan(0);
    for (const item of clean) expect(item.shortfall).toBeLessThanOrEqual(10);
  });
});
