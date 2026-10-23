const form = document.querySelector('#chatForm');
const input = document.querySelector('#messageInput');
const messages = document.querySelector('#messages');
const sendButton = document.querySelector('#sendButton');
const stopButton = document.querySelector('#stopButton');
const clearButton = document.querySelector('#clearButton');
const newChatButton = document.querySelector('#newChatButton');
const welcomeState = document.querySelector('#welcomeState');
const assistantStatus = document.querySelector('#assistantStatus');
const connectionStatus = document.querySelector('#connectionStatus');
const modelName = document.querySelector('#modelName');
const providerDot = document.querySelector('#providerDot');
const characterCount = document.querySelector('#characterCount');
const notice = document.querySelector('#notice');

const STORAGE_KEY = 'nova-ai-session-id';
let sessionId = getOrCreateSessionId();
let activeController = null;
let busy = false;
let noticeTimer = null;

function getOrCreateSessionId() {
  try {
    let value = localStorage.getItem(STORAGE_KEY);
    if (!value || !/^[a-zA-Z0-9_-]{10,80}$/.test(value)) {
      value = globalThis.crypto?.randomUUID?.() || `session_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
      localStorage.setItem(STORAGE_KEY, value);
    }
    return value;
  } catch {
    return globalThis.crypto?.randomUUID?.() || `session_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  }
}

function setConnectionStatus(state, label) {
  connectionStatus.className = `connection-status ${state}`;
  connectionStatus.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  const text = document.createElement('span');
  text.textContent = label;
  connectionStatus.append(dot, text);
  providerDot.classList.toggle('online', state === 'online');
}

async function loadHealth() {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    if (!response.ok) throw new Error('Server unavailable');
    const health = await response.json();
    if (health.apiKeyConfigured) {
      setConnectionStatus('online', 'Connected');
      assistantStatus.textContent = 'Ready when you are';
    } else {
      setConnectionStatus('warning', 'API key needed');
      assistantStatus.textContent = 'Needs API configuration';
      showNotice('Add OPENROUTER_API_KEY to your .env file, then restart the server.', 'warning', false);
    }
    modelName.textContent = health.model || 'Configured model';
    modelName.title = health.model || '';
  } catch {
    setConnectionStatus('offline', 'Server unavailable');
    assistantStatus.textContent = 'Server unavailable';
    modelName.textContent = 'Not connected';
  }
}

function showNotice(message, type = 'info', autoHide = true) {
  clearTimeout(noticeTimer);
  notice.hidden = false;
  notice.className = `notice ${type}`;
  notice.textContent = message;
  if (autoHide) noticeTimer = setTimeout(() => { notice.hidden = true; }, 5000);
}

function makeMessage(role, text = '', { error = false, streaming = false } = {}) {
  const article = document.createElement('article');
  article.className = `message ${role}${error ? ' error' : ''}${streaming ? ' streaming' : ''}`;
  const avatar = document.createElement('div');
  avatar.className = role === 'assistant' ? 'message-avatar assistant-avatar' : 'message-avatar user-avatar';
  avatar.textContent = role === 'assistant' ? 'N' : 'Y';
  avatar.setAttribute('aria-hidden', 'true');
  const content = document.createElement('div');
  content.className = 'message-content';
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const name = document.createElement('span');
  name.className = 'message-author';
  name.textContent = role === 'assistant' ? 'Nova AI' : 'You';
  const time = document.createElement('time');
  time.className = 'message-time';
  time.dateTime = new Date().toISOString();
  time.textContent = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date());
  meta.append(name, time);
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  const paragraph = document.createElement('p');
  paragraph.className = 'message-text';
  paragraph.textContent = text;
  bubble.append(paragraph);
  content.append(meta, bubble);
  article.append(avatar, content);
  messages.append(article);
  messages.scrollTop = messages.scrollHeight;
  welcomeState.hidden = true;
  return { article, bubble, paragraph };
}

function setBusy(isBusy) {
  busy = isBusy;
  sendButton.disabled = isBusy;
  stopButton.hidden = !isBusy;
  input.disabled = isBusy;
  clearButton.disabled = isBusy;
  newChatButton.disabled = isBusy;
  document.querySelectorAll('[data-prompt]').forEach((button) => { button.disabled = isBusy; });
  assistantStatus.textContent = isBusy ? 'Generating response…' : 'Ready when you are';
  if (!isBusy) input.focus();
}

function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
}

function parseEventBlock(block) {
  let event = 'message';
  const dataLines = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  try { return { event, data: JSON.parse(dataLines.join('\n')) }; }
  catch { return null; }
}

async function consumeEventStream(response, output) {
  if (!response.body) throw new Error('Your browser could not read the response stream. Try a recent version of Chrome or Edge.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let started = false;
  let finished = false;
  let streamError = null;

  const processBlock = (block) => {
    if (!block.trim()) return;
    const parsed = parseEventBlock(block);
    if (!parsed) return;
    if (parsed.event === 'meta') {
      if (parsed.data?.model) {
        modelName.textContent = parsed.data.model;
        modelName.title = parsed.data.model;
      }
    } else if (parsed.event === 'delta' && typeof parsed.data?.content === 'string') {
      if (!started) {
        output.paragraph.textContent = '';
        started = true;
      }
      output.paragraph.textContent += parsed.data.content;
      scrollToBottom();
    } else if (parsed.event === 'done') {
      finished = true;
    } else if (parsed.event === 'error') {
      streamError = parsed.data?.error || 'The response stream failed.';
      finished = true;
    }
  };

  while (!finished) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) processBlock(block);
  }
  if (buffer) processBlock(buffer);
  try { await reader.cancel(); } catch { /* Reader may already have closed. */ }
  if (streamError) throw new Error(streamError);
  if (!output.paragraph.textContent.trim()) throw new Error('The model returned an empty response. Try again.');
}

async function sendMessage(rawText) {
  const message = rawText.trim();
  if (!message || busy) return;
  hideNotice();
  makeMessage('user', message);
  input.value = '';
  resizeInput();
  characterCount.textContent = '0 / 6,000';
  setBusy(true);
  activeController = new AbortController();
  const output = makeMessage('assistant', 'Connecting to model…', { streaming: true });
  output.bubble.classList.add('response-cursor');

  try {
    const response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId }),
      signal: activeController.signal
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
    }
    await consumeEventStream(response, output);
    output.bubble.classList.remove('response-cursor');
    output.article.classList.remove('streaming');
  } catch (error) {
    output.bubble.classList.remove('response-cursor');
    output.article.classList.remove('streaming');
    if (error.name === 'AbortError') {
      if (output.paragraph.textContent === 'Connecting to model…') output.paragraph.textContent = 'Response stopped.';
      else output.paragraph.textContent += '\n\n[Generation stopped]';
      showNotice('Generation stopped. Send another message whenever you’re ready.', 'info');
    } else {
      output.article.classList.add('error');
      output.paragraph.textContent = error.message || 'Something went wrong. Please try again.';
      showNotice('The request did not complete. Check the server terminal and OpenRouter settings.', 'error');
    }
  } finally {
    activeController = null;
    setBusy(false);
  }
}

function resizeInput() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

function hideNotice() {
  clearTimeout(noticeTimer);
  notice.hidden = true;
}

async function clearConversation() {
  if (busy) return;
  clearButton.disabled = true;
  newChatButton.disabled = true;
  try {
    const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('The server could not clear this conversation.');
    messages.replaceChildren(welcomeState);
    welcomeState.hidden = false;
    hideNotice();
    input.value = '';
    characterCount.textContent = '0 / 6,000';
    resizeInput();
  } catch (error) {
    showNotice(error.message || 'Could not clear the conversation.', 'error');
  } finally {
    clearButton.disabled = false;
    newChatButton.disabled = false;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage(input.value);
});

input.addEventListener('input', () => {
  resizeInput();
  characterCount.textContent = `${input.value.length.toLocaleString()} / 6,000`;
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

stopButton.addEventListener('click', () => activeController?.abort());
clearButton.addEventListener('click', clearConversation);
newChatButton.addEventListener('click', clearConversation);

document.querySelectorAll('[data-prompt]').forEach((button) => {
  button.addEventListener('click', () => sendMessage(button.dataset.prompt));
});

loadHealth();
