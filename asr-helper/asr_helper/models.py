"""Model catalog shared by the built-in backends (ids are backend independent)."""
from __future__ import annotations

DEFAULT_MODEL = "large-v3-turbo"

# id -> label, plus a per-backend reference (HF repo for MLX, ggml file for whisper.cpp)
CATALOG = {
    "large-v3-turbo": {
        "label": "Whisper Large V3 Turbo (default, fast)",
        "mlx": "mlx-community/whisper-large-v3-turbo",
        "cpp": "ggml-large-v3-turbo.bin",
        "cpp_size": 1624555275,
    },
    "large-v3": {
        "label": "Whisper Large V3 (slower, most accurate)",
        "mlx": "mlx-community/whisper-large-v3-mlx",
        "cpp": "ggml-large-v3.bin",
        "cpp_size": 3095033483,
    },
    # Smaller quantised build, useful on older Intel Macs
    "large-v3-turbo-q5_0": {
        "label": "Whisper Large V3 Turbo q5_0 (whisper.cpp only, small)",
        "cpp": "ggml-large-v3-turbo-q5_0.bin",
        "cpp_size": 574041195,
    },
}

WHISPER_CPP_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{file}"
