<?php

declare(strict_types=1);

namespace SellerScope\Domain;

/** 대사 실행 결과 묶음(행 + 요약 + 실행 메타). */
final readonly class ReconciliationResult
{
    /**
     * @param list<ReconciledRow> $rows
     */
    public function __construct(
        public array $rows,
        public ReconciliationSummary $summary,
        public int $parseErrorCount,
        public int $sourceRowCount,
        public int $elapsedMs,
        public bool $customContract,
    ) {
    }

    public function rowsPerSecond(): int
    {
        return $this->elapsedMs > 0 ? (int) round((count($this->rows) / $this->elapsedMs) * 1000) : 0;
    }

    public function toArray(): array
    {
        return [
            'summary' => $this->summary->toArray(),
            'meta' => [
                'parseErrorCount' => $this->parseErrorCount,
                'sourceRowCount' => $this->sourceRowCount,
                'elapsedMs' => $this->elapsedMs,
                'rowsPerSecond' => $this->rowsPerSecond(),
                'contractSource' => $this->customContract ? 'custom' : 'preset',
            ],
        ];
    }
}
