"""SenseVoice-Small 后端（sherpa-onnx + ONNX Runtime）。

为什么换到这个后端：
  - 中文识别准确率明显高于 whisper-small，这是专门针对中文训练的模型
  - 自带标点与逆文本归一化（ITN），不必再事后补标点
  - CPU 上快一个数量级。whisper-small int8 实测约 2.4x 实时，
    SenseVoice int8 通常在 20x 以上，字幕能真正跟上播放
  - 模型 228MB，比 whisper-small 的 480MB 还小

需要接受的代价：
  - 只给 token 级时间戳，没有现成的句子边界，必须按标点自己切
  - 单次输入必须 ≤30 秒（训练窗口），长音频要自己切片
  - 输出带 <|zh|><|NEUTRAL|><|Speech|> 这类控制标记，必须清掉

选 sherpa-onnx 而不是 funasr 的原因：funasr 依赖 torch，要多装 250MB；
本机已有 onnxruntime，sherpa-onnx 的 wheel 只有 2MB。
"""
from __future__ import annotations

import os
import re
import threading
import time
from pathlib import Path
from typing import Callable

import numpy as np

import config

MODEL_REPO = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
MODEL_FILES = {
    "model.int8.onnx": 239_233_841,
    "tokens.txt": 315_894,
}

# 单块时长。SenseVoice 训练窗口是 30 秒，但块越长、块内静音越多，
# token 时间戳越容易被拉到块边界（实测 25s 块会把一句 10 秒的话标成 25 秒）。
# 20 秒 + 下面的「静音断句」是实测下来时间轴最稳的折中。
CHUNK_SEC = 20.0
# 两个 token 间隔超过这个秒数，视为说话人停顿，在这里断句。
# 不这么做的话，中间 10 秒 BGM 会被算进上一句的时长里。
GAP_SPLIT_SEC = 2.0
# 末块短于这个秒数就并回前一块，否则容易切出半个字
MIN_TAIL_SEC = 1.2
# 单行字幕最长字数，超过就在最近的停顿处断开
MAX_CHARS = 22
# 完全没有标点时，超过这个长度强制断开
FORCE_BREAK_CHARS = 34

SENT_END = "。？！；…"
SENT_PAUSE = "，、：,;:"

_TAG = re.compile(r"<\|[^|]*\|>")
_SPACE = re.compile(r"\s+")

_state: dict = {"rec": None, "key": None, "error": None}
_lock = threading.Lock()


def available() -> bool:
    try:
        import sherpa_onnx  # noqa: F401
        return True
    except Exception as exc:  # noqa: BLE001
        _state["error"] = f"sherpa-onnx 未安装：{exc}"
        return False


def model_dir() -> Path:
    return config.cache_dir() / "models" / "sensevoice"


def model_ready() -> bool:
    d = model_dir()
    return all((d / n).exists() and (d / n).stat().st_size >= s for n, s in MODEL_FILES.items())


def _endpoint() -> str:
    ep = (config.load() or {}).get("hf_endpoint") or "https://hf-mirror.com"
    return ep.rstrip("/")


def _download_one(url: str, dest: Path, expect: int, on_stage: Callable[[str], None] | None, label: str) -> None:
    """流式下载到 .part，完成后再改名。中断重来不会留下半个文件冒充完整文件。"""
    import requests

    tmp = dest.with_name(dest.name + ".part")
    last_report = -1.0
    with requests.get(
        url,
        stream=True,
        timeout=(15, 90),
        headers={"User-Agent": "bili-ai-whisper/0.4"},
        allow_redirects=True,
    ) as r:
        r.raise_for_status()
        total = int(r.headers.get("Content-Length") or expect)
        done = 0
        with open(tmp, "wb") as fh:
            for block in r.iter_content(chunk_size=512 * 1024):
                if not block:
                    continue
                fh.write(block)
                done += len(block)
                if on_stage and total:
                    pct = done * 100.0 / total
                    if pct - last_report >= 10:
                        last_report = pct
                        on_stage(f"下载 {label} {pct:.0f}%（{done // 1048576}/{total // 1048576} MB）")
    if expect and tmp.stat().st_size < expect * 0.98:
        size = tmp.stat().st_size
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"{label} 下载不完整（{size}/{expect} 字节）")
    tmp.replace(dest)


def ensure_model(on_stage: Callable[[str], None] | None = None) -> Path:
    """首次使用自动拉模型。两个文件，共约 228MB。"""
    d = model_dir()
    d.mkdir(parents=True, exist_ok=True)
    base = f"{_endpoint()}/{MODEL_REPO}/resolve/main"

    missing = [(n, s) for n, s in MODEL_FILES.items() if not ((d / n).exists() and (d / n).stat().st_size >= s)]
    if not missing:
        return d

    if on_stage:
        mb = sum(s for _, s in missing) // 1048576
        on_stage(f"首次使用：下载 SenseVoice 模型（约 {mb}MB）…")

    last: Exception | None = None
    for name, size in missing:
        for attempt in range(3):
            try:
                _download_one(f"{base}/{name}", d / name, size, on_stage, name)
                last = None
                break
            except Exception as exc:  # noqa: BLE001
                last = exc
                time.sleep(1.5 * (attempt + 1))
        if last is not None:
            raise RuntimeError(f"SenseVoice 模型下载失败：{last}。可检查网络或配置 hf_endpoint")
    return d


def _threads() -> int:
    n = os.cpu_count() or 4
    return max(1, min(8, n))


def _get_recognizer(on_stage: Callable[[str], None] | None = None):
    d = ensure_model(on_stage)
    key = str(d)
    if _state["rec"] is not None and _state["key"] == key:
        return _state["rec"]

    with _lock:
        if _state["rec"] is not None and _state["key"] == key:
            return _state["rec"]

        import sherpa_onnx

        if on_stage:
            on_stage("加载 SenseVoice 模型…")
        rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(d / "model.int8.onnx"),
            tokens=str(d / "tokens.txt"),
            num_threads=_threads(),
            sample_rate=16000,
            feature_dim=80,
            decoding_method="greedy_search",
            debug=False,
            provider="cpu",
            # 强制中文。留空是自动语种检测，中文视频偶尔会被判成日文，
            # 结果是满屏假名。
            language="zh",
            # 逆文本归一化：「二零二六年」→「2026年」，「百分之三十」→「30%」
            use_itn=True,
        )
        _state["rec"] = rec
        _state["key"] = key
        _state["error"] = None
        return rec


def _clean(text: str) -> str:
    t = _TAG.sub("", text or "")
    t = t.replace("▁", " ").strip()
    return _SPACE.sub(" ", t).strip()


def _is_hit(tok: str, chars: str) -> bool:
    s = (tok or "").strip()
    return bool(s) and s[-1] in chars


def _has_text(s: str) -> bool:
    """至少含一个汉字或字母数字，用来丢掉「只剩一个句号」这种碎片。"""
    return any(ch.isalnum() or "\u4e00" <= ch <= "\u9fff" for ch in s)


def _parse(result, offset: float, chunk_end: float) -> list[dict]:
    """把一块的 token 流切成句子，时间戳加上块偏移。

    切分依据三档，从严到松：
      1. 句末标点（。？！；…）—— 必定断开
      2. 停顿 ≥ GAP_SPLIT_SEC —— 断开。BGM 空隙不应算进上一句时长
      3. 逗号且已够长、或长到没有标点也得断 —— 防止单行字幕糊成一片
    """
    raw = getattr(result, "text", "") or ""
    tokens = [t for t in (getattr(result, "tokens", None) or []) if t and not _TAG.fullmatch(t)]
    stamps = list(getattr(result, "timestamps", None) or [])

    text_all = _clean(raw)
    if not text_all:
        return []

    # 没有 token 级时间戳时退化：整块作为一句，时间用块边界
    if not tokens or len(tokens) != len(stamps):
        return [{"start": round(offset, 2), "end": round(chunk_end, 2), "text": text_all}]

    segs: list[dict] = []
    buf: list[str] = []
    buf_start: float | None = None
    prev_t: float | None = None

    def flush(end_t: float) -> None:
        nonlocal buf, buf_start
        joined = _clean("".join(buf))
        if joined and _has_text(joined) and buf_start is not None:
            segs.append(
                {
                    "start": round(buf_start, 2),
                    "end": round(max(end_t, buf_start + 0.2), 2),
                    "text": joined,
                }
            )
        buf = []
        buf_start = None

    for i, tok in enumerate(tokens):
        t = float(stamps[i]) + offset

        # 停顿断句：先把上一句收掉，静音部分不并进去
        if buf and prev_t is not None and t - prev_t >= GAP_SPLIT_SEC:
            flush(min(prev_t + 0.4, chunk_end))

        if buf_start is None:
            buf_start = t
        buf.append(tok)
        joined = _clean("".join(buf))

        if not joined:
            prev_t = t
            continue

        hit_end = _is_hit(tok, SENT_END)
        hit_pause = _is_hit(tok, SENT_PAUSE) and len(joined) >= MAX_CHARS
        # 只在标点处强制断，避免把词从中间切开
        too_long = len(joined) >= FORCE_BREAK_CHARS and _is_hit(tok, SENT_PAUSE + SENT_END)
        # 整段没有任何标点（模型漏标）时的兜底
        if not (hit_end or hit_pause or too_long) and len(joined) >= int(FORCE_BREAK_CHARS * 1.8):
            too_long = True

        if hit_end or hit_pause or too_long:
            flush(t + 0.35)

        prev_t = t

    if buf:
        flush(min(chunk_end, (prev_t or chunk_end) + 0.4))

    return segs


def transcribe(
    samples: np.ndarray,
    sample_rate: int = 16000,
    on_progress: Callable[[list[dict], float], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    on_stage: Callable[[str], None] | None = None,
) -> list[dict]:
    """对 16k 单声道 float32 做分块识别，逐块回调增量。"""
    rec = _get_recognizer(on_stage)

    if on_stage:
        on_stage("转写中…")

    span = max(1, int(CHUNK_SEC * sample_rate))
    tail_min = int(MIN_TAIL_SEC * sample_rate)
    total = len(samples)
    total_sec = total / float(sample_rate) if total else 0.0

    out: list[dict] = []
    pos = 0
    last_push = 0.0
    last_count = 0

    while pos < total:
        if should_cancel and should_cancel():
            break

        end = min(pos + span, total)
        # 末块太短就并进来，避免切出半个字（但不超过 32 秒，否则超出模型窗口）
        if total - end < tail_min and (end - pos) < int(30 * sample_rate):
            end = total

        chunk = samples[pos:end]
        offset = pos / float(sample_rate)
        chunk_end = end / float(sample_rate)

        try:
            stream = rec.create_stream()
            stream.accept_waveform(sample_rate, chunk)
            rec.decode_stream(stream)
            segs = _parse(stream.result, offset, chunk_end)
        except Exception as exc:  # noqa: BLE001 - 单块失败不该让整片失败
            segs = []
            if on_stage:
                on_stage(f"第 {offset:.0f}s 处识别失败：{exc}")

        for s in segs:
            # 模型偶尔会把同一句连说两遍，相邻完全重复的直接丢
            if out and s["text"] == out[-1]["text"] and s["start"] - out[-1]["end"] < 1.0:
                continue
            out.append(s)

        pos = end

        if on_progress and out and (len(out) - last_count >= 15 or chunk_end - last_push >= 0.8):
            # chunk_end 是绝对秒数，必须除以总时长才是 0~1 的进度
            on_progress(list(out), min(0.99, chunk_end / total_sec) if total_sec else 0.0)
            last_push = chunk_end
            last_count = len(out)

    if on_progress and out:
        on_progress(list(out), 1.0)

    return out
