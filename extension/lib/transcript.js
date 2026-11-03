// Pure helpers: turn ASR segments into transcript.txt / .srt / .json. Timestamps are seconds from audio start.
import { fmtClock } from './format.js';

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

// textOf(segment) lets callers choose raw or normalised text.
export function toSrt(segments, textOf = (s) => s.text) {
  return segments
    .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${textOf(s)}\n`)
    .join('\n');
}

export function toTxt(segments, textOf = (s) => s.text) {
  return segments.map((s) => `[${fmtClock(s.start * 1000)}] ${textOf(s)}`).join('\n') + '\n';
}

// Build transcript.json. `aligned` comes from align.js, `normalized` (optional) from normalize.js.
export function buildTranscriptJson({ session, run, aligned, normalized, audioFile = 'narration.webm' }) {
  const raw = run.raw;
  const audioStart = session.audio?.startedAt ?? null;
  const normBySeg = new Map((normalized?.segments || []).map((n) => [n.id, n]));
  return {
    schema: 'sap-process-recorder/transcript@1',
    raw: true, // `text` fields are the unmodified ASR output; normalised text lives under `normalized`
    session: { id: session.id, name: session.name, startedAt: new Date(session.startedAt).toISOString() },
    audio: {
      file: audioFile,
      startedAt: audioStart ? new Date(audioStart).toISOString() : null,
      offsetFromSessionStartMs: audioStart ? audioStart - session.startedAt : null,
      durationSec: raw.duration,
    },
    asr: {
      backend: raw.backend, model: raw.model, modelRef: raw.model_ref, task: raw.task,
      languageRequested: raw.language_requested, languageDetected: raw.language_detected,
      promptUsed: raw.prompt_used, params: raw.params, timing: raw.timing, helperVersion: raw.helper_version,
      createdAt: new Date(run.createdAt).toISOString(),
    },
    text: raw.segments.map((s) => s.text).join(' '),
    normalization: normalized
      ? { createdAt: new Date(normalized.createdAt).toISOString(), params: normalized.params, sources: normalized.sources }
      : null,
    segments: raw.segments.map((s) => {
      const a = aligned?.segments.get(s.id);
      const n = normBySeg.get(s.id);
      return {
        id: s.id,
        start: s.start,
        end: s.end,
        text: s.text,
        avgLogprob: s.avg_logprob ?? null,
        noSpeechProb: s.no_speech_prob ?? null,
        compressionRatio: s.compression_ratio ?? null,
        sessionStartMs: a?.sessionStartMs ?? null,
        absoluteStart: a ? new Date(a.absStartMs).toISOString() : null,
        events: a?.events || [],
        nearestEvent: a?.nearest || null,
        normalized: n ? { text: n.text, changes: n.changes, suggestions: n.suggestions } : undefined,
      };
    }),
  };
}
