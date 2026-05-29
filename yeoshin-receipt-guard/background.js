// background.js — Service Worker
// 국세청 API 통신 전담 (CORS 우회)

// ── 로그 버퍼 (검증 세션 로그 파일 저장용) ──────────────────────────────────────
// SW 재시작 시에도 로그가 유지되도록 chrome.storage.local에 영속화
const _yrgLogBuffer = [];
let _yrgPersistTimer = null;

function _yrgKSTTimestamp() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 23).replace('T', ' ') + ' KST';
}

// SW 재시작 시 기존 로그 복원
chrome.storage.local.get('_yrgLogs', d => {
  if (Array.isArray(d?._yrgLogs)) _yrgLogBuffer.push(...d._yrgLogs);
});

// 500ms 디바운스로 storage에 일괄 저장 (매 로그마다 I/O 방지)
function _yrgPersist() {
  clearTimeout(_yrgPersistTimer);
  _yrgPersistTimer = setTimeout(() => {
    chrome.storage.local.set({ _yrgLogs: [..._yrgLogBuffer] });
  }, 500);
}

function _yrgAddLog(msg) {
  _yrgLogBuffer.push(`[${_yrgKSTTimestamp()}] ${msg}`);
  _yrgPersist();
}

(function _interceptBgLog() {
  const orig = console.log;
  console.log = function(...args) {
    orig.apply(console, args);
    const msg = args.map(a => (a !== null && typeof a === 'object') ? JSON.stringify(a) : String(a)).join(' ');
    if (msg.startsWith('[YRG')) _yrgAddLog(msg);
  };
})();

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
// 2단계: 확장 혼동 집합
// '0'→'9' 추가: 저해상도에서 9의 꼬리가 사라지면 0으로 오독 (예: 398→308)
const SIMILAR_STAGE2 = {
  '0': ['6', '1', '9'], '1': ['4','7'], '3': ['8'], '4': ['1','7'],
  '5': ['6'], '6': ['0','5'], '7': ['1','4'], '8': ['3','6','9'], '9': ['8', '0']
};

// CAREFUL 응답 전체에서 체크섬 유효한 사업자번호 탐색 (응답이 짧아 전체 스캔 안전)
// 하이픈(-) 외 공백·점(.)으로 구분된 형식도 정규화하여 탐색
function findValidBizNoInText(raw) {
  if (!raw) return null;
  // 공백·점 구분자를 하이픈으로 정규화 (예: "014 15 32077", "014.15.32077" → "014-15-32077")
  const normalized = raw.replace(/(?<!\d)(\d{3})[\s.](\d{2})[\s.](\d{5})(?!\d)/g, '$1-$2-$3');
  const re = /(?<!\d)\d{3}-\d{2}-\d{5}(?!\d)/g;
  let m;
  while ((m = re.exec(normalized)) !== null) {
    if (validateKoreanBizNo(m[0].replace(/\D/g, ''))) return m[0];
  }
  return null;
}

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
// 허용 형식: NNN-NN-NNNNN (하이픈), NNN NN NNNNN (공백), NNN.NN.NNNNN (점) → 모두 하이픈 형식으로 정규화
function normalizeBizNoSeparator(text) {
  // 공백·점 구분자를 하이픈으로 정규화 (단, 이미 하이픈인 경우 무변환)
  return text.replace(/(?<!\d)(\d{3})[\s.](\d{2})[\s.](\d{5})(?!\d)/g, '$1-$2-$3');
}

function extractBizNoText(raw) {
  if (!raw) return '없음';

  // '사업자번호:' 레이블 다음 값 우선 추출
  const labelMatch = raw.match(/사업자번호:\s*([^\n]+)/);

  if (labelMatch) {
    // 레이블을 찾은 경우 — 레이블 값에서만 추출 (전체 탐색 금지: 위변조 분석 텍스트 오염 방지)
    const candidate = normalizeBizNoSeparator(labelMatch[1].trim());
    const m = candidate.match(/(?<!\d)\d{3}-\d{2}-\d{5}(?!\d)/);
    if (m) return m[0];
    return '없음';
  }

  // 레이블 자체가 없는 경우에만 전체 텍스트 탐색 (구형 응답 포맷 대응)
  const normalized = normalizeBizNoSeparator(raw);
  const fullMatch = normalized.match(/(?<!\d)\d{3}-\d{2}-\d{5}(?!\d)/);
  if (fullMatch) return fullMatch[0];

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

// NTS API 결과 메모리 캐시 (서비스워커 세션 내 유지, 1시간 TTL)
const _ntsCache = new Map();
const NTS_CACHE_TTL_MS = 60 * 60 * 1000;

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

  if (message.type === 'RUN_OCR_AND_TAMPER') {
    const dataURL = message.dataURL;
    if (!dataURL) { sendResponse({ success: false, error: 'dataURL 없음' }); return true; }
    geminiOCRAndTamperFromDataURL(dataURL)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
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

  // ── 로그 버퍼 관리 ──────────────────────────────────────────
  if (message.type === 'YRG_LOG') {
    _yrgAddLog(message.msg);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'YRG_LOG_COUNT') {
    sendResponse({ count: _yrgLogBuffer.length });
    return false;
  }

  if (message.type === 'YRG_DOWNLOAD_LOGS') {
    const now = _yrgKSTTimestamp();
    const header = [
      '=== YRG 검증 로그 ===',
      `저장 시각: ${now}`,
      `총 항목: ${_yrgLogBuffer.length}개`,
      '================================',
      '',
    ].join('\n');
    sendResponse({ content: header + _yrgLogBuffer.join('\n'), count: _yrgLogBuffer.length });
    return false;
  }

  if (message.type === 'YRG_CLEAR_LOGS') {
    _yrgLogBuffer.length = 0;
    chrome.storage.local.remove('_yrgLogs');
    sendResponse({ ok: true });
    return false;
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

[정확성 원칙] 이미지에 실제로 명확하게 인쇄된 내용만 답하세요. 흐릿하거나 부분적으로만 보여 확실하지 않은 항목은 "없음"으로 답하세요. 추측하거나 만들어내지 마세요.

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
   - NNN-NN-NNNNN 형식이 이미지에 명확하게 인쇄되어 있으면 추출하세요. 흐릿하거나 확실하지 않으면 "없음"으로 답하세요

4. 카드 승인번호 (숫자 6~10자리)
   - 반드시 "승인번호", "승인 번호", "승인No", "Approval No" 레이블 바로 옆에 있는 숫자만 추출하세요
   - 카드사명이 괄호로 붙어있을 수 있음 (예: 승인번호(삼성카드))
   - 숫자만 추출하세요 (공백·[CC] 등 기호 제거)
   - [절대 금지] 카드번호(XXXX-XXXX-****-**** 형식)의 일부를 승인번호로 추출하지 마세요. 카드번호 앞 8자리(예: 9410-6186)를 승인번호로 오인하지 마세요
   - 레이블이 명확히 보이지 않거나 숫자가 불확실하면 "없음"으로 답하세요

5. 카드번호 앞 자리 (BIN)
   - "카드번호", "Card No", "승인카드번호" 레이블 옆에 있음
   - [핵심 규칙] 첫 번째 * 또는 마스킹 기호가 나오기 전까지 연속으로 표시된 모든 숫자를 추출하세요
   - 예시: "5434 12** **** ****" → "543412", "4033-1234-****-****" → "403312", "5377-****-****-****" → "5377"
   - 영수증마다 보이는 자릿수가 다릅니다. 자릿수별 처리 규칙:
     * 앞 4자리만 표시된 경우 (예: XXXX-****-****-****): 그 4자리를 추출하세요 (예: "4234")
     * 앞 6자리 표시된 경우 (예: XXXX-XX**-****-****): 그 6자리를 추출하세요 (예: "423456")
     * 앞 8자리 표시된 경우 (예: XXXX-XXXX-****-****): 앞 6자리만 추출하세요 (예: "423456")
   - 마스킹(*) 처리된 자리는 무시하고, 숫자로 표시된 앞 자리만 추출하세요
   - 카드번호 레이블이 명확하지 않으면 "없음" 기재
   - [OCR 혼동 주의] 카드번호에서 오인하기 쉬운 숫자 쌍: 5↔6, 0↔6, 0↔9, 1↔7, 3↔8. 카드번호는 금융 정보이므로 각 자리를 픽셀 수준에서 하나씩 신중하게 확인하세요
   - 한 자리라도 확실하지 않으면 전체를 "없음"으로 답하세요 — 불확실한 숫자로 오답을 제출하지 마세요

답변은 반드시 아래 형식 여섯 줄로만:
영수증여부: 예|아니오
상호명: [업체명]
의료기관여부: 예|아니오|불명
사업자번호: XXX-XX-XXXXX
승인번호: XXXXXXXX
카드BIN: XXXX 또는 XXXXXX
(없으면 해당 항목에 "없음" 기재)`;

// 1차와 다른 프롬프트로 재시도 — 영수증 전체를 적극적으로 스캔
const CAREFUL_PROMPT = `한국 카드 영수증 이미지에서 사업자등록번호와 승인번호를 찾아주세요.

[중요] 이미지의 모든 영역을 처음부터 끝까지 빠짐없이 스캔하세요. 작은 글씨, 하단 인쇄, 표 안의 숫자도 모두 확인하세요.

사업자등록번호 찾는 법:
1. 이미지 전체를 처음부터 끝까지 스캔하여 "NNN-NN-NNNNN" (3자리-대시-2자리-대시-5자리, 총 10자리) 형식의 숫자를 모두 찾으세요
2. "사업자번호", "사업자등록번호", "Biz No", "사업자" 레이블 옆에 있는 NNN-NN-NNNNN 숫자를 최우선으로 선택하세요
3. 레이블이 없어도 영수증 어디서든 이 형식이 보이면 추출하세요
4. NNN-NN-NNNNN 형식의 숫자가 여러 개 보이면 쉼표로 구분하여 모두 나열하세요 (예: XXX-XX-XXXXX, YYY-YY-YYYYY)
- 전화번호(02-, 010/011/016~019로 시작)는 절대 포함하지 마세요
- 대시(-)가 없는 연속 숫자는 무시하세요
- 형식에 맞는 숫자가 보이면 반드시 포함하세요 — 놓치지 마세요
- 이미지에 이 형식의 숫자가 정말 없다면 "없음"으로 답하세요

답변은 반드시 아래 형식 두 줄로만:
사업자번호: XXX-XX-XXXXX  ← 여러 개면 쉼표로 나열, 없으면 "없음"
승인번호: XXXXXXXX  ← 없으면 "없음"
(없으면 해당 항목에 "없음" 기재)`;

// ── 위변조 탐지 프롬프트 ─────────────────────────────────────────────────────────

const TAMPER_PROMPT = `한국 카드 영수증 이미지의 위변조 여부를 분석해주세요.

[위변조 판정 원칙]
- "정상" 판정은 거래일시·금액·가맹점명 세 필드를 각각 적극적으로 확인하여 이상이 없음을 확인한 경우에만 사용하세요 — 이상을 발견하지 못했다는 이유만으로 "정상"으로 판정하지 마세요
- 불확실하거나 확인이 충분하지 않으면 "의심"(위변조_점수 30-59)으로 판정하세요
- 위변조_점수 0은 기본값이 아닙니다 — 모든 핵심 필드를 실제로 검토하여 완전히 이상이 없음을 확인한 경우에만 사용하세요
- 위변조로 판정하려면 ①배경 이질성(흰색 덮어쓰기 흔적) 또는 ②폰트 기술 차이(비트맵↔안티앨리어싱 혼재) 중 하나의 명확한 물리적 증거가 필요합니다
- "위변조"는 확실한 물리적 증거가 있는 경우에만 사용하세요 — 애매하거나 미세한 차이는 반드시 "의심"으로 판정하세요. 위변조로 단정하기 어려우면 의심 판정이 더 안전합니다

[검토 항목]
1. 숫자·텍스트 편집 흔적 (최우선 — 가장 세밀하게 검토):
   - 금액(합계·소계·부가세·공급가액)·날짜·사업자번호·승인번호 각 필드를 개별적으로 집중 검토
   - 검토 핵심: 기존 인쇄된 내용 위에 새로운 데이터(숫자·텍스트)가 덧씌워졌는지 여부 — 폰트 크기·굵기 차이만으로는 편집 흔적으로 판단하지 마세요
   - 그림판(mspaint) 지우개+텍스트 도구 패턴: 특정 숫자 아래·주변에 배경보다 더 균일하고 깨끗한 직사각형 영역이 있는지
   - 안티앨리어싱 부재: 원본 열인쇄 텍스트는 가장자리에 미세한 회색 픽셀이 있으나, 그림판 추가 텍스트는 검정(0,0,0)↔흰색(255,255,255) 경계가 1픽셀 단위로 끊어짐
   - 덧씌운 텍스트 아래 원본 글자 잔해, 지워진 영역의 배경색이 주변 종이 질감과 다르게 매끄러움
   - 배경 이질성: 핵심 필드 주변 배경만 종이 질감이 완전히 사라지고 균일한 흰색이며 그 위에 새 텍스트가 있는 경우
   - 날짜 값이 오늘 날짜와 일치하더라도, 배경 이질성·폰트 불일치 등 시각적 편집 흔적이 있으면 "거래핵심정보" 편집으로 판단
   - [열전사 프린터 정상 범위 — 아래 차이는 편집 흔적으로 보지 않음]
     * 날짜 연도(예: "26/04/21"의 "26")가 월·일보다 배경이 "약간" 밝거나 폰트 굵기가 "미세하게" 달라 보이는 것 (종이 질감·노이즈는 유지되어 있음)
     * 날짜 구분자(/, -)를 기준으로 앞뒤 숫자의 선명도나 폰트 두께가 미세하게 다른 것
     * 비스듬한 촬영·조명 반사로 특정 영역이 약간 밝아 보이는 것 (영수증 전체에 걸쳐 자연스러운 광량 그라데이션이 있음)
     * 영수증 내 서로 다른 섹션(가맹점명·합계금액·항목목록·결제정보) 간의 폰트 크기·굵기 차이 — POS 프린터는 중요도에 따라 다른 크기로 인쇄하는 것이 정상 (예: 합계금액이 크게, 항목명이 작게, 사업자번호가 작게)
     * 같은 영수증 내에서 특정 줄·필드의 폰트가 다른 줄보다 작거나 크더라도, 해당 텍스트 주변의 종이 질감·열인쇄 노이즈가 자연스럽게 유지된다면 편집 흔적 아님
     * 전체 이미지가 균일하게 저해상도·흐릿·픽셀 뭉개짐 — 특정 영역만 흐린 것이 아니라 이미지 전체가 동일하게 저화질이면 촬영 환경 문제이므로 편집 흔적으로 판단하지 마세요
     * 영수증 위에 볼펜·연필 등으로 직접 쓴 손글씨(환자 이름, 담당자 메모, 서명 등)는 편집 흔적이 아닙니다 — 손글씨 자체를 위변조 증거나 편집부위로 분류하지 마세요
   - [즉시 위변조 — 아래 중 하나라도 확인되면 위변조_점수 80 이상·판정 "위변조"·편집유형 "교체" 필수]
     * 거래일시·금액 필드 주변에 배경보다 밝고 균일한 직사각형 영역이 있고 그 위에 텍스트가 있는 경우 — 흰색 덮어쓰기+교체의 확정적 증거이며 다른 어떤 "정상 범위" 예외도 적용되지 않음
     * 열인쇄 비트맵 폰트(가장자리 회색 계단, 도트 패턴)와 컴퓨터 폰트(안티앨리어싱, 매끄러운 곡선)가 동일 필드 내에 혼재하는 경우 (단, 서로 다른 필드 간 폰트 차이는 제외)
     * 특정 핵심 필드(날짜·금액·가맹점명)의 배경만 종이 질감이 완전히 사라지고 균일한 흰색이며 그 위에 새 텍스트가 있는 경우
     * 위 세 가지는 반드시 위변조로 판정하세요 — "정상 범위" 예외는 적용되지 않습니다
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
   - [화면 캡처 판정 시 필수 규칙]
     * 화면 캡처 또는 화면 촬영으로 판단된 경우: 편집부위를 반드시 "없음", 편집유형을 반드시 "없음"으로 설정하세요
     * 화면 캡처 자체는 편집 행위가 아닙니다 — 캡처된 화면 내 텍스트가 그림판 등으로 추가 편집된 명백한 흔적이 있을 때만 예외
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
   - 교체: ①기존 내용 위에 흰색·균일색 덮어쓰기 흔적이 있고 ②그 위에 새로운 텍스트·숫자가 명확히 삽입된 경우 — 폰트 크기·굵기 차이 단독으로는 교체로 판정하지 마세요. 흰색 패치·스티커가 사각형 형태로 육안에 확실히 식별되고 그 위에 새 텍스트가 있는 경우에만 "교체"를 선택하세요 — 확실하지 않으면 "없음"으로 판정하세요
   - 은닉: 블러, 모자이크, 검정/흰색으로 단순히 가린 경우(가린 영역 위에 새 텍스트 없음)
   - 없음: 편집 흔적 없음

[출력 전 자기 점검 — 판정 전 반드시 직접 확인하세요]
① 거래일시·금액 필드 주변에 배경보다 더 밝거나 균일한 직사각형이 보이는가?
② 금액 또는 날짜 숫자의 폰트 특성(선의 매끄러움·안티앨리어싱)이 나머지 텍스트와 완전히 다른가?
→ 하나라도 "예"이면 "정상"으로 판정하지 마세요
→ "이상 없음"은 위 두 항목을 포함한 모든 핵심 필드를 적극적으로 확인한 후에만 기재하세요

답변은 반드시 아래 형식 아홉 줄로만:
위변조_점수: 0-100
판정: 정상|의심|위변조
화면캡처: 예|아니오
도용_의심: 예|아니오
AI생성_의심: 예|아니오
다중영수증: 예|아니오
편집부위: 없음|카드정보|거래핵심정보
편집유형: 없음|은닉|교체
이유: (발견된 모든 문제들 — "이상 없음"은 거래일시·금액·가맹점명 세 필드를 모두 적극 확인 후에만 기재)`;

// OCR + 위변조 분석을 단일 Gemini 호출로 수행하는 통합 프롬프트
// ${KST_DATE} 는 호출 시점에 실제 날짜 문자열로 치환됨
const COMBINED_PROMPT = `[중요] 이미지가 90°/180°/270° 회전된 상태일 수 있습니다. 텍스트 방향과 무관하게 각 항목의 레이블을 먼저 정확히 찾은 뒤, 그 레이블 바로 옆·아래에 붙어있는 값만 추출하세요. 레이블 없이 추측하지 마세요.

[정확성 원칙] 이미지에 실제로 명확하게 인쇄된 내용만 답하세요. 흐릿하거나 부분적으로만 보여 확실하지 않은 항목은 "없음"으로 답하세요. 추측하거나 만들어내지 마세요.

한국 카드 영수증 이미지에서 [정보 추출]과 [위변조 분석]을 동시에 수행하세요.

━━━ 정보 추출 ━━━

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
   - [우선순위 2] 레이블이 없더라도 영수증 전체 텍스트에서 NNN-NN-NNNNN 형식의 숫자를 빠짐없이 스캔하여 추출하세요
   - Cashnote Pay 등 일부 영수증은 가맹점명 오른쪽에 레이블 없이 사업자번호만 표기합니다 (예: "나인피부과 강남점   565-10-01602"). 이 경우도 반드시 추출하세요
   - 슬래시(/) 구분 형식 (예: "0141334656/546-33-01634"): 반드시 슬래시 오른쪽의 대시(-)가 포함된 숫자만 사업자번호로 추출하세요
   - [절대 금지] 슬래시 왼쪽의 대시 없는 숫자에 임의로 대시를 삽입하지 마세요
   - 대시(-) 없이 붙어있는 숫자(예: 203742503, 611023899862)는 가맹점 ID·고유번호이므로 무시하세요
   - "고유번호", "일련번호" 레이블 옆 숫자는 사업자등록번호가 아닙니다 — 절대 추출하지 마세요
   - 전화번호(02-, 010/011/016/017/018/019로 시작)와 혼동하지 마세요
   - 카드사(한국신용카드결제, KOCES 등)가 아닌 가맹점 번호를 찾으세요
   - NNN-NN-NNNNN 형식이 이미지에 명확하게 인쇄되어 있으면 추출하세요. 흐릿하거나 확실하지 않으면 "없음"으로 답하세요

4. 카드 승인번호 (숫자 6~10자리)
   - 반드시 "승인번호", "승인 번호", "승인No", "Approval No" 레이블 바로 옆에 있는 숫자만 추출하세요
   - 숫자만 추출하세요 (공백·[CC] 등 기호 제거)
   - [절대 금지] 카드번호(XXXX-XXXX-****-**** 형식)의 일부를 승인번호로 추출하지 마세요
   - 레이블이 명확히 보이지 않거나 숫자가 불확실하면 "없음"으로 답하세요

5. 카드번호 앞 자리 (BIN)
   - "카드번호", "Card No", "승인카드번호" 레이블 옆에 있음
   - [핵심 규칙] 첫 번째 * 또는 마스킹 기호가 나오기 전까지 연속으로 표시된 모든 숫자를 추출하세요
   - 예시: "5434 12** **** ****" → "543412", "4033-1234-****-****" → "403312", "5377-****-****-****" → "5377"
   - 앞 4자리만 표시된 경우 → 4자리 추출, 앞 6자리 표시 → 6자리 추출, 앞 8자리 표시 → 앞 6자리만 추출
   - 마스킹(*) 처리된 자리는 무시하고, 숫자로 표시된 앞 자리만 추출하세요
   - 카드번호 레이블이 명확하지 않으면 "없음" 기재
   - [OCR 혼동 주의] 카드번호에서 오인하기 쉬운 숫자 쌍: 5↔6, 0↔6, 0↔9, 1↔7, 3↔8. 카드번호는 금융 정보이므로 각 자리를 픽셀 수준에서 하나씩 신중하게 확인하세요
   - 한 자리라도 확실하지 않으면 전체를 "없음"으로 답하세요 — 불확실한 숫자로 오답을 제출하지 마세요

━━━ 위변조 분석 [오늘 KST: \${KST_DATE}] ━━━

이 날짜보다 이후인 경우에만 미래 날짜로 판단하세요.

[위변조 판정 원칙]
- "정상" 판정은 거래일시·금액·가맹점명 세 필드를 각각 적극적으로 확인하여 이상이 없음을 확인한 경우에만 사용하세요 — 이상을 발견하지 못했다는 이유만으로 "정상"으로 판정하지 마세요
- 불확실하거나 확인이 충분하지 않으면 "의심"(위변조_점수 30-59)으로 판정하세요
- 위변조_점수 0은 기본값이 아닙니다 — 모든 핵심 필드를 실제로 검토하여 완전히 이상이 없음을 확인한 경우에만 사용하세요
- 위변조로 판정하려면 ①배경 이질성(흰색 덮어쓰기 흔적) 또는 ②폰트 기술 차이(비트맵↔안티앨리어싱 혼재) 중 하나의 명확한 물리적 증거가 필요합니다
- "위변조"는 확실한 물리적 증거가 있는 경우에만 사용하세요 — 애매하거나 미세한 차이는 반드시 "의심"으로 판정하세요. 위변조로 단정하기 어려우면 의심 판정이 더 안전합니다

1. 숫자·텍스트 편집 흔적 (최우선 — 가장 세밀하게 검토):
   - 금액(합계·소계·부가세·공급가액)·날짜·사업자번호·승인번호 각 필드를 개별적으로 집중 검토
   - 검토 핵심: 기존 인쇄된 내용 위에 새로운 데이터(숫자·텍스트)가 덧씌워졌는지 여부 — 폰트 크기·굵기 차이만으로는 편집 흔적으로 판단하지 마세요
   - 그림판(mspaint) 지우개+텍스트 도구 패턴: 특정 숫자 아래·주변에 배경보다 더 균일하고 깨끗한 직사각형 영역이 있는지
   - 안티앨리어싱 부재: 원본 열인쇄 텍스트는 가장자리에 미세한 회색 픽셀이 있으나, 그림판 추가 텍스트는 검정↔흰색 경계가 1픽셀 단위로 끊어짐
   - 배경 이질성: 핵심 필드 주변 배경만 종이 질감이 완전히 사라지고 균일한 흰색이며 그 위에 새 텍스트가 있는 경우
   - [열전사 프린터 정상 범위 — 아래 차이는 편집 흔적으로 보지 않음]
     * 날짜 연도가 월·일보다 배경이 "약간" 밝거나 폰트 굵기가 "미세하게" 달라 보이는 것 (종이 질감·노이즈는 유지)
     * 비스듬한 촬영·조명 반사로 특정 영역이 약간 밝아 보이는 것
     * 영수증 내 서로 다른 섹션(가맹점명·합계금액·항목목록·결제정보) 간의 폰트 크기·굵기 차이 — POS 프린터는 중요도에 따라 다른 크기로 인쇄하는 것이 정상
     * 같은 영수증 내에서 특정 줄·필드의 폰트가 다른 줄보다 작거나 크더라도, 해당 텍스트 주변의 종이 질감·열인쇄 노이즈가 자연스럽게 유지된다면 편집 흔적 아님
     * 전체 이미지가 균일하게 저해상도·흐릿·픽셀 뭉개짐 — 이미지 전체가 동일하게 저화질이면 편집 흔적 아님
     * 영수증 위에 볼펜·연필 등으로 직접 쓴 손글씨(환자 이름, 담당자 메모, 서명 등)는 편집 흔적이 아닙니다 — 손글씨 자체를 위변조 증거나 편집부위로 분류하지 마세요
   - [즉시 위변조 — 아래 중 하나라도 확인되면 위변조_점수 80 이상·판정 "위변조"·편집유형 "교체" 필수]
     * 거래일시·금액 필드 주변에 배경보다 밝고 균일한 직사각형 영역이 있고 그 위에 텍스트가 있는 경우 — 흰색 덮어쓰기+교체의 확정적 증거이며 다른 어떤 "정상 범위" 예외도 적용되지 않음
     * 열인쇄 비트맵 폰트(가장자리 회색 계단, 도트 패턴)와 컴퓨터 폰트(안티앨리어싱, 매끄러운 곡선)가 동일 필드 내에 혼재하는 경우 (단, 서로 다른 필드 간 폰트 차이는 제외)
     * 특정 핵심 필드(날짜·금액·가맹점명)의 배경만 종이 질감이 완전히 사라지고 균일한 흰색이며 그 위에 새 텍스트가 있는 경우
     * 위 세 가지는 반드시 위변조로 판정하세요 — "정상 범위" 예외는 적용되지 않습니다
   - [은닉 독립 평가 원칙]
     * 카드번호·소지자명 등을 단순히 가린 경우(가린 영역 위에 새 텍스트 없음)는 "카드정보 은닉"으로만 판정
     * 은닉이 있더라도 날짜·금액·가맹점명 등 나머지 필드는 독립적으로 평가
2. 수치 논리 일관성: 소계+부가세=합계 여부 (반드시 계산으로 확인), 미래 날짜·비정상 시간대
3. 영수증 구조: 가맹점명·날짜·금액 등 필수 항목 누락, 전체 레이아웃 자연스러움
4. 화면 캡처/스크린샷 여부:
   - 모니터·TV·스마트폰 화면을 촬영하거나 캡처한 이미지인지 판단
   - [화면 캡처 판정 시] 편집부위를 반드시 "없음", 편집유형을 반드시 "없음"으로 설정하세요
5. AI 생성 여부:
   - DALL-E, Midjourney, Stable Diffusion 등 생성형 AI로 만든 이미지인지 판단
   - AI 생성 특징: 폰트/글씨가 지나치게 균일, 열인쇄 노이즈·잉크번짐·구겨짐 전혀 없음
6. 다중 영수증 여부:
   - 이미지 안에 각각 다른 가맹점·금액·날짜를 가진 별개의 영수증이 2장 이상 포함되어 있는지 판단
7. 편집 위치:
   - 거래일시·결제금액·가맹점명·사업자번호·승인번호 중 하나라도 편집 시: "거래핵심정보"
   - 카드번호·소지자명·유효기간·카드사명만 편집 시: "카드정보"
   - 편집 흔적 없음: "없음"
8. 편집 유형:
   - 교체: ①기존 내용 위에 흰색·균일색 덮어쓰기 흔적이 있고 ②그 위에 새로운 텍스트·숫자가 명확히 삽입된 경우 — 폰트 크기·굵기 차이 단독으로는 교체로 판정하지 마세요. 흰색 패치·스티커가 사각형 형태로 육안에 확실히 식별되고 그 위에 새 텍스트가 있는 경우에만 "교체"를 선택하세요 — 확실하지 않으면 "없음"으로 판정하세요
   - 은닉: 블러·모자이크·단순 가리기(가린 영역 위에 새 텍스트 없음)
   - 없음: 편집 흔적 없음

[출력 전 자기 점검 — 판정 전 반드시 직접 확인하세요]
① 거래일시·금액 필드 주변에 배경보다 더 밝거나 균일한 직사각형이 보이는가?
② 금액 또는 날짜 숫자의 폰트 특성(선의 매끄러움·안티앨리어싱)이 나머지 텍스트와 완전히 다른가?
→ 하나라도 "예"이면 "정상"으로 판정하지 마세요
→ "이상 없음"은 위 두 항목을 포함한 모든 핵심 필드를 적극적으로 확인한 후에만 기재하세요
→ "교체" 판정은 흰색·단색 직사각형 패치가 육안으로 명확히 보이고 그 위에 새 텍스트가 있는 경우에만 선택하세요

답변은 반드시 아래 형식 열다섯 줄로만:
영수증여부: 예|아니오
상호명: [업체명]
의료기관여부: 예|아니오|불명
사업자번호: XXX-XX-XXXXX
승인번호: XXXXXXXX
카드BIN: XXXX 또는 XXXXXX
위변조_점수: 0-100
판정: 정상|의심|위변조
화면캡처: 예|아니오
도용_의심: 예|아니오
AI생성_의심: 예|아니오
다중영수증: 예|아니오
편집부위: 없음|카드정보|거래핵심정보
편집유형: 없음|은닉|교체
이유: (발견된 모든 문제들 — "이상 없음"은 거래일시·금액·가맹점명 세 필드를 모두 적극 확인 후에만 기재)
(없으면 해당 항목에 "없음" 기재)`;

function parseTamperResult(raw, kstNow = null) {
  if (!raw) return { tamperLevel: 'unknown', score: 0, isSuspectedStolen: false, isSuspectedAI: false, reason: '분석 결과 없음' };
  let score   = parseInt(raw.match(/위변조_점수:\s*(\d+)/)?.[1] ?? '0');
  let verdict = raw.match(/판정:\s*(정상|의심|위변조)/)?.[1] ?? '정상';
  let reason    = raw.match(/이유:\s*(.+)/)?.[1]?.trim() ?? '이상 없음';
  const isScreenshot        = raw.match(/화면캡처:\s*(예|아니오)/)?.[1] === '예';
  const isSuspectedStolen   = raw.match(/도용_의심:\s*(예|아니오)/)?.[1] === '예';
  const isSuspectedAI       = raw.match(/AI생성_의심:\s*(예|아니오)/)?.[1] === '예';
  const isMultipleReceipts  = raw.match(/다중영수증:\s*(예|아니오)/)?.[1] === '예';
  const editLocation        = raw.match(/편집부위:\s*(없음|카드정보|거래핵심정보)/)?.[1] ?? '없음';
  const editType            = raw.match(/편집유형:\s*(없음|은닉|교체)/)?.[1] ?? '없음';

  // 미래 날짜 오판 교정: Gemini 학습 기준일이 오래된 경우 현재 이전 날짜를 "미래"로 오판하는 버그 보정
  // reason에 "미래 날짜"가 포함되면 실제 날짜와 비교 후 과거/당일이면 정상으로 덮어쓴다
  // 2자리 연도 지원: 영수증에 "25/12/31" 형식으로 표기된 경우 20XX년으로 해석
  if (kstNow && (verdict === '위변조' || verdict === '의심') &&
      (reason.includes('미래 날짜') || reason.includes('현재 날') ||
       reason.includes('미래'))) {
    // 지원 형식: YYYY년MM월DD일 / YY년 M월 D일 / YYYY/MM/DD / YYYY-MM-DD / YYYY.MM.DD / YY.MM.DD 등
    const dateMatch = reason.match(/(\d{2,4})년\s*(\d{1,2})월\s*(\d{1,2})일/) ||
                      reason.match(/(\d{2,4})[\/\-\.](\d{2})[\/\-\.](\d{2})/);
    if (dateMatch) {
      let year = +dateMatch[1];
      if (year < 100) year += 2000; // 2자리 연도(예: 25 → 2025)
      const claimedDate = new Date(Date.UTC(year, +dateMatch[2] - 1, +dateMatch[3]));
      const todayKST = new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()));
      if (claimedDate <= todayKST) {
        console.log('[YRG BG] 미래 날짜 오판 교정:', reason, '→ 정상 (실제 과거/당일:', dateMatch[0], ')');
        verdict = '정상';
        score = 0;
        reason = '이상 없음'; // 교정 후 reason 초기화 — 반려 메시지에 오판 날짜 노출 방지
      }
    }
  }

  // 판정-점수 모순 교정: 판정이 '위변조'인데 점수가 30 미만이면 '의심'으로 완화
  if (verdict === '위변조' && score < 30) {
    console.log('[YRG BG] 판정 교정: 위변조 판정이나 점수', score, '< 30 → 의심으로 완화');
    verdict = '의심';
  }

  let tamperLevel;
  if (verdict === '위변조' && score >= 90) tamperLevel = 'high';
  else if (verdict === '위변조' || verdict === '의심') tamperLevel = 'medium';
  else tamperLevel = 'low';
  return { tamperLevel, score, verdict, reason, isScreenshot, isSuspectedStolen, isSuspectedAI, isMultipleReceipts, editLocation, editType, success: true };
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
    const result = parseTamperResult(raw, kstNow);
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
// 영수증 노출 형식: "950002", "9500-02", "4210-29" 등 대시 포함 형식 모두 처리
// 앞 6자리 이상 → 앞 6자리, 앞 4자리만 노출된 경우 → 4자리 (브랜드 식별용)
function extractCardBINText(raw) {
  if (!raw) return null;
  // 대시 포함 형식(예: 9500-02, 4210-29) 및 연속 숫자 형식(예: 950002) 모두 캡처
  const match = raw.match(/카드BIN:\s*(\d{4}[-\s]?\d{2,4}|\d{4,8})/);
  if (!match) return null;
  const digits = match[1].replace(/\D/g, ''); // 대시·공백 제거 후 숫자만
  if (digits.length >= 6) return digits.slice(0, 6); // 6자리 이상 → 앞 6자리
  if (digits.length === 4) return digits;             // 앞 4자리만 노출된 경우 → 브랜드 식별용
  return null;                                        // 5자리 (비정상) → 스킵
}

// OCR 응답에서 사업자번호 외 부가 필드를 누락 시 채우는 헬퍼
function fillMissingOCRFields(fields, rawText) {
  if (!fields.approvalNo)          fields.approvalNo  = extractApprovalNoText(rawText);
  if (!fields.cardBIN)             fields.cardBIN     = extractCardBINText(rawText);
  if (!fields.merchantName)        fields.merchantName = extractMerchantNameText(rawText);
  if (fields.medicalFlag === '불명') fields.medicalFlag = extractMedicalFlagText(rawText);
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

  const fields = {
    text:         extractBizNoText(rawText),
    approvalNo:   extractApprovalNoText(rawText),
    cardBIN:      extractCardBINText(rawText),
    merchantName: extractMerchantNameText(rawText),
    medicalFlag:  extractMedicalFlagText(rawText),
  };
  console.log('[YRG BG] 상호명 추출:', fields.merchantName || '없음', '/ 의료기관여부:', fields.medicalFlag);

  // "없음"이면 CAREFUL 프롬프트로 단일 재시도 (STANDARD 중복 재시도 제거 — 속도 개선)
  if (fields.text === '없음') {
    console.log('[YRG BG] 없음, CAREFUL 재시도...');
    rawText = await callGeminiOCR(geminiApiKey, base64, mimeType, CAREFUL_PROMPT);
    const carefulBizNo = extractBizNoText(rawText);
    // 체크섬 통과한 경우만 채택 — 할루시네이션 방지
    if (carefulBizNo !== '없음') {
      const carefulDigits = carefulBizNo.replace(/\D/g, '');
      if (carefulDigits.length === 10 && validateKoreanBizNo(carefulDigits)) {
        fields.text = carefulBizNo;
      } else {
        console.log('[YRG BG] CAREFUL 결과 체크섬 실패 — 없음 유지:', carefulBizNo);
      }
    }
    // 레이블 파싱이 없음이어도 응답 전체 스캔으로 유효 번호 탐색
    if (fields.text === '없음') {
      const scanned = findValidBizNoInText(rawText);
      if (scanned) {
        console.log('[YRG BG] CAREFUL 전체 스캔 발견:', scanned);
        fields.text = scanned;
      }
    }
    if (!fields.approvalNo) fields.approvalNo = extractApprovalNoText(rawText);
  }

  const { text, approvalNo, cardBIN, merchantName, medicalFlag } = fields;

  console.log('[YRG BG] 승인번호 추출:', approvalNo || '없음');
  console.log('[YRG BG] 카드BIN 추출:', cardBIN || '없음');

  const digits = text.replace(/\D/g, '');

  if (digits.length === 10 && !validateKoreanBizNo(digits)) {
    // 공통 CAREFUL 헬퍼 — 응답 전체 스캔으로 체크섬 통과 번호 반환, 없으면 null
    const callCarefulAndFind = async () => {
      const t = await callGeminiOCR(geminiApiKey, base64, mimeType, CAREFUL_PROMPT);
      return { text: t, bizNo: findValidBizNoInText(t) };
    };

    // 1단계: 1↔4 혼동 (가장 흔한 OCR 오류, 후보 적음)
    let fixes = findVisualFix(digits, SIMILAR_STAGE1);
    if (fixes.length === 1) {
      const corrected = formatBizNo(fixes[0]);
      console.log('[YRG BG] 1↔4 자동수정:', text, '→', corrected);
      const { text: ct1, bizNo: cb1 } = await callCarefulAndFind();
      if (cb1) {
        if (cb1 !== corrected) console.log('[YRG BG] Stage1 CAREFUL 재확인:', corrected, '→', cb1);
        return { success: true, text: cb1, approvalNo: approvalNo || extractApprovalNoText(ct1), cardBIN, merchantName, medicalFlag };
      }
      // CAREFUL 미확인 → 보정값 신뢰 불가, NTS 오조회 방지
      console.log('[YRG BG] Stage1 CAREFUL 실패 — 없음 반환:', corrected);
      return { success: true, text: '없음', approvalNo, cardBIN, merchantName, medicalFlag };
    }

    // 2단계: 확장 혼동 집합
    fixes = findVisualFix(digits, SIMILAR_STAGE2);
    if (fixes.length === 1) {
      const corrected = formatBizNo(fixes[0]);
      console.log('[YRG BG] 시각 유사 자동수정:', text, '→', corrected);
      const { text: ct2, bizNo: cb2 } = await callCarefulAndFind();
      if (cb2) {
        if (cb2 !== corrected) console.log('[YRG BG] Stage2 CAREFUL 재확인:', corrected, '→', cb2);
        return { success: true, text: cb2, approvalNo: approvalNo || extractApprovalNoText(ct2), cardBIN, merchantName, medicalFlag };
      }
      // CAREFUL 미확인 → 보정값 신뢰 불가, NTS 오조회 방지
      console.log('[YRG BG] Stage2 CAREFUL 실패 — 없음 반환:', corrected);
      return { success: true, text: '없음', approvalNo, cardBIN, merchantName, medicalFlag };
    }

    // 3단계: 후보 다수 → 4→1 단일 치환 우선
    const preferred = fixes.find(candidate => {
      let diffCount = 0, diffPos = -1;
      for (let i = 0; i < 10; i++) {
        if (digits[i] !== candidate[i]) { diffCount++; diffPos = i; }
      }
      return diffCount === 1 && digits[diffPos] === '4' && candidate[diffPos] === '1';
    });
    if (preferred) {
      const corrected = formatBizNo(preferred);
      console.log('[YRG BG] 우선순위 선택 (4→1):', corrected);
      const { text: ctP, bizNo: cbP } = await callCarefulAndFind();
      if (cbP) {
        if (cbP !== corrected) console.log('[YRG BG] 우선순위 CAREFUL 재확인:', corrected, '→', cbP);
        return { success: true, text: cbP, approvalNo: approvalNo || extractApprovalNoText(ctP), cardBIN, merchantName, medicalFlag };
      }
      // CAREFUL도 유효 번호 못 찾음 → 자동 보정값 신뢰 불가, NTS 오조회 방지
      console.log('[YRG BG] 우선순위 보정 CAREFUL 실패 — 없음 반환:', corrected);
      return { success: true, text: '없음', approvalNo, cardBIN, merchantName, medicalFlag };
    }
    // 체크섬 실패 + 후보 다수 모호
    console.log('[YRG BG] 다수 후보 모호 (체크섬 실패), 없음 반환:', text);
    return { success: true, text: '없음', approvalNo, cardBIN, merchantName, medicalFlag };
  }

  return { success: true, text, approvalNo, cardBIN, merchantName, medicalFlag };
}

// OCR + 위변조 분석을 단일 Gemini 호출로 처리 (API 호출 2→1 감소)
async function geminiOCRAndTamperFromDataURL(dataURL) {
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  if (!geminiApiKey) return { success: false, error: 'NO_GEMINI_KEY' };

  const base64 = dataURL.split(',')[1];
  const rawMime = dataURL.match(/data:([^;]+)/)?.[1] || '';
  const mimeType = normalizeMimeType(rawMime, base64);

  const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const kstDateStr = `${kstNow.getUTCFullYear()}년 ${String(kstNow.getUTCMonth() + 1).padStart(2, '0')}월 ${String(kstNow.getUTCDate()).padStart(2, '0')}일`;
  const prompt = COMBINED_PROMPT.replace('${KST_DATE}', kstDateStr);

  // 단일 통합 호출 (maxOutputTokens=1024: 이유 필드가 길어질 수 있어 512→1024로 확장)
  let rawText = await callGeminiOCR(geminiApiKey, base64, mimeType, prompt, 1024);

  const isReceipt = rawText?.match(/영수증여부:\s*(예|아니오)/)?.[1] !== '아니오';
  if (!isReceipt) {
    console.log('[YRG BG] 비영수증 이미지 감지 — 검증 중단');
    return { success: true, isReceipt: false };
  }

  const fields = {
    text:         extractBizNoText(rawText),
    approvalNo:   extractApprovalNoText(rawText),
    cardBIN:      extractCardBINText(rawText),
    merchantName: extractMerchantNameText(rawText),
    medicalFlag:  extractMedicalFlagText(rawText),
    tamperResult: parseTamperResult(rawText, kstNow),
  };
  console.log('[YRG BG] 통합분석 — 상호명:', fields.merchantName || '없음', '/ 위변조판정:', fields.tamperResult?.verdict, `(${fields.tamperResult?.score}점)`);

  // 사업자번호 없음 → CAREFUL 재시도 (tamperResult는 이미 확보, bizNo만 재추출)
  if (fields.text === '없음') {
    console.log('[YRG BG] 없음, CAREFUL 재시도...');
    const carefulText = await callGeminiOCR(geminiApiKey, base64, mimeType, CAREFUL_PROMPT);
    const carefulBizNo = extractBizNoText(carefulText);
    // 체크섬 통과한 경우만 채택 — 할루시네이션 방지
    if (carefulBizNo !== '없음') {
      const carefulDigits = carefulBizNo.replace(/\D/g, '');
      if (carefulDigits.length === 10 && validateKoreanBizNo(carefulDigits)) {
        fields.text = carefulBizNo;
      } else {
        console.log('[YRG BG] CAREFUL 결과 체크섬 실패 — 없음 유지:', carefulBizNo);
      }
    }
    // 레이블 파싱이 없음이어도 응답 전체 스캔으로 유효 번호 탐색
    if (fields.text === '없음') {
      const scanned = findValidBizNoInText(carefulText);
      if (scanned) {
        console.log('[YRG BG] CAREFUL 전체 스캔 발견:', scanned);
        fields.text = scanned;
      }
    }
    if (!fields.approvalNo) fields.approvalNo = extractApprovalNoText(carefulText);
  }

  const { text, approvalNo, cardBIN, merchantName, medicalFlag, tamperResult } = fields;
  const digits = text.replace(/\D/g, '');

  if (digits.length === 10 && !validateKoreanBizNo(digits)) {
    // 공통 CAREFUL 헬퍼 — 응답 전체 스캔으로 체크섬 통과 번호 반환, 없으면 null
    const callCarefulAndFind = async () => {
      const t = await callGeminiOCR(geminiApiKey, base64, mimeType, CAREFUL_PROMPT);
      return { text: t, bizNo: findValidBizNoInText(t) };
    };

    // 1단계: 1↔4 혼동
    let fixes = findVisualFix(digits, SIMILAR_STAGE1);
    if (fixes.length === 1) {
      const corrected = formatBizNo(fixes[0]);
      console.log('[YRG BG] 1↔4 자동수정:', text, '→', corrected);
      const { text: ct1, bizNo: cb1 } = await callCarefulAndFind();
      if (cb1) {
        if (cb1 !== corrected) console.log('[YRG BG] Stage1 CAREFUL 재확인:', corrected, '→', cb1);
        return { success: true, isReceipt: true, text: cb1, approvalNo: approvalNo || extractApprovalNoText(ct1), cardBIN, merchantName, medicalFlag, tamperResult };
      }
      // CAREFUL 미확인 → 보정값 신뢰 불가, NTS 오조회 방지
      console.log('[YRG BG] Stage1 CAREFUL 실패 — 없음 반환:', corrected);
      return { success: true, isReceipt: true, text: '없음', approvalNo, cardBIN, merchantName, medicalFlag, tamperResult };
    }

    // 2단계: 확장 혼동 집합
    fixes = findVisualFix(digits, SIMILAR_STAGE2);
    if (fixes.length === 1) {
      const corrected = formatBizNo(fixes[0]);
      console.log('[YRG BG] 시각 유사 자동수정:', text, '→', corrected);
      const { text: ct2, bizNo: cb2 } = await callCarefulAndFind();
      if (cb2) {
        if (cb2 !== corrected) console.log('[YRG BG] Stage2 CAREFUL 재확인:', corrected, '→', cb2);
        return { success: true, isReceipt: true, text: cb2, approvalNo: approvalNo || extractApprovalNoText(ct2), cardBIN, merchantName, medicalFlag, tamperResult };
      }
      // CAREFUL 미확인 → 보정값 신뢰 불가, NTS 오조회 방지
      console.log('[YRG BG] Stage2 CAREFUL 실패 — 없음 반환:', corrected);
      return { success: true, isReceipt: true, text: '없음', approvalNo, cardBIN, merchantName, medicalFlag, tamperResult };
    }

    // 3단계: 후보 다수 → 4→1 단일 치환 우선
    const preferred = fixes.find(candidate => {
      let diffCount = 0, diffPos = -1;
      for (let i = 0; i < 10; i++) {
        if (digits[i] !== candidate[i]) { diffCount++; diffPos = i; }
      }
      return diffCount === 1 && digits[diffPos] === '4' && candidate[diffPos] === '1';
    });
    if (preferred) {
      const corrected = formatBizNo(preferred);
      console.log('[YRG BG] 우선순위 선택 (4→1):', corrected);
      const { text: ctP, bizNo: cbP } = await callCarefulAndFind();
      if (cbP) {
        if (cbP !== corrected) console.log('[YRG BG] 우선순위 CAREFUL 재확인:', corrected, '→', cbP);
        return { success: true, isReceipt: true, text: cbP, approvalNo: approvalNo || extractApprovalNoText(ctP), cardBIN, merchantName, medicalFlag, tamperResult };
      }
      // CAREFUL도 유효 번호 못 찾음 → 자동 보정값 신뢰 불가, NTS 오조회 방지
      console.log('[YRG BG] 우선순위 보정 CAREFUL 실패 — 없음 반환:', corrected);
      return { success: true, isReceipt: true, text: '없음', approvalNo, cardBIN, merchantName, medicalFlag, tamperResult };
    }
    // 체크섬 실패 + 후보 다수 모호
    console.log('[YRG BG] 다수 후보 모호 (체크섬 실패), 없음 반환:', text);
    return { success: true, isReceipt: true, text: '없음', approvalNo, cardBIN, merchantName, medicalFlag, tamperResult };
  }

  return { success: true, isReceipt: true, text, approvalNo, cardBIN, merchantName, medicalFlag, tamperResult };
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

// BIN 시각 유사 숫자 치환 맵 (단일 자리 OCR 오독 교정용)
const BIN_SIMILAR = {
  '0': ['6', '9'], '1': ['7'], '3': ['8'], '5': ['6'],
  '6': ['5', '0'], '7': ['1'], '8': ['3'], '9': ['0']
};

// 로컬 한국 BIN DB 내에서 단일 자리 시각 유사 치환 후보 탐색 (API 호출 없음)
// 반환: 교정된 BIN 문자열 또는 null
function tryBINVisualFix(bin) {
  if (!_binKorea) return null;
  for (let pos = 0; pos < bin.length; pos++) {
    for (const alt of (BIN_SIMILAR[bin[pos]] || [])) {
      const candidate = bin.slice(0, pos) + alt + bin.slice(pos + 1);
      if (_binKorea[candidate]) return candidate;
    }
  }
  return null;
}

async function verifyCardBIN(bin) {
  if (!bin || !/^\d{4,6}$/.test(bin)) {
    console.log('[YRG BG] BIN 검증 스킵 — 형식 오류:', bin);
    return { valid: true, skip: true, reason: 'BIN 형식 오류' };
  }

  // 한국 이동통신 번호 앞자리 — 현금영수증 발행번호이며 카드 BIN이 아님
  if (/^01[016789]/.test(bin)) {
    console.log('[YRG BG] BIN 검증 스킵 — 현금영수증 (휴대폰번호 패턴):', bin);
    return { valid: true, skip: true, reason: '현금영수증 (휴대폰번호 BIN)' };
  }

  // 앞 4자리만 표시된 경우 → 브랜드 식별 또는 국내 DB prefix 조회
  if (bin.length === 4) {
    const scheme = detectCardSchemeFrom4(bin);
    if (scheme) {
      console.log('[YRG BG] BIN 4자리 브랜드 식별 통과:', bin, scheme);
      return { valid: true, bin, scheme, source: 'scheme-4digit' };
    }
    // 국제 스킴 미매칭 → 국내 DB에서 4자리 prefix 조회 (BC카드 등 국내 전용 카드 대응)
    try {
      await loadBinData();
      const hasKoreanMatch = Object.keys(_binKorea).some(k => k.startsWith(bin));
      if (hasKoreanMatch) {
        console.log('[YRG BG] BIN 4자리 국내 DB prefix 매칭 통과:', bin);
        return { valid: true, bin, source: 'korean-4digit-prefix' };
      }
    } catch (e) {}
    // 4자리 + 국내 DB prefix 미매칭 + 표준 스킴 미해당 → 카드번호 없는 영수증 추정
    console.log('[YRG BG] BIN 4자리 검증 스킵 — 비표준 범위 + DB 미등록 (카드번호 없는 영수증 추정):', bin);
    return { valid: true, skip: true, reason: '카드번호 형식 아님 (비표준 4자리 BIN)' };
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

    // 로컬 DB 미등록 → 시각 유사 숫자 1자리 교정 시도 (예: 5↔6 혼동으로 오추출된 경우)
    const visualFixed = tryBINVisualFix(bin);
    if (visualFixed) {
      const d = _binKorea[visualFixed];
      console.log('[YRG BG] BIN 시각 유사 교정:', bin, '→', visualFixed, d.i);
      return { valid: true, bin: visualFixed, originalBIN: bin, issuer: d.i, type: d.t, source: 'local-korea-visual-fix' };
    }
  } catch (loadErr) {
    console.warn('[YRG BG] 로컬 BIN 데이터 로드 실패, API로 fallback:', loadErr.message);
  }

  // 로컬 DB 미등록 — 주요 카드사 범위 사전 검사
  const scheme = detectCardScheme(bin);
  if (!scheme) {
    // 로컬 DB(국내+국제) 미등록 + 표준 카드 스킴 범위 미해당
    // → 카드번호 없는 영수증에서 Gemini가 다른 숫자(승인번호·고객번호 등)를 BIN으로 잘못 추출한 것으로 판단
    console.log('[YRG BG] BIN 검증 스킵 — 비표준 범위 + 로컬 미등록 (카드번호 없는 영수증 추정):', bin);
    return { valid: true, skip: true, reason: '카드번호 형식 아님 (비표준 BIN)' };
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
  // 메모리 캐시 확인 (1시간 TTL — 동일 사업자번호 반복 검증 시 API 생략)
  const _cached = _ntsCache.get(bizNo);
  if (_cached && _cached.expiresAt > Date.now()) {
    console.log('[YRG BG] NTS 캐시 히트:', bizNo);
    return _cached.result;
  }

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
      const result = { success: true, bizNo, status: 'unregistered', statusText: '국세청미등록' };
      _ntsCache.set(bizNo, { result, expiresAt: Date.now() + NTS_CACHE_TTL_MS });
      return result;
    }

    const mapped = STATUS_MAP[item.b_stt_cd] || { status: 'unregistered', statusText: '국세청미등록' };
    const result = { success: true, bizNo, ...mapped, taxType: item.tax_type || '', endDate: item.end_dt || '' };
    _ntsCache.set(bizNo, { result, expiresAt: Date.now() + NTS_CACHE_TTL_MS });
    return result;

  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return { success: false, error: 'TIMEOUT', message: '요청 시간이 초과되었습니다 (10초).' };
    }
    throw err;
  }
}
