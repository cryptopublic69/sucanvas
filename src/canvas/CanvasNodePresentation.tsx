import { memo, useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import { Handle, Position, useStore } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { CanvasFlowNode } from "../CanvasNode";
import { nodeRenderQueue } from "./renderQueue";
import { useBatchedNodeInternals } from "./useBatchedNodeInternals";
import { posterMemoryCache, requestCachedVideoPoster } from "../videoPosterCache";

type Props = NodeProps<CanvasFlowNode> & { detail: ComponentType<NodeProps<CanvasFlowNode>> };
export const CanvasNodePresentation = memo(function CanvasNodePresentation({ detail: Detail, ...props }: Props) {
  const distant = useStore((state) => state.transform[2] < 0.35);
  const [ready, setReady] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const updateInternals = useBatchedNodeInternals();
  const { record } = props.data;
  const full = Boolean(props.selected || engaged || (!distant && ready));
  useEffect(() => { if (distant) setReady(false); }, [distant]);
  useEffect(() => {
    if (ready || distant || props.selected || engaged) return;
    return nodeRenderQueue.enqueue(() => setReady(true), () => {
      const bounds = host.current?.getBoundingClientRect();
      return bounds ? Math.abs(bounds.x + bounds.width / 2 - innerWidth / 2)
        + Math.abs(bounds.y + bounds.height / 2 - innerHeight / 2) : Infinity;
    });
  }, [ready, distant, props.selected, engaged]);
  useEffect(() => { updateInternals(props.id); }, [full, props.id, updateInternals]);
  const video = record.kind === "generated-video" && typeof record.content.videoUrl === "string"
    ? record.content.videoUrl : record.kind === "video" && typeof record.content.assetPath === "string"
      ? convertFileSrc(record.content.assetPath) : "";
  const image = record.kind === "generated-image" && typeof record.content.imageUrl === "string"
    ? record.content.imageUrl : record.kind === "image" && typeof record.content.assetPath === "string"
      ? convertFileSrc(record.content.assetPath) : "";
  const [poster, setPoster] = useState<{ src: string; url: string } | null>(null);
  useEffect(() => {
    if (full || !video) return;
    let release: (() => void) | undefined;
    let cancelRead: (() => void) | undefined;
    const cancel = nodeRenderQueue.enqueue(() => {
      cancelRead = requestCachedVideoPoster(video, () => {
        const cover = posterMemoryCache.retain(video);
        if (cover) { release = cover.release; setPoster({ src: video, url: cover.url }); }
      });
    });
    return () => { cancel(); cancelRead?.(); release?.(); };
  }, [full, video]);
  if (full) return <div className="canvas-node-detail-host" onFocusCapture={() => setEngaged(true)} onDoubleClickCapture={() => setEngaged(true)}><Detail {...props} /></div>;
  const thumbnail = image || (poster?.src === video ? poster.url : "");
  const kind = ({ text: "文本", "generated-video": "视频", "video-generation": "视频生成", image: "图片", "generated-image": "图片", "image-generation": "图片生成", video: "视频", audio: "音频", folder: "目录", note: "便签" } as Record<string, string>)[record.kind] ?? "内容";
  const status = props.data.activeTaskCount > 0 ? `${props.data.activeTaskCount} 个任务执行中`
    : record.content.generationPlaceholder === true ? "生成中"
      : record.kind === "text" ? "放大或选择以编辑" : distant ? "放大或选择以查看" : "正在加载…";
  const target = ["video-generation", "image-generation", "generated-image", "generated-video"].includes(record.kind)
    || record.kind === "text" && (record.content.contentNode === true || record.content.promptVersionNode === true || record.content.storySceneNode === true);
  const source = ["text", "image", "generated-image", "audio", "video", "video-generation", "image-generation", "generated-video"].includes(record.kind);
  return <div ref={host} className={`canvas-node canvas-node-overview kind-${record.kind} ${props.data.matched ? "" : "is-dimmed"} ${props.data.relationHighlighted ? "is-relation-highlighted" : ""}`}>
    {target && <Handle type="target" position={Position.Left} className="node-handle target-handle" />}
    <header><span>{kind}</span><strong>{record.title || kind}</strong></header>
    {thumbnail ? <img src={thumbnail} alt="" loading="lazy" decoding="async" /> : <div className="canvas-node-overview-symbol">{kind}</div>}
    <footer>{status}</footer>
    {source && <Handle type="source" position={Position.Right} className="node-handle source-handle" />}
  </div>;
});
