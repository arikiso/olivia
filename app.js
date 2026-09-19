// Waguri — standalone chat app (vanilla JS)
// Storage: IndexedDB (primary) + localStorage mirror (fallback / legacy migration)
// Sync: BroadcastChannel for instant cross-tab/window updates

const API_URL = (() => {
  const override = window.WAGURI_API_URL || window.HACKMYSENPAI_API_URL;
  return override || "https://hack-your-senpai.lovable.app/api/public/senpai-chat";
})();

const STORAGE_KEY = "waguri.threads.v1";
const ACTIVE_KEY = "waguri.active.v1";
const THEME_KEY = "waguri.theme.v1";
const LEGACY_STORAGE = "hackmysenpai.threads.v1";
const LEGACY_ACTIVE = "hackmysenpai.active.v1";

const TAB_ID = "tab_" + Math.random().toString(36).slice(2, 10);

// ---------- IndexedDB ----------
const DB_NAME = "waguri-db";
const DB_STORE = "kv";
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("no indexedDB"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("indexedDB open failed"));
  }).catch((e) => { dbPromise = null; throw e; });
  return dbPromise;
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// localStorage mirror (fallback + resilience on mobile)
function lsGetThreads() {
  try {
    const cur = localStorage.getItem(STORAGE_KEY);
    if (cur) return JSON.parse(cur);
    const legacy = localStorage.getItem(LEGACY_STORAGE);
    if (legacy) return JSON.parse(legacy);
  } catch {}
  return [];
}
function lsSet(threadsVal, activeVal) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(threadsVal));
    if (activeVal) localStorage.setItem(ACTIVE_KEY, activeVal);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {}
}

// ---------- state ----------
let threads = [];
let activeId = null;
let sending = false;
let saveTimer = null;

function currentThread() { return threads.find((t) => t.id === activeId) || null; }
function stamp(list) { return list.reduce((n, t) => Math.max(n, t.updatedAt || 0), 0); }

async function loadAll() {
  let idbThreads = null, idbActive = null;
  try {
    idbThreads = await idbGet("threads");
    idbActive = await idbGet("active");
  } catch {}
  const lsThreads = lsGetThreads();
  // Prefer whichever store holds the newer data (mobile browsers can evict either).
  if (Array.isArray(idbThreads) && (!lsThreads.length || stamp(idbThreads) >= stamp(lsThreads))) {
    threads = idbThreads;
  } else {
    threads = lsThreads;
  }
  activeId = idbActive || (() => { try { return localStorage.getItem(ACTIVE_KEY) || localStorage.getItem(LEGACY_ACTIVE); } catch { return null; } })();
  if (activeId && !threads.find((t) => t.id === activeId)) activeId = null;
  // Write back so both stores converge.
  await persist({ broadcast: false });
}

async function persist({ broadcast = true } = {}) {
  lsSet(threads, activeId);
  try {
    await idbSet("threads", threads);
    await idbSet("active", activeId);
  } catch {}
  if (broadcast) postSync();
}

// Debounced persist for hot paths (streaming)
function persistSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; persist(); }, 600);
}

// ---------- BroadcastChannel sync ----------
const channel = ("BroadcastChannel" in window) ? new BroadcastChannel("waguri-sync") : null;

function postSync() {
  if (!channel) return;
  try {
    channel.postMessage({ type: "threads", from: TAB_ID, threads, activeId, at: Date.now() });
  } catch {}
}

if (channel) {
  channel.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg || msg.from === TAB_ID) return;
    if (msg.type === "theme") { applyTheme(msg.theme); return; }
    if (msg.type !== "threads" || !Array.isArray(msg.threads)) return;
    if (sending) {
      // Don't clobber a live stream — merge everything except the active thread.
      const mine = currentThread();
      threads = msg.threads.map((t) => (mine && t.id === mine.id ? mine : t));
      if (mine && !threads.find((t) => t.id === mine.id)) threads.unshift(mine);
      renderThreads();
      return;
    }
    threads = msg.threads;
    if (msg.activeId && threads.find((t) => t.id === msg.activeId)) activeId = msg.activeId;
    if (activeId && !threads.find((t) => t.id === activeId)) activeId = threads[0]?.id || null;
    renderThreads();
    renderMessages();
  };
}

async function reloadFromStore() {
  if (sending) return;
  await loadAll();
  renderThreads();
  renderMessages();
}

// ---------- DOM ----------
const sidebar = document.getElementById("sidebar");
const backdrop = document.getElementById("backdrop");
const threadsList = document.getElementById("threadsList");
const messagesEl = document.getElementById("messages");
const input = document.getElementById("input");
const sendBtn = document.getElementById("sendBtn");
const form = document.getElementById("composer");
const newBtn = document.getElementById("newThreadBtn");
const menuBtn = document.getElementById("menuBtn");
const modelPill = document.getElementById("modelPill");
const modelLabel = document.getElementById("modelLabel");
const toastEl = document.getElementById("toast");

let toastTimer = null;
function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
}

function openSidebarMobile() { sidebar.classList.add("open"); backdrop.classList.add("show"); menuBtn.setAttribute("aria-expanded", "true"); }
function closeSidebarMobile() { sidebar.classList.remove("open"); backdrop.classList.remove("show"); menuBtn.setAttribute("aria-expanded", "false"); }

newBtn.addEventListener("click", () => newThread());
menuBtn.addEventListener("click", () => {
  sidebar.classList.contains("open") ? closeSidebarMobile() : openSidebarMobile();
});
backdrop.addEventListener("click", closeSidebarMobile);

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
});
form.addEventListener("submit", (e) => { e.preventDefault(); send(); });

document.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) { input.value = chip.textContent; input.dispatchEvent(new Event("input")); input.focus(); }
});

// ---------- threads ----------
function newThread() {
  const t = { id: "t_" + Math.random().toString(36).slice(2, 10), title: "New chat", createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  threads.unshift(t);
  activeId = t.id;
  persist();
  renderThreads(); renderMessages();
  closeSidebarMobile();
  input.focus();
  return t;
}
function deleteThread(id) {
  threads = threads.filter((t) => t.id !== id);
  if (activeId === id) activeId = threads[0]?.id || null;
  persist();
  renderThreads(); renderMessages();
}
function selectThread(id) {
  activeId = id;
  persist();
  renderThreads(); renderMessages();
  closeSidebarMobile();
}

// ---------- rendering ----------
function renderThreads() {
  threadsList.innerHTML = "";
  if (!threads.length) {
    threadsList.innerHTML = `<div style="color:var(--text-mute);font-size:12px;padding:8px 12px;">No conversations yet.</div>`;
    return;
  }
  for (const t of threads) {
    const el = document.createElement("div");
    el.className = "thread-item" + (t.id === activeId ? " active" : "");
    el.setAttribute("role", "listitem");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-label", `Open chat: ${t.title}`);
    if (t.id === activeId) el.setAttribute("aria-current", "true");
    el.innerHTML = `<span class="thread-title">${escapeHtml(t.title)}</span><button class="thread-del" title="Delete chat" aria-label="Delete chat: ${escapeHtml(t.title)}">✕</button>`;
    el.addEventListener("click", (e) => {
      if (e.target.classList.contains("thread-del")) { e.stopPropagation(); deleteThread(t.id); }
      else selectThread(t.id);
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectThread(t.id); }
      else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteThread(t.id); }
    });
    threadsList.appendChild(el);
  }
}

function emptyStateHtml() {
  return `
    <div class="empty-state">
      <div class="hero-mark" aria-hidden="true">W</div>
      <h1 class="hero-title">How can I help?</h1>
      <p class="hero-sub">Ask anything — Waguri stays available around the clock.</p>
      <div class="chips" role="list">
        <button class="chip" role="listitem">Draft a professional email</button>
        <button class="chip" role="listitem">Debug my Python code</button>
        <button class="chip" role="listitem">Explain a hard concept simply</button>
        <button class="chip" role="listitem">Summarize a long article</button>
      </div>
    </div>`;
}

function renderMessages() {
  const t = currentThread();
  messagesEl.innerHTML = "";
  if (!t || !t.messages.length) { messagesEl.innerHTML = emptyStateHtml(); return; }
  for (const m of t.messages) {
    const node = renderMessage(m.role, m.content, { error: m.error });
    messagesEl.appendChild(node);
    if (m.role === "assistant" && m.error) attachRetryButton(node);
  }
  scrollToBottom();
}

function renderMessage(role, content, opts = {}) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + role + (opts.error ? " error" : "");
  wrap.setAttribute("role", "article");
  wrap.setAttribute("aria-label", role === "user" ? "You said" : "Waguri said");
  wrap.innerHTML = `<div class="avatar" aria-hidden="true">${role === "user" ? "You" : "W"}</div><div class="bubble"></div>`;
  const bubble = wrap.querySelector(".bubble");
  bubble.innerHTML = renderMarkdown(content);
  enhanceBubble(bubble, content);
  return wrap;
}

// ---------- copy ----------
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

const COPY_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function flashCopied(btn, label) {
  const original = btn.innerHTML;
  btn.classList.add("done");
  btn.innerHTML = "✓ Copied";
  setTimeout(() => { btn.classList.remove("done"); btn.innerHTML = original; }, 1400);
  if (label) toast(label);
}

// Adds copy buttons to code blocks + a copy button for the whole message.
function enhanceBubble(bubble, rawText) {
  bubble.querySelectorAll("pre").forEach((pre) => {
    if (pre.parentElement?.classList.contains("code-block")) return;
    const wrap = document.createElement("div");
    wrap.className = "code-block";
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy";
    btn.setAttribute("aria-label", "Copy code");
    btn.innerHTML = COPY_ICON + " Copy";
    btn.addEventListener("click", async () => {
      const ok = await copyText(pre.innerText);
      if (ok) flashCopied(btn); else toast("Copy failed");
    });
    wrap.appendChild(btn);
  });

  if (rawText && rawText.trim() && !bubble.querySelector(".msg-actions")) {
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "msg-copy";
    copyBtn.setAttribute("aria-label", "Copy message");
    copyBtn.innerHTML = COPY_ICON + " Copy";
    copyBtn.addEventListener("click", async () => {
      const ok = await copyText(rawText);
      if (ok) flashCopied(copyBtn); else toast("Copy failed");
    });
    actions.appendChild(copyBtn);
    bubble.appendChild(actions);
  }
}

function attachRetryButton(msgNode) {
  const bubble = msgNode.querySelector(".bubble");
  if (bubble.querySelector(".retry-row")) return;
  const row = document.createElement("div");
  row.className = "retry-row";
  row.innerHTML = `<span class="error-label">Reply failed.</span><button type="button" class="retry-btn" aria-label="Retry last message"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg> Retry</button>`;
  row.querySelector(".retry-btn").addEventListener("click", retryLast);
  bubble.appendChild(row);
}

function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

// ---------- sending ----------
async function send() {
  const text = input.value.trim();
  if (!text || sending) return;

  if (!currentThread()) newThread();
  const t = currentThread();

  t.messages.push({ role: "user", content: text });
  if (t.title === "New chat") t.title = text.slice(0, 40) + (text.length > 40 ? "…" : "");
  t.updatedAt = Date.now();
  await persist();
  renderThreads(); renderMessages();

  input.value = ""; input.style.height = "auto";
  await streamReply();
}

async function retryLast() {
  if (sending) return;
  const t = currentThread();
  if (!t) return;
  while (t.messages.length && t.messages[t.messages.length - 1].role === "assistant") t.messages.pop();
  if (!t.messages.length || t.messages[t.messages.length - 1].role !== "user") return;
  await persist();
  renderMessages();
  await streamReply();
}

function setModelStatus(online, label) {
  modelPill.classList.toggle("offline", !online);
  if (label) modelLabel.textContent = label;
}

const MAX_ATTEMPTS = 3;

async function streamReply() {
  const t = currentThread();
  if (!t) return;
  sending = true; sendBtn.disabled = true; sendBtn.setAttribute("aria-busy", "true");

  const assistantMsg = { role: "assistant", content: "" };
  t.messages.push(assistantMsg);
  const node = renderMessage("assistant", "");
  const bubbleContent = node.querySelector(".bubble");
  bubbleContent.innerHTML = `<div class="typing" role="status"><span class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></span><span class="typing-label">Waguri is thinking…</span></div>`;
  const empty = messagesEl.querySelector(".empty-state"); if (empty) empty.remove();
  messagesEl.appendChild(node);
  scrollToBottom();

  const history = t.messages
    .slice(0, -1)
    .filter((m) => !m.error && (m.content || "").trim().length > 0)
    .map((m) => ({ role: m.role, content: m.content }));

  let lastError = null;

  // 24/7 guarantee: client-side retries with backoff on top of server model failover.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const usedModel = res.headers.get("X-Waguri-Model");
      if (usedModel) setModelStatus(true, usedModel.split("/").pop() + " · 24/7");
      else setModelStatus(true);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      bubbleContent.innerHTML = "";
      let acc = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        assistantMsg.content = acc;
        bubbleContent.innerHTML = renderMarkdown(acc);
        scrollToBottom();
        t.updatedAt = Date.now();
        persistSoon();
      }
      assistantMsg.error = false;
      enhanceBubble(bubbleContent, acc);
      t.updatedAt = Date.now();
      await persist();
      renderThreads();
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS) {
        const wait = 700 * attempt;
        bubbleContent.innerHTML = `<div class="typing" role="status"><span class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></span><span class="typing-label">Reconnecting… (attempt ${attempt + 1}/${MAX_ATTEMPTS})</span></div>`;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  if (lastError) {
    assistantMsg.content = `Couldn't reach the model after ${MAX_ATTEMPTS} attempts: ${lastError.message}`;
    assistantMsg.error = true;
    node.classList.add("error");
    bubbleContent.innerHTML = renderMarkdown(assistantMsg.content);
    attachRetryButton(node);
    setModelStatus(false, "reconnecting");
    t.updatedAt = Date.now();
    await persist();
  }

  sending = false; sendBtn.disabled = false; sendBtn.removeAttribute("aria-busy");
  input.focus();
}

// ---------- markdown ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function renderMarkdown(src) {
  if (!src) return "";
  let s = escapeHtml(src);
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${code}</code></pre>`);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/^### (.*)$/gm, "<h3>$1</h3>");
  s = s.replace(/^## (.*)$/gm, "<h2>$1</h2>");
  s = s.replace(/^# (.*)$/gm, "<h1>$1</h1>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(?:^|\n)((?:- .+\n?)+)/g, (m) => {
    const items = m.trim().split("\n").map((l) => `<li>${l.replace(/^- /, "")}</li>`).join("");
    return `\n<ul>${items}</ul>`;
  });
  s = s.split(/\n{2,}/).map((block) => {
    if (/^<(h\d|ul|ol|pre)/.test(block.trim())) return block;
    return `<p>${block.replace(/\n/g, "<br/>")}</p>`;
  }).join("");
  return s;
}

// ---------- theme ----------
const themeBtn = document.getElementById("themeBtn");
const themeIcon = document.getElementById("themeIcon");
const SUN_SVG = '<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.5" y1="4.5" x2="6.5" y2="6.5"/><line x1="17.5" y1="17.5" x2="19.5" y2="19.5"/><line x1="4.5" y1="19.5" x2="6.5" y2="17.5"/><line x1="17.5" y1="6.5" x2="19.5" y2="4.5"/>';
const MOON_SVG = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeIcon.innerHTML = theme === "light" ? MOON_SVG : SUN_SVG;
  themeBtn.title = theme === "light" ? "Switch to dark grey" : "Switch to light grey";
}
applyTheme((() => { try { return localStorage.getItem(THEME_KEY) || "dark"; } catch { return "dark"; } })());
themeBtn.addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  applyTheme(next);
  if (channel) { try { channel.postMessage({ type: "theme", from: TAB_ID, theme: next }); } catch {} }
});

// ---------- export ----------
const exportBtn = document.getElementById("exportBtn");
const exportMenu = document.getElementById("exportMenu");
function setExportExpanded(open) {
  exportBtn.setAttribute("aria-expanded", open ? "true" : "false");
  exportMenu.classList.toggle("show", open);
}
exportBtn.addEventListener("click", (e) => { e.stopPropagation(); setExportExpanded(!exportMenu.classList.contains("show")); });
document.addEventListener("click", (e) => {
  if (!exportMenu.contains(e.target) && e.target !== exportBtn) setExportExpanded(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (exportMenu.classList.contains("show")) setExportExpanded(false);
    if (sidebar.classList.contains("open")) closeSidebarMobile();
  }
});
function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}
function safeSlug(s) { return (s || "chat").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "chat"; }
function threadToTxt(t) {
  const header = `# ${t.title}\nCreated: ${new Date(t.createdAt).toISOString()}\n\n`;
  const body = t.messages.map((m) => `## ${m.role === "user" ? "You" : "Waguri"}\n${m.content}\n`).join("\n");
  return header + body;
}
exportMenu.addEventListener("click", async (e) => {
  const kind = e.target?.dataset?.export;
  if (!kind) return;
  setExportExpanded(false);
  const stampStr = new Date().toISOString().slice(0, 10);
  if (kind === "copy-current") {
    const t = currentThread();
    if (!t || !t.messages.length) { toast("This chat is empty."); return; }
    const ok = await copyText(threadToTxt(t));
    toast(ok ? "Chat copied to clipboard" : "Copy failed");
    return;
  }
  if (kind.startsWith("current")) {
    const t = currentThread();
    if (!t || !t.messages.length) { toast("This chat is empty."); return; }
    const slug = safeSlug(t.title);
    if (kind.endsWith("json")) download(`waguri-${slug}-${stampStr}.json`, JSON.stringify(t, null, 2), "application/json");
    else download(`waguri-${slug}-${stampStr}.txt`, threadToTxt(t), "text/plain");
  } else {
    if (!threads.length) { toast("No chats to export."); return; }
    if (kind.endsWith("json")) download(`waguri-all-${stampStr}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), threads }, null, 2), "application/json");
    else download(`waguri-all-${stampStr}.txt`, threads.map(threadToTxt).join("\n\n---\n\n"), "text/plain");
  }
});

// ---------- resume / lifecycle sync ----------
window.addEventListener("storage", (e) => {
  if (e.key === THEME_KEY && e.newValue) applyTheme(e.newValue);
  else if (e.key === STORAGE_KEY || e.key === ACTIVE_KEY) reloadFromStore();
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reloadFromStore(); });
window.addEventListener("pageshow", () => reloadFromStore());
window.addEventListener("pagehide", () => { lsSet(threads, activeId); });
window.addEventListener("beforeunload", () => { lsSet(threads, activeId); });
window.addEventListener("online", () => setModelStatus(true));
window.addEventListener("offline", () => setModelStatus(false, "offline"));

// ---------- boot ----------
(async () => {
  await loadAll();
  renderThreads();
  renderMessages();
})();
