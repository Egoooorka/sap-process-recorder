// Optional terminology normalisation (stage 2). It NEVER touches the raw transcript: it produces a separate
// result. Replacements are only made with terms that exist in the reference material (user glossary,
// UI labels recorded in this session, Solution Design text). Every change is listed with its source and
// score; uncertain matches are reported as suggestions, not applied. Digits / numbers are never altered.

const TR = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'u', я: 'a',
};

/** Rough phonetic skeleton so "пёрчез ордер" and "Purchase Order" produce (nearly) the same key. */
export function phoneticKey(str) {
  let s = [...str.toLowerCase()].map((ch) => (TR[ch] !== undefined ? TR[ch] : ch)).join('');
  s = s.replace(/[^a-z]/g, '');
  s = s
    .replace(/tch|ch/g, 'C').replace(/sh|zh/g, 'S').replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/th/g, 't')
    .replace(/q/g, 'k').replace(/x/g, 'ks').replace(/w/g, 'v').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k')
    .replace(/z/g, 's').replace(/y/g, 'i').replace(/(.)\1+/g, '$1');
  s = s.replace(/[aeiou]+/g, 'a').replace(/a$/, '');
  return s;
}

export function similarity(a, b) {
  if (a === b) return 1;
  const n = a.length, m = b.length;
  if (!n || !m) return 0;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[m] / Math.max(n, m);
}

const TOKEN_RE = /[\p{L}\p{N}_]+(?:[-'’/][\p{L}\p{N}_]+)*/gu;
const HAS_DIGIT = /\p{N}/u;

export function tokenize(text) {
  const out = [];
  for (const m of text.matchAll(TOKEN_RE)) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

// ---- reference material ----------------------------------------------------------------------

/** Glossary lines: "alias1 | alias2 => Canonical Term" (explicit mapping) or "Canonical Term" (reference term). */
export function parseGlossary(text) {
  const aliases = [];
  const terms = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const arrow = line.indexOf('=>');
    if (arrow > 0) {
      const term = line.slice(arrow + 2).trim();
      if (!term) continue;
      for (const a of line.slice(0, arrow).split('|')) if (a.trim()) aliases.push({ alias: a.trim(), term, source: 'glossary' });
      terms.push({ text: term, source: 'glossary' });
    } else {
      terms.push({ text: line, source: 'glossary' });
    }
  }
  return { aliases, terms };
}

const STOP = new Set('the this that these those with from into when then there here have will would should could about after before which what where while your you our are for and not but can may also each such than only more most some any all use used using see note step steps table figure section chapter page'.split(' '));

/** Pull SAP-looking identifiers and phrases out of free text (Solution Design). Conservative on purpose. */
export function extractDesignTerms(text, max = 400) {
  const freq = new Map();
  const add = (t) => {
    let words = t.trim().split(/\s+/);
    while (words.length && STOP.has(words[0].toLowerCase())) words.shift(); // sentence starters ("Use Material Document")
    while (words.length && STOP.has(words[words.length - 1].toLowerCase())) words.pop();
    t = words.join(' ');
    if (t.length < 3 || t.length > 40 || /\p{N}{3,}/u.test(t)) return;
    const k = t.toLowerCase();
    if (STOP.has(k)) return;
    const cur = freq.get(k) || { text: t, n: 0 };
    cur.n++;
    freq.set(k, cur);
  };
  const s = String(text || '');
  for (const m of s.matchAll(/[«“"`]([^«»“”"`\n]{3,40})[»”"`]/g)) add(m[1]);
  for (const m of s.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) add(m[0]);
  for (const m of s.matchAll(/\b[A-Za-z]+(?:[_/][A-Za-z0-9]+)+\b/g)) add(m[0]);
  for (const m of s.matchAll(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g)) add(m[0]); // CamelCase
  for (const m of s.matchAll(/\b[A-Z][a-z]{2,}(?:[ -][A-Z][a-z]{2,}){1,3}\b/g)) add(m[0]); // Title Case phrases
  const out = [...freq.values()].sort((a, b) => b.n - a.n || a.text.length - b.text.length).slice(0, max);
  return out.map((x) => x.text);
}

/** UI labels recorded in this session (no masked fields, no values, nothing with long digit runs). */
export function termsFromEvents(events) {
  const freq = new Map();
  const add = (t) => {
    t = (t || '').trim().replace(/\s+/g, ' ');
    if (t.length < 3 || t.length > 40 || t.split(' ').length > 5 || /\p{N}{3,}/u.test(t) || /[@]/.test(t)) return;
    const k = t.toLowerCase();
    const cur = freq.get(k) || { text: t, n: 0 };
    cur.n++;
    freq.set(k, cur);
  };
  for (const e of events) {
    if (e.masked) continue;
    if (['click', 'input', 'select', 'toggle'].includes(e.type)) add(e.label);
    if (e.type === 'dialog_open' || e.type === 'dialog_close') add(e.title);
    if (e.type === 'navigation') add(e.title);
  }
  return [...freq.values()].sort((a, b) => b.n - a.n).map((x) => x.text);
}

/** Merge all sources. Priority when a term appears in several: glossary > ui > design. */
export function buildReferences({ glossaryText = '', designText = '', events = [] } = {}) {
  const g = parseGlossary(glossaryText);
  const seen = new Set();
  const terms = [];
  const push = (text, source) => {
    const k = text.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    terms.push({ text, source });
  };
  g.terms.forEach((t) => push(t.text, 'glossary'));
  termsFromEvents(events).forEach((t) => push(t, 'ui'));
  extractDesignTerms(designText).forEach((t) => push(t, 'design'));
  return {
    aliases: g.aliases,
    terms,
    counts: {
      aliases: g.aliases.length,
      glossary: terms.filter((t) => t.source === 'glossary').length,
      ui: terms.filter((t) => t.source === 'ui').length,
      design: terms.filter((t) => t.source === 'design').length,
    },
  };
}

/** Short vocabulary hint for Whisper's initial prompt (spelling bias only; capped for token budget). */
export function buildPrompt(refs, maxChars = 380) {
  const list = [];
  let len = 0;
  for (const t of refs.terms) {
    if (!/[A-Za-z]/.test(t.text) || t.text.length > 30) continue; // spell-bias mainly helps Latin SAP terms
    if (len + t.text.length + 2 > maxChars) break;
    list.push(t.text);
    len += t.text.length + 2;
  }
  return list.length ? `SAP Fiori: ${list.join(', ')}.` : '';
}

// ---- matching ------------------------------------------------------------------------------

function prepareTerms(refs) {
  return refs.terms
    .map((t) => {
      const words = tokenize(t.text);
      const key = phoneticKey(t.text);
      return { ...t, nWords: words.length, key, lower: t.text.toLowerCase() };
    })
    .filter((t) => t.nWords > 0 && t.key.length >= 4 && !HAS_DIGIT.test(t.text));
}

export function normalizeSegment(seg, refs, prepared, threshold) {
  const text = seg.text;
  const toks = tokenize(text);
  const cands = []; // {start,end,from,to,kind,score,source,term}
  const suggestions = [];
  const aliasList = refs.aliases.map((a) => ({ ...a, toks: tokenize(a.alias).map((t) => t.text.toLowerCase()) }));

  for (let i = 0; i < toks.length; i++) {
    for (let size = 1; size <= 5 && i + size <= toks.length; size++) {
      const win = toks.slice(i, i + size);
      const start = win[0].start, end = win[size - 1].end;
      const from = text.slice(start, end);
      if (HAS_DIGIT.test(from)) continue; // never alter numbers / document numbers
      if (!/^\s*$/.test(text.slice(start, end).replace(/[\p{L}\p{N}_\-'’/]+/gu, ''))) continue; // punctuation inside window

      const lowerWords = win.map((t) => t.text.toLowerCase());
      for (const a of aliasList) {
        if (a.toks.length === size && a.toks.every((w, k) => w === lowerWords[k]) && from !== a.term) {
          cands.push({ start, end, from, to: a.term, kind: 'alias', score: 1, source: a.source, term: a.term });
        }
      }
      const key = phoneticKey(from);
      if (key.length < 4) continue;
      for (const t of prepared) {
        if (t.nWords !== size) continue; // equal word count keeps stray words like "и" out of a match
        if (Math.abs(t.key.length - key.length) > Math.max(2, key.length * 0.25)) continue;
        if (from === t.text) continue;
        if (from.toLowerCase() === t.lower) {
          if (t.text !== t.text.toLowerCase()) cands.push({ start, end, from, to: t.text, kind: 'case', score: 1, source: t.source, term: t.text });
          continue;
        }
        const score = similarity(key, t.key);
        // short keys are collision-prone: demand a perfect phonetic match there
        const need = key.length < 6 ? 1 : threshold;
        if (score >= need) cands.push({ start, end, from, to: t.text, kind: 'fuzzy', score: +score.toFixed(3), source: t.source, term: t.text });
        else if (score >= threshold - 0.08 && key.length >= 6) suggestions.push({ start, end, from, term: t.text, score: +score.toFixed(3), source: t.source, reason: 'low confidence' });
      }
    }
  }

  // Resolve ambiguity per span: a fuzzy winner needs a clear margin over a different term.
  const bySpan = new Map();
  for (const c of cands) {
    const k = `${c.start}:${c.end}`;
    if (!bySpan.has(k)) bySpan.set(k, []);
    bySpan.get(k).push(c);
  }
  const resolved = [];
  for (const list of bySpan.values()) {
    list.sort((a, b) => (b.kind === 'alias') - (a.kind === 'alias') || b.score - a.score);
    const best = list[0];
    const rival = list.find((c) => c.term.toLowerCase() !== best.term.toLowerCase());
    if (best.kind === 'fuzzy' && rival && best.score - rival.score < 0.03) {
      suggestions.push({ start: best.start, end: best.end, from: best.from, term: best.term, score: best.score, source: best.source, reason: `ambiguous with "${rival.term}"` });
    } else resolved.push(best);
  }

  // Greedy non-overlapping selection: aliases first, then by score, then longer spans.
  resolved.sort((a, b) => (b.kind === 'alias') - (a.kind === 'alias') || b.score - a.score || (b.end - b.start) - (a.end - a.start));
  const chosen = [];
  for (const c of resolved) if (!chosen.some((x) => c.start < x.end && x.start < c.end)) chosen.push(c);
  chosen.sort((a, b) => a.start - b.start);

  let out = text;
  for (const c of [...chosen].reverse()) out = out.slice(0, c.start) + c.to + out.slice(c.end);
  const chosenSpans = new Set(chosen.map((c) => `${c.start}:${c.end}`));
  const uniq = new Map();
  for (const s of suggestions) {
    if (chosenSpans.has(`${s.start}:${s.end}`)) continue;
    const k = `${s.start}:${s.end}:${s.term}`;
    if (!uniq.has(k) || uniq.get(k).score < s.score) uniq.set(k, s);
  }
  return { id: seg.id, text: out, changes: chosen, suggestions: [...uniq.values()].sort((a, b) => a.start - b.start) };
}

export function normalizeTranscript(segments, refs, { threshold = 0.84 } = {}) {
  const prepared = prepareTerms(refs);
  return {
    createdAt: Date.now(),
    params: { threshold, note: 'raw transcript is unchanged; only terms from the reference sources are used' },
    sources: refs.counts,
    segments: segments.map((s) => normalizeSegment(s, refs, prepared, threshold)),
  };
}
