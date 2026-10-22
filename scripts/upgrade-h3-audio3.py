"""One-off upgrade: give installed H3 reference-to-video packages a third reference audio.

Usage:
  python -I scripts/upgrade-h3-audio3.py <workflow-modules-root>            # dry run
  python -I scripts/upgrade-h3-audio3.py <workflow-modules-root> --apply    # back up, then write
  python -I scripts/upgrade-h3-audio3.py --source <workflow.json> [--apply] # repo source workflow

A package is upgraded only when its adapter declares audioMax=2 with two audio
nodes, and its conditioning node (bindings.conditioningNodeId) is an H3 node
whose ref_audios accepts three inputs. Packages that already have three audio
inputs are skipped, so running --apply twice changes nothing the second time.
Manifest, ui-schema and module id are never touched.
"""

import argparse
import copy
import datetime
import json
import os
import shutil
import sys

# Both ComfyUI nodes declare ref_audios as Autogrow prefix ref_audio_, max=3:
# comfy_extras/nodes_minimax_h3.py and custom_nodes/minimax-h3-audio-T8/nodes.py.
CONDITIONING_CLASSES = {"MiniMaxH3ReferenceToVideo", "MiniMaxH3AudioConditioningT8"}
AUDIO_INPUT = "ref_audios.ref_audio_{}"
BACKUP_SUFFIX = "h3-audio3"


class Skip(Exception):
    pass


def read_json(path):
    with open(path, "rb") as handle:
        raw = handle.read()
    bom = raw.startswith(b"\xef\xbb\xbf")
    text = raw[3:].decode("utf-8") if bom else raw.decode("utf-8")
    style = {
        "bom": bom,
        "newline": "\r\n" if "\r\n" in text else "\n",
        "ascii": all(ord(ch) < 128 for ch in text),
        "trailing": text.endswith(("\n", "\r\n")),
    }
    return json.loads(text), style


def write_json(path, value, style):
    text = json.dumps(value, indent=2, ensure_ascii=style["ascii"])
    if style["trailing"]:
        text += "\n"
    if style["newline"] == "\r\n":
        text = text.replace("\n", "\r\n")
    data = text.encode("utf-8")
    if style["bom"]:
        data = b"\xef\xbb\xbf" + data
    temporary = path + ".upgrade-tmp"
    with open(temporary, "wb") as handle:
        handle.write(data)
    os.replace(temporary, path)


def insert_after(mapping, anchor, key, value):
    items = list(mapping.items())
    position = next(index for index, (name, _) in enumerate(items) if name == anchor) + 1
    items.insert(position, (key, value))
    mapping.clear()
    mapping.update(items)


def plan_workflow(workflow, conditioning_id, audio_ids):
    """Return the new LoadAudio id, or raise Skip with the reason."""
    node = workflow.get(conditioning_id)
    if not isinstance(node, dict):
        raise Skip(f"条件节点 {conditioning_id} 不存在")
    class_type = node.get("class_type", "")
    if class_type not in CONDITIONING_CLASSES:
        raise Skip(f"条件节点 {conditioning_id} 是 {class_type or '<缺失>'}，不在白名单内")
    inputs = node.get("inputs", {})
    if AUDIO_INPUT.format(2) in inputs:
        raise Skip(f"条件节点 {conditioning_id} 已有 ref_audio_2")
    if len(audio_ids) != 2:
        raise Skip(f"音频节点数是 {len(audio_ids)}，不是 2")
    for index, audio_id in enumerate(audio_ids):
        if inputs.get(AUDIO_INPUT.format(index)) != [audio_id, 0]:
            raise Skip(f"ref_audio_{index} 没有接到音频节点 {audio_id}")
        if workflow.get(audio_id, {}).get("class_type") != "LoadAudio":
            raise Skip(f"音频节点 {audio_id} 不是 LoadAudio")
    new_id = str(max(int(key) for key in workflow if key.isdigit()) + 1)
    if new_id in workflow:
        raise Skip(f"新节点 id {new_id} 已被占用")
    return new_id


def apply_workflow(workflow, conditioning_id, audio_ids, new_id):
    insert_after(workflow, audio_ids[1], new_id, copy.deepcopy(workflow[audio_ids[1]]))
    insert_after(
        workflow[conditioning_id]["inputs"],
        AUDIO_INPUT.format(1),
        AUDIO_INPUT.format(2),
        [new_id, 0],
    )


def upgrade_package(root, name, apply, backup_root):
    directory = os.path.join(root, name)
    manifest, _ = read_json(os.path.join(directory, "manifest.json"))
    adapter_path = os.path.join(directory, "adapter.json")
    workflow_path = os.path.join(directory, "workflow.json")
    row = {
        "package": name,
        "name": f"{manifest.get('name', '')} {manifest.get('revision', '')}".strip(),
        "deleted": bool(manifest.get("deletedAt")),
    }
    if not os.path.isfile(adapter_path):
        raise Skip("没有 adapter.json（legacy 包由程序按 2 路处理）")
    adapter, adapter_style = read_json(adapter_path)
    if adapter.get("variant") != "reference-to-video":
        raise Skip(f"variant 是 {adapter.get('variant')}")
    contract = adapter.get("inputContract", {})
    bindings = adapter.get("bindings", {})
    audio_ids = list(bindings.get("audioNodeIds", []))
    if contract.get("audioMax") == 3 and len(audio_ids) == 3:
        raise Skip("已是 3 路")
    if contract.get("audioMax") != 2:
        raise Skip(f"audioMax 是 {contract.get('audioMax')}，不是 2")
    workflow, workflow_style = read_json(workflow_path)
    conditioning_id = bindings.get("conditioningNodeId", "")
    new_id = plan_workflow(workflow, conditioning_id, audio_ids)
    row.update(conditioning=conditioning_id, audio_before=audio_ids, new_id=new_id)
    if not apply:
        return row
    target = os.path.join(backup_root, name)
    if os.path.exists(target):
        raise RuntimeError(f"备份目录已存在，拒绝覆盖：{target}")
    os.makedirs(backup_root, exist_ok=True)
    shutil.copytree(directory, target)
    apply_workflow(workflow, conditioning_id, audio_ids, new_id)
    contract["audioMax"] = 3
    bindings["audioNodeIds"] = audio_ids + [new_id]
    write_json(workflow_path, workflow, workflow_style)
    write_json(adapter_path, adapter, adapter_style)
    # Read back so a half-written package is reported as a failure, not a success.
    check_adapter, _ = read_json(adapter_path)
    check_workflow, _ = read_json(workflow_path)
    if (
        check_adapter["inputContract"]["audioMax"] != 3
        or check_adapter["bindings"]["audioNodeIds"] != audio_ids + [new_id]
        or check_workflow[conditioning_id]["inputs"].get(AUDIO_INPUT.format(2)) != [new_id, 0]
        or check_workflow.get(new_id, {}).get("class_type") != "LoadAudio"
    ):
        raise RuntimeError("写入后回读不一致")
    row["backup"] = target
    return row


def run_root(root, apply, date):
    backup_root = os.path.join(root, ".repair-backups", f"{date}-{BACKUP_SUFFIX}")
    counts = {"upgraded": 0, "skipped": 0, "failed": 0}
    print(f"模式：{'APPLY' if apply else 'DRY-RUN'}  根目录：{root}")
    if apply:
        print(f"备份目录：{backup_root}")
    for name in sorted(os.listdir(root)):
        if not os.path.isfile(os.path.join(root, name, "manifest.json")):
            continue
        try:
            row = upgrade_package(root, name, apply, backup_root)
            counts["upgraded"] += 1
            verb = "UPGRADED" if apply else "WOULD-UPGRADE"
            print(
                f"{verb:13} {name}  [{row['name']}{' 回收站' if row['deleted'] else ''}]"
                f"  条件节点 {row['conditioning']}  音频 {','.join(row['audio_before'])} + 新节点 {row['new_id']}"
            )
        except Skip as reason:
            counts["skipped"] += 1
            print(f"{'SKIP':13} {name}  {reason}")
        except Exception as error:  # report every package, keep going
            counts["failed"] += 1
            print(f"{'FAIL':13} {name}  {error}")
    label = "改了" if apply else "会改"
    print(f"结果：{label} {counts['upgraded']} 个，跳过 {counts['skipped']} 个，失败 {counts['failed']} 个")
    return 1 if counts["failed"] else 0


def run_source(path, apply):
    workflow, style = read_json(path)
    candidates = [
        key
        for key, node in workflow.items()
        if isinstance(node, dict) and node.get("class_type") in CONDITIONING_CLASSES
    ]
    if len(candidates) != 1:
        print(f"FAIL 找到 {len(candidates)} 个 H3 条件节点，需要恰好 1 个")
        return 1
    conditioning_id = candidates[0]
    inputs = workflow[conditioning_id]["inputs"]
    audio_ids = [inputs[AUDIO_INPUT.format(i)][0] for i in range(2) if AUDIO_INPUT.format(i) in inputs]
    try:
        new_id = plan_workflow(workflow, conditioning_id, audio_ids)
    except Skip as reason:
        print(f"SKIP {path}  {reason}")
        return 0
    print(f"{'UPGRADED' if apply else 'WOULD-UPGRADE'} {path}  条件节点 {conditioning_id}  新节点 {new_id}")
    if apply:
        apply_workflow(workflow, conditioning_id, audio_ids, new_id)
        write_json(path, workflow, style)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("root", nargs="?", help="workflow-modules 根目录")
    parser.add_argument("--source", help="改单个仓库源工作流 json（没有 adapter）")
    parser.add_argument("--apply", action="store_true", help="真正写入；不加只预演")
    parser.add_argument("--date", default=datetime.date.today().isoformat(), help="备份目录日期前缀")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    if bool(args.root) == bool(args.source):
        parser.error("root 和 --source 二选一")
    if args.source:
        return run_source(args.source, args.apply)
    if not os.path.isdir(args.root):
        parser.error(f"目录不存在：{args.root}")
    return run_root(args.root, args.apply, args.date)


if __name__ == "__main__":
    sys.exit(main())
