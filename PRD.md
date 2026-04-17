# [PRD] 여신티켓 어드민 영수증 검증 크롬 확장 프로그램 (Vibe-Coding 용)

**@AI (Claude/Cursor) 에게 지시하는 프롬프트:**
> "너는 지금부터 20년 차 시니어 크롬 확장 프로그램 개발자야. 아래의 PRD를 완벽하게 숙지하고, 서버(백엔드) 구축 없이 오직 프론트엔드 환경(Vanilla JavaScript)에서 동작하는 크롬 확장 프로그램 코드를 작성해 줘. 코드를 바로 짜지 말고, 먼저 구현 계획과 파일 구조를 나에게 브리핑해 줘."

---

## 1. 프로젝트 개요 (Overview)
* **프로젝트명:** Yeoshin-Receipt-Guard (여신티켓 영수증 가드)
* **목표:** 사내 어드민 페이지에 등록된 영수증 이미지(img 태그)를 클릭 한 번으로 자동 검증하는 크롬 확장 프로그램 개발.
* **작동 환경:** Chrome Browser (Manifest V3 규격 필수 적용)
* **개발 제약사항 (가장 중요):** React, Vue, Node.js 등 복잡한 프레임워크나 빌드 도구(Webpack 등)를 절대 사용하지 않는다. 오직 순수 **Vanilla JS, HTML, CSS**로만 구성하여 비개발자가 폴더째로 크롬에 업로드해서 바로 테스트하고 사용할 수 있게 만든다.

## 2. 핵심 기술 스택 (무료/오픈소스 CDN 활용)
다음의 라이브러리들을 `content.js` 또는 `background.js`에서 CDN을 통해 로드하거나 모듈로 포함하여 사용한다.
1. **[OCR 텍스트 추출]:** `Tesseract.js` (한국어 `kor` 모델 필수 사용)
2. **[이미지 위변조 탐지]:** `exif-js` (이미지 메타데이터 내 'Photoshop', 'Software' 등 편집 프로그램 흔적 식별)
3. **[중복 이미지 탐지]:** `blockhash-js` (이미지를 pHash 값으로 변환하여 유사도 비교)
4. **[사업자 진위 검증]:** 공공데이터포털 '국세청_사업자등록정보 진위확인 API' (Fetch API 활용)

## 3. 파일 구조 (Architecture)
* `manifest.json`: Manifest V3 규격. 권한(`activeTab`, `scripting`, `storage`, API 호출을 위한 `host_permissions`) 설정.
* `content.js`: 사내 어드민 DOM에 접근하여 영수증 이미지 태그 옆에 [🔍 자동 검증] 버튼을 띄우고, 결과를 팝업(모달)으로 보여주는 UI 담당. (Tesseract.js, exif-js, blockhash-js 실행)
* `background.js`: Service Worker로 동작. `content.js`의 요청을 받아 CORS 에러를 우회하여 국세청 API 통신(Fetch)을 전담.
* `options.html` & `options.js`: 사용자가 '국세청 API Key'를 입력하고 로컬 저장소(`chrome.storage.local`)에 안전하게 저장하는 설정 페이지 UI.
* `styles.css`: 주입되는 버튼과 결과 모달 창의 깔끔한 디자인 담당.

## 4. 기능 작동 프로세스 (User Flow & Logic)

**Step 1. UI 주입 및 실행 대기 (`content.js`)**
* 페이지가 로드되면 화면 내의 영수증 이미지(`<img>` 태그)를 찾아 우측 상단에 플로팅 형태로 **[🔍 영수증 검증]** 버튼을 삽입한다.
* 버튼을 누르면 스피너(로딩 애니메이션)가 돌면서 아래 Step 2~4가 비동기(병렬)로 실행된다.

**Step 2. 로컬 브라우저 이미지 분석 (`content.js`)**
* **EXIF 검사:** `exif-js`를 활용해 이미지 메타데이터를 파싱하고, `Software` 태그 등에 편집 툴(Photoshop 등) 흔적이 있는지 확인한다.
* **Hash 추출:** `blockhash-js`를 이용해 이미지의 해시값을 추출하여 콘솔에 임시 출력한다.
* **OCR 추출:** `Tesseract.js`를 백그라운드 워커로 실행하여 이미지 내 텍스트를 추출한다. 정규식(Regex)을 사용하여 하이픈 포함 유무와 관계없이 숫자 10자리 형태의 **'사업자등록번호'**만 타겟팅하여 뽑아낸다.

**Step 3. 국세청 API 검증 (`background.js`)**
* `content.js`가 추출된 10자리 사업자번호(하이픈 제거)를 `background.js`로 전달한다.
* `chrome.storage.local`에 저장해둔 '공공데이터포털 API Key'를 불러온다.
* 국세청 API로 POST 요청을 보내어 해당 사업자의 상태(계속사업자, 휴업, 폐업, 국세청 미등록) 데이터를 받아와 `content.js`로 응답한다.

**Step 4. 결과 모달 출력 (`content.js` & `styles.css`)**
* 검사가 끝나면 이미지 바로 옆에 팝업(모달) 위젯을 띄운다.
* **UI 상태값 (신호등 디자인):**
  * 🟢 **정상 (Green):** 메타데이터 조작 없음 + 국세청 API 결과 '계속사업자'
  * 🟡 **주의 (Yellow):** OCR 텍스트 추출 실패 (화질 저하 등 육안 확인 필요)
  * 🔴 **반려 (Red):** 국세청 API 결과 '폐업자/미등록 번호' 이거나 EXIF 메타데이터에 'Photoshop' 등 위변조 흔적 발견 (사유를 텍스트로 명시할 것).

## 5. 예외 처리 및 방어 로직 (Error Handling)
* **API Key 누락:** `options.html`에 국세청 API Key가 등록되지 않은 상태에서 버튼을 누르면, "설정에서 공공데이터포털 API Key를 먼저 입력해 주세요."라는 `alert` 알림창을 띄운다.
* **CORS 에러 방지:** 외부 API 통신과 Canvas 이미지 조작 시 발생할 수 있는 보안 에러를 피하기 위해 `manifest.json`의 `host_permissions`를 꼼꼼히 반영한다.
* **비동기 처리:** API 호출 실패(Timeout, 500 Error 등) 시 모달 창에 직관적인 에러 메시지를 띄우고 무한 로딩에 빠지지 않도록 처리한다.