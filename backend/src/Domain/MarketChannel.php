<?php

declare(strict_types=1);

namespace SellerScope\Domain;

/**
 * 판매 채널.
 *
 * DB의 ENUM('smartstore','coupang','elevenst','gmarket','own')과 값이 1:1로 대응한다.
 * 백킹 값을 문자열로 둔 이유: 정산서 CSV에 적힌 값(“smartstore”)을 그대로 받아
 * `MarketChannel::from($raw)` 한 번으로 검증까지 끝낼 수 있고, DB에 숫자 코드를
 * 심어 두면 로그·문의 대응 때마다 코드표를 찾아야 한다.
 */
enum MarketChannel: string
{
    case SmartStore = 'smartstore';
    case Coupang = 'coupang';
    case ElevenSt = 'elevenst';
    case Gmarket = 'gmarket';
    case Own = 'own';

    public function label(): string
    {
        return match ($this) {
            self::SmartStore => '스마트스토어',
            self::Coupang => '쿠팡',
            self::ElevenSt => '11번가',
            self::Gmarket => 'G마켓',
            self::Own => '자사몰',
        };
    }

    /**
     * 계약 프리셋. 실무에서는 계약서 값으로 덮어쓰지만, "기본값이 있는 상태"와
     * "아무 값도 없는 상태"는 다르다. 셀러가 계약서를 아직 안 올렸을 때도 대사가
     * 돌아가야 하므로 공개 수수료 정책을 기준값으로 둔다.
     */
    public function presetContract(): ContractTerms
    {
        return match ($this) {
            self::SmartStore => new ContractTerms($this, 3.63, 3_000, 5_000),
            self::Coupang => new ContractTerms($this, 10.8, 0, 5_600),
            self::ElevenSt => new ContractTerms($this, 9.0, 3_000, 5_000),
            self::Gmarket => new ContractTerms($this, 8.5, 3_000, 5_000),
            self::Own => new ContractTerms($this, 0.0, 3_000, 5_000),
        };
    }
}
