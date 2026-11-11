<?php

declare(strict_types=1);

namespace SellerScope\Support;

/**
 * 시계 추상화.
 *
 * 외부 API(네이버클라우드 SENS)는 요청 시각을 밀리초 타임스탬프로 서명에 넣는다.
 * 테스트에서 "지금"을 고정하지 않으면 서명 검증 테스트가 매초 달라진다. 그래서 시각은
 * 항상 주입한다 — 프로덕션은 SystemClock, 테스트는 FixedClock.
 */
interface Clock
{
    /** 마이크로초까지 담은 현재 시각. */
    public function now(): \DateTimeImmutable;

    /** 유닉스 epoch 밀리초(문자열). SENS의 x-ncp-apigw-timestamp 헤더 값. */
    public function epochMillisAsString(): string;
}
