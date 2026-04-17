// options.js — API Key 저장/불러오기

document.addEventListener('DOMContentLoaded', async () => {
  const apiKeyInput = document.getElementById('apiKey');
  const showKeyCheckbox = document.getElementById('showKey');
  const geminiApiKeyInput = document.getElementById('geminiApiKey');
  const showGeminiKeyCheckbox = document.getElementById('showGeminiKey');
  const saveBtn = document.getElementById('saveBtn');
  const statusMsg = document.getElementById('statusMsg');

  // 저장된 API Key 불러오기
  try {
    const { apiKey, geminiApiKey } = await chrome.storage.local.get(['apiKey', 'geminiApiKey']);
    if (apiKey) apiKeyInput.value = apiKey;
    if (geminiApiKey) geminiApiKeyInput.value = geminiApiKey;
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

    try {
      await chrome.storage.local.set({ apiKey: key, geminiApiKey: geminiKey });
      showStatus('✅ 저장되었습니다.', 'success');
    } catch (e) {
      showStatus(`❌ 저장 실패: ${e.message}`, 'error');
    }
  });

  // Enter 키로 저장
  apiKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveBtn.click();
  });
  geminiApiKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveBtn.click();
  });

  function showStatus(message, type) {
    statusMsg.textContent = message;
    statusMsg.className = type === 'error' ? 'status-error' : 'status-success';
    if (type === 'success') {
      setTimeout(() => { statusMsg.textContent = ''; }, 3000);
    }
  }
});
