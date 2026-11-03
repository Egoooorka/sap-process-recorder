"""mlx-whisper backend (Apple Silicon). Runs the official CLI in a child process so progress and
cancellation work and a crash cannot take the helper down."""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
import tempfile
from typing import Dict, Tuple

from .. import models
from . import register
from .base import ASRBackend, BackendError, Request
from ._proc import run_streaming

# "[00:03.120 --> 00:07.480]  text"  or  "[01:00:03.120 --> ...]"
SEG_RE = re.compile(r"^\[(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*-->\s*(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\]")


def parse_segment_end(line: str):
    """Return the end time in seconds of a verbose segment line, or None."""
    m = SEG_RE.match(line)
    if not m:
        return None
    h, mi, s = m.group(4), m.group(5), m.group(6)
    return int(h or 0) * 3600 + int(mi) * 60 + float(s)


def hf_cache_has(repo: str) -> bool:
    root = os.environ.get("HF_HUB_CACHE") or os.path.join(os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface")), "hub")
    snap = os.path.join(root, "models--" + repo.replace("/", "--"), "snapshots")
    if not os.path.isdir(snap):
        return False
    for rev in os.listdir(snap):
        files = os.listdir(os.path.join(snap, rev))
        if "config.json" in files and any(f.startswith("weights.") for f in files):
            return True
    return False


class MlxWhisper(ASRBackend):
    id = "mlx-whisper"
    label = "mlx-whisper (Apple Silicon)"

    def models(self) -> Dict[str, dict]:
        return {k: {"label": v["label"], "ref": v["mlx"]} for k, v in models.CATALOG.items() if "mlx" in v}

    def available(self) -> Tuple[bool, str]:
        import platform
        if platform.machine() != "arm64":
            return False, "needs a native arm64 Python on Apple Silicon"
        if importlib.util.find_spec("mlx_whisper") is None:
            return False, "python package 'mlx-whisper' not installed (pip install mlx-whisper)"
        return True, ""

    def model_installed(self, model: str) -> bool:
        m = self.models().get(model)
        return bool(m) and hf_cache_has(m["ref"])

    def transcribe(self, req: Request, report, cancelled) -> dict:
        m = self.models().get(req.model)
        if not m:
            raise BackendError(f"model '{req.model}' is not available for mlx-whisper")
        ref = m["ref"]
        installed = self.model_installed(req.model)
        report(0.0, "transcribing" if installed else "downloading_model",
               "Loading model…" if installed else f"Downloading {ref} (first run only)…")
        out_dir = tempfile.mkdtemp(prefix="mlx-asr-")
        args = [sys.executable, "-c", "from mlx_whisper.cli import main; main()", req.wav_path,
                "--model", ref, "--task", req.task or "transcribe",
                "--output-format", "json", "--output-dir", out_dir, "--output-name", "out",
                "--verbose", "True",
                "--condition-on-previous-text", "True" if req.condition_on_previous_text else "False"]
        if req.language:
            args += ["--language", req.language]
        if req.prompt:
            args += ["--initial-prompt", req.prompt]

        def on_line(line: str):
            end = parse_segment_end(line)
            if end is not None and req.duration > 0:
                report(min(0.99, end / req.duration), "transcribing", "Transcribing…")
            elif "ownload" in line or "Fetching" in line:
                report(None, "downloading_model", line[:120])

        run_streaming(args, on_line, cancelled)
        path = os.path.join(out_dir, "out.json")
        if not os.path.exists(path):
            raise BackendError("mlx_whisper produced no output file")
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        segs = [{
            "start": float(s["start"]), "end": float(s["end"]), "text": s["text"].strip(),
            "avg_logprob": s.get("avg_logprob"), "no_speech_prob": s.get("no_speech_prob"),
            "compression_ratio": s.get("compression_ratio"),
        } for s in data.get("segments", [])]
        return {"language": data.get("language"), "segments": segs, "model_ref": ref}


def register_default():
    register(MlxWhisper())
