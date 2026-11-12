<?php

declare(strict_types=1);

namespace SellerScope\Tests\Support;

use SellerScope\Domain\Promotion\Campaign;
use SellerScope\Domain\Promotion\CouponTemplate;
use SellerScope\Repositories\PromotionCatalog;

/**
 * 카탈로그 페이크.
 *
 * 발급 서비스가 DB에 의존하지 않음을 증명하는 객체다. 캠페인 상태(종료·일시정지)와
 * 예산 소진을 "원하는 순간"에 만들 수 있어야 경계 테스트가 가능하다.
 */
final class FakePromotionCatalog implements PromotionCatalog
{
    public int $issuedCount = 0;

    public int $issuedDiscountTotal = 0;

    /**
     * @param array<int, Campaign>       $campaigns
     * @param array<int, CouponTemplate> $templates
     */
    public function __construct(
        private array $campaigns = [],
        private array $templates = [],
    ) {
    }

    public function campaign(int $campaignId): ?Campaign
    {
        return $this->campaigns[$campaignId] ?? null;
    }

    public function template(int $templateId): ?CouponTemplate
    {
        return $this->templates[$templateId] ?? null;
    }

    public function issuedCouponCount(int $campaignId): int
    {
        return $this->issuedCount;
    }

    public function issuedDiscountTotal(int $campaignId): int
    {
        return $this->issuedDiscountTotal;
    }
}
