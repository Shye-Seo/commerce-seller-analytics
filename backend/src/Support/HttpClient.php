<?php

declare(strict_types=1);

namespace SellerScope\Support;

/**
 * HTTP 클라이언트 추상화.
 *
 * 왜 인터페이스인가: 알림톡 발송·SENS 결과 조회는 전부 외부 네트워크다. 서비스가 curl을
 * 직접 부르면 단위 테스트에서 실제 과금이 나가고, 실패 경로(401 서명 오류, 429 한도)를
 * 재현할 수 없다. 그래서 서비스는 이 인터페이스만 알고, 테스트는 스텁을 넣는다.
 */
interface HttpClient
{
    public function send(HttpRequest $request): HttpResponse;
}
