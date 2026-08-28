"""Add symbolic shape metadata required by ONNX Runtime TensorRT EP."""

from pathlib import Path

import onnx
from onnx import AttributeProto


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "models" / "kokoro-v1.0.export-v1.1.fp16.onnx"
OUTPUT = ROOT / "models" / "kokoro-v1.0.export-v1.1.fp16.shaped.onnx"


def _set_symbolic_shape(value_info: onnx.ValueInfoProto, dimensions: list[str]) -> None:
    shape = value_info.type.tensor_type.shape
    shape.ClearField("dim")
    for dimension in dimensions:
        shape.dim.add().dim_param = dimension


def _patch_loop_boundary_shapes(graph: onnx.GraphProto) -> None:
    for value_info in graph.value_info:
        if value_info.name == "/Expand_2_output_0":
            _set_symbolic_shape(
                value_info, ["loop_expand_rows", "loop_expand_columns"]
            )
        elif value_info.name == "/ConcatFromSequence_output_0":
            _set_symbolic_shape(value_info, ["expanded_token_count"])
    for node in graph.node:
        for attribute in node.attribute:
            if attribute.type == AttributeProto.GRAPH:
                _patch_loop_boundary_shapes(attribute.g)
            elif attribute.type == AttributeProto.GRAPHS:
                for subgraph in attribute.graphs:
                    _patch_loop_boundary_shapes(subgraph)


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"Missing source model: {SOURCE}")
    model = onnx.load(str(SOURCE), load_external_data=False)
    shaped = onnx.shape_inference.infer_shapes(
        model,
        check_type=False,
        strict_mode=False,
        data_prop=True,
    )
    _patch_loop_boundary_shapes(shaped.graph)
    onnx.save(shaped, str(OUTPUT))
    print(f"Wrote {OUTPUT} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
