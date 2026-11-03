# SAP Process Recorder

Record a business process you perform by hand in **one SAP Fiori browser tab** – screenshots, UI actions, microphone narration –
and turn it into a documentation package. Optional **local speech-to-text** (Whisper) transcribes the narration on your Mac and
links every spoken sentence to the UI actions that happened at the same time. Nothing is uploaded anywhere.

```
extension/    Chrome Manifest V3 extension (recorder, review page, ZIP export)
asr-helper/   local Python service that runs Whisper (mlx-whisper on Apple Silicon, whisper.cpp on Intel)
```

**ZIP export:** `events.json`, `timeline.md`, `narration.webm`, `screenshots/step-001.png …`, `session.json`, and – if transcribed –
`transcript.txt`, `transcript.json`, `transcript.srt` (+ `transcript.normalized.*`).

## Requirements

- Google Chrome 116+ (macOS; the extension itself also works on other desktop OSes)
- For transcription: a Mac, [Homebrew](https://brew.sh), ~2 GB free disk for the default model (4+ GB with the alternative model)

## 1. Install the extension (5 minutes, no build step)

1. `git clone <this repo>` (or download the ZIP and unpack it).
2. Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the **`extension/`** folder.
3. Pin the extension (puzzle icon → pin). Screenshot shortcut: **Alt+Shift+S** (change at `chrome://extensions/shortcuts`).

Use it: open your Fiori app in a tab → extension icon → enter a process name → **Start recording** (first time with the microphone on,
Chrome asks for permission in a new tab – allow it, return to the SAP tab, press Start again) → work normally → **Stop**.
The review page opens: play the audio, delete anything you do not want, **Export ZIP**. Full details: [extension/README.md](extension/README.md).

## 2. Add Whisper (local transcription)

The browser cannot run Whisper itself, so a small helper runs on your Mac and the extension talks to it on `127.0.0.1`.
The helper picks the engine from your CPU:

| Mac | Engine | Notes |
|---|---|---|
| Apple Silicon (M1…M5) | **mlx-whisper** | fastest; needs a native arm64 Python (the setup script installs one) |
| Intel | **whisper.cpp** | installed via Homebrew |

Default model: **Whisper Large V3 Turbo** (~1.6 GB). Alternative: **Large V3** (~3 GB, slower, most accurate).

### Automatic setup

```bash
cd asr-helper
./setup.sh --prefetch        # installs ffmpeg + python@3.12 (Homebrew), a venv with mlx-whisper (or whisper-cpp on Intel),
                             # and downloads the Turbo model. Homebrew will ask you to confirm; allow ~5–10 minutes.
./run.sh                     # starts the helper; keep this terminal open. It prints an access token.
```

Options: `./setup.sh --large-v3` also downloads the alternative model; `--with-cpp` also installs whisper.cpp on Apple Silicon as a fallback.
Without `--prefetch` the model is downloaded on the first transcription instead.

### Manual setup (what the script does)

```bash
brew install ffmpeg python@3.12
python3.12 -m venv asr-helper/.venv
# Apple Silicon:
asr-helper/.venv/bin/pip install mlx-whisper
# Intel:
brew install whisper-cpp
# check what was detected and what is installed:
cd asr-helper && .venv/bin/python -m asr_helper doctor
```

### Connect the extension

1. Start the helper (`./run.sh`) – copy the **token** it prints (also stored in `~/.sap-process-recorder/token`).
2. Chrome → the extension's **Options** (popup → *Privacy settings*, scroll to **Speech recognition**).
3. Paste the token → **Test connection**. You should see your chip, the chosen backend and `large-v3-turbo ✓`.
4. Choose the narration language (**Russian** by default, English or Auto), model, and **Save speech settings**.
5. After a recording, open the review page → **Transcribe**. Progress and errors are shown; **Retranscribe** any time with another
   language/model without recording again. Speech is only *transcribed*, never translated.

### Choosing another Whisper model or engine

- **Large V3 instead of Turbo:** pick it in Options (or per run on the review page). It downloads on first use, or run
  `asr-helper/.venv/bin/python -m asr_helper prefetch --model large-v3`.
- **Another engine:** drop a plugin into `~/.sap-process-recorder/plugins/` – see [asr-helper/README.md](asr-helper/README.md#adding-another-asr-engine).

### Terminology (optional)

For Russian narration with English SAP terms: add a glossary (`фиори => Fiori`, one reference term per line – see
[asr-helper/glossary.example.txt](asr-helper/glossary.example.txt)) and/or paste the Solution Design text in the same Options panel. UI labels from
the recording are used automatically. The *Normalise terminology* step never edits the raw transcript, only uses terms from those references,
lists every change, and never touches numbers.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Local ASR helper is not reachable" | start `asr-helper/run.sh`; check the URL in Options (`http://127.0.0.1:8765`) |
| "helper rejected the token" | paste the token printed by the helper / from `~/.sap-process-recorder/token` |
| `ffmpeg not found` | `brew install ffmpeg` |
| `mlx-whisper not installed` / Python under Rosetta | run `asr-helper/setup.sh` from a native (arm64) terminal |
| First transcription is slow | the model is being downloaded/loaded once; later runs are faster |
| Hallucinated text on silence | segments flagged "likely silence" on the review page; keep "Condition on previous text" off |
| Microphone not recording | allow the mic on the tab that opens from the popup; check `chrome://settings/content/microphone` |

## Privacy

No telemetry, no cloud. Recordings live in the browser's IndexedDB until you export or delete them. The helper listens on loopback only,
requires a token, accepts only `chrome-extension://` origins, and deletes uploaded audio after each job. Passwords and hidden fields are never
captured; masking rules are configurable. Review recordings before sharing a ZIP – screenshots may still contain business data.

## Development

```bash
node --test extension/tests/lib.test.mjs                      # alignment, normalisation, SRT
cd asr-helper && python3 -m unittest discover -s tests         # helper API with a fake backend
```

Status: MVP. Covered by automated tests of the pure logic and helper API, and used end to end by the author.
Please report problems as GitHub issues; the manual test list is in [extension/README.md](extension/README.md).

## License

MIT – see [LICENSE](LICENSE). Whisper models are released by OpenAI under the MIT license; ffmpeg, mlx-whisper and whisper.cpp have their own licenses.
