<?php

declare(strict_types=1);

namespace SellerScope\Domain;

/**
 * 이상 탐지 코드 + 메타데이터(라벨·분류·심각도·귀속 우선순위).
 *
 * 프론트엔드의 ANOMALY_META와 같은 목록·같은 문구를 쓴다. 한쪽에만 코드를 추가하면
 * 화면에는 "알 수 없는 유형"이 뜨거나, 운영 알림이 조용히 누락된다. 그래서 서버에서
 * 알림톡을 보낼 때 라벨을 DB에 저장하기 전에 이 enum을 반드시 통과시킨다
 * (from()이 실패하면 저장 자체를 거부).
 *
 * priority()는 손실 귀속 순서다. 한 행의 부족분(shortfall)을 원인별로 나눠 담을 때
 * "취소 건 수수료" → "반품비 중복" → "배송완료 건 반품비" → "수수료 초과" → "배송비 초과"
 * 순으로 배정한다. 이유: 취소·반품 건은 그 자체가 명백한 부당 청구라 근거가 가장 강하고,
 * 수수료 초과는 반올림·프로모션 해석의 여지가 있어 뒤로 둔다. 같은 돈을 두 번 세지 않게
 * 하는 장치이기도 하다.
 */
enum AnomalyType: string
{
    case FeeOvercharge = 'FEE_OVERCHARGE';
    case FeeUndercharge = 'FEE_UNDERCHARGE';
    case FeeOnCanceledOrder = 'FEE_ON_CANCELED_ORDER';
    case ShippingOvercharge = 'SHIPPING_OVERCHARGE';
    case ReturnFeeDoubleCharged = 'RETURN_FEE_DOUBLE_CHARGED';
    case ReturnFeeOnShippedOrder = 'RETURN_FEE_ON_SHIPPED_ORDER';
    case SettlementShortfall = 'SETTLEMENT_SHORTFALL';
    case SettlementSurplus = 'SETTLEMENT_SURPLUS';
    case RoundingLeak = 'ROUNDING_LEAK';
    case NegativeMargin = 'NEGATIVE_MARGIN';
    case MissingLedger = 'MISSING_LEDGER';

    public function label(): string
    {
        return match ($this) {
            self::FeeOvercharge => '수수료 초과 청구',
            self::FeeUndercharge => '수수료 과소 청구',
            self::FeeOnCanceledOrder => '취소 건 수수료 청구',
            self::ShippingOvercharge => '배송비 초과 차감',
            self::ReturnFeeDoubleCharged => '반품비 중복 차감',
            self::ReturnFeeOnShippedOrder => '배송완료 건 반품비',
            self::SettlementShortfall => '정산 부족(설명 불가)',
            self::SettlementSurplus => '정산 초과 입금',
            self::RoundingLeak => '반올림 누수',
            self::NegativeMargin => '역마진(실효 마이너스)',
            self::MissingLedger => '원장 누락',
        };
    }

    public function category(): string
    {
        return match ($this) {
            self::FeeOvercharge, self::FeeUndercharge, self::FeeOnCanceledOrder => 'fee',
            self::ShippingOvercharge, self::ReturnFeeDoubleCharged, self::ReturnFeeOnShippedOrder => 'logistics',
            self::SettlementShortfall, self::SettlementSurplus, self::RoundingLeak => 'settlement',
            self::NegativeMargin => 'margin',
            self::MissingLedger => 'data',
        };
    }

    public function severity(): string
    {
        return match ($this) {
            self::FeeOvercharge, self::FeeOnCanceledOrder, self::ReturnFeeDoubleCharged,
            self::SettlementShortfall, self::NegativeMargin => 'critical',
            self::ShippingOvercharge, self::ReturnFeeOnShippedOrder, self::MissingLedger => 'warning',
            self::FeeUndercharge, self::SettlementSurplus, self::RoundingLeak => 'info',
        };
    }

    /** 손실 귀속 우선순위(낮을수록 먼저 배정). */
    public function priority(): int
    {
        return match ($this) {
            self::FeeOnCanceledOrder => 10,
            self::ReturnFeeDoubleCharged => 20,
            self::ReturnFeeOnShippedOrder => 30,
            self::FeeOvercharge => 40,
            self::ShippingOvercharge => 50,
            default => 90,
        };
    }

    /** 부족분을 차지할 수 있는 "부당 청구 후보"인가(귀속 대상). */
    public function isAttributable(): bool
    {
        return in_array($this, [
            self::FeeOnCanceledOrder,
            self::ReturnFeeDoubleCharged,
            self::ReturnFeeOnShippedOrder,
            self::FeeOvercharge,
            self::ShippingOvercharge,
        ], true);
    }

    public function isCritical(): bool
    {
        return $this->severity() === 'critical';
    }

    /**
     * 알림톡 문구용 짧은 이름. 템플릿 변수는 길이 제한(알림톡 본문 1,000자)이 있어
     * 카카오에 등록한 문구 길이에 맞춰 줄인다.
     */
    public function shortLabel(): string
    {
        return match ($this) {
            self::FeeOvercharge => '수수료 과다청구',
            self::FeeUndercharge => '수수료 과소청구',
            self::FeeOnCanceledOrder => '취소건 수수료',
            self::ShippingOvercharge => '배송비 과다차감',
            self::ReturnFeeDoubleCharged => '반품비 중복',
            self::ReturnFeeOnShippedOrder => '배송완료 반품비',
            self::SettlementShortfall => '설명불가 부족',
            self::SettlementSurplus => '초과입금',
            self::RoundingLeak => '반올림 차이',
            self::NegativeMargin => '역마진',
            self::MissingLedger => '원가 누락',
        };
    }
}
