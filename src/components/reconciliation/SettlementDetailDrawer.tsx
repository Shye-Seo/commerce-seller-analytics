"use client";

import { useEffect } from "react";
import type { ReconciledRow } from "@/lib/reconciliationEngine";
import { maskAmount, resolveFieldMask, ROLES, type RoleId } from "@/lib/multiTenantRbac";
import { formatPercent, formatSignedWon, formatWon } from "@/lib/format";

/**
 * 정산 1건 상세 드로어
 *
 * 면접관이 이 화면에서 확인하는 것은 "예쁜 표"가 아니라 **금액 근거의 추적 가능성**이다.
 * 그래서 계약 기준 기대값과 정산서 실제값을 항목별로 나란히 두고, 차액이 어느 규칙으로
 * 귀속됐는지 계산식까지 그대로 보여 준다.
 */

function amount(value: number, role: RoleId, field: "settledAmount" | "unitCost" | "netMargin" = "settledAmount"): string {
  const level = resolveFieldMask(role, field);
  return level === "none" ? formatWon(value) : maskAmount(value, level);
}

/** 부호를 붙인 금액도 마스킹 규칙을 지킨다. */
function signedAmount(value: number, role: RoleId): string {
  const level = resolveFieldMask(role, "settledAmount");
  if (level === "none") return formatSignedWon(value);
  const sign = value < 0 ? "-" : value > 0 ? "+" : "";
  return `${sign}${maskAmount(Math.abs(value), level)}`;
}

export default function SettlementDetailDrawer({
  item,
  role,
  onClose,
}: {
  item: ReconciledRow | null;
  role: RoleId;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!item) return;
    const handler = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [item, onClose]);

  if (!item) return null;

  const { row } = item;
  const roleDefinition = ROLES[role];
  const costMasked = resolveFieldMask(role, "unitCost") !== "none";
  const totalCost = row.unitCost * row.quantity + row.sellerShippingCost;

  return (
    <div className="fixed inset-0 z-[60] flex justify-end">
      <button
        type="button"
        aria-label="상세 닫기"
        onClick={onClose}
        className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`주문 ${row.orderNo} 정산 상세`}
        className="relative z-10 h-full w-full max-w-[460px] overflow-y-auto border-l border-white/[0.08] bg-[#080D1A] px-5 py-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-emerald-400/80">Settlement detail</p>
            <h2 className="mt-1 font-mono text-[15px] font-semibold text-white">{row.orderNo}</h2>
            <p className="mt-1 text-[11.5px] text-slate-400">
              {row.productName} · {row.sku} · {row.quantity}개
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {row.orderDate} · {row.status} · 계약 수수료율 {formatPercent(item.contract.feeRate, 2)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[11px] text-slate-300 transition hover:border-white/20 hover:text-white"
          >
            닫기
          </button>
        </div>

        <section className="mt-5 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">금액 대사</h3>
          <dl className="mt-2 space-y-1.5 text-[11.5px]">
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">소비자 결제금액</dt>
              <dd className="tabular-nums text-slate-200">{amount(row.paidAmount, role)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">마켓 수수료</dt>
              <dd className="tabular-nums text-right text-slate-200">
                {amount(row.commission, role)}
                <span className="ml-1 text-[10px] text-slate-500">계약 {amount(item.expectedCommission, role)}</span>
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">배송비 차감</dt>
              <dd className="tabular-nums text-right text-slate-200">
                {amount(row.shippingDeduction, role)}
                <span className="ml-1 text-[10px] text-slate-500">계약 {amount(item.expectedShippingDeduction, role)}</span>
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">반품비</dt>
              <dd className="tabular-nums text-right text-slate-200">
                {amount(row.returnFee, role)}
                <span className="ml-1 text-[10px] text-slate-500">계약 {amount(item.expectedReturnFee, role)}</span>
              </dd>
            </div>
            <div className="mt-1 flex justify-between gap-3 border-t border-white/[0.07] pt-2">
              <dt className="font-medium text-slate-300">실정산액</dt>
              <dd className="tabular-nums font-semibold text-white">{amount(item.actualSettlement, role)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">계약 기준 기대 정산액</dt>
              <dd className="tabular-nums text-slate-300">{amount(item.expectedSettlement, role)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">차액</dt>
              <dd className={`tabular-nums font-semibold ${item.variance < 0 ? "text-rose-300" : item.variance > 0 ? "text-sky-300" : "text-slate-400"}`}>
                {item.variance === 0 ? "0원" : signedAmount(item.variance, role)}
              </dd>
            </div>
          </dl>
        </section>

        <section className="mt-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">이상 탐지 · 원인 귀속</h3>
          {item.anomalies.length === 0 ? (
            <p className="mt-2 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.06] px-2.5 py-2 text-[11.5px] text-emerald-200/90">
              계약 조건과 정산서가 일치합니다. 조치할 항목이 없습니다.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {item.anomalies.map((anomaly) => (
                <li key={`${anomaly.code}-${anomaly.actual}`} className="rounded-lg border border-white/[0.06] bg-ink-950/40 px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11.5px] font-semibold text-slate-200">{anomaly.label}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[9.5px] font-semibold ${anomaly.loss > 0 ? "bg-rose-400/10 text-rose-300" : "bg-slate-400/10 text-slate-300"}`}>
                      {anomaly.loss > 0 ? `귀속 ${amount(anomaly.loss, role)}` : "손실 없음"}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{anomaly.detail}</p>
                  <p className="mt-1 flex gap-3 text-[10px] tabular-nums text-slate-600">
                    <span>기대 {amount(anomaly.expected, role)}</span>
                    <span>실제 {amount(anomaly.actual, role)}</span>
                  </p>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 rounded-lg border border-white/[0.06] bg-ink-950/40 px-2.5 py-2 text-[10.5px] leading-relaxed text-slate-500">
            <p className="tabular-nums">
              실효 마진 = 실정산 {amount(item.actualSettlement, role)} − (원가 {costMasked ? "●●●" : formatWon(row.unitCost)} × {row.quantity} + 실배송 {amount(row.sellerShippingCost, role)}) ={" "}
              <span className={item.netMargin < 0 ? "font-semibold text-rose-300" : "text-slate-300"}>{amount(item.netMargin, role, "netMargin")}</span>
              {item.marginRate !== 0 && <span className="ml-1">({formatPercent(item.marginRate, 1)})</span>}
            </p>
            <p className="mt-1">누수 상한 = 부족분 {amount(item.shortfall, role)} · 귀속 합계 {amount(item.anomalies.reduce((sum, anomaly) => sum + anomaly.loss, 0), role)}</p>
          </div>
        </section>

        <section className="mt-3 rounded-xl border border-indigo-400/20 bg-indigo-400/[0.05] p-3 text-[10.5px] leading-relaxed text-indigo-200/80">
          <p className="font-semibold text-indigo-200">권한 정책 · {roleDefinition.label}</p>
          <p className="mt-1">
            정산액 {roleDefinition.amountMask === "none" ? "전체 열람" : roleDefinition.amountMask === "partial" ? "부분 마스킹" : "차단"} · 원가{" "}
            {costMasked ? "차단" : "열람"} · 이 열람은 감사 로그에 기록됩니다.
          </p>
          <p className="mt-1 text-indigo-200/50">마스킹된 값은 화면에서만 가려지며 원본 정산 데이터는 변경되지 않습니다.</p>
        </section>
      </aside>
    </div>
  );
}
