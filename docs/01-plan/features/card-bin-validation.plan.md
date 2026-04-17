# [Plan] card-bin-validation

> **Feature**: 카드 BIN 번호 유효성 검증
> **Date**: 2026-04-15
> **Phase**: Plan

---

## Executive Summary

| 관점 | 내용 |
|------|------|
| **Problem** | 영수증 내 카드번호가 실제 존재하지 않는 번호이더라도 현재 구조에서 탐지 불가 — 허위 카드번호로 만든 영수증이 통과됨 |
| **Solution** | OCR로 영수증 카드번호 앞 6자리(BIN)를 추출하고, 무료 BIN 조회 API(lookup.binlist.net)로 실존 여부 확인 |
| **Functional UX Effect** | 유효하지 않은 카드번호 영수증 즉시 🔴 반려 — 운영자의 육안 확인 부담 제거 |
| **Core Value** | 존재하지 않는 카드번호로 제작된 위조 영수증을 자동 차단 |

---

## Context Anchor

| 항목 | 내용 |
|------|------|
| **WHY** | 카드번호 자체를 허위로 만든 영수증은 EXIF·OCR·NTS 검증을 모두 통과할 수 있음 |
| **WHO** | 여신티켓 어드민 운영자 — 허위 카드번호 영수증을 육안으로 식별하기 어려운 실무자 |
| **RISK** | BIN API Rate Limit: lookup.binlist.net은 무료 약 10req/hour — 초과 시 건너뜀(graceful degradation) 처리 / 카드번호 마스킹으로 인한 BIN 미추출 시 건너뜀 |
| **SUCCESS** | 유효하지 않은 BIN → 🔴 반려 / 유효한 BIN → 다음 검증 계속 / API 실패 시 건너뜀, 다른 검증 영향 없음 |
| **SCOPE** | `background.js` BIN API 핸들러, `content.js` 카드번호 추출 + BIN 검증 통합, `STANDARD_PROMPT` 확장 |

---

## 1. 요구사항

| ID | 요구사항 | 우선순위 |
|----|----------|----------|
| FR-01 | Gemini OCR 결과에서 카드번호 앞 6자리(BIN) 추출 | Must |
| FR-02 | `background.js`에서 `lookup.binlist.net` API로 BIN 실존 여부 확인 | Must |
| FR-03 | BIN 404(미등록) → 🔴 반려 처리 | Must |
| FR-04 | BIN API Rate Limit(429) 또는 오류 → 건너뜀, 다른 검증 계속 | Must |
| FR-05 | 카드번호 미추출(마스킹 등) 시 BIN 검증 건너뜀 | Must |
| FR-06 | `judgeResult()`에 `binResult` 인자 추가, 판정 우선순위 4로 통합 | Must |

---

## 2. 기술 설계

### 2.1 BIN 조회 API

| 항목 | 내용 |
|------|------|
| **서비스** | lookup.binlist.net (무료, 인증 불필요) |
| **엔드포인트** | `GET https://lookup.binlist.net/{6자리 BIN}` |
| **응답 예** | `{"scheme":"visa","type":"debit","brand":"Visa","country":{"alpha2":"KR"},"bank":{"name":"국민은행"}}` |
| **HTTP 404** | BIN 미등록 → 유효하지 않은 카드번호 |
| **HTTP 429** | Rate Limit 초과 → graceful skip |
| **Timeout** | 8초 설정 |

### 2.2 STANDARD_PROMPT 확장

```
(기존 내용 유지)

3. 카드번호 앞 6자리 (BIN)
   - "카드번호", "Card No", "승인카드번호" 레이블 옆에 있음
   - 형식: XXXX-XX**-****-XXXX 또는 XXXX XXXX XXXX XXXX (마스킹 포함)
   - 앞 6자리만 추출 (예: "123456")
   - 카드번호 자체가 없으면 "없음" 기재

(기존 답변 두 줄 유지)
카드BIN: XXXXXX
(없으면 "없음" 기재)
```

### 2.3 처리 흐름

```
verifyReceipt()
  ↓
OCR 결과에서 cardBIN 추출 (extractCardBIN)
  ↓
cardBIN이 있으면:
  → VERIFY_CARD_BIN → background.js
  → fetch lookup.binlist.net/{bin}
  → 404: { valid: false, reason: 'BIN 미등록' }
  → 200: { valid: true, scheme, country, bank }
  → 429/오류: { valid: true, skip: true }
  ↓
judgeResult(..., binResult)
  └─ binResult.valid === false → 🔴 반려 (우선순위 4)
```

### 2.4 판정 우선순위 (갱신)

| 우선순위 | 조건 | 판정 |
|----------|------|------|
| 1 | EXIF 위변조 | 🔴 반려 |
| 2 | AI 시각적 위변조 고신뢰 | 🔴 반려 |
| 3 | 중복 영수증 | 🔴 반려 |
| **4** | **유효하지 않은 카드 BIN** | **🔴 반려** |
| 5 | NTS 폐업/휴업/미등록 | 🔴 반려 |
| 6 | AI 시각적 위변조 중신뢰 | 🟡 주의 |
| 7 | 국세청 API 오류 | 🟡 주의 |
| 8 | 사업자번호 없음 | 🟢 통과 |
| 9 | NTS 계속사업자 | 🟢 정상 |

---

## 3. 범위

### 포함
- `background.js`
  - `VERIFY_CARD_BIN` 메시지 핸들러
  - `verifyCardBIN(bin)` 함수 (lookup.binlist.net 호출)
- `content.js`
  - `extractCardBIN(ocrText)` 함수 (OCR 결과에서 BIN 추출)
  - `checkCardBIN(bin)` 함수 (background 메시지 래퍼)
  - `verifyReceipt()`: BIN 검증 단계 추가 (OCR 후 직렬 실행)
  - `judgeResult()`: `binResult` 6번째 인자 추가
- `background.js`의 `STANDARD_PROMPT`: 카드BIN 항목 추가

### 제외
- 전체 카드번호 Luhn 알고리즘 검증 (마스킹으로 불가)
- 카드사별 BIN 범위 로컬 데이터베이스 (API 방식으로 대체)
- UI 스타일 추가 없음 (기존 🔴 모달 재사용)

---

## 4. 리스크

| 리스크 | 영향도 | 대응 |
|--------|--------|------|
| Rate Limit 초과 (10req/hour) | 중간 | HTTP 429 → graceful skip, 다른 검증 계속 |
| 카드번호 마스킹으로 BIN 미추출 | 중간 | BIN 없음 → 건너뜀, 검증 무시 |
| lookup.binlist.net 서비스 불안정 | 낮음 | 8초 timeout + catch → graceful skip |
| 외국 카드(BIN 없음으로 잘못 반려) | 낮음 | 외국 BIN도 대부분 등록됨; 실제 미등록 BIN은 허위 번호일 가능성 높음 |

---

## 5. 성공 기준

- [ ] 존재하지 않는 BIN 번호 영수증 → 🔴 반려 + "유효하지 않은 카드번호" 표시
- [ ] 유효한 BIN(국내외 카드) → 다음 검증 계속 진행
- [ ] 카드번호 없는 영수증 → BIN 검증 건너뜀, 다른 검증 정상 동작
- [ ] Rate Limit 초과 시 → 건너뜀, 다른 검증 정상 동작

---

## 6. 구현 순서

1. `background.js` — `verifyCardBIN()` 함수 + `VERIFY_CARD_BIN` 핸들러
2. `background.js` — `STANDARD_PROMPT`에 카드BIN 추출 항목 추가
3. `content.js` — `extractCardBIN()` 함수 (OCR 결과 파싱)
4. `content.js` — `checkCardBIN()` wrapper 함수
5. `content.js` — `verifyReceipt()`에 BIN 검증 단계 추가 (OCR 후 직렬)
6. `content.js` — `judgeResult()` 우선순위 4 BIN 반려 로직 추가
