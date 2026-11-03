"""Run a child process, stream its merged output line by line, support cancellation."""
from __future__ import annotations

import os
import subprocess
import threading
import time
from collections import deque
from typing import Callable, Deque, Iterable, Optional

from .base import BackendError, Cancelled


def run_streaming(cmd: Iterable[str], on_line: Callable[[str], None], cancelled: Callable[[], bool],
                  env: Optional[dict] = None) -> str:
    """Returns the tail of the output. Raises Cancelled / BackendError."""
    e = dict(os.environ)
    e["PYTHONUNBUFFERED"] = "1"
    if env:
        e.update(env)
    proc = subprocess.Popen(list(cmd), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=e,
                            stdin=subprocess.DEVNULL, bufsize=0)
    tail: Deque[str] = deque(maxlen=40)

    def pump():
        buf = b""
        while True:
            chunk = proc.stdout.read(1024)
            if not chunk:
                break
            buf += chunk
            # tqdm and whisper.cpp use \r for progress updates
            parts = buf.replace(b"\r", b"\n").split(b"\n")
            buf = parts.pop()
            for p in parts:
                line = p.decode("utf-8", "replace").strip()
                if line:
                    tail.append(line)
                    try:
                        on_line(line)
                    except Exception:
                        pass
        if buf.strip():
            tail.append(buf.decode("utf-8", "replace").strip())

    t = threading.Thread(target=pump, daemon=True)
    t.start()
    while proc.poll() is None:
        if cancelled():
            proc.terminate()
            try:
                proc.wait(5)
            except subprocess.TimeoutExpired:
                proc.kill()
            raise Cancelled()
        time.sleep(0.2)
    t.join(5)
    if proc.returncode != 0:
        raise BackendError("process exited with code %s: %s" % (proc.returncode, " | ".join(list(tail)[-6:])))
    return "\n".join(tail)
