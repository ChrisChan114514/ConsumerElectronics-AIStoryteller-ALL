"""Runtime adapter joining the TensorRT Kokoro frontend and decoder."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import onnxruntime as ort


ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / "models" / "split"
CACHE = ROOT / "trt_cache" / "split_stable_fp16"
MAX_FRAMES = 512
DECODER_PROVIDER = os.getenv("KOKORO_DECODER_PROVIDER", "cuda").lower()
SENSITIVE_DECODER_OPS = (
    "CumSum,Sin,Exp,Pow,Sqrt,Reciprocal,InstanceNormalization,RandomNormalLike"
)


def provider_options(component: str) -> dict[str, object]:
    cache = CACHE / component
    cache.mkdir(parents=True, exist_ok=True)
    options: dict[str, object] = {
        "device_id": int(os.getenv("CUDA_DEVICE_ID", "0")),
        "trt_fp16_enable": True,
        "trt_int8_enable": False,
        "trt_max_workspace_size": int(
            os.getenv("TRT_MAX_WORKSPACE_SIZE", "536870912")
        ),
        "trt_builder_optimization_level": int(
            os.getenv("TRT_BUILDER_OPT_LEVEL", "1")
        ),
        "trt_min_subgraph_size": int(os.getenv("TRT_MIN_SUBGRAPH_SIZE", "5")),
        "trt_engine_cache_enable": True,
        "trt_engine_cache_path": str(cache),
        "trt_timing_cache_enable": True,
        "trt_timing_cache_path": str(cache / "timing.cache"),
    }
    if component == "frontend":
        options.update(
            {
                "trt_profile_min_shapes": "input_ids:1x2,style:1x256,speed:1",
                "trt_profile_opt_shapes": "input_ids:1x128,style:1x256,speed:1",
                "trt_profile_max_shapes": "input_ids:1x512,style:1x256,speed:1",
            }
        )
    else:
        options.update(
            {
                "trt_op_types_to_exclude": SENSITIVE_DECODER_OPS,
            }
        )
    return options


def create_session(component: str) -> ort.InferenceSession:
    model = MODEL_DIR / f"kokoro-{component}.onnx"
    if not model.exists():
        raise RuntimeError(f"Missing split model: {model}")
    session_options = ort.SessionOptions()
    session_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session_options.log_severity_level = int(os.getenv("ORT_LOG_SEVERITY", "3"))
    session_options.intra_op_num_threads = 1
    session_options.inter_op_num_threads = 1
    device_id = int(os.getenv("CUDA_DEVICE_ID", "0"))
    cuda = (
        "CUDAExecutionProvider",
        {
            "device_id": device_id,
            "arena_extend_strategy": "kSameAsRequested",
            "cudnn_conv_algo_search": "HEURISTIC",
        },
    )
    use_tensorrt = component == "frontend" or DECODER_PROVIDER == "tensorrt"
    providers = (
        [
            ("TensorrtExecutionProvider", provider_options(component)),
            cuda,
            "CPUExecutionProvider",
        ]
        if use_tensorrt
        else [cuda, "CPUExecutionProvider"]
    )
    session = ort.InferenceSession(
        str(model), sess_options=session_options, providers=providers
    )
    expected = "TensorrtExecutionProvider" if use_tensorrt else "CUDAExecutionProvider"
    if session.get_providers()[0] != expected:
        raise RuntimeError(
            f"{expected} was not selected for {component}: {session.get_providers()}"
        )
    return session


@dataclass(frozen=True)
class OutputInfo:
    name: str
    type: str


class SplitSession:
    """Minimal InferenceSession interface consumed by kokoro-onnx."""

    def __init__(self) -> None:
        if DECODER_PROVIDER not in {"cuda", "tensorrt"}:
            raise ValueError(
                "KOKORO_DECODER_PROVIDER must be 'cuda' or 'tensorrt', got "
                f"{DECODER_PROVIDER!r}"
            )
        ort.preload_dlls(cuda=True, cudnn=True)
        self._model_path = str(MODEL_DIR / "kokoro-frontend.fp16.onnx")
        self.frontend = create_session("frontend")
        self.decoder = create_session("decoder")
        self.runtime_mode = (
            "tensorrt-fp16" if DECODER_PROVIDER == "tensorrt" else "hybrid-trt-cuda"
        )
        self.max_observed_frames = 0
        self.last_wave_peak = 0.0
        self.last_wave_rms = 0.0

    def get_inputs(self):
        return self.frontend.get_inputs()

    def get_outputs(self):
        return [OutputInfo("waveform", "tensor(float)"), OutputInfo("duration", "tensor(int64)")]

    def get_modelmeta(self):
        return self.frontend.get_modelmeta()

    def get_providers(self) -> list[str]:
        return self.frontend.get_providers()

    @property
    def component_providers(self) -> dict[str, str]:
        return {
            "frontend": self.frontend.get_providers()[0],
            "decoder": self.decoder.get_providers()[0],
        }

    def run(
        self, output_names: list[str] | None, inputs: dict[str, np.ndarray]
    ) -> list[np.ndarray]:
        prosody, text, duration = self.frontend.run(None, inputs)
        frames = int(duration.sum())
        self.max_observed_frames = max(self.max_observed_frames, frames)
        if frames < 8:
            raise ValueError(f"Predicted only {frames} frames; minimum is 8")
        if frames > MAX_FRAMES:
            raise ValueError(
                f"Predicted {frames} frames, exceeding TensorRT profile maximum "
                f"{MAX_FRAMES}; split the input into a shorter batch"
            )

        token_indices = np.repeat(np.arange(duration.shape[1]), duration[0])
        alignment = np.eye(duration.shape[1], dtype=np.float32)[token_indices]
        alignment = np.ascontiguousarray(alignment.T[None])
        prosody_frames = np.ascontiguousarray(
            np.matmul(prosody.transpose(0, 2, 1), alignment), dtype=np.float32
        )
        text_frames = np.ascontiguousarray(
            np.matmul(text, alignment), dtype=np.float32
        )
        waveform = self.decoder.run(
            None,
            {
                "prosody_frames": prosody_frames,
                "text_frames": text_frames,
                "style": np.asarray(inputs["style"], dtype=np.float32),
            },
        )[0]
        if not np.isfinite(waveform).all():
            raise RuntimeError(
                f"TensorRT decoder produced non-finite samples for {frames} frames"
            )
        waveform64 = waveform.astype(np.float64, copy=False)
        self.last_wave_peak = float(np.max(np.abs(waveform64)))
        self.last_wave_rms = float(np.sqrt(np.mean(waveform64 * waveform64)))
        return [waveform, duration]
