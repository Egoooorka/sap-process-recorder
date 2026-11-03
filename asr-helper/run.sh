#!/usr/bin/env bash
# Starts the local ASR helper on 127.0.0.1:8765 (Ctrl+C to stop). Extra args: --port N --extension-id ID
cd "$(dirname "$0")"
[ -x .venv/bin/python ] || { echo "Run ./setup.sh first"; exit 1; }
exec .venv/bin/python -m asr_helper serve "$@"
