<?php

declare(strict_types=1);

namespace SellerScope\Sens;

/**
 * 발송할 알림톡 한 건.
 *
 * content는 **카카오에 등록·검수된 템플릿 본문과 일치해야** 한다(SENS가 문구를 대조한다).
 * 그래서 자유 문장을 만들지 않고, 템플릿의 `#{변수}`만 치환한다(AlimtalkTemplate 참고).
 *
 * useSmsFailover: 카톡 미가입·차단 사용자에게 SMS로 대체 발송하는 옵션. 발신번호가
 * 콘솔에 등록돼 있어야만 켤 수 있으므로, 발신번호가 없으면 자동으로 끈다
 * (켜 두고 실패하면 SENS가 400으로 거절한다).
 */
final readonly class AlimtalkMessage
{
    public string $recipientDigits;
    public string $countryCode;

    public function __construct(
        public string $to,
        public string $content,
        public string $templateCode,
        public string $plusFriendId,
        public ?string $failoverFrom = null,
        public bool $useSmsFailover = false,
        public ?string $title = null,
    ) {
        if (trim($content) === '') {
            throw new \InvalidArgumentException('알림톡 본문이 비어 있습니다.');
        }
        if (mb_strlen($content) > 1000) {
            // 카카오 알림톡 텍스트형 본문 상한. 넘으면 SENS가 3014로 거절한다.
            throw new \InvalidArgumentException('알림톡 본문은 1,000자를 넘을 수 없습니다: ' . mb_strlen($content) . '자');
        }

        $phone = RecipientPhone::fromString($to);
        $this->recipientDigits = $phone->digits;
        $this->countryCode = $phone->countryCode;
    }

    public function withContent(string $content): self
    {
        return new self(
            $this->to,
            $content,
            $this->templateCode,
            $this->plusFriendId,
            $this->failoverFrom,
            $this->useSmsFailover,
            $this->title,
        );
    }

    /** SENS `messages[]` 항목. */
    public function toPayload(): array
    {
        $payload = [
            'countryCode' => $this->countryCode,
            'to' => $this->recipientDigits,
            'content' => $this->content,
        ];
        if ($this->title !== null) {
            $payload['title'] = $this->title;
        }
        if ($this->useSmsFailover && $this->failoverFrom !== null) {
            $payload['useSmsFailover'] = true;
            $payload['failoverConfig'] = [
                'type' => mb_strlen($this->content) > 90 ? 'LMS' : 'SMS',
                'from' => preg_replace('/\D+/', '', $this->failoverFrom),
                'content' => $this->content,
            ];
        }

        return $payload;
    }

    /** 로그·DB에 남길 사본(전화번호는 마스킹해서 남긴다). */
    public function toAuditArray(): array
    {
        $payload = $this->toPayload();
        $payload['to'] = RecipientPhone::fromString($this->to)->masked();

        return $payload;
    }
}
