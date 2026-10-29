"""配置读写。密钥只落在本机 server/config.json，不进扩展、不进浏览器存储。"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"

DEFAULTS = {
    # 只剩 SenseVoice 一个后端。原来的 backend / default_model / vad / beam_size
    # 都是给 faster-whisper 用的，v0.4.1 随兜底链一起移除，留着只会误导。
    "device": "cpu",
    "compute_type": "int8",
    "port": 8765,
    # huggingface 镜像，国内直连 huggingface.co 基本下不动模型
    "hf_endpoint": "https://hf-mirror.com",
}

_lock = threading.Lock()


def cache_dir() -> Path:
    root = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/.cache")
    d = Path(root) / "bili-ai-whisper" / "cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _merge(base: dict, patch: dict) -> dict:
    out = dict(base)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = {**out[k], **v}
        else:
            out[k] = v
    return out


def load() -> dict:
    with _lock:
        if not CONFIG_PATH.exists():
            return json.loads(json.dumps(DEFAULTS))
        try:
            data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return json.loads(json.dumps(DEFAULTS))
        return _merge(json.loads(json.dumps(DEFAULTS)), data)


def save(patch: dict) -> dict:
    with _lock:
        current = load()
        merged = _merge(current, patch)
        CONFIG_PATH.write_text(
            json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return merged
