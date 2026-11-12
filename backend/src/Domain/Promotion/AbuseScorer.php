<?php

declare(strict_types=1);

namespace SellerScope\Domain\Promotion;

/**
 * 어뷰징 점수 계산.
 *
 * 점수는 "몇 개의 독립 신호가 겹쳤는가"로 만든다. 단일 신호로 차단하면 오탐이 나온다
 * (가족이 같은 와이파이에서 각자 응모하면 IP가 같다). 반대로 신호가 3개 겹치는 계정은
 * 거의 확실히 매크로다.
 *
 * 가중치(합계 100 상한)
 *   · DEVICE_CLUSTER  +50 : 같은 디바이스 핑거프린트로 서로 다른 사용자 3명 이상(단독 차단)
 *   · DEVICE_PAIR     +20 : 같은 디바이스로 2명
 *   · PHONE_REUSE     +30 : 같은 전화번호 해시가 다른 사용자 해시로 쓰임(다계정 신호)
 *   · IP_BURST        +25 : 같은 IP에서 10초에 20건 초과
 *   · IP_FLOOD        +40 : 같은 IP에서 10초에 50건 초과
 *   · UA_ANOMALY      +10 : User-Agent 해시가 없거나, 같은 UA로 10초에 30건 초과
 *   · RATE_LIMIT      +35 : 토큰 버킷 소진(스크립트성 연타)
 *
 * 50점 이상이면 차단(is_abusing=1). 스키마 CHECK(`is_abusing=0 OR abuse_score>=50`)와
 * 같은 임계값을 쓴다 — 코드와 DB가 다른 기준을 들면 제약 위반으로 발급이 터진다.
 */
final class AbuseScorer
{
    public const BLOCK_THRESHOLD = 50;

    public const DEVICE_CLUSTER = 'DEVICE_CLUSTER';
    public const DEVICE_PAIR = 'DEVICE_PAIR';
    public const PHONE_REUSE = 'PHONE_REUSE';
    public const IP_BURST = 'IP_BURST';
    public const IP_FLOOD = 'IP_FLOOD';
    public const UA_ANOMALY = 'UA_ANOMALY';
    public const RATE_LIMIT = 'RATE_LIMIT_EXCEEDED';

    /**
     * @param array{deviceUsers:int, ipCount:int, phoneUsers:int, uaCount:int, hasUserAgent:bool, rateLimited:bool} $signals
     * @return array{score:int, reasons:list<string>}
     */
    public function score(array $signals): array
    {
        $score = 0;
        $reasons = [];

        if ($signals['deviceUsers'] >= 3) {
            // 3개 이상 계정이 한 기기를 공유하는 것은 오탐 가능성이 낮아 단독으로 차단한다.
            $score += 50;
            $reasons[] = self::DEVICE_CLUSTER;
        } elseif ($signals['deviceUsers'] === 2) {
            $score += 20;
            $reasons[] = self::DEVICE_PAIR;
        }

        if ($signals['phoneUsers'] >= 2) {
            $score += 30;
            $reasons[] = self::PHONE_REUSE;
        }

        if ($signals['ipCount'] > 50) {
            $score += 40;
            $reasons[] = self::IP_FLOOD;
        } elseif ($signals['ipCount'] > 20) {
            $score += 25;
            $reasons[] = self::IP_BURST;
        }

        if (! $signals['hasUserAgent'] || $signals['uaCount'] > 30) {
            $score += 10;
            $reasons[] = self::UA_ANOMALY;
        }

        if ($signals['rateLimited']) {
            $score += 35;
            $reasons[] = self::RATE_LIMIT;
        }

        return ['score' => min(100, $score), 'reasons' => $reasons];
    }

    /** 이 점수면 차단인가. */
    public function isBlocked(int $score): bool
    {
        return $score >= self::BLOCK_THRESHOLD;
    }

    /**
     * 사람이 읽는 한 줄. 운영 콘솔의 어뷰징 카드에 그대로 쓴다.
     *
     * @param list<string> $reasons
     */
    public function explain(array $reasons): string
    {
        $labels = [
            self::DEVICE_CLUSTER => '같은 기기에서 3명 이상 응모',
            self::DEVICE_PAIR => '같은 기기에서 2명 응모',
            self::PHONE_REUSE => '한 전화번호로 여러 계정 응모',
            self::IP_BURST => 'IP당 요청 폭주(20건/10초 초과)',
            self::IP_FLOOD => 'IP당 요청 폭주(50건/10초 초과)',
            self::UA_ANOMALY => '비정상 User-Agent 패턴',
            self::RATE_LIMIT => '레이트 리밋 초과(연타/스크립트)',
        ];

        if ($reasons === []) {
            return '특이 신호 없음';
        }

        return implode(' · ', array_map(static fn (string $r): string => $labels[$r] ?? $r, $reasons));
    }
}
