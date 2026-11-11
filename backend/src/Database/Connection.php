<?php

declare(strict_types=1);

namespace SellerScope\Database;

use SellerScope\Support\Env;

/**
 * PDO 연결(MySQL 8.0).
 *
 * 기본값을 바꾼 세 가지에는 모두 이유가 있다.
 *
 *   1) ERRMODE_EXCEPTION — 오류를 조용히 false로 돌려주면 "저장된 줄 알았는데 0건"이
 *      된다. 정산 배치에서 그런 실패는 데이터 유실로 이어진다.
 *   2) EMULATE_PREPARES=false — 서버측 prepared statement를 쓴다. 에뮬레이션은 값을
 *      문자열로 이어 붙여 타입 정보가 사라지고(SQL 인젝션 방어는 되지만), 실행 계획을
 *      재사용하지 못한다. 100만 행 배치에서 이 차이가 크다.
 *   3) utf8mb4 + SET time_zone — 정산일·감사 로그가 KST 기준으로 저장돼야 한다.
 *      커넥션 타임존을 고정하지 않으면 서버 기본값(UTC)에 따라 "하루 전"으로 보인다.
 */
final class Connection
{
    private function __construct(private readonly \PDO $pdo)
    {
    }

    public static function fromEnv(): self
    {
        $host = Env::get('DB_HOST', '127.0.0.1');
        $port = Env::int('DB_PORT', 3306);
        $database = Env::get('DB_DATABASE', 'sellerscope');
        $socket = Env::get('DB_UNIX_SOCKET');

        $dsn = $socket !== null
            ? "mysql:unix_socket={$socket};dbname={$database};charset=utf8mb4"
            : "mysql:host={$host};port={$port};dbname={$database};charset=utf8mb4";

        return self::fromDsn(
            $dsn,
            Env::get('DB_USERNAME', 'root') ?? 'root',
            Env::get('DB_PASSWORD', '') ?? '',
            Env::get('DB_TIMEZONE', '+09:00') ?? '+09:00',
        );
    }

    public static function fromDsn(string $dsn, string $user, string $password, string $timezone = '+09:00'): self
    {
        $pdo = new \PDO($dsn, $user, $password, [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
            \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
            \PDO::ATTR_EMULATE_PREPARES => false,
            \PDO::ATTR_STRINGIFY_FETCHES => false,
            \PDO::ATTR_PERSISTENT => false,
        ]);

        // 서버가 5.7이면 8.0 전용 문법(윈도우 함수·CTE·row alias)이 조용히 실패한다.
        // 배포 사고의 절반은 "로컬은 8.0, 운영은 5.7"에서 나므로 접속 즉시 확인한다.
        $version = (string) $pdo->query('SELECT VERSION()')->fetchColumn();
        if (version_compare(preg_replace('/[^0-9.].*$/', '', $version) ?: '0', '8.0.19', '<')) {
            throw new \RuntimeException("MySQL 8.0.19 이상이 필요합니다(현재 {$version}).");
        }

        $pdo->exec("SET time_zone = '{$timezone}'");
        $pdo->exec("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO'");

        return new self($pdo);
    }

    public static function fromPdo(\PDO $pdo): self
    {
        return new self($pdo);
    }

    public function pdo(): \PDO
    {
        return $this->pdo;
    }

    /**
     * 트랜잭션 실행. 교착(1213)·잠금 대기 초과(1205)는 **재시도 가능한 실패**다.
     *
     * 정산 배치는 하루에 한 번, 여러 워커가 같은 테넌트의 다른 스토어를 갱신한다.
     * 같은 인덱스 범위를 스치는 순간 교착이 나는데, 이때 롤백하고 다시 하면 대부분 성공한다.
     * 재시도하지 않으면 새벽 배치가 "운이 나빠서" 실패하고, 아침에 아무도 결과를 못 본다.
     *
     * @template T
     * @param callable(\PDO):T $work
     * @return T
     */
    public function transaction(callable $work, int $maxAttempts = 3): mixed
    {
        $attempt = 0;
        beginning:
        $attempt++;

        $this->pdo->beginTransaction();
        try {
            $result = $work($this->pdo);
            $this->pdo->commit();

            return $result;
        } catch (\PDOException $e) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            $driverCode = (int) ($e->errorInfo[1] ?? 0);
            $retryable = in_array($driverCode, [1205, 1213], true);
            if ($retryable && $attempt < $maxAttempts) {
                usleep(50_000 * $attempt); // 50ms, 100ms — 재시도 폭주를 만들지 않을 만큼만
                goto beginning;
            }
            throw $e;
        } catch (\Throwable $e) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            throw $e;
        }
    }
}
