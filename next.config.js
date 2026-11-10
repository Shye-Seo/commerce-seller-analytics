/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // 이 프로젝트는 외부 API·외부 이미지 도메인에 의존하지 않는다.
  // 실제 오픈마켓 API 연동 단계에서는 여기에 rewrites/remotePatterns를 추가한다.
};

module.exports = nextConfig;
