"""Backend plug-in interface. To add an ASR engine, subclass ASRBackend and call register()."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, Optional, Tuple


class Cancelled(Exception):
    pass


class BackendError(RuntimeError):
    pass


@dataclass
class Request:
    wav_path: str                      # 16 kHz mono PCM WAV prepared by the helper
    duration: float                    # seconds
    model: str                         # catalog id, e.g. "large-v3-turbo"
    language: Optional[str] = None     # "ru", "en" or None = auto-detect
    task: str = "transcribe"           # NEVER "translate" – the original language is preserved
    prompt: str = ""                   # optional vocabulary hint (initial prompt)
    condition_on_previous_text: bool = False
    threads: int = 4
    extra: dict = field(default_factory=dict)


# report(progress 0..1 or None, status, message)
Report = Callable[[Optional[float], str, str], None]


class ASRBackend:
    id = ""
    label = ""

    def models(self) -> Dict[str, dict]:
        """catalog id -> {"label": str, "ref": backend specific reference}"""
        raise NotImplementedError

    def available(self) -> Tuple[bool, str]:
        """(usable, reason when not usable)"""
        raise NotImplementedError

    def model_installed(self, model: str) -> bool:
        raise NotImplementedError

    def transcribe(self, req: Request, report: Report, cancelled: Callable[[], bool]) -> dict:
        """Return {"language": str|None, "segments": [{"start","end","text",...}], "model_ref": str}.
        Must raise Cancelled when cancelled() becomes true and BackendError for failures."""
        raise NotImplementedError
