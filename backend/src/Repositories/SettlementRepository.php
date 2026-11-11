<?php

declare(strict_types=1);

namespace SellerScope\Repositories;

use SellerScope\Database\Connection;
use SellerScope\Domain\MarketChannel;
use SellerScope\Domain\Money;
use SellerScope\Domain\OrderStatus;
use SellerScope\Domain\ReconciledRow;
use SellerScope\Domain\SettlementRow;

/**
 * 정산 주문 저장소(PDO).
 *
 * 이 클래스가 이 백엔드에서 SQL이 가장 복잡한 곳이고, 그래서 규칙을 문서로 남긴다.
 *
 *   1) 배치 UPSERT — 정산서 1회 업로드는 수천~수만 행이다. 행마다 INSERT하면
 *      왕복이 행 수만큼 생긴다(10만 행 = 10만 RTT). 250행씩 묶어 한 문장으로 보내면
 *      왕복이 1/250이 된다. 컬럼 30개 × 250 = 7,500 바인딩으로, MySQL의 플레이스홀더
 *      상한(65,535) 안에서 안전하다.
 *   2) 재업로드 멱등성 — 유니크 키 (store_id, order_no)에 ON DUPLICATE KEY UPDATE.
 *      같은 정산서를 두 번 올려도 행이 늘지 않고 결과만 갱신된다.
 *   3) 원본 컬럼 불변 — ON DUPLICATE KEY UPDATE 목록에 paid_amount/commission 같은
 *      마켓 원본을 넣지 않는다. 재계산이 마켓이 준 값을 덮어쓰면 "마켓이 뭐라고 했는지"를
 *      영원히 잃는다.
 *   4) row alias(`AS new`) — MySQL 8.0.19+ 문법. VALUES()는 8.0.20에서 deprecated이고,
 *      곧 제거된다. 신규 코드는 alias를 쓴다.
 *   5) 금액은 전부 int로 바인딩한다. 문자열로 넘기면 서버가 묵시적 형변환을 하면서
 *      인덱스 사용이 흐려지고, DECIMAL 컬럼(수수료율)에서 반올림이 달라진다.
 */
final class SettlementRepository
{
    private const CHUNK_SIZE = 250;

    /** @var array<string,int> channel => store_id (요청 1회 안에서만 캐시) */
    private array $storeCache = [];

    public function __construct(private readonly Connection $connection)
    {
    }

    /**
     * 업서트에 참여하는 컬럼. 순서가 SQL과 바인딩 순서를 결정하므로 한 곳에 모은다.
     *
     * @return list<string>
     */
    public static function columns(): array
    {
        return [
            'tenant_id', 'store_id', 'batch_id', 'order_no', 'channel',
            'order_date', 'settlement_date', 'product_name', 'sku', 'quantity',
            'paid_amount', 'commission', 'shipping_deduction', 'return_fee', 'settled_amount',
            'order_status', 'unit_cost', 'seller_shipping_cost',
            'expected_commission', 'expected_settlement', 'variance', 'shortfall', 'surplus',
            'effective_fee_rate', 'net_margin', 'margin_rate', 'loss', 'reconciled',
            'source_file', 'reconciled_at',
        ];
    }

    /** 재계산 결과로만 갱신되는 컬럼(마켓 원본은 절대 포함하지 않는다). */
    private const RECOMPUTED_COLUMNS = [
        'batch_id', 'expected_commission', 'expected_settlement', 'variance', 'shortfall',
        'surplus', 'effective_fee_rate', 'net_margin', 'margin_rate', 'loss', 'reconciled',
        'source_file', 'reconciled_at',
    ];

    /**
     * 채널별 스토어 id. 계약 조건은 스토어에 붙어 있어, 행을 저장하려면 먼저 스토어를 찾아야 한다.
     *
     * @return array<string,int>
     */
    public function storeIdsByChannel(int $tenantId): array
    {
        if ($this->storeCache !== []) {
            return $this->storeCache;
        }

        $stmt = $this->connection->pdo()->prepare(
            'SELECT channel, MIN(id) AS store_id FROM stores
             WHERE tenant_id = :tenant_id AND is_active = 1
             GROUP BY channel'
        );
        $stmt->execute(['tenant_id' => $tenantId]);

        $map = [];
        foreach ($stmt->fetchAll() as $row) {
            $map[(string) $row['channel']] = (int) $row['store_id'];
        }

        return $this->storeCache = $map;
    }

    /**
     * 대사 결과를 저장하고, 저장된 주문 id를 돌려준다(이상 탐지 행이 FK로 참조해야 한다).
     *
     * @param list<ReconciledRow> $rows
     * @return array<string,int> 'channel:orderNo' => settlement_orders.id
     */
    public function upsertReconciledRows(
        int $tenantId,
        string $batchId,
        ?string $sourceFile,
        array $rows,
        ?\DateTimeImmutable $now = null,
    ): array {
        if ($rows === []) {
            return [];
        }

        $now ??= new \DateTimeImmutable('now');
        $storeIds = $this->storeIdsByChannel($tenantId);
        $pdo = $this->connection->pdo();

        /** @var array<string, list<ReconciledRow>> $byChannel */
        $byChannel = [];
        foreach ($rows as $row) {
            $channel = $row->row->channel->value;
            if (!isset($storeIds[$channel])) {
                // 계약(스토어)이 없는 채널의 행은 저장할 수 없다. 조용히 버리면 그 채널의
                // 손실이 사라지므로, 어떤 행이 왜 빠졌는지 예외 메시지에 남긴다.
                throw new \RuntimeException("활성 스토어가 없는 채널입니다: {$channel} (주문 {$row->row->orderNo})");
            }
            $byChannel[$channel][] = $row;
        }

        $orderIds = [];

        foreach ($byChannel as $channel => $channelRows) {
            $storeId = $storeIds[$channel];

            foreach (array_chunk($channelRows, self::CHUNK_SIZE) as $chunk) {
                $sql = self::buildUpsertSql(count($chunk));
                $params = [];
                foreach ($chunk as $item) {
                    array_push(
                        $params,
                        $tenantId,
                        $storeId,
                        $batchId,
                        $item->row->orderNo,
                        $channel,
                        $item->row->orderDate->format('Y-m-d'),
                        $item->row->settlementDate?->format('Y-m-d'),
                        $item->row->productName,
                        $item->row->sku,
                        $item->row->quantity,
                        $item->row->paidAmount,
                        $item->row->commission,
                        $item->row->shippingDeduction,
                        $item->row->returnFee,
                        $item->row->settledAmount,
                        $item->row->status->value,
                        $item->row->unitCost,
                        $item->row->sellerShippingCost,
                        $item->expectedCommission,
                        $item->expectedSettlement,
                        $item->variance,
                        $item->shortfall,
                        $item->surplus,
                        $item->effectiveFeeRate,
                        $item->netMargin,
                        $item->marginRate,
                        $item->loss,
                        $item->isReconciled() ? 1 : 0,
                        $sourceFile,
                        $now->format('Y-m-d H:i:s.v'),
                    );
                }

                $pdo->prepare($sql)->execute($params);

                // UPSERT는 마지막 행의 id만 돌려준다(lastInsertId). 그래서 유니크 키로 다시 조회한다.
                // 한 문장 더 쓰지만, "행마다 SELECT"보다 훨씬 싸고 결과가 확실하다.
                $orderNos = array_map(static fn (ReconciledRow $r): string => $r->row->orderNo, $chunk);
                $placeholders = implode(',', array_fill(0, count($orderNos), '?'));
                $stmt = $pdo->prepare(
                    "SELECT id, order_no FROM settlement_orders WHERE store_id = ? AND order_no IN ({$placeholders})"
                );
                $stmt->execute(array_merge([$storeId], $orderNos));
                foreach ($stmt->fetchAll() as $saved) {
                    $orderIds[$channel . ':' . $saved['order_no']] = (int) $saved['id'];
                }
            }
        }

        return $orderIds;
    }

    /**
     * INSERT … ON DUPLICATE KEY UPDATE 문 생성.
     *
     * @param positive-int $rowCount
     */
    public static function buildUpsertSql(int $rowCount): string
    {
        $columns = self::columns();
        $columnList = implode(', ', $columns);
        $rowPlaceholder = '(' . implode(', ', array_fill(0, count($columns), '?')) . ')';
        $valuesList = implode(",\n  ", array_fill(0, $rowCount, $rowPlaceholder));

        $updates = implode(",\n  ", array_map(
            static fn (string $column): string => "{$column} = new.{$column}",
            self::RECOMPUTED_COLUMNS,
        ));

        return "INSERT INTO settlement_orders ({$columnList})\nVALUES\n  {$valuesList} AS new\nON DUPLICATE KEY UPDATE\n  {$updates}";
    }

    /**
     * 기간 내 정산 행을 keyset pagination으로 읽는다.
     *
     * OFFSET은 페이지가 깊어질수록 앞 행을 다시 훑는다(10만 행에서 100페이지 = 1,000만 행 스캔).
     * 마지막 id보다 큰 행만 읽으면 깊이와 무관하게 인덱스 범위만큼만 읽는다.
     *
     * @return list<array<string,mixed>>
     */
    public function findByTenantAndPeriod(
        int $tenantId,
        \DateTimeImmutable $from,
        \DateTimeImmutable $to,
        ?int $cursorId = null,
        int $limit = 100,
        bool $onlyFlagged = false,
    ): array {
        $sql = 'SELECT id, order_no, channel, order_date, settlement_date, product_name, sku, quantity,
                       paid_amount, commission, shipping_deduction, return_fee, settled_amount,
                       order_status, unit_cost, seller_shipping_cost, expected_commission,
                       expected_settlement, variance, shortfall, surplus, effective_fee_rate,
                       net_margin, margin_rate, loss, reconciled
                FROM settlement_orders
                WHERE tenant_id = :tenant_id
                  AND settlement_date BETWEEN :from_date AND :to_date';
        $params = [
            'tenant_id' => $tenantId,
            'from_date' => $from->format('Y-m-d'),
            'to_date' => $to->format('Y-m-d'),
        ];
        if ($onlyFlagged) {
            $sql .= ' AND reconciled = 0';
        }
        if ($cursorId !== null) {
            $sql .= ' AND id > :cursor_id';
            $params['cursor_id'] = $cursorId;
        }
        $sql .= ' ORDER BY id ASC LIMIT :limit_rows';

        $stmt = $this->connection->pdo()->prepare($sql);
        foreach ($params as $key => $value) {
            $stmt->bindValue(':' . $key, $value, is_int($value) ? \PDO::PARAM_INT : \PDO::PARAM_STR);
        }
        $stmt->bindValue(':limit_rows', $limit, \PDO::PARAM_INT);
        $stmt->execute();

        return $stmt->fetchAll();
    }

    /**
     * DB에 저장된 값으로 요약을 다시 계산한다.
     *
     * 왜 애플리케이션 요약과 별도로 DB 요약이 필요한가: 화면에 보여 줄 숫자는 "저장된 사실"이어야
     * 한다. 배치가 계산한 요약을 그대로 신뢰하면, 저장 과정에서 일부 행이 누락돼도 알 수 없다.
     * 이 메서드의 결과와 서비스 요약을 비교하는 것이 배치의 자체 정합성 검사다
     * (bin/reconcile.php --verify).
     *
     * @return array<string,mixed>
     */
    public function aggregateByTenantAndPeriod(
        int $tenantId,
        \DateTimeImmutable $from,
        \DateTimeImmutable $to,
    ): array {
        $stmt = $this->connection->pdo()->prepare(
            "SELECT
                COUNT(*) AS total_rows,
                COALESCE(SUM(reconciled = 1), 0) AS matched_rows,
                COALESCE(SUM(reconciled = 0), 0) AS flagged_rows,
                COALESCE(SUM(paid_amount), 0) AS total_paid,
                COALESCE(SUM(commission), 0) AS total_commission,
                COALESCE(SUM(settled_amount), 0) AS total_settled,
                COALESCE(SUM(expected_settlement), 0) AS total_expected,
                COALESCE(SUM(loss), 0) AS total_loss,
                COALESCE(SUM(surplus), 0) AS total_surplus,
                COALESCE(SUM(CASE WHEN order_status = 'SHIPPED' AND unit_cost > 0 AND net_margin < 0
                                  THEN -net_margin ELSE 0 END), 0) AS margin_risk,
                COALESCE(SUM(CASE WHEN order_status = 'SHIPPED' AND unit_cost > 0 AND net_margin < 0
                                  THEN 1 ELSE 0 END), 0) AS negative_margin_rows
             FROM settlement_orders
             WHERE tenant_id = :tenant_id AND settlement_date BETWEEN :from_date AND :to_date"
        );
        $stmt->execute([
            'tenant_id' => $tenantId,
            'from_date' => $from->format('Y-m-d'),
            'to_date' => $to->format('Y-m-d'),
        ]);
        $totals = $stmt->fetch() ?: [];

        $byChannel = $this->connection->pdo()->prepare(
            'SELECT channel, COUNT(*) AS rows_count, COALESCE(SUM(paid_amount), 0) AS paid,
                    COALESCE(SUM(settled_amount), 0) AS settled, COALESCE(SUM(loss), 0) AS leak,
                    COALESCE(SUM(reconciled = 0), 0) AS flagged
             FROM settlement_orders
             WHERE tenant_id = :tenant_id AND settlement_date BETWEEN :from_date AND :to_date
             GROUP BY channel
             ORDER BY paid DESC'
        );
        $byChannel->execute([
            'tenant_id' => $tenantId,
            'from_date' => $from->format('Y-m-d'),
            'to_date' => $to->format('Y-m-d'),
        ]);

        return [
            'totals' => array_map('intval', $totals),
            'matchedRate' => Money::rate((int) ($totals['matched_rows'] ?? 0), max(1, (int) ($totals['total_rows'] ?? 0))),
            // 채널명은 문자열이라 전체 intval을 걸면 'smartstore'가 0이 된다. 숫자 컬럼만 캐스팅한다.
            'byChannel' => array_map(
                static fn (array $row): array => [
                    'channel' => (string) $row['channel'],
                    'rows_count' => (int) $row['rows_count'],
                    'paid' => (int) $row['paid'],
                    'settled' => (int) $row['settled'],
                    'leak' => (int) $row['leak'],
                    'flagged' => (int) $row['flagged'],
                ],
                $byChannel->fetchAll(),
            ),
        ];
    }

    /** 대시보드 카드용: 오늘 기준 최근 7일 손실 상위 SKU. */
    public function topSkuLosses(int $tenantId, \DateTimeImmutable $from, \DateTimeImmutable $to, int $limit = 5): array
    {
        $stmt = $this->connection->pdo()->prepare(
            'SELECT sku, MAX(product_name) AS product_name, COUNT(*) AS rows_count, SUM(loss) AS loss
             FROM settlement_orders
             WHERE tenant_id = :tenant_id AND settlement_date BETWEEN :from_date AND :to_date AND loss > 0
             GROUP BY sku
             ORDER BY loss DESC
             LIMIT :limit_rows'
        );
        $stmt->bindValue(':tenant_id', $tenantId, \PDO::PARAM_INT);
        $stmt->bindValue(':from_date', $from->format('Y-m-d'));
        $stmt->bindValue(':to_date', $to->format('Y-m-d'));
        $stmt->bindValue(':limit_rows', $limit, \PDO::PARAM_INT);
        $stmt->execute();

        // SUM()은 DECIMAL이라 PDO가 문자열로 돌려준다. 화면에서 '1548'과 1548이 섞이지 않게 캐스팅.
        return array_map(static fn (array $row): array => [
            'sku' => (string) $row['sku'],
            'product_name' => (string) $row['product_name'],
            'rows_count' => (int) $row['rows_count'],
            'loss' => (int) $row['loss'],
        ], $stmt->fetchAll());
    }

    /** 저장된 한 행(테스트·디버깅용). */
    public function findById(int $id): ?array
    {
        $stmt = $this->connection->pdo()->prepare('SELECT * FROM settlement_orders WHERE id = :id');
        $stmt->execute(['id' => $id]);
        $row = $stmt->fetch();

        return $row === false ? null : $row;
    }

    /** 테스트/데모용 시드 판정: 해당 주문이 이미 저장돼 있는가. */
    public function exists(int $tenantId, MarketChannel $channel, string $orderNo): bool
    {
        $storeIds = $this->storeIdsByChannel($tenantId);
        $storeId = $storeIds[$channel->value] ?? null;
        if ($storeId === null) {
            return false;
        }
        $stmt = $this->connection->pdo()->prepare(
            'SELECT 1 FROM settlement_orders WHERE store_id = :store_id AND order_no = :order_no LIMIT 1'
        );
        $stmt->execute(['store_id' => $storeId, 'order_no' => $orderNo]);

        return $stmt->fetchColumn() !== false;
    }

    /** 정산 상태 문자열을 DB enum 값으로(외부 입력 방어). */
    public static function statusToDb(OrderStatus $status): string
    {
        return $status->value;
    }

    /**
     * 테스트에서 SettlementRow를 그대로 저장하지 않고 값만 확인하고 싶을 때 쓰는 헬퍼.
     *
     * @return array<string,mixed>
     */
    public static function rowToDbArray(SettlementRow $row): array
    {
        return [
            'order_no' => $row->orderNo,
            'channel' => $row->channel->value,
            'order_date' => $row->orderDate->format('Y-m-d'),
            'settled_amount' => $row->settledAmount,
            'order_status' => $row->status->value,
        ];
    }
}
