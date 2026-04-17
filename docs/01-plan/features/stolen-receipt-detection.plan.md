# [Plan] stolen-receipt-detection

> **Feature**: 도용 영수증 탐지 (인터넷 캡처/스크린샷)
> **Date**: 2026-04-15
> **Phase**: Plan

---

## Executive Summary

| 관점 | 내용 |
|------|------|
| **Problem** | 블로그·카페·타인 리뷰에서 캡처한 화면 스크린샷 영수증을 현재 구조에서 탐지 불가 — EXIF 흔적도 없고, 내용도 실제 영수증과 동일 |
| **Solution** | Gemini Vision API로 "실제 촬영 영수증 vs 화면 캡처/스크린샷" 판별 항목을 기존 TAMPER_PROMPT에 추가 (API 추가 호출 없음) |
| **Functional UX Effect** | 화면 캡처 영수증 감지 시 🔴 반려 또는 🟡 주의 — 도용 의심 근거 명시 |
| **Core Value** | 타인 리뷰 영수증 도용을 통한 포인트 편취 방지 |

---

## Context Anchor

| 항목 | 내용 |
|------|------|
| **WHY** | 인터넷에서 검색한 영수증 이미지를 스크린샷으로 제출하는 행위가 EXIF 검증, OCR, NTS API를 모두 통과할 수 있음 |
| **WHO** | 여신티켓 어드민 운영자 — 화면 캡처 영수증을 육안으로 구별하기 어려운 실무자 |
| **RISK** | 오탐: 고화질 스마트폰 스크린샷은 실제 촬영과 구별 어려울 수 있음 — 중신뢰(의심)는 🟡 주의로 처리하여 오반려 최소화 |
| **SUCCESS** | 화면 캡처 고신뢰 → 🔴 반려 / 화면 캡처 의심 → 🟡 주의 / 정상 촬영 영수증 오탐 없음 |
| **SCOPE** | `background.js`의 `TAMPER_PROMPT` 확장 + `parseTamperResult()` 확장, `content.js`의 `judgeResult()` 확장 |

---

## 1. 요구사항

| ID | 요구사항 | 우선순위 |
|----|----------|----------|
| FR-01 | `TAMPER_PROMPT`에 "화면 캡처/스크린샷 여부" 탐지 항목(4번) 추가 | Must |
| FR-02 | Gemini 응답에 `도용_의심: 예\|아니오` 줄 추가 | Must |
| FR-03 | `parseTamperResult()`에서 `도용_의심` 파싱 → `isSuspectedStolen: true/false` 반환 | Must |
| FR-04 | 화면 캡처 고신뢰(`isSuspectedStolen && tamperLevel !== 'low'`) → 🔴 반려 (우선순위 2 통합) | Must |
| FR-05 | 화면 캡처 단독 의심(`isSuspectedStolen && tamperLevel === 'low'`) → 🟡 주의 | Must |
| FR-06 | Gemini 분석 실패 시 `isSuspectedStolen: false` 기본값 → 건너뜀 | Must |

---

## 2. 기술 설계

### 2.1 TAMPER_PROMPT 확장

```
기존 [검토 항목] 1~3 유지

4. 화면 캡처/스크린샷 여부:
   - 모니터·TV·스마트폰 화면을 촬영하거나 캡처한 이미지인지 판단
   - 픽셀 격자 패턴(모아레), 화면 베젤·UI 요소 흔적, 반사광
   - 실제 종이 영수증 특유의 열인쇄 노이즈·구겨짐·배경 없이 완벽한 흰 배경

기존 답변 3줄 유지
도용_의심: 예|아니오
(화면 캡처·스크린샷으로 판단 시 "예", 아니면 "아니오")
```

### 2.2 parseTamperResult 확장

```javascript
function parseTamperResult(raw) {
  // ... 기존 파싱 유지 ...
  const stolenMatch = raw.match(/도용_의심:\s*(예|아니오)/);
  const isSuspectedStolen = stolenMatch?.[1] === '예';
  return { tamperLevel, score, verdict, reason, isSuspectedStolen, success: true };
}
```

### 2.3 처리 흐름 및 판정

```
ANALYZE_TAMPER 응답 (기존 + 도용_의심 추가)
  ↓
parseTamperResult()
  → tamperLevel: 'high'/'medium'/'low'
  → isSuspectedStolen: true/false
  ↓
judgeResult()
  ├─ tamperLevel='high' (위변조 고신뢰) → 🔴 반려 [기존, 우선순위 2]
  ├─ isSuspectedStolen && tamperLevel !== 'low' → 🔴 반려 [신규, 우선순위 2 통합]
  ├─ isSuspectedStolen && tamperLevel === 'low' → 🟡 주의 [신규, 우선순위 6 통합]
  └─ tamperLevel='medium' (위변조 중신뢰) → 🟡 주의 [기존, 우선순위 6]
```

### 2.4 판정 우선순위 (갱신)

| 우선순위 | 조건 | 판정 |
|----------|------|------|
| 2 | AI 위변조 고신뢰 **또는 도용 고신뢰** | 🔴 반려 |
| 6 | AI 위변조 중신뢰 **또는 도용 단독 의심** | 🟡 주의 |
| (기타) | 기존 우선순위 유지 | — |

---

## 3. 범위

### 포함
- `background.js`
  - `TAMPER_PROMPT`: 항목 4 (화면 캡처 탐지) + 응답 포맷에 `도용_의심` 줄 추가
  - `parseTamperResult()`: `isSuspectedStolen` 파싱 추가
- `content.js`
  - `judgeResult()`: `tamperResult.isSuspectedStolen` 판정 로직 추가

### 제외
- 역방향 이미지 검색 (Google Vision, TinEye 등) — CORS·비용 문제로 제외
- 별도 API 호출 없음 — 기존 ANALYZE_TAMPER 파이프라인 재사용
- UI 스타일 추가 없음 (기존 🔴/🟡 모달 재사용)

---

## 4. 리스크

| 리스크 | 영향도 | 대응 |
|--------|--------|------|
| 오탐: 고화질 폰 스크린샷 → 정상 반려 | 높음 | 도용 단독 의심 → 🟡 주의로 처리 (반려 아님) |
| Gemini가 도용_의심 줄 누락 | 중간 | regex 미매칭 → `isSuspectedStolen: false` 기본값 → 건너뜀 |
| 탐지 정확도 한계 | 중간 | 프롬프트 기반 판단 — 완벽하지 않음을 결과 메시지에 명시 |

---

## 5. 성공 기준

- [ ] 블로그 캡처 영수증 → 🔴 반려 또는 🟡 주의 + "화면 캡처 의심" 메시지
- [ ] 실제 촬영 영수증 → 도용 오탐 없이 다음 검증 진행
- [ ] Gemini 응답에 도용_의심 줄 없을 시 → 건너뜀, 다른 검증 영향 없음

---

## 6. 구현 순서

1. `background.js` — `TAMPER_PROMPT`에 항목 4 추가 + 응답 포맷에 `도용_의심` 줄 추가
2. `background.js` — `parseTamperResult()`에 `isSuspectedStolen` 파싱 추가
3. `content.js` — `judgeResult()`에 `isSuspectedStolen` 판정 로직 추가
