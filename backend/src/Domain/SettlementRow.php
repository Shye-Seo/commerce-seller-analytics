<?php

declare(strict_types=1);

namespace SellerScope\Domain;

/**
 * 정산서 한 행 + 원가 원장(불변).
 *
 * 두 출처를 필드 이름으로 구분한다.
 *   · 마켓이 준 값: paidAmount, commission, shippingDeduction, returnFee, settledAmount
 *   · 우리 원장 값: unitCost, sellerShippingCost
 * 정산서에는 원가가 없고, 원장에는 정산액이 없다. 대사는 이 둘을 한 행에서 만나게 하는
 * 일이다. 그래서 어느 값이 어디서 왔는지가 타입 이름에 드러나 있어야 한다.
 */
final readonly class SettlementRow
{
    public function __construct(
        public string $orderNo,
        public MarketChannel $channel,
        public \DateTimeImmutable $orderDate,
        public string $productName,
        public string $sku,
        public int $quantity,
        public int $paidAmount,
        public int $commission,
        public int $shippingDeduction,
        public int $returnFee,
        public int $settledAmount,
        public OrderStatus $status,
        public ?float $contractFeeRate = null,
        public int $unitCost = 0,
        public int $sellerShippingCost = 0,
        public ?\DateTimeImmutable $settlementDate = null,
    ) {
        if ($quantity < 1) {
            throw new \InvalidArgumentException("수량은 1 이상이어야 합니다(주문 {$orderNo}).");
        }
        if ($paidAmount < 0 || $unitCost < 0 || $sellerShippingCost < 0) {
            throw new \InvalidArgumentException("금액은 음수일 수 없습니다(주문 {$orderNo}).");
        }
    }

    /** 리스트 key·유니크 인덱스(store_id, order_no)와 같은 조합. */
    public function id(): string
    {
        return $this->channel->value . ':' . $this->orderNo;
    }

    /** 매출 인식액(반품·취소는 0). */
    public function recognizedRevenue(): int
    {
        return $this->status->recognizesRevenue() ? $this->paidAmount : 0;
    }

    /**
     * 정산서 CSV/JSON 한 줄을 객체로. 필수 키가 없으면 예외로 즉시 실패한다.
     *
     * 여기서 "없으면 0으로" 처리하지 않는 이유: 결제금액이 빠진 행을 0원 매출로 조용히
     * 적재하면 그 행은 영원히 이상 없음으로 보이고, 셀러는 손실을 영영 모른다.
     * 파싱 실패는 배치 리포트의 parseErrorCount로 올라가 별도 확인 대상이 된다.
     */
    public static function fromArray(array $raw): self
    {
        $required = ['order_no', 'channel', 'order_date', 'product_name', 'sku', 'quantity', 'paid_amount',
            'commission', 'shipping_deduction', 'return_fee', 'settled_amount', 'order_status'];
        foreach ($required as $key) {
            if (!array_key_exists($key, $raw) || $raw[$key] === null || $raw[$key] === '') {
                throw new \InvalidArgumentException("필수 값이 없습니다: {$key}");
            }
        }

        // 정산서는 마켓마다 표기가 다르다. 한글 상태명(배송완료)과 코드(SHIPPED)를 모두 받는다.
        $statusRaw = trim((string) $raw['order_status']);
        $status = preg_match('/[가-힣]/u', $statusRaw) === 1
            ? OrderStatus::fromKorean($statusRaw)
            : OrderStatus::from(strtoupper($statusRaw));

        return new self(
            orderNo: trim((string) $raw['order_no']),
            channel: MarketChannel::from(strtolower(trim((string) $raw['channel']))),
            orderDate: new \DateTimeImmutable((string) $raw['order_date']),
            productName: trim((string) $raw['product_name']),
            sku: trim((string) $raw['sku']),
            quantity: (int) $raw['quantity'],
            paidAmount: (int) $raw['paid_amount'],
            commission: (int) $raw['commission'],
            shippingDeduction: (int) $raw['shipping_deduction'],
            returnFee: (int) $raw['return_fee'],
            settledAmount: (int) $raw['settled_amount'],
            status: $status,
            contractFeeRate: isset($raw['contract_fee_rate']) ? (float) $raw['contract_fee_rate'] : null,
            unitCost: (int) ($raw['unit_cost'] ?? 0),
            sellerShippingCost: (int) ($raw['seller_shipping_cost'] ?? 0),
            settlementDate: isset($raw['settlement_date']) && $raw['settlement_date'] !== ''
                ? new \DateTimeImmutable((string) $raw['settlement_date'])
                : null,
        );
    }

    public function toArray(): array
    {
        return [
            'orderNo' => $this->orderNo,
            'channel' => $this->channel->value,
            'orderDate' => $this->orderDate->format('Y-m-d'),
            'settlementDate' => $this->settlementDate?->format('Y-m-d'),
            'productName' => $this->productName,
            'sku' => $this->sku,
            'quantity' => $this->quantity,
            'paidAmount' => $this->paidAmount,
            'commission' => $this->commission,
            'shippingDeduction' => $this->shippingDeduction,
            'returnFee' => $this->returnFee,
            'settledAmount' => $this->settledAmount,
            'status' => $this->status->label(),
            'contractFeeRate' => $this->contractFeeRate,
            'unitCost' => $this->unitCost,
            'sellerShippingCost' => $this->sellerShippingCost,
        ];
    }
}
