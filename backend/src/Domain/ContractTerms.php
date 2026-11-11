<?php

declare(strict_types=1);

namespace SellerScope\Domain;

/**
 * 계약 조건(스토어 단위).
 *
 * 대사 엔진은 "마켓이 준 숫자"가 아니라 "계약으로 다시 계산한 숫자"를 기준으로 삼는다.
 * 그래서 이 객체가 대사의 기준값 전부를 들고 있다.
 *
 * feeRate만 float이고 나머지는 int인 이유: 수수료율은 3.63%처럼 소수 둘째 자리가
 * 실제 계약값이지만, 배송비는 원 단위 정수 계약이다. 섞어 쓰면 3.6300000000001 같은
 * 값이 기대 수수료 계산에 들어가 1원 차이가 생긴다.
 */
final readonly class ContractTerms
{
    public function __construct(
        public MarketChannel $channel,
        public float $feeRate,
        public int $outboundShipping,
        public int $roundTripReturnFee,
    ) {
        if ($feeRate < 0 || $feeRate >= 100) {
            throw new \InvalidArgumentException("수수료율은 0 이상 100 미만이어야 합니다: {$feeRate}");
        }
        if ($outboundShipping < 0 || $roundTripReturnFee < 0) {
            throw new \InvalidArgumentException('배송비는 음수일 수 없습니다.');
        }
    }

    /**
     * 정산서 행에 박힌 계약 수수료율 스냅샷을 우선 적용한다.
     *
     * 왜 스냅샷인가: 셀러가 3월에 3.63%로 계약하고 6월에 4.2%로 재계약하면, 3월 정산서를
     * 7월에 다시 대사할 때 "현재 계약(4.2%)"으로 계산하면 전부 이상으로 잡힌다.
     * 정산서를 받은 시점의 요율을 행에 남겨 두고 그것을 기준으로 삼는다.
     */
    public function withFeeRateSnapshot(?float $snapshot): self
    {
        if ($snapshot === null || $snapshot <= 0 || $snapshot >= 100) {
            return $this;
        }
        if (abs($snapshot - $this->feeRate) < 0.0001) {
            return $this;
        }

        return new self($this->channel, $snapshot, $this->outboundShipping, $this->roundTripReturnFee);
    }

    public function toArray(): array
    {
        return [
            'channel' => $this->channel->value,
            'feeRate' => $this->feeRate,
            'outboundShipping' => $this->outboundShipping,
            'roundTripReturnFee' => $this->roundTripReturnFee,
        ];
    }
}
