# [Plan] visual-tamper-detection

> **Feature**: Gemini Vision API 기반 시각적 위변조 탐지
> **Date**: 2026-04-14
> **Phase**: Plan

---

## Executive Summary

| 관점 | 내용 |
|------|------|
| **Problem** | EXIF 기반 탐지는 편집 흔적이 남을 때만 작동 — 그림판·온라인 편집·물리 위조 등 대부분의 실제 위변조는 탐지 불가 |
| **Solution** | Gemini Vision API로 이미지를 직접 분석해 시각적 이상 징후·수치 논리 불일치·구조 결함을 3축 검증 |
| **Functional UX Effect** | 고신뢰 위변조 → 🔴 반려 / 의심 → 🟡 주의 로 어드민 수동 검토 대상 명확화 |
| **Core Value** | EXIF 탐지의 근본적 한계를 보완하여 숫자·금액 변조 등 실질적 사기를 차단 |

---

## Context Anchor

| 항목 | 내용 |
|------|------|
| **WHY** | 그림판·온라인 편집 등 EXIF 흔적 없는 위변조가 현재 구조에서 전량 미탐지됨 |
| **WHO** | 여신티켓 어드민 운영자 — 위변조 영수증 수동 검토 부담 경감 필요 |
| **RISK** | Gemini 오탐(정상 영수증 반려): 임계값 80% 보수적 설정으로 대응 / API 추가 비용: OCR과 별도 1회 호출 |
| **SUCCESS** | 금액 변조 이미지 → 🔴 반려 / 정상 영수증 오탐 없음 / Gemini 미설정 시 해당 단계 건너뜀 |
| **SCOPE** | `background.js` 위변조 분석 파이프라인, `content.js` 판정 통합 |

---

## 1. 요구사항

| ID | 요구사항 | 우선순위 |
|----|----------|----------|
| FR-01 | Gemini Vision API로 영수증 이미지 위변조 분석 (`ANALYZE_TAMPER` 메시지 핸들러) | Must |
| FR-02 | 시각적 이상 징후 탐지: 폰트 불균일, 덧칠/지우기 흔적, 픽셀 artifacts, 복붙 패턴 | Must |
| FR-03 | 수치 논리 일관성 검증: 소계+부가세=합계, 날짜 현실성 (미래 날짜 등) | Must |
| FR-04 | 영수증 구조 검증: 가맹점명·날짜·금액·사업자번호 등 필수 항목 존재 여부 | Must |
| FR-05 | 위변조_점수 ≥ 80 또는 판정='위변조' → 🔴 반려 (우선순위 2 — EXIF 다음) | Must |
| FR-06 | 위변조_점수 50–79 또는 판정='의심' → 🟡 주의 (NTS 이후 단계에서 표시) | Must |
| FR-07 | `judgeResult()`에 `tamperResult` 인자 추가, 판정 우선순위 통합 | Must |
| FR-08 | Gemini API 미설정 또는 분석 실패 시 위변조 단계 건너뜀 — 다른 검증 계속 진행 | Must |

---

## 2. 기술 설계

### 2.1 판정 우선순위 (judgeResult 통합)

| 우선순위 | 조건 | 판정 |
|----------|------|------|
| 1 | EXIF 위변조 감지 | 🔴 반려 |
| **2** | **AI 위변조 고신뢰 (점수 ≥ 80 또는 판정='위변조')** | **🔴 반려** |
| 3 | 중복 영수증 감지 | 🔴 반려 |
| 4 | NTS 폐업/휴업/미등록 | 🔴 반려 |
| 5 | **AI 위변조 중신뢰 (점수 50–79 또는 판정='의심')** | **🟡 주의** |
| 6 | 국세청 API 오류 | 🟡 주의 |
| 7 | 사업자번호 없음 | 🟢 통과 |
| 8 | NTS 계속사업자 | 🟢 정상 |

### 2.2 Gemini 위변조 분석 프롬프트

```
한국 카드 영수증 이미지의 위변조 여부를 분석해주세요.

[검토 항목]
1. 시각적 이상 징후: 글자/숫자 폰트 불균일, 덧칠·지우개 흔적, 픽셀 아티팩트,
   복사-붙여넣기 패턴, 색상 경계 이상
2. 수치 논리 일관성: 소계+부가세=합계 여부, 미래 날짜·비정상 시간 등
3. 영수증 구조: 가맹점명·날짜·금액 등 필수 항목 누락 여부, 전체 레이아웃 자연스러움

답변은 반드시 아래 형식 세 줄로만:
위변조_점수: 0-100
판정: 정상|의심|위변조
이유: (발견된 문제, 없으면 "이상 없음")
```

### 2.3 응답 파싱 (`parseTamperResult`)

```javascript
function parseTamperResult(raw) {
  const score   = parseInt(raw.match(/위변조_점수:\s*(\d+)/)?.[1] ?? '0');
  const verdict = raw.match(/판정:\s*(정상|의심|위변조)/)?.[1] ?? '정상';
  const reason  = raw.match(/이유:\s*(.+)/)?.[1]?.trim() ?? '이상 없음';

  let tamperLevel;
  if (verdict === '위변조' || score >= 80) tamperLevel = 'high';
  else if (verdict === '의심' || score >= 50) tamperLevel = 'medium';
  else tamperLevel = 'low';

  return { tamperLevel, score, verdict, reason, success: true };
}
```

### 2.4 처리 흐름

```
verifyReceipt()
  ↓
병렬 실행: EXIF + Hash + OCR + [위변조 분석 (신규)]
                                  ↓
                         analyzeVisualTamper(dataURL)
                           → ANALYZE_TAMPER → background.js
                           → callGeminiOCR(TAMPER_PROMPT)
                           → parseTamperResult()
                           → { tamperLevel, score, reason }
  ↓
judgeResult(exifResult, ocrResult, apiResult, hashResult, tamperResult)
  ├─ tamperLevel='high' → 🔴 반려
  ├─ tamperLevel='medium' → 🟡 주의 (NTS 이후)
  └─ tamperLevel='low' → 다음 판정으로
```

---

## 3. 범위

### 포함
- `background.js`
  - `TAMPER_PROMPT` 상수
  - `parseTamperResult(raw)` 함수
  - `analyzeVisualTamper(dataURL)` 함수
  - `ANALYZE_TAMPER` 메시지 핸들러
- `content.js`
  - `analyzeTamper(dataURL)` 함수 (background 메시지 래퍼)
  - `verifyReceipt()`: 병렬 실행 배열에 `analyzeTamper` 추가
  - `judgeResult()`: `tamperResult` 5번째 인자 추가, 우선순위 2·5 판정 로직

### 제외
- blockhash·OCR·NTS 로직 변경 없음
- EXIF 탐지 로직 변경 없음 (보완 관계, 대체 아님)
- UI 스타일 추가 없음 (기존 🔴/🟡 모달 재사용)

---

## 4. 리스크

| 리스크 | 영향도 | 대응 |
|--------|--------|------|
| 오탐 (정상 영수증 반려) | 높음 | 임계값 80% 보수적 설정 / 중간 신뢰는 🟡 주의로 처리 |
| Gemini 비용 증가 | 중간 | 검증당 추가 1회 호출 — OCR과 동일 모델, 동일 이미지 |
| 분석 지연 (병렬 실행) | 낮음 | OCR과 병렬 실행이므로 전체 검증 시간 증가 최소화 |
| 저해상도 이미지 오분석 | 중간 | 분석 실패 시 `tamperLevel='unknown'` → 건너뜀으로 처리 |

---

## 5. 성공 기준

- [ ] 금액 변조 이미지(숫자 일부 수정) → 🔴 반려
- [ ] 수치 불일치 이미지(합계 오류) → 🔴 반려 또는 🟡 주의
- [ ] 정상 영수증 5개 이상 → 오탐 없이 🟢 통과/정상
- [ ] Gemini API 미설정 시 해당 단계 건너뜀, 다른 검증 정상 동작
- [ ] 분석 실패(타임아웃 등) → 건너뜀, 다른 검증 영향 없음

---

## 6. 구현 순서

1. `background.js` — `TAMPER_PROMPT`, `parseTamperResult()`, `analyzeVisualTamper()`, `ANALYZE_TAMPER` 핸들러
2. `content.js` — `analyzeTamper()` 함수, `verifyReceipt()` 병렬 추가
3. `content.js` — `judgeResult()` `tamperResult` 인자 및 우선순위 2·5 판정 로직
