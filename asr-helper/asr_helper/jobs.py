"""Job queue: one transcription at a time (the ASR models use all cores / the GPU)."""
from __future__ import annotations

import json
import os
import queue
import shutil
import threading
import time
import uuid
from typing import Callable, Dict, Optional

from . import VERSION, audio, hardware, models
from .backends import REGISTRY
from .backends.base import BackendError, Cancelled, Request

DATA_DIR = os.path.join(os.path.expanduser("~"), ".sap-process-recorder")
KEEP_DAYS = 7


def jobs_dir() -> str:
    d = os.path.join(os.environ.get("ASR_DATA_DIR", DATA_DIR), "jobs")
    os.makedirs(d, exist_ok=True)
    return d


class Job:
    def __init__(self, params: dict):
        self.id = uuid.uuid4().hex[:12]
        self.params = params
        self.status = "queued"  # queued|converting|downloading_model|transcribing|done|error|cancelled
        self.progress = 0.0
        self.message = "Queued"
        self.error: Optional[str] = None
        self.result: Optional[dict] = None
        self.created = time.time()
        self.cancel = threading.Event()
        self.dir = os.path.join(jobs_dir(), self.id)
        os.makedirs(self.dir, exist_ok=True)
        self.audio_path = os.path.join(self.dir, "input.audio")

    def public(self, with_result: bool = True) -> dict:
        d = {"id": self.id, "status": self.status, "progress": round(self.progress, 4),
             "message": self.message, "error": self.error, "params": self.params}
        if with_result and self.result is not None:
            d["result"] = self.result
        return d


def choose_backend(requested: str, hw: dict) -> str:
    """'auto' -> first available backend in hardware preference order, then any other available one."""
    if requested and requested != "auto":
        if requested not in REGISTRY:
            raise BackendError(f"unknown backend '{requested}'")
        ok, why = REGISTRY[requested].available()
        if not ok:
            raise BackendError(f"backend '{requested}' unavailable: {why}")
        return requested
    order = hardware.backend_preference(hw) + [b for b in REGISTRY if b not in hardware.backend_preference(hw)]
    for bid in order:
        be = REGISTRY.get(bid)
        if be and be.available()[0]:
            return bid
    reasons = "; ".join(f"{b.id}: {b.available()[1]}" for b in REGISTRY.values())
    raise BackendError("no ASR backend is available (" + reasons + ")")


class JobManager:
    def __init__(self, converter: Callable[[str, str], float] = audio.convert_to_wav, hw: Optional[dict] = None):
        self.jobs: Dict[str, Job] = {}
        self.q: "queue.Queue[Job]" = queue.Queue()
        self.converter = converter
        self.hw = hw or hardware.detect_hardware()
        self._cleanup_old()
        threading.Thread(target=self._worker, daemon=True).start()

    def _cleanup_old(self):
        cutoff = time.time() - KEEP_DAYS * 86400
        for name in os.listdir(jobs_dir()):
            p = os.path.join(jobs_dir(), name)
            if os.path.isdir(p) and os.path.getmtime(p) < cutoff:
                shutil.rmtree(p, ignore_errors=True)

    def create(self, params: dict) -> Job:
        job = Job(params)
        self.jobs[job.id] = job
        return job

    def submit(self, job: Job):
        self.q.put(job)

    def get(self, job_id: str) -> Optional[Job]:
        job = self.jobs.get(job_id)
        if job:
            return job
        path = os.path.join(jobs_dir(), job_id, "result.json")  # survives helper restarts
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            j = Job.__new__(Job)
            j.id, j.params, j.status, j.progress = job_id, data.get("params", {}), "done", 1.0
            j.message, j.error, j.result = "Done", None, data
            return j
        return None

    def cancel(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job:
            return False
        job.cancel.set()
        if job.status == "queued":
            job.status, job.message = "cancelled", "Cancelled"
        return True

    # ---- worker ----
    def _set(self, job: Job, status=None, progress=None, message=None):
        if status:
            job.status = status
        if progress is not None:
            job.progress = progress
        if message:
            job.message = message

    def _worker(self):
        while True:
            job = self.q.get()
            if job.status == "cancelled":
                continue
            try:
                self._run(job)
            except Cancelled:
                self._set(job, "cancelled", message="Cancelled")
            except Exception as e:  # report every failure to the UI
                job.error = str(e)
                self._set(job, "error", message="Failed")
            finally:
                for f in ("input.audio", "audio.wav"):
                    try:
                        os.remove(os.path.join(job.dir, f))
                    except OSError:
                        pass

    def _run(self, job: Job):
        p = job.params
        t0 = time.time()
        backend_id = choose_backend(p.get("backend", "auto"), self.hw)
        backend = REGISTRY[backend_id]
        model = p.get("model") or models.DEFAULT_MODEL
        if model not in backend.models():
            raise BackendError(f"model '{model}' is not supported by {backend_id}")

        self._set(job, "converting", 0.0, "Converting audio…")
        wav = os.path.join(job.dir, "audio.wav")
        duration = self.converter(job.audio_path, wav)
        t_conv = time.time()
        if duration < 0.3:
            raise BackendError("the recording contains no audio")

        language = p.get("language")
        if language in (None, "", "auto"):
            language = None
        req = Request(wav_path=wav, duration=duration, model=model, language=language,
                      task="transcribe", prompt=(p.get("prompt") or "")[:900],
                      condition_on_previous_text=bool(p.get("condition_on_previous_text", False)),
                      threads=max(2, min(8, self.hw.get("cpus", 4))))

        def report(progress, status, message):
            self._set(job, status, progress, message)

        res = backend.transcribe(req, report, job.cancel.is_set)
        if job.cancel.is_set():
            raise Cancelled()
        segments = []
        for i, s in enumerate(res["segments"]):
            seg = {k: v for k, v in s.items() if v is not None}
            seg["id"] = i
            seg["text"] = seg["text"].strip()
            segments.append(seg)
        job.result = {
            "helper_version": VERSION,
            "backend": backend_id,
            "model": model,
            "model_ref": res.get("model_ref"),
            "task": "transcribe",
            "language_requested": language or "auto",
            "language_detected": res.get("language"),
            "duration": round(duration, 3),
            "text": " ".join(s["text"] for s in segments),
            "segments": segments,
            "params": {k: v for k, v in p.items() if k != "prompt"},
            "prompt_used": bool(req.prompt),
            "timing": {"convert_s": round(t_conv - t0, 2), "transcribe_s": round(time.time() - t_conv, 2)},
            "hardware": {k: self.hw.get(k) for k in ("chip", "machine", "apple_silicon", "rosetta")},
        }
        with open(os.path.join(job.dir, "result.json"), "w", encoding="utf-8") as f:
            json.dump(job.result, f, ensure_ascii=False)
        self._set(job, "done", 1.0, "Done")
