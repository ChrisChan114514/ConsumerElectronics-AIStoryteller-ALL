"""Build and verify the split Kokoro TensorRT FP16 sessions."""

from __future__ import annotations

import argparse
import json
import os
import resource
import sys
import sysconfig
import time
from collections import Counter
from pathlib import Path

import numpy as np


def ensure_runtime_library_path() -> None:
    if os.environ.get("KOKORO_TRT_LIBRARY_PATH_READY") == "1":
        return
    site_packages = Path(sysconfig.get_paths()["purelib"])
    directories = [
        site_packages / "onnxruntime" / "capi",
        site_packages / "tensorrt_libs",
        site_packages / "nvidia" / "cublas" / "lib",
        site_packages / "nvidia" / "cuda_runtime" / "lib",
        site_packages / "nvidia" / "cudnn" / "lib",
    ]
    values = [str(path) for path in directories if path.is_dir()]
    if os.environ.get("LD_LIBRARY_PATH"):
        values.append(os.environ["LD_LIBRARY_PATH"])
    environment = os.environ.copy()
    environment["LD_LIBRARY_PATH"] = ":".join(values)
    environment["KOKORO_TRT_LIBRARY_PATH_READY"] = "1"
    os.execve(sys.executable, [sys.executable, *sys.argv], environment)


ensure_runtime_library_path()

import onnxruntime as ort  # noqa: E402
import tensorrt  # noqa: E402


ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / "models" / "split"
CACHE = ROOT / "trt_cache" / "split_stable_fp16"
FRONTEND = MODEL_DIR / "kokoro-frontend.onnx"
DECODER = MODEL_DIR / "kokoro-decoder.onnx"


def options(component: str) -> dict[str, object]:
    cache = CACHE / component
    cache.mkdir(parents=True, exist_ok=True)
    common: dict[str, object] = {
        "device_id": 0,
        "trt_fp16_enable": True,
        "trt_int8_enable": False,
        "trt_max_workspace_size": 536870912,
        "trt_builder_optimization_level": 1,
        "trt_min_subgraph_size": 5,
        "trt_engine_cache_enable": True,
        "trt_engine_cache_path": str(cache),
        "trt_timing_cache_enable": True,
        "trt_timing_cache_path": str(cache / "timing.cache"),
    }
    if component == "frontend":
        common.update(
            {
                "trt_profile_min_shapes": "input_ids:1x2,style:1x256,speed:1",
                "trt_profile_opt_shapes": "input_ids:1x128,style:1x256,speed:1",
                "trt_profile_max_shapes": "input_ids:1x512,style:1x256,speed:1",
            }
        )
    else:
        common.update(
            {
                "trt_op_types_to_exclude": "CumSum,Sin,Exp,Pow,Sqrt,Reciprocal,InstanceNormalization,RandomNormalLike",
            }
        )
    return common


def make_session(path: Path, component: str) -> tuple[ort.InferenceSession, Path]:
    profile_dir = CACHE / component
    session_options = ort.SessionOptions()
    session_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session_options.intra_op_num_threads = 1
    session_options.inter_op_num_threads = 1
    session_options.enable_profiling = True
    session_options.profile_file_prefix = str(profile_dir / "provider_profile")
    session = ort.InferenceSession(
        str(path),
        sess_options=session_options,
        providers=[
            ("TensorrtExecutionProvider", options(component)),
            ("CUDAExecutionProvider", {"device_id": 0}),
            "CPUExecutionProvider",
        ],
    )
    if session.get_providers()[0] != "TensorrtExecutionProvider":
        raise RuntimeError(f"TensorRT not selected for {component}")
    return session, profile_dir


def provider_counts(session: ort.InferenceSession) -> Counter[str]:
    path = Path(session.end_profiling())
    events = json.loads(path.read_text())
    return Counter(
        event.get("args", {}).get("provider")
        for event in events
        if event.get("args", {}).get("provider")
    )


def frontend_inputs() -> dict[str, np.ndarray]:
    return {
        "input_ids": np.array(
            [[0, 50, 83, 54, 156, 57, 135, 16, 65, 87, 54, 46, 4, 0]],
            dtype=np.int64,
        ),
        "style": np.linspace(-0.2, 0.2, 256, dtype=np.float32).reshape(1, 256),
        "speed": np.array([1.0], dtype=np.float32),
    }


def expand(front_values: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
    prosody, text, duration = front_values
    token_indices = np.repeat(np.arange(duration.shape[1]), duration[0])
    alignment = np.eye(duration.shape[1], dtype=np.float32)[token_indices].T[None]
    return np.matmul(prosody.transpose(0, 2, 1), alignment), np.matmul(text, alignment)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--component", choices=("frontend", "decoder", "all"), default="frontend"
    )
    parser.add_argument(
        "--experimental-full-trt",
        action="store_true",
        help="allow the unstable, high-RAM TensorRT decoder experiment",
    )
    args = parser.parse_args()
    if args.component in {"decoder", "all"} and not args.experimental_full_trt:
        raise SystemExit(
            "Decoder TensorRT FP16 is experimental and can consume about 9 GiB RAM. "
            "Use the default frontend check, or explicitly add "
            "--experimental-full-trt after reading README.md."
        )
    print(f"onnxruntime={ort.__version__} tensorrt={tensorrt.__version__}")
    print(f"available_providers={ort.get_available_providers()}")
    for path in (FRONTEND, DECODER):
        if not path.exists():
            raise SystemExit(f"Missing {path}; run export_tensorrt_models.py")
    ort.preload_dlls(cuda=True, cudnn=True)

    values: list[np.ndarray]
    if args.component in {"frontend", "all"}:
        started = time.perf_counter()
        frontend, _ = make_session(FRONTEND, "frontend")
        values = frontend.run(None, frontend_inputs())
        counts = provider_counts(frontend)
        print(f"frontend_provider_nodes={dict(counts)}")
        print(f"frontend_s={time.perf_counter() - started:.3f}")
        if counts["TensorrtExecutionProvider"] == 0:
            raise SystemExit("Frontend executed no TensorRT nodes")
    else:
        frontend = ort.InferenceSession(
            str(FRONTEND), providers=["CPUExecutionProvider"]
        )
        values = frontend.run(None, frontend_inputs())

    if args.component in {"decoder", "all"}:
        prosody_frames, text_frames = expand(values)
        frames = prosody_frames.shape[2]
        started = time.perf_counter()
        decoder, _ = make_session(DECODER, "decoder")
        waveform = decoder.run(
            None,
            {
                "prosody_frames": prosody_frames,
                "text_frames": text_frames,
                "style": frontend_inputs()["style"],
            },
        )[0]
        counts = provider_counts(decoder)
        print(f"decoder_provider_nodes={dict(counts)}")
        print(
            f"decoder_s={time.perf_counter() - started:.3f} frames={frames} "
            f"samples={len(waveform)} peak_rss_mib="
            f"{resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024:.1f}"
        )
        if len(waveform) != frames * 600 or not np.isfinite(waveform).all():
            raise SystemExit("Decoder produced invalid waveform")
        if counts["TensorrtExecutionProvider"] == 0:
            raise SystemExit("Decoder executed no TensorRT nodes")
    print(f"Split TensorRT FP16 {args.component} verified successfully")


if __name__ == "__main__":
    main()
