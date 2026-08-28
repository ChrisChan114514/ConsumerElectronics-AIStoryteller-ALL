"""Verify libraries and optionally build a real TensorRT FP16 session."""

import argparse
import json
import os
import resource
import sys
import sysconfig
import time
from collections import Counter
from pathlib import Path


def _ensure_runtime_library_path() -> None:
    """Restart once so dlopen sees pip-installed ORT, CUDA and TensorRT libs."""
    if os.environ.get("KOKORO_TRT_LIBRARY_PATH_READY") == "1":
        return
    site_packages = Path(sysconfig.get_paths()["purelib"])
    library_dirs = [
        site_packages / "onnxruntime" / "capi",
        site_packages / "tensorrt_libs",
        site_packages / "nvidia" / "cublas" / "lib",
        site_packages / "nvidia" / "cuda_runtime" / "lib",
        site_packages / "nvidia" / "cudnn" / "lib",
    ]
    existing = os.environ.get("LD_LIBRARY_PATH", "")
    values = [str(path) for path in library_dirs if path.is_dir()]
    if existing:
        values.append(existing)
    env = os.environ.copy()
    env["LD_LIBRARY_PATH"] = ":".join(values)
    env["KOKORO_TRT_LIBRARY_PATH_READY"] = "1"
    os.execve(sys.executable, [sys.executable, *sys.argv], env)


_ensure_runtime_library_path()

import onnxruntime as ort  # noqa: E402
import tensorrt  # noqa: E402
import torch  # noqa: E402

from kokoro_onnx import Kokoro  # noqa: E402

ROOT = Path(__file__).resolve().parent
MODEL = ROOT / "models" / "kokoro-v1.0.export-v1.1.fp16.shaped.onnx"
VOICES = ROOT / "voices" / "voices-v1.0.bin"
CACHE = ROOT / "trt_cache"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--build",
        action="store_true",
        help="Create the TensorRT session. This may use substantial RAM on the first run.",
    )
    args = parser.parse_args()
    print(f"torch={torch.__version__} torch_cuda={torch.version.cuda}")
    print(f"onnxruntime={ort.__version__} tensorrt={tensorrt.__version__}")
    print(f"available_providers={ort.get_available_providers()}")
    missing = [str(path) for path in (MODEL, VOICES) if not path.exists()]
    if missing:
        raise SystemExit(f"Missing model assets; run ./download_models.sh: {', '.join(missing)}")
    print(f"model={MODEL} size_mib={MODEL.stat().st_size / 1024 / 1024:.1f}")
    if "TensorrtExecutionProvider" not in ort.get_available_providers():
        raise SystemExit("TensorrtExecutionProvider is unavailable")
    if not args.build:
        print("Preflight passed. Run provider_check.py --build to build the first FP16 engine.")
        return

    try:
        ort.preload_dlls(cuda=True, cudnn=True)
    except Exception as exc:
        print(f"preload_dlls warning: {exc}")
    CACHE.mkdir(exist_ok=True)
    session_options = ort.SessionOptions()
    session_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session_options.intra_op_num_threads = 1
    session_options.inter_op_num_threads = 1
    session_options.enable_profiling = True
    session_options.profile_file_prefix = str(CACHE / "provider_profile")
    trt_options = {
        "device_id": 0,
        "trt_fp16_enable": True,
        "trt_int8_enable": False,
        "trt_max_workspace_size": 536870912,
        "trt_builder_optimization_level": 1,
        "trt_min_subgraph_size": 5,
        "trt_op_types_to_exclude": "Loop,SequenceEmpty,SequenceInsert,SequenceAt,ConcatFromSequence,SplitToSequence,Expand",
        "trt_profile_min_shapes": "input_ids:1x2,style:1x256,speed:1,/SequenceAt_output_0:1,/SequenceAt_1_output_0:1",
        "trt_profile_opt_shapes": "input_ids:1x256,style:1x256,speed:1,/SequenceAt_output_0:1,/SequenceAt_1_output_0:1",
        "trt_profile_max_shapes": "input_ids:1x510,style:1x256,speed:1,/SequenceAt_output_0:1,/SequenceAt_1_output_0:1",
        "trt_engine_cache_enable": True,
        "trt_engine_cache_path": str(CACHE),
        "trt_timing_cache_enable": True,
        "trt_timing_cache_path": str(CACHE / "timing.cache"),
    }
    session = ort.InferenceSession(
        str(MODEL),
        sess_options=session_options,
        providers=[
            ("TensorrtExecutionProvider", trt_options),
            ("CUDAExecutionProvider", {"device_id": 0}),
            "CPUExecutionProvider",
        ],
    )
    actual = session.get_providers()
    print(f"session_providers={actual}")
    if not actual or actual[0] != "TensorrtExecutionProvider":
        raise SystemExit("TensorRT was not selected; inspect the errors above")
    tts = Kokoro.from_session(session, str(VOICES))
    started = time.perf_counter()
    audio, sample_rate = tts.create(
        "Once upon a time, a little star found its way home.",
        voice="af_heart",
        speed=1.0,
        lang="en-us",
        trim=True,
    )
    elapsed = time.perf_counter() - started
    profile_path = Path(session.end_profiling())
    events = json.loads(profile_path.read_text())
    provider_counts = Counter(
        event.get("args", {}).get("provider")
        for event in events
        if event.get("args", {}).get("provider")
    )
    print(f"executed_provider_nodes={dict(provider_counts)}")
    print(
        f"inference_s={elapsed:.3f} audio_s={len(audio) / sample_rate:.3f} "
        f"peak_rss_mib={resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024:.1f}"
    )
    if provider_counts["TensorrtExecutionProvider"] == 0:
        raise SystemExit("No profiled node executed on TensorRT; do not benchmark this as TensorRT")
    print("TensorRT FP16 inference verified successfully")


if __name__ == "__main__":
    main()
