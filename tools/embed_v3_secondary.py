"""Persist the independent V3 secondary branch; back up every changed workflow."""
import copy
import json
import tempfile
from datetime import datetime
from pathlib import Path


def upgrade(graph):
    def node(kind, **inputs):
        return {"class_type": kind, "inputs": inputs}

    nodes = {
        "9300": node("VHS_LoadVideo", video="selected-preview.mp4", force_rate=24.0,
                     custom_width=0, custom_height=0, frame_load_cap=0,
                     skip_first_frames=0, select_every_nth=1),
        "9398": node("ResolutionSelector", aspect_ratio="16:9 (Widescreen)", megapixels=0.5, multiple=32),
        "9383": node("ImageResizeKJv2", image=["259", 0], width=["9398", 0],
                     height=["9398", 1], upscale_method="nvidia_rtx_vsr", keep_proportion="crop",
                     pad_color="0, 0, 0", crop_position="center", divisible_by=32, device="cpu"),
        "9386": node("VAEEncode", pixels=["9383", 0], vae=["119", 0]),
        "9388": node("VAEEncodeAudio", audio=["218", 0], vae=["120", 0]),
        "9390": node("PT_H3ConcatAVLatent", video_latent=["9386", 0], audio_latent=["9388", 0]),
        "9391": node("BasicScheduler", scheduler="simple", steps=4, denoise=0.2, model=["9509", 0]),
        "9393": node("BasicGuider", model=["9509", 0], conditioning=["9394", 0]),
        "9394": copy.deepcopy(graph["278"]),
        "9387": node("SamplerCustomAdvanced", noise=["129", 0], guider=["9393", 0],
                     sampler=["123", 0], sigmas=["9391", 0], latent_image=["9390", 0]),
        "9395": node("VAEDecode", samples=["9387", 0], vae=["119", 0]),
        "9403": node("LayerColor: BrightnessContrastV2", brightness=1.0, contrast=0.9,
                     saturation=1.0, image=["9395", 0]),
        "9404": node("VHS_VideoCombine", images=["9403", 0], audio=["218", 0],
                     frame_rate=24, loop_count=0, filename_prefix="%date:yyyy-MM-dd%/Minimax_H3_2pass",
                     format="video/h264-mp4", pix_fmt="yuv420p", crf=19,
                     save_metadata=True, trim_to_audio=False, pingpong=False, save_output=True),
    }
    nodes["9394"]["inputs"].update(first_frame=["9383", 0], width=["9398", 0], height=["9398", 1])
    for key, value in nodes.items():
        if key in graph:
            raise ValueError(f"Node collision: {key}")
        value["_meta"] = {"title": f"独立2采 {value['class_type']}", "sucanvasIndependentSecondary": True}
    graph.update(nodes)
    return graph


def main():
    root = Path(__file__).resolve().parents[1]
    candidates = list((root / "workflows").glob("*V3.json"))
    candidates += list((root / "src-tauri/target/debug/SuCanvasData/data/workflow-modules").glob("*/workflow.json"))
    changes = []
    for path in candidates:
        graph = json.loads(path.read_text(encoding="utf-8-sig"))
        if graph.get("279", {}).get("class_type") != "BasicGuider":
            continue
        changes.append((path, upgrade(graph)))
    backup = Path(tempfile.gettempdir()) / ("sucanvas-v3-embedded-secondary-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
    for path, graph in changes:
        dest = backup / path.relative_to(root)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(path.read_bytes())
    for path, graph in changes:
        temporary = path.with_suffix(".secondary.tmp")
        temporary.write_text(json.dumps(graph, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(path)
    print(f"Updated {len(changes)} workflows; backup: {backup}")


if __name__ == "__main__":
    main()
