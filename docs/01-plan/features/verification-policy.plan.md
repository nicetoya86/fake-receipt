# [Plan] verification-policy

> **Feature**: 영수증 검증 결과 판정 정책 수정
> **Date**: 2026-04-14
> **Phase**: Plan

---

## Executive Summary

| 관점 | 내용 |
|------|------|
| **Problem** | 사업자번호 없는 정상 영수증(현금영수증·간이영수증 등)이 업로드될 때 🟡 주의로 표시되어 불필요한 혼란 발생 |
| **Solution** | OCR로 사업자번호를 찾지 못한 경우 통과 처리 — 실제 위험 신호(폐업·미등록)가 있을 때만 반려 |
| **Functional UX Effect** | 사업자번호 없는 영수증에 대한 오탐(false positive) 제거로 운영자 검증 부담 감소 |
| **Core Value** | 실질적 위험(운영 불가 사업자)만 차단하고 불필요한 주의·보류 최소화 |

---

## Context Anchor

| 항목 | 내용 |
|------|------|
| **WHY** | 간이영수증·현금영수증 등 사업자번호 없는 정상 문서가 🟡 주의로 처리되는 오탐 문제 |
| **WHO** | 여신티켓 어드민 운영자 — 영수증 검증 결과를 빠르게 판단해야 하는 실무자 |
| **RISK** | OCR 오류로 번호를 못 읽은 경우도 통과되므로, EXIF 위변조 감지가 더 중요해짐 |
| **SUCCESS** | 사업자번호 없는 영수증 → 🟢 통과 / 폐업·휴업·미등록 → 🔴 반려 정상 동작 |
| **SCOPE** | `content.js`의 `judgeResult()` 함수 판정 로직 수정만 |

---

## 1. 요구사항

| ID | 요구사항 | 우선순위 |
|----|----------|----------|
| FR-01 | OCR 결과 사업자번호 없음(`bizNumbers.length === 0`) → 🟢 통과 처리 | Must |
| FR-02 | 폐업자(`closed`) → 🔴 반려 유지 | Must |
| FR-03 | 휴업자(`suspended`) → 🔴 반려 유지 | Must |
| FR-04 | 국세청미등록(`unregistered`) → 🔴 반려 유지 | Must |
| FR-05 | 계속사업자(`active`) → 🟢 정상 유지 | Must |

---

## 2. 판정 정책표

| OCR 결과 | NTS 결과 | 판정 | 변경 |
|----------|----------|------|------|
| 번호 없음 | 호출 안 함 | 🟢 통과 | **변경** (기존: 🟡 주의) |
| 번호 있음 | 계속사업자 | 🟢 정상 | 유지 |
| 번호 있음 | 폐업자 | 🔴 반려 | 유지 |
| 번호 있음 | 휴업자 | 🔴 반려 | 유지 |
| 번호 있음 | 국세청미등록 | 🔴 반려 | 유지 |
| EXIF 위변조 | — | 🔴 반려 | 유지 |
| API 오류 | — | 🟡 주의 | 유지 |

---

## 3. 범위

### 포함
- `content.js` — `judgeResult()` 함수의 `bizNumbers.length === 0` 분기 수정

### 제외
- `background.js` (변경 없음)
- `manifest.json` (변경 없음)
- NTS API 호출 로직 (변경 없음)
- UI 스타일 (변경 없음)

---

## 4. 구현 상세

### 변경 위치: `content.js:359`

```javascript
// 변경 전
if (!ocrResult || !ocrResult.text || ocrResult.bizNumbers.length === 0) {
  return { status: 'caution', icon: '🟡', title: '주의', reasons: [...] };
}

// 변경 후
if (!ocrResult || !ocrResult.text || ocrResult.bizNumbers.length === 0) {
  return { status: 'pass', icon: '🟢', title: '통과', reasons: ['사업자번호 없는 영수증으로 확인됩니다.'] };
}
```

---

## 5. 성공 기준

- [ ] 사업자번호 없는 영수증 업로드 시 🟢 통과 표시
- [ ] 폐업자 사업자번호 영수증 → 🔴 반려 정상 동작
- [ ] 계속사업자 영수증 → 🟢 정상 정상 동작
