# SellerScope 백엔드 — PHP 8.2 · MySQL 8.0 · 네이버클라우드 SENS 알림톡

프론트엔드(Next.js 14)가 브라우저에서 하던 **정산 대사 판정**을 서버로 옮긴 계층입니다.
운영에서는 마켓 4~5곳의 정산서가 매일 밤 자동으로 들어오고, 100만 행을 배치로 다시 계산해
결과를 DB에 남겨야 합니다. 브라우저 탭이 닫히면 사라지는 계산은 감사 대상이 될 수 없습니다.

```
Next.js 14 (TypeScript, Web Worker 파싱)  ─┐
                                          ├─→  PHP 8.2 API/배치  ─→  MySQL 8.0
CLI 배치 (bin/reconcile.php)              ─┘         │
                                                    └─→  NCP SENS 알림톡 (카카오)
```

## 1. 5분 안에 돌려보기

```bash
# 1) MySQL 8.0 기동 (리포지토리 루트의 docker-compose.yml 사용)
docker compose up -d mysql

# 2) 의존성
cd backend
composer install

# 3) 환경변수
cp .env.example .env          # DB_* 값만 채워도 대사·조회는 동작한다(SENS 키 없으면 알림만 비활성)

# 4) 스키마 + 데모 데이터
php bin/migrate.php --fresh --seed --verify

# 5) 대사 배치 실행 (저장 + DB 집계와 대조)
php bin/reconcile.php --tenant=1 --file=examples/settlement_2026-10_sample.csv --verify

# 6) 테스트
composer test
```

실행 결과(로컬 MySQL 8.0.40 기준):

```
== 대사 결과 ==
대상 10건 · 정상 6건 · 이상 4건 (정상률 60.00%)
결제 314,600원 · 정산 203,218원 · 기대 212,013원
누수 8,795원 · 초과입금 0원 · 역마진 노출 2,596원
최대 원인: 반품비 중복 차감 5,000원
  수수료 초과 청구     2건  1,485원
  취소 건 수수료 청구    1건  2,310원
  반품비 중복 차감     1건  5,000원
  역마진(실효 마이너스)    2건  0원

저장 완료: 주문 10행, 이상 6행
[정합성] 계산 누수 8,795원 / DB 누수 8,795원 (차이 0원)
[정합성] 일치합니다.
```

## 2. API

| 메서드 | 경로 | 역할 |
| --- | --- | --- |
| `GET` | `/health` | 상태 + 알림톡 설정 여부 |
| `POST` | `/api/v1/reconciliations` | 정산 배치 수신 → 대사 → 저장(+critical 알림톡). 최대 5,000행 |
| `GET` | `/api/v1/reconciliations/summary` | 기간 요약(저장된 사실 기준) + 감사 체인 검증 결과 |
| `GET` | `/api/v1/reconciliations/rows` | 정산 행 목록(keyset pagination) |
| `GET` | `/api/v1/anomalies` | 열린 이상(심각도순) + 스토어별 원인 집계 |

```bash
curl -X POST http://127.0.0.1:8080/api/v1/reconciliations \
  -H 'Content-Type: application/json' \
  -d '{
    "tenant_id": 1,
    "source_file": "coupang_2026-10.csv",
    "notify_phone": "010-1234-5678",
    "actor": {"id": "kim@acme.co.kr", "role": "SETTLEMENT_MANAGER"},
    "rows": [{
      "order_no": "CP-20261006-0001", "channel": "coupang",
      "order_date": "2026-10-06", "settlement_date": "2026-10-20",
      "product_name": "무선 미니 가습기", "sku": "SKU-HUM-06", "quantity": 1,
      "paid_amount": 32000, "commission": 4000, "shipping_deduction": 0,
      "return_fee": 0, "settled_amount": 28000, "order_status": "배송완료",
      "unit_cost": 14500, "seller_shipping_cost": 2900
    }]
  }'
```

응답(요약): `persisted.orders/anomalies`, `summary`(프론트의 `ReconciliationSummary`와 같은 키),
`meta.parseErrors`, `alerts.sent/skipped/failed`.

## 3. 구조

```
backend/
├── public/index.php                     # front controller (DI + 라우팅 + 오류 정규화)
├── bin/
│   ├── migrate.php                      # schema.sql 적용 + 구조 검증
│   └── reconcile.php                    # CSV 배치(대용량) — 저장·검증·알림
├── src/
│   ├── Controllers/ReconciliationController.php   # 입력 검증 + 트랜잭션 경계
│   ├── Services/
│   │   ├── SettlementReconciliationService.php    # 대사·손실 귀속 엔진 (프론트와 동일 규칙)
│   │   ├── NaverCloudSensService.php              # SENS 서명·발송·결과 조회
│   │   ├── SettlementAlertComposer.php            # 알림톡 템플릿 변수 합성
│   │   └── SettlementAlertNotifier.php            # 중복 차단 + 실패 격리
│   ├── Repositories/
│   │   ├── SettlementRepository.php               # 배치 UPSERT, keyset 조회, DB 집계
│   │   ├── AnomalyRepository.php                  # 원인별 UPSERT(닫힌 상태 보존)
│   │   ├── AlimtalkLogRepository.php              # INSERT IGNORE 기반 원자적 선점
│   │   └── AuditLogRepository.php                 # 해시체인 append/verify
│   ├── Domain/                                    # Money, SettlementRow, Anomaly, enum …
│   ├── Database/Connection.php                    # PDO + 교착 재시도
│   ├── Http/                                      # Request, Router, JsonResponse
│   ├── Sens/                                      # SensConfig, AlimtalkMessage, 응답 값 객체
│   └── Support/                                   # Env, Clock, HttpClient(Curl)
├── tests/                                         # 75 테스트(단위 69 + MySQL 통합 6)
├── examples/settlement_2026-10_sample.csv
├── composer.json / phpunit.xml / .env.example
```

## 4. 설계 결정 (면접에서 물어보는 지점)

### 4.1 네이버클라우드 SENS 서명 — 문자열 한 글자가 401을 만든다

NCP API Gateway는 본문을 보지 않고 아래 문자열만 HMAC-SHA256으로 검증합니다.

```
POST + " " + /alimtalk/v2/services/{serviceId}/messages + "\n" + timestamp(ms) + "\n" + accessKey
→ base64(HMAC-SHA256(secretKey, 위 문자열))
```

실무에서 자주 틀리는 세 가지를 코드로 막았습니다.
1. **URI에 쿼리스트링 포함** — path만 서명하면 401이고, 원인이 "키가 틀렸다"처럼 보인다.
2. **서명에 쓴 timestamp를 헤더에 그대로** — 헤더에서 다시 계산하면 밀리초가 달라져 실패한다.
3. **서비스 ID의 콜론** — `ncp:kkobizmsg:kr:…:sens`를 `rawurlencode`로 `%3A`로 바꾸면 실제 경로와
   서명 문자열이 달라진다. 허용 문자만 남기는 방식으로 처리했다.

회귀 테스트는 **Python(hashlib/hmac)으로 독립 계산한 벡터**를 상수로 고정했습니다
(`tests/Services/NaverCloudSensServiceTest`). PHP로 만든 값을 PHP로 검증하는 순환을 피했습니다.

### 4.2 알림톡은 "보냈다"가 아니라 "도달했다"

- `202 Accepted`는 접수일 뿐입니다. `messageStatusCode = 0000`이어야 도달입니다.
- `3005`(AckTimeout)는 성공/실패 어느 쪽도 아니므로 `sent`(성공 불확실)로 따로 남깁니다.
- 카톡 미가입자용 SMS 대체 발송은 발신번호가 콘솔에 등록돼 있어야 켤 수 있습니다(없으면 자동 off).
- 템플릿은 카카오 검수가 필요합니다. 본문을 창작하지 않고 `#{변수}`만 치환합니다
  (`SettlementAlertComposer`). 변수에는 개행을 넣지 않습니다(템플릿 대조 실패의 흔한 원인).

등록해야 하는 템플릿 2종은 `src/Services/SettlementAlertComposer.php` 상단 주석에 그대로 있습니다.

### 4.3 알림 실패가 대사를 실패시키지 않는다

정산 대사는 돈이 걸린 배치입니다. 알림 서버가 죽었다고 배치를 롤백하면 셀러는 그날 결과를 못 봅니다.
그래서 알림은 부가 효과로 분리하고, 실패는 `alimtalk_logs.status='failed'`에 남겨 재시도 대상으로 넘깁니다.
`SettlementAlertNotifier`는 `SensException`과 네트워크 예외를 모두 잡아 카운트만 올립니다.

### 4.4 멱등성 — 배치를 두 번 돌려도 세상이 두 번 바뀌지 않는다

| 대상 | 장치 |
| --- | --- |
| 정산 행 | `UNIQUE (store_id, order_no)` + `INSERT … AS new ON DUPLICATE KEY UPDATE` |
| 이상 탐지 | `UNIQUE (order_id, anomaly_type)` + UPDATE 목록에서 `status` 제외(닫힌 이의 제기 보존) |
| 알림 | `UNIQUE (dedupe_key)` + `INSERT IGNORE`로 확인·적재를 한 문장에 |

### 4.5 반올림 — 화면과 서버가 1원도 어긋나지 않게

JavaScript `Math.round`는 `floor(x + 0.5)`입니다. PHP `round()` 기본값(0에서 먼 쪽)을 그대로 쓰면
음수에서 1원이 갈라집니다. `Money::round()`가 JS와 같은 식을 쓰고, `MoneyTest`가 그 등가성을 고정합니다.

### 4.6 트랜잭션과 교착

배치는 여러 워커가 같은 테넌트의 다른 스토어를 갱신합니다. 같은 인덱스 범위를 스치는 순간
교착(1213)이 납니다. `Connection::transaction()`이 1213/1205에서 최대 3회 재시도합니다.
재시도하지 않으면 새벽 배치가 "운이 나빠서" 실패하고 아침에 아무도 결과를 못 봅니다.

### 4.7 PDO 설정

`ERRMODE_EXCEPTION`(조용한 실패 금지), `EMULATE_PREPARES=false`(서버측 prepare, 실행 계획 재사용),
`SET time_zone='+09:00'`(정산일이 하루 밀리는 사고 방지), 접속 즉시 MySQL 8.0.19 이상 확인
(5.7에서 `AS new` 문법이 조용히 실패하는 것을 막는다).

## 5. 테스트

```bash
composer test                                   # 75 tests (MySQL 없으면 통합 6건 skip)
SELLERSCOPE_INTEGRATION=1 composer test         # MySQL 8.0 있으면 전부 실행
```

| 파일 | 검증 내용 |
| --- | --- |
| `Domain/MoneyTest` | JS `Math.round` 등가성(음수 포함), 비율 2자리 |
| `Services/SettlementReconciliationServiceTest` | 11개 이상 유형의 금액·귀속·중복 계산 방지(골든 케이스) |
| `Services/NaverCloudSensServiceTest` | 서명 벡터 2종, 헤더 일관성, 100건 청킹, 오류 힌트, 도달 상태 구분 |
| `Services/SettlementAlertComposerTest` | 템플릿 변수·길이 상한·개행 제거·dedupe 키 |
| `Services/SettlementAlertNotifierTest` | 중복 차단, critical만 발송, API/네트워크 실패 격리 |
| `Repositories/SettlementRepositorySqlTest` | UPSERT 문법·바인딩 수·원본 컬럼 불변 |
| `Integration/DatabaseIntegrationTest` | 실 MySQL: UPSERT 멱등성, 닫힌 이상 보존, 알림 선점, 감사 체인 변조 탐지, FK/CHECK |

## 6. 운영

| 항목 | 방법 |
| --- | --- |
| 야간 배치 | `cron`: `0 3 * * * cd /app/backend && php bin/reconcile.php --tenant=1 --file=/data/coupang_$(date +%F).csv --verify --phone=010…` |
| 실패 알림 | CLI 종료 코드(0 성공 / 1 입력 오류 / 2 정합성 불일치)를 모니터링이 수집 |
| 알림 재시도 | `alimtalk_logs.status IN ('queued','failed') AND attempts < 3`을 5분 주기 워커가 재발송 |
| 감사 로그 | `GET /api/v1/reconciliations/summary`의 `auditChain`이 `valid=false`면 즉시 경보 |

## 7. 한계와 다음 단계

- **인증**: 지금은 `actor`를 요청 본문에서 받습니다. 실서비스는 NCP API Gateway 키 또는 사내 SSO
  토큰에서 `actor`를 꺼내고, `settlement.amount`/`export.csv` 권한을 서버에서 판정해야 합니다
  (권한 규칙은 프론트 `multiTenantRbac.ts`에 이미 있고, 서버로 옮기는 것이 다음 작업입니다).
- **파일 업로드**: 5,000행 초과는 CLI 경로를 씁니다. S3/NCP Object Storage presigned URL 업로드 +
  큐 적재로 바꾸면 API 하나로 통일됩니다.
- **알림 결과 폴링**: `fetchDelivery()`는 구현되어 있지만 스케줄러가 아직 없습니다
  (`alimtalk_logs.message_id`로 조회 후 `markDelivery`).
