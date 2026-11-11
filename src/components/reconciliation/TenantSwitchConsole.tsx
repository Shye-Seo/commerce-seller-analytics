"use client";

import type { AuditEvent, RoleId, Tenant } from "@/lib/multiTenantRbac";
import {
  ACTION_LABELS,
  maskBusinessNo,
  resolveFieldMask,
  ROLE_LIST,
  ROLES,
  type PermissionId,
} from "@/lib/multiTenantRbac";

/**
 * 멀티 테넌트 · RBAC 콘솔
 *
 * 왼쪽 레일에서 "내가 지금 어떤 법인의 어떤 역할로 보고 있는가"를 항상 보이게 한다.
 * 엔터프라이즈 도구에서 사고가 나는 지점은 대개 권한이 없는 사람이 아니라,
 * **권한이 있는 사람이 지금 어느 테넌트에 있는지 착각하는 순간**이다.
 */

const TIER_LABEL: Record<Tenant["tier"], string> = {
  HQ: "본사",
  BRANCH: "지사",
  CONSIGNMENT: "위탁",
};

const TIER_STYLE: Record<Tenant["tier"], string> = {
  HQ: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  BRANCH: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  CONSIGNMENT: "border-violet-400/30 bg-violet-400/10 text-violet-300",
};

const PERMISSION_ROWS: PermissionId[] = [
  "tenant.switch",
  "settlement.amount",
  "settlement.masked",
  "cost.read",
  "export.csv",
  "reconcile.run",
  "audit.read",
  "member.manage",
];

export default function TenantSwitchConsole({
  tenants,
  activeTenantId,
  role,
  onTenantChange,
  onRoleChange,
  auditEvents,
  chainValid,
  onExportAudit,
}: {
  tenants: Tenant[];
  activeTenantId: string;
  role: RoleId;
  onTenantChange: (tenantId: string) => void;
  onRoleChange: (role: RoleId) => void;
  auditEvents: readonly AuditEvent[];
  chainValid: boolean;
  onExportAudit: () => void;
}) {
  const activeRole = ROLES[role];
  const canSwitch = activeRole.permissions.includes("tenant.switch");
  const canReadAudit = activeRole.permissions.includes("audit.read");

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400/80">Tenant</p>
          <span className="text-[10px] text-slate-500">멀티 테넌트</span>
        </div>

        <div className="mt-3 space-y-2">
          {tenants.map((tenant) => {
            const active = tenant.id === activeTenantId;
            const businessNo = maskBusinessNo(tenant.businessNo, resolveFieldMask(role, "businessNo"));
            return (
              <button
                key={tenant.id}
                type="button"
                onClick={() => onTenantChange(tenant.id)}
                aria-pressed={active}
                className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
                  active
                    ? "border-emerald-400/40 bg-emerald-400/[0.07]"
                    : "border-white/[0.06] bg-white/[0.015] hover:border-white/20"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[12.5px] font-semibold text-slate-100">{tenant.name}</span>
                  <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${TIER_STYLE[tenant.tier]}`}>
                    {TIER_LABEL[tenant.tier]}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between text-[10.5px] text-slate-500">
                  <span className="tabular-nums">사업자 {businessNo}</span>
                  <span>좌석 {tenant.seatCount}</span>
                </div>
              </button>
            );
          })}
        </div>

        {!canSwitch && (
          <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-2.5 py-2 text-[11px] leading-relaxed text-amber-200/90">
            {activeRole.label}는 법인 전환 권한이 없습니다. 소속 법인 데이터만 열람합니다.
          </p>
        )}
      </section>

      <section className="card p-4">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400/80">Role</p>
          <span className="text-[10px] text-slate-500">RBAC</span>
        </div>

        <div className="mt-3 grid gap-1.5">
          {ROLE_LIST.map((definition) => {
            const active = definition.id === role;
            return (
              <button
                key={definition.id}
                type="button"
                onClick={() => onRoleChange(definition.id)}
                aria-pressed={active}
                className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left transition ${
                  active ? "border-indigo-400/40 bg-indigo-400/[0.1]" : "border-white/[0.05] bg-white/[0.015] hover:border-white/20"
                }`}
              >
                <span className="text-[12px] font-medium text-slate-200">{definition.label}</span>
                <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-indigo-300" : "bg-slate-600"}`} aria-hidden />
              </button>
            );
          })}
        </div>

        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">{activeRole.description}</p>

        <table className="mt-3 w-full border-collapse text-[10.5px]">
          <thead>
            <tr className="text-slate-500">
              <th className="py-1 text-left font-medium">권한</th>
              {ROLE_LIST.map((definition) => (
                <th key={definition.id} className="py-1 text-center font-medium">
                  {definition.shortLabel}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERMISSION_ROWS.map((permission) => (
              <tr key={permission} className="border-t border-white/[0.04]">
                <td className="py-1 pr-1 text-slate-400">{ACTION_LABELS[permission]}</td>
                {ROLE_LIST.map((definition) => {
                  const allowed = definition.permissions.includes(permission);
                  return (
                    <td
                      key={definition.id}
                      className={`py-1 text-center ${allowed ? "text-emerald-300" : "text-slate-700"}`}
                      aria-label={`${definition.label} ${ACTION_LABELS[permission]} ${allowed ? "가능" : "불가"}`}
                    >
                      {allowed ? "●" : "－"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card p-4">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400/80">Audit trail</p>
          <span
            className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${
              chainValid
                ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300"
                : "border-rose-400/30 bg-rose-400/10 text-rose-300"
            }`}
          >
            {chainValid ? "체인 정상" : "체인 손상"}
          </span>
        </div>

        <ul className="mt-3 space-y-1.5">
          {auditEvents.length === 0 && <li className="text-[11px] text-slate-600">아직 기록이 없습니다.</li>}
          {auditEvents.map((event) => (
            <li key={`${event.seq}-${event.hash}`} className="rounded-lg border border-white/[0.05] bg-white/[0.015] px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[11px] font-medium text-slate-300">{ACTION_LABELS[event.action as PermissionId] ?? event.action}</span>
                <span
                  className={`shrink-0 rounded px-1 py-0.5 text-[9.5px] font-semibold ${
                    event.outcome === "allowed" ? "bg-emerald-400/10 text-emerald-300" : "bg-rose-400/10 text-rose-300"
                  }`}
                >
                  {event.outcome === "allowed" ? "허용" : "거부"}
                </span>
              </div>
              <p className="mt-0.5 truncate text-[10px] text-slate-500">{event.target}</p>
              <p className="mt-0.5 flex items-center justify-between text-[9.5px] text-slate-600">
                <span className="tabular-nums">{event.at.slice(11, 19)}</span>
                <span className="font-mono">#{event.seq} · {event.hash.slice(0, 6)}</span>
              </p>
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={onExportAudit}
          disabled={!canReadAudit}
          className="mt-3 w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 py-1.5 text-[11px] font-medium text-slate-300 transition enabled:hover:border-white/20 enabled:hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {canReadAudit ? "감사 로그 CSV 반출" : "감사 로그 반출 권한 없음"}
        </button>
      </section>
    </div>
  );
}
