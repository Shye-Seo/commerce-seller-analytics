<?php

declare(strict_types=1);

namespace SellerScope\Tests\Repositories;

use PHPUnit\Framework\TestCase;
use SellerScope\Repositories\SettlementRepository;

/**
 * UPSERT SQL 생성 테스트(DB 없이).
 *
 * 실제 실행은 Integration/DatabaseIntegrationTest가 MySQL에서 확인한다. 여기서는
 * "생성된 SQL이 우리가 의도한 성질을 갖는가"만 본다:
 *   - 행 수만큼 플레이스홀더가 생기는가 (바인딩 개수 불일치 = 런타임 오류)
 *   - 8.0.19+ 문법(`AS new`)을 쓰는가 (VALUES() deprecated 회피)
 *   - 마켓 원본 컬럼을 UPDATE 목록에 넣지 않았는가 (원본 불변 규칙)
 */
final class SettlementRepositorySqlTest extends TestCase
{
    public function testColumnsAreTheThirtyContractColumns(): void
    {
        self::assertCount(30, SettlementRepository::columns());
        self::assertContains('paid_amount', SettlementRepository::columns());
        self::assertContains('reconciled_at', SettlementRepository::columns());
    }

    public function testUpsertSqlHasOnePlaceholderPerColumnPerRow(): void
    {
        $sql = SettlementRepository::buildUpsertSql(3);

        self::assertSame(90, substr_count($sql, '?'));
        self::assertSame(3, substr_count($sql, '(?, ?, '));
    }

    public function testUpsertUsesRowAliasSyntax(): void
    {
        $sql = SettlementRepository::buildUpsertSql(1);

        self::assertStringContainsString(' AS new', $sql);
        self::assertStringContainsString('reconciled = new.reconciled', $sql);
        self::assertStringNotContainsString('VALUES(', $sql, 'VALUES()는 8.0.20에서 deprecated다.');
    }

    public function testOriginalMarketColumnsAreNeverUpdated(): void
    {
        $sql = SettlementRepository::buildUpsertSql(1);
        $updateSection = substr($sql, strpos($sql, 'ON DUPLICATE KEY UPDATE'));

        foreach (['paid_amount', 'commission', 'shipping_deduction', 'return_fee', 'settled_amount', 'order_status', 'unit_cost'] as $originalColumn) {
            // 줄 시작 기준으로 비교한다. 'commission = new.'는 'expected_commission = new.'의 일부이기도 하다.
            self::assertSame(
                0,
                preg_match('/^\\s*' . preg_quote($originalColumn, '/') . ' = new\\./m', $updateSection),
                "{$originalColumn}은 마켓/원장 원본이라 재계산이 덮어쓰면 안 된다.",
            );
        }
    }

    public function testStatusMappingUsesDatabaseEnumValues(): void
    {
        self::assertSame('RETURNED', SettlementRepository::statusToDb(\SellerScope\Domain\OrderStatus::Returned));
    }
}
