import { DEFAULTS, getSettings, saveSettings } from './lib/settings.js';

const $ = (id) => document.getElementById(id);
const BOOL = ['captureValues', 'redactScreenshots'];
const TEXT = ['maskSelectors', 'maskPatterns'];
const NUM = ['quietMs', 'maxWaitMs'];

function fill(s) {
  BOOL.forEach((k) => ($(k).checked = !!s[k]));
  TEXT.forEach((k) => ($(k).value = s[k]));
  NUM.forEach((k) => ($(k).value = s[k]));
}

$('save').onclick = async () => {
  try { new RegExp($('maskPatterns').value); } catch (e) { $('msg').textContent = `Invalid regex: ${e.message}`; return; }
  const s = {};
  BOOL.forEach((k) => (s[k] = $(k).checked));
  TEXT.forEach((k) => (s[k] = $(k).value));
  NUM.forEach((k) => (s[k] = Math.max(100, Number($(k).value) || DEFAULTS[k])));
  await saveSettings({ ...(await getSettings()), ...s }); // keep speech-recognition settings
  $('msg').textContent = 'Saved. Applies to the next recording.';
};
$('reset').onclick = () => { fill(DEFAULTS); $('msg').textContent = 'Defaults loaded – press Save.'; };
getSettings().then(fill);
