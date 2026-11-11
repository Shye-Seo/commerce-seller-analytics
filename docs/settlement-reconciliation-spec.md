# 정산 대사 · 이상 탐지 기능 명세서

> `commerce-seller-analytics` / 구현: `src/lib/reconciliationEngine.ts`, `src/lib/csvStreamParser.ts`, `src/lib/multiTenantRbac.ts`
> 이 문서는 **구현과 1:1로 맞는 계약**입니다. 코드를 바꾸면 이 문서도 같이 바뀌어야 합니다.

---

## 1. 범위

| ID | 기능 | 입력 | 출력 |
| --- | --- | --- | --- |
| F-01 | 정산서 파싱 | CSV 파일(UTF-8, 한글/영문 헤더) | `SettlementRow[]` + 격리된 오류 |
| F-02 | 계약 기반 재계산 | `SettlementRow` + `ContractTerms` | 기대 수수료·배송비·반품비·정산액 |
| F-03 | 이상 탐지 | 기대값 vs 정산서 실제값 | `RowAnomaly[]` (11종) |
| F-04 | 손실 귀속 | 부족분 + 원인 후보 | 원인별 귀속 금액 (합 ≤ 부족분) |
| F-05 | 집계 | `ReconciledRow[]` | 총 정산액·정상 대사율·누수·노출액·채널 분해 |
| F-06 | 대량 렌더 | `ReconciledRow[]` | 뷰포트 구간 행만 DOM |
| F-07 | 권한·마스킹 | 역할·테넌트·동작 | 허용/거부 + 마스킹된 표기 |
| F-08 | 감사 로그 | 이벤트 | 해시체인 + 무결성 검증 |
| F-09 | 반출 | 권한 확인 후 | CSV 다운로드 / 거부 사유 |

범위 밖(이번 단계 제외): 마켓 API 직접 연동, 서버 영속화, 다중 사용자 실시간 협업, 이메일 알림.

---

## 2. 데이터 계약

### 2.1 `SettlementRow` (정산서 1행)

| 필드 | 타입 | 필수 | 단위 | 규칙 |
| --- | --- | --- | --- | --- |
| `orderNo` | string | ✔ | — | 채널 내 유일. `channel:orderNo` 조합으로 중복 제거 |
| `channel` | enum | ✔ | — | `smartstore` \| `coupang` \| `elevenst` \| `gmarket` |
| `orderDate` | string | △ | YYYY-MM-DD | 없으면 `1970-01-01` |
| `productName` | string | △ | — | 없으면 `상품명 미상` |
| `sku` | string | △ | — | 없으면 `UNKNOWN-{orderNo}` |
| `quantity` | number | △ | 개 | 최소 1로 보정 |
| `paidAmount` | number | ✔ | 원 | 음수 불가 |
| `commission` | number | △ | 원 | 0 허용 |
| `shippingDeduction` | number | △ | 원 | 0 허용 |
| `returnFee` | number | △ | 원 | 0 허용 |
| `settledAmount` | number | ✔ | 원 | **음수 허용**(차감 정산) |
| `contractFeeRate` | number | △ | % | 없으면 실효 수수료율로 대체 |
| `unitCost` | number | △ | 원 | 0이면 `MISSING_LEDGER` |
| `sellerShippingCost` | number | △ | 원 | 0 허용 |
| `status` | enum | △ | — | `배송완료` \| `반품완료` \| `취소` \| `교환완료` (기본 `배송완료`) |

### 2.2 헤더 별칭 (일부)

| 필드 | 인식하는 헤더 |
| --- | --- |
| `orderNo` | 주문번호, 주문아이디, orderId, orderNo, 주문id |
| `channel` | 채널, 마켓, 판매채널, channel, market, 플랫폼 |
| `paidAmount` | 결제금액, 판매금액, 결제액, paidAmount, gross |
| `commission` | 마켓수수료, 판매수수료, 수수료, commission, fee |
| `settledAmount` | 실정산액, 정산액, 정산금액, 입금액, settledAmount, settlement |
| `contractFeeRate` | 계약수수료율, 수수료율, feeRate, contractFeeRate |

필수 열: `orderNo`, `channel`, `paidAmount`, `settledAmount`. 누락 시 `SettlementCsvSchemaError`(파일 전체 거부).

### 2.3 계약 프리셋 (`ContractTerms`)

| 채널 | 수수료율 | 기본 배송비 | 반품 왕복 배송비 |
| --- | --- | --- | --- |
| smartstore | 3.63% | 3,000원 | 5,000원 |
| coupang | 10.8% | 0원 | 5,600원 |
| elevenst | 9.0% | 3,000원 | 5,000원 |
| gmarket | 8.5% | 3,000원 | 5,000원 |

`reconcileSettlement(rows, { contracts })`로 계약 DB 값으로 교체 가능.

---

## 3. 계산 정의

```text
revenue            = (status ∈ {취소, 반품완료}) ? 0 : paidAmount
expectedCommission = round(revenue × contract.feeRate / 100)
expectedShipping   = revenue > 0 ? contract.outboundShipping : 0
expectedReturnFee  = (status ∈ {반품완료, 교환완료}) ? contract.roundTripReturnFee : 0
expectedSettlement = revenue − expectedCommission − expectedShipping − expectedReturnFee

variance  = settledAmount − expectedSettlement
shortfall = max(0, −variance)
surplus   = max(0,  variance)

effectiveFeeRate = commission / paidAmount × 100
netMargin        = settledAmount − (unitCost × quantity) − sellerShippingCost
marginRate       = netMargin / paidAmount × 100
```

모든 금액은 **원 단위 정수**(`roundWon`)로 반올림하며 `-0`을 만들지 않는다.

---

## 4. 탐지 규칙

| 코드 | 판정 조건 | 귀속 손실 | 심각도 |
| --- | --- | --- | --- |
| `FEE_OVERCHARGE` | `commission − expectedCommission > max(100, expectedCommission × 1%)` | 초과분 | critical |
| `FEE_UNDERCHARGE` | `expectedCommission − commission > max(100, expectedCommission × 1%)` | 0 | info |
| `FEE_ON_CANCELED_ORDER` | `status = 취소` 이고 `commission > 0` | `commission` | critical |
| `SHIPPING_OVERCHARGE` | `revenue > 0` 이고 `shippingDeduction > expectedShipping` | 초과분 | warning |
| `RETURN_FEE_DOUBLE_CHARGED` | `status = 반품완료` 이고 `returnFee > roundTripReturnFee` | 초과분 | critical |
| `RETURN_FEE_ON_SHIPPED_ORDER` | `status = 배송완료` 이고 `returnFee > 0` | `returnFee` | warning |
| `SETTLEMENT_SHORTFALL` | 배정 후 잔여 부족분 `> 10원` | 잔여 | critical |
| `ROUNDING_LEAK` | 배정 후 잔여 부족분 `1~10원` | 잔여 | info |
| `SETTLEMENT_SURPLUS` | `surplus > 10원` | 0 | info |
| `NEGATIVE_MARGIN` | `status = 배송완료` 이고 `unitCost > 0` 이고 `netMargin < 0` | 0 (노출액 별도) | critical |
| `MISSING_LEDGER` | `unitCost ≤ 0` | 0 | warning |

### 4.1 귀속 우선순위

`FEE_ON_CANCELED_ORDER` → `RETURN_FEE_DOUBLE_CHARGED` → `RETURN_FEE_ON_SHIPPED_ORDER` → `FEE_OVERCHARGE` → `SHIPPING_OVERCHARGE`

각 후보의 귀속액 = `min(후보 금액, 남은 부족분)`.

---

## 5. 불변식 (테스트로 고정)

| ID | 불변식 |
| --- | --- |
| INV-1 | 모든 행에서 `row.loss === row.shortfall` |
| INV-2 | 모든 행에서 `sum(anomaly.loss) === row.loss` (이중 계산 없음) |
| INV-3 | 이상이 없는 행은 `shortfall ≤ 10원` |
| INV-4 | `0 ≤ matchedRate ≤ 100` |
| INV-5 | 동일 입력 → 동일 출력 (시계·난수 미사용, `now` 주입) |
| INV-6 | 마스킹된 금액 문자열은 정확한 값을 복원할 수 없다 (`full`은 숫자 0개) |
| INV-7 | 감사 로그는 삭제·수정 시 `verify()`가 깨진 인덱스를 반환 |
| INV-8 | 파싱 결과는 청크 분할 방식과 무관하게 동일 |

---

## 6. 파이프라인 API

```ts
// 파일 (브라우저)
parseSettlementFile(file, {
  onProgress?: (p: ParseProgress) => void,
  forceMainThread?: boolean,
  workerTimeoutMs?: number,
}): Promise<FileParseResult>
// meta.engine: "worker" | "main-thread", meta.engineFallbackReason?: string

// 문자열 / 스트림
parseSettlementCsvText(text, options): Promise<SettlementParseResult>
parseSettlementCsvChunks(chunks: AsyncIterable<string>, options): Promise<SettlementParseResult>

// 대사
reconcileRow(row, contracts?): ReconciledRow
reconcileSettlement(rows, options?): ReconciliationResult
reconcileSettlementInBatches(rows, { batchSize, onProgress, signal, yieldToEventLoop }): Promise<ReconciliationResult>
```

### 6.1 진행률 계약

| 필드 | 의미 |
| --- | --- |
| `percent` | 0~100. 파서는 읽은 바이트, 대사기는 처리 행 기준 |
| `processedRows` / `parsedRows` / `errorRows` | 원본 행 / 정상 변환 / 격리 |
| `rowsPerSecond` | 경과 시간 기준 실측 |
| `bytesRead` / `totalBytes` | 파일 크기 대비 진행 |

`percent`는 **단조 증가**해야 하며 마지막 콜백은 100이다(테스트).

---

## 7. 오류 예산

| 상황 | 정책 |
| --- | --- |
| 오류 행 비율 < 5% | 정상 진행 + 경고 배너 |
| 오류 행 비율 ≥ 5% | 정상 진행 + 경고 강조 (파일 형식 재확인 권고) |
| 정상 행 0건 | 실패 처리, 첫 오류 사유 표시 |
| 필수 열 누락 | 즉시 실패 (부분 결과로 오해 방지) |
| 중복 주문번호 | 두 번째부터 제외, 건수 표시 |
| 필드 64KB 초과 | 해당 행 격리(`corrupted`) |

---

## 8. 화면 상태 정의

| 상태 | 조건 | 표시 |
| --- | --- | --- |
| `idle` | 최초 진입 | 스켈레톤 + "대기 중" |
| `generating` | 데모 원장 생성 | 진행률 바 |
| `parsing` | 파일 파싱 | 엔진(Worker/메인)·행 수·처리량 |
| `reconciling` | 배치 대사 | 처리/전체·처리량 |
| `ready` | 완료 | KPI·표·요약 |
| `error` | 실패 | 사유 + 재시도 경로 |

---

## 9. 권한 · 마스킹 계약

| 역할 | 정산액 | 원가 | 사업자번호 | 반출 | 테넌트 전환 | 감사 로그 |
| --- | --- | --- | --- | --- | --- | --- |
| `MASTER_ADMIN` | 전체 | 전체 | 부분 | ✔ | ✔ | ✔ |
| `SETTLEMENT_MANAGER` | 전체 | 전체 | 부분 | ✔ | ✕ | ✕ |
| `OPERATION_MD` | 부분 | 차단 | 차단 | ✕ | ✕ | ✕ |

거부 시 `authorize()`는 `{ allowed:false, code, reason }`을 돌려주고, **호출 측은 거부도 감사 로그에 기록**한다.
`code`: `ROLE_NOT_ALLOWED` | `TENANT_OUT_OF_SCOPE` | `TENANT_UNKNOWN` | `NOT_AUTHENTICATED`.

---

## 10. 감사 로그 계약

```ts
AuditEvent = {
  seq, at(ISO), role, tenantId, action, target, detail, outcome,
  hash,      // FNV-1a(JSON(payload))
  prevHash,  // 직전 이벤트 hash, 첫 이벤트는 "genesis"
}
```

검증: `seq/at/role/tenantId/action/target/detail/outcome/prevHash`를 다시 직렬화해 해시를 재계산하고,
`prevHash` 연결을 확인한다. 하나라도 어긋나면 `{ valid: false, brokenIndex }`.

---

## 11. 성능 목표

| 항목 | 목표 | 현재 |
| --- | --- | --- |
| 10만 행 파싱 | < 2,000 ms | 612 ms (Node 20.20.2) |
| 10만 행 대사 | < 500 ms | 161 ms |
| 스크롤 프레임 | < 16 ms | rAF 1회 갱신, 렌더 28행 |
| 초기 번들 | < 130 kB | `/reconciliation` First Load 119 kB |

---

## 12. 테스트 매트릭스

| 영역 | 파일 | 케이스 |
| --- | --- | --- |
| 대사 규칙·귀속·집계·배치 | `reconciliationEngine.test.ts` | 33 |
| 토크나이저·매퍼·파이프라인·성능 | `csvStreamParser.test.ts` | 20 |
| 윈도 계산·이진 탐색 | `virtualization.test.ts` | 16 |
| 권한·마스킹·감사 체인 | `multiTenantRbac.test.ts` | 22 |
