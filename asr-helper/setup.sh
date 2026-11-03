#!/usr/bin/env bash
# One-time setup of the local ASR helper. Picks the backend from the Mac's CPU:
#   Apple Silicon -> mlx-whisper (pip)           Intel -> whisper.cpp (Homebrew)
# Usage: ./setup.sh [--prefetch] [--large-v3] [--with-cpp]
set -euo pipefail
cd "$(dirname "$0")"

PREFETCH=0; LARGE=0; WITH_CPP=0
for a in "$@"; do case "$a" in --prefetch) PREFETCH=1;; --large-v3) LARGE=1; PREFETCH=1;; --with-cpp) WITH_CPP=1;; esac; done

APPLE=$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)
if [ "$APPLE" = "1" ] && [ "$(uname -m)" != "arm64" ]; then
  echo "Apple Silicon detected but this shell runs under Rosetta; restarting natively…"
  exec arch -arm64 /bin/bash "$0" "$@"
fi
echo "CPU: $(sysctl -n machdep.cpu.brand_string)  (apple_silicon=$APPLE, uname -m=$(uname -m))"

command -v brew >/dev/null || { echo "Homebrew is required: https://brew.sh"; exit 1; }
BREW_PREFIX=$(brew --prefix)

command -v ffmpeg >/dev/null || [ -x "$BREW_PREFIX/bin/ffmpeg" ] || brew install ffmpeg

# A recent Python is needed for mlx (the system Python 3.9 is too old)
PY="$BREW_PREFIX/bin/python3.12"
[ -x "$PY" ] || brew install python@3.12

if [ ! -d .venv ]; then "$PY" -m venv .venv; fi
if [ "$APPLE" = "1" ]; then
  echo "Backend: mlx-whisper (Apple Silicon)"
  .venv/bin/pip install --quiet --upgrade pip
  .venv/bin/pip install --quiet mlx-whisper
  [ "$WITH_CPP" = "1" ] && brew install whisper-cpp
else
  echo "Backend: whisper.cpp (Intel)"
  command -v whisper-cli >/dev/null || brew install whisper-cpp
fi

echo; .venv/bin/python -m asr_helper doctor | head -40

if [ "$PREFETCH" = "1" ]; then
  echo; echo "Downloading model large-v3-turbo (~1.6 GB)…"
  .venv/bin/python -m asr_helper prefetch --model large-v3-turbo
  [ "$LARGE" = "1" ] && { echo "Downloading model large-v3 (~3 GB)…"; .venv/bin/python -m asr_helper prefetch --model large-v3; }
fi
echo; echo "Done. Start the helper with ./run.sh"
