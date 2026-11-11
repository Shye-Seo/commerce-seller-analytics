#!/usr/bin/env php
<?php

declare(strict_types=1);

/**
 * 스키마 마이그레이션 실행기.
 *
 * 사용
 *   php backend/bin/migrate.php                 # database/schema.sql 적용
 *   php backend/bin/migrate.php --fresh         # DB를 지우고 다시 만든다(개발 전용)
 *   php backend/bin/migrate.php --seed          # 데모 데이터까지 적재
 *   php backend/bin/migrate.php --verify        # 적용 결과(테이블·인덱스·FK) 점검
 *
 * 왜 마이그레이션 도구(Phinx/Flyway)를 쓰지 않았나: 이 저장소의 스키마는 6개 테이블이고,
 * 면접관이 "어떤 DDL이 언제 적용됐는지"를 파일 하나로 확인할 수 있는 편이 낫다.
 * 대신 실행기는 (1) 문장 단위 분리, (2) 적용 후 구조 검증, (3) 실패 시 즉시 중단을 한다.
 */

require __DIR__ . '/../vendor/autoload.php';

use SellerScope\Database\Connection;
use SellerScope\Support\Env;

Env::load(__DIR__ . '/../.env');

$options = getopt('', ['fresh', 'seed', 'verify', 'help', 'sql::']);

if (isset($options['help'])) {
    fwrite(STDOUT, <<<TXT
    사용법: php backend/bin/migrate.php [--fresh] [--seed] [--verify]

      --fresh   기존 sellerscope DB를 삭제하고 새로 만든다 (개발 전용)
      --seed    database/seed_demo.sql 을 이어서 실행한다
      --verify  테이블·인덱스·외래키를 조회해 적용 상태를 요약한다

    TXT);
    exit(0);
}

$schemaPath = $options['sql'] ?? __DIR__ . '/../../database/schema.sql';
if (!is_readable($schemaPath)) {
    fwrite(STDERR, "스키마 파일을 찾을 수 없습니다: {$schemaPath}\n");
    exit(1);
}

$host = Env::get('DB_HOST', '127.0.0.1');
$port = Env::int('DB_PORT', 3306);
$socket = Env::get('DB_UNIX_SOCKET');
$user = Env::get('DB_USERNAME', 'root') ?? 'root';
$password = Env::get('DB_PASSWORD', '') ?? '';
$database = Env::get('DB_DATABASE', 'sellerscope') ?? 'sellerscope';

$serverDsn = $socket !== null
    ? "mysql:unix_socket={$socket};charset=utf8mb4"
    : "mysql:host={$host};port={$port};charset=utf8mb4";

try {
    $connection = Connection::fromDsn($serverDsn, $user, $password, Env::get('DB_TIMEZONE', '+09:00') ?? '+09:00');
} catch (\Throwable $e) {
    fwrite(STDERR, "MySQL 접속 실패: {$e->getMessage()}\n");
    exit(1);
}
$pdo = $connection->pdo();

if (isset($options['fresh'])) {
    $pdo->exec("DROP DATABASE IF EXISTS `{$database}`");
    fwrite(STDOUT, "기존 DB 삭제: {$database}\n");
}

/**
 * SQL 파일을 문장 단위로 분리한다.
 *
 * 전용 파서를 쓰지 않는 이유: 이 스키마는 프로시저·트리거가 없고, 문자열 리터럴 안에
 * 세미콜론이 없다. 그 조건에서 "줄 끝이 세미콜론"이면 문장 경계다. 조건이 깨지는
 * DDL(프로시저)을 추가할 때는 이 함수를 반드시 바꿔야 한다는 것을 주석으로 남긴다.
 *
 * @return list<string>
 */
function splitStatements(string $sql): array
{
    $statements = [];
    $buffer = '';

    // \R은 PCRE에서 NEL(0x85)까지 개행으로 본다. UTF-8 한글의 연속 바이트에 0x85가
    // 흔히 들어 있어(예: '셀' = EC 85 80) 문장이 중간에서 쪼개진다. 개행만 명시한다.
    foreach (explode("\n", str_replace("\r\n", "\n", $sql)) as $line) {
        $trimmed = trim($line);
        if ($trimmed === '' || str_starts_with($trimmed, '--') || str_starts_with($trimmed, '#')) {
            continue;
        }
        $buffer .= $line . "\n";
        if (str_ends_with($trimmed, ';')) {
            $statement = rtrim(trim($buffer), ';');
            if ($statement !== '') {
                $statements[] = $statement;
            }
            $buffer = '';
        }
    }

    if (trim($buffer) !== '') {
        $statements[] = trim($buffer);
    }

    return $statements;
}

$sql = file_get_contents($schemaPath) ?: '';
$statements = splitStatements($sql);

fwrite(STDOUT, sprintf("스키마 적용: %s (%d statements)\n", basename($schemaPath), count($statements)));

$startedAt = microtime(true);
foreach ($statements as $index => $statement) {
    try {
        $pdo->exec($statement);
    } catch (\PDOException $e) {
        fwrite(STDERR, sprintf("실패: #%d %s\n  %s\n", $index + 1, mb_substr($statement, 0, 160), $e->getMessage()));
        exit(1);
    }
}
fwrite(STDOUT, sprintf("완료: %.2fs\n", microtime(true) - $startedAt));

if (isset($options['seed'])) {
    $seedPath = __DIR__ . '/../../database/seed_demo.sql';
    if (is_readable($seedPath)) {
        $pdo->exec("USE `{$database}`");
        foreach (splitStatements((string) file_get_contents($seedPath)) as $statement) {
            $pdo->exec($statement);
        }
        fwrite(STDOUT, "데모 데이터 적재 완료: seed_demo.sql\n");
    }
}

// ---------------------------------------------------------------------------
// 적용 결과 검증 — "돌았다"와 "의도한 구조가 됐다"는 다르다.
// ---------------------------------------------------------------------------
$pdo->exec("USE `{$database}`");

$tables = $pdo->query('SHOW TABLES')->fetchAll(\PDO::FETCH_COLUMN);
fwrite(STDOUT, sprintf("\n테이블 %d개: %s\n", count($tables), implode(', ', $tables)));

$expected = ['tenants', 'stores', 'settlement_orders', 'reconciliation_anomalies', 'alimtalk_logs', 'audit_logs'];
$missing = array_diff($expected, $tables);
if ($missing !== []) {
    fwrite(STDERR, '누락된 테이블: ' . implode(', ', $missing) . "\n");
    exit(1);
}

if (isset($options['verify'])) {
    foreach ($expected as $table) {
        $indexes = $pdo->query("SHOW INDEX FROM `{$table}`")->fetchAll();
        $keys = array_values(array_unique(array_column($indexes, 'Key_name')));
        $fks = $pdo->query(
            "SELECT CONSTRAINT_NAME, REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{$table}' AND REFERENCED_TABLE_NAME IS NOT NULL"
        )->fetchAll();
        fwrite(STDOUT, sprintf(
            "  %-26s indexes=%s fks=%s\n",
            $table,
            implode('/', $keys),
            implode('/', array_map(static fn (array $fk): string => $fk['CONSTRAINT_NAME'] . '→' . $fk['REFERENCED_TABLE_NAME'], $fks)) ?: '-',
        ));
    }

    $engine = $pdo->query(
        "SELECT ENGINE, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() LIMIT 1"
    )->fetch();
    fwrite(STDOUT, sprintf("  engine=%s collation=%s\n", $engine['ENGINE'], $engine['TABLE_COLLATION']));
}

fwrite(STDOUT, "\n스키마 준비 완료.\n");
