# [Plan] ai-generated-detection

> **Feature**: 생성형 AI 영수증 탐지 (TAMPER_PROMPT 통합)
> **Date**: 2026-04-15
> **Phase**: Plan

---

## Executive Summary

| 관점 | 내용 |
|------|------|
| **Problem** | DALL-E·Midjourney·Stable Diffusion 등 생성형 AI로 만든 영수증은 EXIF 흔적 없고 시각적으로도 완벽하여 기존 검증 모두 통과 |
| **Solution** | 기존 `TAMPER_PROMPT`에 "AI 생성 여부" 탐지 항목(5번) 추가 — Gemini가 AI 생성 특유의 픽셀 패턴·폰트 완벽성·비현실적 깔끔함을 감지 (API 추가 호출 없음) |
| **Functional UX Effect** | AI 생성 영수증 → 🔴 반려, 의심 → 🟡 주의 — 생성형 AI 악용 사기 자동 차단 |
| **Core Value** | EXIF·OCR·NTS 검증을 모두 우회하는 AI 생성 영수증에 대한 마지막 방어선 |

---

## Context Anchor

| 항목 | 내용 |
|------|------|
| **WHY** | 생성형 AI 기술이 보편화되어 영수증 이미지를 AI로 생성하는 것이 쉬워짐 — 기존 4개 검증이 모두 무력화됨 |
| **WHO** | 여신티켓 어드민 운영자 — AI 생성 영수증을 육안으로 식별하기 점점 어려워지는 실무자 |
| **RISK** | Gemini 오탐: 화질 좋고 깔끔한 실제 영수증이 AI 생성으로 오판될 수 있음 — 보수적 판정으로 완화 |
| **SUCCESS** | AI 생성 영수증 고신뢰 → 🔴 반려 / AI 생성 의심 → 🟡 주의 / 실제 영수증 오탐 없음 |
| **SCOPE** | `background.js`의 `TAMPER_PROMPT` + `parseTamperResult()` 확장, `content.js`의 `judgeResult()` 확장 |

---

## 1. 요구사항

| ID | 요구사항 | 우선순위 |
|----|----------|----------|
| FR-01 | `TAMPER_PROMPT`에 "AI 생성 여부" 탐지 항목(5번) 추가 | Must |
| FR-02 | Gemini 응답에 `AI생성_의심: 예\|아니오` 줄 추가 | Must |
| FR-03 | `parseTamperResult()`에서 `AI생성_의심` 파싱 → `isSuspectedAI: true/false` 반환 | Must |
| FR-04 | AI 생성 고신뢰(`isSuspectedAI && tamperLevel !== 'low'`) → 🔴 반려 (우선순위 2 통합) | Must |
| FR-05 | AI 생성 단독 의심(`isSuspectedAI && tamperLevel === 'low'`) → 🟡 주의 | Must |
| FR-06 | Gemini 분석 실패 시 `isSuspectedAI: false` 기본값 → 건너뜀 | Must |

---

## 2. 기술 설계

### 2.1 TAMPER_PROMPT 확장 (stolen-receipt-detection과 연계)

```
기존 [검토 항목] 1~4 (도용 탐지 포함) 유지

5. AI 생성 여부:
   - DALL-E, Midjourney, Stable Diffusion 등 생성형 AI로 만든 이미지인지 판단
   - AI 생성 특징: 폰트/글씨가 지나치게 균일, 열인쇄 노이즈·잉크번짐·구겨짐 전혀 없음
   - 비현실적으로 완벽한 레이아웃, 숫자 배치가 인간적 부정확함 없이 픽셀 완벽
   - AI 생성 텍스트 특유의 비자연스러운 한국어 글자 조합

기존 답변 (위변조_점수, 판정, 도용_의심) 유지
AI생성_의심: 예|아니오
이유: (발견된 모든 문제들, 없으면 "이상 없음")
```

> **참고**: `stolen-receipt-detection` Plan과 동일한 `TAMPER_PROMPT`를 수정하므로,
> 두 Plan을 **한 번에 구현**하는 것을 권장. 최종 응답 형식 (6줄):
> ```
> 위변조_점수: 0-100
> 판정: 정상|의심|위변조
> 도용_의심: 예|아니오
> AI생성_의심: 예|아니오
> 이유: ...
> ```

### 2.2 parseTamperResult 최종 형태

```javascript
function parseTamperResult(raw) {
  if (!raw) return { tamperLevel: 'unknown', score: 0, isSuspectedStolen: false, isSuspectedAI: false, reason: '분석 결과 없음' };
  const score   = parseInt(raw.match(/위변조_점수:\s*(\d+)/)?.[1] ?? '0');
  const verdict = raw.match(/판정:\s*(정상|의심|위변조)/)?.[1] ?? '정상';
  const reason  = raw.match(/이유:\s*(.+)/)?.[1]?.trim() ?? '이상 없음';
  const isSuspectedStolen = raw.match(/도용_의심:\s*(예|아니오)/)?.[1] === '예';
  const isSuspectedAI     = raw.match(/AI생성_의심:\s*(예|아니오)/)?.[1] === '예';

  let tamperLevel;
  if (verdict === '위변조' || score >= 80) tamperLevel = 'high';
  else if (verdict === '의심' || score >= 50) tamperLevel = 'medium';
  else tamperLevel = 'low';

  return { tamperLevel, score, verdict, reason, isSuspectedStolen, isSuspectedAI, success: true };
}
```

### 2.3 판정 우선순위 (최종 통합)

| 우선순위 | 조건 | 판정 |
|----------|------|------|
| 1 | EXIF 위변조 | 🔴 반려 |
| 2 | AI 위변조 고신뢰 **또는 도용 고신뢰 또는 AI생성 고신뢰** | 🔴 반려 |
| 3 | 중복 영수증 | 🔴 반려 |
| 4 | 유효하지 않은 카드 BIN | 🔴 반려 |
| 5 | NTS 폐업/휴업/미등록 | 🔴 반려 |
| 6 | AI 위변조 중신뢰 **또는 도용 단독 의심 또는 AI생성 단독 의심** | 🟡 주의 |
| 7 | 국세청 API 오류 | 🟡 주의 |
| 8 | 사업자번호 없음 | 🟢 통과 |
| 9 | NTS 계속사업자 | 🟢 정상 |

### 2.4 처리 흐름

```
ANALYZE_TAMPER 응답 (위변조_점수, 판정, 도용_의심, AI생성_의심, 이유)
  ↓
parseTamperResult()
  → tamperLevel, isSuspectedStolen, isSuspectedAI
  ↓
judgeResult()
  ├─ tamperLevel='high' OR isSuspectedStolen OR isSuspectedAI → 🔴 반려 [우선순위 2]
  │    (단, isSuspectedStolen/AI 단독이고 tamperLevel='low'인 경우 → 다음으로)
  ├─ tamperLevel='medium' OR isSuspectedStolen(단독) OR isSuspectedAI(단독) → 🟡 주의 [우선순위 6]
  └─ tamperLevel='low' AND !isSuspectedStolen AND !isSuspectedAI → 다음 판정으로
```

---

## 3. 범위

### 포함
- `background.js`
  - `TAMPER_PROMPT`: 항목 5 (AI 생성 탐지) + 응답 포맷에 `AI생성_의심` 줄 추가 (stolen 플랜과 동시 적용)
  - `parseTamperResult()`: `isSuspectedAI` 파싱 추가
- `content.js`
  - `judgeResult()`: `tamperResult.isSuspectedAI` 판정 로직 추가

### 제외
- C2PA (Content Authenticity Initiative) 메타데이터 검증 — 라이브러리 의존성으로 제외
- 별도 AI 생성 탐지 API — 기존 Gemini 파이프라인 재사용
- UI 스타일 추가 없음

---

## 4. 구현 상 주의사항

`stolen-receipt-detection`과 `ai-generated-detection`은 **동일한 TAMPER_PROMPT와 parseTamperResult()를 수정**합니다. 반드시 두 Plan을 **함께 구현**해야 충돌 없이 동작합니다.

구현 시 최종 TAMPER_PROMPT 응답 형식은 **6줄**:
```
위변조_점수: 0-100
판정: 정상|의심|위변조
도용_의심: 예|아니오
AI생성_의심: 예|아니오
이유: ...
```

---

## 5. 리스크

| 리스크 | 영향도 | 대응 |
|--------|--------|------|
| 오탐: 깨끗한 실제 영수증 → AI 생성 오판 | 높음 | 단독 의심 → 🟡 주의로 처리 (반려 아님) |
| Gemini AI생성 탐지 정확도 한계 | 중간 | 프롬프트 기반 판단 — 근거(이유) 명시로 운영자 판단 보조 |
| AI생성_의심 줄 Gemini가 누락 | 낮음 | regex 미매칭 → `isSuspectedAI: false` 기본값 → 건너뜀 |

---

## 6. 성공 기준

- [ ] AI 생성 영수증(Midjourney 등) → 🔴 반려 또는 🟡 주의 + "AI 생성 의심" 메시지
- [ ] 실제 촬영 영수증 → AI생성 오탐 없이 다음 검증 진행
- [ ] `stolen-receipt-detection`과 함께 구현 시 `parseTamperResult()` 정상 동작 확인

---

## 7. 구현 순서

(*stolen-receipt-detection과 동시 구현 권장*)

1. `background.js` — `TAMPER_PROMPT` 최종 버전 (항목 4+5 + 6줄 응답 형식)
2. `background.js` — `parseTamperResult()` 최종 버전 (`isSuspectedStolen` + `isSuspectedAI`)
3. `content.js` — `judgeResult()` 우선순위 2·6 확장 (도용+AI생성 통합 판정)
