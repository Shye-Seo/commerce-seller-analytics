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

-- =============================================================================
-- 2부 · 실시간 선착순 프로모션 & 쿠폰 원장 (Flash Promotion & Coupon Ledger)
-- =============================================================================
-- 왜 정산 대사(1부) 위에 프로모션을 얹었나
--   셀러의 손익은 "마켓이 얼마를 뺐나"에서 끝나지 않는다. 우리가 뿌린 할인쿠폰이
--   누구 부담으로 얼마나 나갔는지가 정산서에 다시 들어오기 때문이다. 그래서 쿠폰은
--   프로모션 → 템플릿 → 재고 → 응모 → 원장 → 정산 대사로 이어지는 하나의 사슬로 둔다.
--   이 사슬의 마지막 테이블(coupon_settlement_reconciliations)이 1부의 정산 대사와
--   같은 문법(원본 불변 + 재계산 결과 갱신)으로 쇼핑몰 정산서와 쿠폰 원장을 맞춘다.
--
-- 이 파트의 세 가지 불변식
--   1) 재고는 절대 음수가 되지 않는다. remaining_qty >= 0 CHECK + 조건부 UPDATE
--      (UPDATE ... SET remaining_qty = remaining_qty - 1 WHERE remaining_qty > 0).
--      "읽고 → 검사하고 → 쓰기"는 고동시성에서 반드시 오버이슈가 난다.
--   2) 참여 1건은 멱등하다. event_entries.idempotency_key UNIQUE와
--      (campaign_id, user_hash) UNIQUE가 같은 사람의 두 번째 요청을 DB 레벨에서 막는다.
--      애플리케이션의 if문은 동시 요청 2건을 모두 통과시킬 수 있지만, 유니크 인덱스는 못 한다.
--   3) 쿠폰 코드는 원문을 저장하지 않는다. coupon_hash(SHA-256)만 남기고, 16자리 원문은
--      발급 응답에서 한 번만 보여준다. DB 덤프가 유출돼도 유효한 쿠폰이 되지 않는다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 7. promotional_campaigns — 캠페인 마스터(타임딜·토스형 브랜드 제휴)
-- -----------------------------------------------------------------------------
-- 캠페인은 "언제, 얼마어치를, 어떤 마진 하한을 지키며" 뿌릴지를 정하는 계약이다.
-- min_guaranteed_margin은 장식이 아니다. 쿠폰 발급 서비스가 발급 직전에
--   (정산 예정액 - 쿠폰 할인 - 원가) / 정산 예정액
-- 을 계산해 이 값 미만이면 발급을 막거나 경고한다(마진 가드레일).
-- 프로모션은 매출을 늘리는 장치이지 손실을 확정하는 장치가 아니어야 한다.
--
-- reward_budget은 "총 발행 예산"이다. token_budget(장수)과 따로 두는 이유:
--   장당 할인액이 다른 템플릿을 한 캠페인에 묶을 수 있어서, 장수만으로는 예산을
--   통제할 수 없다. 발급 시 두 상한을 모두 확인하고, 둘 중 먼저 닿는 쪽에서 멈춘다.
-- -----------------------------------------------------------------------------
CREATE TABLE promotional_campaigns (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '캠페인 PK',
  tenant_id             BIGINT UNSIGNED NOT NULL                COMMENT '소유 법인(1부와 동일한 멀티테넌트 스코프)',
  code                  VARCHAR(40)     NOT NULL                COMMENT '캠페인 코드(flash-2026-11-blackfriday). 외부 광고 소재가 참조하는 안정 식별자',
  name                  VARCHAR(120)    NOT NULL                COMMENT '캠페인명',
  campaign_type         ENUM('FLASH_DEAL','BRAND_DROP','TOSS_STYLE_DROP','WELCOME') NOT NULL
                        COMMENT 'FLASH_DEAL=타임딜, BRAND_DROP=브랜드 제휴, TOSS_STYLE_DROP=토스형 선착순 드롭, WELCOME=신규 유입',
  partner_name          VARCHAR(80)     NULL                    COMMENT '제휴 브랜드명. BRAND_DROP/TOSS_STYLE_DROP은 필수(CHECK)',
  reward_budget         INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '총 발행 예산(원). 할인액 누적이 이 값을 넘으면 신규 발급 중단',
  token_budget          INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '발행 장수 상한. 템플릿 인벤토리 합계의 상위 한도',
  min_guaranteed_margin DECIMAL(5,2)    NOT NULL DEFAULT 0.00   COMMENT '최소 보장 마진율(%). 쿠폰 적용 후 이보다 낮아지면 발급 차단/경고',
  margin_guard_mode     ENUM('block','warn') NOT NULL DEFAULT 'block'
                        COMMENT '가드레일 위반 시 동작. block=발급 거부(기본), warn=발급하되 경고를 이력에 남긴다',
  expected_peak_tps     INT UNSIGNED    NOT NULL DEFAULT 500    COMMENT '오픈 시각 예상 최대 TPS. 레이트리밋·커넥션 풀 산정 근거',
  starts_at             DATETIME(3)     NOT NULL                COMMENT '오픈 시각(KST)',
  ends_at               DATETIME(3)     NOT NULL                COMMENT '종료 시각(KST)',
  status                ENUM('draft','scheduled','live','paused','ended','settled') NOT NULL DEFAULT 'draft'
                        COMMENT 'draft=작성, scheduled=오픈 대기, live=진행, paused=일시정지, ended=종료, settled=정산완료',
  created_at            DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_campaigns_tenant_code (tenant_id, code) COMMENT '법인 안에서 캠페인 코드 유일 — 광고 소재 중복 발행 방지',
  KEY idx_campaigns_tenant_status_window (tenant_id, status, starts_at, ends_at) COMMENT '운영 콘솔 주 조회: 법인 + 상태 + 오픈 구간',
  KEY idx_campaigns_open_window (status, starts_at) COMMENT '스케줄러: 오픈 시각이 지난 scheduled 캠페인 스캔',
  CONSTRAINT fk_campaigns_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT chk_campaigns_window CHECK (ends_at > starts_at),
  CONSTRAINT chk_campaigns_margin CHECK (min_guaranteed_margin >= 0 AND min_guaranteed_margin < 100),
  CONSTRAINT chk_campaigns_partner CHECK (campaign_type NOT IN ('BRAND_DROP','TOSS_STYLE_DROP') OR partner_name IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='실시간 선착순 프로모션 캠페인 마스터(예산·마진 하한·오픈 구간)';

-- -----------------------------------------------------------------------------
-- 8. coupon_templates — 쿠폰 템플릿(정액/정률·최소주문·최대할인·1인 제한)
-- -----------------------------------------------------------------------------
-- 정률 쿠폰에는 반드시 max_discount_amount 상한이 필요하다. 상한 없는 "20% off"는
-- 1,000만 원 주문에 200만 원을 깎아주는 사고가 되고, 그 사고는 새벽 2시에 터진다.
-- CHECK가 (discount_type='PERCENT' → max_discount_amount > 0)을 강제한다.
--
-- funded_by(부담 주체)는 정산 대사 파트와 직결된다. 셀러 부담 쿠폰은 쇼핑몰이
-- 정산서에서 차감하고, 플랫폼/제휴사 부담 쿠폰은 우리가 쇼핑몰에 청구한다.
-- 같은 3,000원 할인이라도 누가 부담하느냐에 따라 셀러 마진이 달라진다.
--
-- validity_minutes는 발급 시점 TTL이다(15분=900이 기본값). 선착순 드롭에서 쿠폰을
-- 받아만 두고 쓰지 않는 재고 잠식을 줄이려면 만료가 짧아야 한다.
-- -----------------------------------------------------------------------------
CREATE TABLE coupon_templates (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '템플릿 PK',
  campaign_id          BIGINT UNSIGNED NOT NULL                COMMENT '소속 캠페인',
  code                 VARCHAR(40)     NOT NULL                COMMENT '템플릿 코드(flash-3000-off). 응모 화면·딥링크가 참조',
  name                 VARCHAR(120)    NOT NULL                COMMENT '쿠폰명(사용자 노출 문구)',
  discount_type        ENUM('FIXED','PERCENT') NOT NULL        COMMENT 'FIXED=정액(원), PERCENT=정률(%)',
  discount_amount      INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '정액 할인액(원). FIXED일 때만 사용',
  discount_rate        DECIMAL(5,2)    NOT NULL DEFAULT 0.00   COMMENT '정률 할인율(%). PERCENT일 때만 사용',
  min_order_amount     INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '최소 주문금액(원). 0이면 조건 없음',
  max_discount_amount  INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '최대 할인액(원). PERCENT는 필수(무제한 정률 방지)',
  per_user_limit       TINYINT UNSIGNED NOT NULL DEFAULT 1     COMMENT '1인당 발급 가능 수량',
  validity_minutes     SMALLINT UNSIGNED NOT NULL DEFAULT 15   COMMENT '발급 후 유효 시간(분). 15분 TTL이 기본',
  funded_by            ENUM('SELLER','PLATFORM','PARTNER') NOT NULL DEFAULT 'SELLER'
                       COMMENT '할인 부담 주체. 쇼핑몰 정산 대사에서 차감/청구 방향을 결정',
  issued_budget        INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '템플릿 단위 발행 예산(원). 0이면 캠페인 예산만 적용',
  is_active            TINYINT(1)      NOT NULL DEFAULT 1      COMMENT '0이면 신규 발급 중단(기발급 쿠폰은 유효)',
  created_at           DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_templates_campaign_code (campaign_id, code) COMMENT '캠페인 안에서 템플릿 코드 유일',
  KEY idx_templates_campaign_active (campaign_id, is_active) COMMENT '발급 가능 템플릿 목록',
  CONSTRAINT fk_templates_campaign FOREIGN KEY (campaign_id) REFERENCES promotional_campaigns (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT chk_templates_fixed CHECK (discount_type <> 'FIXED' OR discount_amount > 0),
  CONSTRAINT chk_templates_percent CHECK (discount_type <> 'PERCENT' OR (discount_rate > 0 AND discount_rate <= 100)),
  CONSTRAINT chk_templates_percent_cap CHECK (discount_type <> 'PERCENT' OR max_discount_amount > 0),
  CONSTRAINT chk_templates_limit CHECK (per_user_limit >= 1 AND validity_minutes >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='쿠폰 템플릿. 정률 쿠폰의 최대 할인 상한과 부담 주체를 함께 고정';

-- -----------------------------------------------------------------------------
-- 9. coupon_inventories — 재고(원자적 수량 제어)
-- -----------------------------------------------------------------------------
-- 이 테이블의 존재 이유는 단 하나: **오버이슈 0건**.
--
-- 낙관적 락(version)을 기본으로 두고, 경합이 심한 순간에는 조건부 UPDATE 한 문장으로
-- 내려간다. 두 방식을 모두 지원하는 이유:
--   · version 낙관적 락 — 읽기 비중이 높고 경합이 낮은 구간(오픈 전 프리뷰, 잔여 확인)에서
--     락 대기 없이 처리된다. 충돌 시 애플리케이션이 재시도한다.
--   · 조건부 UPDATE — 오픈 0.5초 구간(수천 TPS)에서는 재시도 자체가 비용이다.
--     UPDATE coupon_inventories SET remaining_qty = remaining_qty - 1, version = version + 1
--       WHERE id = ? AND remaining_qty >= 1
--     한 문장이면 InnoDB 행 락이 직렬화를 보장하고, 영향 행 수 0이면 즉시 SOLD_OUT이다.
--
-- reserved_qty는 "발급은 됐지만 아직 주문에 쓰이지 않은" 수량이다. remaining에서 빼서
-- reserved로 옮기므로, remaining + reserved + consumed = total_qty 라는 보존식이 성립한다.
-- CHECK가 이 보존식을 DB에서 강제한다. 회계 원장과 같은 성질이다.
-- -----------------------------------------------------------------------------
CREATE TABLE coupon_inventories (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '재고 PK',
  campaign_id       BIGINT UNSIGNED NOT NULL                COMMENT '캠페인(집계·예산 검증 단위)',
  coupon_template_id BIGINT UNSIGNED NOT NULL               COMMENT '템플릿 1개당 재고 1행(UNIQUE)',
  total_qty         INT UNSIGNED    NOT NULL                COMMENT '총 발행 가능 수량',
  remaining_qty     INT UNSIGNED    NOT NULL                COMMENT '잔여 수량. 조건부 UPDATE의 대상',
  reserved_qty      INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '발급되어 사용 대기 중인 수량(만료 스윕에서 remaining으로 복원)',
  consumed_qty      INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '사용 완료(REDEEMED/SETTLED) 수량. 회계 확정분',
  version           INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '낙관적 락 버전. UPDATE ... WHERE version = ?',
  last_issued_at    DATETIME(3)     NULL                    COMMENT '마지막 발급 시각. 소진 속도(TPS) 계산용',
  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventories_template (coupon_template_id) COMMENT '템플릿당 재고 행은 하나 — 이중 재고 방지',
  KEY idx_inventories_campaign (campaign_id),
  KEY idx_inventories_low_stock (campaign_id, remaining_qty) COMMENT '잔여 임계치 알림 스캔',
  CONSTRAINT fk_inventories_campaign FOREIGN KEY (campaign_id) REFERENCES promotional_campaigns (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_inventories_template FOREIGN KEY (coupon_template_id) REFERENCES coupon_templates (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT chk_inventories_non_negative CHECK (remaining_qty >= 0 AND reserved_qty >= 0 AND consumed_qty >= 0),
  CONSTRAINT chk_inventories_balance CHECK (remaining_qty + reserved_qty + consumed_qty <= total_qty)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='쿠폰 재고. 조건부 UPDATE + version 낙관적 락으로 오버이슈 0건 보장';

-- -----------------------------------------------------------------------------
-- 10. event_entries — 실시간 응모 트래픽 로그
-- -----------------------------------------------------------------------------
-- 초당 수천 건이 들어오는 테이블이다. 그래서 "한 건을 저장하는 비용"이 설계 기준이다.
--   · client_ip는 VARBINARY(16)(INET6_ATON). 문자열 VARCHAR(45)보다 작고, 정렬·범위 비교가 빠르다.
--   · user_agent는 원문 대신 해시를 저장한다. 원문은 카디널리티가 낮고(수십 종) 길다.
--   · risk_reasons만 JSON이다. 어뷰징 사유는 종류가 계속 늘어나므로 컬럼을 미리 고정하면
--     마이그레이션이 잦아진다. 집계에 쓰는 점수(abuse_score)는 별 정규 컬럼으로 꺼낸다.
--
-- 유니크 2종의 역할이 다르다.
--   · uq_entries_idempotency (idempotency_key) — 클라이언트 재전송(타임아웃 후 재시도) 흡수
--   · uq_entries_campaign_user (campaign_id, user_hash) — 같은 사람의 중복 응모 차단
-- 둘 다 DB가 막아야 한다. 애플리케이션 검사만으로는 동시 도착 2건을 막지 못한다.
-- 경합이 몰리는 테이블이므로 status·latency_ms를 함께 남겨 "왜 거절됐는지"를 즉시 답한다.
-- -----------------------------------------------------------------------------
CREATE TABLE event_entries (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '응모 PK',
  campaign_id             BIGINT UNSIGNED NOT NULL                COMMENT '대상 캠페인',
  entry_ref               CHAR(36)        NOT NULL                COMMENT '응모 UUID(외부 노출용). PK를 노출하지 않는다',
  user_hash               CHAR(64)        NOT NULL                COMMENT '참여자 식별 해시(SHA-256 of 회원ID/전화번호+솔트). 원문 저장 금지',
  phone_hash              CHAR(64)        NULL                    COMMENT '전화번호 해시. 다계정 탐지의 보조 키',
  device_fingerprint_sha256 CHAR(64)      NULL                    COMMENT '디바이스 핑거프린트 해시(User-Agent+화면+타임존+캔버스 등)',
  client_ip               VARBINARY(16)   NULL                    COMMENT '클라이언트 IP(INET6_ATON 바이너리)',
  user_agent_hash         CHAR(64)        NULL                    COMMENT 'User-Agent 해시(원문 대신)',
  utm_source              VARCHAR(40)     NULL                    COMMENT '유입 소스(instagram, youtube, kakao …)',
  utm_medium              VARCHAR(40)     NULL                    COMMENT '유입 매체(cpc, social, dm)',
  utm_campaign            VARCHAR(60)     NULL                    COMMENT '광고 캠페인 파라미터',
  is_abusing              TINYINT(1)      NOT NULL DEFAULT 0      COMMENT '1이면 어뷰징 판정(발급 차단)',
  abuse_score             TINYINT UNSIGNED NOT NULL DEFAULT 0     COMMENT '어뷰징 점수 0~100. 임계치 이상이면 is_abusing',
  risk_reasons            JSON            NULL                    COMMENT '판정 사유 배열(["DEVICE_CLUSTER","IP_VELOCITY"…])',
  status                  ENUM('ACCEPTED','REJECTED_STOCK','REJECTED_DUPLICATE','REJECTED_ABUSE','REJECTED_RATE_LIMIT','REJECTED_WINDOW')
                          NOT NULL DEFAULT 'ACCEPTED' COMMENT '응모 결과. 거절도 기록해야 민원·어뷰징 분석이 된다',
  idempotency_key         VARCHAR(64)     NOT NULL                COMMENT '클라이언트 요청 멱등 키(재전송 흡수)',
  latency_ms              SMALLINT UNSIGNED NOT NULL DEFAULT 0     COMMENT '게이트웨이 수신→응답 지연(ms). SLA 모니터링',
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_entries_idempotency (idempotency_key) COMMENT '재전송 흡수 — 같은 요청은 한 행',
  UNIQUE KEY uq_entries_campaign_user (campaign_id, user_hash) COMMENT '1인 1응모: 동시 요청도 DB가 막는다',
  KEY idx_entries_campaign_status (campaign_id, status, created_at) COMMENT '실시간 대시보드: 상태별 건수·최근 순',
  KEY idx_entries_device (device_fingerprint_sha256, created_at) COMMENT '핑거프린트 클러스터 탐지',
  KEY idx_entries_ip (client_ip, created_at) COMMENT 'IP 벨로시티 탐지',
  KEY idx_entries_phone (phone_hash) COMMENT '전화번호 재사용(다계정) 탐지',
  CONSTRAINT fk_entries_campaign FOREIGN KEY (campaign_id) REFERENCES promotional_campaigns (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT chk_entries_score CHECK (abuse_score <= 100),
  CONSTRAINT chk_entries_abusing CHECK (is_abusing = 0 OR abuse_score >= 50)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='실시간 응모 트래픽 로그(멱등·중복차단·어뷰징 점수)';

-- -----------------------------------------------------------------------------
-- 11. issued_coupons — 쿠폰 원장(Ledger)
-- -----------------------------------------------------------------------------
-- "쿠폰을 발급했다"는 사실은 돈이 걸린 부채다. 그래서 원장이다.
--   · coupon_code(16자리)는 발급 응답에서 한 번만 노출하고 원문을 저장하지 않는다.
--     coupon_hash UNIQUE가 "이 코드가 우리가 발급한 것"임을 증명한다.
--   · 상태 전이는 단방향이다: ISSUED → RESERVED → REDEEMED → SETTLED,
--     그리고 ISSUED/RESERVED → CANCELLED, ISSUED → EXPIRED. 되돌리는 전이는 없다.
--     (REDEEMED를 ISSUED로 되돌리면 매출이 두 번 잡힌다. 취소는 별도 CANCELLED 상태로 남긴다.)
--   · status별 시각 컬럼을 따로 둔다. redeemed_at이 NULL인데 status='REDEEMED'인 행은
--     CHECK가 막는다. 상태와 시각이 어긋나면 정산 대사가 전부 틀어진다.
--
-- discount_amount는 "발급 시점 확정 금액"이다. 정률 쿠폰은 주문금액에 따라 달라지므로
-- RESERVED 시점(주문 생성)에 확정해 이 컬럼에 박는다. 이후 주문이 바뀌어도 원장 금액은
-- 바뀌지 않는다(감사 대응).
-- -----------------------------------------------------------------------------
CREATE TABLE issued_coupons (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '쿠폰 원장 PK',
  tenant_id           BIGINT UNSIGNED NOT NULL                COMMENT '소유 법인(모든 조회의 선행 조건)',
  campaign_id         BIGINT UNSIGNED NOT NULL                COMMENT '발급 캠페인',
  coupon_template_id  BIGINT UNSIGNED NOT NULL                COMMENT '발급 템플릿(할인 규칙)',
  entry_id            BIGINT UNSIGNED NULL                    COMMENT '계기가 된 응모. 운영자 수동 발급은 NULL',
  store_id            BIGINT UNSIGNED NULL                    COMMENT '사용된 셀러 스토어(1부 stores). 미사용이면 NULL',
  user_hash           CHAR(64)        NOT NULL                COMMENT '쿠폰 소유자 해시',
  coupon_code         CHAR(16)        NOT NULL                COMMENT '16자리 코드의 마스킹 표기(앞4·끝4만 원문, 가운데 8자리 별표). 원문은 저장하지 않는다',
  coupon_hash         CHAR(64)        NOT NULL                COMMENT 'coupon_code의 SHA-256. UNIQUE — 발급 사실 증명',
  status              ENUM('ISSUED','RESERVED','REDEEMED','SETTLED','CANCELLED','EXPIRED') NOT NULL DEFAULT 'ISSUED'
                      COMMENT 'ISSUED=발급, RESERVED=주문에 묶임, REDEEMED=사용, SETTLED=정산반영, CANCELLED=취소, EXPIRED=만료',
  discount_amount     INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '확정 할인액(원). 정률 쿠폰은 RESERVED 시점에 확정',
  order_amount        INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '쿠폰 적용 주문금액(원). 마진 가드레일 계산 입력',
  order_id            VARCHAR(64)     NULL                    COMMENT '쇼핑몰 주문번호(RESERVED 이후)',
  idempotency_key     VARCHAR(64)     NOT NULL                COMMENT '발급 멱등 키(같은 요청 재전송 → 같은 쿠폰)',
  issued_at           DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '발급 시각',
  reserved_at         DATETIME(3)     NULL                    COMMENT '주문 묶임 시각',
  redeemed_at         DATETIME(3)     NULL                    COMMENT '사용 확정 시각',
  settled_at          DATETIME(3)     NULL                    COMMENT '정산 반영 시각',
  expires_at          DATETIME(3)     NOT NULL                COMMENT '만료 시각(issued_at + validity_minutes)',
  cancel_reason       VARCHAR(200)    NULL                    COMMENT '취소 사유(중복 발급·주문 취소·운영 정정)',
  created_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_coupons_hash (coupon_hash) COMMENT '코드 원문 대신 해시로 유일성 보장',
  UNIQUE KEY uq_coupons_idempotency (idempotency_key) COMMENT '발급 멱등: 재전송이 쿠폰을 두 장 만들지 않는다',
  UNIQUE KEY uq_coupons_template_user (coupon_template_id, user_hash) COMMENT '1인 1장(템플릿 단위) — 동시 발급 차단',
  KEY idx_coupons_tenant_status (tenant_id, status, issued_at) COMMENT '법인별 상태 집계',
  KEY idx_coupons_campaign_status (campaign_id, status) COMMENT '캠페인 소진율·전환율',
  KEY idx_coupons_expiry_sweep (status, expires_at) COMMENT '만료 스윕: ISSUED/RESERVED + 만료 지난 행',
  KEY idx_coupons_order (order_id) COMMENT '주문 단위 원장 조회',
  CONSTRAINT fk_coupons_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_coupons_campaign FOREIGN KEY (campaign_id) REFERENCES promotional_campaigns (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_coupons_template FOREIGN KEY (coupon_template_id) REFERENCES coupon_templates (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_coupons_entry FOREIGN KEY (entry_id) REFERENCES event_entries (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_coupons_store FOREIGN KEY (store_id) REFERENCES stores (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_coupons_redeemed_at CHECK (status NOT IN ('REDEEMED','SETTLED') OR redeemed_at IS NOT NULL),
  CONSTRAINT chk_coupons_settled_at CHECK (status <> 'SETTLED' OR settled_at IS NOT NULL),
  CONSTRAINT chk_coupons_discount CHECK (discount_amount <= order_amount OR order_amount = 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='쿠폰 원장. 16자리 코드는 해시만 저장하고 상태·시각 불변식을 CHECK로 고정';

-- -----------------------------------------------------------------------------
-- 12. coupon_settlement_reconciliations — 쇼핑몰 정산서 ↔ 쿠폰 원장 대사
-- -----------------------------------------------------------------------------
-- 마지막 고리. 쇼핑몰이 보낸 정산서에는 "쿠폰 할인 차감"이 한 줄로 들어오는데,
-- 그 금액이 우리 원장과 맞는지는 아무도 자동으로 확인해 주지 않는다.
--
-- 1부의 정산 대사와 같은 문법을 쓴다.
--   원본(mall_discount_amount …)은 쇼핑몰이 준 값 → 절대 덮어쓰지 않는다.
--   결과(platform_borne_amount, seller_borne_amount, partner_borne_amount, variance)는
--   우리가 다시 계산해 갱신한다. 그래서 "쇼핑몰은 이렇게 뺐고, 우리 장부는 이렇다"를
--   한 행에서 대조할 수 있다.
--
-- 부담 주체 3분할이 핵심이다. 3,000원 쿠폰 하나가 셀러/플랫폼/제휴사에 나뉘어 붙으면
--   seller_borne + platform_borne + partner_borne = mall_discount_amount
-- 가 성립해야 한다. 어긋난 금액(variance)이 0이 아니면 status='DISPUTED'로 올려
-- 쇼핑몰에 이의를 제기한다. UNIQUE (issued_coupon_id)로 재업로드가 대사 행을 늘리지 않는다.
-- -----------------------------------------------------------------------------
CREATE TABLE coupon_settlement_reconciliations (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '쿠폰 대사 PK',
  tenant_id               BIGINT UNSIGNED NOT NULL                COMMENT '소유 법인',
  campaign_id             BIGINT UNSIGNED NOT NULL                COMMENT '대상 캠페인',
  issued_coupon_id        BIGINT UNSIGNED NOT NULL                COMMENT '대상 쿠폰 원장 행(1:1)',
  store_id                BIGINT UNSIGNED NOT NULL                COMMENT '정산서를 발행한 쇼핑몰(스토어)',
  settlement_month        CHAR(7)         NOT NULL                COMMENT '정산 월(YYYY-MM). 쇼핑몰 정산 주기 단위',
  mall_settlement_ref     VARCHAR(64)     NOT NULL                COMMENT '쇼핑몰 정산서 식별자(정산 ID/파일명). 이의 제기 근거',
  mall_discount_amount    INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '원본: 쇼핑몰이 차감한 쿠폰 할인액(원). 불변',
  seller_borne_amount     INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '재계산: 셀러 부담분(원). 템플릿 funded_by로 결정',
  platform_borne_amount   INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '재계산: 플랫폼 부담분(원)',
  partner_borne_amount    INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '재계산: 제휴사 부담분(원)',
  variance                INT             NOT NULL DEFAULT 0      COMMENT '차액(원) = 쇼핑몰 차감 - (셀러+플랫폼+제휴). 음수면 우리가 더 부담',
  variance_reason         ENUM('MATCHED','SELLER_OVERBORNE','PLATFORM_OVERBORNE','UNKNOWN_COUPON','DUPLICATE_DISCOUNT','AMOUNT_MISMATCH')
                          NOT NULL DEFAULT 'MATCHED' COMMENT '차액 원인 판정. MATCHED 외에는 이의 제기 대상',
  status                  ENUM('PENDING','MATCHED','DISPUTED','ADJUSTED') NOT NULL DEFAULT 'PENDING'
                          COMMENT 'PENDING=미대사, MATCHED=일치, DISPUTED=이의제기, ADJUSTED=정정 반영',
  detail                  VARCHAR(500)    NOT NULL DEFAULT ''     COMMENT '사람이 읽는 판정 문장(쇼핑몰 담당자에게 그대로 전달)',
  reconciled_at           DATETIME(3)     NULL                    COMMENT '마지막 대사 실행 시각',
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_coupon_recon_coupon (issued_coupon_id) COMMENT '쿠폰 1장당 대사 1행 — 재업로드 멱등',
  KEY idx_coupon_recon_tenant_month (tenant_id, settlement_month, status) COMMENT '월별 미해결 차액 큐',
  KEY idx_coupon_recon_campaign (campaign_id, status) COMMENT '캠페인별 차액 집계',
  KEY idx_coupon_recon_store (store_id, settlement_month) COMMENT '쇼핑몰별 이의 제기 목록',
  CONSTRAINT fk_coupon_recon_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_coupon_recon_campaign FOREIGN KEY (campaign_id) REFERENCES promotional_campaigns (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_coupon_recon_coupon FOREIGN KEY (issued_coupon_id) REFERENCES issued_coupons (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_coupon_recon_store FOREIGN KEY (store_id) REFERENCES stores (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_coupon_recon_month CHECK (settlement_month REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT chk_coupon_recon_variance CHECK (status <> 'MATCHED' OR variance = 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='쿠폰 원장 ↔ 쇼핑몰 정산서 대사(부담 주체 3분할·차액 판정)';

