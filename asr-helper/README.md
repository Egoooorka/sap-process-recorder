# ASR helper (local speech-to-text for SAP Process Recorder)

A small local HTTP service (Python stdlib, `127.0.0.1` only) that transcribes the extension's `narration.webm`
with **Whisper** on this Mac. Nothing is uploaded; no cloud/paid API.

## Backend selection (by CPU)

| Mac | Backend | Why |
|---|---|---|
| Apple Silicon (arm64, native Python) | **mlx-whisper** (fallback whisper.cpp) | Metal/MLX is the fastest on M-series |
| Apple Silicon but Python under Rosetta | whisper.cpp | MLX needs a native arm64 Python |
| Intel (x86_64) | **whisper.cpp** | MLX is Apple-Silicon only |

Models (catalog ids): `large-v3-turbo` (**default**), `large-v3` (alternative), plus `large-v3-turbo-q5_0` (whisper.cpp only, small).
`task` is always `transcribe`; the spoken language is kept (Russian by default, English terms stay as spoken). `translate` is never used,
even if a client asks for it.

The detected machine for this repo: **Apple M5, arm64 native, 24 GB** → mlx-whisper + `large-v3-turbo`.

## Install & run

```bash
cd asr-helper
./setup.sh --prefetch      # brew ffmpeg + python@3.12, venv, mlx-whisper (Apple Silicon) or whisper-cpp (Intel), downloads the model
./run.sh                   # prints a token; paste it into the extension: Options -> Speech recognition -> Token
```

`./setup.sh --large-v3` also downloads the alternative model; `--with-cpp` installs whisper.cpp on Apple Silicon as fallback.
Without `--prefetch` the model downloads automatically on the first transcription (progress is shown in the review page).
Check the setup any time: `.venv/bin/python -m asr_helper doctor`.

Transcribe a file without the extension: `.venv/bin/python -m asr_helper transcribe rec.webm --language ru`.

## HTTP API (token header `X-ASR-Token`)

- `GET /health` – hardware, backends, models, ffmpeg.
- `POST /jobs?language=ru|en|auto&model=large-v3-turbo&backend=auto&condition_on_previous_text=0|1` – body = raw audio; optional
  header `X-ASR-Prompt-B64` (UTF-8 vocabulary hint, base64) → `{id}`.
- `GET /jobs/<id>` – `status` (`queued|converting|downloading_model|transcribing|done|error|cancelled`), `progress` 0..1, `result` when done.
- `DELETE /jobs/<id>` – cancel.

Security: loopback bind, Host-header check (DNS-rebinding), only `chrome-extension://` origins (pin one with `--extension-id`), token in
`~/.sap-process-recorder/token` (mode 600). Uploaded audio and temporary WAVs are deleted after the job; results are kept 7 days in
`~/.sap-process-recorder/jobs/`.

## Adding another ASR engine

Create `~/.sap-process-recorder/plugins/my_engine.py`:

```python
from asr_helper.backends import register
from asr_helper.backends.base import ASRBackend

class MyEngine(ASRBackend):
    id, label = "my-engine", "My engine"
    def models(self): return {"large-v3-turbo": {"label": "…", "ref": "…"}}
    def available(self): return True, ""
    def model_installed(self, model): return True
    def transcribe(self, req, report, cancelled):
        # req.wav_path (16 kHz mono WAV), req.language, req.prompt, req.task == "transcribe"
        report(0.5, "transcribing", "halfway")
        return {"language": "ru", "model_ref": "…", "segments": [{"start": 0.0, "end": 2.5, "text": "…"}]}

register(MyEngine())
```

Restart the helper; the backend appears in the extension's backend list. Plugins run with your user's rights – only install ones you trust.

## Tests

```bash
python3 -m unittest discover -s tests   # hardware choice, API, auth, task=transcribe enforcement (fake backend)
```
