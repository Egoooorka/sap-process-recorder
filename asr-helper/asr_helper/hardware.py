"""Detect the Mac CPU architecture and pick the ASR backend order."""
from __future__ import annotations

import os
import platform
import subprocess


def _sysctl(name: str) -> str:
    try:
        out = subprocess.run(["sysctl", "-n", name], capture_output=True, text=True, timeout=5)
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def detect_hardware() -> dict:
    machine = platform.machine()  # arch of THIS python process (x86_64 under Rosetta)
    arm_capable = _sysctl("hw.optional.arm64") == "1"  # true on Apple Silicon even under Rosetta
    rosetta = _sysctl("sysctl.proc_translated") == "1"
    apple_silicon = arm_capable or machine == "arm64"
    mem = _sysctl("hw.memsize")
    return {
        "system": platform.system(),
        "macos": platform.mac_ver()[0],
        "machine": machine,
        "apple_silicon": apple_silicon,
        "rosetta": rosetta,
        "native_arch": "arm64" if apple_silicon else machine,
        "chip": _sysctl("machdep.cpu.brand_string") or platform.processor(),
        "cpus": os.cpu_count() or 4,
        "ram_gb": round(int(mem) / 1024**3) if mem.isdigit() else None,
        "python": platform.python_version(),
    }


def backend_preference(hw: dict) -> list:
    """Ordered backend ids. MLX needs a *native* arm64 Python (not Rosetta)."""
    if hw.get("apple_silicon") and not hw.get("rosetta") and hw.get("machine") == "arm64":
        return ["mlx-whisper", "whisper.cpp"]
    return ["whisper.cpp"]


def explain_choice(hw: dict) -> str:
    if hw.get("apple_silicon") and hw.get("rosetta"):
        return "Apple Silicon, but this Python runs under Rosetta -> whisper.cpp (use a native arm64 Python for mlx-whisper)."
    if hw.get("apple_silicon"):
        return "Apple Silicon (arm64) -> mlx-whisper preferred, whisper.cpp as fallback."
    return "Intel Mac (x86_64) -> whisper.cpp preferred (MLX requires Apple Silicon)."
