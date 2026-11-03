// Service worker. All state lives in chrome.storage.local ("rec") + IndexedDB, so the worker can be
// suspended and restarted at any time without losing the recording.
import * as DB from './lib/db.js';
import { getSettings } from './lib/settings.js';

const COUNTED = new Set(['click', 'input', 'select', 'toggle', 'navigation', 'dialog_open', 'manual_screenshot']);
const MIN_CAPTURE_GAP_MS = 700; // Chrome allows ~2 captureVisibleTab calls per second
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let S = { status: 'idle' };
const ready = chrome.storage.local.get('rec').then(({ rec }) => { if (rec) S = rec; });

// ---- serialisation -------------------------------------------------------------------------
let eventChain = Promise.resolve();
const serial = (fn) => { const p = eventChain.then(fn); eventChain = p.catch(() => {}); return p; };
let shotChain = Promise.resolve();
let lastCaptureAt = 0;
const beforeShots = new Map(); // token -> Promise<shotId|null>
let stopping = null;

const isRecording = () => S.status === 'recording';
const fromBoundTab = (sender) => isRecording() && sender?.tab?.id === S.tabId && sender.tab.windowId === S.windowId;

async function persist() {
  await chrome.storage.local.set({ rec: S });
  updateBadge();
}

function updateBadge() {
  if (isRecording()) {
    chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
    chrome.action.setBadgeText({ text: S.count > 0 ? String(S.count) : 'REC' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

async function flashBadge(text) {
  chrome.action.setBadgeBackgroundColor({ color: '#f9ab00' });
  chrome.action.setBadgeText({ text });
  await sleep(2000);
  updateBadge();
}

// ---- events --------------------------------------------------------------------------------
function recordEvent(ev) {
  return serial(async () => {
    await ready;
    if (!isRecording()) return null;
    const t = ev.t || Date.now();
    const rec = {
      sessionId: S.sessionId,
      seq: ++S.eventSeq,
      ...ev,
      t,
      offsetMs: t - S.startedAt,
      audioOffsetMs: S.audioStartedAt ? t - S.audioStartedAt : null,
      shots: {},
    };
    await DB.putEvent(rec);
    if (COUNTED.has(rec.type)) S.count++;
    await persist();
    return rec;
  });
}

// ---- screenshots ---------------------------------------------------------------------------
async function tabIsCapturable() {
  const tab = await chrome.tabs.get(S.tabId).catch(() => null);
  if (!tab || !tab.active || tab.windowId !== S.windowId) return false;
  const win = await chrome.windows.get(S.windowId).catch(() => null);
  return !!win && win.state !== 'minimized';
}

function sendToTab(msg, frameId) {
  const opts = frameId == null ? undefined : { frameId };
  return chrome.tabs.sendMessage(S.tabId, { target: 'content', ...msg }, opts).catch(() => null);
}

function hashDataUrl(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 61) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `${s.length}:${h >>> 0}`;
}

function queueShot(opts) {
  const p = shotChain.then(() => doShot(opts)).catch((e) => { console.warn('shot failed', e); return null; });
  shotChain = p.then(() => {});
  return p;
}

async function skipShot(seq, slot, reason) {
  if (seq != null) await DB.updateEvent(S.sessionId, seq, (e) => { (e.shots ||= {})[`${slot}Skipped`] = reason; });
  return null;
}

// slot: 'before' | 'after'. Returns the stored shot id (or null if skipped).
async function doShot({ seq = null, slot = 'after', force = false }) {
  await ready;
  if (!isRecording()) return null;
  const wait = MIN_CAPTURE_GAP_MS - (Date.now() - lastCaptureAt);
  if (wait > 0) await sleep(wait);

  // Safety: only ever capture when the bound tab is the active tab of the bound window.
  if (!(await tabIsCapturable())) return skipShot(seq, slot, 'recorded tab not visible');

  const settings = await getSettings();
  if (settings.redactScreenshots) { await sendToTab({ type: 'mask', on: true }); await sleep(80); }
  let dataUrl = null;
  try {
    for (let attempt = 0; attempt < 3 && !dataUrl; attempt++) {
      try {
        lastCaptureAt = Date.now();
        dataUrl = await chrome.tabs.captureVisibleTab(S.windowId, { format: 'png' });
      } catch (e) {
        if (!/quota|MAX_CAPTURE/i.test(String(e?.message))) throw e;
        await sleep(1100);
      }
    }
  } catch (e) {
    return skipShot(seq, slot, `capture failed: ${e?.message || e}`);
  } finally {
    if (settings.redactScreenshots) sendToTab({ type: 'mask', on: false });
  }
  if (!dataUrl) return skipShot(seq, slot, 'rate limited');

  // Re-check: if the user switched tabs during the capture, discard the image.
  if (!(await tabIsCapturable())) return skipShot(seq, slot, 'tab changed during capture');

  const hash = hashDataUrl(dataUrl);
  if (!force && hash === S.lastHash) return skipShot(seq, slot, 'duplicate of previous screenshot');
  S.lastHash = hash;

  const id = `${S.sessionId}:${++S.shotSeq}`;
  const blob = await (await fetch(dataUrl)).blob();
  // Pixel size of the image + top-frame viewport (CSS px) let the exporter convert element rects to image pixels.
  let width = null, height = null, viewport = null;
  try {
    const bmp = await createImageBitmap(blob);
    width = bmp.width; height = bmp.height; bmp.close();
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: S.tabId, frameIds: [0] },
      func: () => ({ w: window.innerWidth, h: window.innerHeight }),
    });
    viewport = res?.result || null;
  } catch { /* geometry stays optional */ }
  await DB.putShot({ id, sessionId: S.sessionId, t: Date.now(), hash, blob, width, height, viewport });
  if (seq != null) await DB.updateEvent(S.sessionId, seq, (e) => { (e.shots ||= {})[slot] = id; });
  await persist();
  return id;
}

async function waitStable(maxMs = 7000) {
  await Promise.race([sendToTab({ type: 'waitStable' }, 0), sleep(maxMs)]);
}

// ---- tab / content script management -------------------------------------------------------
async function inject(tabId, frameIds) {
  try {
    await chrome.scripting.executeScript({
      target: frameIds ? { tabId, frameIds } : { tabId, allFrames: true },
      files: ['content.js'],
    });
  } catch { /* frame gone or not injectable (e.g. chrome:// pages) */ }
}

async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Record microphone narration while the user performs the SAP process',
  });
}
const closeOffscreen = () => chrome.offscreen.closeDocument().catch(() => {});

// ---- start / stop --------------------------------------------------------------------------
async function startRecording({ name, tabId, options }) {
  await ready;
  if (isRecording()) throw new Error('A recording is already running.');
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:/i.test(tab.url || '')) throw new Error('Only http(s) pages can be recorded.');
  const settings = await getSettings();
  const sessionId = `rec-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = Date.now();

  let audio = null;
  if (options.mic) {
    await ensureOffscreen();
    const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', sessionId });
    if (!r?.ok) { await closeOffscreen(); throw new Error(`Microphone: ${r?.error || 'no response'}`); }
    audio = { startedAt: r.startedAt, mimeType: r.mimeType };
  }

  S = {
    status: 'recording', sessionId, name, tabId, windowId: tab.windowId, startedAt,
    audioStartedAt: audio?.startedAt ?? null, options, eventSeq: 0, shotSeq: 0, count: 0,
    lastHash: null, lastUrl: tab.url, hidden: false, tabTitle: tab.title || '',
  };
  await DB.putSession({
    id: sessionId, name, startedAt, status: 'recording', tabId, windowId: tab.windowId,
    startUrl: tab.url, startTitle: tab.title || '', options, audio,
    masking: { selectors: settings.maskSelectors, patterns: settings.maskPatterns, captureValues: settings.captureValues, redactScreenshots: settings.redactScreenshots },
    userAgent: navigator.userAgent,
  });
  await persist();
  await inject(tabId);

  const first = await recordEvent({ type: 'initial_screen', url: tab.url, title: tab.title || '' });
  (async () => {
    await sleep(300);
    await waitStable(4000);
    await queueShot({ seq: first.seq, slot: 'after', force: true });
  })();
  return { ok: true, sessionId };
}

function stopRecording(reason = 'user') {
  stopping ||= (async () => {
    await ready;
    if (!isRecording()) return { ok: true, sessionId: S.lastSessionId };
    const sid = S.sessionId;
    await Promise.race([shotChain, sleep(10000)]);
    await sendToTab({ type: 'deactivate' });
    await recordEvent({ type: 'session_stop', reason });

    let audioEnd = null;
    if (S.audioStartedAt) {
      const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => null);
      audioEnd = r?.endedAt ?? null;
      await closeOffscreen();
    }
    const session = await DB.getSession(sid);
    session.endedAt = Date.now();
    session.status = reason === 'interrupted' ? 'interrupted' : 'completed';
    session.stopReason = reason;
    if (session.audio) session.audio.endedAt = audioEnd;
    await DB.putSession(session);

    // Drop screenshots that were captured but never attached to an event (e.g. aborted clicks).
    const used = new Set();
    for (const e of await DB.listEvents(sid)) { used.add(e.shots?.before); used.add(e.shots?.after); }
    for (const id of await DB.listShotIds(sid)) if (!used.has(id)) await DB.deleteShot(id);

    S = { status: 'idle', lastSessionId: sid };
    beforeShots.clear();
    await persist();
    return { ok: true, sessionId: sid };
  })().finally(() => { stopping = null; });
  return stopping;
}

async function manualShot() {
  await ready;
  if (!isRecording()) return { ok: false, error: 'Not recording' };
  if (!(await tabIsCapturable())) { flashBadge('!'); return { ok: false, error: 'The recorded tab is not the visible tab.' }; }
  const tab = await chrome.tabs.get(S.tabId).catch(() => null);
  const ev = await recordEvent({ type: 'manual_screenshot', url: tab?.url, title: tab?.title });
  if (!ev) return { ok: false };
  const id = await queueShot({ seq: ev.seq, slot: 'after', force: true });
  return { ok: !!id };
}

// ---- messages ------------------------------------------------------------------------------
async function handle(msg, sender) {
  await ready;
  switch (msg.type) {
    case 'getState':
      if (isRecording() && !(await chrome.tabs.get(S.tabId).catch(() => null))) await stopRecording('tab-closed');
      return { rec: S };
    case 'start': return startRecording(msg);
    case 'stop': return stopRecording('user');
    case 'manualShot': return manualShot();

    // ---- from the content script (only trusted when sent by the bound tab) ----
    case 'hello': {
      if (!fromBoundTab(sender)) return { active: false };
      const s = await getSettings();
      const { captureValues, redactScreenshots, maskSelectors, maskPatterns, quietMs, maxWaitMs } = s;
      return { active: true, cfg: { captureValues, redactScreenshots, maskSelectors, maskPatterns, quietMs, maxWaitMs, shotMode: S.options.shotMode } };
    }
    case 'before': {
      if (!fromBoundTab(sender) || S.options.shotMode !== 'beforeAfter') return { ok: false };
      beforeShots.set(msg.token, queueShot({ slot: 'before' }));
      return { ok: true };
    }
    case 'ev': {
      if (!fromBoundTab(sender)) return { ok: false };
      const rec = await recordEvent(msg.ev);
      if (rec && msg.beforeToken && beforeShots.has(msg.beforeToken)) {
        const token = msg.beforeToken;
        beforeShots.get(token).then(async (id) => {
          beforeShots.delete(token);
          if (id) await DB.updateEvent(rec.sessionId, rec.seq, (e) => { e.shots.before = id; });
          else await DB.updateEvent(rec.sessionId, rec.seq, (e) => { e.shots.beforeSkipped = 'duplicate or not visible'; });
        });
      }
      return { ok: !!rec, seq: rec?.seq };
    }
    case 'stable': {
      if (!fromBoundTab(sender) || S.options.shotMode === 'manual') return { ok: false };
      const seqs = [...msg.seqs].sort((a, b) => a - b);
      const last = seqs.pop();
      const sid = S.sessionId;
      for (const s of seqs) await DB.updateEvent(sid, s, (e) => { (e.shots ||= {}).refSeq = last; });
      queueShot({ seq: last, slot: 'after' });
      return { ok: true };
    }
    default: return { ok: false, error: 'unknown message' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target) return false; // addressed to the offscreen document / content script
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

chrome.commands.onCommand.addListener((cmd) => { if (cmd === 'manual-screenshot') manualShot(); });

// ---- navigation (works for full loads, pushState and UI5 hash routing) ---------------------
async function onNav(d, navKind) {
  await ready;
  if (!isRecording() || d.tabId !== S.tabId || d.frameId !== 0) return;
  if (d.url === S.lastUrl) return;
  const from = S.lastUrl;
  S.lastUrl = d.url;
  await persist();
  const ev = await recordEvent({ type: 'navigation', navKind, url: d.url, from });
  if (!ev) return;
  if (navKind === 'load') { await inject(S.tabId); await sleep(250); }
  await waitStable();
  const tab = await chrome.tabs.get(S.tabId).catch(() => null);
  if (tab?.title) DB.updateEvent(ev.sessionId, ev.seq, (e) => { e.title = tab.title; });
  if (S.options.shotMode !== 'manual') queueShot({ seq: ev.seq, slot: 'after' });
}

chrome.webNavigation.onDOMContentLoaded.addListener(async (d) => {
  await ready;
  if (isRecording() && d.tabId === S.tabId) inject(d.tabId, [d.frameId]);
});
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => onNav(d, 'spa'));
chrome.webNavigation.onReferenceFragmentUpdated.addListener((d) => onNav(d, 'hash'));
chrome.webNavigation.onCompleted.addListener((d) => onNav(d, 'load'));

// ---- tab lifecycle -------------------------------------------------------------------------
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  await ready;
  if (!isRecording() || windowId !== S.windowId) return;
  if (tabId !== S.tabId && !S.hidden) {
    S.hidden = true; await persist();
    recordEvent({ type: 'tab_hidden' });
  } else if (tabId === S.tabId && S.hidden) {
    S.hidden = false; await persist();
    recordEvent({ type: 'tab_visible' });
  }
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  if (isRecording() && tabId === S.tabId) stopRecording('tab-closed');
});
chrome.tabs.onAttached.addListener(async (tabId, info) => {
  await ready;
  if (isRecording() && tabId === S.tabId) { S.windowId = info.newWindowId; await persist(); }
});

// Browser restarted while recording -> finalise what we have (audio/events are already on disk).
chrome.runtime.onStartup.addListener(async () => {
  await ready;
  if (isRecording()) stopRecording('interrupted');
});
chrome.runtime.onInstalled.addListener(async () => {
  await ready;
  if (isRecording()) stopRecording('interrupted');
  else updateBadge();
});
