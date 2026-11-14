import type { Metadata } from "next";
import ApiDocsConsole from "@/components/api-docs/ApiDocsConsole";

export const metadata: Metadata = {
  title: "API 문서 · SellerScope",
  description:
    "정산 대사 API의 OpenAPI 3.0 명세. 엔드포인트별 요청·응답 스키마를 읽고, 브라우저에서 명세 기준 요청 검증과 예시 응답을 확인합니다.",
  keywords: ["OpenAPI", "Swagger", "API 문서", "정산 대사", "REST API", "PHP"],
};

export default function ApiDocsPage() {
  return <ApiDocsConsole />;
}
