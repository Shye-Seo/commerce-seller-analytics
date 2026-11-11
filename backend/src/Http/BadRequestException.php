<?php

declare(strict_types=1);

namespace SellerScope\Http;

/** 클라이언트 잘못(400). 컨트롤러가 잡아 JSON 오류 응답으로 바꾼다. */
class BadRequestException extends \RuntimeException
{
    public function __construct(string $message, private readonly array $details = [])
    {
        parent::__construct($message);
    }

    public function details(): array
    {
        return $this->details;
    }
}
