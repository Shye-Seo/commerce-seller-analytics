import type { ReactNode } from "react";
import Header from "../Header";

/**
 * 페이지 공통 껍데기
 *
 * 머리말(Header) + 본문 + 꼬리말만 담는다. 본문 폭은 1280px로 고정해, 표가 넓어지는 화면과
 * 문단이 길어지는 화면이 같은 세로 기준선을 쓰게 한다. 페이지마다 껍데기를 다시 만들면
 * 여백 규격이 조금씩 어긋나므로 모든 화면이 이 컴포넌트를 쓴다.
 */
export default function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-ink-950">
      <Header />
      <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-5 sm:px-6 lg:py-6">{children}</main>
      <footer className="border-t border-white/[0.06]">
        <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-1 px-4 py-4 text-[10.5px] text-slate-600 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span>서승혜 · 커머스 SaaS 기획·개발</span>
          <span className="flex flex-wrap items-center gap-3">
            <span>수수료 프리셋은 마켓 공개 정책을 참고한 예시값입니다.</span>
            <a
              href="https://github.com/Shye-Seo"
              target="_blank"
              rel="noreferrer noopener"
              className="transition hover:text-slate-300"
            >
              GitHub @Shye-Seo
            </a>
          </span>
        </div>
      </footer>
    </div>
  );
}
