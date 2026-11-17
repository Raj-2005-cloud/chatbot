// ── Config ───────────────────────────────────────────────────────
// Static fallback list (used before dynamic list loads)
const FALLBACK_MODELS = [
  'gemini-3.8-flash',
  'gemini-2.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-4-hydrogen',
];

let GEMINI_MODELS = [...FALLBACK_MODELS];

// Fetch real available models from the API and filter to generateContent ones
async function loadAvailableModels() {
  if (!API_KEY) return;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`
    );
    if (!res.ok) return;
    const data = await res.json();
    const flashModels = (data.models || [])
      .filter(m =>
        m.supportedGenerationMethods?.includes('generateContent') &&
        m.name.includes('flash')
      )
      .map(m => m.name.replace('models/', ''))
      // prefer faster/newer ones first
      .sort((a, b) => b.localeCompare(a));
    if (flashModels.length > 0) {
      GEMINI_MODELS = flashModels;
      console.log('Available models:', GEMINI_MODELS);
    }
  } catch (e) {
    console.warn('Could not fetch model list, using fallbacks.', e);
  }
}
const SYSTEM_PROMPT = `You are a helpful and concise chatbot assistant.
Keep replies short (1-3 sentences) and conversational.
Do not use any emojis. Write naturally, like a person would.`;

// ── API Key management ────────────────────────────────────────────
let API_KEY = localStorage.getItem('gemini_api_key') || '';

function saveApiKey(key) {
  API_KEY = key.trim();
  localStorage.setItem('gemini_api_key', API_KEY);
}

function clearApiKey() {
  API_KEY = '';
  localStorage.removeItem('gemini_api_key');
}

// ── Conversation history (for context) ───────────────────────────
const history = [];

// ── Gemini API call (with model fallback + retry) ─────────────────
async function callGeminiModel(model, body) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;
    if (res.status === 400 || res.status === 403) {
      clearApiKey();
      throw new Error('AUTH:' + msg);
    }
    // 429 / 503 / high-demand → signal to try next model
    throw new Error('RETRY:' + msg);
  }

  return res.json();
}

async function callGemini(userText) {
  history.push({ role: 'user', parts: [{ text: userText }] });

  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: history,
    generationConfig: { maxOutputTokens: 256, temperature: 0.9 },
  };

  let lastError = '';
  for (const model of GEMINI_MODELS) {
    try {
      const data = await callGeminiModel(model, body);
      const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text
        || "I didn't get a response. Try again!";
      history.push({ role: 'model', parts: [{ text: reply }] });
      return reply;
    } catch (err) {
      if (err.message.startsWith('AUTH:')) throw new Error(err.message.slice(5));
      // Log and try next model
      lastError = err.message.replace('RETRY:', '');
      console.warn(`Model ${model} failed: ${lastError}. Trying next…`);
      await new Promise(r => setTimeout(r, 800)); // small pause before retry
    }
  }

  throw new Error(`All models unavailable. Last error: ${lastError}`);
}

// ── DOM helpers ───────────────────────────────────────────────────
const messagesEl = document.getElementById('chatMessages');
const inputEl    = document.getElementById('userInput');

document.getElementById('initTime').textContent = getTime();

function getTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function appendMessage(text, sender) {
  const msgDiv = document.createElement('div');
  msgDiv.classList.add('message', sender);

  const bubble = document.createElement('div');
  bubble.classList.add('bubble');
  bubble.textContent = text;

  const ts = document.createElement('span');
  ts.classList.add('timestamp');
  ts.textContent = getTime();

  msgDiv.appendChild(bubble);
  msgDiv.appendChild(ts);
  messagesEl.appendChild(msgDiv);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return msgDiv;
}

function showTyping() {
  const typingDiv = document.createElement('div');
  typingDiv.classList.add('message', 'bot', 'typing');
  typingDiv.id = 'typingIndicator';
  typingDiv.innerHTML = `<div class="bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;
  messagesEl.appendChild(typingDiv);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function hideTyping() {
  const el = document.getElementById('typingIndicator');
  if (el) el.remove();
}

function setInputDisabled(val) {
  inputEl.disabled = val;
  document.getElementById('sendBtn').disabled = val;
}

// ── API key modal ─────────────────────────────────────────────────
function showApiKeyModal(errorMsg = '') {
  document.getElementById('apiKeyModal').classList.remove('hidden');
  document.getElementById('apiKeyError').textContent = errorMsg;
  document.getElementById('apiKeyInput').focus();
}

function hideApiKeyModal() {
  document.getElementById('apiKeyModal').classList.add('hidden');
}

document.getElementById('saveKeyBtn').addEventListener('click', async () => {
  const key = document.getElementById('apiKeyInput').value.trim();
  if (!key) {
    document.getElementById('apiKeyError').textContent = 'Please enter a valid API key.';
    return;
  }
  saveApiKey(key);
  hideApiKeyModal();
  await loadAvailableModels(); // discover real models for this key
  appendMessage('API key saved. Ask me anything!', 'bot');
});

document.getElementById('apiKeyInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('saveKeyBtn').click();
});

// Allow changing key via settings icon
document.getElementById('settingsBtn').addEventListener('click', () => {
  document.getElementById('apiKeyInput').value = API_KEY;
  showApiKeyModal();
});

// ── Main send flow ────────────────────────────────────────────────
async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text) return;

  if (!API_KEY) {
    showApiKeyModal('Enter your Gemini API key to start chatting.');
    return;
  }

  appendMessage(text, 'user');
  inputEl.value = '';
  setInputDisabled(true);
  showTyping();

  try {
    const reply = await callGemini(text);
    hideTyping();
    appendMessage(reply, 'bot');
  } catch (err) {
    hideTyping();
    appendMessage(`Error: ${err.message}`, 'bot');
    if (!API_KEY) showApiKeyModal('Your API key was rejected. Please enter a valid key.');
  } finally {
    setInputDisabled(false);
    inputEl.focus();
  }
}

// Send on Enter key
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter') sendMessage();
});

// ── Init ──────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('initTime').textContent = getTime();
  if (!API_KEY) {
    showApiKeyModal('Enter your Gemini API key to get started.');
  } else {
    await loadAvailableModels(); // refresh model list on reload
  }
});
