// ── Query detection ───────────────────────────────────────────────────────────

function parseGmailUrl() {
  const hash = decodeURIComponent(window.location.hash);
  if (hash.startsWith('#category/'))  return `category:${hash.slice('#category/'.length).split('/')[0]}`;
  if (hash.startsWith('#label/'))     return `label:${hash.slice('#label/'.length).split('/')[0]}`;
  if (hash.startsWith('#search/'))    return hash.slice('#search/'.length);
  if (hash === '#inbox' || hash.startsWith('#inbox/')) return 'in:inbox';
  if (hash.startsWith('#starred'))    return 'is:starred';
  if (hash.startsWith('#imp'))        return 'is:important';
  if (hash.startsWith('#all'))        return 'in:all';
  return null;
}

// Track "Select all conversations" by watching the URL hash + polling .x8 state.
// _selectAllHash = the hash where "select all" was activated, or null if not active.
let _selectAllHash = null;
let _x8HadRole     = true;  // assume .x8 starts with a role

// When the URL changes, clear select-all state and pause detection for 1 s
// so Gmail can finish re-rendering (avoids reading stale .x8 state mid-render).
let _detecting = true;
window.addEventListener('hashchange', () => {
  _selectAllHash = null;
  _detecting     = false;
  setTimeout(() => {
    const b = document.querySelector('.x8');
    _x8HadRole  = !b || b.hasAttribute('role');  // sync to settled state
    _detecting  = true;
  }, 1000);
});

// Poll every 300 ms. When .x8 transitions from having a role to having no role,
// the user just clicked "Select all conversations" on this URL — record it.
setInterval(() => {
  if (!_detecting) return;
  const b       = document.querySelector('.x8');
  const hasRole = !b || b.hasAttribute('role');
  if (_x8HadRole && !hasRole) _selectAllHash = location.hash; // → "Select all conversations"
  if (!_x8HadRole && hasRole)  _selectAllHash = null;          // → "Clear all" / deselected
  _x8HadRole = hasRole;
  // Update floating trigger label based on selection state
  const trigger = document.getElementById('gmu-trigger');
  if (trigger) {
    const isSelectAll = _selectAllHash !== null && _selectAllHash === location.hash;
    const hasChecked = !!document.querySelector('.oZ-jc[aria-checked="true"]');
    trigger.textContent = (hasChecked && !isSelectAll) ? '✉ Unsubscribe Selected' : '✉ Unsubscribe All';
  }
}, 300);

function decodeB64(b64) {
  const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
  return atob(padded);
}

function threadIdFromJslog(jslog) {
  // Format 1: " 1:BASE64" — category/label views; decodes to proto with "thread-f:DECIMAL"
  const m1 = jslog.match(/\s1:([A-Za-z0-9+/]+)/);
  if (m1) {
    try {
      const decoded = decodeB64(m1[1]);
      const m = decoded.match(/thread-[fa]:(\d+)/);
      if (m) return BigInt(m[1]).toString(16);
    } catch {}
  }

  // Format 2: " 41:BASE64" — search results; decodes to JSON array with thread ID
  // Base64 stops at first non-base64 char (e.g. ".") so no terminator needed.
  // Gmail sometimes uses URL-safe base64 (-/_) so normalize before decoding.
  const m41 = jslog.match(/\s41:([A-Za-z0-9+/\-_=]+)/);
  if (m41) {
    try {
      const b64 = m41[1].replace(/-/g, '+').replace(/_/g, '/');
      const arr = JSON.parse(decodeB64(b64));
      // arr[4][4] is the thread ID — already in hex in this format
      const primary = arr?.[4]?.[4];
      if (typeof primary === 'string' && /^[0-9a-f]{10,}$/i.test(primary)) return primary.toLowerCase();
      // Fallback: search nested arrays for a hex thread ID string
      const found = (function search(node) {
        if (!Array.isArray(node)) return null;
        for (const v of node) {
          if (typeof v === 'string' && /^[0-9a-f]{10,}$/i.test(v)) return v.toLowerCase();
          const r = search(v);
          if (r) return r;
        }
        return null;
      })(arr);
      if (found) return found;
    } catch {}
  }

  return null;
}

function getSelectedThreadIds() {
  // "Select all conversations" was clicked on this exact URL → use URL query instead
  if (_selectAllHash !== null && _selectAllHash === location.hash) return [];

  const seen = new Set();
  return [...document.querySelectorAll('.oZ-jc[aria-checked="true"]')]
    .map(cb => cb.closest('tr.zA'))
    .filter(Boolean)
    .map(row => threadIdFromJslog(row.getAttribute('jslog') || ''))
    .filter(id => id && !seen.has(id) && seen.add(id));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'getCurrentQuery') sendResponse({ query: parseGmailUrl() });
  if (msg.action === 'getSelected') sendResponse({ threadIds: getSelectedThreadIds() });
});

// ── Injected button ───────────────────────────────────────────────────────────

function injectButton() {
  if (document.getElementById('gmu-btn')) return;

  const style = document.createElement('style');
  style.textContent = `
    #gmu-btn {
      position: fixed; bottom: 24px; right: 24px; z-index: 9999;
      font-family: 'Google Sans', Roboto, sans-serif; font-size: 13px;
    }
    #gmu-trigger {
      background: #1a73e8; color: #fff; border: none; border-radius: 24px;
      padding: 10px 18px; cursor: pointer; font-size: 13px; font-weight: 500;
      box-shadow: 0 2px 8px rgba(0,0,0,.25); transition: background .15s;
      display: flex; align-items: center; gap: 6px;
    }
    #gmu-trigger:hover { background: #1765cc; }
    #gmu-panel {
      position: absolute; bottom: 52px; right: 0; width: 290px;
      background: #fff; border-radius: 12px; padding: 12px 16px 16px;
      box-shadow: 0 4px 24px rgba(0,0,0,.18);
      display: flex; flex-direction: column; gap: 10px;
    }
    #gmu-panel.gmu-hidden { display: none; }
    #gmu-panel-header { display: flex; justify-content: flex-end; margin-bottom: -4px; }
    #gmu-close { background: none; border: none; cursor: pointer; color: #5f6368; font-size: 18px; line-height: 1; padding: 0; }
    #gmu-query {
      font-size: 11px; font-family: monospace; background: #e8f0fe;
      color: #1a73e8; padding: 7px 9px; border-radius: 6px; word-break: break-all;
      min-height: 28px;
    }
    #gmu-query.gmu-noquery { background: #fce8e6; color: #c5221f; }
    .gmu-row { display: flex; align-items: center; gap: 8px; }
    .gmu-row label { display: flex; align-items: center; gap: 5px; font-size: 12px; color: #5f6368; white-space: nowrap; flex: 1; }
    .gmu-row input[type=number] { width: 60px; padding: 5px 8px; border: 1px solid #dadce0; border-radius: 6px; font-size: 12px; }
    .gmu-chip-btn {
      background: #f1f3f4; color: #3c4043; border: 1.5px solid transparent;
      border-radius: 14px; padding: 5px 11px; font-size: 12px; font-weight: 500;
      cursor: pointer; transition: all .15s; white-space: nowrap; font-family: inherit;
    }
    .gmu-chip-btn:hover { background: #e8eaed; }
    .gmu-chip-btn.active { background: #e8f0fe; color: #1a73e8; border-color: #1a73e8; }
    #gmu-start {
      background: #1a73e8; color: #fff; border: none; border-radius: 8px;
      padding: 9px; cursor: pointer; font-size: 13px; font-weight: 500; width: 100%;
      transition: background .15s;
    }
    #gmu-start:hover:not(:disabled) { background: #1765cc; }
    #gmu-start.gmu-stop { background: #f1f3f4; color: #d93025; }
    #gmu-start.gmu-stop:hover { background: #fce8e6; }
    #gmu-start:disabled { opacity: .45; cursor: default; }
    #gmu-progress { display: flex; flex-direction: column; gap: 8px; }
    #gmu-progress.gmu-hidden { display: none; }
    #gmu-bar-wrap { height: 5px; background: #f1f3f4; border-radius: 3px; overflow: hidden; }
    #gmu-bar { height: 100%; background: #1a73e8; width: 0%; transition: width .4s; }
    #gmu-status { font-size: 11px; color: #5f6368; }
    #gmu-stats { font-size: 11px; display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; }
    .gmu-ok { color: #188038; font-weight: 500; }
    .gmu-fail { color: #d93025; font-weight: 500; }
    .gmu-skip { color: #e37400; }
    .gmu-muted { color: #80868b; }
  `;
  document.head.appendChild(style);

  const btn = document.createElement('div');
  btn.id = 'gmu-btn';
  btn.innerHTML = `
    <button id="gmu-trigger">✉ Unsubscribe All</button>
    <div id="gmu-panel" class="gmu-hidden">
      <div id="gmu-panel-header">
        <button id="gmu-close" title="Close">×</button>
      </div>
      <div id="gmu-query"></div>
      <div class="gmu-row">
        <label>Limit <input type="number" id="gmu-limit" placeholder="∞" min="1" max="50000" /></label>
        <button id="gmu-delete" class="gmu-chip-btn">🗑️ Trash after</button>
      </div>
      <button id="gmu-start">▶ Start</button>
      <div id="gmu-progress" class="gmu-hidden">
        <div id="gmu-bar-wrap"><div id="gmu-bar"></div></div>
        <div id="gmu-status"></div>
        <div id="gmu-stats"></div>
      </div>
    </div>
  `;
  document.body.appendChild(btn);

  const panel      = document.getElementById('gmu-panel');
  const queryEl    = document.getElementById('gmu-query');
  const startBtn   = document.getElementById('gmu-start');
  const deleteBtn  = document.getElementById('gmu-delete');
  const progress   = document.getElementById('gmu-progress');
  const bar        = document.getElementById('gmu-bar');
  const statusEl   = document.getElementById('gmu-status');
  const statsEl    = document.getElementById('gmu-stats');
  const limitInput = document.getElementById('gmu-limit');

  let total = 0, done = 0, running = false;
  let floatingThreadIds = null;

  function renderStats(s) {
    statsEl.innerHTML =
      `<span class="gmu-ok">✓ ${s.succeeded} Unsubscribed</span>` +
      `<span class="gmu-fail">✗ ${s.failed} Failed</span>` +
      `<span class="gmu-skip">∅ ${s.noUrl + s.manual} No Link</span>` +
      `<span class="gmu-muted">🗑️ ${s.trashed} Trashed</span>`;
  }

  // ── Always-on port ────────────────────────────────────────────────────────────
  // Connect immediately so we receive broadcasts from popup-started jobs too.
  // Stop sends 'cancel' but never disconnects this port.
  let port = connectBgPort();

  function connectBgPort() {
    const p = chrome.runtime.connect({ name: 'job' });
    p.onMessage.addListener(onPortMsg);
    p.onDisconnect.addListener(() => {
      // Service worker restarted — reconnect after a short delay
      setTimeout(() => { port = connectBgPort(); }, 800);
    });
    return p;
  }

  function onPortMsg(msg) {
    switch (msg.type) {
      case 'jobRunning': {
        const s = msg.state;
        total = s.total; done = s.done;
        setRunning(true);
        progress.classList.remove('gmu-hidden');
        bar.style.width = total > 0 ? `${Math.round(done / total * 100)}%` : '0%';
        statusEl.textContent = `${done}/${total} — synced`;
        if (s.stats) renderStats(s.stats);
        break;
      }
      case 'status':
        if (!running) {
          setRunning(true);
          progress.classList.remove('gmu-hidden');
          bar.style.width = '0%';
          statsEl.innerHTML = '';
          total = 0; done = 0;
        }
        statusEl.textContent = msg.text;
        break;
      case 'total':
        total = msg.total;
        statusEl.textContent = `Processing ${total} threads…`;
        break;
      case 'progress':
        done++;
        bar.style.width = total > 0 ? `${Math.round(done / total * 100)}%` : '0%';
        statusEl.textContent = `${done}/${total} — ${(msg.sender || '').replace(/<[^>]+>/g, '').slice(0, 35)}`;
        break;
      case 'stats':
        renderStats(msg.stats);
        break;
      case 'stopped':
        statusEl.textContent = 'Stopped.';
        setRunning(false);
        break;
      case 'done':
        statusEl.textContent = 'Done.';
        setRunning(false);
        break;
      case 'error':
        statusEl.textContent = `Error: ${msg.message}`;
        setRunning(false);
        break;
    }
  }

  // Load saved prefs from chrome.storage (shared with popup)
  chrome.storage.local.get(['gmu-limit', 'gmu-delete'], prefs => {
    if (prefs['gmu-limit'] !== undefined) limitInput.value = prefs['gmu-limit'];
    if (prefs['gmu-delete'] === true) deleteBtn.classList.add('active');
  });
  // Stay in sync when popup changes the values
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes['gmu-limit'] !== undefined) limitInput.value = changes['gmu-limit'].newValue ?? '';
    if (changes['gmu-delete'] !== undefined) {
      deleteBtn.classList.toggle('active', !!changes['gmu-delete'].newValue);
    }
  });
  limitInput.addEventListener('input', () => {
    const v = parseInt(limitInput.value);
    if (!isNaN(v) && v <= 0) limitInput.value = '';
    chrome.storage.local.set({ 'gmu-limit': limitInput.value });
  });
  deleteBtn.addEventListener('click', () => {
    deleteBtn.classList.toggle('active');
    chrome.storage.local.set({ 'gmu-delete': deleteBtn.classList.contains('active') });
  });

  function refreshQuery() {
    floatingThreadIds = getSelectedThreadIds();
    if (floatingThreadIds.length) {
      queryEl.textContent = `${floatingThreadIds.length} thread${floatingThreadIds.length > 1 ? 's' : ''} selected`;
      queryEl.classList.remove('gmu-noquery');
      if (!running) startBtn.disabled = false;
      return null;
    }
    floatingThreadIds = null;
    const q = parseGmailUrl();
    queryEl.textContent = q || 'No recognizable Gmail view detected';
    queryEl.classList.toggle('gmu-noquery', !q);
    if (!running) startBtn.disabled = !q;
    return q;
  }

  function openPanel() {
    panel.classList.remove('gmu-hidden');
    refreshQuery();
  }

  function closePanel() {
    panel.classList.add('gmu-hidden');
  }

  function setRunning(state) {
    running = state;
    if (state) {
      startBtn.textContent = '■ Stop';
      startBtn.classList.add('gmu-stop');
      startBtn.disabled = false;
    } else {
      startBtn.textContent = '▶ Start';
      startBtn.classList.remove('gmu-stop');
    }
  }

  document.getElementById('gmu-trigger').addEventListener('click', e => {
    e.stopPropagation();
    panel.classList.contains('gmu-hidden') ? openPanel() : closePanel();
  });

  document.getElementById('gmu-close').addEventListener('click', closePanel);

  document.addEventListener('click', e => {
    if (!btn.contains(e.target)) closePanel();
  });

  window.addEventListener('hashchange', () => {
    if (!panel.classList.contains('gmu-hidden')) refreshQuery();
  });

  startBtn.addEventListener('click', () => {
    if (running) {
      port.postMessage({ action: 'cancel' });
      setRunning(false);
      statusEl.textContent = 'Stopped.';
      return;
    }

    const query = refreshQuery();
    if (!query && !floatingThreadIds?.length) return;

    const limit = parseInt(limitInput.value) || 0;
    const deleteAfter = deleteBtn.classList.contains('active');

    progress.classList.remove('gmu-hidden');
    bar.style.width = '0%';
    statsEl.innerHTML = '';
    statusEl.textContent = 'Starting…';
    total = 0; done = 0;
    setRunning(true);

    port.postMessage({ action: 'start', query, threadIds: floatingThreadIds, limit, deleteAfter });
  });
}


// Wait for Gmail to fully load then inject
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectButton);
} else {
  injectButton();
}
