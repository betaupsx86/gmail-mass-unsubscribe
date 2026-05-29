const $ = id => document.getElementById(id);

let currentQuery = null;
let selectedThreadIds = null;
let jobPort = null;
let total = 0;
let done = 0;
let failedEntries = [];
let isRunning = false;

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const { signedIn } = await chrome.runtime.sendMessage({ action: 'checkAuth' });
  showAuth(!signedIn);
  if (signedIn) {
    detectCurrentView();
    connectToBackground();
  }
  chrome.storage.local.get(['gmu-limit', 'gmu-delete'], prefs => {
    if (prefs['gmu-limit'] !== undefined) $('limitInput').value = prefs['gmu-limit'];
    if (prefs['gmu-delete'] === true) $('deleteChip').classList.add('active');
  });
});

function connectToBackground() {
  if (jobPort) return;
  jobPort = chrome.runtime.connect({ name: 'job' });
  jobPort.onMessage.addListener(handleMessage);
  jobPort.onDisconnect.addListener(() => { jobPort = null; });
}

function showAuth(show) {
  $('authSection').classList.toggle('hidden', !show);
  $('mainSection').classList.toggle('hidden', show);
  $('signOutBtn').classList.toggle('hidden', show);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

$('signInBtn').addEventListener('click', async () => {
  $('signInBtn').disabled = true;
  $('signInBtn').textContent = 'Opening Google sign-in…';
  $('authError').classList.add('hidden');
  const resp = await chrome.runtime.sendMessage({ action: 'authenticate' });
  if (resp.error) {
    $('authError').textContent = resp.error;
    $('authError').classList.remove('hidden');
    $('signInBtn').textContent = 'Sign in with Google';
    $('signInBtn').disabled = false;
    return;
  }
  showAuth(false);
  detectCurrentView();
  connectToBackground();
});

$('signOutBtn').addEventListener('click', async () => {
  if (jobPort) { jobPort.disconnect(); jobPort = null; }
  await chrome.runtime.sendMessage({ action: 'signOut' });
  showAuth(true);
  $('progressInline').classList.add('hidden');
  isRunning = false;
});

// ── Category chips (single-select toggle) ─────────────────────────────────────

document.querySelectorAll('#categoryChips .chip').forEach(btn => {
  btn.addEventListener('click', () => {
    const wasActive = btn.classList.contains('active');
    document.querySelectorAll('#categoryChips .chip').forEach(b => b.classList.remove('active'));
    if (!wasActive) btn.classList.add('active');
    pushChipsToQuery();
  });
});

// ── Importance / Star / Read chips (single-select pairs) ─────────────────────

['#importanceChips', '#starChips', '#readChips'].forEach(id => {
  document.querySelectorAll(`${id} .chip`).forEach(btn => {
    btn.addEventListener('click', () => {
      const wasActive = btn.classList.contains('active');
      document.querySelectorAll(`${id} .chip`).forEach(b => b.classList.remove('active'));
      if (!wasActive) btn.classList.add('active');
      pushChipsToQuery();
    });
  });
});

// ── Age chips (single-select) ─────────────────────────────────────────────────

document.querySelectorAll('#ageChips .chip').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#ageChips .chip').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    pushChipsToQuery();
  });
});

// ── Delete / Limit toggles ────────────────────────────────────────────────────

$('deleteChip').addEventListener('click', () => {
  $('deleteChip').classList.toggle('active');
  chrome.storage.local.set({ 'gmu-delete': $('deleteChip').classList.contains('active') });
});


$('limitInput').addEventListener('input', () => {
  const v = parseInt($('limitInput').value);
  if (!isNaN(v) && v <= 0) $('limitInput').value = '';
  chrome.storage.local.set({ 'gmu-limit': $('limitInput').value });
});

// ── Query building ────────────────────────────────────────────────────────────

function buildQueryFromChips() {
  const cat  = document.querySelector('#categoryChips .chip.active')?.dataset.cat;
  const imp  = document.querySelector('#importanceChips .chip.active')?.dataset.imp;
  const star = document.querySelector('#starChips .chip.active')?.dataset.star;
  const read = document.querySelector('#readChips .chip.active')?.dataset.read;
  const age  = document.querySelector('#ageChips .chip.active')?.dataset.age ?? '';

  const parts = [];
  if (cat)  parts.push(`category:${cat}`);
  if (imp === 'important')     parts.push('is:important');
  if (imp === 'not-important') parts.push('-is:important');
  if (star === 'starred')      parts.push('is:starred');
  if (star === 'not-starred')  parts.push('-is:starred');
  if (read === 'unread')       parts.push('is:unread');
  if (read === 'read')         parts.push('is:read');
  if (age) parts.push(`older_than:${age}`);
  return parts.join(' ');
}

function pushChipsToQuery() {
  selectedThreadIds = null;
  $('queryInput').disabled = false;
  const q = buildQueryFromChips();
  $('queryInput').value = q;
  setQuery(q);
}

function clearChips() {
  document.querySelectorAll('#categoryChips .chip, #importanceChips .chip, #starChips .chip, #readChips .chip, #ageChips .chip')
    .forEach(b => b.classList.remove('active'));
  document.querySelector('#ageChips .chip[data-age=""]').classList.add('active');
}

// ── Query input ───────────────────────────────────────────────────────────────

$('queryInput').addEventListener('input', () => {
  selectedThreadIds = null;
  $('queryInput').disabled = false;
  clearChips();
  setQuery($('queryInput').value.trim() || null);
});

function setQuery(q) {
  currentQuery = q || null;
  if (!isRunning) $('startBtn').disabled = !q && !selectedThreadIds;
}

// ── Current view / selection ──────────────────────────────────────────────────

async function detectCurrentView() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const tab = tabs[0];
  if (!tab?.url?.includes('mail.google.com')) return;

  const sel = await chrome.tabs.sendMessage(tab.id, { action: 'getSelected' }).catch(() => null);
  if (sel?.threadIds?.length) {
    selectedThreadIds = sel.threadIds;
    clearChips();
    $('queryInput').value = `${sel.threadIds.length} thread${sel.threadIds.length > 1 ? 's' : ''} selected`;
    $('queryInput').disabled = true;
    if (!isRunning) $('startBtn').disabled = false;
    return;
  }

  selectedThreadIds = null;
  $('queryInput').disabled = false;
  const resp = await chrome.tabs.sendMessage(tab.id, { action: 'getCurrentQuery' }).catch(() => null);
  if (resp?.query) {
    clearChips();
    $('queryInput').value = resp.query;
    setQuery(resp.query);
  }
}

$('currentViewBtn').addEventListener('click', detectCurrentView);

// ── Job ───────────────────────────────────────────────────────────────────────

$('startBtn').addEventListener('click', () => {
  if (isRunning) { stopJob(); } else { startJob(); }
});

$('saveReportBtn').addEventListener('click', () => {
  const date = new Date().toISOString().slice(0, 10);
  const failed  = failedEntries.filter(e => e.type === 'failed');
  const noLinks = failedEntries.filter(e => e.type === 'nourl' || e.type === 'manual');

  const lines = [`Gmail Mass Unsubscribe — Report (${date})`, '='.repeat(56), ''];

  lines.push(`FAILED TO UNSUBSCRIBE (${failed.length})`, '-'.repeat(40), '');
  for (const e of failed) {
    lines.push(e.sender);
    lines.push(`  Link:   https://mail.google.com/mail/u/0/#all/${e.id}`);
    lines.push(`  Reason: ${e.reason}`);
    lines.push('');
  }

  lines.push(`NO UNSUBSCRIBE LINK FOUND (${noLinks.length})`, '-'.repeat(40), '');
  for (const e of noLinks) {
    const tag = e.type === 'manual' ? '[MAILTO]' : '[NO URL]';
    lines.push(`${tag} ${e.sender}`);
    lines.push(`  Link:   https://mail.google.com/mail/u/0/#all/${e.id}`);
    lines.push(`  Reason: ${e.reason}`);
    lines.push('');
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `unsubscribe-report-${date}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

function startJob() {
  const rawLimit = parseInt($('limitInput').value);
  const limit       = isNaN(rawLimit) || rawLimit <= 0 ? 0 : rawLimit;
  const deleteAfter = $('deleteChip').classList.contains('active');

  isRunning = true;
  $('startBtn').textContent = '■ Stop';
  $('startBtn').classList.add('stop-mode');
  $('progressInline').classList.remove('hidden');
  $('saveReportBtn').classList.add('hidden');
  $('logList').innerHTML = '';
  total = 0; done = 0; failedEntries = [];
  $('progressBar').style.width = '0%';
  updateStats({ succeeded: 0, failed: 0, noUrl: 0, manual: 0, trashed: 0 });
  $('statusText').textContent = 'Starting…';

  connectToBackground();
  jobPort.postMessage({ action: 'start', query: currentQuery, threadIds: selectedThreadIds, limit, deleteAfter });
}

function stopJob() {
  if (jobPort) {
    try { jobPort.postMessage({ action: 'cancel' }); } catch {}
    jobPort.disconnect();
    jobPort = null;
  }
  isRunning = false;
  $('startBtn').textContent = '▶ Start';
  $('startBtn').classList.remove('stop-mode');
  $('startBtn').disabled = !currentQuery && !selectedThreadIds;
  $('statusText').textContent = 'Stopped.';
  // Reconnect so we receive broadcasts from future floating-button-started jobs.
  connectToBackground();
}

function jobFinished() {
  isRunning = false;
  $('startBtn').textContent = '▶ Start';
  $('startBtn').classList.remove('stop-mode');
  $('startBtn').disabled = !currentQuery && !selectedThreadIds;
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'jobRunning': {
      const s = msg.state;
      total = s.total; done = s.done;
      isRunning = true;
      $('startBtn').textContent = '■ Stop';
      $('startBtn').classList.add('stop-mode');
      $('startBtn').disabled = false;
      $('progressInline').classList.remove('hidden');
      $('saveReportBtn').classList.add('hidden');
      $('logList').innerHTML = '';
      updateProgress();
      updateStats(s.stats);
      $('statusText').textContent = `${s.done}/${s.total} — reconnected`;
      for (const entry of [...s.recentLog].reverse()) addLogEntry(entry);
      break;
    }
    case 'stopped':
      if (isRunning) { $('statusText').textContent = 'Stopped.'; jobFinished(); }
      break;
    case 'status':  $('statusText').textContent = msg.text; break;
    case 'total':
      total = msg.total;
      $('statusText').textContent = `Processing ${total} threads…`;
      updateProgress();
      break;
    case 'progress':
      done++;
      updateProgress();
      addLogEntry(msg);
      $('statusText').textContent = `${done}/${total} — ${(msg.sender || '').replace(/<[^>]+>/g, '').slice(0, 35)}`;
      break;
    case 'stats':  updateStats(msg.stats); break;
    case 'done':
      updateStats(msg.stats);
      $('statusText').textContent = 'Done.';
      jobFinished();
      if (msg.failedEntries?.length) {
        failedEntries = msg.failedEntries;
        const hasContent = failedEntries.some(e => e.type === 'failed' || e.type === 'nourl' || e.type === 'manual');
        if (hasContent) $('saveReportBtn').classList.remove('hidden');
      }
      break;
    case 'error':
      $('statusText').textContent = `Error: ${msg.message}`;
      jobFinished();
      break;
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function updateProgress() {
  $('progressBar').style.width = total > 0 ? `${Math.round(done / total * 100)}%` : '0%';
}

function updateStats(s) {
  $('statOk').textContent    = s.succeeded;
  $('statFail').textContent  = s.failed;
  $('statSkip').textContent  = s.noUrl + s.manual;
  $('statTrash').textContent = s.trashed;
}

function addLogEntry({ sender, ok, status }) {
  const isSkip = status.startsWith('no URL') || status === 'manual mailto';
  const icon = ok ? '✓' : isSkip ? '?' : '✗';
  const cls  = ok ? 'ok' : isSkip ? 'skip' : 'fail';
  const el = document.createElement('div');
  el.className = `log-entry ${cls}`;
  const s = (sender || '').replace(/<[^>]+>/g, '').slice(0, 32).padEnd(32);
  el.textContent = `${icon} ${s} ${status}`;
  $('logList').prepend(el);
}
