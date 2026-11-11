# 마켓 정산 API 커넥터 설계 노트

이 문서는 `src/lib/marketApiConnector.ts`가 **왜 이렇게 생겼는지**를 남긴다.
README §6.6이 사용법이라면, 여기는 결정의 근거와 경계다.

---

## 1. 범위

| 하는 것 | 하지 않는 것 |
| --- | --- |
| 스마트스토어 커머스API·쿠팡 Open API에서 정산 내역 조회 | 상품·주문·배송 API |
| 인증(토큰/서명), 페이지네이션, 재시도, 오류 번역 | 시크릿의 서버 보관 |
| 마켓 금액 + 셀러 원장(원가) + 계약서(수수료율) 결합 | 계약서 관리 UI |
| 대사 엔진으로의 단일 파이프라인 연결 | 대사 규칙의 재구현 |

“하지 않는 것”을 적어 두는 이유는, 이 모듈이 커지면 경계가 흐려지기 때문이다. 특히 **대사 규칙은 한 벌만**
존재해야 한다. 파일 경로와 API 경로가 다른 규칙을 쓰면 같은 정산서가 경로에 따라 다른 손실액을 낸다.

---

## 2. 인증

### 스마트스토어(커머스API) — OAuth2 Client Credentials + bcrypt 전자서명

```
password        = client_id + "_" + timestamp(ms)
client_secret_sign = Base64( bcrypt(password, client_secret) )
POST /external/v1/oauth2/token
  client_id=…&timestamp=…&grant_type=client_credentials&client_secret_sign=…&type=SELF
→ { access_token, expires_in }
Authorization: Bearer {access_token}
```

- 시크릿 **원문을 전송하지 않기 위한** 장치다. 따라서 요청 본문에도, 오류 메시지에도 시크릿이 남으면 안 된다.
- `timestamp`는 13자리(ms)이고 서버 시각 기준 5분 이내여야 한다(마켓 문서). 시계가 틀어지면 서명이 거부된다.
- `401 + GW.AUTHN`은 “토큰 만료”의 신호다. 커넥터는 **토큰을 1회 재발급하고 요청을 재시도**한다(`fetchPage`).
- 내 스토어 앱은 `type=SELF`만 지원한다.

### 쿠팡(Open API) — CEA HMAC-SHA256

```
signed_date = <YYMMDD>T<HHMMSS>Z   (UTC)
message     = signed_date + METHOD + path + query   (도메인 제외)
signature   = HEX( HMAC_SHA256(secret_key, message) )
Authorization: CEA algorithm=HmacSHA256, access-key=…, signed-date=…, signature=…
```

- 서명에 **쿼리 문자열 전체**가 들어간다. URL을 만들고 나서 서명해야 하며, 쿼리 순서가 바뀌면 서명이 깨진다.
  그래서 `settlementPath()`가 URL과 서명 재료를 **한 번에** 만든다.
- 업체코드(`vendorId`)는 필수다. 없으면 요청 전에 `CONFIG`로 막는다(네트워크를 낭비하지 않는다).
- HMAC은 Web Crypto(`crypto.subtle`)를 쓴다. 브라우저와 Node 20 모두에서 동작하고, 키를 문자열로 보관하지 않는다.

### 테스트가 구현을 믿지 않게 하는 법

쿠팡 서명 테스트는 커넥터가 만든 헤더에서 `signed-date`와 URL을 꺼내 **`node:crypto`로 다시 계산**해 비교한다.
같은 함수로 검증하면 “구현과 테스트가 함께 틀리는” 경우를 못 잡는다.

---

## 3. 페이지네이션

- 응답 봉투가 마켓마다 다르다: `{ data: [...] }`(스마트스토어), `{ code, data: { content: [...] } }`(쿠팡).
  `unwrapSettlementPage()`는 배열이 있는 첫 지점을 찾고, `page`/`hasNext` 플래그도 같은 방식으로 찾는다.
- **플래그가 없을 때만** “페이지가 가득 찼으면 다음이 있다”로 추론한다. 플래그가 있는데도 추론하면
  마지막 페이지에서 무한 루프가 된다(실제로 이 버그를 테스트가 잡았다).
- 안전장치: `maxPages`(기본 40). 넘으면 조용히 자르지 않고 `PARSE` 오류로 알린다.
  잘못된 `hasNext` 구현이 브라우저 탭을 죽이는 것보다, “왜 멈췄는지”를 말하는 편이 낫다.

---

## 4. 오류 정책

| 상황 | 코드 | 재시도 | 이유 |
| --- | --- | --- | --- |
| 400/401(토큰) | `AUTH` | ✗ | 키가 틀렸는데 재시도하면 계정이 잠긴다 |
| 403 | `FORBIDDEN` | ✗ | 권한 문제는 반복해도 같다 |
| 429 | `RATE_LIMITED` | ✓ (800ms) | 한도 회복을 기다린다 |
| 5xx | `SERVER` | ✓ (300·2ⁿms) | 일시 장애 |
| 네트워크/타임아웃 | `NETWORK` | ✓ | 재시도 가치가 있다 |
| JSON 아님/배열 없음 | `PARSE` | ✗ | 점검 페이지·버전 변경 |
| 설정 누락 | `CONFIG` | ✗ | 요청조차 보내지 않는다 |

모든 오류는 `MarketApiError`로 통일하고 `hint`에 **사용자가 할 수 있는 일**을 적는다. 화면은 이 `hint`를 그대로 보여 준다.
오류를 만든 지점에서 `secrets`를 넘기면 `message`·`detail`에서 해당 값이 `[REDACTED]`로 치환된다.

---

## 5. 샌드박스

- `(provider, month)`를 FNV-1a 해시로 시드해 1,200건을 생성한다. 같은 조합이면 항상 같은 결과다.
- 레코드에는 **마켓이 실제로 주는 필드만** 담는다. 원가는 `ledger`로 분리해, 결합 단계가 진짜로 실행되게 한다.
- 주문번호에 정산월을 넣어(`SS2026100000001`) 월별 데이터가 섞이지 않는다.
- 전송 계층만 바꿔 끼우므로(`HttpTransport`) 커넥터·파서·페이지네이션·오류 처리는 실연동과 **같은 코드**를 탄다.
- 실패 주입(`failAt`)으로 재시도 경로도 샌드박스에서 검증한다.

---

## 6. 보안 경계

1. **시크릿은 화면에 다시 그리지 않는다.** 입력 후에는 마스크(`sk-••••••••1f2a`)만 남는다. 불릿 개수를 고정해
   길이도 숨긴다.
2. **로컬 저장은 opt-in.** `localStorage` 키는 `csa.market-api.credentials.v1` 하나이고, 사용자가 체크한 경우에만
   시크릿을 포함한다. 손상된 JSON은 조용히 버린다(화면이 죽는 것보다 낫다).
3. **브라우저 직접 호출은 샌드박스 전용.** 마켓 API는 CORS를 허용하지 않는다. 실연동은 서버 프록시
   (`NEXT_PUBLIC_MARKET_API_PROXY`)를 거치며, 프록시가 없으면 화면이 그 사실을 먼저 알린다.
4. **실서비스 권장 구성**: 시크릿은 서버(KMS/Secrets Manager)에만 두고, 브라우저는 “수집 요청”만 보낸다.
   이 저장소는 그 경계를 명시적으로 표시하는 데까지 했다.

---

## 7. 남은 일

- [ ] 마켓 API 프록시 라우트(`/api/market/{provider}/…`)와 서버 측 시크릿 보관
- [ ] 정산 이력 저장(월별 재대사, 전월 대비 차액)
- [ ] 쿠팡 `rCode`(HTTP 200 + 오류 코드) 응답 처리 — 실연동 시 확인 필요
- [ ] 마켓별 레코드 필드 확장(배송비 정산 주체, 쿠폰 분담)
