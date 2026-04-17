# [Analysis] verification-policy Gap 분석

**Feature:** verification-policy
**Date:** 2026-04-15
**Phase:** Check
**References:**
- Plan: `docs/01-plan/features/verification-policy.plan.md`
- Implementation: `yeoshin-receipt-guard/content.js`

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

## 1. 분석 결과 요약

| 항목 | 결과 |
|------|------|
| **Match Rate** | **100%** |
| 전체 요구사항 항목 | 5개 |
| 구현 완료 | 5개 ✅ |
| Gap (미흡) | 0개 |
| 미구현 | 0개 ❌ |

**판정: ✅ 100% — 완전 구현**

---

## 2. FR 항목별 검증

| FR | 요구사항 | 구현 위치 | 상태 |
|----|----------|-----------|------|
| FR-01 | `bizNumbers.length === 0` → 🟢 통과 | `content.js:428-430` | ✅ |
| FR-02 | 폐업자(`closed`) → 🔴 반려 유지 | `content.js:399-404` | ✅ |
| FR-03 | 휴업자(`suspended`) → 🔴 반려 유지 | `content.js:399-404` | ✅ |
| FR-04 | 국세청미등록(`unregistered`) → 🔴 반려 유지 | `content.js:399-404` | ✅ |
| FR-05 | 계속사업자(`active`) → 🟢 정상 유지 | `content.js:432-444` | ✅ |

---

## 3. 판정 정책표 검증

| OCR 결과 | NTS 결과 | Plan 판정 | 구현 판정 | 상태 |
|----------|----------|-----------|-----------|------|
| 번호 없음 | 호출 안 함 | 🟢 통과 | 🟢 통과 | ✅ |
| 번호 있음 | 계속사업자 | 🟢 정상 | 🟢 정상 | ✅ |
| 번호 있음 | 폐업자 | 🔴 반려 | 🔴 반려 | ✅ |
| 번호 있음 | 휴업자 | 🔴 반려 | 🔴 반려 | ✅ |
| 번호 있음 | 국세청미등록 | 🔴 반려 | 🔴 반려 | ✅ |
| EXIF 위변조 | — | 🔴 반려 | 🔴 반려 | ✅ |
| API 오류 | — | 🟡 주의 | 🟡 주의 | ✅ |

---

## 4. 핵심 코드 증거

```javascript
// content.js:428-430
if (!ocrResult || !ocrResult.text || ocrResult.bizNumbers.length === 0) {
  return { status: 'pass', icon: '🟢', title: '통과', reasons: ['사업자번호 없는 영수증으로 확인됩니다.'] };
}
```

Plan의 "변경 후" 코드와 완전히 일치.

---

## 5. 성공 기준 달성 여부

| 기준 | 상태 |
|------|------|
| 사업자번호 없는 영수증 업로드 시 🟢 통과 표시 | ✅ |
| 폐업자 사업자번호 영수증 → 🔴 반려 정상 동작 | ✅ |
| 계속사업자 영수증 → 🟢 정상 정상 동작 | ✅ |

**결론: `/pdca report verification-policy` 진행 가능**
