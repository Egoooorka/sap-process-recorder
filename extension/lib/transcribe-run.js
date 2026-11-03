// Orchestrates one transcription run: audio from IndexedDB -> local helper -> stored run record.
// Each run is a separate record; the raw ASR output is never modified afterwards.
import * as DB from './db.js';
import { getSettings } from './settings.js';
import { startJob, waitForJob, HelperError } from './asr-client.js';
import { buildReferences, buildPrompt, normalizeTranscript } from './normalize.js';

export async function audioBlob(sessionId) {
  const chunks = await DB.listAudio(sessionId);
  if (!chunks.length) throw new HelperError('This recording has no narration audio.', { code: 'noaudio' });
  return new Blob(chunks.map((c) => c.blob), { type: 'audio/webm' });
}

async function referencesFor(sessionId, s) {
  const events = await DB.listEvents(sessionId);
  return buildReferences({ glossaryText: s.glossary, designText: s.solutionDesign, events });
}

/** Start a new run. overrides: {language, model, backend}. onUpdate(run, job) for progress. */
export async function startRun(sessionId, overrides = {}, onUpdate = () => {}, signal) {
  const s = await getSettings();
  const params = {
    language: overrides.language || s.asrLanguage,
    model: overrides.model || s.asrModel,
    backend: overrides.backend || s.asrBackend,
    conditionPrev: s.asrConditionPrev,
  };
  const refs = await referencesFor(sessionId, s);
  const prompt = s.asrUseHints ? buildPrompt(refs) : '';
  const run = {
    id: `${sessionId}:t${Date.now()}`, sessionId, createdAt: Date.now(), status: 'running',
    params: { ...params, hintsUsed: !!prompt }, jobId: null, error: null, raw: null, normalized: null,
  };
  await DB.putTranscript(run);
  onUpdate(run, null);
  try {
    const blob = await audioBlob(sessionId);
    run.jobId = await startJob(s, blob, { ...params, prompt });
    await DB.putTranscript(run);
    return await follow(run, s, onUpdate, signal);
  } catch (e) {
    return fail(run, e);
  }
}

/** Re-attach to a run that was still processing when the page was closed. */
export async function resumeRun(run, onUpdate = () => {}, signal) {
  const s = await getSettings();
  try {
    return await follow(run, s, onUpdate, signal);
  } catch (e) {
    return fail(run, e);
  }
}

async function follow(run, s, onUpdate, signal) {
  const job = await waitForJob(s, run.jobId, (j) => onUpdate(run, j), { signal });
  run.raw = job.result;
  run.status = 'done';
  run.error = null;
  await DB.putTranscript(run);
  onUpdate(run, job);
  return run;
}

async function fail(run, e) {
  run.status = e.code === 'cancelled' ? 'cancelled' : 'error';
  run.error = e.message;
  run.hint = e.hint || '';
  await DB.putTranscript(run);
  return run;
}

/** Stage 2 (optional): terminology normalisation. Raw text is untouched. */
export async function normalizeRun(run) {
  const s = await getSettings();
  const refs = await referencesFor(run.sessionId, s);
  run.normalized = normalizeTranscript(run.raw.segments, refs, { threshold: s.normThreshold });
  await DB.putTranscript(run);
  return run;
}

/** Most relevant finished run for a session: the chosen one, else the newest. */
export function pickRun(runs, activeId) {
  const done = runs.filter((r) => r.status === 'done' && r.raw);
  return done.find((r) => r.id === activeId) || done.sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}
