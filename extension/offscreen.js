// Offscreen document: owns the microphone + MediaRecorder so narration keeps going while the user
// switches tabs, closes the popup, or the service worker is suspended. Chunks go straight to IndexedDB.
import { putAudio } from './lib/db.js';

let recorder = null;
let stream = null;
let seq = 0;
let writes = Promise.resolve();
let sessionId = null;

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m?.target !== 'offscreen') return false;
  const job = m.type === 'start' ? start(m) : m.type === 'stop' ? stop() : Promise.resolve({ ok: false, error: 'unknown' });
  job.then(reply, (e) => reply({ ok: false, error: e?.name ? `${e.name}: ${e.message}` : String(e) }));
  return true;
});

async function start(m) {
  if (recorder) throw new Error('Already recording');
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  sessionId = m.sessionId;
  seq = 0;
  recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 });
  recorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    const s = seq++;
    writes = writes
      .then(() => putAudio({ sessionId, seq: s, t: Date.now(), blob: e.data }))
      .catch((err) => console.error('audio write failed', err));
  };
  const startedAt = await new Promise((resolve) => {
    recorder.onstart = () => resolve(Date.now());
    recorder.start(1000); // 1 s chunks -> at most 1 s of audio lost on a crash
  });
  return { ok: true, startedAt, mimeType };
}

async function stop() {
  if (!recorder) return { ok: true, chunks: 0 };
  const r = recorder;
  await new Promise((resolve) => {
    r.onstop = resolve;
    if (r.state === 'inactive') resolve();
    else r.stop();
  });
  await writes;
  stream?.getTracks().forEach((t) => t.stop());
  const out = { ok: true, endedAt: Date.now(), chunks: seq };
  recorder = null;
  stream = null;
  return out;
}
