<?php

declare(strict_types=1);

namespace SellerScope\Repositories;

use SellerScope\Domain\Promotion\InventorySnapshot;

/**
 * 재고 저장소 계약.
 *
 * 메서드를 두 갈래로 나눈 것이 이 인터페이스의 핵심이다.
 *
 *   reserveAtomically()   — 핫패스. `UPDATE ... SET remaining = remaining - 1
 *                           WHERE id = ? AND remaining >= 1` 한 문장. 영향 행 0이면 SOLD_OUT.
 *   reserveOptimistically() — version 비교. 충돌 시 false를 돌려주고 서비스가 재시도한다.
 *
 * 둘 다 있는 이유: 오픈 직후 0.5초는 조건부 UPDATE가 정답이고(재시도 비용이 더 크다),
 * 프리뷰·관리자 사전 예약처럼 경합이 낮은 구간은 낙관적 락이 락 대기 없이 처리된다.
 * 어느 쪽을 탈지는 서비스가 정하고, 저장소는 "원자적으로 실패한다"는 계약만 지킨다.
 */
interface CouponInventoryStore
{
    public function snapshot(int $templateId): ?InventorySnapshot;

    /**
     * 조건부 UPDATE로 1장 선점. 잔여가 없으면 false(예외 아님 — 정상적인 소진이다).
     */
    public function reserveAtomically(int $templateId): bool;

    /**
     * version 낙관적 락으로 1장 선점. version이 달라졌거나 잔여가 없으면 false.
     */
    public function reserveOptimistically(int $templateId, int $expectedVersion): bool;

    /** 예약 1장을 잔여로 되돌린다(취소·만료·INSERT 실패 보상). */
    public function release(int $templateId): void;

    /** 예약 1장을 사용 확정으로 옮긴다(reserved - 1, consumed + 1). */
    public function consume(int $templateId): void;
}
