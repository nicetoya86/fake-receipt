# [Plan] gemini-ocr-migration

> **Feature**: OCR 방식을 Gemini Vision API 단일 방식으로 전환 + 저해상도 정확도 강화
> **Date**: 2026-04-09 (Updated: 2026-04-14)
> **Phase**: Plan (v2 — OCR 정확도 개선 반영)

---

## Executive Summary

| 관점 | 내용 |
|------|------|
| **Problem** | Tesseract.js 복잡한 인프라 + 저해상도 영수증 OCR 실패 / 사업자번호 오독 문제 |
| **Solution** | Gemini Vision API 단일 엔진 + 체크섬 검증 기반 자동수정으로 저해상도·회전·노이즈 이미지 처리 |
| **Functional UX Effect** | Tesseract 폴백 대기 제거로 검증 속도 향상; 저해상도 영수증에서도 정확한 번호 추출 |
| **Core Value** | 코드 단순화 + OCR 정확도 향상 + 국세청 API 불필요한 중복 호출 제거 |

---

## Context Anchor

| 항목 | 내용 |
|------|------|
| **WHY** | Tesseract 이중 구조 복잡도 대비 정확도 낮음 + 저해상도 열인쇄 영수증에서 1↔4 등 숫자 오독 발생 |
| **WHO** | 여신티켓 어드민 운영자 — 영수증을 빠르고 정확하게 검증해야 하는 실무 사용자 |
| **RISK** | Gemini API Key 필수화; API 비용; 저해상도 이미지에서 드물게 자동수정 오판 가능 |
| **SUCCESS** | 사업자번호 추출 성공률 ≥ 99%; 체크섬 통과율 ≥ 95%; 국세청 API 1회 호출 보장 |
| **SCOPE** | background.js 전면 교체 (OCR 파이프라인 + 체크섬 자동수정), offscreen/Tesseract 제거 |

---

## 1. 요구사항

### 1.1 기능 요구사항 (v1 — 초기 마이그레이션)

| ID | 요구사항 | 우선순위 | 상태 |
|----|----------|----------|------|
| FR-01 | `RUN_OCR` 메시지 처리를 Gemini Vision API 직접 호출로 교체 | Must | ✅ 완료 |
| FR-02 | Gemini API Key를 필수 설정으로 격상 | Must | ✅ 완료 |
| FR-03 | content.js의 이중 OCR 경로를 단일 경로로 통합 | Must | ✅ 완료 |
| FR-04 | offscreen.js, offscreen.html 파일 제거 | Must | ✅ 완료 |
| FR-05 | Tesseract 관련 파일 전체 삭제 | Must | ✅ 완료 |
| FR-06 | manifest.json에서 offscreen 권한 및 Tesseract 리소스 제거 | Must | ✅ 완료 |
| FR-07 | Gemini 프롬프트: 사업자번호만 추출 ("XXX-XX-XXXXX 형식으로만 답변") | Must | ✅ 완료 |
| FR-08 | options.html/js에서 Gemini API Key를 필수 항목으로 UI 안내 | Should | ✅ 완료 |

### 1.2 기능 요구사항 (v2 — OCR 정확도 개선, 2026-04-14)

| ID | 요구사항 | 우선순위 | 상태 |
|----|----------|----------|------|
| FR-09 | `thinkingConfig` 필드를 `generationConfig` 내부로 이동 (API 400 오류 수정) | Must | ✅ 완료 |
| FR-10 | OCR 프롬프트 강화: 전화번호 구분, 기울어진 이미지, 카드사 번호 혼동 방지 | Must | ✅ 완료 |
| FR-11 | Gemini 응답에서 레이블 제거 (`extractBizNoText`): `XXX-XX-XXXXX` 패턴만 추출 | Must | ✅ 완료 |
| FR-12 | 사업자등록번호 체크섬 검증 (`validateKoreanBizNo`): 가중치 [1,3,7,1,3,7,1,3,5] | Must | ✅ 완료 |
| FR-13 | 체크섬 실패 시 시각 유사 자동수정 (STAGE1: 1↔4, STAGE2: 확장 혼동 집합) | Must | ✅ 완료 |
| FR-14 | "없음" 반환 시 STANDARD → STANDARD → CAREFUL 순서로 최대 2회 재시도 | Must | ✅ 완료 |
| FR-15 | 후보 다수 시 NTS 추가 호출 없이 우선순위 기반 선택 (4→1 우선) | Must | ✅ 완료 |

### 1.3 비기능 요구사항

| ID | 요구사항 | 상태 |
|----|----------|------|
| NFR-01 | Gemini 응답 타임아웃: 30초 | ✅ |
| NFR-02 | 국세청 API 타임아웃: 10초 | ✅ |
| NFR-03 | 국세청 API는 최종 검증에서만 1회 호출 (OCR 과정에서 추가 호출 없음) | ✅ |
| NFR-04 | temperature: 0, maxOutputTokens: 1024 (thinking 활성화) | ✅ |

---

## 2. 범위 (Scope)

### 포함

- `background.js` — OCR 파이프라인 전면 교체 + 체크섬 자동수정 로직
- `content.js` — 이중 OCR 경로 단일화
- `manifest.json` — offscreen 권한·리소스 제거
- `options.html` / `options.js` — Gemini Key 필수 UI
- 파일 삭제: `offscreen.js`, `offscreen.html`, Tesseract lib/lang 파일 전체

### 제외

- EXIF 분석 로직 (변경 없음)
- 국세청 API 검증 로직 (변경 없음)
- blockhash 이미지 해시 (변경 없음)
- UI 모달·버튼 스타일 (변경 없음)

---

## 3. 아키텍처

### OCR 파이프라인 (v2)

```
content.js
  └── runOCR() ──→ [RUN_OCR] ──→ background.js
                                   └── geminiOCRFromDataURL()
                                         ├── 1차: STANDARD_PROMPT
                                         ├── "없음" → STANDARD 재시도
                                         ├── "없음" → CAREFUL 재시도
                                         └── 체크섬 검증
                                               ├── STAGE1: 1↔4 (유일 후보 → 자동수정)
                                               ├── STAGE2: 확장 혼동 (유일 후보 → 자동수정)
                                               └── 다수 후보 → 4→1 우선 선택
```

### 체크섬 자동수정 흐름

```
OCR 추출 → 체크섬 검증
  ✓ 통과 → 반환
  ✗ 실패
    ├── STAGE1(1↔4) 유일 후보 → 자동수정 반환
    ├── STAGE2(확장) 유일 후보 → 자동수정 반환
    └── 다수 후보 → 4→1 치환 우선, 없으면 첫 번째
```

---

## 4. 핵심 구현 상세

### 4.1 체크섬 알고리즘 (`validateKoreanBizNo`)

```
가중치: [1, 3, 7, 1, 3, 7, 1, 3, 5]
sum = Σ(digit[i] × weight[i]) + floor(digit[8] × 5 / 10)
check = (10 - sum % 10) % 10
유효: check === digit[9]
```

### 4.2 시각 유사 혼동 집합

| Stage | 혼동 쌍 | 적용 조건 |
|-------|---------|-----------|
| STAGE1 | `1↔4` | 항상 먼저 시도 (후보 최소화) |
| STAGE2 | `0↔6,1`, `1↔4,7`, `3↔8`, `4↔1,7`, `5↔6`, `6↔0,5`, `7↔1,4`, `8↔3,6,9`, `9↔8` | STAGE1 실패 시 |

### 4.3 Gemini 설정

```javascript
GEMINI_MODEL = 'gemini-2.5-flash'
generationConfig = { temperature: 0, maxOutputTokens: 1024 }
// thinking 활성화 (thinkingConfig 미지정 = 모델 기본값)
```

---

## 5. 리스크

| 리스크 | 영향도 | 대응 |
|--------|--------|------|
| Gemini API 네트워크 장애 | 높음 | 오류 메시지로 육안 확인 안내 |
| API Key 미설정 사용자 | 중간 | 설정 화면으로 즉시 유도 |
| 다수 후보에서 우선순위 오판 | 낮음 | STANDARD 재시도로 대부분 해결 (발생 확률 ~11% × α) |
| 국세청 API 타임아웃 | 중간 | OCR 단계에서 NTS 미호출로 원인 제거 |

---

## 6. 성공 기준

- [x] Tesseract 관련 코드·파일이 저장소에 남아있지 않음
- [x] `manifest.json`에 `offscreen` 권한 없음
- [x] Gemini API Key 미설정 시 🟡 주의 즉시 표시
- [x] 정상 영수증에서 사업자번호 추출 성공
- [x] 저해상도 영수증에서 1↔4 오독 자동수정
- [x] 체크섬 검증으로 오추출 방지
- [x] 국세청 API는 최종 검증 시 1회만 호출

---

## 7. 구현 순서

1. **background.js** — OCR 로직 교체 (핵심) ✅
2. **manifest.json** — 권한·리소스 정리 ✅
3. **content.js** — 이중 경로 제거 ✅
4. **options.html/js** — Gemini Key 필수 UI ✅
5. **파일 삭제** — offscreen.js/html, Tesseract lib/lang ✅
6. **OCR 정확도 개선** — 체크섬·재시도·자동수정 ✅ (2026-04-14)
