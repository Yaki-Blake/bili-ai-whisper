"""转写入口：统一走 SenseVoice-Small（sherpa-onnx）。

为什么删掉 faster-whisper 兜底（v0.4.1）：
  - 只要装了 sherpa-onnx 就永远走不到 whisper 分支，那条路径是死代码；
  - 它连带把 ctranslate2 / onnxruntime / huggingface-hub / tokenizers / hf-xet
    一起拖进来，约 135MB。其中最讽刺的是 onnxruntime —— SenseVoice 实际用的是
    sherpa_onnx/lib/onnxruntime.dll，跟 pip 那个包毫无关系；
  - 兜底会把「依赖没装好」「模型没下完」变成悄悄降级：界面照常出字幕，
    只是慢十倍，用户根本不知道该修哪里。

现在缺依赖就直接抛错，把原因摆到界面上，比降级可诊断得多。
"""
from __future__ import annotations

from typing import Callable

from audio_util import load_pcm_16k


def available() -> bool:
    """sherpa-onnx 是否可用。不可用时原因写进 asr_sensevoice._state["error"]。"""
    try:
        import asr_sensevoice

        return asr_sensevoice.available()
    except Exception:  # noqa: BLE001 - 导入失败一律按不可用处理
        return False


def unavailable_reason() -> str:
    try:
        import asr_sensevoice

        return asr_sensevoice._state.get("error") or "sherpa-onnx 不可用"
    except Exception as exc:  # noqa: BLE001
        return f"asr_sensevoice 导入失败：{exc}"


def transcribe(
    audio_path: str,
    on_progress: Callable[[list[dict], float], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    on_stage: Callable[[str], None] | None = None,
) -> list[dict]:
    """解码音频并转写，返回 [{start, end, text}]。

    解码统一走 audio_util（PyAV → 16kHz 单声道 float32）：
    SenseVoice 只接受这一种输入，采样率错了不报错但结果会整体失真。
    """
    import asr_sensevoice  # 延迟导入：只在真正转写时加载 onnxruntime

    if not asr_sensevoice.available():
        raise RuntimeError(unavailable_reason())

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
