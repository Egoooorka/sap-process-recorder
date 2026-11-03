import * as DB from './lib/db.js';
import { buildExport } from './lib/export.js';
import { describeEvent, fmtClock } from './lib/format.js';
import { getSettings } from './lib/settings.js';
import { pickRun } from './lib/transcribe-run.js';
import { alignSegments } from './lib/align.js';
import { buildTranscriptPanel, transcribeNow } from './review-transcript.js';

const $ = (id) => document.getElementById(id);
const urls = [];
let currentId = null;
const ui = {}; // transient view state of the transcript panel

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  kids.flat().forEach((k) => e.append(k));
  return e;
}

async function recordingNow() {
  const { rec } = await chrome.storage.local.get('rec');
  return rec?.status === 'recording' ? rec.sessionId : null;
}

async function renderList() {
  const sessions = (await DB.listSessions()).sort((a, b) => b.startedAt - a.startedAt);
  const live = await recordingNow();
  const box = $('list');
  box.replaceChildren();
  if (!sessions.length) box.append(el('p', { className: 'muted', textContent: 'No recordings yet.' }));
  for (const s of sessions) {
    const n = await DB.countEvents(s.id);
    box.append(el('div', { className: 'sess' + (s.id === currentId ? ' sel' : ''), onclick: () => open(s.id) },
      el('b', { textContent: s.name }), el('br'),
      el('span', { className: 'sub', textContent: `${new Date(s.startedAt).toLocaleString()} · ${n} events${s.id === live ? ' · recording…' : ''}` })));
  }
}

async function open(id) {
  currentId = id;
  history.replaceState(null, '', `#${id}`);
  urls.splice(0).forEach(URL.revokeObjectURL);
  renderList();
  const session = await DB.getSession(id);
  const main = $('main');
  if (!session) { main.replaceChildren(el('p', { textContent: 'Session not found.' })); return; }
  const events = (await DB.listEvents(id)).sort((a, b) => a.t - b.t || a.seq - b.seq);
  const live = (await recordingNow()) === id;

  const exportBtn = el('button', { className: 'primary', textContent: 'Export ZIP', disabled: live,
    onclick: async () => {
      exportBtn.disabled = true; exportBtn.textContent = 'Building…';
      try {
        const { blob, filename } = await buildExport(id, { highlight: $('hl')?.checked !== false });
        const a = el('a', { href: URL.createObjectURL(blob), download: filename });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      } catch (e) { alert(`Export failed: ${e.message}`); }
      exportBtn.disabled = live; exportBtn.textContent = 'Export ZIP';
    } });
  exportBtn.style.cssText = 'width:auto;margin:0';
  const delBtn = el('button', { className: 'danger', textContent: 'Delete recording', disabled: live,
    onclick: async () => {
      if (!confirm(`Delete "${session.name}" and all its screenshots and audio?`)) return;
      await DB.deleteSession(id);
      currentId = null; history.replaceState(null, '', '#');
      main.replaceChildren(el('p', { className: 'muted', textContent: 'Deleted.' }));
      renderList();
    } });

  const head = el('div', {},
    el('h1', { textContent: session.name }),
    el('div', { className: 'sub', textContent:
      `${new Date(session.startedAt).toLocaleString()} · ${session.endedAt ? fmtClock(session.endedAt - session.startedAt) : 'in progress'} · ${session.status}${session.stopReason && session.stopReason !== 'user' ? ` (${session.stopReason})` : ''} · ${session.startUrl}` }),
    el('div', { className: 'actions' }, exportBtn, delBtn, el('label', { className: 'row', style: 'margin:0;font-weight:400' }, el('input', { type: 'checkbox', id: 'hl', checked: true }), 'Draw highlight frames'),
      el('span', { className: 'sub', textContent: 'Review below: delete any event or screenshot you do not want exported.' })));

  const chunks = await DB.listAudio(id);
  let audioEl = null;
  if (chunks.length) {
    const a = audioEl = el('audio', { controls: true, src: URL.createObjectURL(new Blob(chunks.map((c) => c.blob), { type: 'audio/webm' })) });
    urls.push(a.src);
    head.append(a);
  }

  const runs = await DB.listTranscripts(id);
  const run = pickRun(runs, session.activeTranscript);
  const cfg = await getSettings();
  const aligned = run && session.audio?.startedAt
    ? alignSegments(run.raw.segments, events, {
        audioStartedAt: session.audio.startedAt, sessionStartedAt: session.startedAt,
        offsetMs: cfg.asrSyncOffsetMs || 0, describe: describeEvent,
      })
    : null;
  const panel = await buildTranscriptPanel({ session, runs, run, aligned, audioEl, reopen: () => open(id), ui });
  const segText = new Map((run?.raw.segments || []).map((g) => [g.id, g.text]));

  const tbody = el('tbody');
  const table = el('table', {}, el('thead', {}, el('tr', {}, ['#', 'Time', 'Audio', 'Action', 'Screenshots', ''].map((h) => el('th', { textContent: h })))), tbody);
  let i = 0;
  for (const e of events) {
    i++;
    const thumbs = el('div', { className: 'thumbs' });
    for (const slot of ['before', 'after']) {
      const sid = e.shots?.[slot];
      if (!sid) continue;
      const img = el('img', { title: slot, alt: slot });
      thumbs.append(img);
      DB.getShot(sid).then((s) => {
        if (!s) return img.remove();
        const u = URL.createObjectURL(s.blob);
        urls.push(u);
        img.src = u;
        img.onclick = () => window.open(u);
      });
    }
    const note = e.shots?.afterSkipped || e.shots?.beforeSkipped;
    if (e.shots?.refSeq != null) thumbs.append(el('span', { className: 'sub', textContent: 'screen shared with a later action' }));
    if (note && !thumbs.childNodes.length) thumbs.append(el('span', { className: 'sub', textContent: `no screenshot: ${note}` }));

    const delShots = e.shots?.before || e.shots?.after ? el('button', { textContent: 'Drop images', onclick: async () => {
      for (const sid of [e.shots.before, e.shots.after]) if (sid) await DB.deleteShot(sid);
      await DB.updateEvent(id, e.seq, (x) => { x.shots = {}; });
      open(id);
    } }) : '';
    const delEv = el('button', { className: 'danger', textContent: 'Delete', onclick: async () => {
      for (const sid of [e.shots?.before, e.shots?.after]) if (sid) await DB.deleteShot(sid);
      await DB.deleteEvent(id, e.seq);
      open(id);
    } });

    tbody.append(el('tr', {},
      el('td', { textContent: i }),
      el('td', { textContent: fmtClock(e.offsetMs) }),
      el('td', { textContent: fmtClock(e.audioOffsetMs) }),
      el('td', {}, describeEvent(e), el('br'),
        el('span', { className: 'tag', textContent: e.type }),
        e.masked ? el('span', { className: 'tag', textContent: ' value masked' }) : '',
        el('div', { className: 'sub', textContent: e.selector || e.url || '' }),
        (aligned?.events.get(e.seq) || []).map((l) => el('div', { className: 'sub', style: 'color:#0a6ed1', textContent: `🎙 “${segText.get(l.segmentId)}” (${l.relation.replace('_', ' ')})` }))),
      el('td', {}, thumbs),
      el('td', {}, delShots, ' ', delEv)));
  }
  main.replaceChildren(head, panel, table);
}

(async () => {
  await renderList();
  const [id, query] = location.hash.slice(1).split('?');
  if (id) {
    await open(id);
    // ?transcribe=1 is set by the popup after Stop when "start automatically" is enabled
    if (query === 'transcribe=1' && !(await DB.listTranscripts(id)).length) transcribeNow(id, {}, () => open(id));
    history.replaceState(null, '', `#${id}`);
  }
  chrome.storage.onChanged.addListener((c) => { if (c.rec) renderList(); });
})();
