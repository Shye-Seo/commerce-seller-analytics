<?php

declare(strict_types=1);

namespace SellerScope\Domain\Promotion;

/**
 * 발급 결과 코드.
 *
 * 성공/실패 두 값으로 뭉개지 않는 이유: 이 값이 그대로 **지표**가 되기 때문이다.
 * 오픈 콘솔은 `SOLD_OUT`(정상 소진)과 `DUPLICATE_CLAIM`(중복 시도)과
 * `REJECTED_ABUSE`(어뷰징)를 구분해 보여줘야 한다. 하나로 합치면
 * "왜 30%가 실패했나"에 답할 수 없다.
 *
 * IDEMPOTENT_REPLAY는 실패가 아니다. 같은 요청의 재전송이므로 200으로 응답하고
 * 같은 쿠폰을 돌려준다(그래서 isSuccess()가 true).
 */
enum IssueOutcome: string
{
    case Issued = 'ISSUED';
    case IdempotentReplay = 'IDEMPOTENT_REPLAY';
    case SoldOut = 'SOLD_OUT';
    case DuplicateClaim = 'DUPLICATE_CLAIM';
    case MarginGuardBlocked = 'MARGIN_GUARD_BLOCKED';
    case CampaignClosed = 'CAMPAIGN_CLOSED';
    case TemplateInactive = 'TEMPLATE_INACTIVE';
    case BudgetExhausted = 'BUDGET_EXHAUSTED';
    case InventoryConflict = 'INVENTORY_CONFLICT';
    case InvalidRequest = 'INVALID_REQUEST';
    case IllegalTransition = 'ILLEGAL_TRANSITION';
    case NotFound = 'NOT_FOUND';
}
