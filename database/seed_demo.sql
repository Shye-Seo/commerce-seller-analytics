-- =============================================================================
-- SellerScope 데모 데이터 (선택)
-- =============================================================================
-- php backend/bin/migrate.php --seed 로 적재한다.
-- 시나리오: 본사 1 + 지사 1 + 위탁사 1, 스토어 5개, 정산서 12행.
-- 그중 4행에 이상이 있도록 설계했다(수수료 초과 / 반품비 중복 / 취소건 수수료 / 역마진).
-- 대사 결과가 아니라 "정산서 원본"만 넣는다. 이상 탐지는 배치가 계산해야 의미가 있다.
-- =============================================================================

USE sellerscope;

INSERT INTO tenants (id, code, name, business_no, tier, parent_id, settlement_cycle, seat_count, status) VALUES
  (1, 'tn-hq',      '본사 스토어 (주식회사 숭구리커머스)', '1234567890', 'HQ',          NULL, '월 1회 · 익월 10일', 14, 'active'),
  (2, 'tn-busan',   '부산 지사 (문현 물류센터)',           '2345678901', 'BRANCH',      1,    '월 2회 · 10일/25일',  6, 'active'),
  (3, 'tn-partner', '위탁사 (협력 셀러 12곳)',             '3456789012', 'CONSIGNMENT', 1,    '월 1회 · 익월 15일', 12, 'active')
AS new
ON DUPLICATE KEY UPDATE name = new.name;

INSERT INTO stores (id, tenant_id, code, name, channel, contract_fee_rate, outbound_shipping, round_trip_return_fee) VALUES
  (1, 1, 'SS-01', '숭구리 공식 스마트스토어', 'smartstore', 3.63, 3000, 5000),
  (2, 1, 'CP-01', '숭구리 쿠팡 그로스',       'coupang',    10.80,    0, 5600),
  (3, 1, 'ES-01', '숭구리 11번가',            'elevenst',    9.00, 3000, 5000),
  (4, 2, 'SS-11', '부산지사 스마트스토어',     'smartstore',  3.63, 3000, 5000),
  (5, 1, 'GM-01', '숭구리 G마켓',              'gmarket',     8.50, 3000, 5000)
AS new
ON DUPLICATE KEY UPDATE name = new.name;

-- 정상 8행 + 이상 4행. settled_amount는 "마켓이 실제로 입금한 금액"이다.
INSERT INTO settlement_orders
  (tenant_id, store_id, batch_id, order_no, channel, order_date, settlement_date, product_name, sku, quantity,
   paid_amount, commission, shipping_deduction, return_fee, settled_amount, order_status,
   unit_cost, seller_shipping_cost, source_file)
VALUES
  -- 정상: 29,900 - 1,085(3.63%) - 3,000 = 25,815
  (1, 1, '00000000-0000-4000-9000-000000000001', '20261001-0000001', 'smartstore', '2026-10-01', '2026-10-10',
   '부산 문현동 자취방 수납함', 'SKU-BOX-01', 1, 29900, 1085, 3000, 0, 25815, 'SHIPPED', 9800, 2600, 'seed_demo.sql'),
  -- 정상: 45,000 - 1,634 - 3,000 = 40,366
  (1, 1, '00000000-0000-4000-9000-000000000001', '20261001-0000002', 'smartstore', '2026-10-02', '2026-10-10',
   '빈티지 디카 스트랩', 'SKU-STR-02', 1, 45000, 1634, 3000, 0, 40366, 'SHIPPED', 12000, 2600, 'seed_demo.sql'),
  -- 이상 1) 수수료 초과: 계약 3.63% = 1,815원인데 3,300원 청구 → 1,485원 과다
  (1, 1, '00000000-0000-4000-9000-000000000001', '20261001-0000003', 'smartstore', '2026-10-03', '2026-10-10',
   '원목 미니 서랍', 'SKU-DRW-03', 2, 50000, 3300, 3000, 0, 43700, 'SHIPPED', 21000, 2600, 'seed_demo.sql'),
  -- 이상 2) 취소 건 수수료: 매출 0이어야 하는데 2,310원 청구
  (1, 1, '00000000-0000-4000-9000-000000000001', '20261001-0000004', 'smartstore', '2026-10-04', '2026-10-10',
   '룸 스프레이 500ml', 'SKU-SPR-04', 1, 21000, 2310, 0, 0, -2310, 'CANCELED', 7000, 0, 'seed_demo.sql'),
  -- 이상 3) 반품비 중복: 계약 왕복 5,000원인데 10,000원 차감
  (1, 1, '00000000-0000-4000-9000-000000000001', '20261001-0000005', 'smartstore', '2026-10-05', '2026-10-10',
   '린넨 커튼 (2장)', 'SKU-CRT-05', 1, 38000, 1379, 3000, 10000, 23621, 'RETURNED', 15000, 5200, 'seed_demo.sql'),
  -- 정상 쿠팡: 32,000 - 3,456(10.8%) - 0 = 28,544
  (1, 2, '00000000-0000-4000-9000-000000000001', 'CP-20261006-0001', 'coupang', '2026-10-06', '2026-10-20',
   '무선 미니 가습기', 'SKU-HUM-06', 1, 32000, 3456, 0, 0, 28544, 'SHIPPED', 14500, 2900, 'seed_demo.sql'),
  -- 이상 4) 역마진: 정산 8,900 - 원가 9,500 - 배송 2,900 = -3,500
  (1, 2, '00000000-0000-4000-9000-000000000001', 'CP-20261007-0002', 'coupang', '2026-10-07', '2026-10-20',
   '실리콘 접이식 물통', 'SKU-BTL-07', 1, 12000, 1296, 1804, 0, 8900, 'SHIPPED', 9500, 2900, 'seed_demo.sql'),
  -- 정상 11번가: 27,000 - 2,430(9%) - 3,000 = 21,570
  (1, 3, '00000000-0000-4000-9000-000000000001', 'ES-20261008-0001', 'elevenst', '2026-10-08', '2026-10-25',
   '캔들 워머', 'SKU-CDL-08', 1, 27000, 2430, 3000, 0, 21570, 'SHIPPED', 11000, 2900, 'seed_demo.sql'),
  -- 정상 지사: 64,000 - 2,323 - 3,000 = 58,677
  (2, 4, '00000000-0000-4000-9000-000000000002', '20261009-0000001', 'smartstore', '2026-10-09', '2026-10-25',
   '이불 압축팩 10매', 'SKU-BAG-09', 1, 64000, 2323, 3000, 0, 58677, 'SHIPPED', 24000, 2600, 'seed_demo.sql'),
  -- 정상 교환: 반품비 정당 발생 → 35,000 - 1,271 - 3,000 - 5,000 = 25,729
  (1, 1, '00000000-0000-4000-9000-000000000001', '20261001-0000010', 'smartstore', '2026-10-10', '2026-10-10',
   '도자기 머그 2P', 'SKU-MUG-10', 1, 35000, 1271, 3000, 5000, 25729, 'EXCHANGED', 12000, 2900, 'seed_demo.sql'),
  -- 정상 반품: 28,000 - 1,016 - 0 - 5,000 = 21,984 (반품은 매출 0, 반품비만)
  (1, 1, '00000000-0000-4000-9000-000000000001', '20261001-0000011', 'smartstore', '2026-10-11', '2026-10-10',
   '패브릭 소파 커버', 'SKU-SOF-11', 1, 28000, 1016, 0, 5000, 21984, 'RETURNED', 16000, 5200, 'seed_demo.sql'),
  -- 원장 누락: unit_cost=0 → MISSING_LEDGER (마진 검증 불가)
  (1, 1, '00000000-0000-4000-9000-000000000001', '20261001-0000012', 'smartstore', '2026-10-12', '2026-10-10',
   '원형 러그 120cm', 'SKU-RUG-12', 1, 39000, 1416, 3000, 0, 34584, 'SHIPPED', 0, 2600, 'seed_demo.sql')
AS new
ON DUPLICATE KEY UPDATE product_name = new.product_name;

-- =============================================================================
-- 2부 · 실시간 선착순 프로모션 데모 데이터
-- =============================================================================
-- 시나리오: 토스형 브랜드 드롭(1번 캠페인, 종료) + 블랙프라이데이 타임딜(2번, 진행 중).
-- 원본은 "응모·발급 사실"만 넣는다. 어뷰징 점수·소진율·정산 판정은 엔진이 계산해야 의미가
-- 있다(1부에서 대사 결과를 넣지 않은 것과 같은 원칙).
-- 응모 로그는 RECURSIVE CTE로 생성한다. 60행을 손으로 쓰는 대신, 결정적(재적재해도 같은 값)
-- 으로 만들기 위해 MD5/SHA2에 순번을 넣는다.
-- =============================================================================

INSERT INTO promotional_campaigns
  (id, tenant_id, code, name, campaign_type, partner_name, reward_budget, token_budget,
   min_guaranteed_margin, margin_guard_mode, expected_peak_tps, starts_at, ends_at, status)
VALUES
  (1, 1, 'toss-drop-2026-11', '[토스형] 무신사 스탠다드 시크릿 드롭', 'TOSS_STYLE_DROP', '무신사 스탠다드',
   9000000, 1000, 12.00, 'block', 3500, '2026-11-20 20:00:00', '2026-11-20 22:00:00', 'ended'),
  (2, 1, 'blackfriday-2026', '블랙프라이데이 셀러 부담 타임딜', 'FLASH_DEAL', NULL,
   15000000, 5000, 8.00, 'warn', 1200, '2026-11-27 00:00:00', '2026-11-30 23:59:59', 'live'),
  (3, 2, 'busan-open-2026', '부산지사 개점 기념 웰컴 쿠폰', 'WELCOME', NULL,
   2000000, 800, 5.00, 'block', 300, '2026-12-01 10:00:00', '2026-12-07 23:59:59', 'scheduled')
AS new
ON DUPLICATE KEY UPDATE name = new.name, status = new.status;

INSERT INTO coupon_templates
  (id, campaign_id, code, name, discount_type, discount_amount, discount_rate,
   min_order_amount, max_discount_amount, per_user_limit, validity_minutes, funded_by, issued_budget, is_active)
VALUES
  (1, 1, 'toss-3000-fixed', '3,000원 즉시 할인',      'FIXED',   3000, 0.00, 30000,     0, 1, 15, 'PARTNER',  3000000, 1),
  (2, 1, 'toss-10-percent', '10% 할인 (최대 5천원)',  'PERCENT',    0, 10.00, 20000,  5000, 1, 15, 'PLATFORM', 4125000, 1),
  (3, 2, 'bf-seller-5000',  '셀러부담 5,000원 쿠폰',  'FIXED',   5000, 0.00, 50000,     0, 1, 30, 'SELLER',   9000000, 1),
  (4, 3, 'busan-welcome-2000', '부산 개점 웰컴 2,000원', 'FIXED', 2000, 0.00, 15000,      0, 1, 60, 'SELLER',   1600000, 1)
AS new
ON DUPLICATE KEY UPDATE name = new.name, is_active = new.is_active;

-- 보존식: remaining + reserved + consumed = total
INSERT INTO coupon_inventories
  (id, campaign_id, coupon_template_id, total_qty, remaining_qty, reserved_qty, consumed_qty, version, last_issued_at)
VALUES
  (1, 1, 1, 1000,  100,  38,  862, 1874, '2026-11-20 20:04:12.318'),
  (2, 1, 2,  500,    0,   0,  500,  988, '2026-11-20 20:02:31.902'),
  (3, 2, 3, 5000, 4210,  90,  700,  812, '2026-11-28 14:22:07.441'),
  (4, 3, 4,  800,  800,   0,    0,    0, NULL)
AS new
ON DUPLICATE KEY UPDATE remaining_qty = new.remaining_qty, reserved_qty = new.reserved_qty,
  consumed_qty = new.consumed_qty, version = new.version, last_issued_at = new.last_issued_at;

-- 응모 60건(캠페인1) — 총 60명이 몰렸고, 그중 52명이 쿠폰을 받았다.
-- 앞 20건은 같은 기기 3대를 나눠 쓴 8명("device-1~3")이라 어뷰징 점수가 높게 잡하는 대상이다.
INSERT INTO event_entries
  (campaign_id, entry_ref, user_hash, phone_hash, device_fingerprint_sha256, client_ip, user_agent_hash,
   utm_source, utm_medium, utm_campaign, is_abusing, abuse_score, risk_reasons, status, idempotency_key, latency_ms, created_at)
WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 60)
SELECT
  1,
  UUID(),
  SHA2(CONCAT('demo-user-', n), 256),
  SHA2(CONCAT('010-1000-', LPAD(n, 4, '0')), 256),
  SHA2(CONCAT('device-', CASE WHEN n <= 20 THEN 1 + (n % 3) ELSE n END), 256),
  INET6_ATON(CONCAT('203.0.113.', 1 + (n % 200))),
  SHA2(CONCAT('ua-', 1 + (n % 5)), 256),
  CASE WHEN n % 3 = 0 THEN 'instagram' WHEN n % 3 = 1 THEN 'youtube' ELSE 'kakao' END,
  CASE WHEN n % 2 = 0 THEN 'cpc' ELSE 'social' END,
  'toss-drop-2026-11',
  CASE WHEN n <= 20 AND n % 4 <> 0 THEN 1 ELSE 0 END,
  CASE WHEN n <= 20 AND n % 4 <> 0 THEN 72 + (n % 20) WHEN n > 55 THEN 18 ELSE 4 END,
  CASE
    WHEN n <= 20 AND n % 4 <> 0 THEN JSON_ARRAY('DEVICE_CLUSTER', 'SUBNET_VELOCITY')
    WHEN n > 55 THEN JSON_ARRAY('UA_ANOMALY')
    ELSE NULL
  END,
  CASE
    WHEN n <= 20 AND n % 4 <> 0 THEN 'REJECTED_ABUSE'
    WHEN n BETWEEN 21 AND 22 THEN 'REJECTED_DUPLICATE'
    WHEN n BETWEEN 23 AND 25 THEN 'REJECTED_STOCK'
    WHEN n BETWEEN 26 AND 28 THEN 'REJECTED_RATE_LIMIT'
    WHEN n BETWEEN 29 AND 30 THEN 'REJECTED_WINDOW'
    ELSE 'ACCEPTED'
  END,
  CONCAT('demo-entry-1-', n),
  8 + (n % 37),
  TIMESTAMPADD(MICROSECOND, n * 750000, TIMESTAMP('2026-11-20 20:00:00'))
FROM seq
ON DUPLICATE KEY UPDATE status = VALUES(status);

-- 발급된 쿠폰 35장(캠페인1, 템플릿1) — ACCEPTED 응모에만 연결된다.
-- 상태 분포: ISSUED 12 / RESERVED 4 / REDEEMED 10 / SETTLED 5 / CANCELLED 3 / EXPIRED 1
INSERT INTO issued_coupons
  (tenant_id, campaign_id, coupon_template_id, entry_id, store_id, user_hash, coupon_code, coupon_hash,
   status, discount_amount, order_amount, order_id, idempotency_key,
   issued_at, reserved_at, redeemed_at, settled_at, expires_at, cancel_reason)
WITH picked AS (
  SELECT e.id AS entry_id, e.user_hash, e.created_at,
         ROW_NUMBER() OVER (ORDER BY e.id) AS rn
    FROM event_entries e
   WHERE e.campaign_id = 1 AND e.status = 'ACCEPTED'
   ORDER BY e.id
   LIMIT 40
), coded AS (
  SELECT entry_id, user_hash, created_at, rn,
         UPPER(SUBSTR(MD5(CONCAT('c1-', entry_id)), 1, 16)) AS code
    FROM picked
)
SELECT
  1, 1, 1, entry_id,
  CASE WHEN rn % 2 = 0 THEN 1 ELSE 2 END,
  user_hash, code, SHA2(code, 256),
  CASE
    WHEN rn <= 12 THEN 'ISSUED'
    WHEN rn <= 16 THEN 'RESERVED'
    WHEN rn <= 25 THEN 'REDEEMED'
    WHEN rn <= 30 THEN 'SETTLED'
    WHEN rn <= 33 THEN 'CANCELLED'
    ELSE 'EXPIRED'
  END,
  3000,
  CASE WHEN rn BETWEEN 13 AND 33 THEN 32000 + rn * 100 ELSE 0 END,
  CASE WHEN rn BETWEEN 13 AND 33 THEN CONCAT('20261120-', LPAD(rn, 7, '0')) ELSE NULL END,
  CONCAT('issue-1-', entry_id),
  created_at,
  CASE WHEN rn BETWEEN 13 AND 33 THEN TIMESTAMPADD(MINUTE, 1, created_at) ELSE NULL END,
  CASE WHEN rn BETWEEN 19 AND 30 THEN TIMESTAMPADD(MINUTE, 3, created_at) ELSE NULL END,
  CASE WHEN rn BETWEEN 26 AND 30 THEN TIMESTAMPADD(MINUTE, 5, created_at) ELSE NULL END,
  TIMESTAMPADD(MINUTE, 15, created_at),
  CASE WHEN rn BETWEEN 31 AND 33 THEN '주문 취소로 인한 정정' ELSE NULL END
FROM coded
ON DUPLICATE KEY UPDATE status = VALUES(status);

-- 쇼핑몰 정산서와의 대사 12건 — 그중 2건은 부담 주체가 어긋나 DISPUTED로 판정된 상태.
INSERT INTO coupon_settlement_reconciliations
  (tenant_id, campaign_id, issued_coupon_id, store_id, settlement_month, mall_settlement_ref,
   mall_discount_amount, seller_borne_amount, platform_borne_amount, partner_borne_amount,
   variance, variance_reason, status, detail, reconciled_at)
WITH target AS (
  SELECT c.id, c.discount_amount, c.store_id, c.redeemed_at,
         ROW_NUMBER() OVER (ORDER BY c.id) AS rn
    FROM issued_coupons c
   WHERE c.campaign_id = 1 AND c.status IN ('REDEEMED', 'SETTLED')
   ORDER BY c.id
   LIMIT 12
)
SELECT
  1, 1, id, COALESCE(store_id, 1), '2026-11', CONCAT('SS-SETTLE-202611-', LPAD(rn, 4, '0')),
  CASE WHEN rn = 4 THEN discount_amount + 1500 WHEN rn = 9 THEN discount_amount - 1000 ELSE discount_amount END,
  CASE WHEN rn IN (4, 9) THEN 0 WHEN rn % 2 = 0 THEN 0 ELSE discount_amount END,
  CASE WHEN rn IN (4, 9) THEN 0 WHEN rn % 2 = 0 THEN discount_amount ELSE 0 END,
  0,
  CASE WHEN rn = 4 THEN 1500 WHEN rn = 9 THEN -1000 ELSE 0 END,
  CASE WHEN rn = 4 THEN 'SELLER_OVERBORNE' WHEN rn = 9 THEN 'AMOUNT_MISMATCH' ELSE 'MATCHED' END,
  CASE WHEN rn IN (4, 9) THEN 'DISPUTED' ELSE 'MATCHED' END,
  CASE WHEN rn = 4 THEN '제휴사 부담 쿠폰인데 쇼핑몰이 셀러 부담으로 1,500원 더 차감했습니다.'
       WHEN rn = 9 THEN '쇼핑몰 차감액이 쿠폰 원장보다 1,000원 적습니다(부분 차감).'
       ELSE '부담 주체 3분할 합계가 쇼핑몰 차감액과 일치합니다.' END,
  TIMESTAMP('2026-12-11 09:30:00')
FROM target
ON DUPLICATE KEY UPDATE status = VALUES(status);
