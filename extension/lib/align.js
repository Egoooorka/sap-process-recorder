// Synchronise speech segments (seconds from audio start) with Chrome event timestamps (epoch ms).

const IGNORED = new Set(['session_stop']);

/**
 * @param segments  [{id,start,end,text}]   seconds from the first audio sample
 * @param events    sorted events [{seq,t,type,...}]
 * @param opts      {audioStartedAt, sessionStartedAt, leadMs, lagMs, offsetMs, describe}
 * @returns {segments: Map(id -> {absStartMs, absEndMs, sessionStartMs, events:[], nearest}),
 *           events: Map(seq -> [{segmentId, relation, deltaMs}])}
 *
 * relation: "during"        event happened while the segment was spoken (delta 0)
 *           "before_speech" event happened up to `leadMs` before the segment started ("I clicked X, now…")
 *           "after_speech"  event happened up to `lagMs` after the segment ended ("let's click X")
 */
export function alignSegments(segments, events, opts) {
  const { audioStartedAt, sessionStartedAt, leadMs = 2500, lagMs = 4000, offsetMs = 0, describe } = opts;
  const segOut = new Map();
  const evOut = new Map();
  if (audioStartedAt == null) return { segments: segOut, events: evOut };
  const usable = events.map((e, i) => ({ e, index: i + 1 })).filter(({ e }) => !IGNORED.has(e.type));

  for (const s of segments) {
    const absStartMs = audioStartedAt + offsetMs + Math.round(s.start * 1000);
    const absEndMs = audioStartedAt + offsetMs + Math.round(s.end * 1000);
    const hits = [];
    for (const { e, index } of usable) {
      let relation = null;
      let deltaMs = 0;
      if (e.t >= absStartMs && e.t <= absEndMs) relation = 'during';
      else if (e.t < absStartMs && absStartMs - e.t <= leadMs) { relation = 'before_speech'; deltaMs = e.t - absStartMs; }
      else if (e.t > absEndMs && e.t - absEndMs <= lagMs) { relation = 'after_speech'; deltaMs = e.t - absEndMs; }
      if (!relation) continue;
      hits.push({ seq: e.seq, index, type: e.type, action: describe ? describe(e) : undefined, relation, deltaMs });
      if (!evOut.has(e.seq)) evOut.set(e.seq, []);
      evOut.get(e.seq).push({ segmentId: s.id, relation, deltaMs });
    }
    let nearest = null;
    if (!hits.length && usable.length) {
      let best = null;
      for (const { e, index } of usable) {
        const d = e.t < absStartMs ? e.t - absStartMs : e.t > absEndMs ? e.t - absEndMs : 0;
        if (!best || Math.abs(d) < Math.abs(best.deltaMs)) best = { seq: e.seq, index, deltaMs: d };
      }
      nearest = { ...best, distant: true }; // too far to be considered related; informational only
    }
    segOut.set(s.id, { absStartMs, absEndMs, sessionStartMs: absStartMs - sessionStartedAt, events: hits, nearest });
  }
  // keep the 3 closest segments per event
  for (const [seq, list] of evOut) {
    list.sort((a, b) => Math.abs(a.deltaMs) - Math.abs(b.deltaMs));
    evOut.set(seq, list.slice(0, 3));
  }
  return { segments: segOut, events: evOut };
}
