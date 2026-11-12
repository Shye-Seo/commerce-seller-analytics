<?php

declare(strict_types=1);

namespace SellerScope\Repositories;

use SellerScope\Database\Connection;
use SellerScope\Domain\Promotion\Coupon;
use SellerScope\Domain\Promotion\CouponStatus;
use SellerScope\Support\DbTime;

/**
 * 쿠폰 원장 PDO 구현.
 *
 * INSERT는 유니크 위반(1062)을 `DuplicateCouponException`으로 바꾼다.
 * 어떤 제약이 터졌는지(errorInfo 메시지의 인덱스 이름)를 함께 넘겨, 서비스가
 * "멱등 재전송"과 "사용자 중복"을 구분해 응답할 수 있게 한다 — 409의 문구가 달라진다.
 *
 * transition()은 compare-and-set이다:
 *   UPDATE issued_coupons SET status = :to, ... WHERE id = :id AND status = :from
 * 영향 행이 0이면 다른 요청이 먼저 바꾼 것이다. 이때 예외를 던지지 않고 false를
 * 돌려주는 이유: "동시에 취소와 사용이 들어왔다"는 정상적인 경합이고, 호출자가
 * 최신 상태를 읽어 409로 응답하면 된다(재시도로 해결되지 않는다).
 *
 * status별 시각은 화이트리스트로만 허용한다. 임의 컬럼을 SET에 넣으면
 * SQL 인젝션 통로가 된다(컬럼명은 바인딩할 수 없으므로 반드시 검증한다).
 */
final class PdoIssuedCouponStore implements IssuedCouponStore
{
    private const ALLOWED_STAMPS = ['order_amount', 'discount_amount', 'order_id', 'reserved_at', 'redeemed_at', 'settled_at', 'cancel_reason'];

    public function __construct(private readonly Connection $connection)
    {
    }

    public function findByIdempotencyKey(string $idempotencyKey): ?Coupon
    {
        $stmt = $this->connection->pdo()->prepare(
            'SELECT * FROM issued_coupons WHERE idempotency_key = :key',
        );
        $stmt->execute(['key' => $idempotencyKey]);
        $row = $stmt->fetch();

        return $row === false ? null : $this->hydrate($row);
    }

    public function findByTemplateAndUser(int $templateId, string $userHash): ?Coupon
    {
        $stmt = $this->connection->pdo()->prepare(
            'SELECT * FROM issued_coupons WHERE coupon_template_id = :template AND user_hash = :user',
        );
        $stmt->execute(['template' => $templateId, 'user' => $userHash]);
        $row = $stmt->fetch();

        return $row === false ? null : $this->hydrate($row);
    }

    public function findById(int $id): ?Coupon
    {
        $stmt = $this->connection->pdo()->prepare('SELECT * FROM issued_coupons WHERE id = :id');
        $stmt->execute(['id' => $id]);
        $row = $stmt->fetch();

        return $row === false ? null : $this->hydrate($row);
    }

    public function insert(Coupon $coupon): int
    {
        $sql = 'INSERT INTO issued_coupons
                  (tenant_id, campaign_id, coupon_template_id, entry_id, user_hash, coupon_code, coupon_hash,
                   status, discount_amount, order_amount, order_id, idempotency_key, issued_at, expires_at)
                VALUES
                  (:tenant, :campaign, :template, :entry, :user, :code, :hash,
                   :status, :discount, :order_amount, :order_id, :idem, :issued_at, :expires_at)';

        try {
            $stmt = $this->connection->pdo()->prepare($sql);
            $params = [
                'tenant' => $coupon->tenantId,
                'campaign' => $coupon->campaignId,
                'template' => $coupon->templateId,
                'entry' => $coupon->entryId,
                'user' => $coupon->userHash,
                // 원문 코드는 저장하지 않는다. 마스킹 표기(앞4·끝4)만 남겨 CS가 코드를 특정할 수 있게 한다.
                'code' => $coupon->maskedCode,
                'hash' => $coupon->codeHash,
                'status' => $coupon->status->value,
                'discount' => $coupon->discountAmount,
                'order_amount' => $coupon->orderAmount,
                'order_id' => $coupon->orderId,
                'idem' => $coupon->idempotencyKey,
                'issued_at' => $coupon->issuedAt->format('Y-m-d H:i:s.v'),
                'expires_at' => $coupon->expiresAt->format('Y-m-d H:i:s.v'),
            ];
            $stmt->execute($params);
        } catch (\PDOException $e) {
            if ((int) ($e->errorInfo[1] ?? 0) === 1062) {
                $message = (string) ($e->errorInfo[2] ?? '');
                $constraint = match (true) {
                    str_contains($message, 'uq_coupons_idempotency') => 'idempotency_key',
                    str_contains($message, 'uq_coupons_template_user') => 'template_user',
                    str_contains($message, 'uq_coupons_hash') => 'coupon_hash',
                    default => 'unknown',
                };

                throw new DuplicateCouponException($constraint);
            }

            throw $e;
        }

        return (int) $this->connection->pdo()->lastInsertId();
    }

    public function transition(int $couponId, CouponStatus $from, CouponStatus $to, array $stamps = []): bool
    {
        $assignments = ['status = :to', 'updated_at = NOW(3)'];
        $params = ['to' => $to->value, 'id' => $couponId, 'from' => $from->value];

        foreach ($stamps as $column => $value) {
            if (! in_array($column, self::ALLOWED_STAMPS, true)) {
                throw new \InvalidArgumentException("허용되지 않은 상태 컬럼: {$column}");
            }
            $assignments[] = "{$column} = :{$column}";
            $params[$column] = $value instanceof \DateTimeImmutable ? $value->format('Y-m-d H:i:s.v') : $value;
        }

        $stmt = $this->connection->pdo()->prepare(
            sprintf(
                'UPDATE issued_coupons SET %s WHERE id = :id AND status = :from',
                implode(', ', $assignments),
            ),
        );
        $stmt->execute($params);

        return $stmt->rowCount() === 1;
    }

    public function findExpiringBefore(\DateTimeImmutable $now, int $limit): array
    {
        $stmt = $this->connection->pdo()->prepare(
            "SELECT * FROM issued_coupons
              WHERE status IN ('ISSUED','RESERVED') AND expires_at < :now
              ORDER BY expires_at
              LIMIT :limit",
        );
        $stmt->bindValue('now', $now->format('Y-m-d H:i:s.v'));
        $stmt->bindValue('limit', $limit, \PDO::PARAM_INT);
        $stmt->execute();

        return array_map(fn (array $row): Coupon => $this->hydrate($row), $stmt->fetchAll());
    }

    /**
     * @param array<string, mixed> $row
     */
    private function hydrate(array $row): Coupon
    {
        $toDate = static fn (mixed $value): ?\DateTimeImmutable => $value === null
            ? null
            : DbTime::parse((string) $value);

        return new Coupon(
            id: (int) $row['id'],
            tenantId: (int) $row['tenant_id'],
            campaignId: (int) $row['campaign_id'],
            templateId: (int) $row['coupon_template_id'],
            entryId: $row['entry_id'] !== null ? (int) $row['entry_id'] : null,
            userHash: (string) $row['user_hash'],
            codeHash: (string) $row['coupon_hash'],
            status: CouponStatus::from((string) $row['status']),
            discountAmount: (int) $row['discount_amount'],
            orderAmount: (int) $row['order_amount'],
            orderId: $row['order_id'] !== null ? (string) $row['order_id'] : null,
            idempotencyKey: (string) $row['idempotency_key'],
            issuedAt: DbTime::parse((string) $row['issued_at']) ?? new \DateTimeImmutable('now'),
            expiresAt: DbTime::parse((string) $row['expires_at']) ?? new \DateTimeImmutable('now'),
            redeemedAt: $toDate($row['redeemed_at'] ?? null),
            settledAt: $toDate($row['settled_at'] ?? null),
            cancelReason: $row['cancel_reason'] !== null ? (string) $row['cancel_reason'] : null,
            maskedCode: (string) ($row['coupon_code'] ?? ''),
        );
    }
}
