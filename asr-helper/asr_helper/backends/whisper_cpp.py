"""whisper.cpp backend (Intel Macs, or Apple Silicon fallback). Needs `brew install whisper-cpp ffmpeg`;
ggml model files are downloaded on first use into ~/.sap-process-recorder/models."""
from __future__ import annotations

import json
import os
import re
import tempfile
import urllib.request
from typing import Dict, Tuple

from .. import models
from ..audio import find_binary
from . import register
from .base import ASRBackend, BackendError, Cancelled, Request
from ._proc import run_streaming

PROGRESS_RE = re.compile(r"progress\s*=\s*(\d+)\s*%")


def models_dir() -> str:
    d = os.environ.get("ASR_MODELS_DIR") or os.path.join(os.path.expanduser("~"), ".sap-process-recorder", "models")
    os.makedirs(d, exist_ok=True)
    return d


def find_cli() -> str | None:
    return find_binary("whisper-cli", "WHISPER_CPP_BIN") or find_binary("whisper-cpp")


class WhisperCpp(ASRBackend):
    id = "whisper.cpp"
    label = "whisper.cpp"

    def models(self) -> Dict[str, dict]:
        return {k: {"label": v["label"], "ref": v["cpp"]} for k, v in models.CATALOG.items() if "cpp" in v}

    def available(self) -> Tuple[bool, str]:
        if not find_cli():
            return False, "whisper-cli not found (brew install whisper-cpp)"
        return True, ""

    def model_path(self, model: str) -> str:
        return os.path.join(models_dir(), self.models()[model]["ref"])

    def model_installed(self, model: str) -> bool:
        return model in self.models() and os.path.exists(self.model_path(model))

    def _download(self, model: str, report, cancelled):
        info = models.CATALOG[model]
        url = models.WHISPER_CPP_URL.format(file=info["cpp"])
        dest = self.model_path(model)
        part = dest + ".part"
        req = urllib.request.Request(url, headers={"User-Agent": "sap-process-recorder-asr-helper"})
        with urllib.request.urlopen(req, timeout=60) as r, open(part, "wb") as f:
            total = int(r.headers.get("Content-Length") or info.get("cpp_size") or 0)
            done = 0
            while True:
                if cancelled():
                    f.close()
                    os.remove(part)
                    raise Cancelled()
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                if total:
                    report(done / total * 0.5, "downloading_model",
                           f"Downloading {info['cpp']}: {done >> 20} / {total >> 20} MB")
        if info.get("cpp_size") and os.path.getsize(part) != info["cpp_size"]:
            os.remove(part)
            raise BackendError("model download is incomplete, please retry")
        os.replace(part, dest)

    def transcribe(self, req: Request, report, cancelled) -> dict:
        cli = find_cli()
        if req.model not in self.models():
            raise BackendError(f"model '{req.model}' is not available for whisper.cpp")
        if not self.model_installed(req.model):
            self._download(req.model, report, cancelled)
        report(0.0, "transcribing", "Transcribing…")
        out_base = os.path.join(tempfile.mkdtemp(prefix="cpp-asr-"), "out")
        args = [cli, "-m", self.model_path(req.model), "-f", req.wav_path,
                "-l", req.language or "auto", "-oj", "-of", out_base, "-pp",
                "-t", str(req.threads)]
        # (no -tr flag: task is always "transcribe", the spoken language is kept)
        if req.prompt:
            args += ["--prompt", req.prompt]
        if not req.condition_on_previous_text:
            args += ["-mc", "0"]

        def on_line(line: str):
            m = PROGRESS_RE.search(line)
            if m:
                report(int(m.group(1)) / 100.0, "transcribing", "Transcribing…")

        run_streaming(args, on_line, cancelled)
        path = out_base + ".json"
        if not os.path.exists(path):
            raise BackendError("whisper-cli produced no JSON output")
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        segs = []
        for s in data.get("transcription", []):
            text = (s.get("text") or "").strip()
            if text:
                segs.append({"start": s["offsets"]["from"] / 1000.0, "end": s["offsets"]["to"] / 1000.0, "text": text})
        return {"language": (data.get("result") or {}).get("language"), "segments": segs,
                "model_ref": self.models()[req.model]["ref"]}


def register_default():
    register(WhisperCpp())
