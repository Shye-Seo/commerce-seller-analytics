"use client";

import { useState } from "react";
import ReconciliationConsole from "@/components/reconciliation/ReconciliationConsole";
import SettlementWatchConsole from "@/components/settlement-watch/SettlementWatchConsole";
import PageHeader from "@/components/ui/PageHeader";
import Segmented from "@/components/ui/Segmented";

/**
 * 정산 화면 — 받은 정산서와 들어와야 할 돈을 한 흐름으로
 *
 * 예전에는 대사 콘솔과 누락 감시가 서로 다른 메뉴였고, 대사 콘솔 하나가 열두 개 패널을 세로로
 * 쌓고 있었다. 지금은 "대사 개요 → 이상 내역 → 데이터 유입 → 반출·알림 → 월별 추이"라는
 * 일의 순서를 한 줄 탭으로 두고, 정산서에 아예 등장하지 않는 주문을 찾는 '누락·지연'을 같은
 * 줄 끝에 붙였다. 탭은 하위 탭 없이 이 한 줄이 전부다.
 *
 * 두 콘솔은 모두 마운트해 두고 hidden으로만 감춘다. 대사는 2만 건 원장을 다시 계산하는 비용이
 * 커서, 탭을 오갈 때마다 처음부터 돌리면 화면이 아니라 계산을 보고 있게 된다.
 */
export type SettlementTab = "overview" | "rows" | "intake" | "export" | "trend" | "watch";

const TABS = [
  { id: "overview" as const, label: "대사 개요" },
  { id: "rows" as const, label: "이상 내역" },
  { id: "intake" as const, label: "데이터 유입" },
  { id: "export" as const, label: "반출·알림" },
  { id: "trend" as const, label: "월별 추이" },
  { id: "watch" as const, label: "누락·지연" },
];

export default function SettlementWorkspace({ initialTab = "overview" }: { initialTab?: SettlementTab }) {
  const [tab, setTab] = useState<SettlementTab>(initialTab);

  return (
    <>
      <PageHeader
        meta="Settlement"
        title="정산 — 들어와야 할 돈 확인"
        description="정산서와 판매 원장이 어긋난 차액을 계약 조건으로 다시 계산하고(대사), 정산 기한을 지났는데 내역에 없는 주문(누락·지연)을 함께 봅니다."
        actions={
          <span className="chip">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
            계약 수수료 기준 재계산
          </span>
        }
      />

      <div className="mt-3 px-0.5">
        <Segmented items={TABS} value={tab} onChange={setTab} label="정산 화면 보기" testIdPrefix="recon-tab" />
      </div>

      <div className="mt-4" role="tabpanel" aria-label={TABS.find((item) => item.id === tab)?.label ?? "정산"}>
        <div hidden={tab === "watch"}>
          <ReconciliationConsole section={tab === "watch" ? "overview" : tab} />
        </div>
        <div hidden={tab !== "watch"}>
          <SettlementWatchConsole />
        </div>
      </div>
    </>
  );
}
