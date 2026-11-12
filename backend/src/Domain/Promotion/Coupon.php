<?php

declare(strict_types=1);

namespace SellerScope\Domain\Promotion;

/**
 * 쿠폰 원장 한 행.
 *
 * `codeHash`만 들고 있고 16자리 원문은 들고 있지 않다. 원문은 발급 응답에서 한 번만
 * 노출되고, 이후 조회 응답은 마스킹(`****-****-****-AB12`)된 값만 나간다.
 * 이 객체가 원문을 들고 다니면 로그·에러 트레이스에 원문이 찍혀 유출된다.
 */
final class Coupon
{
    public function __construct(
        public readonly int $id,
        public readonly int $tenantId,
        public readonly int $campaignId,
        public readonly int $templateId,
        public readonly ?int $entryId,
        public readonly string $userHash,
        public readonly string $codeHash,
        public readonly CouponStatus $status,
        public readonly int $discountAmount,
        public readonly int $orderAmount,
        public readonly ?string $orderId,
        public readonly string $idempotencyKey,
        public readonly \DateTimeImmutable $issuedAt,
        public readonly \DateTimeImmutable $expiresAt,
        public readonly ?\DateTimeImmutable $redeemedAt = null,
        public readonly ?\DateTimeImmutable $settledAt = null,
        public readonly ?string $cancelReason = null,
        public readonly string $maskedCode = '',
    ) {
    }

    public function isExpiredAt(\DateTimeImmutable $now): bool
    {
        return $now >= $this->expiresAt;
    }

    public function with(
        ?CouponStatus $status = null,
        ?int $discountAmount = null,
        ?int $orderAmount = null,
        ?string $orderId = null,
        ?\DateTimeImmutable $redeemedAt = null,
        ?\DateTimeImmutable $settledAt = null,
        ?string $cancelReason = null,
        ?string $maskedCode = null,
    ): self {
        return new self(
            id: $this->id,
            tenantId: $this->tenantId,
            campaignId: $this->campaignId,
            templateId: $this->templateId,
            entryId: $this->entryId,
            userHash: $this->userHash,
            codeHash: $this->codeHash,
            status: $status ?? $this->status,
            discountAmount: $discountAmount ?? $this->discountAmount,
            orderAmount: $orderAmount ?? $this->orderAmount,
            orderId: $orderId ?? $this->orderId,
            idempotencyKey: $this->idempotencyKey,
            issuedAt: $this->issuedAt,
            expiresAt: $this->expiresAt,
            redeemedAt: $redeemedAt ?? $this->redeemedAt,
            settledAt: $settledAt ?? $this->settledAt,
            cancelReason: $cancelReason ?? $this->cancelReason,
            maskedCode: $maskedCode ?? $this->maskedCode,
        );
    }

    /**
     * 저장·표시용 마스킹 코드(16자리: 앞 4 + 별표 8 + 끝 4).
     *
     * 원문 코드를 DB에 두지 않는다. 마스킹 값만 있어도 CS가 "끝자리 CD34로 끝나는
     * 쿠폰"을 특정할 수 있고, DB가 유출돼도 사용 가능한 쿠폰이 되지 않는다.
     */
    public static function mask(string $plainCode): string
    {
        if (strlen($plainCode) < 8) {
            return '****************';
        }

        return substr($plainCode, 0, 4) . str_repeat('*', 8) . substr($plainCode, -4);
    }
}
