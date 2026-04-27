// options.js — API Key 저장/불러오기

document.addEventListener('DOMContentLoaded', async () => {
  const apiKeyInput = document.getElementById('apiKey');
  const showKeyCheckbox = document.getElementById('showKey');
  const geminiApiKeyInput = document.getElementById('geminiApiKey');
  const showGeminiKeyCheckbox = document.getElementById('showGeminiKey');
  const supabaseUrlInput = document.getElementById('supabaseUrl');
  const supabaseAnonKeyInput = document.getElementById('supabaseAnonKey');
  const showSupabaseKeyCheckbox = document.getElementById('showSupabaseKey');
  const saveBtn = document.getElementById('saveBtn');
  const statusMsg = document.getElementById('statusMsg');

  // 저장된 설정 불러오기
  try {
    const stored = await chrome.storage.local.get(['apiKey', 'geminiApiKey', 'supabaseUrl', 'supabaseAnonKey']);
    if (stored.apiKey) apiKeyInput.value = stored.apiKey;
    if (stored.geminiApiKey) geminiApiKeyInput.value = stored.geminiApiKey;
    if (stored.supabaseUrl) supabaseUrlInput.value = stored.supabaseUrl;
    if (stored.supabaseAnonKey) supabaseAnonKeyInput.value = stored.supabaseAnonKey;
  } catch (e) {
    showStatus('저장된 설정을 불러오지 못했습니다.', 'error');
  }

  // API Key 표시/숨김 토글
  showKeyCheckbox.addEventListener('change', () => {
    apiKeyInput.type = showKeyCheckbox.checked ? 'text' : 'password';
  });
  showGeminiKeyCheckbox.addEventListener('change', () => {
    geminiApiKeyInput.type = showGeminiKeyCheckbox.checked ? 'text' : 'password';
  });
  showSupabaseKeyCheckbox.addEventListener('change', () => {
    supabaseAnonKeyInput.type = showSupabaseKeyCheckbox.checked ? 'text' : 'password';
  });

  // 저장 버튼
  saveBtn.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      showStatus('❌ 국세청 API Key를 입력해 주세요.', 'error');
      apiKeyInput.focus();
      return;
    }
    if (key.length < 20) {
      showStatus('❌ API Key가 너무 짧습니다. 올바른 키를 입력해 주세요.', 'error');
      return;
    }

    const geminiKey = geminiApiKeyInput.value.trim();
    if (!geminiKey) {
      showStatus('⚠️ Gemini API Key를 입력해 주세요. (OCR에 필수)', 'error');
      geminiApiKeyInput.focus();
      return;
    }

    const supabaseUrl = supabaseUrlInput.value.trim();
    const supabaseAnonKey = supabaseAnonKeyInput.value.trim();

    // Supabase는 둘 다 입력하거나 둘 다 비워야 함
    if ((supabaseUrl && !supabaseAnonKey) || (!supabaseUrl && supabaseAnonKey)) {
      showStatus('❌ Supabase URL과 Anon Key를 모두 입력하거나 모두 비워주세요.', 'error');
      return;
    }

    try {
      const toSave = { apiKey: key, geminiApiKey: geminiKey };
      if (supabaseUrl && supabaseAnonKey) {
        toSave.supabaseUrl = supabaseUrl;
        toSave.supabaseAnonKey = supabaseAnonKey;
      } else {
        // 기존 Supabase 설정 제거
        await chrome.storage.local.remove(['supabaseUrl', 'supabaseAnonKey']);
      }
      await chrome.storage.local.set(toSave);
      showStatus('✅ 저장되었습니다.', 'success');
    } catch (e) {
      showStatus(`❌ 저장 실패: ${e.message}`, 'error');
    }
  });

  // Enter 키로 저장
  [apiKeyInput, geminiApiKeyInput, supabaseUrlInput, supabaseAnonKeyInput].forEach(input => {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveBtn.click(); });
  });

  function showStatus(message, type) {
    statusMsg.textContent = message;
    statusMsg.className = type === 'error' ? 'status-error' : 'status-success';
    if (type === 'success') {
      setTimeout(() => { statusMsg.textContent = ''; }, 3000);
    }
  }
});
