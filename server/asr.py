"""faster-whisper 封装。

设计取舍：
  - 模型全局单例。加载 small 约 3-5 秒、medium 约 15 秒，反复加载不可接受。
  - 转写逐段回调。上层靠这个回调把增量结果写进任务状态，
    前端才能「边转边出」，而不是等整段音频跑完。
  - 不依赖 ffmpeg。faster-whisper 自带 PyAV，能直接解码 B站 的 fMP4 音轨，
    少一个外部依赖就少一类环境问题。
"""
from __future__ import annotations

import os
import re
import threading
import time
from pathlib import Path
from typing import Callable

import numpy as np

from audio_util import load_pcm_16k

# 必须在 import huggingface_hub 之前设置，否则不生效。
# 国内直连 huggingface.co 基本拿不到模型，卡在「加载模型…」直到超时，
# 这是 faster-whisper 在国内最容易踩的坑。镜像可在 config.json 覆盖。
try:  # 配置优先，读不到就用内置默认
    import config as _config

    _ep = (_config.load() or {}).get("hf_endpoint")
    if _ep:
        os.environ.setdefault("HF_ENDPOINT", _ep)
except Exception:  # noqa: BLE001 - 配置文件损坏也不能挡住启动
    pass

os.environ.setdefault("HF_ENDPOINT", os.environ.get("BZ_HF_ENDPOINT", "https://hf-mirror.com"))
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
# huggingface-hub 2.x 默认走 Xet 传输（cas-server.xethub.hf.co），
# 国内镜像不代理这条通道，会直接 401。必须关掉退回普通 HTTPS 下载。
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
# 默认超时 10s，镜像慢一点就断，下到一半重来回非常折磨
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "60")
# Windows 默认不支持符号链接，hf 会刷一屏 UserWarning，初次使用的人会以为出错了
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

_state = {
    "model": None,
    "key": None,
    "error": None,
}
_load_lock = threading.Lock()

DEFAULT_DEVICE = os.environ.get("BZ_ASR_DEVICE", "cpu")
DEFAULT_COMPUTE = os.environ.get("BZ_ASR_COMPUTE", "int8")

# 中文场景不给引导时，模型容易输出繁体、且标点稀疏。这句是最小有效引导。
ZH_PROMPT = "以下是普通话的句子，使用简体中文和标准标点。"


def local_model_dir(model_name: str) -> str | None:
    """拿本地已缓存的模型目录。命中就完全离线，不再联网校验。

    不用 snapshot_download(local_files_only=True) 判断：hub 2.x 要求 snapshot
    完整，缺 README.md / .gitattributes 这类无关文件就抛 IncompleteSnapshotError，
    而 faster-whisper 下载时本来就只取必要文件。所以直接看 model.bin 在不在。
    """
    if os.path.isdir(model_name):
        return model_name

    try:
        from huggingface_hub.constants import HF_HUB_CACHE  # 延迟导入
    except Exception:  # noqa: BLE001 - 没装 hub 时按未缓存处理
        return None

    snapshots = Path(HF_HUB_CACHE) / f"models--Systran--faster-whisper-{model_name}" / "snapshots"
    if not snapshots.is_dir():
        return None

    found = sorted(
        (p for p in snapshots.glob("*/model.bin") if p.stat().st_size > 1_000_000),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return str(found[0].parent) if found else None


def model_cached(model_name: str) -> bool:
    """判断模型是否已在本地，用于区分「首次加载要下载」和「正常加载」。"""
    return local_model_dir(model_name) is not None


def download_model(model_name: str) -> str:
    """只在本地没有时才联网下载，失败重试三次。"""
    from huggingface_hub import snapshot_download  # 延迟导入

    last: Exception | None = None
    for attempt in range(3):
        try:
            return snapshot_download(
                repo_id=f"Systran/faster-whisper-{model_name}",
                max_workers=4,
            )
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(
        f"模型下载失败（已试 3 次）：{last}。"
        f"可检查网络，或手动放到 {os.environ.get('HF_ENDPOINT')} 可达的位置"
    )


def available() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception as exc:  # noqa: BLE001
        _state["error"] = f"faster-whisper 未安装：{exc}"
        return False


def loaded_model_name() -> str:
    return _state["key"] or ""


def _get_model(model_name: str, device: str, compute_type: str):
    key = f"{model_name}|{device}|{compute_type}"
    if _state["model"] is not None and _state["key"] == key:
        return _state["model"]

    with _load_lock:
        if _state["model"] is not None and _state["key"] == key:
            return _state["model"]

        from faster_whisper import WhisperModel  # 延迟导入，未安装时服务仍可启动

        path = local_model_dir(model_name) or download_model(model_name)
        model = WhisperModel(path, device=device, compute_type=compute_type)
        _state["model"] = model
        _state["key"] = key
        _state["error"] = None
        return model


# Whisper 在无人声段落上的固定幻觉。关闭 VAD 后这类段会变多，必须过滤。
HALLUCINATIONS = (
    "谢谢观看", "谢谢大家", "感谢观看", "感谢收看", "请不吝点赞", "请点赞",
    "订阅", "转发", "打赏", "字幕由", "字幕提供", "字幕组", "明镜与点点",
    "下期再见", "未完待续", "中文字幕",
)

# 中文竖排标点混进来是 whisper 的常见输出，统一成全角逗号句号
PUNCT_MAP = str.maketrans({"﹐": "，", "﹑": "、", "﹒": "。", "．": "。", "｡": "。"})

# 中文文本里的半角标点换成全角，观感差别很明显
EN2ZH_PUNCT = str.maketrans({",": "，", "?": "？", "!": "！", ";": "；", ":": "："})

_CJK = re.compile(r"[\u4e00-\u9fff]")


def _normalize(text: str) -> str:
    t = (text or "").translate(PUNCT_MAP).strip()
    if _CJK.search(t):
        t = t.translate(EN2ZH_PUNCT)
    return t


def _is_noise(text: str, start: float, end: float) -> bool:
    """过滤无人声段落产生的假字幕。

    只在「短 + 命中固定模式」时才丢，避免误杀 UP 主正常的口头语与笑声。
    """
    t = text.strip()
    if not t:
        return True

    # 纯标点或纯符号，没有任何字母数字汉字
    if not any(ch.isalnum() for ch in t):
        return True

    span = end - start

    # 单个字符且时间极短，多半是噪声（真说话会持续更久）
    if len(t) <= 1 and span < 0.8:
        return True

    # 纯大写英文单词（CAMERA / MUSIC / THANKS 这类）
    if t.isascii() and t.isupper() and len(t) <= 14 and span < 3.0:
        return True

    # 固定幻觉句式，只在足够短时才判定，避免误杀正常结束语
    if len(t) <= 16 and span < 4.0:
        for h in HALLUCINATIONS:
            if h in t:
                return True

    return False


def transcribe(
    audio_path: str,
    model_name: str = "small",
    duration: float = 0.0,
    device: str | None = None,
    compute_type: str | None = None,
    on_progress: Callable[[list[dict], float], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    on_stage: Callable[[str], None] | None = None,
    vad: bool = False,
    beam_size: int = 1,
    backend: str = "auto",
) -> list[dict]:
    """按 backend 分发到具体实现，返回 [{start, end, text}]。

    backend:
      auto       优先 SenseVoice，装了就用；出错自动退回 whisper（默认）
      sensevoice 强制 SenseVoice，失败直接抛错，便于排查
      whisper    强制 faster-whisper

    vad / beam_size / model_name 只对 whisper 后端有意义。SenseVoice 是
    非自回归模型，没有 beam search，也不吃 external prompt。
    """
    backend = (backend or "auto").strip().lower()

    if backend in ("auto", "sensevoice"):
        try:
            return _run_sensevoice(audio_path, on_progress, should_cancel, on_stage)
        except Exception as exc:  # noqa: BLE001
            if backend == "sensevoice":
                raise
            # auto 模式：SenseVoice 环境没备好（没装包、模型下不下来）时
            # 不能让整个功能不可用，退回 whisper 继续出字幕
            if on_stage:
                on_stage(f"SenseVoice 不可用（{exc}），改用 whisper {model_name}")

    return _run_whisper(
        audio_path,
        model_name=model_name,
        duration=duration,
        device=device,
        compute_type=compute_type,
        on_progress=on_progress,
        should_cancel=should_cancel,
        on_stage=on_stage,
        vad=vad,
        beam_size=beam_size,
    )


def _run_sensevoice(
    audio_path: str,
    on_progress: Callable[[list[dict], float], None] | None,
    should_cancel: Callable[[], bool] | None,
    on_stage: Callable[[str], None] | None,
) -> list[dict]:
    import asr_sensevoice  # 延迟导入：只用 whisper 时不必加载 onnxruntime

    if not asr_sensevoice.available():
        raise RuntimeError(asr_sensevoice._state.get("error") or "sherpa-onnx 未安装")

    if on_stage:
        on_stage("解码音频…")
    samples = load_pcm_16k(audio_path)
    if not len(samples):
        raise RuntimeError("音频解码后为空，无法转写")

    return asr_sensevoice.transcribe(
        samples,
        sample_rate=16000,
        on_progress=on_progress,
        should_cancel=should_cancel,
        on_stage=on_stage,
    )


def _run_whisper(
    audio_path: str,
    model_name: str = "small",
    duration: float = 0.0,
    device: str | None = None,
    compute_type: str | None = None,
    on_progress: Callable[[list[dict], float], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    on_stage: Callable[[str], None] | None = None,
    vad: bool = False,
    beam_size: int = 1,
) -> list[dict]:
    """faster-whisper 实现。

    vad 默认关闭。实测 silero VAD（onnxruntime 后端）在本机把 176s 音频里的
    168s 判成静音，只吐出开头一句——开着等于功能报废。改用「关闭 VAD +
    幻觉过滤」，宁可多跑几秒也不能丢字幕。
    """
    device = device or DEFAULT_DEVICE
    compute_type = compute_type or DEFAULT_COMPUTE

    if on_stage:
        if model_cached(model_name):
            on_stage(f"加载模型 {model_name}…")
        else:
            on_stage(f"首次使用：正在下载 {model_name} 模型（约 480MB），1~3 分钟…")

    model = _get_model(model_name, device, compute_type)

    kwargs = {}
    if vad:
        kwargs["vad_filter"] = True
        kwargs["vad_parameters"] = {"min_silence_duration_ms": 500}

    # 显式解成 16k 单声道再喂模型，省掉 whisper 内部的重采样。
    # 传 ndarray 时 info.duration 仍按采样数算，进度计算不受影响。
    if isinstance(audio_path, np.ndarray):
        samples = audio_path
    else:
        if on_stage:
            on_stage("解码音频…")
        samples = load_pcm_16k(audio_path)

    segments, info = model.transcribe(
        samples,
        language="zh",
        task="transcribe",
        beam_size=max(1, int(beam_size)),
        condition_on_previous_text=False,
        word_timestamps=False,
        initial_prompt=ZH_PROMPT,
        **kwargs,
    )

    total = duration or getattr(info, "duration", 0) or 0
    out: list[dict] = []
    last_push = 0.0
    last_count = 0

    for seg in segments:
        if should_cancel and should_cancel():
            break

        start = float(seg.start)
        end = float(seg.end)
        text = _normalize(seg.text)

        if not _is_noise(text, start, end):
            out.append(
                {
                    "start": round(start, 2),
                    "end": round(end, 2),
                    "text": text,
                }
            )

        # 控制推送频率：每 800ms 或新增 15 句推一次，避免任务状态被高频写入
        if on_progress and out and (len(out) - last_count >= 15 or end - last_push >= 0.8):
            progress = min(0.99, end / total) if total else 0.0
            on_progress(list(out), progress)
            last_push = end
            last_count = len(out)

    if on_progress and out:
        on_progress(list(out), 1.0)

    return out
