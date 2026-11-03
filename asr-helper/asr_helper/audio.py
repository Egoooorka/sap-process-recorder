"""Audio preparation: WebM/Opus (MediaRecorder) -> 16 kHz mono PCM WAV via ffmpeg."""
from __future__ import annotations

import os
import shutil
import subprocess
import wave

EXTRA_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]


def find_binary(name: str, env_var: str = "") -> str | None:
    if env_var and os.environ.get(env_var):
        return os.environ[env_var]
    found = shutil.which(name)
    if found:
        return found
    for p in EXTRA_PATHS:  # GUI/launchd environments often lack Homebrew in PATH
        cand = os.path.join(p, name)
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return None


def find_ffmpeg() -> str | None:
    return find_binary("ffmpeg", "FFMPEG_BIN")


class ConvertError(RuntimeError):
    pass


def convert_to_wav(src: str, dst: str) -> float:
    """Convert to 16 kHz mono s16 WAV. Returns the duration in seconds (measured from the WAV,
    because MediaRecorder WebM files have no duration header)."""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise ConvertError("ffmpeg not found. Install it with: brew install ffmpeg")
    cmd = [ffmpeg, "-nostdin", "-y", "-loglevel", "error", "-i", src,
           "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", dst]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0 or not os.path.exists(dst):
        raise ConvertError("ffmpeg failed: " + (p.stderr.strip()[-500:] or f"exit {p.returncode}"))
    return wav_duration(dst)


def wav_duration(path: str) -> float:
    with wave.open(path, "rb") as w:
        return w.getnframes() / float(w.getframerate())
