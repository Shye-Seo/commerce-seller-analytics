<?php

declare(strict_types=1);

namespace SellerScope\Repositories;

use SellerScope\Database\Connection;
use SellerScope\Domain\Promotion\Campaign;
use SellerScope\Domain\Promotion\CouponTemplate;
use SellerScope\Domain\Promotion\DiscountType;
use SellerScope\Support\DbTime;

/**
 * 프로모션 카탈로그의 PDO 구현.
 *
 * 발급 핫패스에서 이 저장소는 **읽기 4회**를 담당한다(캠페인·템플릿·발급 장수·할인 합계).
 * 오픈 순간 초당 3,000건이면 초당 1.2만 쿼리이므로, 아래 두 가지를 지킨다.
 *
 *   1) 캠페인/템플릿은 요청 1회 안에서 캐시한다(같은 요청이 두 번 읽지 않게).
 *   2) 집계 쿼리는 커버링 인덱스만 탄다. `idx_coupons_campaign_status`가
 *      (campaign_id, status)를 들고 있어 COUNT(*)는 인덱스만 읽는다.
 *      SUM(discount_amount)는 커버링이 아니므로 캠페인 단위 캐시(60초)를 두는 것을
 *      운영 기본값으로 권고한다 — 여기서는 정확성을 위해 매번 조회하되,
 *      호출부(콘솔)가 초당 1회만 부르도록 설계했다.
 */
final class PdoPromotionCatalog implements PromotionCatalog
{
    /** @var array<int, Campaign|null> */
    private array $campaignCache = [];

    /** @var array<int, CouponTemplate|null> */
    private array $templateCache = [];

    public function __construct(private readonly Connection $connection)
    {
    }

    public function campaign(int $campaignId): ?Campaign
    {
        if (array_key_exists($campaignId, $this->campaignCache)) {
            return $this->campaignCache[$campaignId];
        }

        $stmt = $this->connection->pdo()->prepare(
            'SELECT id, tenant_id, code, name, campaign_type, partner_name, reward_budget, token_budget,
                    min_guaranteed_margin, margin_guard_mode, starts_at, ends_at, status
               FROM promotional_campaigns WHERE id = :id',
        );
        $stmt->execute(['id' => $campaignId]);
        $row = $stmt->fetch();

        if ($row === false) {
            return $this->campaignCache[$campaignId] = null;
        }

        return $this->campaignCache[$campaignId] = new Campaign(
            id: (int) $row['id'],
            tenantId: (int) $row['tenant_id'],
            code: (string) $row['code'],
            name: (string) $row['name'],
            type: (string) $row['campaign_type'],
            partnerName: $row['partner_name'] !== null ? (string) $row['partner_name'] : null,
            rewardBudget: (int) $row['reward_budget'],
            tokenBudget: (int) $row['token_budget'],
            minGuaranteedMargin: (float) $row['min_guaranteed_margin'],
            marginGuardMode: (string) $row['margin_guard_mode'],
            startsAt: DbTime::parse((string) $row['starts_at']) ?? new \DateTimeImmutable('now'),
            endsAt: DbTime::parse((string) $row['ends_at']) ?? new \DateTimeImmutable('now'),
            status: (string) $row['status'],
        );
    }

    public function template(int $templateId): ?CouponTemplate
    {
        if (array_key_exists($templateId, $this->templateCache)) {
            return $this->templateCache[$templateId];
        }

        $stmt = $this->connection->pdo()->prepare(
            'SELECT id, campaign_id, code, name, discount_type, discount_amount, discount_rate,
                    min_order_amount, max_discount_amount, per_user_limit, validity_minutes,
                    funded_by, is_active
               FROM coupon_templates WHERE id = :id',
        );
        $stmt->execute(['id' => $templateId]);
        $row = $stmt->fetch();

        if ($row === false) {
            return $this->templateCache[$templateId] = null;
        }

        return $this->templateCache[$templateId] = new CouponTemplate(
            id: (int) $row['id'],
            campaignId: (int) $row['campaign_id'],
            code: (string) $row['code'],
            name: (string) $row['name'],
            discountType: DiscountType::from((string) $row['discount_type']),
            discountAmount: (int) $row['discount_amount'],
            discountRate: (float) $row['discount_rate'],
            minOrderAmount: (int) $row['min_order_amount'],
            maxDiscountAmount: (int) $row['max_discount_amount'],
            perUserLimit: (int) $row['per_user_limit'],
            validityMinutes: (int) $row['validity_minutes'],
            fundedBy: (string) $row['funded_by'],
            isActive: (bool) $row['is_active'],
        );
    }

    public function issuedCouponCount(int $campaignId): int
    {
        $stmt = $this->connection->pdo()->prepare(
            "SELECT COUNT(*) FROM issued_coupons
              WHERE campaign_id = :campaign AND status NOT IN ('CANCELLED','EXPIRED')",
        );
        $stmt->execute(['campaign' => $campaignId]);

        return (int) $stmt->fetchColumn();
    }

    public function issuedDiscountTotal(int $campaignId): int
    {
        $stmt = $this->connection->pdo()->prepare(
            "SELECT COALESCE(SUM(discount_amount), 0) FROM issued_coupons
              WHERE campaign_id = :campaign AND status NOT IN ('CANCELLED','EXPIRED')",
        );
        $stmt->execute(['campaign' => $campaignId]);

        return (int) $stmt->fetchColumn();
    }
}
