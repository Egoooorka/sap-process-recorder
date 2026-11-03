// Speech-transcript panel of the review page.
import * as DB from './lib/db.js';
import { getSettings } from './lib/settings.js';
import { startRun, resumeRun, normalizeRun } from './lib/transcribe-run.js';
import { cancelJob } from './lib/asr-client.js';
import { fmtClock } from './lib/format.js';

const following = new Map(); // run id -> AbortController (runs this page is currently polling)

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  kids.flat().forEach((k) => e.append(k));
  return e;
}

const STATUS_TEXT = {
  queued: 'Waiting in the queue…', converting: 'Converting audio…', downloading_model: 'Downloading model (first run only)…',
  transcribing: 'Transcribing…', done: 'Done',
};

export function transcribeNow(sessionId, overrides, reopen) {
  const ctl = new AbortController();
  let started = null;
  startRun(sessionId, overrides, (run, job) => {
    if (!started) { started = run; following.set(run.id, ctl); reopen(); }
    paint(run, job);
  }, ctl.signal).then(async (run) => {
    following.delete(run.id);
    if (run.status === 'cancelled') await DB.deleteTranscript(run.id);
    reopen();
  });
}

function paint(run, job) {
  const bar = document.getElementById('asr-progress');
  const msg = document.getElementById('asr-message');
  if (!bar || !msg) return;
  bar.value = job ? job.progress : 0;
  msg.textContent = job ? `${STATUS_TEXT[job.status] || job.status}${job.status === 'transcribing' ? ` ${Math.round(job.progress * 100)}%` : ''}${job.message && job.status === 'downloading_model' ? ' – ' + job.message : ''}` : 'Starting…';
}

export async function buildTranscriptPanel({ session, runs, run, aligned, audioEl, reopen, ui }) {
  const settings = await getSettings();
  const hasAudio = !!session.audio;
  const running = runs.find((r) => r.status === 'running');

  // Re-attach to a job that was started before this page was (re)opened.
  if (running && running.jobId && !following.has(running.id)) {
    const ctl = new AbortController();
    following.set(running.id, ctl);
    resumeRun(running, paint, ctl.signal).then(() => { following.delete(running.id); reopen(); });
  }

  const lang = el('select', {}, ...[['ru', 'Russian'], ['en', 'English'], ['auto', 'Auto-detect']].map(([v, t]) => el('option', { value: v, textContent: t })));
  lang.value = ui.language || settings.asrLanguage;
  lang.onchange = () => { ui.language = lang.value; };
  const model = el('select', {}, ...[['large-v3-turbo', 'Large V3 Turbo'], ['large-v3', 'Large V3']].map(([v, t]) => el('option', { value: v, textContent: t })));
  model.value = ui.model || settings.asrModel;
  model.onchange = () => { ui.model = model.value; };

  const doneRuns = runs.filter((r) => r.status === 'done');
  const runSel = el('select', {}, ...runs.sort((a, b) => b.createdAt - a.createdAt).map((r) =>
    el('option', { value: r.id, textContent: `${new Date(r.createdAt).toLocaleString()} · ${r.params.model} · ${r.params.language} · ${r.status}` })));
  if (run) runSel.value = run.id;
  runSel.onchange = async () => { session.activeTranscript = runSel.value; await DB.putSession(session); reopen(); };

  const goBtn = el('button', {
    className: 'primary', textContent: doneRuns.length ? 'Retranscribe' : 'Transcribe', disabled: !hasAudio || !!running,
    onclick: () => transcribeNow(session.id, { language: lang.value, model: model.value }, reopen),
  });
  goBtn.style.cssText = 'width:auto;margin:0';
  const cancelBtn = running ? el('button', { textContent: 'Cancel', onclick: async () => {
    following.get(running.id)?.abort();
    if (running.jobId) await cancelJob(settings, running.jobId);
  } }) : '';
  const normBtn = run ? el('button', { textContent: run.normalized ? 'Re-run terminology normalisation' : 'Normalise terminology (optional)',
    onclick: async () => { await normalizeRun(run); ui.showNorm = true; reopen(); } }) : '';
  const showNorm = run?.normalized ? el('label', { className: 'row', style: 'margin:0;font-weight:400' },
    el('input', { type: 'checkbox', checked: !!ui.showNorm, onchange: (e) => { ui.showNorm = e.target.checked; reopen(); } }), 'Show normalised text') : '';
  const delRun = run ? el('button', { className: 'danger', textContent: 'Delete run', onclick: async () => {
    if (!confirm('Delete this transcription run (the recording and audio stay)?')) return;
    await DB.deleteTranscript(run.id);
    reopen();
  } }) : '';

  const bar = el('progress', { id: 'asr-progress', max: 1, value: running ? 0 : 1, style: 'width:240px' + (running ? '' : ';display:none') });
  const msg = el('span', { id: 'asr-message', className: 'sub', textContent: running ? 'Working…' : '' });

  const failed = runs.filter((r) => r.status === 'error').sort((a, b) => b.createdAt - a.createdAt)[0];
  const err = failed && (!run || failed.createdAt > run.createdAt)
    ? el('div', { className: 'err', style: 'margin:8px 0' }, `Last attempt failed: ${failed.error}`, failed.hint ? el('div', { className: 'sub', textContent: failed.hint }) : '',
        el('button', { textContent: 'Dismiss', style: 'margin-left:8px', onclick: async () => { await DB.deleteTranscript(failed.id); reopen(); } }))
    : '';

  const panel = el('section', { style: 'margin-top:18px;border-top:1px solid #e3e6ec;padding-top:12px' },
    el('h2', { textContent: 'Speech transcript (local Whisper)', style: 'font-size:15px;margin:0 0 8px' }),
    !hasAudio ? el('div', { className: 'sub', textContent: 'This recording has no narration audio.' }) : '',
    el('div', { className: 'actions' }, goBtn, 'Language', lang, 'Model', model, cancelBtn, normBtn, showNorm, delRun),
    runs.length ? el('div', { className: 'actions' }, 'Run:', runSel) : '',
    el('div', { className: 'actions' }, bar, msg),
    err);

  if (run) {
    const raw = run.raw;
    panel.append(el('div', { className: 'sub', textContent:
      `${raw.backend} · ${raw.model} · language ${raw.language_detected || raw.language_requested} · ${raw.segments.length} segments · ${raw.timing.transcribe_s}s` +
      `${run.params.hintsUsed ? ' · SAP term hints used' : ''} · task=${raw.task} (no translation)` }));
    const norm = new Map((run.normalized?.segments || []).map((n) => [n.id, n]));
    const list = el('div', { style: 'margin-top:8px' });
    for (const g of raw.segments) {
      const n = norm.get(g.id);
      const al = aligned?.segments.get(g.id);
      const shown = ui.showNorm && n ? n.text : g.text;
      const row = el('div', { style: 'display:flex;gap:10px;padding:6px 0;border-bottom:1px solid #eef0f4' },
        el('a', { href: '#', textContent: fmtClock(g.start * 1000), style: 'min-width:56px;color:#0a6ed1', onclick: (e) => {
          e.preventDefault();
          if (audioEl) { audioEl.currentTime = g.start; audioEl.play(); }
        } }),
        el('div', { style: 'flex:1' }, shown,
          (g.no_speech_prob ?? 0) > 0.6 ? el('span', { className: 'tag', textContent: ' likely silence', style: 'margin-left:6px' }) : '',
          ui.showNorm && n?.changes.length ? el('div', { className: 'sub' }, n.changes.map((c) => `${c.from} → ${c.to} (${c.kind}, ${c.source})`).join(' · ')) : '',
          ui.showNorm && n?.suggestions.length ? el('div', { className: 'sub', style: 'font-style:italic' }, 'not applied: ' + n.suggestions.map((c) => `${c.from} ≟ ${c.term} (${c.score}, ${c.reason})`).join(' · ')) : '',
          al?.events.length ? el('div', { className: 'sub' }, al.events.map((e) => `#${e.index} ${e.action || e.type} [${e.relation.replace('_', ' ')}]`).join(' · ')) : '',
          !al?.events.length && al?.nearest ? el('div', { className: 'sub', textContent: `no nearby UI event (nearest #${al.nearest.index}, ${(al.nearest.deltaMs / 1000).toFixed(1)} s)` }) : ''));
      list.append(row);
    }
    panel.append(list);
  }
  return panel;
}
