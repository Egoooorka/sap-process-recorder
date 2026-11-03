"""Backend registry. Third-party engines: drop a .py file into ~/.sap-process-recorder/plugins/
that defines an ASRBackend subclass and calls `register(MyBackend())`."""
from __future__ import annotations

import importlib.util
import os
import sys
from typing import Dict

from .base import ASRBackend

REGISTRY: Dict[str, ASRBackend] = {}


def register(backend: ASRBackend) -> ASRBackend:
    REGISTRY[backend.id] = backend
    return backend


def plugin_dir() -> str:
    return os.path.join(os.path.expanduser("~"), ".sap-process-recorder", "plugins")


def load_all() -> Dict[str, ASRBackend]:
    from . import mlx_whisper, whisper_cpp  # noqa: F401  (import registers them)
    mlx_whisper.register_default()
    whisper_cpp.register_default()
    d = plugin_dir()
    if os.path.isdir(d):
        for name in sorted(os.listdir(d)):
            if not name.endswith(".py"):
                continue
            try:
                spec = importlib.util.spec_from_file_location(f"asr_plugin_{name[:-3]}", os.path.join(d, name))
                mod = importlib.util.module_from_spec(spec)
                sys.modules[spec.name] = mod
                spec.loader.exec_module(mod)
            except Exception as e:  # a broken plugin must not take the helper down
                print(f"[asr-helper] plugin {name} failed to load: {e}", file=sys.stderr)
    return REGISTRY
