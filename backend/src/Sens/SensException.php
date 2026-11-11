<?php

declare(strict_types=1);

namespace SellerScope\Sens;

/**
 * SENS 호출 실패.
 *
 * 상태 코드별로 "다음에 무엇을 해야 하는지"를 hint로 붙인다. 알림 실패는 배치를 세우지
 * 않고 로그로 남기지만, 401(서명 오류)과 429(한도)는 원인과 조치가 완전히 다르므로
 * 로그만 보고는 구분할 수 없으면 안 된다.
 */
final class SensException extends \RuntimeException
{
    public function __construct(
        string $message,
        public readonly int $httpStatus = 0,
        public readonly string $responseBody = '',
        public readonly string $hint = '',
    ) {
        parent::__construct($message, $httpStatus);
    }

    public static function fromHttpStatus(int $status, string $body, string $uriPath): self
    {
        $hint = match (true) {
            $status === 401 => '서명 검증 실패입니다. Access/Secret Key와 서버 시각(NTP)을 확인하세요. '
                . 'timestamp는 5분 이상 어긋나면 거절됩니다.',
            $status === 403 => '해당 서비스에 대한 권한이 없습니다. NCP 서브계정 권한과 서비스 ID를 확인하세요.',
            $status === 404 => '서비스 ID 또는 API 경로가 잘못됐습니다: ' . $uriPath,
            $status === 429 => '요청 한도를 초과했습니다. 알림을 묶어 보내거나 지수 백오프로 재시도하세요.',
            $status >= 500 => 'NCP 서버 오류입니다. 같은 요청을 그대로 재시도해도 되지만, 중복 발송에 주의하세요.',
            default => '요청 본문(템플릿 코드·채널 ID·수신 번호)이 검수된 템플릿과 일치하는지 확인하세요.',
        };

        return new self(
            message: "SENS API 호출 실패(HTTP {$status})",
            httpStatus: $status,
            responseBody: $body,
            hint: $hint,
        );
    }

    public function isRetryable(): bool
    {
        return $this->httpStatus === 429 || $this->httpStatus >= 500;
    }
}
