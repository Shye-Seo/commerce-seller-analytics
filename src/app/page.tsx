import Dashboard from "@/components/Dashboard";
import EnterpriseEntry from "@/components/EnterpriseEntry";
import CampaignPerformanceCard from "@/components/CampaignPerformanceCard";
import Header from "@/components/Header";
import { IconArrowUpRight } from "@/components/icons";
import KeywordRankingTable from "@/components/KeywordRankingTable";
import SalesTrendChart from "@/components/SalesTrendChart";
import { DAILY_SALES, DEMO_SNAPSHOT_DATE, MONTHLY_SALES, SCORED_KEYWORDS } from "@/lib/mockData";

const STACK_BADGES = [
  "Next.js 14 App Router",
  "TypeScript",
  "Tailwind CSS",
  "Vitest",
  "Vercel",
];

function SectionHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="mb-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400/80">
        {eyebrow}
      </p>
      <h2 className="mt-1 text-lg font-semibold tracking-tight text-white">{title}</h2>
      <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-slate-500">{description}</p>
    </div>
  );
}

export default function HomePage() {
  return (
    <div className="min-h-screen">
      <Header />

      <main>
        <section className="relative overflow-hidden border-b border-white/[0.06]">
          <div
            className="pointer-events-none absolute -left-32 -top-40 h-[420px] w-[420px] rounded-full bg-emerald-500/10 blur-[120px]"
            aria-hidden
          />
          <div
            className="pointer-events-none absolute -right-24 top-10 h-[360px] w-[360px] rounded-full bg-indigo-500/10 blur-[120px]"
            aria-hidden
          />

          <div className="relative mx-auto w-full max-w-7xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20">
            <span className="chip">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
              이커머스 셀러 운영 도구 · 포트폴리오 프로젝트
            </span>

            <h1 className="mt-5 max-w-3xl text-[28px] font-semibold leading-[1.3] tracking-tight text-white sm:text-4xl lg:text-[42px]">
              수수료·배송·반품까지 반영한{" "}
              <span className="text-emerald-300">진짜 마진</span>과,
              <br className="hidden sm:block" /> 지금 들어갈 만한 키워드를 한 화면에서.
            </h1>

            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-slate-400 sm:text-[15px]">
              스마트스토어·쿠팡 셀러가 정산서를 받고 나서야 손해를 알아차리는 일을 없애기 위해
              만들었습니다. 판매가를 바꾸는 순간 순이익·마진율·손익분기 판매가가 다시 계산되고,
              비용 구조를 네 축으로 진단해 실행 순서를 제시하며, 같은 상품을 5개 마켓에 올렸을 때의
              마진을 나란히 비교합니다. 키워드는 검색량·경쟁 강도·구매 의도를 합성한 하나의 지수로
              비교합니다.
            </p>

            <div className="mt-6 flex flex-wrap gap-2">
              {STACK_BADGES.map((badge) => (
                <span
                  key={badge}
                  className="rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium text-slate-400"
                >
                  {badge}
                </span>
              ))}
            </div>

            <div className="mt-7 flex flex-wrap items-center gap-3">
              <a
                href="#simulator"
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-400 px-4 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-emerald-300"
              >
                마진 계산기 열기
              </a>
              <a
                href="https://github.com/Shye-Seo/commerce-seller-analytics"
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1.5 rounded-xl border border-white/[0.1] bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:border-white/25 hover:text-white"
              >
                소스 코드 보기
                <IconArrowUpRight className="h-4 w-4" />
              </a>
            </div>

            <p className="mt-6 text-[11px] text-slate-500">
              데모 스냅샷 {DEMO_SNAPSHOT_DATE} · 오픈마켓 API는 아직 연동되지 않았고, 모든 수치는
              고정 시드로 생성한 목업 데이터입니다.
            </p>
          </div>
        </section>

        <div className="mx-auto w-full max-w-7xl space-y-12 px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
          <Dashboard />

          <EnterpriseEntry />

          <CampaignPerformanceCard />

          <section id="trend" className="scroll-mt-24">
            <SectionHeading
              eyebrow="Trend"
              title="매출과 마진은 같이 봐야 합니다"
              description="매출이 늘어도 마진율이 떨어지면 남는 돈은 줄어듭니다. 일별·월별 두 단위로 매출(막대)과 마진율(선)을 함께 비교하세요."
            />
            <SalesTrendChart daily={DAILY_SALES} monthly={MONTHLY_SALES} />
          </section>

          <section id="keywords" className="scroll-mt-24">
            <SectionHeading
              eyebrow="Keyword intelligence"
              title="검색량이 많은 키워드가 좋은 키워드는 아닙니다"
              description="경쟁이 치열하면 광고 단가가 오르고, 구매 의도가 낮으면 클릭만 늘어납니다. 세 지표를 하나의 기회 지수로 합성해 진입 우선순위를 정렬합니다."
            />
            <KeywordRankingTable rows={SCORED_KEYWORDS} />
          </section>
        </div>
      </main>

      <footer className="border-t border-white/[0.06] bg-ink-900/40">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <div>
            <p className="text-[13px] font-semibold text-slate-200">서승혜 · Frontend Developer</p>
            <p className="mt-1 text-[11px] text-slate-500">
              커머스 SaaS 기획·개발 경험을 바탕으로 만든 셀러 분석 대시보드입니다.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-[11px] text-slate-500">
            <a
              href="https://github.com/Shye-Seo"
              target="_blank"
              rel="noreferrer noopener"
              className="transition hover:text-slate-200"
            >
              GitHub @Shye-Seo
            </a>
            <span>
              수수료 프리셋은 공개 정책을 참고한 예시값이며, 실제 정산 금액과 다를 수 있습니다.
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
