# [Design] tamper-field-detection

> **Feature**: 위변조 편집 위치·유형 분류
> **Date**: 2026-04-22
> **Phase**: Design

---

## Context Anchor

| 항목 | 내용 |
|------|------|
| **WHY** | 거래일시 교체 편집이 승인되는 오류 — 편집 위치·유형 구분 필요 |
| **SCOPE** | background.js TAMPER_PROMPT + parseTamperResult / content.js analyzeImageNoise + step3Tamper |

---

## 1. background.js — TAMPER_PROMPT 수정

### 검토 항목 추가 (기존 6개 → 8개)

```
7. 편집 위치:
   - 흰색 덮어쓰기, 블러, 모자이크, 스티커 등으로 편집된 영역 확인
   - 거래핵심정보(거래일시·결제금액·가맹점명·사업자번호·승인번호) 편집 시 "거래핵심정보"
   - 카드정보(카드번호·소지자명·유효기간·카드사명) 편집 시 "카드정보"
   - 편집 없음 시 "없음"

8. 편집 유형:
   - 기존 내용을 지우고 새로운 텍스트나 값을 덧씌운 경우: "교체"
   - 블러, 모자이크, 검정/흰색으로 단순 가린 경우(새 텍스트 없음): "은닉"
   - 편집 없음: "없음"
```

### 응답 형식 변경 (6줄 → 8줄)

```
위변조_점수: 0-100
판정: 정상|의심|위변조
도용_의심: 예|아니오
AI생성_의심: 예|아니오
다중영수증: 예|아니오
이유: ...
편집부위: 없음|카드정보|거래핵심정보
편집유형: 없음|은닉|교체
```

---

## 2. background.js — parseTamperResult() 수정

```javascript
const editLocation = raw.match(/편집부위:\s*(없음|카드정보|거래핵심정보)/)?.[1] ?? '없음';
const editType     = raw.match(/편집유형:\s*(없음|은닉|교체)/)?.[1] ?? '없음';
// 반환 객체에 editLocation, editType 추가
```

---

## 3. content.js — analyzeImageNoise() 보조 시그니처

기존 `isPaintSuspect` 로직을 유지하면서, 의심 블록의 **밝기 평균**으로 편집 유형 힌트 추가:

```javascript
// 의심 블록 평균 밝기 계산
// 밝기 > 220 이고 분산 ≈ 0 → 흰색 덮어쓰기 → editHint: '교체'
// 그 외 의심 블록 → editHint: '은닉' (블러·모자이크·검정 처리)
// 의심 블록 없음 → editHint: null
return { isPaintSuspect, suspiciousBlocks, ratio, editHint };
```

---

## 4. content.js — step3Tamper() 판정 로직 교체

```javascript
// Gemini 결과 우선 판정
const { editLocation, editType } = tamperResult;

if (editLocation === '거래핵심정보') {
  return reject('[3단계] 위변조 탐지 — 거래 핵심 정보(거래일시·금액 등)가 편집된 흔적이 있습니다.');
}
if (editLocation === '카드정보' && editType === '교체') {
  return reject('[3단계] 위변조 탐지 — 카드 정보가 교체 편집된 흔적이 있습니다.');
}
if (editLocation === '카드정보' && editType === '은닉') {
  // 개인정보 보호 처리 → tamperLevel 판정으로 진행하되 은닉 자체는 반려 사유 아님
  // (단, tamperLevel high/medium이면 다른 위변조 증거로 반려될 수 있음)
}

// editLocation === '없음' → 기존 tamperLevel 판정 유지
// 픽셀 시그니처 보조: editLocation이 없음인데 noiseResult.editHint === '교체'이면
// tamperLevel 상향 시 이 정보를 reason에 포함
```

---

## 5. 타입 명세

### parseTamperResult 반환값 추가

```typescript
editLocation: '없음' | '카드정보' | '거래핵심정보';
editType:     '없음' | '은닉' | '교체';
```

### analyzeImageNoise 반환값 추가

```typescript
editHint: '교체' | '은닉' | null;
```
