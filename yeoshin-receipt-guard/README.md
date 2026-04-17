# Yeoshin Receipt Guard — 여신티켓 영수증 가드

영수증 이미지를 클릭 한 번으로 자동 검증하는 크롬 확장 프로그램입니다.

## 사용 전 준비 (필수)

### 1단계: 라이브러리 파일 다운로드

`download-libs.bat` 더블클릭으로 자동 다운로드 (curl 필요, Windows 10 이상 기본 내장).

수동으로 받을 경우 아래 URL을 사용하세요.

**Tesseract.js v4.1.4 (OCR)** — jsDelivr 확인 완료
- `lib/tesseract.min.js` → https://cdn.jsdelivr.net/npm/tesseract.js@4.1.4/dist/tesseract.min.js
- `lib/tesseract-worker.min.js` → https://cdn.jsdelivr.net/npm/tesseract.js@4.1.4/dist/worker.min.js

**exif-js v2.3.0 (EXIF 메타데이터)** — jsDelivr 확인 완료
- `lib/exif.js` → https://cdn.jsdelivr.net/npm/exif-js@2.3.0/exif.js

**blockhash (이미지 해시)** — 다운로드 불필요
- `lib/blockhash.js` → 이미 내장 (브라우저 호환 버전 직접 구현)
  - npm 공식 패키지는 Node.js 전용으로 브라우저에서 동작하지 않음
  - Canvas API 기반으로 재구현하여 `lib/blockhash.js`에 포함됨

### 2단계: 한국어 OCR 학습 데이터 다운로드

`lang/` 폴더에 아래 파일을 다운로드합니다 (`download-libs.bat`에 포함).

- `lang/kor.traineddata.gz` → https://tessdata.projectnaptha.com/4.0.0/kor.traineddata.gz

> 파일 크기 약 10MB. `download-libs.bat` 실행 시 자동 다운로드됩니다.

### 3단계: 아이콘 파일 준비

`icons/` 폴더에 PNG 이미지를 준비합니다:
- `icons/icon16.png` (16×16px)
- `icons/icon48.png` (48×48px)
- `icons/icon128.png` (128×128px)

> 임시 아이콘이 필요하면 단색 PNG를 사용해도 됩니다.

---

## 크롬 업로드 방법

1. Chrome 주소창에 `chrome://extensions/` 입력
2. 우측 상단 **개발자 모드** 토글 ON
3. **압축 해제된 확장 프로그램 로드** 클릭
4. `yeoshin-receipt-guard` **폴더 전체** 선택
5. 확장 프로그램 목록에 "Yeoshin Receipt Guard" 표시 확인

---

## API Key 설정

1. 확장 프로그램 아이콘 우클릭 → **옵션** 클릭
2. 공공데이터포털에서 발급받은 API Key 입력 후 **저장**

### API Key 발급 방법
1. [공공데이터포털](https://www.data.go.kr) 회원가입/로그인
2. "국세청_사업자등록정보 진위확인" 검색
3. "활용신청" 후 승인 대기
4. 마이페이지 → 개발계정 → 일반 인증키 복사

---

## 사용 방법

1. 어드민 페이지에서 영수증 이미지를 확인합니다
2. 이미지 우측 상단의 **🔍 영수증 검증** 버튼을 클릭합니다
3. 로딩 후 결과 모달이 표시됩니다:
   - 🟢 **정상**: EXIF 조작 없음 + 계속사업자
   - 🟡 **주의**: OCR 실패 또는 사업자번호 인식 불가
   - 🔴 **반려**: 위변조 감지 또는 폐업/미등록 사업자

---

## 파일 구조

```
yeoshin-receipt-guard/
├── manifest.json
├── content.js          ← DOM 주입, OCR, EXIF, 결과 UI
├── background.js       ← Service Worker, 국세청 API 통신
├── options.html        ← API Key 설정 페이지
├── options.js
├── styles.css
├── lib/                ← 다운로드 필요
│   ├── tesseract.min.js
│   ├── tesseract-worker.min.js
│   ├── exif.js
│   └── blockhash.js
├── lang/               ← 다운로드 필요
│   └── kor.traineddata.gz
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```
