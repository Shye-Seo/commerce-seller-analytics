-- =============================================================================
-- SellerScope · 이커머스 셀러 정산 대사 플랫폼 — MySQL 8.0 DDL
-- =============================================================================
-- 실행
--   mysql -u root -p < database/schema.sql
--   php backend/bin/migrate.php            (같은 파일을 애플리케이션에서 실행)
--
-- 설계 원칙
--   1) 금액은 전부 "원 단위 정수(INT)"로 저장한다. DECIMAL(15,2)를 쓰지 않는 이유:
--      원화 정산은 소수점 단위 결제가 없고, 대사 로직이 `반올림 후 정수 비교`로
--      고정되어 있다(프론트엔드 reconciliationEngine.ts와 동일 규칙). 실수를 넣으면
--      앱과 DB가 서로 다른 반올림 규칙을 쓰게 되어 "1원 차이"가 재현되지 않는다.
--   2) 정산서 원본 값과 대사 결과 값을 같은 행에 둔다. 원본(paid_amount …
--      settled_amount)은 마켓이 준 값이라 절대 덮어쓰지 않고, 결과(expected_*,
--      variance, shortfall, net_margin)는 배치가 다시 계산해 갱신한다. 그래서
--      "마켓이 뭐라고 했는지"와 "우리가 어떻게 판정했는지"를 한 행에서 대조할 수 있다.
--   3) 멀티 테넌트는 모든 조회의 선행 조건이다. 업무 테이블은 예외 없이 tenant_id를
--      갖고, 인덱스도 tenant_id를 맨 앞에 두어 테넌트 스코프 없이 스캔되는 경로를
--      만들지 않는다.
--   4) 이상 탐지 결과는 (order_id, anomaly_type) 유니크로 멱등하다. 같은 정산서를
--      두 번 올려도 알림톡이 두 번 가지 않는다.
-- =============================================================================

SET NAMES utf8mb4;
SET time_zone = '+09:00';

CREATE DATABASE IF NOT EXISTS sellerscope
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_0900_ai_ci;

USE sellerscope;

-- -----------------------------------------------------------------------------
-- 1. tenants — 법인(테넌트)
-- -----------------------------------------------------------------------------
-- 본사(HQ) 아래 지사(BRANCH)와 위탁사(CONSIGNMENT)가 붙는 1:N 트리다. parent_id를
-- NULL 허용으로 둔 것은 본사만 루트이기 때문이며, 자기 참조 FK로 "지사가 지사를
-- 참조하는 실수"는 막되 "지사가 본사를 참조하는 정상 관계"는 허용한다.
-- ON DELETE RESTRICT: 법인을 지우면 정산 이력이 고아가 되므로 삭제 대신
-- status='archived'로 닫는다(회계 데이터는 삭제 대상이 아니다).
-- -----------------------------------------------------------------------------
CREATE TABLE tenants (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '법인 PK',
  code              VARCHAR(32)     NOT NULL                COMMENT '법인 코드(tn-hq 등). API·감사로그가 참조하는 안정 식별자',
  name              VARCHAR(120)    NOT NULL                COMMENT '법인명',
  business_no       CHAR(10)        NULL                    COMMENT '사업자등록번호 10자리(숫자만). 하이픈 표기는 애플리케이션이 만든다',
  tier              ENUM('HQ','BRANCH','CONSIGNMENT') NOT NULL DEFAULT 'HQ' COMMENT '법인 구분: 본사/지사/위탁사',
  parent_id         BIGINT UNSIGNED NULL                    COMMENT '상위 법인 id. 본사는 NULL',
  settlement_cycle  VARCHAR(40)     NOT NULL DEFAULT '월 1회 · 익월 10일' COMMENT '정산 주기 표기(계약서 문구 그대로)',
  seat_count        SMALLINT UNSIGNED NOT NULL DEFAULT 0    COMMENT '허용 좌석(계정) 수',
  status            ENUM('active','suspended','archived') NOT NULL DEFAULT 'active' COMMENT 'active=사용중, suspended=정지, archived=계약종료(이력 보존)',
  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_tenants_code (code),
  KEY idx_tenants_parent (parent_id),
  KEY idx_tenants_tier_status (tier, status) COMMENT '본사 직속 지사 목록·활성 법인 집계용',
  CONSTRAINT fk_tenants_parent FOREIGN KEY (parent_id) REFERENCES tenants (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_tenants_business_no CHECK (business_no IS NULL OR business_no REGEXP '^[0-9]{10}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='법인(테넌트). 멀티테넌트 격리의 루트';

-- -----------------------------------------------------------------------------
-- 2. stores — 판매 채널(스토어)과 계약 조건
-- -----------------------------------------------------------------------------
-- 수수료율·배송비는 "스토어의 계약"이지 "테넌트의 속성"이 아니다. 같은 법인이
-- 스마트스토어는 3.63%, 쿠팡은 10.8%로 계약하기 때문이다. 대사 엔진은 이 행을
-- ContractTerms로 읽어 기대 정산액을 재계산한다.
-- 금액 3종(outbound_shipping, round_trip_return_fee)은 원 단위 INT이고,
-- 요율 1종은 DECIMAL(5,2)(0.00~999.99%)다. 요율만 DECIMAL인 이유는 3.63%처럼
-- 소수 둘째 자리 계약이 실제로 존재하기 때문이다.
-- -----------------------------------------------------------------------------
CREATE TABLE stores (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '스토어 PK',
  tenant_id               BIGINT UNSIGNED NOT NULL                COMMENT '소유 법인',
  code                    VARCHAR(32)     NOT NULL                COMMENT '스토어 코드(내부 관리번호)',
  name                    VARCHAR(120)    NOT NULL                COMMENT '스토어명',
  channel                 ENUM('smartstore','coupang','elevenst','gmarket','own') NOT NULL COMMENT '판매 채널',
  contract_fee_rate       DECIMAL(5,2)    NOT NULL DEFAULT 0.00   COMMENT '계약 판매 수수료율(%)',
  outbound_shipping       INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '계약상 셀러 부담 기본 배송비(원)',
  round_trip_return_fee   INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '계약상 반품 왕복 배송비(원)',
  is_active               TINYINT(1)      NOT NULL DEFAULT 1      COMMENT '계약 유효 여부. 0이면 대사 대상에서 제외',
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_stores_tenant_code (tenant_id, code) COMMENT '같은 법인 안에서 스토어 코드는 유일, 다른 법인과는 겹쳐도 된다',
  KEY idx_stores_tenant_channel (tenant_id, channel) COMMENT '법인의 채널별 스토어 목록',
  CONSTRAINT fk_stores_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT chk_stores_fee_rate CHECK (contract_fee_rate >= 0 AND contract_fee_rate < 100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='판매 채널(마켓 스토어)과 계약 조건. 대사 기준값의 원천';

-- -----------------------------------------------------------------------------
-- 3. settlement_orders — 정산서 한 행(주문 단위) + 원가 원장 + 대사 결과
-- -----------------------------------------------------------------------------
-- 이 테이블이 시스템의 심장이다. 한 행이 "마켓이 준 정산 1줄"과 "우리 원장의 원가"를
-- 동시에 갖고, 배치가 대사 결과를 같은 행에 채워 넣는다.
--
-- 왜 정산서 원본과 대사 결과를 분리하지 않았나
--   · 대사는 10만 행 단위로 다시 돌린다. 원본과 결과를 다른 테이블로 나누면 매 실행마다
--     조인 2회 + 결과 행 10만 건 재삽입이 필요하다. 한 행에 두면 UPSERT 한 번으로 끝난다.
--   · 반대로 "원본 컬럼은 절대 UPDATE 하지 않는다"는 규칙을 컬럼 COMMENT로 못 박아
--     재계산이 마켓 값을 덮어쓰는 사고를 막는다.
--
-- 인덱스 설계(브리프 지정 2종 포함)
--   · uq_orders_store_order (store_id, order_no)
--       재업로드 멱등성의 기준. 정산서를 다시 올리면 "새 행"이 아니라 "같은 행 갱신"이 된다.
--   · idx_orders_tenant_settlement (tenant_id, settlement_date, channel)
--       대시보드의 주 조회 패턴: "이 법인의 이번 달 정산일 구간, 채널별 합계".
--       tenant_id가 선두라 테넌트 스코프가 인덱스에서 바로 잘린다(테넌트 간 데이터 누출
--       방지 + 파티션 프루닝과 같은 효과). settlement_date는 DATE라 BETWEEN 범위 스캔이
--       가능하고, 세 번째 컬럼 channel은 커버링에 가깝게 만들어 채널별 GROUP BY의
--       정렬·임시테이블을 없앤다.
--   · idx_orders_tenant_flagged (tenant_id, reconciled, settlement_date)
--       "이상 있는 행만" 보는 화면. 카디널리티가 낮은 reconciled을 중간에 두는 대신
--       tenant_id(고카디널리티) + 날짜 범위로 스캔 폭을 먼저 줄인다.
--   · idx_orders_loss (tenant_id, loss DESC)
--       손실 큰 순 정렬. MySQL 8.0은 DESC 인덱스를 실제로 내림차순 저장하므로 filesort가 사라진다.
-- -----------------------------------------------------------------------------
CREATE TABLE settlement_orders (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '정산 행 PK',
  tenant_id              BIGINT UNSIGNED NOT NULL                COMMENT '소유 법인(모든 조회의 선행 조건)',
  store_id               BIGINT UNSIGNED NOT NULL                COMMENT '판매 스토어(계약 조건의 출처)',
  batch_id               CHAR(36)        NOT NULL                COMMENT '업로드/대사 배치 UUID. 같은 파일 재처리 추적',
  order_no               VARCHAR(40)     NOT NULL                COMMENT '마켓 주문번호',
  channel                ENUM('smartstore','coupang','elevenst','gmarket','own') NOT NULL COMMENT '판매 채널(비정규화: 인덱스 커버용)',
  -- 원본(마켓 정산서) -------------------------------------------------------
  order_date             DATE            NOT NULL                COMMENT '주문일',
  settlement_date        DATE            NULL                    COMMENT '정산 지급 예정/실행일. 미정이면 NULL',
  product_name           VARCHAR(200)    NOT NULL                COMMENT '상품명(정산서 표기 그대로)',
  sku                    VARCHAR(64)     NOT NULL                COMMENT '셀러 내부 SKU',
  quantity               SMALLINT UNSIGNED NOT NULL DEFAULT 1     COMMENT '주문 수량',
  paid_amount            INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '소비자 결제금액(원). 반품·취소 건도 "원래 결제액"을 유지한다',
  commission             INT             NOT NULL DEFAULT 0      COMMENT '마켓이 청구한 판매 수수료(원)',
  shipping_deduction     INT             NOT NULL DEFAULT 0      COMMENT '마켓이 차감한 배송비(원)',
  return_fee             INT             NOT NULL DEFAULT 0      COMMENT '마켓이 차감한 반품비(원)',
  settled_amount         INT             NOT NULL DEFAULT 0      COMMENT '실제 입금된 정산액(원). 차감 정산이면 음수',
  order_status           ENUM('SHIPPED','RETURNED','CANCELED','EXCHANGED') NOT NULL DEFAULT 'SHIPPED'
                         COMMENT '배송완료/반품완료/취소/교환완료. 한글 상태명은 애플리케이션 enum이 만든다',
  -- 원장(셀러 내부) ---------------------------------------------------------
  unit_cost              INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '상품 매입원가(원, 1개 기준). 0이면 MISSING_LEDGER',
  seller_shipping_cost   INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '셀러가 실제 부담한 배송원가(원, 주문 단위)',
  -- 대사 결과(배치가 계산·갱신) ---------------------------------------------
  expected_commission    INT             NOT NULL DEFAULT 0      COMMENT '계약 수수료율로 재계산한 기대 수수료(원)',
  expected_settlement    INT             NOT NULL DEFAULT 0      COMMENT '계약 기준 기대 정산액(원)',
  variance               INT             NOT NULL DEFAULT 0      COMMENT '실제 - 기대(원). 음수면 셀러가 덜 받음',
  shortfall              INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '부족분(0 이상). 원인별 귀속액의 상한',
  surplus                INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '초과 입금분(0 이상)',
  effective_fee_rate     DECIMAL(7,2)    NOT NULL DEFAULT 0.00   COMMENT '실효 수수료율(%) = 청구 수수료 / 결제금액',
  net_margin             INT             NOT NULL DEFAULT 0      COMMENT '실효 마진(원) = 정산액 - 원가 - 실배송원가',
  margin_rate            DECIMAL(7,2)    NOT NULL DEFAULT 0.00   COMMENT '실효 마진율(%)',
  loss                   INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '이 행에서 확인된 손실(원). shortfall을 넘지 않는다',
  reconciled             TINYINT(1)      NOT NULL DEFAULT 1      COMMENT '1=이상 없음, 0=이상 탐지',
  -- 처리 이력 --------------------------------------------------------------
  source_file            VARCHAR(255)    NULL                    COMMENT '업로드 원본 파일명',
  reconciled_at          DATETIME(3)     NULL                    COMMENT '마지막 대사 실행 시각',
  ingested_at            DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '최초 적재 시각',
  updated_at             DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_orders_store_order (store_id, order_no) COMMENT '재업로드 멱등성: 같은 스토어의 같은 주문은 한 행',
  KEY idx_orders_tenant_settlement (tenant_id, settlement_date, channel) COMMENT '주 조회 패턴: 테넌트 + 정산일 범위 + 채널 집계',
  KEY idx_orders_tenant_flagged (tenant_id, reconciled, settlement_date) COMMENT '이상 행만 보기',
  KEY idx_orders_loss (tenant_id, loss DESC) COMMENT '손실 큰 순 정렬(filesort 제거)',
  KEY idx_orders_batch (tenant_id, batch_id) COMMENT '배치 단위 재처리·롤백 추적',
  KEY idx_orders_sku (tenant_id, sku) COMMENT 'SKU별 손실 집계',
  CONSTRAINT fk_orders_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_orders_store FOREIGN KEY (store_id) REFERENCES stores (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_orders_quantity CHECK (quantity >= 1),
  CONSTRAINT chk_orders_shortfall CHECK (shortfall = 0 OR variance < 0),
  CONSTRAINT chk_orders_amounts CHECK (paid_amount >= 0 AND unit_cost >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='정산서 원본 행 + 원가 원장 + 대사 결과(주문 단위)';

-- -----------------------------------------------------------------------------
-- 4. reconciliation_anomalies — 이상 탐지 결과(원인별 귀속)
-- -----------------------------------------------------------------------------
-- 한 주문에서 "수수료 초과 1,900원 + 반품비 중복 1,500원"처럼 원인이 여러 개 나올 수
-- 있으므로 1:N이다. 핵심 불변식은 anomalies.loss_amount 합계 <= orders.shortfall이다.
-- (엔진이 shortfall을 넘지 않게 배정하고, 초과분은 SETTLEMENT_SHORTFALL로 남긴다.)
--
-- 인덱스 설계
--   · uq_anomalies_order_type (order_id, anomaly_type)
--       같은 주문·같은 원인은 한 번만. 배치 재실행 시 UPSERT로 상태(open→resolved)만 바뀐다.
--   · idx_anomalies_store_type (store_id, anomaly_type)
--       브리프 지정 인덱스. "이 스토어에서 수수료 초과가 몇 건인가"를 채널 단위로 집계하며,
--       마켓과 이의 제기(분쟁)를 할 때 실제로 쓰는 조회다. store_id가 선두라 특정 마켓만
--       골라내는 범위 스캔이 된다.
--   · idx_anomalies_tenant_severity_open (tenant_id, status, severity, created_at)
--       운영 큐: 열린 critical부터 처리. status='open' 조건과 severity 정렬을 함께 탄다.
-- -----------------------------------------------------------------------------
CREATE TABLE reconciliation_anomalies (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '이상 탐지 PK',
  tenant_id        BIGINT UNSIGNED NOT NULL                COMMENT '소유 법인(조회 선행 조건)',
  store_id         BIGINT UNSIGNED NOT NULL                COMMENT '판매 스토어(마켓 이의 제기 단위)',
  order_id         BIGINT UNSIGNED NOT NULL                COMMENT '대상 정산 행',
  batch_id         CHAR(36)        NOT NULL                COMMENT '탐지 배치 UUID',
  anomaly_type     VARCHAR(40)     NOT NULL                COMMENT 'FEE_OVERCHARGE, RETURN_FEE_DOUBLE_CHARGED … (엔진 enum과 1:1)',
  category         ENUM('fee','logistics','settlement','margin','data') NOT NULL COMMENT '원인 분류',
  severity         ENUM('critical','warning','info') NOT NULL COMMENT '심각도. critical만 알림톡 즉시 발송',
  expected_amount  INT             NOT NULL DEFAULT 0      COMMENT '계약 기준 기대값(원)',
  actual_amount    INT             NOT NULL DEFAULT 0      COMMENT '정산서 실제값(원)',
  loss_amount      INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '이 원인에 귀속된 손실액(원)',
  detail           VARCHAR(500)    NOT NULL                COMMENT '사람이 읽는 한 줄 설명(마켓에 그대로 붙여넣을 수 있는 문장)',
  status           ENUM('open','acknowledged','disputed','resolved','ignored') NOT NULL DEFAULT 'open'
                   COMMENT 'open=미처리, acknowledged=확인, disputed=마켓 이의제기, resolved=환급완료, ignored=무시',
  resolution_note  VARCHAR(500)    NULL                    COMMENT '처리 메모(환급 금액·담당자)',
  resolved_at      DATETIME(3)     NULL,
  created_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_anomalies_order_type (order_id, anomaly_type) COMMENT '배치 멱등성: 같은 주문·같은 원인은 1행',
  KEY idx_anomalies_store_type (store_id, anomaly_type) COMMENT '스토어(마켓)별 원인 집계 — 이의 제기 근거',
  KEY idx_anomalies_tenant_severity_open (tenant_id, status, severity, created_at) COMMENT '운영 큐: 열린 critical 우선',
  KEY idx_anomalies_batch (tenant_id, batch_id),
  CONSTRAINT fk_anomalies_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_anomalies_store FOREIGN KEY (store_id) REFERENCES stores (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_anomalies_order FOREIGN KEY (order_id) REFERENCES settlement_orders (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT chk_anomalies_loss CHECK (loss_amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='이상 탐지 결과. 원인별 손실 귀속 1:N';

-- -----------------------------------------------------------------------------
-- 5. alimtalk_logs — 네이버클라우드 SENS 알림톡 발송 이력
-- -----------------------------------------------------------------------------
-- 알림톡은 "보냈다"가 아니라 "도달했다"가 중요하다. 발송 요청(202 Accepted)과 수신 결과
-- (0000 성공)는 다르고, 카톡 미가입자는 SMS 대체 발송으로 넘어간다. 그래서 한 행에
-- request_id(요청) + message_id(건별) + message_status_code(수신)를 모두 남긴다.
--
-- dedupe_key UNIQUE: 같은 배치에서 같은 이상 유형으로 두 번 알리지 않는다.
--   예) 'anomaly:1024:FEE_OVERCHARGE'. 배치를 다시 돌려도 INSERT가 무시된다.
-- request_payload JSON: 실제로 보낸 본문(템플릿 치환 결과)을 남긴다. 나중에 "왜 이런
--   문구가 갔나"를 추적할 수 없으면 CS 대응이 불가능하다.
-- -----------------------------------------------------------------------------
CREATE TABLE alimtalk_logs (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '발송 이력 PK',
  tenant_id           BIGINT UNSIGNED NOT NULL                COMMENT '수신 테넌트(알림 대상 법인)',
  anomaly_id          BIGINT UNSIGNED NULL                    COMMENT '계기가 된 이상 탐지. 요약 알림은 NULL',
  batch_id            CHAR(36)        NULL                    COMMENT '대사 배치 UUID',
  template_code       VARCHAR(40)     NOT NULL                COMMENT 'SENS에 등록·검수된 템플릿 코드',
  plus_friend_id      VARCHAR(40)     NOT NULL                COMMENT '카카오톡 채널 아이디(@채널)',
  recipient_phone     VARCHAR(20)     NOT NULL                COMMENT '수신 번호(숫자만, 국가코드 제외)',
  recipient_role      VARCHAR(40)     NULL                    COMMENT '수신자 역할(대표/정산담당). 템플릿 문구 개인화용',
  dedupe_key          VARCHAR(120)    NOT NULL                COMMENT '중복 발송 방지 키. UNIQUE',
  request_id          VARCHAR(80)     NULL                    COMMENT 'SENS 요청 아이디(묶음 단위)',
  message_id          VARCHAR(80)     NULL                    COMMENT 'SENS 메시지 아이디(건 단위). 결과 조회 키',
  status              ENUM('queued','accepted','sent','delivered','failed','fallback_sent') NOT NULL DEFAULT 'queued'
                      COMMENT 'queued=적재, accepted=202 수락, delivered=0000 도달, failed=실패, fallback_sent=SMS 대체',
  message_status_code VARCHAR(8)      NULL                    COMMENT 'SENS 수신 결과 코드(0000=정상). 3005=성공 불확실',
  message_status_desc VARCHAR(200)    NULL                    COMMENT 'SENS 수신 결과 설명',
  attempts            TINYINT UNSIGNED NOT NULL DEFAULT 0     COMMENT '발송 시도 횟수(지수 백오프 재시도 포함)',
  request_payload     JSON            NULL                    COMMENT '실제 전송 본문(템플릿 치환 결과) — CS 추적용',
  response_payload    JSON            NULL                    COMMENT 'SENS 응답 원문',
  error_message       VARCHAR(500)    NULL                    COMMENT '실패 사유(서명 오류·템플릿 불일치 등)',
  scheduled_at        DATETIME(3)     NULL                    COMMENT '예약 발송 시각(없으면 즉시)',
  sent_at             DATETIME(3)     NULL                    COMMENT 'SENS가 수락한 시각',
  delivered_at        DATETIME(3)     NULL                    COMMENT '수신 결과 확인 시각',
  created_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_alimtalk_dedupe (dedupe_key) COMMENT '중복 알림 차단(배치 재실행 안전)',
  KEY idx_alimtalk_tenant_created (tenant_id, created_at) COMMENT '법인별 발송 이력 타임라인',
  KEY idx_alimtalk_status_created (status, created_at) COMMENT '재시도 워커: failed/queued 스캔',
  KEY idx_alimtalk_message (message_id) COMMENT '수신 결과 폴링',
  CONSTRAINT fk_alimtalk_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_alimtalk_anomaly FOREIGN KEY (anomaly_id) REFERENCES reconciliation_anomalies (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='SENS 알림톡 발송·도달 이력(멱등 키 포함)';

-- -----------------------------------------------------------------------------
-- 6. audit_logs — 해시체인 감사 로그
-- -----------------------------------------------------------------------------
-- "누가 언제 어떤 금액을 열람/반출했는가"는 B2B 계약 조항이다. 각 행은 직전 행의
-- hash를 prev_hash로 물고 있어, 중간 행을 지우거나 고치면 체인이 끊긴다.
-- (프론트엔드 multiTenantRbac.ts의 AuditTrail과 같은 개념을 서버에서 영속화한 것.
--  서버는 SHA-256을 쓰고, 브라우저 데모는 의존성 없는 FNV-1a를 쓴다.)
--
-- seq는 테넌트별 1,2,3…이며 UNIQUE (tenant_id, seq)로 "번호 건너뛰기"를 막는다.
-- 한 트랜잭션에서 seq를 읽고 쓰면 경합이 생기므로, append는 테넌트 단위
-- SELECT ... FOR UPDATE(마지막 행)로 직렬화한다(AuditLogRepository 참고).
-- -----------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '감사 로그 PK',
  tenant_id     BIGINT UNSIGNED NOT NULL                COMMENT '대상 법인',
  seq           INT UNSIGNED    NOT NULL                COMMENT '테넌트별 체인 순번(1부터)',
  actor_id      VARCHAR(64)     NOT NULL                COMMENT '행위자 식별자(계정 id 또는 API 키 이름)',
  actor_role    VARCHAR(40)     NOT NULL                COMMENT '행위 시점의 역할(MASTER_ADMIN 등). 역할 변경 이력 보존을 위해 문자열',
  action        VARCHAR(40)     NOT NULL                COMMENT 'TENANT_SWITCH, RECONCILE_RUN, VIEW_ANOMALY, EXPORT_CSV …',
  target        VARCHAR(120)    NOT NULL                COMMENT '대상(주문번호·파일명·법인코드)',
  detail        VARCHAR(500)    NOT NULL DEFAULT ''     COMMENT '부가 설명',
  outcome       ENUM('allowed','denied') NOT NULL DEFAULT 'allowed' COMMENT '허용/거부. 거부도 기록해야 시도 흔적이 남는다',
  ip_address    VARBINARY(16)   NULL                    COMMENT 'IPv4/IPv6 바이너리(INET6_ATON). 문자열보다 4배 작다',
  prev_hash     CHAR(64)        NOT NULL                COMMENT '직전 행 hash(체인 시작은 제네시스 상수)',
  hash          CHAR(64)        NOT NULL                COMMENT '이 행의 SHA-256(payload + prev_hash)',
  occurred_at   DATETIME(3)     NOT NULL                COMMENT '사건 발생 시각(서버 수신 시각과 다를 수 있음)',
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_audit_tenant_seq (tenant_id, seq) COMMENT '체인 번호 유일 — 건너뛰기·중복 차단',
  KEY idx_audit_tenant_occurred (tenant_id, occurred_at) COMMENT '기간 조회(감사 대응)',
  KEY idx_audit_tenant_action (tenant_id, action, occurred_at) COMMENT '행위별 필터',
  CONSTRAINT fk_audit_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='해시체인 감사 로그(법인별 순번·변조 탐지)';
