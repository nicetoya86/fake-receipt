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

  // '사업자번호:' 레이블 다음 값 우선 추출
  const labelMatch = raw.match(/사업자번호:\s*([^\n]+)/);
  const candidate = labelMatch ? labelMatch[1].trim() : '';

  // candidate에서 NNN-NN-NNNNN 매칭
  if (candidate) {
    const m = candidate.match(/(?<!\d)\d{3}-\d{2}-\d{5}(?!\d)/);
    if (m) return m[0];
    if (candidate.includes('없음')) return '없음';
  }

  // 전체 raw에서 NNN-NN-NNNNN 재탐색
  const fullMatch = raw.match(/(?<!\d)\d{3}-\d{2}-\d{5}(?!\d)/);
  if (fullMatch) return fullMatch[0];

  // 유효한 번호 없으면 없음 반환 (전체 텍스트 반환 금지)
  return '없음';
}

// ──────────────────────────────────────────────────────────────────────────────

// ── 중복 해시 관리 (Supabase 기반, chrome.storage.local 폴백) ────────────────

const HASH_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1년
const HAMMING_THRESHOLD = 10;

// UTC ms → KST ISO 문자열 (예: "2026-04-27T16:30:00.000+09:00")
function toKSTISOString(ms) {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  return d.toISOString().replace('Z', '+09:00');
}

function hammingDistance(hash1, hash2) {
  if (!hash1 || !hash2 || hash1.length !== hash2.length) return Infinity;
  let dist = 0;
  for (let i = 0; i < hash1.length; i++) {
    const xor = parseInt(hash1[i], 16) ^ parseInt(hash2[i], 16);
    dist += xor.toString(2).split('1').length - 1;
  }
  return dist;
}

// Supabase REST API 호출 헬퍼
async function supabaseFetch(method, path, body, supabaseUrl, anonKey) {
  const headers = {
    'apikey': anonKey,
    'Authorization': `Bearer ${anonKey}`,
    'Content-Type': 'application/json'
  };
  if (method === 'POST') headers['Prefer'] = 'return=representation';

  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.status);
    throw new Error(`Supabase ${method} ${path} → ${res.status}: ${errText}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Supabase 기반 해시 관리
async function manageReceiptHashesSupabase(newHash, approvalNo, reviewUrl, supabaseUrl, anonKey) {
  const now = Date.now();
  const ttlDate = new Date(now - HASH_TTL_MS).toISOString();

  // approved 항목만 조회 (TTL 필터 포함)
  const rows = await supabaseFetch(
    'GET',
    `receipt_hashes?select=id,hash,approval_no,saved_at,review_url&status=eq.approved&saved_at=gte.${ttlDate}`,
    null, supabaseUrl, anonKey
  );

  if (!newHash && !approvalNo) return { isDuplicate: false };

  // 중복 비교
  for (const row of (rows || [])) {
    if (approvalNo && row.approval_no && approvalNo === row.approval_no) {
      return { isDuplicate: true, savedAt: new Date(row.saved_at).getTime(), reason: 'approvalNo', reviewUrl: row.review_url || null };
    }
    if (newHash && row.hash) {
      const dist = hammingDistance(newHash, row.hash);
      if (dist <= HAMMING_THRESHOLD) {
        return { isDuplicate: true, savedAt: new Date(row.saved_at).getTime(), reason: 'hash', distance: dist, reviewUrl: row.review_url || null };
      }
    }
  }

  // 중복 아님 — 승인 시에만 저장하므로 여기서는 INSERT 안 함
  return { isDuplicate: false };
}

// chrome.storage.local 폴백 해시 관리 (Supabase 미설정 또는 오류 시)
async function manageReceiptHashesLocal(newHash, approvalNo, reviewUrl) {
  const { receiptHashes = [] } = await chrome.storage.local.get('receiptHashes');
  const now = Date.now();
  const validHashes = receiptHashes.filter(entry => (now - entry.savedAt) < HASH_TTL_MS);

  if (!newHash && !approvalNo) {
    await chrome.storage.local.set({ receiptHashes: validHashes });
    return { isDuplicate: false };
  }

  for (const entry of validHashes) {
    if (entry.status === 'pending') continue;
    if (approvalNo && entry.approvalNo && approvalNo === entry.approvalNo) {
      await chrome.storage.local.set({ receiptHashes: validHashes });
      return { isDuplicate: true, savedAt: entry.savedAt, reason: 'approvalNo', reviewUrl: entry.reviewUrl || null };
    }
    if (newHash && entry.hash) {
      const dist = hammingDistance(newHash, entry.hash);
      if (dist <= HAMMING_THRESHOLD) {
        await chrome.storage.local.set({ receiptHashes: validHashes });
        return { isDuplicate: true, savedAt: entry.savedAt, reason: 'hash', distance: dist, reviewUrl: entry.reviewUrl || null };
      }
    }
  }

  // 중복 아님 — 승인 시에만 저장하므로 여기서는 저장 안 함
  return { isDuplicate: false };
}

async function manageReceiptHashes(newHash, approvalNo, reviewUrl) {
  const { supabaseUrl, supabaseAnonKey } = await chrome.storage.local.get(['supabaseUrl', 'supabaseAnonKey']);

  if (supabaseUrl && supabaseAnonKey) {
    try {
      return await manageReceiptHashesSupabase(newHash, approvalNo, reviewUrl, supabaseUrl, supabaseAnonKey);
    } catch (err) {
      console.warn('[YRG] Supabase 해시 관리 실패, 로컬 폴백:', err.message);
    }
  }

  return manageReceiptHashesLocal(newHash, approvalNo, reviewUrl);
}

async function confirmReceiptHash(hash, approvalNo, reviewUrl) {
  const now = Date.now();
  const { supabaseUrl, supabaseAnonKey } = await chrome.storage.local.get(['supabaseUrl', 'supabaseAnonKey']);

  if (supabaseUrl && supabaseAnonKey) {
    try {
      await supabaseFetch('POST', 'receipt_hashes', {
        hash: hash || null,
        approval_no: approvalNo || null,
        saved_at: toKSTISOString(now),
        status: 'approved',
        review_url: reviewUrl || null
      }, supabaseUrl, supabaseAnonKey);
      return { success: true };
    } catch (err) {
      console.warn('[YRG] Supabase 승인 저장 실패, 로컬 폴백:', err.message);
    }
  }

  // 로컬 폴백
  const { receiptHashes = [] } = await chrome.storage.local.get('receiptHashes');
  receiptHashes.push({ hash: hash || null, approvalNo: approvalNo || null, reviewUrl: reviewUrl || null, savedAt: now, status: 'approved' });
  await chrome.storage.local.set({ receiptHashes });
  return { success: true };
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
    manageReceiptHashes(message.hash, message.approvalNo, message.reviewUrl)
      .then(sendResponse)
      .catch(err => sendResponse({ isDuplicate: false, error: err.message }));
    return true;
  }

  if (message.type === 'CONFIRM_HASH') {
    confirmReceiptHash(message.hash, message.approvalNo, message.reviewUrl)
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

const STANDARD_PROMPT = `[중요] 이미지가 90°/180°/270° 회전된 상태일 수 있습니다. 텍스트 방향과 무관하게 각 항목의 레이블을 먼저 정확히 찾은 뒤, 그 레이블 바로 옆·아래에 붙어있는 값만 추출하세요. 레이블 없이 추측하지 마세요.

한국 카드 영수증 이미지에서 다음 여섯 가지를 확인해주세요.

0. 이미지가 영수증인지 판단
   - 영수증(POS 영수증, 신용·체크카드 전표, 세금계산서, 배달 영수증)이면 "예"
   - 광고물·사진·스크린샷·문서·명함 등 영수증이 아니면 "아니오"
   - 영수증이 찍힌 사진이나 부분적으로 보이는 영수증도 "예"

1. 가맹점(판매자)의 상호명
   - "가맹점명", "상호", "판매처", "가맹점", "사업장명" 레이블 옆 또는 영수증 상단에 표기된 업체명
   - 지점명(예: "강남점", "홍대점")이 붙어있으면 포함해서 추출하세요
   - 카드사명(삼성카드, 신한카드 등)과 혼동하지 마세요

2. 상호명이 병·의원·한의원·치과·약국 등 의료기관인지 판단
   - 의료기관이면 "예", 음식점·카페·쇼핑 등 비의료기관이면 "아니오", 판단 불가이면 "불명"

3. 가맹점(판매자)의 사업자등록번호 (10자리, "XXX-XX-XXXXX" 형식)
   - 반드시 정확히 "NNN-NN-NNNNN" (3자리-2자리-5자리, 총 10자리) 형식으로 표기된 숫자만 추출하세요
   - [우선순위 1] "사업자번호", "사업자등록번호", "Biz No", "사업자" 레이블 옆 숫자를 먼저 확인하세요
   - [우선순위 2] 레이블이 없더라도 영수증 전체 텍스트에서 NNN-NN-NNNNN 형식(3자리-대시-2자리-대시-5자리)의 숫자를 빠짐없이 스캔하여 추출하세요
   - Cashnote Pay 등 일부 영수증은 가맹점명 오른쪽에 레이블 없이 사업자번호만 표기합니다 (예: "나인피부과 강남점   565-10-01602"). 이 경우도 반드시 추출하세요
   - 슬래시(/) 구분 형식 (예: "0141334656/546-33-01634"): 반드시 슬래시 오른쪽의 대시(-)가 포함된 숫자(예: "546-33-01634")만 사업자번호로 추출하세요
   - [절대 금지] 슬래시 왼쪽의 대시 없는 숫자(예: 0141334656, 203742503)에 임의로 대시를 삽입하지 마세요. 이 숫자를 NNN-NN-NNNNN 형식으로 변환하는 것은 금지입니다
   - 대시(-) 없이 붙어있는 숫자(예: 203742503, 611023899862)는 가맹점 ID·고유번호이므로 무시하세요
   - "고유번호", "일련번호" 레이블 옆 숫자는 사업자등록번호가 아닙니다 — 절대 추출하지 마세요
   - 사업자번호는 반드시 정확히 NNN-NN-NNNNN (3자리-2자리-5자리) 형식이어야 하며, 슬래시 왼쪽 숫자의 일부를 앞자리로 사용하지 마세요
   - 전화번호(02-, 010/011/016/017/018/019로 시작)와 혼동하지 마세요
   - 카드사(한국신용카드결제, KOCES 등)가 아닌 가맹점 번호를 찾으세요
   - 영수증 전체를 꼼꼼히 읽어 NNN-NN-NNNNN 패턴이 하나라도 있으면 반드시 추출하고, 진짜로 없을 때만 "없음"으로 답하세요

4. 카드 승인번호 (숫자 6~10자리)
   - 반드시 "승인번호", "승인 번호", "승인No", "Approval No" 레이블 바로 옆에 있는 숫자만 추출하세요
   - 카드사명이 괄호로 붙어있을 수 있음 (예: 승인번호(삼성카드))
   - 숫자만 추출하세요 (공백·[CC] 등 기호 제거)
   - [절대 금지] 카드번호(XXXX-XXXX-****-**** 형식)의 일부를 승인번호로 추출하지 마세요. 카드번호 앞 8자리(예: 9410-6186)를 승인번호로 오인하지 마세요

5. 카드번호 앞 자리 (BIN)
   - "카드번호", "Card No", "승인카드번호" 레이블 옆에 있음
   - 영수증마다 보이는 자릿수가 다릅니다. 자릿수별 처리 규칙:
     * 앞 4자리만 표시된 경우 (예: XXXX-****-****-****): 그 4자리를 추출하세요 (예: "4234")
     * 앞 6자리 표시된 경우 (예: XXXX-XX**-****-****): 그 6자리를 추출하세요 (예: "423456")
     * 앞 8자리 표시된 경우 (예: XXXX-XXXX-****-****): 앞 6자리만 추출하세요 (예: "423456")
   - 마스킹(*) 처리된 자리는 무시하고, 숫자로 표시된 앞 자리만 추출하세요
   - 카드번호 자체가 없으면 "없음" 기재

답변은 반드시 아래 형식 여섯 줄로만:
영수증여부: 예|아니오
상호명: [업체명]
의료기관여부: 예|아니오|불명
사업자번호: XXX-XX-XXXXX
승인번호: XXXXXXXX
카드BIN: XXXX 또는 XXXXXX
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
   - [열전사 프린터 정상 범위 — 아래 미세한 차이는 편집 흔적으로 보지 않음]
     * 날짜 연도(예: "26/04/21"의 "26")가 월·일보다 배경이 "약간" 밝거나 폰트 굵기가 "미세하게" 달라 보이는 것 (종이 질감·노이즈는 유지되어 있음)
     * 날짜 구분자(/, -)를 기준으로 앞뒤 숫자의 선명도나 폰트 두께가 미세하게 다른 것
     * 비스듬한 촬영·조명 반사로 특정 영역이 약간 밝아 보이는 것 (영수증 전체에 걸쳐 자연스러운 광량 그라데이션이 있음)
   - [단일 증거만으로도 즉시 위변조(교체)로 판정해야 하는 명백한 편집 흔적]
     * 순백색 직사각형 위에 새로운 텍스트·숫자가 덧씌워진 경우 — 흰색 덮어쓰기 후 교체의 확정적 증거
     * 열인쇄 비트맵 폰트(가장자리 회색 계단, 도트 패턴)와 컴퓨터 폰트(안티앨리어싱, 매끄러운 곡선)가 동일 필드에 혼재하는 경우
     * 특정 핵심 필드(날짜·금액·가맹점명)의 배경만 종이 질감이 완전히 사라지고 균일한 흰색이며 그 위에 새 텍스트가 있는 경우
     * 위 세 가지 중 하나라도 해당하면 단독으로 편집유형 "교체"로 판정하세요
   - [은닉 독립 평가 원칙 — 중요]
     * 카드번호·소지자명 등 개인정보를 검정색·흰색·스티커 등으로 단순히 가린 경우(가린 영역 위에 새 텍스트 없음)는 "카드정보 은닉"으로만 판정하세요
     * 은닉이 있더라도 날짜·금액·가맹점명 등 나머지 필드는 독립적으로 평가하세요 — 카드번호 가림이 있다는 이유로 날짜 등 다른 필드를 의심하지 마세요
     * 순백색·검정 직사각형이 있어도 그 위에 새 텍스트가 없으면 "교체"가 아닌 "은닉"으로 판정하세요
   - 그 외 미세한 차이가 2가지 이상 동시에 관찰될 때 위변조로 판정하세요
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

// Gemini 응답에서 상호명 추출
function extractMerchantNameText(raw) {
  if (!raw) return null;
  const match = raw.match(/상호명:\s*(.+)/);
  if (!match) return null;
  const name = match[1].trim();
  return (name === '없음' || name === '') ? null : name;
}

// Gemini 응답에서 의료기관여부 추출 ('예'|'아니오'|'불명')
function extractMedicalFlagText(raw) {
  if (!raw) return '불명';
  const match = raw.match(/의료기관여부:\s*(예|아니오|불명)/);
  return match ? match[1] : '불명';
}

// Gemini 응답에서 승인번호 추출
function extractApprovalNoText(raw) {
  if (!raw) return null;
  const match = raw.match(/승인번호:\s*(\d{6,10})/);
  return match ? match[1] : null;
}

// Gemini 응답에서 카드 BIN 추출
// 영수증 노출 자릿수: 앞 4자리 → 4자리 그대로, 앞 6자리 → 6자리 그대로, 앞 8자리 → 앞 6자리
function extractCardBINText(raw) {
  if (!raw) return null;
  const match = raw.match(/카드BIN:\s*(\d{4,8})/);
  if (!match) return null;
  const digits = match[1];
  if (digits.length >= 6) return digits.slice(0, 6); // 6~8자리 → 앞 6자리
  if (digits.length === 4) return digits;              // 앞 4자리 → 그대로 (브랜드 식별용)
  return null;                                         // 5자리 이하 (비정상) → 스킵
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
  let merchantName = extractMerchantNameText(rawText);
  let medicalFlag = extractMedicalFlagText(rawText);
  console.log('[YRG BG] 상호명 추출:', merchantName || '없음', '/ 의료기관여부:', medicalFlag);

  // "없음" 처리: 같은 프롬프트로 1차 재시도 (비결정적 특성 활용, 2/3 확률 성공)
  if (text === '없음') {
    console.log('[YRG BG] 1차 없음, STANDARD 재시도...');
    rawText = await callGeminiOCR(geminiApiKey, base64, mimeType, STANDARD_PROMPT);
    text = extractBizNoText(rawText);
    if (!approvalNo) approvalNo = extractApprovalNoText(rawText);
    if (!cardBIN) cardBIN = extractCardBINText(rawText);
    if (!merchantName) merchantName = extractMerchantNameText(rawText);
    if (medicalFlag === '불명') medicalFlag = extractMedicalFlagText(rawText);
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
      return { success: true, text: corrected, approvalNo, cardBIN, merchantName, medicalFlag };
    }

    // 2단계: 확장 혼동 집합 시도
    fixes = findVisualFix(digits, SIMILAR_STAGE2);
    if (fixes.length === 1) {
      const corrected = formatBizNo(fixes[0]);
      console.log('[YRG BG] 시각 유사 자동수정:', text, '→', corrected);
      return { success: true, text: corrected, approvalNo, cardBIN, merchantName, medicalFlag };
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
    return { success: true, text: corrected, approvalNo, cardBIN, merchantName, medicalFlag };
  }

  return { success: true, text, approvalNo, cardBIN, merchantName, medicalFlag };
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
        generationConfig: { temperature: 0, maxOutputTokens, thinkingConfig: { thinkingBudget: 0 } }
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

const BIN_API_URL = 'https://data.handyapi.com/bin';
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

// 주요 카드사 BIN 범위로 카드 종류 판별 (로컬 DB 미등록 BIN 사전 필터, 6자리용)
function detectCardScheme(bin) {
  const n = parseInt(bin, 10);
  if (bin[0] === '4') return 'Visa';
  if ((n >= 510000 && n <= 559999) || (n >= 222100 && n <= 272099)) return 'Mastercard';
  if (bin.startsWith('34') || bin.startsWith('37')) return 'Amex';
  if (bin.startsWith('6011') || bin.startsWith('65') ||
      (n >= 644000 && n <= 649999) || (n >= 622126 && n <= 622925)) return 'Discover';
  if (bin.startsWith('35')) return 'JCB';
  if (bin.startsWith('36') || bin.startsWith('300') || bin.startsWith('301') ||
      bin.startsWith('302') || bin.startsWith('303') || bin.startsWith('304') ||
      bin.startsWith('305') || bin.startsWith('38')) return 'Diners';
  if (bin.startsWith('62')) return 'UnionPay';
  return null;
}

// 앞 4자리만 표시된 영수증용 브랜드 식별 (6자리 BIN 조회 불가 → 브랜드 범위만 확인)
function detectCardSchemeFrom4(bin4) {
  const n = parseInt(bin4, 10);
  if (bin4[0] === '4') return 'Visa';
  if ((n >= 5100 && n <= 5599) || (n >= 2221 && n <= 2720)) return 'Mastercard';
  if (bin4.startsWith('34') || bin4.startsWith('37')) return 'Amex';
  if (bin4.startsWith('60') || bin4.startsWith('64') || bin4.startsWith('65')) return 'Discover';
  if (bin4.startsWith('35')) return 'JCB';
  if (bin4.startsWith('36') || bin4.startsWith('38') || (n >= 3000 && n <= 3059)) return 'Diners';
  if (bin4.startsWith('62')) return 'UnionPay';
  return null;
}

async function verifyCardBIN(bin) {
  if (!bin || !/^\d{4,6}$/.test(bin)) {
    console.log('[YRG BG] BIN 검증 스킵 — 형식 오류:', bin);
    return { valid: true, skip: true, reason: 'BIN 형식 오류' };
  }

  // 앞 4자리만 표시된 경우 → 브랜드 식별만 수행 (6자리 BIN 조회 불가)
  if (bin.length === 4) {
    const scheme = detectCardSchemeFrom4(bin);
    if (!scheme) {
      console.warn('[YRG BG] BIN 4자리 — 알 수 없는 카드사 범위:', bin);
      return { valid: false, bin, reason: `알 수 없는 카드번호 — 앞 4자리(${bin})가 주요 카드사 범위에 해당하지 않습니다` };
    }
    console.log('[YRG BG] BIN 4자리 브랜드 식별 통과:', bin, scheme);
    return { valid: true, bin, scheme, source: 'scheme-4digit' };
  }

  // 로컬 BIN 데이터 우선 조회 (API 호출 없이 즉시 처리)
  try {
    await loadBinData();

    if (_binKorea[bin]) {
      const d = _binKorea[bin];
      console.log('[YRG BG] BIN 검증 통과 — 국내 DB 매칭:', bin, d.i);
      return { valid: true, bin, issuer: d.i, type: d.t, source: 'local-korea' };
    }

    const binNum = parseInt(bin, 10);
    const intlMatch = _binIntl.find(r => binNum >= parseInt(r.s, 10) && binNum <= parseInt(r.e, 10));
    if (intlMatch) {
      console.log('[YRG BG] BIN 검증 통과 — 국제 DB 매칭:', bin, intlMatch.b);
      return { valid: true, bin, issuer: intlMatch.b, scheme: intlMatch.sc, source: 'local-intl' };
    }
  } catch (loadErr) {
    console.warn('[YRG BG] 로컬 BIN 데이터 로드 실패, API로 fallback:', loadErr.message);
  }

  // 로컬 DB 미등록 — 주요 카드사 범위 사전 검사
  const scheme = detectCardScheme(bin);
  if (!scheme) {
    console.warn('[YRG BG] BIN 알 수 없는 카드사 범위:', bin, '— 주요 카드사(Visa/MC/Amex/JCB 등) BIN 아님');
    return { valid: false, bin, reason: `알 수 없는 카드번호 — BIN ${bin}은(는) 주요 카드사 범위에 해당하지 않습니다` };
  }

  console.log('[YRG BG] BIN 로컬 미등록, API 조회 시작:', bin, `(${scheme} 범위)`);

  // Fallback: handyapi.me BIN API (월 80,000회 무료, API Key 불필요)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BIN_TIMEOUT_MS);

  try {
    const response = await fetch(`${BIN_API_URL}/${bin}`, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn('[YRG BG] BIN API 오류 — 검증 스킵:', bin, response.status);
      return { valid: true, skip: true, reason: `BIN API 오류 (HTTP ${response.status})` };
    }

    const data = await response.json();

    if (data.Status === 'NOT FOUND') {
      console.warn('[YRG BG] BIN API — 미등록 BIN:', bin);
      return { valid: false, bin, reason: '유효하지 않은 카드번호 (BIN 미등록)' };
    }

    if (data.Status !== 'SUCCESS') {
      console.warn('[YRG BG] BIN API — 알 수 없는 응답:', bin, data.Status);
      return { valid: true, skip: true, reason: `BIN API 응답 오류: ${data.Status}` };
    }

    // Issuer와 Country 모두 없으면 실존 카드사 확인 불가 → 차단
    const hasIssuer = !!data.Issuer;
    const hasCountry = Array.isArray(data.Country) ? data.Country.length > 0 : !!data.Country?.A2;
    if (!hasIssuer && !hasCountry) {
      console.warn('[YRG BG] BIN API — 발급사/국가 정보 없음 (실존 카드사 미확인):', bin);
      return { valid: false, bin, reason: '유효하지 않은 카드번호 (발급사 확인 불가)' };
    }

    console.log('[YRG BG] BIN 검증 통과 — API 확인:', bin, data.Scheme, data.Issuer);
    return { valid: true, bin, scheme: data.Scheme, country: data.Country?.A2, bank: data.Issuer, source: 'api' };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.warn('[YRG BG] BIN API 타임아웃 — 검증 스킵:', bin);
      return { valid: true, skip: true, reason: 'BIN API 타임아웃' };
    }
    console.warn('[YRG BG] BIN API 네트워크 오류 — 검증 스킵:', bin, err.message);
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
