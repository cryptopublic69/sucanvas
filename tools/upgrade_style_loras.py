"""Persist six H3 style slots in templates and installed modules, with backups."""
import argparse
import copy
import json
from pathlib import Path
import shutil

PRIMARY = ["9200", "9500", "9502", "9504", "9506", "9508"]
SECONDARY = ["9201", "9501", "9503", "9505", "9507", "9509"]


def upgrade(workflow, bindings=None):
    ids_by_stage = [PRIMARY.copy(), SECONDARY.copy()]
    if bindings:
        ids_by_stage[0][0] = bindings.get("primaryStyleLoraNodeId", "9200")
        ids_by_stage[1][0] = bindings.get("secondaryStyleLoraNodeId", "9201")
    for ids in ids_by_stage:
        original = workflow[ids[0]]
        if original["class_type"] != "LoraLoaderModelOnly":
            raise ValueError(f"Unsupported style loader {ids[0]}")
        for index, node_id in enumerate(ids[1:], 1):
            if node_id in workflow:
                if workflow[node_id].get("_meta", {}).get("sucanvasStyleSlot") != index + 1:
                    raise ValueError(f"Node ID collision: {node_id}")
                continue
            node = copy.deepcopy(original)
            node["inputs"]["model"] = [ids[index - 1], 0]
            node["inputs"]["lora_name"] = ""
            node["inputs"]["strength_model"] = 1.0
            node["_meta"] = {"title": f"风格 LoRA {index + 1}（{'1采' if ids is ids_by_stage[0] else '二段'}）", "sucanvasStyleSlot": index + 1}
            workflow[node_id] = node
        # Existing downstream style connections point to the end of the saved chain.
        # Runtime configuration still bypasses unused slots before submission.
        for node_id, node in workflow.items():
            if node_id in ids:
                continue
            for key, value in node.get("inputs", {}).items():
                if value == [ids[0], 0]:
                    node["inputs"][key] = [ids[-1], 0]
    # Native V3 stages share the patched model and Sigma scheduler, but have
    # separate guiders. Their original bypass links never referenced 9200/9201,
    # so merely replacing existing style consumers misses both chain outputs.
    primary_upstream = workflow[ids_by_stage[0][0]]["inputs"]["model"]
    secondary_upstream = workflow[ids_by_stage[1][0]]["inputs"]["model"]
    if (primary_upstream == secondary_upstream
            and workflow.get("126", {}).get("class_type") == "BasicGuider"
            and workflow.get("279", {}).get("class_type") == "BasicGuider"):
        workflow["126"]["inputs"]["model"] = [ids_by_stage[0][-1], 0]
        workflow["279"]["inputs"]["model"] = [ids_by_stage[1][-1], 0]
    if bindings is not None:
        bindings["primaryStyleLoraNodeIds"] = ids_by_stage[0]
        bindings["secondaryStyleLoraNodeIds"] = ids_by_stage[1]
    return workflow


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--templates", type=Path)
    parser.add_argument("--modules", type=Path)
    parser.add_argument("--backup", required=True, type=Path)
    args = parser.parse_args()
    changes = []
    if args.templates:
        for path in args.templates.glob("*H3*.json"):
            data = json.loads(path.read_text(encoding="utf-8-sig"))
            changes.append((path, upgrade(data), Path("templates") / path.name))
    if args.modules:
        for path in args.modules.glob("workflow-module-*/manifest.json"):
            manifest = json.loads(path.read_text(encoding="utf-8-sig"))
            if manifest.get("capability") != "video-generation":
                continue
            folder = path.parent
            workflow_path, adapter_path = folder / "workflow.json", folder / "adapter.json"
            workflow = json.loads(workflow_path.read_text(encoding="utf-8-sig"))
            adapter = json.loads(adapter_path.read_text(encoding="utf-8-sig"))
            upgrade(workflow, adapter["bindings"])
            for file, data in [(workflow_path, workflow), (adapter_path, adapter)]:
                changes.append((file, data, Path("modules") / folder.name / file.name))
    # Validate all graphs before any write; save all originals first.
    args.backup.mkdir(parents=True, exist_ok=False)
    for path, _, relative in changes:
        dest = args.backup / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, dest)
    for path, data, _ in changes:
        temporary = path.with_suffix(".style-slots.tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(path)
    print(f"Updated {len(changes)} files; backup: {args.backup}")


if __name__ == "__main__":
    main()
