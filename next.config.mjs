/**
 * Next.js 설정
 *
 * 두 가지 모드로 동작한다.
 *
 *  1. 기본(로컬·Vercel) — `next dev` / `npm run build` / `next start` / Playwright E2E.
 *     서버가 있으므로 아무것도 바꾸지 않는다.
 *  2. GitHub Pages(`GITHUB_PAGES=1`) — 서버가 없으므로 **정적 내보내기**로 전환하고,
 *     저장소 하위 경로(`/commerce-seller-analytics`)를 `basePath`로 붙인다.
 *
 * 두 모드를 한 파일에서 분기하는 이유는, E2E가 프로덕션 빌드를 띄워 검증하기 때문이다.
 * 정적 내보내기를 기본값으로 두면 `next start`가 없어 E2E가 통째로 깨진다.
 *
 * `assetPrefix`를 같이 주는 이유: `_next/static` 자산 경로는 basePath만으로는 하위 경로에
 * 붙지 않아, GitHub Pages에서 CSS·JS가 404가 된다.
 */

const isGithubPages = process.env.GITHUB_PAGES === "1" || process.env.GITHUB_PAGES === "true";
const repoBasePath = "/commerce-seller-analytics";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  ...(isGithubPages
    ? {
        output: "export",
        basePath: repoBasePath,
        assetPrefix: repoBasePath,
        trailingSlash: true,
        // 정적 내보내기에서는 Next 이미지 최적화 서버가 없다.
        images: { unoptimized: true },
      }
    : {}),

  // 런타임에서 명세 파일을 같은 경로에서 읽기 위한 값. basePath와 반드시 같아야 한다.
  env: {
    NEXT_PUBLIC_BASE_PATH: isGithubPages ? repoBasePath : "",
  },
};

export default nextConfig;
