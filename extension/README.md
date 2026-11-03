# SAP Process Recorder – extension (Chrome MV3, local only)

Records a business process performed by hand in **one** SAP Fiori browser tab: screenshots, UI actions
(timestamps, element labels, field names) and microphone narration. Review the data, then export a ZIP.
No dependencies, no build step, no network access, no telemetry.

## Install

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder of this repository (Chrome ≥ 116).
3. Optional: pin the extension. Change the screenshot shortcut at `chrome://extensions/shortcuts`
   (default **Alt+Shift+S**).

## Use

1. Open your Fiori Launchpad / app in a tab and make it the active tab.
2. Click the extension icon, enter a **process name**, choose microphone on/off and a **screenshot mode**
   (after each action / before+after / manual only), press **Start recording**.
   - First time with the mic enabled, a tab opens to grant microphone permission; allow it, return to the SAP
     tab, press Start again.
3. Work normally. You can close the popup and switch to other tabs; the toolbar badge shows the action counter,
   and the narration keeps recording. Other tabs are never injected, tracked or captured.
4. Press **Stop recording** (popup). The **Review** page opens: play the narration, inspect every event and
   screenshot, delete anything you don't want, then **Export ZIP**.

### ZIP contents

```
events.json        structured events (time, offsetMs, audioOffsetMs, type, label, role, selector, value, url, screenshots)
timeline.md        human-readable step list with embedded screenshots
narration.webm     microphone audio (only if enabled)
screenshots/step-001.png, step-001-before.png, ...   (red frame + click dot + step number drawn on the clicked element)
screenshots/original/...   untouched copies of every image that got a frame
session.json       metadata: tab/window, start/end, audio start offset, options, masking config
```

`audioOffsetMs` in each event is the position inside `narration.webm`; `session.json → audio.offsetFromSessionStartMs`
shows how long after the session start the microphone began.

## What is captured

- Element geometry: every action event has `rect` (x, y, w, h in viewport CSS px; `exact:false` for cross-origin iframes) and clicks have `point`. `events.json → highlights.before/after` holds the same box converted to pixels of each screenshot (`x,y,w,h,imageWidth,imageHeight,click`), used to draw the highlight frames at export (checkbox "Draw highlight frames" on the review page; frames go on the `before` image, or on `after` when there is no `before`; skipped for cross-origin iframes). Use `before` for exactness; `after` is valid only if the layout did not shift.

- Clicks on buttons, links, menu items, tabs, list items/tiles, table rows, options (incl. UI5 `sap.m` / `sap.ui.table` markup).
- Field changes (`input`, `select`, checkbox/radio), with label from `aria-label(ledby)`, `<label>`, placeholder, title or text.
- Dialogs opening/closing (`role=dialog|alertdialog`, `<dialog>`; UI5 popovers are ignored), message toasts.
- Navigation: full loads, `pushState` and hash routing (UI5 router) via `chrome.webNavigation`.
- Tab switches away from / back to the recorded tab (logged, nothing captured while away).
- Iframes inside the recorded tab are tracked too.

### Screenshots

- Initial screen, then after meaningful actions once the UI is **stable**: no DOM mutation or network resource for
  600 ms, no UI5 busy indicator / block layer, max 6 s wait (configurable).
- Mode "before+after" also captures on mouse-down of an action. Identical consecutive images are skipped.
- Captures are throttled to < 2/s (Chrome's `captureVisibleTab` quota), with retry on quota errors.
- **Safety**: a screenshot is taken only if the bound tab is the *active* tab of the bound window, checked before
  *and* after the capture; otherwise the image is discarded (reason stored in the event).

## Privacy

- Everything stays in the browser's IndexedDB until you export; the ZIP is built in the browser. No uploads.
- Password and hidden fields are never read; values are never stored for masked elements.
- **Privacy settings** (popup → Privacy settings): toggle value capture, edit masked CSS selectors and a name regex
  (label/name/id/placeholder), and blur masked fields in screenshots (applied only for the instant of capture).
- Delete individual events/screenshots or whole recordings on the review page.
- `<all_urls>` host permission is required for `captureVisibleTab` and injection; the content script is injected
  programmatically **only** into the bound tab while recording.

## How it survives popup closure / worker suspension

- State lives in `chrome.storage.local` (`rec`) and IndexedDB (events, PNG blobs, 1 s audio chunks); the service
  worker reloads it on every wake-up.
- The microphone runs in an **offscreen document** that writes its chunks directly to IndexedDB.
- If the recorded tab is closed the recording is finalised automatically; after a browser restart an unfinished
  recording is closed as `interrupted` (data up to that point is kept and exportable).

## Test checklist

1. Load the extension, open any https page (or a Fiori system), start a recording with mic on.
2. Click a few buttons/links, type into a text field, change a dropdown, open a dialog, navigate by hash.
3. Switch to another tab, talk for a few seconds, switch back; press Alt+Shift+S on the SAP tab.
4. Open another tab/window and click around: nothing is recorded; Alt+Shift+S there only flashes a `!` badge.
5. Close the popup mid-recording, reopen it: timer and counter continue. Wait > 30 s idle to let the worker sleep,
   then click again: events still arrive.
6. Stop → review page: events, thumbnails, audio playback. Export, unzip, check the files; compare `audioOffsetMs`
   with what you said in the narration.
7. Type into a password field: no value anywhere in `events.json`, field blurred in screenshots.

Debug: `chrome://extensions` → *service worker* link opens the worker console; the offscreen document appears
under *Inspect views*.


## Speech recognition (local Whisper)

Runs outside the browser in the helper in `../asr-helper` (setup: `./setup.sh --prefetch`, start: `./run.sh`, see its README).
Default: **Whisper Large V3 Turbo**; alternative Large V3. Apple Silicon → mlx-whisper, Intel → whisper.cpp (auto-selected).
Language defaults to Russian (English SAP terms stay as spoken); `task=transcribe`, never translated.

1. Options → *Speech recognition*: paste the helper token, **Test connection** (shows detected CPU, chosen backend, installed models),
   pick language/model, optionally add a glossary and Solution Design text.
2. After Stop, on the review page press **Transcribe** (or enable auto-start). Progress and errors are shown; **Retranscribe** with another
   language/model at any time without re-recording (each run is kept; the original audio and timestamps are never modified).
3. Segments are matched to Chrome events by time (`during` / `just before speaking` / `just after speaking`); click a timestamp to play from there.
   A sync correction in ms is available in the settings if narration and events are consistently offset.
4. Optional **Normalise terminology**: separate stage; raw text stays untouched. Only terms from your glossary, the UI labels of this recording
   and the Solution Design text are used; every change is listed with source and score, doubtful ones are shown as "not applied" suggestions,
   and numbers/document numbers are never changed. Short terms (e.g. "Fiori") need an explicit alias line `фиори => Fiori`.
5. Export adds `transcript.txt`, `transcript.json` (segments + linked events + optional normalised text), `transcript.srt` (timestamps relative to
   `narration.webm`), and `transcript.normalized.*` when normalisation was run; `events.json` gets a `speech` list per event and `timeline.md` shows the narration.

Live transcription (while recording) is not implemented yet; the option is present but disabled.

Tests for the pure logic (alignment, normalisation, SRT): `node --test tests/lib.test.mjs`.

## Known limitations (MVP)

- Chrome can only screenshot the visible tab of a window, so actions are logged but not captured while the SAP tab
  is hidden. Minimized windows are skipped.
- Cross-origin SAP GUI/WebGUI canvases and native `<select>` popups are not visible to the DOM tracker; use the manual
  screenshot shortcut there.
- ZIP is uncompressed (store) and limited to < 4 GB. No extension icons are bundled.
