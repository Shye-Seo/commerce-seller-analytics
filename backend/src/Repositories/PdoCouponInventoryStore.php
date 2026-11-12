<?php

declare(strict_types=1);

namespace SellerScope\Repositories;

use SellerScope\Database\Connection;
use SellerScope\Domain\Promotion\InventorySnapshot;

/**
 * 재고 저장소 PDO 구현 — 이 프로젝트에서 가장 중요한 SQL 3문장이 있다.
 *
 *  ① 원자 차감(핫패스)
 *     UPDATE coupon_inventories
 *        SET remaining_qty = remaining_qty - 1,
 *            reserved_qty  = reserved_qty + 1,
 *            version       = version + 1,
 *            last_issued_at = NOW(3)
 *      WHERE id = :id AND remaining_qty >= 1;
 *     → affected rows = 0 이면 소진. **조회와 갱신이 한 문장**이라 두 요청이 같은
 *       잔여값을 읽는 창이 없다. InnoDB는 이 UPDATE에 행 락을 잡고 순서대로 적용한다.
 *
 *  ② 낙관적 락(저경합 구간)
 *     ... WHERE id = :id AND version = :version AND remaining_qty >= 1;
 *     → affected rows = 0 이면 충돌. 서비스가 스냅샷을 다시 읽고 재시도한다.
 *
 *  ③ 복원(취소·만료·보상)
 *     UPDATE ... SET remaining_qty = remaining_qty + 1, reserved_qty = reserved_qty - 1
 *      WHERE id = :id AND reserved_qty >= 1;
 *     → reserved_qty >= 1 조건이 없으면, 중복 복원 요청(재시도)이 잔여를 부풀려
 *       "없는 재고"를 만든다. 조건을 반드시 붙인다.
 *
 * 금액·수량은 전부 int로 바인딩한다. 문자열로 넘기면 서버가 형변환하며
 * 인덱스 사용이 흐려지고, 엄격 모드에서 예상치 못한 반올림이 생긴다.
 */
final class PdoCouponInventoryStore implements CouponInventoryStore
{
    public function __construct(private readonly Connection $connection)
    {
    }

    public function snapshot(int $templateId): ?InventorySnapshot
    {
        $stmt = $this->connection->pdo()->prepare(
            'SELECT id, coupon_template_id, total_qty, remaining_qty, reserved_qty, consumed_qty, version
               FROM coupon_inventories WHERE coupon_template_id = :template',
        );
        $stmt->execute(['template' => $templateId]);
        $row = $stmt->fetch();

        if ($row === false) {
            return null;
        }

        return new InventorySnapshot(
            id: (int) $row['id'],
            templateId: (int) $row['coupon_template_id'],
            totalQty: (int) $row['total_qty'],
            remainingQty: (int) $row['remaining_qty'],
            reservedQty: (int) $row['reserved_qty'],
            consumedQty: (int) $row['consumed_qty'],
            version: (int) $row['version'],
        );
    }

    public function reserveAtomically(int $templateId): bool
    {
        $stmt = $this->connection->pdo()->prepare(
            'UPDATE coupon_inventories
                SET remaining_qty = remaining_qty - 1,
                    reserved_qty = reserved_qty + 1,
                    version = version + 1,
                    last_issued_at = NOW(3)
              WHERE coupon_template_id = :template AND remaining_qty >= 1',
        );
        $stmt->execute(['template' => $templateId]);

        return $stmt->rowCount() === 1;
    }

    public function reserveOptimistically(int $templateId, int $expectedVersion): bool
    {
        $stmt = $this->connection->pdo()->prepare(
            'UPDATE coupon_inventories
                SET remaining_qty = remaining_qty - 1,
                    reserved_qty = reserved_qty + 1,
                    version = version + 1,
                    last_issued_at = NOW(3)
              WHERE coupon_template_id = :template AND version = :version AND remaining_qty >= 1',
        );
        $stmt->execute(['template' => $templateId, 'version' => $expectedVersion]);

        return $stmt->rowCount() === 1;
    }

    public function release(int $templateId): void
    {
        $stmt = $this->connection->pdo()->prepare(
            'UPDATE coupon_inventories
                SET remaining_qty = remaining_qty + 1,
                    reserved_qty = reserved_qty - 1,
                    version = version + 1
              WHERE coupon_template_id = :template AND reserved_qty >= 1',
        );
        $stmt->execute(['template' => $templateId]);
    }

    public function consume(int $templateId): void
    {
        $stmt = $this->connection->pdo()->prepare(
            'UPDATE coupon_inventories
                SET reserved_qty = reserved_qty - 1,
                    consumed_qty = consumed_qty + 1,
                    version = version + 1
              WHERE coupon_template_id = :template AND reserved_qty >= 1',
        );
        $stmt->execute(['template' => $templateId]);
    }
}
