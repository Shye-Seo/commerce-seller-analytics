/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // 대시보드 전용 다크 팔레트. 표면(surface)과 배경(ink)의 명도 차이를 3단계로 고정해
        // 카드가 배경에 묻히지 않으면서도 계층이 과하지 않게 유지한다.
        ink: {
          950: "#070B16",
          900: "#0B1020",
          800: "#101731",
          700: "#18203B",
        },
        accent: {
          DEFAULT: "#34D399",
          soft: "#6EE7B7",
          deep: "#059669",
        },
        naver: "#03C75A",
        coupang: "#F1682A",
      },
      fontFamily: {
        sans: [
          "Pretendard",
          "-apple-system",
          "BlinkMacSystemFont",
          "system-ui",
          "Apple SD Gothic Neo",
          "Malgun Gothic",
          "sans-serif",
        ],
      },
      boxShadow: {
        card: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 18px 40px -24px rgba(2,6,23,0.9)",
        glow: "0 0 0 1px rgba(52,211,153,0.18), 0 20px 50px -30px rgba(52,211,153,0.55)",
      },
      keyframes: {
        rise: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        rise: "rise 0.45s cubic-bezier(0.22, 1, 0.36, 1) both",
      },
    },
  },
  plugins: [],
};
