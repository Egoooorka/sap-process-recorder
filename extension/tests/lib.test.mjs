import assert from 'node:assert/strict';
import { test } from 'node:test';
const R = new URL('../lib/', import.meta.url).href;
const N = await import(R + 'normalize.js');
const A = await import(R + 'align.js');
const T = await import(R + 'transcript.js');

test('phonetic keys match across scripts', () => {
  assert.equal(N.phoneticKey('пёрчез ордер'), N.phoneticKey('Purchase Order'));
  assert.equal(N.phoneticKey('лаунчпад'), N.phoneticKey('Launchpad'));
});
test('fuzzy replacement uses only reference terms, logs changes', () => {
  const refs = N.buildReferences({ glossaryText: 'Purchase Order\nLaunchpad\nфиори | фиорри => Fiori', events: [] });
  const out = N.normalizeTranscript([{ id: 0, text: 'Открываю лаунчпад и создаю пёрчез ордер, потом фиори.' }], refs);
  const s = out.segments[0];
  assert.equal(s.text, 'Открываю Launchpad и создаю Purchase Order, потом Fiori.');
  assert.deepEqual(s.changes.map((c) => c.kind), ['fuzzy', 'fuzzy', 'alias']);
});
test('numbers and unknown words are never changed or invented', () => {
  const refs = N.buildReferences({ glossaryText: 'Purchase Order' });
  const txt = 'Документ 4500012345 создан, поставщик Иванов, заказ готов.';
  const s = N.normalizeTranscript([{ id: 0, text: txt }], refs).segments[0];
  assert.equal(s.text, txt);
  assert.equal(s.changes.length, 0);
});
test('short terms need alias, not fuzzy', () => {
  const refs = N.buildReferences({ glossaryText: 'Fiori' });
  assert.equal(N.normalizeTranscript([{ id: 0, text: 'машина фара горит' }], refs).segments[0].text, 'машина фара горит');
});
test('UI labels become terms but not ones with long digit runs', () => {
  const t = N.termsFromEvents([{ type: 'click', label: 'Create Purchase Order' }, { type: 'click', label: 'Order 4500012345' }, { type: 'input', label: 'Password', masked: true }]);
  assert.deepEqual(t, ['Create Purchase Order']);
});
test('design term extraction + prompt', () => {
  const d = N.extractDesignTerms('The field "Plant" maps to WERKS. Use Material Document and GoodsReceipt. The FM_CREATE_PO is called.');
  for (const x of ['Plant', 'WERKS', 'Material Document', 'GoodsReceipt', 'FM_CREATE_PO']) assert.ok(d.includes(x), x);
  const p = N.buildPrompt(N.buildReferences({ glossaryText: 'Purchase Order', designText: 'WERKS' }));
  assert.match(p, /^SAP Fiori: Purchase Order, WERKS\.$/);
});
test('alignment relations', () => {
  const events = [{ seq: 1, t: 10_000, type: 'click' }, { seq: 2, t: 14_000, type: 'click' }, { seq: 3, t: 60_000, type: 'click' }];
  const segs = [{ id: 0, start: 1, end: 3 }, { id: 1, start: 30, end: 31 }];
  const r = A.alignSegments(segs, events, { audioStartedAt: 9_000, sessionStartedAt: 8_000 });
  assert.equal(r.segments.get(0).events[0].relation, 'during'); // 10_000 within 10_000..12_000
  assert.equal(r.segments.get(0).events[0].seq, 1);
  assert.equal(r.segments.get(0).events[1].relation, 'after_speech'); // 14_000 is 2s after end 12_000
  assert.equal(r.segments.get(1).events.length, 0);
  assert.equal(r.segments.get(1).nearest.distant, true);
  assert.equal(r.segments.get(0).sessionStartMs, 2000);
  assert.equal(r.events.get(3), undefined);
});
test('srt/txt', () => {
  const segs = [{ start: 0.5, end: 3661.25, text: 'Привет' }];
  assert.equal(T.srtTime(3661.25), '01:01:01,250');
  assert.equal(T.toSrt(segs), '1\n00:00:00,500 --> 01:01:01,250\nПривет\n');
  assert.match(T.toTxt(segs), /^\[00:00\.5\] Привет\n$/);
});
