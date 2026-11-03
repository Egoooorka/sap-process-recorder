"""Local HTTP API for the Chrome extension. Binds to 127.0.0.1 only.

Security: shared token (X-ASR-Token), Host header must be loopback (anti DNS-rebinding), and
browser requests must come from a chrome-extension:// origin (optionally one pinned extension id).
"""
from __future__ import annotations

import hmac
import json
import os
import secrets
import shutil
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import VERSION, audio, hardware, models
from .backends import REGISTRY, load_all
from .jobs import DATA_DIR, JobManager, choose_backend

MAX_UPLOAD = 2 * 1024**3


def load_token() -> str:
    d = os.environ.get("ASR_DATA_DIR", DATA_DIR)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, "token")
    if os.path.exists(path):
        return open(path).read().strip()
    tok = secrets.token_urlsafe(24)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(tok)
    return tok


def health(manager: JobManager) -> dict:
    hw = manager.hw
    backends = []
    for b in REGISTRY.values():
        ok, why = b.available()
        backends.append({
            "id": b.id, "label": b.label, "available": ok, "reason": why,
            "models": [{"id": mid, "label": m["label"], "installed": bool(ok and b.model_installed(mid))}
                       for mid, m in b.models().items()],
        })
    try:
        recommended = choose_backend("auto", hw)
    except Exception:
        recommended = None
    return {
        "ok": True, "version": VERSION, "hardware": hw,
        "choice_reason": hardware.explain_choice(hw),
        "recommended_backend": recommended, "default_model": models.DEFAULT_MODEL,
        "ffmpeg": bool(audio.find_ffmpeg()), "backends": backends,
    }


def make_handler(manager: JobManager, token: str, port: int, extension_id: str = ""):
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "SapAsrHelper/" + VERSION

        def log_message(self, fmt, *args):  # quiet
            pass

        # ---- helpers ----
        def _origin_ok(self) -> bool:
            origin = self.headers.get("Origin")
            if not origin:
                return True  # curl / scripts (still need the token)
            if not origin.startswith("chrome-extension://"):
                return False
            return not extension_id or origin == f"chrome-extension://{extension_id}"

        def _cors(self):
            origin = self.headers.get("Origin")
            if origin and self._origin_ok():
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Headers", "X-ASR-Token, X-ASR-Prompt-B64, Content-Type")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")

        def _json(self, code: int, obj):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)

        def _guard(self, need_token=True) -> bool:
            if self.headers.get("Host", "") not in allowed_hosts:
                self._json(403, {"error": "bad Host header"})
                return False
            if not self._origin_ok():
                self._json(403, {"error": "origin not allowed"})
                return False
            if need_token and not hmac.compare_digest(self.headers.get("X-ASR-Token", ""), token):
                self._json(401, {"error": "invalid or missing token (see ~/.sap-process-recorder/token)"})
                return False
            return True

        # ---- routes ----
        def do_OPTIONS(self):
            if not self._guard(need_token=False):
                return
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            if not self._guard():
                return
            path = urlparse(self.path).path
            if path == "/health":
                return self._json(200, health(manager))
            if path.startswith("/jobs/"):
                job = manager.get(path.split("/")[2])
                if not job:
                    return self._json(404, {"error": "unknown job"})
                return self._json(200, job.public())
            self._json(404, {"error": "not found"})

        def do_DELETE(self):
            if not self._guard():
                return
            path = urlparse(self.path).path
            if path.startswith("/jobs/") and manager.cancel(path.split("/")[2]):
                return self._json(200, {"ok": True})
            self._json(404, {"error": "unknown job"})

        def do_POST(self):
            if not self._guard():
                return
            url = urlparse(self.path)
            if url.path != "/jobs":
                return self._json(404, {"error": "not found"})
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_UPLOAD:
                return self._json(413, {"error": "missing or oversized audio body"})
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            prompt = self.headers.get("X-ASR-Prompt-B64")
            if prompt:
                import base64
                try:
                    q["prompt"] = base64.b64decode(prompt).decode("utf-8")
                except Exception:
                    return self._json(400, {"error": "bad prompt encoding"})
            q["condition_on_previous_text"] = q.get("condition_on_previous_text") == "1"
            job = manager.create(q)
            remaining = length
            with open(job.audio_path, "wb") as f:
                while remaining > 0:
                    chunk = self.rfile.read(min(1 << 20, remaining))
                    if not chunk:
                        break
                    f.write(chunk)
                    remaining -= len(chunk)
            if remaining:
                shutil.rmtree(job.dir, ignore_errors=True)
                return self._json(400, {"error": "upload interrupted"})
            manager.submit(job)
            self._json(202, {"id": job.id})

    return Handler


def serve(port: int = 8765, extension_id: str = ""):
    load_all()
    token = load_token()
    manager = JobManager()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(manager, token, port, extension_id))
    print(f"SAP Process Recorder ASR helper {VERSION} on http://127.0.0.1:{port}")
    print(f"Hardware: {manager.hw['chip']} ({manager.hw['native_arch']}) – {hardware.explain_choice(manager.hw)}")
    print(f"Token (paste into the extension's Speech Recognition settings):\n\n  {token}\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return httpd
