"use client";

import { useMemo, useState } from "react";
import { formatCompactNumber, formatWon } from "@/lib/format";
import type { KeywordGrade, KeywordMarket, ScoredKeyword } from "@/lib/types";
import { IconSearch } from "./icons";

type SortKey = "opportunity" | "volume" | "competition" | "intent";
type MarketFilter = "all" | KeywordMarket;

const MARKET_META: Record<KeywordMarket, { label: string; color: string; chip: string }> = {
  naver: {
    label: "네이버",
    color: "#03C75A",
    chip: "border-naver/30 bg-naver/10 text-naver",
  },
  coupang: {
    label: "쿠팡",
    color: "#F1682A",
    chip: "border-coupang/30 bg-coupang/10 text-coupang",
  },
};

const GRADE_STYLES: Record<KeywordGrade, string> = {
  "진입 추천": "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  관찰: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  회피: "border-slate-400/25 bg-slate-400/10 text-slate-400",
};

const COLUMNS: Array<{ key: SortKey; label: string; align: "left" | "right" | "center"; hideBelow?: string }> = [
  { key: "volume", label: "월 검색량", align: "right" },
  { key: "competition", label: "경쟁 강도", align: "left", hideBelow: "hidden sm:table-cell" },
  { key: "intent", label: "구매 의도", align: "left", hideBelow: "hidden md:table-cell" },
  { key: "opportunity", label: "기회 지수", align: "right" },
];

function competitionLabel(value: number): { text: string; tone: string } {
  if (value >= 70) return { text: "높음", tone: "text-rose-300" };
  if (value >= 45) return { text: "보통", tone: "text-amber-300" };
  return { text: "낮음", tone: "text-emerald-300" };
}

function barColor(value: number): string {
  if (value >= 70) return "#FB7185";
  if (value >= 45) return "#FBBF24";
  return "#34D399";
}

function Meter({ value, color }: { value: number; color: string }) {
  return (
    <div className="mt-1.5 h-1.5 w-16 overflow-hidden rounded-full bg-white/[0.08]">
      <div
        className="h-full rounded-full transition-all duration-300"
        style={{ width: `${Math.min(100, Math.max(0, value))}%`, backgroundColor: color }}
      />
    </div>
  );
}

export interface KeywordRankingTableProps {
  rows: ScoredKeyword[];
}

export default function KeywordRankingTable({ rows }: KeywordRankingTableProps) {
  const [market, setMarket] = useState<MarketFilter>("all");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("opportunity");
  const [descending, setDescending] = useState(true);

  const counts = useMemo(
    () => ({
      all: rows.length,
      naver: rows.filter((row) => row.market === "naver").length,
      coupang: rows.filter((row) => row.market === "coupang").length,
    }),
    [rows],
  );

  const visibleRows = useMemo(() => {
    const keyword = query.trim().toLowerCase();

    const filtered = rows.filter((row) => {
      const marketMatch = market === "all" || row.market === market;
      const queryMatch = keyword === "" || row.keyword.toLowerCase().includes(keyword);
      return marketMatch && queryMatch;
    });

    const valueOf = (row: ScoredKeyword): number => {
      switch (sortKey) {
        case "volume":
          return row.monthlyVolume;
        case "competition":
          return row.competition;
        case "intent":
          return row.purchaseIntent;
        case "opportunity":
        default:
          return row.opportunityScore;
      }
    };

    return [...filtered].sort((a, b) => (descending ? valueOf(b) - valueOf(a) : valueOf(a) - valueOf(b)));
  }, [rows, market, query, sortKey, descending]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setDescending((prev) => !prev);
      return;
    }
    setSortKey(key);
    setDescending(true);
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-col gap-4 border-b border-white/[0.06] p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div>
          <h3 className="text-sm font-semibold text-white">키워드 기회 분석</h3>
          <p className="mt-1 text-[11px] text-slate-500">
            기회 지수 = 0.45×수요 + 0.30×구매 의도 + 0.25×(1−경쟁 강도)
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-white/[0.08] bg-white/[0.02] p-1">
            {(
              [
                { value: "all", label: `전체 ${counts.all}` },
                { value: "naver", label: `네이버 ${counts.naver}` },
                { value: "coupang", label: `쿠팡 ${counts.coupang}` },
              ] as Array<{ value: MarketFilter; label: string }>
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={market === option.value}
                onClick={() => setMarket(option.value)}
                className={`rounded-md px-2.5 py-1.5 text-[11px] font-medium transition ${
                  market === option.value
                    ? "bg-white/10 text-white"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="relative">
            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="키워드 검색"
              aria-label="키워드 검색"
              className="h-9 w-40 rounded-lg border border-white/[0.08] bg-white/[0.03] pl-8 pr-3 text-[12px] text-white placeholder:text-slate-500 focus:border-emerald-400/50 focus:outline-none focus:ring-2 focus:ring-emerald-400/20"
            />
          </div>
        </div>
      </div>

      <div className="thin-scrollbar overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-left">
          <thead>
            <tr className="border-b border-white/[0.06] text-[11px] uppercase tracking-wide text-slate-500">
              <th scope="col" className="px-5 py-2.5 font-medium sm:px-6">
                키워드
              </th>
              {COLUMNS.map((column) => {
                const active = column.key === sortKey;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    className={`px-3 py-2.5 font-medium ${column.hideBelow ?? ""} ${
                      column.align === "right" ? "text-right" : "text-left"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(column.key)}
                      className={`inline-flex items-center gap-1 transition hover:text-slate-200 ${
                        active ? "text-slate-200" : ""
                      }`}
                      aria-label={`${column.label} 기준 정렬`}
                    >
                      {column.label}
                      <span className={`text-[9px] ${active ? "text-emerald-400" : "text-slate-600"}`}>
                        {active ? (descending ? "▼" : "▲") : "↕"}
                      </span>
                    </button>
                  </th>
                );
              })}
              <th scope="col" className="hidden px-3 py-2.5 text-right font-medium lg:table-cell">
                평균가
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04]">
            {visibleRows.map((row) => {
              const meta = MARKET_META[row.market];
              const competition = competitionLabel(row.competition);

              return (
                <tr key={row.id} className="transition-colors hover:bg-white/[0.02]">
                  <td className="px-5 py-3 sm:px-6">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${meta.chip}`}
                      >
                        {meta.label}
                      </span>
                      <span className="text-[13px] font-medium text-slate-100">{row.keyword}</span>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-500">{row.category}</p>
                  </td>

                  <td className="px-3 py-3 text-right text-[13px] font-medium text-slate-200 tabular-nums">
                    {formatCompactNumber(row.monthlyVolume)}
                  </td>

                  <td className="hidden px-3 py-3 sm:table-cell">
                    <div className="flex items-center gap-2">
                      <Meter value={row.competition} color={barColor(row.competition)} />
                      <span className={`text-[11px] font-medium ${competition.tone}`}>
                        {competition.text}
                      </span>
                    </div>
                  </td>

                  <td className="hidden px-3 py-3 md:table-cell">
                    <div className="flex items-center gap-2">
                      <Meter value={row.purchaseIntent} color="#818CF8" />
                      <span className="text-[11px] text-slate-400 tabular-nums">
                        {row.purchaseIntent}
                      </span>
                    </div>
                  </td>

                  <td className="px-3 py-3 text-right">
                    <span
                      className={`inline-flex min-w-[38px] justify-center rounded-md border px-2 py-0.5 text-[11px] font-semibold tabular-nums ${GRADE_STYLES[row.grade]}`}
                    >
                      {row.opportunityScore}
                    </span>
                  </td>

                  <td className="hidden px-3 py-3 text-right text-[12px] text-slate-300 tabular-nums lg:table-cell">
                    {formatWon(row.averagePrice)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {visibleRows.length === 0 ? (
        <div className="px-6 py-12 text-center">
          <p className="text-sm text-slate-400">조건에 맞는 키워드가 없습니다.</p>
          <p className="mt-1 text-[11px] text-slate-500">검색어를 지우거나 마켓 필터를 전체로 바꿔 보세요.</p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] px-5 py-3 text-[11px] text-slate-500 sm:px-6">
        <span>
          {visibleRows.length}개 키워드 · 기회 지수 70 이상은 <span className="text-emerald-300">진입 추천</span>
        </span>
        <span>검색량·경쟁 강도는 데모 데이터입니다.</span>
      </div>
    </div>
  );
}
