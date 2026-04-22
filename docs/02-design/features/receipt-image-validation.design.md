# [Design] receipt-image-validation

> **Feature**: 비영수증 이미지 조기 감지 및 반려
> **Date**: 2026-04-22
> **Phase**: Design
> **Architecture**: Option A — OCR 프롬프트 통합

---

## Context Anchor

| 항목 | 내용 |
|------|------|
| **WHY** | 비영수증 이미지에서 픽셀 노이즈 오탐 등 무관한 사유로 반려되는 문제 발생 — 조기에 차단해야 함 |
| **WHO** | 여신티켓 어드민 운영자 — 영수증만 업로드해야 하는 실무자 |
| **RISK** | Gemini가 `영수증여부` 필드를 누락하거나 잘못 판단하면 정상 영수증 오탐 가능 → 기본값 `true` 처리로 방어 |
| **SUCCESS** | 비영수증 이미지 업로드 시 `[0단계]` 메시지로 즉시 반려, 정상 영수증은 통과 |
| **SCOPE** | `background.js` STANDARD_PROMPT + 파싱 로직, `content.js` verifyReceipt |

---

## 1. 아키텍처 개요

### 선택: Option A — OCR 통합

기존 `STANDARD_PROMPT`에 `영수증여부: 예|아니오` 필드를 추가하고, 1차 OCR 응답에서 즉시 추출해 비영수증이면 반려합니다. **추가 Gemini 호출 없음.**

```
verifyReceipt()
  │
  ├─ [병렬 시작] OCR + Tamper + Hash + EXIF + Noise
  │
  ├─ await ocrPromise
  │     ├─ isReceipt === false → showModal([0단계] 반려)  ◀ NEW
  │     └─ isReceipt === true  → 기존 흐름 유지
  │
  ├─ step1BizNo + step2CardBIN (병렬)
  ├─ step3Tamper
  └─ step4AI
```

---

## 2. 변경 명세

### 2.1 background.js — STANDARD_PROMPT

**응답 형식 변경 (3줄 → 4줄)**:

```
답변은 반드시 아래 형식 네 줄로만:
영수증여부: 예|아니오
사업자번호: XXX-XX-XXXXX
승인번호: XXXXXXXX
카드BIN: XXXXXX
(없으면 해당 항목에 "없음" 기재)
```

**프롬프트 앞에 판별 기준 추가**:
```
0. 이미지가 카드 영수증(POS 영수증, 신용·체크카드 전표, 세금계산서, 배달 영수증)인지 판단
   - 영수증이면 "예", 광고물·사진·스크린샷·문서·명함 등이면 "아니오"
   - 영수증이 부분적으로 보이거나 찍힌 사진도 "예"로 판단
```

### 2.2 background.js — geminiOCRFromDataURL()

1차 응답에서 `영수증여부` 파싱 후 즉시 반환:

```javascript
// 1차 OCR 응답 파싱
const isReceipt = rawText.match(/영수증여부:\s*(예|아니오)/)?.[1] !== '아니오';

// 비영수증이면 재시도 없이 즉시 반환
if (!isReceipt) {
  return { success: true, isReceipt: false, text: '없음', approvalNo: null, cardBIN: null };
}
```

- `영수증여부` 필드가 없거나 파싱 실패 시 → `isReceipt: true` (기본값, 오탐 방어)
- 비영수증이면 STANDARD 재시도, CAREFUL 재시도 모두 스킵

### 2.3 content.js — verifyReceipt()

OCR 결과 수신 직후, step1 이전에 체크:

```javascript
const ocrRaw = await ocrPromise;

// [0단계] 비영수증 이미지 조기 반려
if (ocrRaw?.isReceipt === false) {
  showModal(imgEl, {
    status: 'reject', icon: '🔴', title: '반려',
    reasons: ['[0단계] 영수증 이미지가 아닙니다 — 카드 영수증 이미지를 업로드해 주세요.']
  });
  return;
}
```

---

## 3. 타입 명세

### OCR 응답 객체 (`geminiOCRFromDataURL` 반환값)

```typescript
{
  success: boolean;
  isReceipt: boolean;      // NEW — false이면 비영수증
  text: string;
  approvalNo: string | null;
  cardBIN: string | null;
  error?: string;
}
```

---

## 4. 엣지 케이스

| 케이스 | 처리 |
|--------|------|
| Gemini가 `영수증여부` 필드 누락 | `isReceipt: true` 기본값 → 오탐 없이 통과 |
| 영수증 사진(카메라로 찍은 영수증) | "예" 판단 → 정상 통과 |
| 영수증이 포함된 스크린샷 | "예" 판단 → 정상 통과 |
| 완전히 무관한 이미지(광고·인물사진) | "아니오" → [0단계] 반려 |
| OCR 오류 발생 | 기존 오류 처리 유지 (`NO_GEMINI_KEY` 등) |

---

## 5. 구현 순서

1. `background.js` — `STANDARD_PROMPT` 수정 (판별 기준 + 응답 형식)
2. `background.js` — `geminiOCRFromDataURL()` 파싱 로직 추가
3. `content.js` — `verifyReceipt()` 에 `isReceipt` 체크 추가
