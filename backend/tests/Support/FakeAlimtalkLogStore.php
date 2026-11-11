<?php

declare(strict_types=1);

namespace SellerScope\Tests\Support;

use SellerScope\Repositories\AlimtalkLogStore;
use SellerScope\Sens\AlimtalkMessage;
use SellerScope\Sens\AlimtalkSendResult;

final class FakeAlimtalkLogStore implements AlimtalkLogStore
{
    /** @var array<string,int> dedupeKey => id */
    public array $claimed = [];

    /** @var list<array{id:int,error:string}> */
    public array $failures = [];

    /** @var list<array{id:int,requestId:string}> */
    public array $accepted = [];

    private int $nextId = 1;

    public function __construct(private readonly array $alreadySent = [])
    {
        foreach ($alreadySent as $key) {
            $this->claimed[$key] = $this->nextId++;
        }
    }

    public function claim(
        int $tenantId,
        string $dedupeKey,
        string $templateCode,
        string $plusFriendId,
        string $recipientPhone,
        ?string $batchId,
        array $payload,
        \DateTimeImmutable $now,
    ): ?int {
        if (isset($this->claimed[$dedupeKey])) {
            return null;
        }
        $id = $this->nextId++;
        $this->claimed[$dedupeKey] = $id;

        return $id;
    }

    public function markAccepted(int $id, AlimtalkSendResult $result, AlimtalkMessage $message, \DateTimeImmutable $now): void
    {
        $this->accepted[] = ['id' => $id, 'requestId' => $result->requestId];
    }

    public function markFailed(int $id, string $error, \DateTimeImmutable $now): void
    {
        $this->failures[] = ['id' => $id, 'error' => $error];
    }
}
