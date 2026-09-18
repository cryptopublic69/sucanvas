"""Persist separate style chains for internal stage two and independent pass two."""
import copy
import json
import tempfile
from datetime import datetime
from pathlib import Path


def main():
    root = Path(__file__).resolve().parents[1]
    paths = list((root / "workflows").glob("*V3.json"))
    paths += list((root / "src-tauri/target/debug/SuCanvasData/data/workflow-modules").glob("*/workflow.json"))
    changes = []
    for path in paths:
        graph = json.loads(path.read_text(encoding="utf-8-sig"))
        if graph.get("141", {}).get("class_type") != "ModelPreviewOverrideKJ" or "209" not in graph:
            continue
        native = "279" in graph
        upstream = ["141", 0]
        for index in range(6):
            key = str(9600 + index)
            if key in graph:
                raise ValueError(f"Node collision: {path}: {key}")
            graph[key] = {
                "class_type": "LoraLoaderModelOnly",
                "inputs": {"model": upstream, "lora_name": "", "strength_model": 1.0},
                "_meta": {"title": f"风格 LoRA {index + 1}（{'独立2采' if native else '内部二段'}）"},
            }
            upstream = [key, 0]
        if native:
            for key in ["9391", "9393"]:
                graph[key]["inputs"]["model"] = upstream
        else:
            if "9606" in graph:
                raise ValueError(f"Node collision: {path}: 9606")
            graph["9606"] = copy.deepcopy(graph["126"])
            graph["9606"]["inputs"]["model"] = upstream
            graph["9606"]["_meta"] = {"title": "内部二段独立风格引导器"}
            graph["209"]["inputs"]["guider"] = ["9606", 0]
            # Apply styles after the shared model patches; neither stage inherits the other's styles.
            graph["142"]["inputs"]["model"] = graph["9200"]["inputs"]["model"]
            graph["9200"]["inputs"]["model"] = ["141", 0]
            graph["126"]["inputs"]["model"] = ["9508", 0]
        changes.append((path, graph))
    backup = Path(tempfile.gettempdir()) / ("sucanvas-style-scopes-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
    for path, graph in changes:
        dest = backup / path.relative_to(root)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(path.read_bytes())
    for path, graph in changes:
        temp = path.with_suffix(".scopes.tmp")
        temp.write_text(json.dumps(graph, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temp.replace(path)
    print(f"Updated {len(changes)} workflows; backup: {backup}")


if __name__ == "__main__":
    main()
