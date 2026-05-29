// ── Auth ──────────────────────────────────────────────────────────────────────

function getToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, token => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(token);
    });
  });
}

// ── Gmail API ─────────────────────────────────────────────────────────────────

async function gmailGet(token, path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), 20_000);
    try {
      const r = await fetch(`https://www.googleapis.com/gmail/v1/users/me${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctl.signal,
      });
      clearTimeout(tid);
      if (r.status === 429) {
        await new Promise(res => setTimeout(res, (attempt + 1) * 2000));
        continue;
      }
      if (r.status === 401) throw new Error('Session expired — please sign in again.');
      if (!r.ok) throw new Error(`Gmail API ${r.status} on ${path}`);
      return r.json();
    } catch (e) {
      clearTimeout(tid);
      if (e.name === 'AbortError') {
        if (attempt < 3) { await new Promise(res => setTimeout(res, (attempt + 1) * 2000)); continue; }
        throw new Error('Gmail API request timed out');
      }
      throw e;
    }
  }
  throw new Error('Rate limited after retries — try again later.');
}

async function gmailPost(token, path, body = {}) {
  const r = await fetch(`https://www.googleapis.com/gmail/v1/users/me${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Gmail API ${r.status} on ${path}`);
  return r.json();
}

let _userEmail = null;
async function getUserEmail(token) {
  if (_userEmail) return _userEmail;
  const p = await gmailGet(token, '/profile');
  _userEmail = p.emailAddress;
  return _userEmail;
}

async function sendMailtoUnsubscribe(token, mailtoUrl) {
  const parsed = new URL(mailtoUrl);
  const to      = decodeURIComponent(parsed.pathname);
  const subject = parsed.searchParams.get('subject') || 'unsubscribe';
  const body    = parsed.searchParams.get('body')    || '';
  const from    = await getUserEmail(token);

  // Build a minimal RFC 2822 message
  const raw = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    body,
  ].join('\r\n');

  // Base64url-encode via TextEncoder so non-ASCII subjects/bodies are handled correctly
  const bytes = new TextEncoder().encode(raw);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  return gmailPost(token, '/messages/send', { raw: encoded });
}

async function* iterThreads(token, query, limit) {
  let pageToken = null, count = 0;
  while (count < limit) {
    const params = new URLSearchParams({ q: query, maxResults: Math.min(500, limit - count) });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await gmailGet(token, `/threads?${params}`);
    for (const t of (data.threads || [])) {
      yield t;
      if (++count >= limit) return;
    }
    pageToken = data.nextPageToken;
    if (!pageToken) return;
  }
}

// ── Unsubscribe logic ─────────────────────────────────────────────────────────

function getHeader(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

function decodeBody(part) {
  const data = part.body?.data;
  if (!data) return '';
  const bytes = Uint8Array.from(atob(data.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function getHtmlBody(payload) {
  if (payload.mimeType === 'text/html') return decodeBody(payload);
  for (const part of (payload.parts || [])) {
    const r = getHtmlBody(part);
    if (r) return r;
  }
  return '';
}

function extractFromHeader(val) {
  let httpUrl = null, mailto = null;
  for (const m of val.matchAll(/<([^>]+)>/g)) {
    const t = m[1].trim();
    if (t.startsWith('http')) httpUrl = t;
    else if (t.startsWith('mailto:')) mailto = t;
  }
  return { httpUrl, mailto };
}

const UNSUB_RE = /unsub|opt.out|manage.*(pref|email|notif|alert)|stop.*(email|receiv|alert)|turn.off/i;

function unescapeHtml(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function extractFromHtml(html) {
  for (const [, url, inner] of html.matchAll(/<a[^>]+href=["']([^"']{20,})["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = inner.replace(/<[^>]+>/g, '').trim();
    if (UNSUB_RE.test(text) && url.startsWith('http')) return unescapeHtml(url);
  }
  const lower = html.toLowerCase();
  for (const kw of ['unsub', 'opt-out', 'opt out', 'manage pref', 'email pref', 'turn off']) {
    let pos = 0;
    while (true) {
      const idx = lower.indexOf(kw, pos);
      if (idx === -1) break;
      const chunk = html.slice(Math.max(0, idx - 500), idx + 200);
      const hrefs = [...chunk.matchAll(/href=["']([^"']{20,})["']/g)].map(m => m[1]).reverse();
      for (const u of hrefs) {
        const ue = unescapeHtml(u);
        if (ue.startsWith('http')) return ue;
      }
      pos = idx + kw.length;
    }
  }
  return null;
}

const BROWSER_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function doUnsubscribe(url, usePost) {
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), 10_000);
  try {
    const postOpts = {
      method: 'POST',
      headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
      signal: ctl.signal,
    };
    let r;
    if (usePost) {
      r = await fetch(url, postOpts);
    } else {
      r = await fetch(url, { headers: BROWSER_HEADERS, signal: ctl.signal });
      if (r.status === 403 || r.status === 405) {
        r = await fetch(url, postOpts);
        return { ok: r.ok, status: `${r.status}(POST)` };
      }
    }
    return { ok: r.ok, status: String(r.status) };
  } catch (e) {
    return { ok: false, status: e.name === 'AbortError' ? 'timeout' : e.message.slice(0, 60) };
  } finally {
    clearTimeout(tid);
  }
}

// ── Job state & broadcast ─────────────────────────────────────────────────────

let jobState = null;   // non-null while a job is running or just finished
const activePorts = new Set();

function broadcast(msg) {
  // Keep jobState in sync so reconnecting popups can restore the UI
  if (jobState) {
    switch (msg.type) {
      case 'total':    jobState.total = msg.total; break;
      case 'stats':    jobState.stats = { ...msg.stats }; break;
      case 'status':   jobState.statusText = msg.text; break;
      case 'progress':
        jobState.done++;
        jobState.recentLog.unshift(msg);
        if (jobState.recentLog.length > 150) jobState.recentLog.length = 150;
        break;
      case 'done': case 'error':
        jobState.running = false;
        jobState.finalMsg = msg;
        break;
    }
  }
  for (const p of [...activePorts]) {
    try { p.postMessage(msg); } catch { activePorts.delete(p); }
  }
}

// ── Job runner ────────────────────────────────────────────────────────────────

async function runJob({ query, threadIds, limit, deleteAfter }) {
  // Capture this job's state object so cancel/reset from a subsequent job can't corrupt us.
  const myState = jobState;
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20_000);

  const token = await getToken();

  const maxItems = (limit && limit > 0) ? limit : Number.MAX_SAFE_INTEGER;

  let threads;
  if (threadIds && threadIds.length) {
    const capped = (maxItems < threadIds.length) ? threadIds.slice(0, maxItems) : threadIds;
    broadcast({ type:'status', text: `Processing ${capped.length} selected threads…` });
    threads = capped.map(id => ({ id }));
  } else {
    broadcast({ type:'status', text: `Fetching threads for: ${query}` });
    threads = [];
    for await (const t of iterThreads(token, query, maxItems)) {
      if (myState.cancelled) break;
      threads.push(t);
    }
  }
  if (myState.cancelled) { clearInterval(keepAlive); return; }
  broadcast({ type:'total', total: threads.length });

  if (threads.length === 0) { broadcast({ type: 'done', stats: { succeeded:0, failed:0, noUrl:0, manual:0, trashed:0 }, failedEntries: [] }); return; }

  const stats = { succeeded: 0, failed: 0, noUrl: 0, manual: 0, trashed: 0 };
  const successIds = [];
  const failedEntries = [];

  // Queue-based concurrency: 5 workers pull from shared queue independently.
  // Each item has a 35 s hard deadline — a hung network call can never stall a worker.
  const queue = threads.slice();
  let counter = 0;

  async function worker() {
    while (queue.length > 0 && !myState.cancelled) {
      const t = queue.shift();
      if (!t) break;
      const myIdx = ++counter;
      let sender = t.id;

      const itemWork = async () => {
        const data   = await gmailGet(token, `/threads/${t.id}?format=full`);
        const msg    = data.messages[0];
        const hdrs   = msg.payload.headers || [];
        sender = getHeader(hdrs, 'From') || 'unknown';
        const lu     = getHeader(hdrs, 'List-Unsubscribe');
        const luPost = getHeader(hdrs, 'List-Unsubscribe-Post');

        let httpUrl = null, mailto = null, source = null;
        if (lu) { ({ httpUrl, mailto } = extractFromHeader(lu)); source = 'header'; }
        if (!httpUrl) { httpUrl = extractFromHtml(getHtmlBody(msg.payload)); source = 'html'; }

        if (httpUrl) {
          const { ok, status } = await doUnsubscribe(httpUrl, Boolean(luPost));
          if (ok) {
            stats.succeeded++;
            successIds.push(t.id);
            broadcast({ type:'progress', idx: myIdx, sender, ok: true, status: `[${source}] ${status}` });
          } else if (mailto) {
            // HTTP failed — fall back to mailto: via Gmail API
            try {
              await sendMailtoUnsubscribe(token, mailto);
              stats.succeeded++;
              successIds.push(t.id);
              broadcast({ type:'progress', idx: myIdx, sender, ok: true, status: 'mailto sent' });
            } catch (e) {
              stats.failed++;
              failedEntries.push({ id: t.id, sender, reason: `[${source}] ${status}`, type: 'failed' });
              broadcast({ type:'progress', idx: myIdx, sender, ok: false, status: `[${source}] ${status}` });
            }
          } else {
            stats.failed++;
            failedEntries.push({ id: t.id, sender, reason: `[${source}] ${status}`, type: 'failed' });
            broadcast({ type:'progress', idx: myIdx, sender, ok: false, status: `[${source}] ${status}` });
          }
        } else if (mailto) {
          // Send the unsubscribe email through Gmail API — arrives from Google's servers.
          try {
            await sendMailtoUnsubscribe(token, mailto);
            stats.succeeded++;
            successIds.push(t.id);
            broadcast({ type:'progress', idx: myIdx, sender, ok: true, status: 'mailto sent' });
          } catch (e) {
            stats.failed++;
            failedEntries.push({ id: t.id, sender, reason: `mailto: ${e.message.slice(0, 60)}`, type: 'failed' });
            broadcast({ type:'progress', idx: myIdx, sender, ok: false, status: `mailto error: ${e.message.slice(0, 40)}` });
          }
        } else {
          stats.noUrl++;
          failedEntries.push({ id: t.id, sender, reason: 'no URL found', type: 'nourl' });
          broadcast({ type:'progress', idx: myIdx, sender, ok: false, status: 'no URL found' });
        }
      };

      try {
        await Promise.race([
          itemWork(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('item timed out after 35 s')), 35_000)),
        ]);
      } catch (e) {
        stats.failed++;
        failedEntries.push({ id: t.id, sender, reason: e.message.slice(0, 80), type: 'failed' });
        broadcast({ type:'progress', idx: myIdx, sender, ok: false, status: `error: ${e.message.slice(0, 50)}` });
      }
      broadcast({ type:'stats', stats });
    }
  }

  const CONCURRENCY = 5;
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  clearInterval(keepAlive);
  // If this job was cancelled (and possibly superseded), don't send done — would clobber the new job.
  if (myState.cancelled) return;

  if (deleteAfter && successIds.length) {
    broadcast({ type:'status', text: `🗑️ Trashing ${successIds.length} threads…` });
    // Re-fetch token — long jobs can outlive the original token's 1-hour lifetime.
    const trashToken = await new Promise(resolve =>
      chrome.identity.getAuthToken({ interactive: false }, t => resolve(t || token))
    );
    await Promise.all(successIds.map(async id => {
      try {
        await gmailPost(trashToken, `/threads/${id}/trash`);
        stats.trashed++;
      } catch (e) {
        broadcast({ type:'status', text: `⚠️ Trash failed for ${id}: ${e.message.slice(0, 60)}` });
      }
    }));
    broadcast({ type:'stats', stats });
  }

  broadcast({ type:'done', stats, failedEntries });
}

// ── Message handlers ──────────────────────────────────────────────────────────

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'job') return;
  // Subscribe every connecting port immediately — popup and floating button both get all broadcasts.
  activePorts.add(port);
  port.onDisconnect.addListener(() => activePorts.delete(port));

  if (jobState?.running) {
    // New subscriber joining a live job — send current snapshot so it can restore UI.
    try {
      port.postMessage({ type: 'jobRunning', state: {
        total:      jobState.total,
        done:       jobState.done,
        stats:      jobState.stats,
        statusText: jobState.statusText,
        recentLog:  jobState.recentLog,
      }});
    } catch {}
  } else if (jobState?.finalMsg) {
    // Job finished while this client was away — deliver the result once.
    try { port.postMessage(jobState.finalMsg); } catch {}
    jobState = null;
  }

  port.onMessage.addListener(async msg => {
    if (msg.action === 'cancel') {
      if (jobState?.running) {
        jobState.running = false;
        jobState.cancelled = true;
        broadcast({ type: 'stopped' });
      }
      return;
    }
    if (msg.action !== 'start' || jobState?.running) return;
    jobState = {
      running: true, cancelled: false, total: 0, done: 0,
      stats: { succeeded: 0, failed: 0, noUrl: 0, manual: 0, trashed: 0 },
      statusText: 'Starting…', recentLog: [], finalMsg: null,
    };
    try { await runJob(msg); }
    catch (e) { broadcast({ type: 'error', message: e.message }); }
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'authenticate') {
    getToken()
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.action === 'signOut') {
    chrome.identity.getAuthToken({ interactive: false }, token => {
      if (token) chrome.identity.removeCachedAuthToken({ token }, () => sendResponse({ ok: true }));
      else sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.action === 'checkAuth') {
    chrome.identity.getAuthToken({ interactive: false }, token => {
      sendResponse({ signedIn: !!token && !chrome.runtime.lastError });
    });
    return true;
  }
});
