import { getSettings, saveSettings } from './lib/settings.js';
import { getHealth } from './lib/asr-client.js';
import { extractDesignTerms } from './lib/normalize.js';

const $ = (id) => document.getElementById(id);
const TEXT = ['asrHelperUrl', 'asrToken', 'asrLanguage', 'asrModel', 'asrBackend', 'glossary', 'solutionDesign'];
const BOOL = ['asrAutoStart', 'asrUseHints', 'asrConditionPrev'];

function designInfo() {
  const n = extractDesignTerms($('solutionDesign').value).length;
  $('sdInfo').textContent = $('solutionDesign').value ? `${n} reference terms extracted` : '';
}

async function load() {
  const s = await getSettings();
  TEXT.forEach((k) => ($(k).value = s[k]));
  BOOL.forEach((k) => ($(k).checked = !!s[k]));
  $('asrSyncOffsetMs').value = s.asrSyncOffsetMs;
  $('normThreshold').value = s.normThreshold;
  document.querySelector(`input[name=asrMode][value=${s.asrMode === 'live' ? 'after' : s.asrMode}]`).checked = true;
  designInfo();
}

$('solutionDesign').addEventListener('input', designInfo);
$('sdFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) { $('solutionDesign').value = await f.text(); designInfo(); }
});

$('asrSave').onclick = async () => {
  const s = {};
  TEXT.forEach((k) => (s[k] = k === 'glossary' || k === 'solutionDesign' ? $(k).value : $(k).value.trim()));
  BOOL.forEach((k) => (s[k] = $(k).checked));
  s.asrSyncOffsetMs = Number($('asrSyncOffsetMs').value) || 0;
  s.normThreshold = Math.min(1, Math.max(0.7, Number($('normThreshold').value) || 0.84));
  s.asrMode = 'after';
  await saveSettings({ ...(await getSettings()), ...s });
  $('asrMsg').textContent = 'Saved.';
};

$('asrTest').onclick = async () => {
  $('asrTestMsg').textContent = 'Connecting…';
  $('asrInfo').textContent = '';
  const cur = { asrHelperUrl: $('asrHelperUrl').value.trim(), asrToken: $('asrToken').value.trim() };
  try {
    const h = await getHealth(cur);
    $('asrTestMsg').textContent = `✅ Connected (helper ${h.version})`;
    const hw = h.hardware;
    const lines = [
      `Hardware: ${hw.chip || '?'} · ${hw.native_arch}${hw.rosetta ? ' (Python under Rosetta)' : ''} · ${hw.ram_gb ?? '?'} GB RAM · macOS ${hw.macos}`,
      `Choice: ${h.choice_reason}`,
      `Recommended backend: ${h.recommended_backend || 'none available'}`,
      `ffmpeg: ${h.ffmpeg ? 'found' : 'MISSING – brew install ffmpeg'}`,
      ...h.backends.map((b) => `• ${b.id}: ${b.available ? 'ready' : 'unavailable – ' + b.reason}` +
        (b.available ? ' | models: ' + b.models.map((m) => `${m.id}${m.installed ? ' ✓' : ' (downloads on first use)'}`).join(', ') : '')),
    ];
    $('asrInfo').textContent = lines.join('\n');
    const sel = $('asrBackend');
    const have = new Set([...sel.options].map((o) => o.value));
    h.backends.forEach((b) => { if (!have.has(b.id)) sel.add(new Option(b.id + ' (plugin)', b.id)); });
  } catch (e) {
    $('asrTestMsg').textContent = `❌ ${e.message}`;
    $('asrInfo').textContent = e.hint || '';
  }
};

load();
