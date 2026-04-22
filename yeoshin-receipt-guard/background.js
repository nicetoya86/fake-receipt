// background.js — Service Worker
// 국세청 API 통신 전담 (CORS 우회)

// base64 magic bytes로 실제 이미지 포맷 탐지
function normalizeMimeType(rawMime, base64) {
  const SUPPORTED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
  if (SUPPORTED.includes(rawMime)) return rawMime;

  try {
    const bytes = atob(base64.slice(0, 16));
    const b = (i) => bytes.charCodeAt(i);
    if (b(0) === 0xFF && b(1) === 0xD8) return 'image/jpeg';
    if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E) return 'image/png';
    if (bytes.slice(0,4) === 'RIFF' && bytes.slice(8,12) === 'WEBP') return 'image/webp';
  } catch {}

  return 'image/jpeg';
}

// ── 사업자등록번호 유틸리티 ─────────────────────────────────────────────────────

// 가중치 [1,3,7,1,3,7,1,3,5] 체크섬 검증
function validateKoreanBizNo(digits) {
  if (digits.length !== 10) return false;
  const d = digits.split('').map(Number);
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += d[i] * w[i];
  sum += Math.floor((d[8] * 5) / 10);
  return ((10 - (sum % 10)) % 10) === d[9];
}

function formatBizNo(digits) {
  return `${digits.slice(0,3)}-${digits.slice(3,5)}-${digits.slice(5)}`;
}

// 시각적으로 혼동하기 쉬운 숫자 쌍 (단계별)
// 1단계: 가장 흔한 1↔4 혼동만
const SIMILAR_STAGE1 = { '1': ['4'], '4': ['1'] };
// 2단계: 확장 혼동 집합 ('0'→'1' 포함: 저해상도에서 0이 1로 오독)
const SIMILAR_STAGE2 = {
  '0': ['6', '1'], '1': ['4','7'], '3': ['8'], '4': ['1','7'],
  '5': ['6'], '6': ['0','5'], '7': ['1','4'], '8': ['3','6','9'], '9': ['8']
};

// 시각적으로 유사한 숫자 치환 중 체크섬 통과 후보 반환
function findVisualFix(digits, similarMap) {
  const candidates = new Set();
  for (let pos = 0; pos < 9; pos++) {
    for (const alt of (similarMap[digits[pos]] || [])) {
      const modified = digits.slice(0, pos) + alt + digits.slice(pos + 1);
      if (validateKoreanBizNo(modified)) candidates.add(modified);
    }
  }
  return [...candidates];
}

// Gemini 응답에서 사업자번호 패턴만 추출 (레이블·설명 제거)
function extractBizNoText(raw) {
  if (!raw) return '없음';
  const match = raw.match(/\d{3}-\d{2}-\d{5}/);
  if (match) return match[0];
  if (raw.includes('없음')) return '없음';
  return raw.trim();
}

// ──────────────────────────────────────────────────────────────────────────────

// ── 중복 해시 관리 ────────────────────────────────────────────────────────────

const HASH_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1년
const HAMMING_THRESHOLD = 10;

function hammingDistance(hash1, hash2) {
  if (!hash1 || !hash2 || hash1.length !== hash2.length) return Infinity;
  let dist = 0;
  for (let i = 0; i < hash1.length; i++) {
    const xor = parseInt(hash1[i], 16) ^ parseInt(hash2[i], 16);
    dist += xor.toString(2).split('1').length - 1;
  }
  return dist;
}

async function manageReceiptHashes(newHash, approvalNo) {
  const { receiptHashes = [] } = await chrome.storage.local.get('receiptHashes');
  const now = Date.now();

  // TTL 정리: 1년 초과 항목 제거
  const validHashes = receiptHashes.filter(entry => (now - entry.savedAt) < HASH_TTL_MS);

  if (!newHash && !approvalNo) {
    await chrome.storage.local.set({ receiptHashes: validHashes });
    return { isDuplicate: false };
  }

  // 승인된 항목만 중복 비교 (status 없는 레거시 항목도 approved 취급)
  for (const entry of validHashes) {
    if (entry.status === 'pending') continue;
    if (approvalNo && entry.approvalNo && approvalNo === entry.approvalNo) {
      await chrome.storage.local.set({ receiptHashes: validHashes });
      return { isDuplicate: true, savedAt: entry.savedAt, reason: 'approvalNo' };
    }
    if (newHash && entry.hash) {
      const dist = hammingDistance(newHash, entry.hash);
      if (dist <= HAMMING_THRESHOLD) {
        await chrome.storage.local.set({ receiptHashes: validHashes });
        return { isDuplicate: true, savedAt: entry.savedAt, reason: 'hash', distance: dist };
      }
    }
  }

  // 중복 아님 — pending 상태로 저장 (후기 승인 후 approved로 변경 필요)
  validHashes.push({ hash: newHash || null, approvalNo: approvalNo || null, savedAt: now, status: 'pending' });
  await chrome.storage.local.set({ receiptHashes: validHashes });
  return { isDuplicate: false };
}

async function confirmReceiptHash(hash, approvalNo) {
  const { receiptHashes = [] } = await chrome.storage.local.get('receiptHashes');

  // 가장 최근 pending 항목 중 매칭되는 것 하나를 approved로 변경
  let updated = false;
  for (let i = receiptHashes.length - 1; i >= 0; i--) {
    const entry = receiptHashes[i];
    if (entry.status !== 'pending') continue;
    const hashMatch = hash && entry.hash && hammingDistance(hash, entry.hash) <= HAMMING_THRESHOLD;
    const approvalMatch = approvalNo && entry.approvalNo && approvalNo === entry.approvalNo;
    if (hashMatch || approvalMatch) {
      receiptHashes[i] = { ...entry, status: 'approved' };
      updated = true;
      break;
    }
  }

  if (updated) await chrome.storage.local.set({ receiptHashes });
  return { success: updated };
}

// ──────────────────────────────────────────────────────────────────────────────

const NTS_API_URL = 'https://api.odcloud.kr/api/nts-businessman/v1/status';
const API_TIMEOUT_MS = 10000;

const STATUS_MAP = {
  '01': { status: 'active',       statusText: '계속사업자' },
  '02': { status: 'closed',       statusText: '폐업자' },
  '03': { status: 'suspended',    statusText: '휴업자' }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'MANAGE_HASHES') {
    manageReceiptHashes(message.hash, message.approvalNo)
      .then(sendResponse)
      .catch(err => sendResponse({ isDuplicate: false, error: err.message }));
    return true;
  }

  if (message.type === 'CONFIRM_HASH') {
    confirmReceiptHash(message.hash, message.approvalNo)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'ANALYZE_TAMPER') {
    const dataURL = message.dataURL;
    if (!dataURL) { sendResponse({ tamperLevel: 'unknown', reason: 'dataURL 없음' }); return true; }
    analyzeVisualTamper(dataURL)
      .then(sendResponse)
      .catch(err => sendResponse({ tamperLevel: 'unknown', reason: err.message }));
    return true;
  }

  if (message.type === 'VERIFY_BIZ_NUMBER') {
    verifyWithNTS(message.bizNo)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: 'API_ERROR', message: err.message }));
    return true;
  }

  if (message.type === 'RUN_OCR') {
    const dataURL = message.dataURL;
    const imageURL = message.imageURL;
    console.log('[YRG BG] RUN_OCR 수신, dataURL:', dataURL ? `있음(${dataURL.length}자)` : '없음', 'imageURL:', imageURL ? imageURL.slice(0, 80) : '없음');

    if (!dataURL && !imageURL) {
      sendResponse({ success: false, error: '[BG] dataURL과 imageURL 모두 전달되지 않았습니다.' });
      return true;
    }

    const getDataURL = dataURL ? Promise.resolve(dataURL) : fetchImageAsDataURL(imageURL);

    getDataURL
      .then(url => {
        console.log('[YRG BG] 이미지 dataURL 준비 완료, 길이:', url.length);
        return geminiOCRFromDataURL(url);
      })
      .then(result => {
        console.log('[YRG BG] OCR 완료:', JSON.stringify(result)?.slice(0, 200));
        sendResponse(result);
      })
      .catch(err => {
        console.error('[YRG BG] OCR 파이프라인 오류:', err.message);
        sendResponse({ success: false, error: err.message || '알 수 없는 오류' });
      });
    return true;
  }

  if (message.type === 'VERIFY_CARD_BIN') {
    verifyCardBIN(message.bin)
      .then(sendResponse)
      .catch(err => sendResponse({ valid: true, skip: true, reason: err.message }));
    return true;
  }

  if (message.type === 'PING') {
    sendResponse({ status: 'ok' });
  }
});

// ── 이미지 fetch ──────────────────────────────────────────────────────────────

async function fetchImageAsDataURL(imageURL) {
  const resp = await fetch(imageURL, { credentials: 'omit' });
  if (!resp.ok) throw new Error(`이미지 fetch 실패: HTTP ${resp.status}`);
  const blob = await resp.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ── Gemini Vision OCR ─────────────────────────────────────────────────────────

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_TIMEOUT_MS = 30000;

const STANDARD_PROMPT = `한국 카드 영수증 이미지에서 다음 네 가지를 확인해주세요.

0. 이미지가 영수증인지 판단
   - 영수증(POS 영수증, 신용·체크카드 전표, 세금계산서, 배달 영수증)이면 "예"
   - 광고물·사진·스크린샷·문서·명함 등 영수증이 아니면 "아니오"
   - 영수증이 찍힌 사진이나 부분적으로 보이는 영수증도 "예"

1. 가맹점(판매자)의 사업자등록번호 (10자리, "XXX-XX-XXXXX" 형식)
   - "사업자번호", "사업자등록번호", "Biz No", "가맹점번호", "사업자" 레이블 옆에 있으면 우선 사용
   - 레이블이 없더라도 XXX-XX-XXXXX 형식(3자리-2자리-5자리)의 숫자가 보이면 사업자등록번호로 추출하세요
   - 전화번호(02-, 010/011/016/017/018/019로 시작)와 혼동하지 마세요
   - 카드사(한국신용카드결제, KOCES 등)가 아닌 가맹점 번호를 찾으세요
   - 이미지가 기울어지거나 배경이 있어도 정확히 읽으세요

2. 카드 승인번호 (숫자 6~10자리)
   - "승인번호", "승인 번호", "승인No", "Approval No" 레이블 옆에 있음
   - 카드사명이 괄호로 붙어있을 수 있음 (예: 승인번호(삼성카드))
   - 숫자만 추출하세요 (공백·[CC] 등 기호 제거)

3. 카드번호 앞 6자리 (BIN)
   - "카드번호", "Card No", "승인카드번호" 레이블 옆에 있음
   - 형식: XXXX-XX**-****-XXXX 또는 XXXX XXXX XXXX XXXX (뒷자리 마스킹 포함)
   - 앞 6자리만 추출 (예: "423456")
   - 카드번호 자체가 없으면 "없음" 기재

답변은 반드시 아래 형식 네 줄로만:
영수증여부: 예|아니오
사업자번호: XXX-XX-XXXXX
승인번호: XXXXXXXX
카드BIN: XXXXXX
(없으면 해당 항목에 "없음" 기재)`;

// 1차와 다른 프롬프트로 재시도 — 힌트 없이 신중하게 읽기만 요청
const CAREFUL_PROMPT = `한국 카드 영수증에서 두 가지를 찾아주세요. 저해상도일 수 있으니 각 숫자를 천천히 읽으세요.
사업자등록번호는 레이블("사업자번호" 등) 없이 XXX-XX-XXXXX 형식만 있어도 추출하세요. 단 전화번호(02-, 010- 등)는 제외하세요.

답변은 반드시 아래 형식 두 줄로만:
사업자번호: XXX-XX-XXXXX
승인번호: XXXXXXXX
(없으면 해당 항목에 "없음" 기재)`;

// ── 위변조 탐지 프롬프트 ─────────────────────────────────────────────────────────

const TAMPER_PROMPT = `한국 카드 영수증 이미지의 위변조 여부를 분석해주세요.

[검토 항목]
1. 숫자·텍스트 편집 흔적 (최우선 — 가장 세밀하게 검토):
   - 금액(합계·소계·부가세·공급가액)·날짜·사업자번호·승인번호 각 필드를 개별적으로 집중 검토
   - 같은 줄·같은 필드 안에서 숫자 간 폰트 크기·굵기·자간·기울기·획 두께가 일치하는지 비교
   - 그림판(mspaint) 지우개+텍스트 도구 패턴: 특정 숫자 아래·주변에 배경보다 더 균일하고 깨끗한 직사각형 영역이 있는지
   - 안티앨리어싱 부재: 원본 열인쇄 텍스트는 가장자리에 미세한 회색 픽셀이 있으나, 그림판 추가 텍스트는 검정(0,0,0)↔흰색(255,255,255) 경계가 1픽셀 단위로 끊어짐
   - 덧씌운 텍스트 아래 원본 글자 잔해, 지워진 영역의 배경색이 주변 종이 질감과 다르게 매끄러움
   - 복사-붙여넣기 흔적: 특정 텍스트 블록 주변만 선명도·노이즈 수준이 현저히 다름
   - 폰트 이질성: POS 열인쇄 폰트(비트맵 계열, 가장자리 회색조 계단)와 Windows/컴퓨터 입력 폰트(안티앨리어싱, 매끈한 곡선)가 동일 필드 또는 인접 필드에 혼재하는지 확인
   - 배경 이질성: 거래일시·금액 등 핵심 필드 주변 배경이 나머지 영수증 배경보다 더 희고 균일하면(종이 질감·노이즈 없음) 흰색 덮어쓰기 편집으로 판단
   - 날짜 값이 오늘 날짜와 일치하더라도, 배경 이질성·폰트 불일치 등 시각적 편집 흔적이 있으면 "거래핵심정보" 편집으로 판단
2. 수치 논리 일관성: 소계+부가세=합계 여부 (반드시 계산으로 확인), 미래 날짜·비정상 시간대
3. 영수증 구조: 가맹점명·날짜·금액 등 필수 항목 누락, 전체 레이아웃 자연스러움
4. 화면 캡처/스크린샷 여부:
   - 모니터·TV·스마트폰 화면을 촬영하거나 캡처한 이미지인지 판단
   - 픽셀 격자 패턴(모아레), 화면 베젤·UI 요소 흔적, 반사광
   - 실제 종이 영수증 특유의 열인쇄 노이즈·구겨짐·배경 없이 완벽한 흰 배경
5. AI 생성 여부:
   - DALL-E, Midjourney, Stable Diffusion 등 생성형 AI로 만든 이미지인지 판단
   - AI 생성 특징: 폰트/글씨가 지나치게 균일, 열인쇄 노이즈·잉크번짐·구겨짐 전혀 없음
   - 비현실적으로 완벽한 레이아웃, 숫자 배치가 인간적 부정확함 없이 픽셀 완벽
   - AI 생성 텍스트 특유의 비자연스러운 한국어 글자 조합

6. 다중 영수증 여부:
   - 이미지 안에 영수증이 2장 이상 포함되어 있는지 판단
   - 각각 다른 가맹점·금액·날짜를 가진 별개의 영수증이 나란히 놓인 경우 해당
   - 동일 영수증의 앞·뒷면이나 동일 거래의 고객용·가맹점용 사본은 해당 안 됨

7. 편집 위치:
   - 흰색 덮어쓰기, 블러, 모자이크, 스티커 등으로 편집된 영역을 확인
   - 배경 이질성(주변보다 더 균일·밝은 직사각형 영역)·폰트 불일치 등 시각적 편집 흔적이 있으면 날짜 값과 무관하게 편집으로 판단
   - 거래일시·결제금액·가맹점명·사업자번호·승인번호 중 하나라도 편집 시: "거래핵심정보"
   - 카드번호·소지자명·유효기간·카드사명만 편집 시: "카드정보"
   - 편집 흔적 없음: "없음"

8. 편집 유형:
   - 기존 내용을 지우고 새로운 텍스트나 숫자를 덧씌운 경우: "교체"
   - 블러, 모자이크, 검정/흰색으로 단순히 가린 경우(새 텍스트 없음): "은닉"
   - 편집 없음: "없음"

답변은 반드시 아래 형식 여덟 줄로만:
위변조_점수: 0-100
판정: 정상|의심|위변조
도용_의심: 예|아니오
AI생성_의심: 예|아니오
다중영수증: 예|아니오
편집부위: 없음|카드정보|거래핵심정보
편집유형: 없음|은닉|교체
이유: (발견된 모든 문제들, 없으면 "이상 없음")`;

function parseTamperResult(raw) {
  if (!raw) return { tamperLevel: 'unknown', score: 0, isSuspectedStolen: false, isSuspectedAI: false, reason: '분석 결과 없음' };
  const score   = parseInt(raw.match(/위변조_점수:\s*(\d+)/)?.[1] ?? '0');
  const verdict = raw.match(/판정:\s*(정상|의심|위변조)/)?.[1] ?? '정상';
  const reason  = raw.match(/이유:\s*(.+)/)?.[1]?.trim() ?? '이상 없음';
  const isSuspectedStolen = raw.match(/도용_의심:\s*(예|아니오)/)?.[1] === '예';
  const isSuspectedAI       = raw.match(/AI생성_의심:\s*(예|아니오)/)?.[1] === '예';
  const isMultipleReceipts  = raw.match(/다중영수증:\s*(예|아니오)/)?.[1] === '예';
  const editLocation        = raw.match(/편집부위:\s*(없음|카드정보|거래핵심정보)/)?.[1] ?? '없음';
  const editType            = raw.match(/편집유형:\s*(없음|은닉|교체)/)?.[1] ?? '없음';
  let tamperLevel;
  if (verdict === '위변조' && score >= 90) tamperLevel = 'high';
  else if (verdict === '위변조' || verdict === '의심') tamperLevel = 'medium';
  else tamperLevel = 'low';
  return { tamperLevel, score, verdict, reason, isSuspectedStolen, isSuspectedAI, isMultipleReceipts, editLocation, editType, success: true };
}

async function analyzeVisualTamper(dataURL) {
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  if (!geminiApiKey) return { tamperLevel: 'unknown', reason: 'API Key 미설정' };

  const base64 = dataURL.split(',')[1];
  const rawMime = dataURL.match(/data:([^;]+)/)?.[1] || '';
  const mimeType = normalizeMimeType(rawMime, base64);

  // KST 현재 날짜를 프롬프트에 주입 — 모델 학습 기준일과 실제 날짜 차이로 인한 오판 방지
  const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const kstDateStr = `${kstNow.getUTCFullYear()}년 ${String(kstNow.getUTCMonth() + 1).padStart(2, '0')}월 ${String(kstNow.getUTCDate()).padStart(2, '0')}일`;
  const prompt = `[오늘 날짜 KST: ${kstDateStr}]\n이 날짜보다 이후인 경우에만 미래 날짜로 판단하세요.\n\n${TAMPER_PROMPT}`;

  try {
    const raw = await callGeminiOCR(geminiApiKey, base64, mimeType, prompt, 4096);
    const result = parseTamperResult(raw);
    console.log('[YRG BG] 위변조 분석 결과:', result.verdict, `(${result.score}점)`, result.reason);
    return result;
  } catch (err) {
    console.warn('[YRG BG] 위변조 분석 실패:', err.message);
    return { tamperLevel: 'unknown', reason: err.message };
  }
}

// ──────────────────────────────────────────────────────────────────────────────

// Gemini 응답에서 승인번호 추출
function extractApprovalNoText(raw) {
  if (!raw) return null;
  const match = raw.match(/승인번호:\s*(\d{6,10})/);
  return match ? match[1] : null;
}

// Gemini 응답에서 카드 BIN(앞 6자리) 추출
function extractCardBINText(raw) {
  if (!raw) return null;
  const match = raw.match(/카드BIN:\s*(\d{6})/);
  return match ? match[1] : null;
}

async function geminiOCRFromDataURL(dataURL) {
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  if (!geminiApiKey) return { success: false, error: 'NO_GEMINI_KEY' };

  const base64 = dataURL.split(',')[1];
  const rawMime = dataURL.match(/data:([^;]+)/)?.[1] || '';
  const mimeType = normalizeMimeType(rawMime, base64);

  // 1차 OCR
  let rawText = await callGeminiOCR(geminiApiKey, base64, mimeType, STANDARD_PROMPT);
  const isReceipt = rawText?.match(/영수증여부:\s*(예|아니오)/)?.[1] !== '아니오';
  if (!isReceipt) {
    console.log('[YRG BG] 비영수증 이미지 감지 — 검증 중단');
    return { success: true, isReceipt: false, text: '없음', approvalNo: null, cardBIN: null };
  }

  let text = extractBizNoText(rawText);
  let approvalNo = extractApprovalNoText(rawText);
  let cardBIN = extractCardBINText(rawText);

  // "없음" 처리: 같은 프롬프트로 1차 재시도 (비결정적 특성 활용, 2/3 확률 성공)
  if (text === '없음') {
    console.log('[YRG BG] 1차 없음, STANDARD 재시도...');
    rawText = await callGeminiOCR(geminiApiKey, base64, mimeType, STANDARD_PROMPT);
    text = extractBizNoText(rawText);
    if (!approvalNo) approvalNo = extractApprovalNoText(rawText);
    if (!cardBIN) cardBIN = extractCardBINText(rawText);
  }
  // 여전히 "없음"이면 다른 프롬프트로 2차 재시도
  if (text === '없음') {
    console.log('[YRG BG] 2차 없음, CAREFUL 재시도...');
    rawText = await callGeminiOCR(geminiApiKey, base64, mimeType, CAREFUL_PROMPT);
    text = extractBizNoText(rawText);
    if (!approvalNo) approvalNo = extractApprovalNoText(rawText);
  }

  console.log('[YRG BG] 승인번호 추출:', approvalNo || '없음');
  console.log('[YRG BG] 카드BIN 추출:', cardBIN || '없음');

  const digits = text.replace(/\D/g, '');

  if (digits.length === 10 && !validateKoreanBizNo(digits)) {
    // 1단계: 1↔4 혼동만 시도 (가장 흔한 오류, 후보가 적음)
    let fixes = findVisualFix(digits, SIMILAR_STAGE1);
    if (fixes.length === 1) {
      const corrected = formatBizNo(fixes[0]);
      console.log('[YRG BG] 1↔4 자동수정:', text, '→', corrected);
      return { success: true, text: corrected, approvalNo };
    }

    // 2단계: 확장 혼동 집합 시도
    fixes = findVisualFix(digits, SIMILAR_STAGE2);
    if (fixes.length === 1) {
      const corrected = formatBizNo(fixes[0]);
      console.log('[YRG BG] 시각 유사 자동수정:', text, '→', corrected);
      return { success: true, text: corrected, approvalNo };
    }

    // 3단계: 후보 다수 → 우선순위 기반 선택 (NTS 추가 호출 없이)
    // 4→1 단일 치환 후보 우선 (열인쇄 영수증에서 가장 흔한 오독 패턴)
    const preferred = fixes.find(candidate => {
      let diffCount = 0, diffPos = -1;
      for (let i = 0; i < 10; i++) {
        if (digits[i] !== candidate[i]) { diffCount++; diffPos = i; }
      }
      return diffCount === 1 && digits[diffPos] === '4' && candidate[diffPos] === '1';
    });
    const best = preferred ?? fixes[0];
    const corrected = formatBizNo(best);
    console.log('[YRG BG] 우선순위 선택:', corrected, preferred ? '(4→1)' : '(첫번째 후보)');
    return { success: true, text: corrected, approvalNo };
  }

  return { success: true, text, approvalNo, cardBIN };
}

// 단일 Gemini API 호출 (타임아웃 독립 관리)
async function callGeminiOCR(apiKey, base64, mimeType, promptText, maxOutputTokens = 1024) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const apiResp = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mimeType, data: base64 } },
            { text: promptText }
          ]
        }],
        generationConfig: { temperature: 0, maxOutputTokens }
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!apiResp.ok) {
      const errBody = await apiResp.text().catch(() => '');
      console.error('[YRG BG] Gemini 오류 응답 본문:', errBody.slice(0, 600));
      throw new Error(`Gemini API 오류: HTTP ${apiResp.status}`);
    }

    const data = await apiResp.json();
    const candidate = data?.candidates?.[0];
    console.log('[YRG BG] Gemini finishReason:', candidate?.finishReason);
    const parts = candidate?.content?.parts || [];
    parts.forEach((p, i) => console.log(`[YRG BG] part[${i}] thought=${!!p.thought} text=`, p.text?.slice(0, 200)));
    return (parts.find(p => !p.thought) ?? parts[parts.length - 1])?.text?.trim() || '';
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') throw new Error('Gemini API 타임아웃 (30초)');
    throw err;
  }
}

// ── 카드 BIN 유효성 검증 ──────────────────────────────────────────────────────

const BIN_API_URL = 'https://lookup.binlist.net';
const BIN_TIMEOUT_MS = 8000;

// 로컬 BIN 데이터 메모리 캐시 (서비스워커 재시작 시 재로드)
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
  if (!bin || !/^\d{6}$/.test(bin)) {
    return { valid: true, skip: true, reason: 'BIN 형식 오류' };
  }

  // 로컬 BIN 데이터 우선 조회 (API 호출 없이 즉시 처리)
  try {
    await loadBinData();

    if (_binKorea[bin]) {
      const d = _binKorea[bin];
      return { valid: true, bin, issuer: d.i, type: d.t, source: 'local-korea' };
    }

    const binNum = parseInt(bin, 10);
    const intlMatch = _binIntl.find(r => binNum >= parseInt(r.s, 10) && binNum <= parseInt(r.e, 10));
    if (intlMatch) {
      return { valid: true, bin, issuer: intlMatch.b, scheme: intlMatch.sc, source: 'local-intl' };
    }
  } catch (loadErr) {
    console.warn('[YRG BG] 로컬 BIN 데이터 로드 실패, API로 fallback:', loadErr.message);
  }

  // Fallback: binlist.net API
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BIN_TIMEOUT_MS);

  try {
    const response = await fetch(`${BIN_API_URL}/${bin}`, {
      headers: { 'Accept-Version': '3' },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (response.status === 404) {
      return { valid: false, bin, reason: '유효하지 않은 카드번호 (BIN 미등록)' };
    }
    if (response.status === 429) {
      return { valid: true, skip: true, reason: 'Rate Limit 초과' };
    }
    if (!response.ok) {
      return { valid: true, skip: true, reason: `BIN API 오류 (HTTP ${response.status})` };
    }

    const data = await response.json();
    return { valid: true, bin, scheme: data.scheme, country: data.country?.alpha2, bank: data.bank?.name };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') return { valid: true, skip: true, reason: 'BIN API 타임아웃' };
    return { valid: true, skip: true, reason: err.message };
  }
}

// ──────────────────────────────────────────────────────────────────────────────

async function verifyWithNTS(bizNo) {
  const { apiKey } = await chrome.storage.local.get('apiKey');

  if (!apiKey) {
    return { success: false, error: 'NO_API_KEY', message: 'API Key가 설정되지 않았습니다.' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${NTS_API_URL}?serviceKey=${apiKey}&returnType=JSON`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ b_no: [bizNo] }),
        signal: controller.signal
      }
    );

    clearTimeout(timeoutId);

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

    const data = await response.json();
    const item = data?.data?.[0];

    if (!item) {
      return { success: true, bizNo, status: 'unregistered', statusText: '국세청미등록' };
    }

    const mapped = STATUS_MAP[item.b_stt_cd] || { status: 'unregistered', statusText: '국세청미등록' };

    return { success: true, bizNo, ...mapped, taxType: item.tax_type || '', endDate: item.end_dt || '' };

  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return { success: false, error: 'TIMEOUT', message: '요청 시간이 초과되었습니다 (10초).' };
    }
    throw err;
  }
}
