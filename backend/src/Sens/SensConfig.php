<?php

declare(strict_types=1);

namespace SellerScope\Sens;

/**
 * SENS 접속 설정(불변).
 *
 * 값은 전부 환경변수에서 온다. 서비스 ID·채널 ID·템플릿 코드를 코드에 박으면
 * 스테이징/운영을 같은 이미지로 돌릴 수 없고, 템플릿 코드는 카카오 검수 후에 바뀐다.
 */
final readonly class SensConfig
{
    public function __construct(
        public string $accessKey,
        public string $secretKey,
        public string $serviceId,
        public string $plusFriendId,
        public string $anomalyTemplateCode,
        public string $summaryTemplateCode,
        public ?string $failoverFrom = null,
        public string $baseUrl = 'https://sens.apigw.ntruss.com',
        public int $timeoutSeconds = 10,
    ) {
        if ($accessKey === '' || $secretKey === '') {
            throw new \InvalidArgumentException('SENS Access Key / Secret Key 가 비어 있습니다.');
        }
        if ($serviceId === '') {
            throw new \InvalidArgumentException('SENS 서비스 ID 가 비어 있습니다.');
        }
        if (!str_starts_with($plusFriendId, '@')) {
            throw new \InvalidArgumentException('카카오 채널 ID는 @로 시작해야 합니다(예: @sellerscope).');
        }
    }

    public function templateFor(string $templateCode): string
    {
        return $templateCode;
    }
}
