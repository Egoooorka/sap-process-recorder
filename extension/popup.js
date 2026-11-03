import { getPrefs, savePrefs, getSettings } from './lib/settings.js';

const $ = (id) => document.getElementById(id);
let rec = { status: 'idle' };

const call = (m) => chrome.runtime.sendMessage(m);
const say = (t, err = false) => { $('msg').textContent = t; $('msg').classList.toggle('err', err); };
const clock = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

function render() {
  const on = rec.status === 'recording';
  $('status').classList.toggle('hidden', !on);
  $('boundTab').classList.toggle('hidden', !on);
  for (const id of ['name', 'mic', 'shotMode']) $(id).disabled = on;
  $('toggle').textContent = on ? 'Stop recording' : 'Start recording';
  $('toggle').classList.toggle('stop', on);
  $('shot').disabled = !on;
  if (on) {
    $('timer').textContent = clock(Date.now() - rec.startedAt);
    $('counter').textContent = rec.count || 0;
    $('statusText').textContent = rec.hidden ? 'Recording (tab in background)' : 'Recording';
    $('boundTab').textContent = `Bound to tab: ${rec.tabTitle || rec.lastUrl} · mic ${rec.audioStartedAt ? 'on' : 'off'}`;
    $('name').value = rec.name;
    $('mic').checked = !!rec.options?.mic;
    $('shotMode').value = rec.options?.shotMode || 'after';
  }
}

async function micGranted() {
  try { return (await navigator.permissions.query({ name: 'microphone' })).state === 'granted'; } catch { return false; }
}

async function start() {
  const prefs = {
    name: $('name').value.trim() || `Process ${new Date().toLocaleString()}`,
    mic: $('mic').checked,
    shotMode: $('shotMode').value,
  };
  await savePrefs(prefs);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/i.test(tab.url || '')) return say('Open the SAP Fiori page in this tab first (http/https only).', true);
  if (prefs.mic && !(await micGranted())) {
    chrome.tabs.create({ url: chrome.runtime.getURL('mic.html') });
    return say('Grant microphone access in the new tab, go back to your SAP tab, then press Start again.');
  }
  say('Starting…');
  const r = await call({ type: 'start', name: prefs.name, tabId: tab.id, options: { mic: prefs.mic, shotMode: prefs.shotMode } });
  if (!r?.ok) return say(r?.error || 'Could not start.', true);
  say('Recording. You can close this popup – the tab stays bound.');
  rec = (await call({ type: 'getState' })).rec;
  render();
}

async function stop() {
  $('toggle').disabled = true;
  const hadMic = !!rec.audioStartedAt;
  say('Finishing…');
  const r = await call({ type: 'stop' });
  $('toggle').disabled = false;
  rec = (await call({ type: 'getState' })).rec;
  render();
  if (r?.sessionId) {
    say('Saved. Opening review…');
    chrome.tabs.create({ url: chrome.runtime.getURL(`review.html#${r.sessionId}${hadMic && (await getSettings()).asrAutoStart ? '?transcribe=1' : ''}`) });
  }
}

async function init() {
  const prefs = await getPrefs();
  $('name').value = prefs.name;
  $('mic').checked = prefs.mic;
  $('shotMode').value = prefs.shotMode;
  rec = (await call({ type: 'getState' }))?.rec || rec;
  render();
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === 'local' && c.rec) { rec = c.rec.newValue || { status: 'idle' }; render(); }
  });
  setInterval(render, 500);

  $('toggle').onclick = () => (rec.status === 'recording' ? stop() : start());
  $('shot').onclick = async () => {
    const r = await call({ type: 'manualShot' });
    say(r?.ok ? 'Screenshot captured.' : r?.error || 'Screenshot skipped.', !r?.ok);
  };
  $('review').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
  $('settings').onclick = () => chrome.runtime.openOptionsPage();
}
init();
