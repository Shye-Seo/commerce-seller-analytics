<?php

declare(strict_types=1);

namespace SellerScope\Repositories;

use SellerScope\Domain\Promotion\Campaign;
use SellerScope\Domain\Promotion\CouponTemplate;

/**
 * 프로모션 카탈로그 조회 계약(캠페인·템플릿·발행 집계).
 *
 * 발급 서비스가 이 인터페이스에만 의존하므로, 테스트는 DB 없이 캠페인 상태(종료/일시정지)와
 * 예산 소진을 결정적으로 재현할 수 있다. 실 DB 구현(PdoPromotionCatalog)은 같은 계약으로
 * 인덱스 `(tenant_id, status, starts_at)`를 탄다.
 */
interface PromotionCatalog
{
    public function campaign(int $campaignId): ?Campaign;

    public function template(int $templateId): ?CouponTemplate;

    /** 캠페인에서 지금까지 발급된 쿠폰 장수(취소·만료 제외). */
    public function issuedCouponCount(int $campaignId): int;

    /** 캠페인에서 지금까지 나간 할인액 합계(원). 예산 소진 판정용. */
    public function issuedDiscountTotal(int $campaignId): int;
}
