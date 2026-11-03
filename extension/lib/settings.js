export const DEFAULTS = {
  captureValues: true, // store values of non-sensitive fields
  redactScreenshots: true, // blur masked fields while a screenshot is taken
  maskSelectors: 'input[type="password"]\n[data-sensitive]\n.sensitive', // one CSS selector per line
  maskPatterns: 'passw|pwd|secret|token|\\bpin\\b|iban|cvv|ssn|social security|salary|kennwort',
  quietMs: 600, // DOM/network quiet time that counts as "UI stable"
  maxWaitMs: 6000, // never wait longer than this for stabilisation

  // ---- Speech recognition (local helper, see asr-helper/) ----
  asrHelperUrl: 'http://127.0.0.1:8765',
  asrToken: '', // printed by the helper on start; also in ~/.sap-process-recorder/token
  asrBackend: 'auto', // auto | mlx-whisper | whisper.cpp | <plugin id>
  asrModel: 'large-v3-turbo', // | large-v3
  asrLanguage: 'ru', // ru | en | auto
  asrMode: 'after', // 'after' = after recording; 'live' is planned
  asrAutoStart: false, // start transcription automatically when a recording is stopped
  asrUseHints: true, // pass SAP UI labels + glossary terms to Whisper as initial prompt
  asrConditionPrev: false, // condition on previous text (better flow, more risk of repetition loops)
  asrSyncOffsetMs: 0, // manual correction added to speech timestamps when matching events
  glossary: '', // "alias | alias => Canonical Term" lines, or plain reference terms
  solutionDesign: '', // pasted text of the Solution Design (reference only)
  normThreshold: 0.84, // fuzzy match threshold of the terminology normaliser
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

export const saveSettings = (settings) => chrome.storage.local.set({ settings });

export async function getPrefs() {
  const { prefs } = await chrome.storage.local.get('prefs');
  return { name: '', mic: true, shotMode: 'after', ...(prefs || {}) };
}

export const savePrefs = (prefs) => chrome.storage.local.set({ prefs });
