"""Export Kokoro as TensorRT-friendly frontend and decoder ONNX graphs."""

from __future__ import annotations

import argparse
import json
import sys
import types
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnxruntime.transformers.onnx_model import OnnxModel

from split_model import KokoroDecoder, KokoroFrontend, expand_features


ROOT = Path(__file__).resolve().parent
KOKORO_SOURCE = ROOT / "upstream" / "kokoro-pytorch"
CONFIG_KEY = "kokoro_config"


def load_kmodel(config: Path, checkpoint: Path) -> torch.nn.Module:
    # Loading kokoro normally imports its G2P pipeline and the optional misaki
    # dependency. Export only needs the model package and its relative modules.
    package = types.ModuleType("kokoro")
    package.__path__ = [str(KOKORO_SOURCE / "kokoro")]
    sys.modules["kokoro"] = package
    from kokoro.model import KModel

    model = KModel(
        repo_id="hexgrad/Kokoro-82M",
        config=str(config),
        model=str(checkpoint),
        disable_complex=True,
    ).eval()

    # KModel first attempts unprefixed keys, logs a debug message, then retries
    # after removing the checkpoint's "module." prefix. Reload explicitly and
    # fail on any missing key so an incompatible checkpoint cannot be exported.
    state = torch.load(checkpoint, map_location="cpu", weights_only=True)
    for name, values in state.items():
        normalized = {
            key.removeprefix("module."): value for key, value in values.items()
        }
        incompatible = getattr(model, name).load_state_dict(
            normalized, strict=False
        )
        missing = [
            key
            for key in incompatible.missing_keys
            if not key.endswith((".norm.weight", ".norm.bias"))
            and not key.startswith("generator.stft.")
        ]
        if missing or incompatible.unexpected_keys:
            raise RuntimeError(
                f"Checkpoint mismatch in {name}: "
                f"missing={missing}, "
                f"unexpected={incompatible.unexpected_keys}"
            )
    print("Verified all checkpoint modules and parameters")
    return model


def sample_inputs(kmodel: torch.nn.Module) -> tuple[torch.Tensor, ...]:
    phonemes = "həlˈoʊ wˈɜːld, ðɪs ɪz ɐ tˈɛst."
    ids = [kmodel.vocab[p] for p in phonemes if p in kmodel.vocab]
    input_ids = torch.tensor([[0, *ids, 0]], dtype=torch.long)
    style = torch.linspace(-0.2, 0.2, 256, dtype=torch.float32).reshape(1, 256)
    speed = torch.tensor([1.0], dtype=torch.float32)
    return input_ids, style, speed


def embed_config(path: Path, config: Path) -> None:
    model = onnx.load(str(path), load_external_data=False)
    entry = model.metadata_props.add()
    entry.key = CONFIG_KEY
    entry.value = json.dumps(json.loads(config.read_text(encoding="utf-8")))
    onnx.save(model, str(path))


def set_tensor_shape(value: onnx.ValueInfoProto, dimensions: list[int | str]) -> None:
    shape = value.type.tensor_type.shape
    shape.ClearField("dim")
    for dimension in dimensions:
        dim = shape.dim.add()
        if isinstance(dimension, int):
            dim.dim_value = dimension
        else:
            dim.dim_param = dimension


def fix_boundary_shapes(frontend: Path, decoder: Path) -> None:
    front_model = onnx.load(str(frontend), load_external_data=False)
    front_shapes = {
        "prosody": [1, "tokens", 640],
        "text": [1, 512, "tokens"],
        "duration": [1, "tokens"],
    }
    for output in front_model.graph.output:
        set_tensor_shape(output, front_shapes[output.name])
    onnx.save(front_model, str(frontend))

    decoder_model = onnx.load(str(decoder), load_external_data=False)
    decoder_shapes = {
        "prosody_frames": [1, 640, "frames"],
        "text_frames": [1, 512, "frames"],
        "style": [1, 256],
    }
    for input_value in decoder_model.graph.input:
        set_tensor_shape(input_value, decoder_shapes[input_value.name])
    set_tensor_shape(decoder_model.graph.output[0], ["samples"])
    onnx.save(decoder_model, str(decoder))


def to_fp16(source: Path, target: Path) -> None:
    model = OnnxModel(onnx.load(str(source), load_external_data=False))
    model.convert_float_to_float16(
        keep_io_types=True, use_symbolic_shape_infer=False
    )
    model.save_model_to_file(str(target))


def export_frontend(
    model: KokoroFrontend,
    inputs: tuple[torch.Tensor, ...],
    target: Path,
) -> tuple[torch.Tensor, ...]:
    with torch.no_grad():
        outputs = model(*inputs)
    torch.onnx.export(
        model,
        args=inputs,
        f=str(target),
        input_names=["input_ids", "style", "speed"],
        output_names=["prosody", "text", "duration"],
        opset_version=17,
        dynamic_axes={
            "input_ids": {1: "tokens"},
            "prosody": {1: "tokens"},
            "text": {2: "tokens"},
            "duration": {1: "tokens"},
        },
        do_constant_folding=True,
        dynamo=False,
    )
    return outputs


def export_decoder(
    model: KokoroDecoder,
    inputs: tuple[torch.Tensor, ...],
    target: Path,
) -> torch.Tensor:
    with torch.no_grad():
        output = model(*inputs)
    torch.manual_seed(7)
    torch.onnx.export(
        model,
        args=inputs,
        f=str(target),
        input_names=["prosody_frames", "text_frames", "style"],
        output_names=["waveform"],
        opset_version=17,
        dynamic_axes={
            "prosody_frames": {2: "frames"},
            "text_frames": {2: "frames"},
            "waveform": {0: "samples"},
        },
        do_constant_folding=True,
        dynamo=False,
    )
    return output


def verify_onnx(
    frontend_path: Path,
    decoder_path: Path,
    frontend_inputs: tuple[torch.Tensor, ...],
) -> None:
    front_session = ort.InferenceSession(
        str(frontend_path), providers=["CPUExecutionProvider"]
    )
    front_values = front_session.run(
        None,
        {
            "input_ids": frontend_inputs[0].numpy(),
            "style": frontend_inputs[1].numpy(),
            "speed": frontend_inputs[2].numpy(),
        },
    )
    prosody, text, duration = (torch.from_numpy(value) for value in front_values)
    prosody_frames, text_frames = expand_features(prosody, text, duration)
    decoder_session = ort.InferenceSession(
        str(decoder_path), providers=["CPUExecutionProvider"]
    )
    waveform = decoder_session.run(
        None,
        {
            "prosody_frames": prosody_frames.numpy(),
            "text_frames": text_frames.numpy(),
            "style": frontend_inputs[1].numpy(),
        },
    )[0]
    frames = int(duration.sum())
    assert len(waveform) == frames * 600
    assert np.isfinite(waveform).all()
    print(
        f"CPU ONNX split verified: tokens={duration.shape[1]} "
        f"frames={frames} samples={len(waveform)}"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=ROOT / "checkpoints/config.json")
    parser.add_argument(
        "--checkpoint", type=Path, default=ROOT / "checkpoints/kokoro-v1_0.pth"
    )
    parser.add_argument("--output-dir", type=Path, default=ROOT / "models/split")
    parser.add_argument("--skip-verify", action="store_true")
    args = parser.parse_args()

    if not KOKORO_SOURCE.exists():
        raise SystemExit(f"Missing Kokoro source: {KOKORO_SOURCE}")
    for path in (args.config, args.checkpoint):
        if not path.exists():
            raise SystemExit(f"Missing export asset: {path}")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    kmodel = load_kmodel(args.config, args.checkpoint)
    frontend = KokoroFrontend(kmodel).eval()
    decoder = KokoroDecoder(kmodel).eval()
    inputs = sample_inputs(kmodel)

    frontend_fp32 = args.output_dir / "kokoro-frontend.onnx"
    decoder_fp32 = args.output_dir / "kokoro-decoder.onnx"
    frontend_outputs = export_frontend(frontend, inputs, frontend_fp32)
    decoder_inputs = (*expand_features(*frontend_outputs), inputs[1])
    export_decoder(decoder, decoder_inputs, decoder_fp32)
    fix_boundary_shapes(frontend_fp32, decoder_fp32)

    for path in (frontend_fp32, decoder_fp32):
        onnx.checker.check_model(onnx.load(str(path), load_external_data=False))
        embed_config(path, args.config)

    frontend_fp16 = args.output_dir / "kokoro-frontend.fp16.onnx"
    decoder_fp16 = args.output_dir / "kokoro-decoder.fp16.onnx"
    to_fp16(frontend_fp32, frontend_fp16)
    to_fp16(decoder_fp32, decoder_fp16)
    print(f"Exported {frontend_fp16} ({frontend_fp16.stat().st_size / 2**20:.1f} MiB)")
    print(f"Exported {decoder_fp16} ({decoder_fp16.stat().st_size / 2**20:.1f} MiB)")

    if not args.skip_verify:
        verify_onnx(frontend_fp16, decoder_fp16, inputs)


if __name__ == "__main__":
    main()
