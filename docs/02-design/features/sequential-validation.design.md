# [Design] sequential-validation

> **Feature**: 영수증 검증 순차 실행 흐름 구현
> **Date**: 2026-04-22
> **Architecture**: Option B — 단계별 함수 분리
> **Phase**: Design

---

## Context Anchor

| 항목 | 내용 |
|------|------|
| **WHY** | 병렬 실행 구조에서는 반려 우선순위가 코드 로직에 숨어있어 운영자가 실제 반려 원인을 파악하기 어려움 |
| **WHO** | 여신티켓 어드민 운영자 — 영수증 검수 판단을 빠르고 명확하게 처리해야 하는 실무자 |
| **RISK** | OCR 단계에서 정보 추출 실패 시 이후 단계 검증 정확도 저하 가능 |
| **SUCCESS** | 각 단계 실패 시 해당 단계 사유가 포함된 알림이 즉시 노출되고, 4단계 모두 통과 시 최종 승인 판정 |
| **SCOPE** | `content.js` verifyReceipt() 재작성 + step1~4 함수 추가, `background.js` verifyCardBIN() 로컬 BIN 조회 추가 |

---

## 1. 개요

### 1.1 현재 구조 (병렬)
```
verifyReceipt()
  └─ Promise.all([EXIF, Hash, OCR, Tamper, Noise])  ← 모두 병렬
       └─ judgeResult(exif, ocr, api, hash, tamper, bin)  ← 우선순위 코드로 판정
```

### 1.2 변경 후 구조 (순차 — Option B)
```
verifyReceipt()  ← 오케스트레이터
  ├─ runOCR()          ← 사전 준비 (1회만 실행)
  ├─ step1BizNo()      ← 1단계: NTS API
  ├─ step2CardBIN()    ← 2단계: BIN 검증 (로컬 우선)
  ├─ step3Tamper()     ← 3단계: EXIF + 픽셀 + 중복 + Gemini
  └─ step4AI()         ← 4단계: AI 생성 탐지 (Gemini 재사용)
```

### 1.3 핵심 설계 원칙
- 각 step 함수는 `{ pass: boolean, verdict?: VerdictObject }` 반환
- `pass: false` → `showModal()` 호출 후 즉시 `return` (이후 단계 스킵)
- OCR은 `verifyReceipt()` 진입 시 1회 실행, 모든 단계에서 결과 공유
- Gemini 위변조 분석(step3)의 응답 객체를 step4에 전달 (추가 API 호출 없음)

---

## 2. 데이터 타입

```javascript
// 모든 step 함수의 반환 타입
// pass: true  → 다음 단계 진행
// pass: false → verdict를 showModal()에 전달 후 중단
type StepResult = {
  pass: boolean,
  verdict?: {         // pass: false일 때만 존재
    status: 'reject',
    icon: '🔴',
    title: '반려',
    reasons: string[]  // [0]: "[N단계] ..." 형식으로 단계 번호 포함
  },
  tamperResult?: object  // step3에서만: step4 전달용
}
```

---

## 3. 함수별 상세 설계

### 3.1 `step1BizNo(bizNo)` — content.js

```
입력: bizNo (string | null)  — OCR 추출 사업자번호, 없으면 null
출력: StepResult

흐름:
  1. bizNo가 null/없음 → { pass: true }  (1단계 스킵, 2단계 진행)
  2. verifyBusinessNumber(bizNo) 호출 (background.js 위임)
  3. apiResult.status === 'active' → { pass: true }
  4. 그 외(closed/suspended/unregistered/API 오류) → {
       pass: false,
       verdict: {
         status: 'reject', icon: '🔴', title: '반려',
         reasons: ['[1단계] 사업자 검증 실패 — 사업자 상태: {statusText}', ...]
       }
     }

엣지 케이스:
  - API 오류(timeout/네트워크) → pass: false, reasons에 '[1단계] 국세청 API 오류: ...'
  - NO_API_KEY → pass: false, reasons에 '[1단계] API Key 미설정 — 옵션에서 설정해 주세요'
```

### 3.2 `step2CardBIN(bin)` — content.js

```
입력: bin (string | null)  — OCR 추출 카드BIN 6자리, 없으면 null
출력: StepResult

흐름:
  1. bin이 null/없음 → { pass: true }  (2단계 스킵, 3단계 진행)
  2. checkCardBIN(bin) 호출 (background.js 위임)
  3. result.valid === true 또는 result.skip === true → { pass: true }
  4. result.valid === false → {
       pass: false,
       verdict: {
         status: 'reject', icon: '🔴', title: '반려',
         reasons: ['[2단계] 카드번호 검증 실패 — {reason} (BIN: {bin})']
       }
     }
```

### 3.3 `step3Tamper(imgEl, dataURL, hashInfo)` — content.js

```
입력:
  imgEl: HTMLImageElement
  dataURL: string
  hashInfo: { hash: string|null, approvalNo: string|null }

출력: StepResult + tamperResult (step4 전달용)

흐름 (순차):
  1. analyzeEXIF(imgEl)
     - isTampered: true → pass: false, reasons: ['[3단계] 위변조 탐지 — 이미지 편집 흔적: {software}']

  2. analyzeImageNoise(dataURL)  ← 픽셀 수준 그림판 탐지
     - isPaintSuspect: true → tamperLevel 격상 플래그 설정 (단독으로 반려하지 않음, Gemini 결과와 합산)

  3. compareHash(hashInfo.hash, hashInfo.approvalNo)
     - isDuplicate: true → pass: false, reasons: ['[3단계] 위변조 탐지 — 중복 영수증 (이전: {date})']

  4. analyzeTamper(dataURL)  ← Gemini 위변조 분석
     - 픽셀 노이즈 isPaintSuspect 반영 (tamperLevel 격상 로직 기존과 동일)
     - tamperLevel === 'high' → pass: false
     - tamperLevel === 'medium' → pass: false  (🔴 반려)
     - tamperLevel === 'low' → 계속 진행

  5. 모두 통과 → { pass: true, tamperResult }  (tamperResult는 step4에 전달)

반려 시 verdict.reasons 예시:
  - '[3단계] 위변조 탐지 — {tamper.reason} (신뢰도: {score}점/100)'
```

### 3.4 `step4AI(tamperResult)` — content.js

```
입력: tamperResult (step3의 Gemini 응답 파싱 결과)
출력: StepResult

흐름:
  1. tamperResult.isSuspectedAI === true →
     pass: false,
     verdict: {
       status: 'reject', icon: '🔴', title: '반려',
       reasons: ['[4단계] AI 생성 이미지 탐지 — 생성형 AI로 만든 영수증으로 의심됩니다']
     }
  2. isSuspectedAI === false → { pass: true }
  3. tamperResult가 없거나 unknown → { pass: true }  (탐지 불확실, 통과)
```

---

## 4. `verifyReceipt()` 오케스트레이터 재설계 — content.js

```javascript
async function verifyReceipt(imgEl, button) {
  // API Key 사전 확인
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) { /* 기존과 동일한 미설정 알림 */ return; }

  showSpinner(button);

  try {
    // 사전 준비: 이미지 dataURL 취득
    const dataURL = await getImageDataURL(imgEl).catch(...);
    if (!dataURL) throw new Error('이미지를 불러올 수 없습니다.');

    // OCR 1회 실행 (전 단계 공유)
    const ocrRaw = await runOCR(dataURL).catch(e => {
      if (e.message === 'NO_GEMINI_KEY') throw e;
      return null;
    });
    const bizNo    = extractBizNoFromOCR(ocrRaw);
    const cardBIN  = ocrRaw?.cardBIN  || null;
    const approvalNo = ocrRaw?.approvalNo || null;

    // 해시 추출 (step3에서 사용)
    const hashResult = await extractHash(imgEl).catch(() => ({ hash: null }));
    const hashInfo = { hash: hashResult.hash, approvalNo };

    // ── 1단계 ─────────────────────────────────────────────
    const r1 = await step1BizNo(bizNo);
    if (!r1.pass) { showModal(imgEl, r1.verdict); return; }

    // ── 2단계 ─────────────────────────────────────────────
    const r2 = await step2CardBIN(cardBIN);
    if (!r2.pass) { showModal(imgEl, r2.verdict); return; }

    // ── 3단계 ─────────────────────────────────────────────
    const r3 = await step3Tamper(imgEl, dataURL, hashInfo);
    if (!r3.pass) { showModal(imgEl, r3.verdict); return; }

    // ── 4단계 ─────────────────────────────────────────────
    const r4 = step4AI(r3.tamperResult);
    if (!r4.pass) { showModal(imgEl, r4.verdict); return; }

    // ── 최종 승인 ──────────────────────────────────────────
    const confirmData = (hashResult.hash || approvalNo)
      ? { hash: hashResult.hash, approvalNo }
      : null;
    showModal(imgEl, {
      status: 'pass', icon: '🟢', title: '최종 승인',
      reasons: buildApprovalReasons(bizNo, cardBIN, ocrRaw)
    }, confirmData);

  } catch (err) {
    // 기존 에러 처리 유지 (NO_GEMINI_KEY 등)
  } finally {
    hideSpinner(button);
  }
}
```

---

## 5. `verifyCardBIN()` 로컬 BIN 조회 추가 — background.js

### 5.1 로컬 BIN 데이터 구조
```
bin-korea.json:   { "423456": { "i": "신한카드", "br": "로컬", "t": "신용", "p": "개인" }, ... }
bin-intl-ranges.json: [{ "s": "341142", "e": "341199", "sc": "amex", "c": "US", "b": "AMEX" }, ...]
```

### 5.2 변경 로직
```javascript
// 모듈 레벨 캐시 (서비스워커 재시작 시 재로드, 정상 동작)
let _binKorea = null;
let _binIntl = null;

async function loadBinData() {
  if (!_binKorea) {
    const r = await fetch(chrome.runtime.getURL('lib/bin-korea.json'));
    _binKorea = await r.json();
  }
  if (!_binIntl) {
    const r = await fetch(chrome.runtime.getURL('lib/bin-intl-ranges.json'));
    _binIntl = await r.json();
  }
}

async function verifyCardBIN(bin) {
  if (!bin || !/^\d{6}$/.test(bin)) return { valid: true, skip: true };

  await loadBinData();

  // 1. 국내 BIN 직접 조회
  if (_binKorea[bin]) {
    const d = _binKorea[bin];
    return { valid: true, bin, issuer: d.i, type: d.t, source: 'local-korea' };
  }

  // 2. 국제 BIN 범위 조회
  const binNum = parseInt(bin, 10);
  const intlMatch = _binIntl.find(r => binNum >= parseInt(r.s) && binNum <= parseInt(r.e));
  if (intlMatch) {
    return { valid: true, bin, issuer: intlMatch.b, scheme: intlMatch.sc, source: 'local-intl' };
  }

  // 3. Fallback: binlist.net API
  // ... (기존 코드 유지)
}
```

---

## 6. 제거 대상

| 항목 | 위치 | 이유 |
|------|------|------|
| `judgeResult()` 함수 | content.js:467 | 순차 step 함수들로 완전 대체 |
| `Promise.all([exif, hash, ocr, tamper, noise])` | content.js:601 | 순차 실행으로 변경 |
| 병렬 `apiResult`, `binResult` 블록 | content.js:639 | step1, step2로 이동 |

---

## 7. 영향 없는 항목

| 항목 | 이유 |
|------|------|
| `showModal()`, `showSpinner()`, `hideSpinner()` | UI 함수 변경 없음 |
| `analyzeEXIF()`, `analyzeImageNoise()`, `extractHash()` | 헬퍼 함수 유지 |
| `analyzeTamper()`, `runOCR()`, `checkCardBIN()` | 래퍼 함수 시그니처 변경 없음 |
| `background.js` 메시지 핸들러 | verifyCardBIN 내부만 변경 |
| `manifest.json`, `styles.css`, `options.js` | 변경 없음 |

---

## 8. 테스트 시나리오

| # | 시나리오 | 기대 결과 |
|---|----------|-----------|
| T1 | 폐업자 사업자번호 영수증 | [1단계] 반려 모달, 2~4단계 미실행 |
| T2 | 사업자번호 없는 현금영수증 | 1단계 스킵 → 2단계 진행 |
| T3 | 유효하지 않은 BIN | [2단계] 반려 모달, 3~4단계 미실행 |
| T4 | BIN 없는 영수증 | 2단계 스킵 → 3단계 진행 |
| T5 | EXIF 편집 도구 감지 | [3단계] 반려 모달, 4단계 미실행 |
| T6 | 중복 영수증 | [3단계] 반려 모달, 4단계 미실행 |
| T7 | Gemini 위변조 high | [3단계] 반려 모달, 4단계 미실행 |
| T8 | AI 생성 이미지 | [4단계] 반려 모달 |
| T9 | 모든 단계 통과 | 최종 승인 모달 |
| T10 | 국내 BIN (bin-korea.json) | 로컬 매칭 성공, binlist.net 미호출 |
| T11 | 국제 BIN (bin-intl-ranges.json) | 범위 매칭 성공, binlist.net 미호출 |

---

## 9. 파일 변경 요약

| 파일 | 변경 유형 | 변경 내용 |
|------|-----------|-----------|
| `content.js` | 수정 | verifyReceipt() 재작성, step1~4 추가, judgeResult() 제거 |
| `background.js` | 수정 | verifyCardBIN() 로컬 BIN 조회 로직 추가, 캐시 변수 추가 |

---

## 10. 구현 예상 규모

| 항목 | 수치 |
|------|------|
| 수정 파일 | 2개 |
| 추가 함수 | 4개 (step1~4) + buildApprovalReasons() + loadBinData() |
| 제거 함수 | 1개 (judgeResult) |
| 예상 변경 라인 | ~120줄 (content.js) + ~40줄 (background.js) |

---

## 11. 구현 가이드

### 11.1 구현 순서

1. **background.js** — `verifyCardBIN()` 로컬 BIN 조회 추가 (캐시 변수 + loadBinData + 로컬 조회 로직)
2. **content.js** — `step1BizNo()` 작성
3. **content.js** — `step2CardBIN()` 작성
4. **content.js** — `step3Tamper()` 작성 (EXIF + 노이즈 + 중복 + Gemini 순서)
5. **content.js** — `step4AI()` 작성
6. **content.js** — `verifyReceipt()` 오케스트레이터로 재작성
7. **content.js** — `judgeResult()` 제거

### 11.2 주의 사항

- `step3Tamper()`에서 픽셀 노이즈(`isPaintSuspect`)는 단독 반려 트리거가 아니라 Gemini tamperLevel 격상 로직에만 사용 (기존 동작 유지)
- `step4AI()`의 입력 `tamperResult`가 `null`/`unknown`이면 통과 처리 (Gemini 오류 시 AI 탐지 실패로 반려하지 않음)
- `verifyCardBIN()`의 binlist.net fallback은 로컬 데이터에 없을 때만 실행

### 11.3 Session Guide

| 모듈 | 파일 | 함수 | 예상 시간 |
|------|------|------|-----------|
| module-1 | background.js | verifyCardBIN() 로컬 BIN 추가 | 15분 |
| module-2 | content.js | step1BizNo(), step2CardBIN() | 15분 |
| module-3 | content.js | step3Tamper(), step4AI() | 20분 |
| module-4 | content.js | verifyReceipt() 재작성 + judgeResult() 제거 | 20분 |
