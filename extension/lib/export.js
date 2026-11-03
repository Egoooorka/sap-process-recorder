import * as DB from './db.js';
import { ZipWriter } from './zip.js';
import { describeEvent, fmtClock } from './format.js';
import { getSettings } from './settings.js';
import { alignSegments } from './align.js';
import { pickRun } from './transcribe-run.js';
import { buildTranscriptJson, toSrt, toTxt } from './transcript.js';

const slug = (s) => (s || 'process').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'process';
const pad = (n) => String(n).padStart(2, '0');

// Draws a red frame around the element, a dot at the click point and the step number.
async function annotate(blob, h, step) {
  if (!(h.w > 0 && h.h > 0) || h.x > h.imageWidth || h.y > h.imageHeight || h.x + h.w < 0 || h.y + h.h < 0) return null;
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const lw = Math.max(3, Math.round(c.width / 450));
  const color = '#e5173f';
  g.shadowColor = 'rgba(0,0,0,.35)';
  g.shadowBlur = lw * 2;
  g.lineWidth = lw;
  g.strokeStyle = color;
  g.strokeRect(h.x - lw, h.y - lw, h.w + 2 * lw, h.h + 2 * lw);
  if (h.click) {
    g.fillStyle = 'rgba(229,23,63,.85)';
    g.beginPath();
    g.arc(h.click.x, h.click.y, lw * 2.5, 0, Math.PI * 2);
    g.fill();
  }
  const r = lw * 4.5;
  const bx = Math.max(r, h.x - lw), by = Math.max(r, h.y - lw);
  g.shadowBlur = 0;
  g.fillStyle = color;
  g.beginPath();
  g.arc(bx, by, r, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff';
  g.font = `bold ${Math.round(r * 1.2)}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(step), bx, by + 1);
  return c.convertToBlob({ type: 'image/png' });
}

export async function buildExport(sessionId, { highlight = true } = {}) {
  const session = await DB.getSession(sessionId);
  if (!session) throw new Error('Session not found');
  const events = (await DB.listEvents(sessionId)).sort((a, b) => a.t - b.t || a.seq - b.seq);
  const shotIds = new Set(await DB.listShotIds(sessionId));
  const zip = new ZipWriter();

  // Assign step numbers to every event that owns at least one screenshot.
  const paths = new Map(); // seq -> {before, after, step}
  let step = 0;
  for (const e of events) {
    const sh = e.shots || {};
    const before = sh.before && shotIds.has(sh.before) ? sh.before : null;
    const after = sh.after && shotIds.has(sh.after) ? sh.after : null;
    if (!before && !after) continue;
    step++;
    const n = String(step).padStart(3, '0');
    paths.set(e.seq, {
      step,
      before: before && { id: before, path: `screenshots/step-${n}-before.png` },
      after: after && { id: after, path: `screenshots/step-${n}.png` },
    });
  }
  const scaleOf = new Map(); // shot id -> {sx, sy, width, height}

  // Element box / click point converted to pixels of a given screenshot (for drawing highlight frames).
  const highlightFor = (e, shotRef) => {
    const sc = shotRef && scaleOf.get(shotRef.id);
    if (!sc || !e.rect) return null;
    const r2 = (n) => Math.round(n);
    const out = {
      x: r2(e.rect.x * sc.sx), y: r2(e.rect.y * sc.sy), w: r2(e.rect.w * sc.sx), h: r2(e.rect.h * sc.sy),
      imageWidth: sc.width, imageHeight: sc.height, exact: e.rect.exact,
    };
    if (e.point) out.click = { x: r2(e.point.x * sc.sx), y: r2(e.point.y * sc.sy) };
    return out;
  };

  const bySeq = new Map(events.map((e) => [e.seq, e]));
  for (const [seq, p] of paths) {
    const e = bySeq.get(seq);
    for (const k of ['before', 'after']) {
      if (!p[k]) continue;
      const shot = await DB.getShot(p[k].id);
      if (!shot) continue;
      if (shot.width && shot.viewport?.w) {
        scaleOf.set(p[k].id, { sx: shot.width / shot.viewport.w, sy: shot.height / shot.viewport.h, width: shot.width, height: shot.height });
      }
      // Frame the element on the "before" image; on the "after" image only when there is no "before"
      // (the element may have moved or vanished after the action).
      const h = highlight && (k === 'before' || !p.before) ? highlightFor(e, p[k]) : null;
      const annotated = h && h.exact !== false ? await annotate(shot.blob, h, p.step) : null;
      if (annotated) {
        await zip.add(p[k].path, annotated);
        await zip.add(p[k].path.replace('screenshots/', 'screenshots/original/'), shot.blob);
        p[k].highlighted = true;
      } else {
        await zip.add(p[k].path, shot.blob);
      }
    }
  }

  const shotOf = (e) => {
    const own = paths.get(e.seq);
    const ref = e.shots?.refSeq != null ? paths.get(e.shots.refSeq) : null;
    return {
      step: own?.step ?? ref?.step ?? null,
      before: own?.before?.path ?? null,
      after: own?.after?.path ?? ref?.after?.path ?? null,
    };
  };

  // Speech <-> event synchronisation (only when a finished transcription exists)
  const run = pickRun(await DB.listTranscripts(sessionId), session.activeTranscript);
  const settings = await getSettings();
  const aligned = run && session.audio?.startedAt
    ? alignSegments(run.raw.segments, events, {
        audioStartedAt: session.audio.startedAt, sessionStartedAt: session.startedAt,
        offsetMs: settings.asrSyncOffsetMs || 0, describe: describeEvent,
      })
    : null;
  const segText = new Map((run?.raw.segments || []).map((g) => [g.id, g.text]));
  const normText = new Map((run?.normalized?.segments || []).map((g) => [g.id, g.text]));

  const outEvents = events.map((e, i) => {
    const { sessionId: _s, shots, ...rest } = e;
    const s = shotOf(e);
    return {
      index: i + 1,
      ...rest,
      time: new Date(e.t).toISOString(),
      action: describeEvent(e),
      step: s.step,
      screenshots: { before: s.before, after: s.after },
      // pixel boxes per screenshot; "after" is only valid if the layout did not shift after the action
      highlights: {
        before: highlightFor(e, paths.get(e.seq)?.before),
        after: highlightFor(e, paths.get(e.seq)?.after),
      },
      screenshotNote: shots?.afterSkipped || shots?.beforeSkipped || undefined,
      speech: aligned?.events.get(e.seq)?.map((l) => ({
        segmentId: l.segmentId, relation: l.relation, deltaMs: l.deltaMs,
        text: segText.get(l.segmentId), // raw ASR text
        ...(normText.has(l.segmentId) ? { normalizedText: normText.get(l.segmentId) } : {}),
      })),
    };
  });
  await zip.add('events.json', JSON.stringify(outEvents, null, 2));

  // Audio
  const chunks = await DB.listAudio(sessionId);
  let audioFile = null;
  if (chunks.length) {
    audioFile = 'narration.webm';
    await zip.add(audioFile, new Blob(chunks.map((c) => c.blob), { type: 'audio/webm' }));
  }

  if (run) {
    const segs = run.raw.segments;
    await zip.add('transcript.txt', toTxt(segs));
    await zip.add('transcript.srt', toSrt(segs));
    await zip.add('transcript.json', JSON.stringify(buildTranscriptJson({ session, run, aligned, normalized: run.normalized }), null, 2));
    if (run.normalized) {
      const nm = new Map(run.normalized.segments.map((n) => [n.id, n.text]));
      const nt = (g) => nm.get(g.id) ?? g.text;
      await zip.add('transcript.normalized.txt', toTxt(segs, nt));
      await zip.add('transcript.normalized.srt', toSrt(segs, nt));
    }
  }

  const startedAt = session.startedAt;
  const audioStartedAt = session.audio?.startedAt ?? null;
  const sessionJson = {
    id: session.id,
    name: session.name,
    status: session.status,
    startUrl: session.startUrl,
    startTitle: session.startTitle,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: session.endedAt ? new Date(session.endedAt).toISOString() : null,
    durationMs: session.endedAt ? session.endedAt - startedAt : null,
    tabId: session.tabId,
    windowId: session.windowId,
    options: session.options,
    masking: session.masking,
    audio: audioFile && {
      file: audioFile,
      mimeType: session.audio?.mimeType || 'audio/webm',
      startedAt: audioStartedAt ? new Date(audioStartedAt).toISOString() : null,
      offsetFromSessionStartMs: audioStartedAt ? audioStartedAt - startedAt : null,
      note: 'audioOffsetMs of each event = position inside narration.webm',
    },
    transcript: run && {
      files: ['transcript.txt', 'transcript.json', 'transcript.srt', ...(run.normalized ? ['transcript.normalized.txt', 'transcript.normalized.srt'] : [])],
      backend: run.raw.backend, model: run.raw.model, task: run.raw.task,
      language: run.raw.language_detected || run.raw.language_requested,
      normalized: !!run.normalized, syncOffsetMs: settings.asrSyncOffsetMs || 0,
    },
    counts: {
      events: events.length,
      screenshots: [...paths.values()].reduce((n, p) => n + (p.before ? 1 : 0) + (p.after ? 1 : 0), 0),
    },
    exportedAt: new Date().toISOString(),
    userAgent: session.userAgent,
    extensionVersion: chrome.runtime.getManifest().version,
  };
  await zip.add('session.json', JSON.stringify(sessionJson, null, 2));

  // timeline.md
  const md = [];
  md.push(`# ${session.name}`, '');
  md.push(`- Recorded: ${new Date(startedAt).toLocaleString()}`);
  if (session.endedAt) md.push(`- Duration: ${fmtClock(session.endedAt - startedAt)}`);
  md.push(`- Start URL: ${session.startUrl}`);
  if (audioFile) md.push(`- Narration: \`${audioFile}\` (starts ${fmtClock(audioStartedAt - startedAt)} after session start)`);
  md.push('', '## Timeline', '');
  let n = 0;
  for (const o of outEvents) {
    n++;
    md.push(`### ${n}. [${fmtClock(o.offsetMs)}] ${o.action}`, '');
    if (o.audioOffsetMs != null) md.push(`- Narration position: ${fmtClock(o.audioOffsetMs)}`);
    md.push(`- Type: \`${o.type}\`${o.selector ? ` · element: \`${o.selector}\`` : ''}`);
    if (o.url) md.push(`- URL: ${o.url}`);
    for (const sp of o.speech || []) {
      const label = { during: 'while speaking', before_speech: 'just before speaking', after_speech: 'just after speaking' }[sp.relation];
      md.push(`- 🎙 (${label}) “${sp.normalizedText ?? sp.text}”${sp.normalizedText && sp.normalizedText !== sp.text ? ` — raw: “${sp.text}”` : ''}`);
    }
    if (o.screenshots.before) md.push('', `Before:`, `![before](${o.screenshots.before})`);
    if (o.screenshots.after) md.push('', `![step](${o.screenshots.after})`);
    md.push('');
  }
  await zip.add('timeline.md', md.join('\n'));

  const d = new Date(startedAt);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return { blob: zip.finish(), filename: `${slug(session.name)}_${stamp}.zip` };
}
