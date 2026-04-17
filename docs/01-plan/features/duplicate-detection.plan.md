# [Plan] duplicate-detection

> **Feature**: 중복 영수증 이미지 탐지 (blockhash 기반)
> **Date**: 2026-04-14
> **Phase**: Plan

---

## Executive Summary

| 관점 | 내용 |
|------|------|
| **Problem** | 동일·유사 영수증 이미지를 재업로드하여 중복 정산을 시도해도 현재 탐지 불가 |
| **Solution** | blockhash로 이미지 지문(해시)을 생성·저장하고 검증 시마다 기존 해시와 비교하여 중복 자동 감지 |
| **Functional UX Effect** | 중복 영수증 즉시 🔴 반려 → 운영자 수작업 검토 부담 제거 |
| **Core Value** | PRD 마지막 미구현 항목 완성 — 4대 검증(EXIF·OCR·NTS·중복) 풀 커버리지 달성 |

---

## Context Anchor

| 항목 | 내용 |
|------|------|
| **WHY** | 동일 영수증 재사용을 통한 중복 정산 사기 방지 — PRD 기획 당시부터 필수 기능으로 명시 |
| **WHO** | 여신티켓 어드민 운영자 — 대량 영수증 처리 시 육안 중복 확인 불가 |
| **RISK** | 해시 충돌(서로 다른 이미지가 유사 해시): 임계값 튜닝 필요 / storage 용량 누적 → 1년 TTL 자동 삭제로 대응 |
| **SUCCESS** | 동일 이미지 재검증 시 🔴 반려 / 다른 이미지 정상 통과 / 1년 경과 항목 자동 삭제 |
| **SCOPE** | `content.js` 해시 비교·저장 로직, `background.js` 스토리지 관리 |

---

## 1. 요구사항

| ID | 요구사항 | 우선순위 |
|----|----------|----------|
| FR-01 | 검증 시 blockhash로 16비트 해시 추출 (기존 `extractHash()` 활용) | Must |
| FR-02 | 해시를 타임스탬프와 함께 `chrome.storage.local`에 영구 저장 | Must |
| FR-03 | 저장된 해시 중 Hamming Distance ≤ 임계값인 항목 존재 시 중복으로 판정 | Must |
| FR-04 | 중복 감지 → 🔴 반려 처리, 최초 검증 일시 표시 | Must |
| FR-05 | 저장된 지 1년(365일) 초과 항목 자동 삭제 (검증 시점에 실행) | Must |
| FR-06 | `hashResult`를 `judgeResult()`에 전달하여 판정 반영 | Must |

---

## 2. 기술 설계

### 2.1 Hamming Distance 임계값

| 임계값 | 의미 |
|--------|------|
| 0 | 완전 동일 이미지 |
| 1–5 | JPEG 재압축·리사이즈 등 미세 변형 |
| 6–10 | 밝기·대비 조정 수준 |
| **≤ 10** | **탐지 기준 (권장)** |

16비트 × 16비트 = 256비트 해시 기준. 10 이하면 실질적으로 동일 이미지.

### 2.2 스토리지 구조

```javascript
// chrome.storage.local key: 'receiptHashes'
{
  "receiptHashes": [
    {
      "hash": "a3f1...c2d0",   // blockhash 결과 문자열
      "savedAt": 1713000000000  // Unix timestamp (ms)
    },
    ...
  ]
}
```

### 2.3 처리 흐름

```
검증 시작
  ↓
blockhash 추출 (extractHash) — 기존 병렬 실행에 포함
  ↓
chrome.storage.local에서 'receiptHashes' 로드
  ↓
TTL 정리: savedAt 기준 365일 초과 항목 제거 후 저장
  ↓
Hamming Distance 비교 (모든 저장 해시 vs 현재 해시)
  ↓
Distance ≤ 10 항목 있음? ─ Yes → 중복 감지 → 🔴 반려
                          └ No  → 현재 해시 저장 → 이후 판정 계속
```

### 2.4 Hamming Distance 계산

```javascript
function hammingDistance(hash1, hash2) {
  // blockhash 결과는 16진수 문자열 → 비트 비교
  let dist = 0;
  for (let i = 0; i < hash1.length; i++) {
    const xor = parseInt(hash1[i], 16) ^ parseInt(hash2[i], 16);
    dist += xor.toString(2).split('1').length - 1;
  }
  return dist;
}
```

---

## 3. 범위

### 포함
- `content.js`
  - `hashResult`를 `judgeResult()` 인자로 추가
  - `judgeResult()` 내 중복 판정 로직 추가
  - `verifyReceipt()` 내 해시 비교·저장 함수 호출
- `background.js`
  - `MANAGE_HASHES` 메시지 핸들러: 로드·TTL 정리·저장·비교 처리
  - (chrome.storage는 background에서 처리하여 content script 권한 분리)

### 제외
- blockhash 라이브러리 자체 수정 없음
- 기존 EXIF·OCR·NTS 로직 변경 없음
- 관리자용 해시 목록 UI (향후 검토)

---

## 4. 판정 정책 (judgeResult 통합)

| 조건 | 판정 | 우선순위 |
|------|------|----------|
| EXIF 위변조 | 🔴 반려 | 1 (최우선) |
| **중복 이미지 감지** | 🔴 반려 | 2 |
| NTS 폐업/휴업/미등록 | 🔴 반려 | 3 |
| 사업자번호 없음 | 🟢 통과 | 4 |
| NTS 계속사업자 | 🟢 정상 | 5 |
| API 오류 | 🟡 주의 | — |

---

## 5. 리스크

| 리스크 | 영향도 | 대응 |
|--------|--------|------|
| 해시 추출 실패 (Canvas CORS) | 중간 | 실패 시 중복 검사 건너뜀 — 다른 검증은 계속 |
| 임계값 오탐 (다른 이미지 반려) | 중간 | 임계값 10으로 보수적 설정, 추후 조정 가능하도록 상수화 |
| storage 용량 초과 | 낮음 | 1년 TTL 자동 삭제, 항목당 ~100B × 10만건 = ~10MB |

---

## 6. 성공 기준

- [ ] 동일 이미지 2회 검증 시 2번째에서 🔴 반려 + "이전 검증 일시" 표시
- [ ] JPEG 재압축 이미지도 중복 감지 (Distance ≤ 10)
- [ ] 서로 다른 영수증은 정상 통과
- [ ] 1년 경과 해시 자동 삭제 확인

---

## 7. 구현 순서

1. `background.js` — `MANAGE_HASHES` 메시지 핸들러 (로드·TTL·저장·비교)
2. `content.js` — `judgeResult()`에 `hashResult` 인자 추가 + 중복 판정 로직
3. `content.js` — `verifyReceipt()`에서 해시 비교·저장 호출 및 결과 전달
