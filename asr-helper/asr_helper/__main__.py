from __future__ import annotations

import argparse
import json
import sys
import time

from . import hardware
from .backends import REGISTRY, load_all
from .jobs import JobManager, choose_backend
from .server import health, serve


def main(argv=None):
    ap = argparse.ArgumentParser(prog="asr_helper", description="Local ASR helper for SAP Process Recorder")
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("serve", help="run the HTTP helper (default)")
    s.add_argument("--port", type=int, default=8765)
    s.add_argument("--extension-id", default="", help="accept requests only from this extension id")
    sub.add_parser("doctor", help="print hardware detection and backend status")
    t = sub.add_parser("transcribe", help="transcribe a local audio file (no extension needed)")
    t.add_argument("file")
    t.add_argument("--language", default="ru", help="ru | en | auto")
    t.add_argument("--model", default="large-v3-turbo")
    t.add_argument("--backend", default="auto")
    t.add_argument("--prompt", default="")
    sub.add_parser("prefetch", help="download the default model for the chosen backend").add_argument("--model", default="large-v3-turbo")
    args = ap.parse_args(argv)
    cmd = args.cmd or "serve"
    if cmd == "serve":
        serve(getattr(args, "port", 8765), getattr(args, "extension_id", ""))
        return 0

    load_all()
    mgr = JobManager()
    if cmd == "doctor":
        print(json.dumps(health(mgr), indent=2, ensure_ascii=False))
        return 0
    if cmd == "transcribe":
        import shutil
        job = mgr.create({"language": args.language, "model": args.model, "backend": args.backend, "prompt": args.prompt})
        shutil.copyfile(args.file, job.audio_path)
        mgr.submit(job)
        last = ""
        while job.status not in ("done", "error", "cancelled"):
            line = f"{job.status} {job.progress * 100:5.1f}% {job.message}"
            if line != last:
                print(line, file=sys.stderr)
                last = line
            time.sleep(0.5)
        if job.status != "done":
            print("ERROR:", job.error, file=sys.stderr)
            return 1
        print(json.dumps(job.result, indent=2, ensure_ascii=False))
        return 0
    if cmd == "prefetch":
        bid = choose_backend("auto", mgr.hw)
        be = REGISTRY[bid]
        print(f"backend: {bid}")
        if be.model_installed(args.model):
            print("model already installed")
            return 0
        if bid == "whisper.cpp":
            be._download(args.model, lambda p, s, m: print(m, end="\r"), lambda: False)
        else:  # mlx: let huggingface_hub fetch it
            from huggingface_hub import snapshot_download
            snapshot_download(be.models()[args.model]["ref"])
        print("\nmodel ready")
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
