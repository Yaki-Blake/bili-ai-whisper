"""音频解码：统一转成 16kHz 单声道 float32。

为什么单独抽一层：
  - 两条后端对输入的要求不同。whisper 接受文件路径，内部自己重采样到 16k；
    SenseVoice（sherpa-onnx）只接受 float32 的 16k 单声道数组，传错采样率
    不会报错，但识别结果会整体失真。
  - 传文件路径时，「解码 → 重采样 → 混单声道」这段每次都要在模型侧重复一遍。
    在入口显式做掉，两条后端拿到的就是同一份 PCM，也省掉一次重采样。

PyAV 的 resample 在流末尾必须用 resample(None) 把内部缓冲刷出来，
否则最后几十毫秒会丢——听不出来，但可能吃掉半句尾字。
"""
from __future__ import annotations

import numpy as np

SAMPLE_RATE = 16000


def load_pcm_16k(path: str, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """把任意音频文件解成 16k 单声道 float32（取值 -1.0 ~ 1.0）。"""
    import av  # 延迟导入：只用 whisper 后端时不必先加载

    chunks: list[np.ndarray] = []
    with av.open(str(path)) as container:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise RuntimeError("音频文件里没有音轨")
        resampler = av.AudioResampler(format="fltp", layout="mono", rate=sample_rate)
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        try:
            for out in resampler.resample(None):  # 刷出尾部缓冲
                chunks.append(out.to_ndarray().reshape(-1))
        except Exception:  # noqa: BLE001 - 部分 av 版本 flush 返回 None
            pass

    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32, copy=False)


def duration_of(samples: np.ndarray, sample_rate: int = SAMPLE_RATE) -> float:
    return round(len(samples) / float(sample_rate), 2) if len(samples) else 0.0
