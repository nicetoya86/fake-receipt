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
        // JPEG인데 EXIF 태그가 전혀 없으면 그림판·기본 편집 도구로 재저장됐을 가능성 있음
        const isJpeg = imgEl.src?.match(/\.jpe?g(\?|$)/i) ||
                       imgEl.currentSrc?.match(/\.jpe?g(\?|$)/i);
        const isExifStripped = isJpeg && Object.keys(allTags).length === 0;

        resolve({
          isTampered: !!foundTool,
          isExifStripped: !!isExifStripped,
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

        // 블록별 분산 계산
        const varGrid = Array.from({ length: rows }, () => new Float32Array(cols));
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
            varGrid[br][bc] = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
          }
        }

        // 주변(8방향) 대비 비정상적으로 평탄한 블록 탐지
        let suspiciousBlocks = 0;
        for (let br = 1; br < rows - 1; br++) {
          for (let bc = 1; bc < cols - 1; bc++) {
            const v = varGrid[br][bc];
            if (v > 1.5) continue; // 충분히 평탄하지 않으면 스킵
            const neighborMean = (
              varGrid[br-1][bc-1] + varGrid[br-1][bc] + varGrid[br-1][bc+1] +
              varGrid[br  ][bc-1]                     + varGrid[br  ][bc+1] +
              varGrid[br+1][bc-1] + varGrid[br+1][bc] + varGrid[br+1][bc+1]
            ) / 8;
            // 주변이 텍스처 있는데 이 블록만 극도로 평탄 = 그림판 채우기 흔적
            if (neighborMean > 20 && v < 0.8) suspiciousBlocks++;
          }
        }

        const totalInner = (rows - 2) * (cols - 2);
        const ratio = suspiciousBlocks / Math.max(1, totalInner);
        // 내부 블록의 4% 이상이 의심스럽고 절대 수 3개 이상이면 플래그
        const isPaintSuspect = ratio > 0.04 && suspiciousBlocks >= 3;
        console.log('[YRG] 노이즈 분석: 의심 블록', suspiciousBlocks, '/', totalInner, `(${Math.round(ratio*100)}%)`);
        resolve({ isPaintSuspect, suspiciousBlocks, ratio: Math.round(ratio * 100) });
      } catch (e) {
        resolve({ isPaintSuspect: false, error: e.message });
      }
    };
    img.onerror = () => resolve({ isPaintSuspect: false });
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
      resolve({ text: response.text, approvalNo: response.approvalNo || null });
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

// ── 7. 결과 판정 로직 ───────────────────────────────────────

function judgeResult(exifResult, ocrResult, apiResult, hashResult, tamperResult, binResult) {
  const reasons = [];

  // 🔴 반려 (우선순위 1): EXIF 위변조 감지
  if (exifResult && exifResult.isTampered) {
    return {
      status: 'reject',
      icon: '🔴',
      title: '반려',
      reasons: [`이미지 편집 흔적 감지: ${exifResult.software}`]
    };
  }

  // 🟡 주의 (우선순위 1-b): JPEG EXIF 완전 제거 — 그림판 등으로 재저장됐을 가능성
  if (exifResult && exifResult.isExifStripped) {
    return {
      status: 'caution',
      icon: '🟡',
      title: '주의',
      reasons: ['JPEG 메타데이터(EXIF)가 완전히 제거됨 — 그림판 등 기본 편집 도구로 재저장됐을 수 있습니다. 수동 검토를 권장합니다.']
    };
  }

  // 🔴 반려 (우선순위 2): AI 위변조 고신뢰 OR 도용 고신뢰 OR AI생성 고신뢰
  if (tamperResult) {
    const highTamper = tamperResult.tamperLevel === 'high';
    const highStolen = tamperResult.isSuspectedStolen && tamperResult.tamperLevel !== 'low';
    const highAI     = tamperResult.isSuspectedAI     && tamperResult.tamperLevel !== 'low';

    if (highTamper || highStolen || highAI) {
      const rejectReasons = [];
      if (highTamper) rejectReasons.push(`AI 위변조 감지 (신뢰도: ${tamperResult.score}점/100) — ${tamperResult.reason}`);
      if (highStolen) rejectReasons.push('화면 캡처/도용 의심 — 실제 촬영 영수증이 아닐 수 있습니다');
      if (highAI)     rejectReasons.push('AI 생성 이미지 의심 — 생성형 AI로 만든 영수증일 수 있습니다');
      return { status: 'reject', icon: '🔴', title: '반려', reasons: rejectReasons };
    }
  }

  // 🔴 반려 (우선순위 3): 중복 영수증 감지 (approved 항목과 일치)
  if (hashResult && hashResult.isDuplicate) {
    const prevDate = hashResult.savedAt
      ? new Date(hashResult.savedAt).toLocaleString('ko-KR')
      : '알 수 없음';
    const reason = hashResult.reason === 'approvalNo' ? '승인번호 일치' : '이미지 유사도 일치';
    return {
      status: 'reject',
      icon: '🔴',
      title: '반려',
      reasons: [`중복 영수증 감지 (${reason}) — 이전 검증 일시: ${prevDate}`]
    };
  }

  // 🔴 반려 (우선순위 4): 유효하지 않은 카드 BIN
  if (binResult && binResult.valid === false) {
    return {
      status: 'reject',
      icon: '🔴',
      title: '반려',
      reasons: [`${binResult.reason || '유효하지 않은 카드번호'}${binResult.bin ? ` (BIN: ${binResult.bin})` : ''}`]
    };
  }

  // 🔴 반려 (우선순위 5): 국세청 API — 폐업/미등록/휴업
  if (apiResult && apiResult.success) {
    if (['closed', 'unregistered', 'suspended'].includes(apiResult.status)) {
      const reasons = [`사업자 상태: ${apiResult.statusText}`];
      if (apiResult.bizNo) reasons.push(`사업자번호: ${apiResult.bizNo}`);
      if (apiResult.endDate) reasons.push(`폐업일: ${apiResult.endDate}`);
      return { status: 'reject', icon: '🔴', title: '반려', reasons };
    }
  }

  // 🟡 주의 (우선순위 6): AI 위변조 중신뢰 OR 도용 단독 의심 OR AI생성 단독 의심
  if (tamperResult) {
    const mediumTamper = tamperResult.tamperLevel === 'medium';
    const onlyStolen   = tamperResult.isSuspectedStolen && tamperResult.tamperLevel === 'low';
    const onlyAI       = tamperResult.isSuspectedAI     && tamperResult.tamperLevel === 'low';

    if (mediumTamper || onlyStolen || onlyAI) {
      const cautionReasons = [];
      if (mediumTamper) cautionReasons.push(`AI 위변조 의심 (신뢰도: ${tamperResult.score}점/100) — ${tamperResult.reason}`);
      if (onlyStolen)   cautionReasons.push('화면 캡처 의심 — 직접 촬영한 영수증인지 확인이 필요합니다');
      if (onlyAI)       cautionReasons.push('AI 생성 이미지 의심 — 생성형 AI로 만든 영수증일 수 있습니다');
      cautionReasons.push('수동 검토를 권장합니다.');
      return { status: 'caution', icon: '🟡', title: '주의', reasons: cautionReasons };
    }
  }

  // 🟡 주의: API 오류 (Key 없음 등)
  if (apiResult && !apiResult.success) {
    reasons.push(`국세청 API 오류: ${apiResult.message || '알 수 없는 오류'}`);
    return { status: 'caution', icon: '🟡', title: '주의', reasons };
  }

  // 🟢 통과: 사업자번호 없는 영수증 (현금영수증·간이영수증 등)
  if (!ocrResult || !ocrResult.text || ocrResult.bizNumbers.length === 0) {
    return { status: 'pass', icon: '🟢', title: '통과', reasons: ['사업자번호 없는 영수증으로 확인됩니다.'] };
  }

  // 🟢 정상: 모든 조건 통과
  const passReasons = [];
  if (exifResult && !exifResult.error) passReasons.push('EXIF 조작 흔적 없음');
  if (apiResult?.bizNo) passReasons.push(`사업자번호: ${apiResult.bizNo}`);
  if (apiResult?.statusText) passReasons.push(`사업자 상태: ${apiResult.statusText}`);
  if (apiResult?.taxType) passReasons.push(`과세 유형: ${apiResult.taxType}`);

  return {
    status: 'pass',
    icon: '🟢',
    title: '정상',
    reasons: passReasons.length > 0 ? passReasons : ['검증 통과']
  };
}

// ── 8. 메인 검증 흐름 ───────────────────────────────────────

async function verifyReceipt(imgEl, button) {
  // API Key 확인 (alert 대신 모달 사용 — 어드민 동작을 차단하지 않음)
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) {
    showModal(null, {
      status: 'caution',
      icon: '🟡',
      title: 'API Key 미설정',
      reasons: ['확장 프로그램 아이콘 우클릭 → "옵션"에서 공공데이터포털 API Key를 먼저 입력해 주세요.']
    });
    return;
  }

  showSpinner(button);

  try {
    // content script 컨텍스트에서 이미지 dataURL 취득 (브라우저 쿠키/인증 자동 포함)
    const dataURL = await getImageDataURL(imgEl).catch(e => {
      console.warn('[YRG] 이미지 dataURL 취득 실패:', e.message);
      return null;
    });

    if (!dataURL) {
      throw new Error('이미지를 불러올 수 없습니다. (CORS 또는 네트워크 오류)');
    }
    console.log('[YRG] 이미지 dataURL 취득 완료, 길이:', dataURL.length);

    // 병렬 실행: EXIF + Hash + OCR (Gemini Vision) + 위변조 분석 + 픽셀 노이즈 분석
    const [exifResult, hashResult, ocrResult, tamperResult, noiseResult] = await Promise.all([
      analyzeEXIF(imgEl).catch(() => ({ isTampered: false, error: true })),
      extractHash(imgEl).catch(() => ({ hash: null, error: true })),
      runOCR(dataURL).catch(e => {
        if (e.message === 'NO_GEMINI_KEY') throw e;
        console.warn('[YRG] OCR 오류:', e.message);
        return null;
      }),
      analyzeTamper(dataURL).catch(() => ({ tamperLevel: 'unknown', error: true })),
      analyzeImageNoise(dataURL).catch(() => ({ isPaintSuspect: false }))
    ]);

    // 캔버스 분석이 그림판 편집 의심 → Gemini가 low/unknown이어도 medium으로 격상
    if (noiseResult.isPaintSuspect) {
      const paintReason = `픽셀 분석: 편집 도구로 지워진 영역 의심 (이상 블록 ${noiseResult.suspiciousBlocks}개, ${noiseResult.ratio}%)`;
      console.log('[YRG]', paintReason);
      if (!tamperResult.tamperLevel || tamperResult.tamperLevel === 'low' || tamperResult.tamperLevel === 'unknown') {
        tamperResult.tamperLevel = 'medium';
        tamperResult.reason = tamperResult.reason && tamperResult.reason !== '이상 없음'
          ? `${tamperResult.reason} / ${paintReason}`
          : paintReason;
      }
    }

    const bizNumbers = extractBusinessNumber(ocrResult?.text);
    const approvalNo = ocrResult?.approvalNo || null;
    const cardBIN    = ocrResult?.cardBIN    || null;

    // 중복 검사 (hash 또는 승인번호 중 하나라도 있으면 실행)
    let duplicateResult = { isDuplicate: false };
    if (hashResult.hash || approvalNo) {
      duplicateResult = await compareHash(hashResult.hash, approvalNo).catch(() => ({ isDuplicate: false }));
      if (duplicateResult.isDuplicate) {
        console.log('[YRG] 중복 감지:', duplicateResult.reason === 'approvalNo' ? `승인번호 일치` : `해시 유사도 (distance: ${duplicateResult.distance})`);
      }
    }

    // 국세청 API 검증 + 카드 BIN 검증 병렬 실행 (중복이 아닐 때만)
    let apiResult = null;
    let binResult = null;
    if (!duplicateResult.isDuplicate) {
      [apiResult, binResult] = await Promise.all([
        bizNumbers.length > 0
          ? verifyBusinessNumber(bizNumbers[0]).catch(err => ({ success: false, error: 'API_ERROR', message: err.message }))
          : Promise.resolve(null),
        cardBIN
          ? checkCardBIN(cardBIN).catch(() => ({ valid: true, skip: true }))
          : Promise.resolve(null)
      ]);
      if (binResult && binResult.valid === false) {
        console.log('[YRG] 카드 BIN 무효:', cardBIN);
      }
    }

    const verdict = judgeResult(exifResult, { text: ocrResult?.text, bizNumbers }, apiResult, duplicateResult, tamperResult, binResult);
    const confirmData = (verdict.status === 'pass' && (hashResult.hash || approvalNo))
      ? { hash: hashResult.hash, approvalNo }
      : null;
    showModal(imgEl, verdict, confirmData);

  } catch (err) {
    if (err.message === 'NO_GEMINI_KEY') {
      showModal(imgEl, {
        status: 'caution',
        icon: '🟡',
        title: 'Gemini API Key 미설정',
        reasons: ['확장 프로그램 아이콘 우클릭 → "옵션"에서 Gemini API Key를 먼저 입력해 주세요. (OCR에 필수)']
      });
    } else {
      showModal(imgEl, {
        status: 'error',
        icon: '⚪',
        title: '오류',
        reasons: [err.message]
      });
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
