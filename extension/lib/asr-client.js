// Client for the local ASR helper (asr-helper/). Only talks to the user-configured loopback URL.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HelperError extends Error {
  constructor(message, { code = 'helper', hint = '' } = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

const START_HINT = 'Start the helper: cd asr-helper && ./run.sh (see README).';

function base(s) {
  const u = (s.asrHelperUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(u)) {
    throw new HelperError('The helper URL must be a loopback address (http://127.0.0.1:PORT).', { code: 'config' });
  }
  return u;
}

async function call(s, path, init = {}) {
  let res;
  try {
    res = await fetch(base(s) + path, { ...init, headers: { 'X-ASR-Token': s.asrToken || '', ...(init.headers || {}) } });
  } catch (e) {
    if (e instanceof HelperError) throw e;
    throw new HelperError(`Local ASR helper is not reachable at ${s.asrHelperUrl}.`, { code: 'unreachable', hint: START_HINT });
  }
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  if (res.status === 401) throw new HelperError('The helper rejected the token.', { code: 'auth', hint: 'Copy the token printed by the helper (or ~/.sap-process-recorder/token) into Speech Recognition settings.' });
  if (!res.ok) throw new HelperError(body?.error || `Helper error ${res.status}`, { code: 'http' });
  return body;
}

export const getHealth = (s) => call(s, '/health');

const b64utf8 = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

// params: {language, model, backend, prompt, conditionPrev}. Returns the job id.
export async function startJob(s, audioBlob, params) {
  const qs = new URLSearchParams({
    language: params.language || 'ru',
    model: params.model || 'large-v3-turbo',
    backend: params.backend || 'auto',
    condition_on_previous_text: params.conditionPrev ? '1' : '0',
  });
  const headers = { 'Content-Type': 'application/octet-stream' };
  if (params.prompt) headers['X-ASR-Prompt-B64'] = b64utf8(params.prompt);
  const r = await call(s, `/jobs?${qs}`, { method: 'POST', body: audioBlob, headers });
  return r.id;
}

export const getJob = (s, id) => call(s, `/jobs/${id}`);
export const cancelJob = (s, id) => call(s, `/jobs/${id}`, { method: 'DELETE' }).catch(() => null);

// Polls until the job finishes. onUpdate(job) is called on every poll. Throws HelperError on failure.
export async function waitForJob(s, id, onUpdate = () => {}, { signal, intervalMs = 1000 } = {}) {
  let misses = 0;
  for (;;) {
    if (signal?.aborted) { await cancelJob(s, id); throw new HelperError('Cancelled', { code: 'cancelled' }); }
    let job;
    try {
      job = await getJob(s, id);
      misses = 0;
    } catch (e) {
      if (e.code === 'unreachable' && ++misses < 5) { await sleep(intervalMs * 2); continue; } // helper restarting?
      throw e;
    }
    onUpdate(job);
    if (job.status === 'done') return job;
    if (job.status === 'error') throw new HelperError(job.error || 'Transcription failed', { code: 'job' });
    if (job.status === 'cancelled') throw new HelperError('Cancelled', { code: 'cancelled' });
    await sleep(intervalMs);
  }
}
