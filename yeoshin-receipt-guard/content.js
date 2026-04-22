// content.js — 어드민 페이지 DOM 주입 + 이미지 분석 + 결과 UI

(function init() {
  try {
    // lib/exif.js, lib/blockhash.js 는 manifest content_scripts 에서 먼저 로드됨
    scanAndInject();
    observeDOM();
  } catch (e) {
    console.warn('[YRG] 초기화 오류:', e.message);
  }
})();

// ── 2. 버튼 위치 관리 (body 포털 방식 — DOM 구조 불변) ───────

// imgEl → buttonEl 매핑 (스크롤/리사이즈 시 위치 재계산용)
const yrgButtonMap = new Map();

function updateAllPositions() {
  for (const [img, btn] of yrgButtonMap) {
    if (!document.body.contains(img)) {
      btn.remove();
      yrgButtonMap.delete(img);
      continue;
    }
    const rect = img.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      btn.style.display = 'none';
    } else {
      btn.style.display = '';
      btn.style.top  = (rect.top  + 8) + 'px';
      btn.style.right = (window.innerWidth - rect.right + 8) + 'px';
    }
  }
}

window.addEventListener('scroll', updateAllPositions, { passive: true, capture: true });
window.addEventListener('resize', updateAllPositions, { passive: true });

// ── 3. 이미지 탐지 및 버튼 주입 ─────────────────────────────

function scanAndInject() {
  document.querySelectorAll('img').forEach(img => {
    if (isReceiptImage(img)) injectVerifyButton(img);
  });
}

// '영수증 사진' 컬럼 인덱스 캐시 (-1 = 미발견)
let yrgReceiptColIndex = -1;

function findReceiptColumnIndex() {
  // 테이블 헤더에서 '영수증 사진' 텍스트를 가진 th/td 위치를 찾아 캐시
  const headerCells = document.querySelectorAll('table thead tr th, table thead tr td, table tr:first-child th');
  for (const cell of headerCells) {
    if (cell.textContent.trim() === '영수증 사진') {
      const row = cell.closest('tr');
      if (row) {
        yrgReceiptColIndex = Array.from(row.children).indexOf(cell);
        return yrgReceiptColIndex;
      }
    }
  }
  return -1;
}

function isReceiptImage(img) {
  if (img.dataset.yrgInjected) return false;

  // 이미지가 테이블 셀(td) 안에 있는지 확인
  const td = img.closest('td');
  if (!td) return false;

  // 컬럼 인덱스가 캐시되지 않았으면 탐색
  if (yrgReceiptColIndex === -1) findReceiptColumnIndex();
  if (yrgReceiptColIndex === -1) return false;

  // 이미지가 속한 td의 컬럼 인덱스와 '영수증 사진' 컬럼 인덱스 비교
  const tr = td.closest('tr');
  if (!tr) return false;
  const tdIndex = Array.from(tr.children).indexOf(td);

  return tdIndex === yrgReceiptColIndex;
}

function injectVerifyButton(imgEl) {
  if (imgEl.dataset.yrgInjected) return;
  imgEl.dataset.yrgInjected = 'true';

  const button = document.createElement('button');
  button.className = 'yrg-verify-btn';
  button.innerHTML = '🔍 영수증 검증';
  button.title = 'Yeoshin Receipt Guard — 클릭하여 검증 시작';
  button.addEventListener('mousedown', () => {
    chrome.runtime.sendMessage({ type: 'PING' });
  }, { passive: true });
  button.addEventListener('click', (e) => {
    // stopPropagation 미사용 — 어드민 클릭 핸들러를 차단하지 않음
    e.preventDefault();
    verifyReceipt(imgEl, button);
  });

  // 이미지 DOM 구조를 변경하지 않고 body에 직접 추가 (포털 방식)
  document.body.appendChild(button);
  yrgButtonMap.set(imgEl, button);

  // 초기 위치 설정
  const rect = imgEl.getBoundingClientRect();
  button.style.top   = (rect.top  + 8) + 'px';
  button.style.right = (window.innerWidth - rect.right + 8) + 'px';
}

// ── 3. DOM 변경 감시 (동적 페이지 대응) ─────────────────────

function observeDOM() {
  let scanTimer = null;

  const observer = new MutationObserver(() => {
    // 400ms 디바운스 — 빈번한 DOM 변경 시 어드민 성능 영향 최소화
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      yrgReceiptColIndex = -1; // 테이블 재렌더링 시 컬럼 인덱스 재탐색
      scanAndInject();
    }, 400);
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// ── 4. 이미지 분석 함수 ──────────────────────────────────────

function resolveFullSizeURL(imgEl) {
  // 썸네일 → 원본 이미지 URL 탐색 순서
  const candidates = [
    imgEl.dataset.original,
    imgEl.dataset.fullSrc,
    imgEl.dataset.zoomImage,
    imgEl.dataset.url,
    imgEl.dataset.src,
    imgEl.closest('a')?.href,
  ];
  for (const url of candidates) {
    if (url && url.startsWith('http') && /\.(jpe?g|png|webp|gif)/i.test(url)) {
      return url;
    }
  }
  // URL 썸네일 파라미터 제거 시도 (예: ?w=80&h=80 → 원본)
  try {
    const u = new URL(imgEl.src);
    ['w', 'h', 'width', 'height', 'size', 'thumb', 'resize'].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch {
    return imgEl.src;
  }
}

async function getImageDataURL(imgEl) {
  const src = resolveFullSizeURL(imgEl);

  // fetch 우선: credentials 제외해야 CDN(S3 등) CORS 정책 통과
  try {
    const resp = await fetch(src, { credentials: 'omit' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    // SVG는 Gemini Vision API 미지원 → Canvas 방식으로 PNG 변환
    if (blob.type === 'image/svg+xml' || /\.svg(\?|$)/i.test(src)) {
      throw new Error('SVG 포맷 — Canvas PNG 변환 필요');
    }
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (fetchErr) {
    console.warn('[YRG] fetch 실패, Canvas 방식으로 폴백:', fetchErr.message);
  }

  // 폴백: Canvas 방식
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      // SVG는 naturalWidth/Height가 0일 수 있으므로 렌더링 크기도 함께 확인
      canvas.width  = img.naturalWidth  || img.width  || 800;
      canvas.height = img.naturalHeight || img.height || 600;
      if (canvas.width < 1 || canvas.height < 1) { canvas.width = 800; canvas.height = 600; }
      ctx.drawImage(img, 0, 0);
      try {
        resolve(canvas.toDataURL('image/png'));
      } catch (e) {
        reject(new Error('이미지 접근 불가 (CORS) — manifest의 host_permissions 도메인을 확인해 주세요.'));
      }
    };
    img.onerror = () => reject(new Error('이미지 로드 실패'));
    img.src = src;
  });
}

async function analyzeEXIF(imgEl) {
  return new Promise((resolve) => {
    if (typeof EXIF === 'undefined') {
      resolve({ isTampered: false, software: null, error: true, errorMsg: 'exif.js 로드 실패' });
      return;
    }
    try {
      EXIF.getData(imgEl, function () {
        const software = EXIF.getTag(this, 'Software') || '';
        const make = EXIF.getTag(this, 'Make') || '';
        const processingSoftware = EXIF.getTag(this, 'ProcessingSoftware') || '';

        const EDIT_TOOLS = [
          'photoshop', 'gimp', 'lightroom', 'paint.net', 'affinity',
          'canva', 'snapseed', 'pixlr', 'inkscape', 'illustrator'
        ];

        const allSoftware = `${software} ${make} ${processingSoftware}`.toLowerCase();
        const foundTool = EDIT_TOOLS.find(tool => allSoftware.includes(tool));

        const allTags = EXIF.getAllTags(this);

        resolve({
          isTampered: !!foundTool,
          software: foundTool ? (software || processingSoftware) : null,
          allTags
        });
      });
    } catch (e) {
      resolve({ isTampered: false, software: null, error: true, errorMsg: e.message });
    }
  });
}

async function extractHash(imgEl) {
  try {
    if (typeof blockhash === 'undefined') {
      return { hash: null, error: true };
    }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = imgEl.naturalWidth || 256;
    canvas.height = imgEl.naturalHeight || 256;
    ctx.drawImage(imgEl, 0, 0);
    const hash = blockhash(canvas, 16);
    return { hash };
  } catch (e) {
    return { hash: null, error: true };
  }
}

// ── 5. 픽셀 수준 그림판 편집 탐지 ──────────────────────────────
// 원리: 그림판 지우개+재입력 시 편집 영역이 주변 배경 노이즈보다
//       비정상적으로 균일해짐(분산≈0). 텍스처가 있는 주변 블록과 비교해 탐지.
async function analyzeImageNoise(dataURL) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const MAX = 480;
        const sw = img.naturalWidth  || img.width  || 400;
        const sh = img.naturalHeight || img.height || 400;
        const scale = Math.min(1, MAX / Math.max(sw, sh));
        const w = Math.max(8, Math.round(sw * scale));
        const h = Math.max(8, Math.round(sh * scale));

        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);

        const BLOCK = 8;
        const cols = Math.floor(w / BLOCK);
        const rows = Math.floor(h / BLOCK);
        if (cols < 3 || rows < 3) return resolve({ isPaintSuspect: false });

        // 블록별 분산 + 평균 밝기 계산
        const varGrid  = Array.from({ length: rows }, () => new Float32Array(cols));
        const meanGrid = Array.from({ length: rows }, () => new Float32Array(cols));
        for (let br = 0; br < rows; br++) {
          for (let bc = 0; bc < cols; bc++) {
            let sum = 0;
            const vals = [];
            for (let y = br * BLOCK; y < (br + 1) * BLOCK; y++) {
              for (let x = bc * BLOCK; x < (bc + 1) * BLOCK; x++) {
                const i = (y * w + x) * 4;
                const g = data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114;
                vals.push(g); sum += g;
              }
            }
            const mean = sum / vals.length;
            meanGrid[br][bc] = mean;
            varGrid[br][bc] = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
          }
        }

        // 기울어진 영수증 가장자리 배경 노출 제외: 이미지 크기의 10% 테두리 제거
        const borderRows = Math.max(2, Math.round(rows * 0.10));
        const borderCols = Math.max(2, Math.round(cols * 0.10));

        // 1차: 후보 블록 탐지 (주변 8방향 대비 극도로 평탄한 블록)
        const suspicious = Array.from({ length: rows }, () => new Uint8Array(cols));
        for (let br = borderRows; br < rows - borderRows; br++) {
          for (let bc = borderCols; bc < cols - borderCols; bc++) {
            const v = varGrid[br][bc];
            if (v > 1.5) continue;
            const neighborMean = (
              varGrid[br-1][bc-1] + varGrid[br-1][bc] + varGrid[br-1][bc+1] +
              varGrid[br  ][bc-1]                     + varGrid[br  ][bc+1] +
              varGrid[br+1][bc-1] + varGrid[br+1][bc] + varGrid[br+1][bc+1]
            ) / 8;
            if (neighborMean > 20 && v < 0.8) suspicious[br][bc] = 1;
          }
        }

        // 2차: 클러스터 필터 + 밝기 수집 — 인접 의심 블록 없는 고립 블록 제외
        let suspiciousBlocks = 0;
        let brightSum = 0, brightCount = 0;
        for (let br = borderRows; br < rows - borderRows; br++) {
          for (let bc = borderCols; bc < cols - borderCols; bc++) {
            if (!suspicious[br][bc]) continue;
            const hasNeighbor = suspicious[br-1][bc] || suspicious[br+1][bc] ||
                                 suspicious[br][bc-1] || suspicious[br][bc+1];
            if (!hasNeighbor) continue;
            suspiciousBlocks++;
            // 해당 블록 중심 픽셀 밝기 샘플링
            const cy = (br * BLOCK + BLOCK / 2) | 0;
            const cx = (bc * BLOCK + BLOCK / 2) | 0;
            const idx = (cy * w + cx) * 4;
            brightSum += data[idx] * 0.299 + data[idx+1] * 0.587 + data[idx+2] * 0.114;
            brightCount++;
          }
        }

        const totalInner = (rows - 2 * borderRows) * (cols - 2 * borderCols);
        const ratio = suspiciousBlocks / Math.max(1, totalInner);
        const isPaintSuspect = ratio > 0.04 && suspiciousBlocks >= 3;

        // 편집 유형 힌트: 의심 블록 평균 밝기로 흰색 덮어쓰기(교체) vs 어두운 가림(은닉) 구분
        let editHint = null;
        if (suspiciousBlocks >= 3) {
          const avgBright = brightCount > 0 ? brightSum / brightCount : 0;
          editHint = avgBright > 220 ? '교체' : '은닉';
        }

        // 흰색 덮어쓰기 전용 탐지 — JPEG 압축 허용 (absolute threshold 대신 이웃 대비 상대 비율)
        // 기존 suspicious(분산<0.8)와 독립적 패스: 밝기>215 + 분산이 이웃 대비 12% 미만 + 이웃 평균 분산>20
        const brightSusp = Array.from({ length: rows }, () => new Uint8Array(cols));
        for (let br = borderRows; br < rows - borderRows; br++) {
          for (let bc = borderCols; bc < cols - borderCols; bc++) {
            if (meanGrid[br][bc] < 215) continue;
            const v = varGrid[br][bc];
            const neighborMean = (
              varGrid[br-1][bc-1] + varGrid[br-1][bc] + varGrid[br-1][bc+1] +
              varGrid[br  ][bc-1]                     + varGrid[br  ][bc+1] +
              varGrid[br+1][bc-1] + varGrid[br+1][bc] + varGrid[br+1][bc+1]
            ) / 8;
            // 이웃 분산이 충분히 높고(텍스처), 현재 블록이 이웃 대비 매우 균일한 경우
            if (neighborMean > 20 && v < neighborMean * 0.12) brightSusp[br][bc] = 1;
          }
        }
        let brightBlocks = 0;
        for (let br = borderRows; br < rows - borderRows; br++) {
          for (let bc = borderCols; bc < cols - borderCols; bc++) {
            if (!brightSusp[br][bc]) continue;
            const hasNeighbor = brightSusp[br-1][bc] || brightSusp[br+1][bc] ||
                                 brightSusp[br][bc-1] || brightSusp[br][bc+1];
            if (hasNeighbor) brightBlocks++;
          }
        }
        // 면적 비율(4%) 미달이라도 흰색 균일 클러스터 5개 이상이면 국소 흰색 교체 의심
        const isWhiteEditSuspect = brightBlocks >= 5;

        console.log('[YRG] 노이즈 분석: 의심블록', suspiciousBlocks, '/', totalInner, `(${Math.round(ratio*100)}%)`, `밝은클러스터:${brightBlocks}`, `흰색교체의심:${isWhiteEditSuspect}`, editHint ? `편집힌트:${editHint}` : '');
        resolve({ isPaintSuspect, isWhiteEditSuspect, suspiciousBlocks, brightBlocks, ratio: Math.round(ratio * 100), editHint });
      } catch (e) {
        resolve({ isPaintSuspect: false, error: e.message });
      }
    };
    img.onerror = () => resolve({ isPaintSuspect: false });
    img.src = dataURL;
  });
}

// Gemini 전송용 이미지 압축 — 최대 1280px + JPEG 변환 (픽셀 분석용 원본과 분리)
function compressImageForGemini(dataURL) {
  const MAX = 1280;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const scale = Math.min(1, MAX / Math.max(w, h, 1));
      if (scale === 1 && dataURL.startsWith('data:image/jpeg')) { resolve(dataURL); return; }
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const compressed = canvas.toDataURL('image/jpeg', 0.88);
      console.log('[YRG] Gemini 이미지 압축:', dataURL.length, '→', compressed.length, `(${Math.round(compressed.length / dataURL.length * 100)}%)`);
      resolve(compressed);
    };
    img.onerror = () => resolve(dataURL);
    img.src = dataURL;
  });
}

// OCR은 Gemini Vision API로 처리 (background 경유)
async function runOCR(dataURL) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('OCR 요청 타임아웃 (30초)')), 30000);

    chrome.runtime.sendMessage({ type: 'RUN_OCR', dataURL }, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.error === 'NO_GEMINI_KEY') {
        reject(new Error('NO_GEMINI_KEY'));
        return;
      }
      if (!response?.success) {
        reject(new Error(response?.error || 'OCR 실패'));
        return;
      }
      resolve({ text: response.text, approvalNo: response.approvalNo || null, cardBIN: response.cardBIN || null, isReceipt: response.isReceipt !== false });
    });
  });
}

function extractBusinessNumber(text) {
  if (!text) return [];

  // OCR 오인식 교정: 숫자처럼 생긴 문자 치환
  // 앞뒤가 숫자인 경우에만 치환해 한글/영문 오염 방지
  const ctxReplace = (char, replacement) => (c, offset, str) => {
    const prev = str[offset - 1];
    const next = str[offset + 1];
    return (/\d/.test(prev) || /\d/.test(next)) ? replacement : c;
  };

  const normalized = text
    .replace(/\r\n|\r/g, '\n')           // 줄바꿈 정규화
    .replace(/[Oo]/g,  '0')             // O/o → 0
    .replace(/[lI|]/g, '1')             // l/I/| → 1
    .replace(/[Ss]/g, ctxReplace('S', '5')) // S → 5 (문맥 조건)
    .replace(/[Zz]/g, ctxReplace('Z', '2')) // Z → 2
    .replace(/[Bb]/g, ctxReplace('B', '8')) // B → 8
    .replace(/[Gg]/g, ctxReplace('G', '6')) // G → 6
    .replace(/[q]/g,  ctxReplace('q', '9')) // q → 9
    .replace(/[Tt]/g, ctxReplace('T', '7')); // T → 7 (드물지만 7과 혼동)

  const results = new Set();

  // 3-2-5 형식: XXX-XX-XXXXX
  // 구분자: -, ·, ., 공백, 줄바꿈, 콤마, 슬래시 등 OCR 오인식 구분자 폭넓게 허용
  // {1,3}: 구분자가 여러 개 연속될 수 있음 (OCR이 공백을 여러 개로 인식)
  const pattern = /(\d{3})[\s\-·.\u00B7,/\\:\n]{1,3}(\d{2})[\s\-·.\u00B7,/\\:\n]{1,3}(\d{5})/g;
  for (const m of normalized.matchAll(pattern)) {
    results.add(m[1] + m[2] + m[3]);
  }

  return [...results].filter(n => n.length === 10);
}

// ── 5. 중복 해시 비교 (background로 위임) ───────────────────

async function compareHash(hash, approvalNo) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'MANAGE_HASHES', hash, approvalNo }, (response) => {
      if (chrome.runtime.lastError || !response) {
        resolve({ isDuplicate: false, error: true });
        return;
      }
      resolve(response);
    });
  });
}

// ── 6. 시각적 위변조 분석 (background로 위임) ─────────────────

async function analyzeTamper(dataURL) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ tamperLevel: 'unknown', reason: '타임아웃' }), 35000);
    chrome.runtime.sendMessage({ type: 'ANALYZE_TAMPER', dataURL }, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError || !response) {
        resolve({ tamperLevel: 'unknown', error: true });
        return;
      }
      resolve(response);
    });
  });
}

// ── 7. 카드 BIN 검증 (background로 위임) ─────────────────────

async function checkCardBIN(bin) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ valid: true, skip: true, reason: '타임아웃' }), 10000);
    chrome.runtime.sendMessage({ type: 'VERIFY_CARD_BIN', bin }, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError || !response) {
        resolve({ valid: true, skip: true });
        return;
      }
      resolve(response);
    });
  });
}

// ── 7. 국세청 API 검증 (background로 위임) ───────────────────

async function verifyBusinessNumber(bizNo) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('background 응답 타임아웃'));
    }, 15000);

    chrome.runtime.sendMessage(
      { type: 'VERIFY_BIZ_NUMBER', bizNo },
      (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      }
    );
  });
}

// ── 7. 순차 검증 단계 함수 ──────────────────────────────────────

// 1단계: 사업자등록번호 계속사업자 확인
async function step1BizNo(bizNo) {
  if (!bizNo) return { pass: true };
  try {
    const api = await verifyBusinessNumber(bizNo);
    if (!api.success) {
      const msg = api.error === 'NO_API_KEY'
        ? '[1단계] 사업자 검증 불가 — API Key 미설정 (옵션에서 설정해 주세요)'
        : `[1단계] 사업자 검증 실패 — 국세청 API 오류: ${api.message || '알 수 없는 오류'}`;
      return { pass: false, verdict: { status: 'reject', icon: '🔴', title: '반려', reasons: [msg] } };
    }
    if (api.status !== 'active') {
      const reasons = [`[1단계] 사업자 검증 실패 — 사업자 상태: ${api.statusText}`];
      if (api.bizNo) reasons.push(`사업자번호: ${api.bizNo}`);
      if (api.endDate) reasons.push(`폐업일: ${api.endDate}`);
      return { pass: false, verdict: { status: 'reject', icon: '🔴', title: '반려', reasons } };
    }
    return { pass: true };
  } catch (err) {
    return { pass: false, verdict: { status: 'reject', icon: '🔴', title: '반려', reasons: [`[1단계] 사업자 검증 오류: ${err.message}`] } };
  }
}

// 2단계: 카드 BIN 규칙 검증
async function step2CardBIN(bin) {
  if (!bin) return { pass: true };
  const result = await checkCardBIN(bin).catch(() => ({ valid: true, skip: true }));
  if (result.valid === false) {
    return {
      pass: false,
      verdict: {
        status: 'reject', icon: '🔴', title: '반려',
        reasons: [`[2단계] 카드번호 검증 실패 — ${result.reason || '유효하지 않은 카드번호'}${result.bin ? ` (BIN: ${result.bin})` : ''}`]
      }
    };
  }
  return { pass: true };
}

// 3단계: 이미지 위변조 탐지 (EXIF + 픽셀 노이즈 + 중복 해시 + Gemini)
async function step3Tamper(imgEl, dataURL, hashInfo, preloaded = {}) {
  const exifResult = await (preloaded.exif || analyzeEXIF(imgEl).catch(() => ({ isTampered: false, error: true })));
  if (exifResult.isTampered) {
    return {
      pass: false,
      verdict: { status: 'reject', icon: '🔴', title: '반려', reasons: [`[3단계] 위변조 탐지 — 이미지 편집 흔적 감지: ${exifResult.software}`] }
    };
  }

  // 픽셀 노이즈 + 중복 해시 병렬 처리
  const [noiseResult, dupResult] = await Promise.all([
    preloaded.noise || analyzeImageNoise(dataURL).catch(() => ({ isPaintSuspect: false })),
    (hashInfo.hash || hashInfo.approvalNo)
      ? compareHash(hashInfo.hash, hashInfo.approvalNo).catch(() => ({ isDuplicate: false }))
      : Promise.resolve({ isDuplicate: false })
  ]);

  if (dupResult.isDuplicate) {
    const prevDate = dupResult.savedAt ? new Date(dupResult.savedAt).toLocaleString('ko-KR') : '알 수 없음';
    const reason = dupResult.reason === 'approvalNo' ? '승인번호 일치' : '이미지 유사도 일치';
    return {
      pass: false,
      verdict: { status: 'reject', icon: '🔴', title: '반려', reasons: [`[3단계] 위변조 탐지 — 중복 영수증 (${reason}) — 이전 검증: ${prevDate}`] }
    };
  }

  const tamperResult = await (preloaded.tamper || analyzeTamper(dataURL).catch(() => ({ tamperLevel: 'unknown', error: true })));

  // ── 편집 위치·유형 분류 판정 (주 신호: Gemini, 보조 신호: 픽셀 시그니처) ──────
  const { editLocation, editType } = tamperResult;

  if (editLocation === '거래핵심정보') {
    return {
      pass: false,
      verdict: { status: 'reject', icon: '🔴', title: '반려',
        reasons: [`[3단계] 위변조 탐지 — 거래 핵심 정보(거래일시·금액·가맹점 등)가 편집된 흔적이 있습니다. (편집유형: ${editType})`] }
    };
  }
  if (editLocation === '카드정보' && editType === '교체') {
    return {
      pass: false,
      verdict: { status: 'reject', icon: '🔴', title: '반려',
        reasons: ['[3단계] 위변조 탐지 — 카드 정보가 교체 편집된 흔적이 있습니다.'] }
    };
  }
  // 카드정보 + 은닉 → 개인정보 보호 처리로 간주, tamperLevel 판정으로 진행

  // 픽셀 시그니처 보조 신호 — Gemini 편집부위 미감지 시에만 활용
  if ((noiseResult.isPaintSuspect || noiseResult.isWhiteEditSuspect) && editLocation === '없음') {
    const paintReason = noiseResult.isWhiteEditSuspect
      ? `픽셀 분석: 흰색 덮어쓰기 편집 의심 — 텍스처 영역 안에 균일한 흰색 블록 ${noiseResult.brightBlocks}개 감지`
      : `픽셀 분석: 편집 도구로 지워진 영역 의심 (이상 블록 ${noiseResult.suspiciousBlocks}개, ${noiseResult.ratio}%)`;
    console.log('[YRG]', paintReason);
    const geminiClean = tamperResult.score === 0 && tamperResult.verdict === '정상';
    const whiteOverwriteDetected = noiseResult.isWhiteEditSuspect;
    if (whiteOverwriteDetected || (!geminiClean && (!tamperResult.tamperLevel || tamperResult.tamperLevel === 'low' || tamperResult.tamperLevel === 'unknown'))) {
      tamperResult.tamperLevel = 'medium';
      if (whiteOverwriteDetected) {
        // 픽셀이 주 반려 근거 — Gemini 이유 덮어쓰기, score 표시 제거
        tamperResult.reason = paintReason;
        tamperResult.score = null;
        tamperResult.editType = '교체';
      } else {
        tamperResult.reason = tamperResult.reason && tamperResult.reason !== '이상 없음'
          ? `${tamperResult.reason} / ${paintReason}`
          : paintReason;
      }
    }
  }

  if (tamperResult.isMultipleReceipts) {
    return {
      pass: false,
      verdict: { status: 'reject', icon: '🔴', title: '반려',
        reasons: ['[3단계] 검증 불가 — 이미지에 영수증이 여러 장 포함되어 있습니다. 영수증 1장씩 업로드해 주세요.'] }
    };
  }

  if (tamperResult.tamperLevel === 'high' || tamperResult.tamperLevel === 'medium') {
    return {
      pass: false,
      verdict: { status: 'reject', icon: '🔴', title: '반려', reasons: [tamperResult.score != null ? `[3단계] 위변조 탐지 — ${tamperResult.reason} (신뢰도: ${tamperResult.score}점/100)` : `[3단계] 위변조 탐지 — ${tamperResult.reason}`] },
      tamperResult
    };
  }

  return { pass: true, tamperResult };
}

// 4단계: AI 생성 이미지 탐지 (3단계 Gemini 응답 재사용, 추가 API 호출 없음)
function step4AI(tamperResult) {
  if (!tamperResult || !tamperResult.isSuspectedAI) return { pass: true };
  return {
    pass: false,
    verdict: { status: 'reject', icon: '🔴', title: '반려', reasons: ['[4단계] AI 생성 이미지 탐지 — 생성형 AI로 만든 영수증으로 의심됩니다'] }
  };
}

function buildApprovalReasons(bizNo, cardBIN) {
  const reasons = [];
  if (bizNo) reasons.push(`사업자번호: ${bizNo} — 계속사업자 확인`);
  if (cardBIN) reasons.push(`카드 BIN: ${cardBIN} — 유효한 카드번호`);
  reasons.push('이미지 위변조 흔적 없음', 'AI 생성 이미지 아님');
  return reasons;
}

// ── 8. 메인 검증 흐름 ───────────────────────────────────────

async function verifyReceipt(imgEl, button) {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) {
    showModal(null, {
      status: 'caution', icon: '🟡', title: 'API Key 미설정',
      reasons: ['확장 프로그램 아이콘 우클릭 → "옵션"에서 공공데이터포털 API Key를 먼저 입력해 주세요.']
    });
    return;
  }

  showSpinner(button);

  try {
    const dataURL = await getImageDataURL(imgEl).catch(e => {
      console.warn('[YRG] 이미지 dataURL 취득 실패:', e.message);
      return null;
    });
    if (!dataURL) throw new Error('이미지를 불러올 수 없습니다. (CORS 또는 네트워크 오류)');
    console.log('[YRG] 이미지 dataURL 취득 완료, 길이:', dataURL.length);

    // Gemini 압축 + 로컬 분석 동시 시작
    const geminiImgPromise = compressImageForGemini(dataURL);
    const hashPromise   = extractHash(imgEl).catch(() => ({ hash: null, error: true }));
    const exifPromise   = analyzeEXIF(imgEl).catch(() => ({ isTampered: false, error: true }));
    const noisePromise  = analyzeImageNoise(dataURL).catch(() => ({ isPaintSuspect: false }));

    // 압축 완료(~20ms) 후 Gemini 호출 시작 — 노이즈 분석은 원본 유지
    const geminiImg = await geminiImgPromise;
    const ocrPromise    = runOCR(geminiImg).catch(e => { if (e.message === 'NO_GEMINI_KEY') throw e; console.warn('[YRG] OCR 오류:', e.message); return null; });
    const tamperPromise = analyzeTamper(geminiImg).catch(() => ({ tamperLevel: 'unknown', error: true }));

    // OCR 완료 후 비영수증 조기 반려 체크
    const ocrRaw = await ocrPromise;
    if (ocrRaw?.isReceipt === false) {
      showModal(imgEl, {
        status: 'reject', icon: '🔴', title: '반려',
        reasons: ['[0단계] 영수증 이미지가 아닙니다 — 카드 영수증 이미지를 업로드해 주세요.']
      });
      return;
    }

    // 1·2단계 병렬 실행
    const bizNumbers = extractBusinessNumber(ocrRaw?.text);
    const bizNo      = bizNumbers[0] || null;
    const cardBIN    = ocrRaw?.cardBIN    || null;
    const approvalNo = ocrRaw?.approvalNo || null;

    const [r1, r2] = await Promise.all([step1BizNo(bizNo), step2CardBIN(cardBIN)]);
    if (!r1.pass) { showModal(imgEl, r1.verdict); return; }
    if (!r2.pass) { showModal(imgEl, r2.verdict); return; }

    // ── 3단계: 이미지 위변조 탐지 (사전 시작된 프로미스 재사용) ───────
    const hashResult = await hashPromise;
    const hashInfo = { hash: hashResult.hash, approvalNo };
    const r3 = await step3Tamper(imgEl, dataURL, hashInfo, { exif: exifPromise, noise: noisePromise, tamper: tamperPromise });
    if (!r3.pass) { showModal(imgEl, r3.verdict); return; }

    // ── 4단계: AI 생성 이미지 탐지 ──────────────────────────────────
    const r4 = step4AI(r3.tamperResult);
    if (!r4.pass) { showModal(imgEl, r4.verdict); return; }

    // ── 최종 승인 ────────────────────────────────────────────────────
    const confirmData = (hashResult.hash || approvalNo) ? { hash: hashResult.hash, approvalNo } : null;
    showModal(imgEl, {
      status: 'pass', icon: '🟢', title: '최종 승인',
      reasons: buildApprovalReasons(bizNo, cardBIN)
    }, confirmData);

  } catch (err) {
    if (err.message === 'NO_GEMINI_KEY') {
      showModal(imgEl, {
        status: 'caution', icon: '🟡', title: 'Gemini API Key 미설정',
        reasons: ['확장 프로그램 아이콘 우클릭 → "옵션"에서 Gemini API Key를 먼저 입력해 주세요. (OCR에 필수)']
      });
    } else {
      showModal(imgEl, { status: 'error', icon: '⚪', title: '오류', reasons: [err.message] });
    }
  } finally {
    hideSpinner(button);
  }
}

// ── 9. UI 함수 ──────────────────────────────────────────────

function showSpinner(button) {
  button.disabled = true;
  button.innerHTML = '<span class="yrg-spinner"></span>검증 중...';
}

function hideSpinner(button) {
  button.disabled = false;
  button.innerHTML = '🔍 영수증 검증';
}

function escapeHTML(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function showModal(imgEl, verdict, confirmData = null) {
  // 기존 모달 제거
  document.querySelectorAll('.yrg-modal-overlay').forEach(el => el.remove());

  const overlay = document.createElement('div');
  overlay.className = 'yrg-modal-overlay';

  const modal = document.createElement('div');
  modal.className = `yrg-modal yrg-${verdict.status || 'error'}`;

  const reasonsHTML = (verdict.reasons || [])
    .map(r => `<div class="yrg-reason-item">${escapeHTML(r)}</div>`)
    .join('');

  modal.innerHTML = `
    <div class="yrg-modal-header">
      <span class="yrg-modal-icon">${escapeHTML(verdict.icon || '⚪')}</span>
      <span class="yrg-modal-title">${escapeHTML(verdict.title || '결과')}</span>
    </div>
    <div class="yrg-modal-body">
      ${reasonsHTML || '<div class="yrg-reason-item">상세 정보 없음</div>'}
    </div>
    <button class="yrg-modal-close" type="button">닫기</button>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  if (confirmData) {
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'yrg-modal-confirm-btn';
    confirmBtn.type = 'button';
    confirmBtn.textContent = '✅ 후기 승인 완료 등록';
    confirmBtn.title = '후기를 승인한 경우 클릭 — 이후 동일 영수증 재검증 시 반려 처리됩니다';
    confirmBtn.addEventListener('click', () => {
      confirmBtn.disabled = true;
      confirmBtn.textContent = '등록 중...';
      chrome.runtime.sendMessage(
        { type: 'CONFIRM_HASH', hash: confirmData.hash, approvalNo: confirmData.approvalNo },
        response => {
          confirmBtn.textContent = response?.success ? '✅ 등록 완료' : '❌ 등록 실패';
        }
      );
    });
    modal.insertBefore(confirmBtn, modal.querySelector('.yrg-modal-close'));
  }

  modal.querySelector('.yrg-modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') overlay.remove();
  }, { once: true });
}
