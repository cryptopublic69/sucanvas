import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { createPortal } from "react-dom";
import {
  BaseEdge,
  Background,
  BackgroundVariant,
  Connection,
  Controls,
  Edge,
  EdgeProps,
  Handle,
  MiniMap,
  Node,
  NodeProps,
  NodeResizer,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import {
  ArrowLeft,
  Check,
  Clapperboard,
  Copy,
  Dices,
  FileText,
  Film,
  FolderOpen,
  FolderKanban,
  GripVertical,
  Image as ImageIcon,
  Link2,
  Moon,
  Maximize2,
  Music,
  Pause,
  Palette,
  Pencil,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Sparkles,
  Square,
  StickyNote,
  Sun,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  ChangeEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./App.css";

type JsonObject = Record<string, unknown>;

interface CanvasRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

interface NodeRecord {
  id: string;
  canvasId: string;
  kind: string;
  title: string;
  content: JsonObject;
  source: string;
  requestId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface EdgeRecord {
  id: string;
  canvasId: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind: string;
  metadata: JsonObject;
  createdAt: string;
}

interface WorkspaceSnapshot {
  canvas: CanvasRecord;
  nodes: NodeRecord[];
  edges: EdgeRecord[];
}

interface RuntimeInfo {
  baseUrl: string;
  dataPath: string;
  canvasId: string;
}

interface CreateNodeResult {
  node: NodeRecord;
  created: boolean;
}

interface DeletedBatch {
  nodes: NodeRecord[];
  edges: EdgeRecord[];
}

interface ComfyOutputFile {
  filename: string;
  subfolder: string;
  fileType: string;
  url: string;
}

interface ComfySubmitResult {
  promptId: string;
  seed: string;
  outputs: ComfyOutputFile[];
  cleanupWarning?: string;
}

interface ComfyQueueStatus {
  state: "preparing" | "queued" | "running" | "unknown";
  position: number | null;
  pendingCount: number;
}

interface GenerationSnapshot {
  prompt: string;
  durationSeconds: number;
  primaryResolutionMegapixels: number;
  secondaryResolutionMegapixels: number;
  imagePaths: string[];
  audioPaths: string[];
  videoPaths: string[];
}

interface NodePatch {
  title?: string;
  content?: JsonObject;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  status?: string;
}

interface CanvasContextMenuState {
  screenX: number;
  screenY: number;
  flowX: number;
  flowY: number;
}

interface CanvasNodeData extends Record<string, unknown> {
  record: NodeRecord;
  matched: boolean;
  inputCount: number;
  mediaInputs: NodeRecord[];
  textInputCount: number;
  textInputs: NodeRecord[];
  queuePosition: number | null;
  onChange: (id: string, patch: NodePatch) => void;
  onSave: (id: string, patch: NodePatch) => Promise<boolean>;
  onExecutionCheck: (message: string, valid: boolean) => void;
  onExecute: (id: string) => Promise<void>;
  onSecondarySample: (id: string) => Promise<void>;
  onCancelExecution: (id: string) => Promise<void>;
  onRevealGeneratedVideo: (id: string) => Promise<void>;
  onRemoveInput: (targetId: string, sourceId: string) => Promise<void>;
  onDelete: (id: string) => void;
  onCopy: (text: string) => void;
}

interface NodeClipboardEdge {
  sourceId: string;
  targetId: string;
  kind: string;
  metadata: JsonObject;
}

interface NodeClipboard {
  nodes: NodeRecord[];
  videoInputEdges: NodeClipboardEdge[];
  pasteCount: number;
}

interface CanvasEdgeData extends Record<string, unknown> {
  record?: EdgeRecord;
  onDisconnect?: (edgeId: string) => void;
}

type CanvasFlowNode = Node<CanvasNodeData, "canvasNode">;

const CANVAS_GRID_SIZE = 24;
const CANVAS_SNAP_GRID: [number, number] = [CANVAS_GRID_SIZE, CANVAS_GRID_SIZE];
const AUDIO_NODE_MIN_HEIGHT = 240;
const VIDEO_NODE_BASE_HEIGHT = 432;
const MEDIA_NODE_CHROME_HEIGHT = 73;
const COMFYUI_SERVER_URL = "http://192.168.5.108:8188";
const DEFAULT_GENERATION_SEED = "56456340597885880";
const H3_REFERENCE_WORKFLOW_PATH = "D:\\Downloads\\MiniMax+H3全能参考工作流.json";
const VIDEO_RESIZE_CONTROLS = [
  { position: "top", direction: [0, -1] },
  { position: "right", direction: [1, 0] },
  { position: "bottom", direction: [0, 1] },
  { position: "left", direction: [-1, 0] },
  { position: "top-left", direction: [-1, -1] },
  { position: "top-right", direction: [1, -1] },
  { position: "bottom-right", direction: [1, 1] },
  { position: "bottom-left", direction: [-1, 1] },
] as const;
const VIDEO_GENERATION_MODES = [
  { value: "reference-to-video", label: "参考生视频" },
  { value: "first-last-frame", label: "首尾帧" },
  { value: "text-to-video", label: "文生视频" },
] as const;

type VideoGenerationMode = typeof VIDEO_GENERATION_MODES[number]["value"];
type FrameRole = "first" | "last";
type SeedMode = "random" | "fixed";

function comfyWebSocketUrl(serverUrl: string, clientId: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/ws`;
  url.search = "";
  url.searchParams.set("clientId", clientId);
  return url.toString();
}

function openComfyProgressSocket(clientId: string): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    const socket = new WebSocket(comfyWebSocketUrl(COMFYUI_SERVER_URL, clientId));
    let settled = false;
    const finish = (result: WebSocket | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve(result);
    };
    const timeout = window.setTimeout(() => {
      socket.close();
      finish(null);
    }, 4000);
    socket.addEventListener("open", () => finish(socket), { once: true });
    socket.addEventListener("error", () => finish(null), { once: true });
  });
}

function snapCanvasCoordinate(value: number): number {
  return Math.round(value / CANVAS_GRID_SIZE) * CANVAS_GRID_SIZE;
}

function incomingNodePosition(
  node: NodeRecord,
  existingNodes: NodeRecord[],
  viewportCenter: { x: number; y: number },
): { x: number; y: number } {
  const gap = CANVAS_GRID_SIZE;
  const y = snapCanvasCoordinate(viewportCenter.y - node.height / 2);
  let x = snapCanvasCoordinate(viewportCenter.x - node.width / 2);

  for (let attempt = 0; attempt <= existingNodes.length; attempt += 1) {
    const blockers = existingNodes.filter((existing) => (
      existing.id !== node.id
      && x < existing.x + existing.width + gap
      && x + node.width + gap > existing.x
      && y < existing.y + existing.height + gap
      && y + node.height + gap > existing.y
    ));
    if (!blockers.length) break;
    x = snapCanvasCoordinate(
      Math.max(...blockers.map((existing) => existing.x + existing.width)) + gap,
    );
  }

  return { x, y };
}

function validCanvasColor(value: string | null): string | null {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

function canvasGridColor(background: string | null, theme: "dark" | "light"): string {
  if (!background) return theme === "light" ? "#cbd1dc" : "#2b3140";
  const red = Number.parseInt(background.slice(1, 3), 16);
  const green = Number.parseInt(background.slice(3, 5), 16);
  const blue = Number.parseInt(background.slice(5, 7), 16);
  const brightness = (red * 299 + green * 587 + blue * 114) / 255000;
  return brightness > 0.58 ? "rgba(43, 49, 65, 0.34)" : "rgba(220, 225, 235, 0.24)";
}

function videoGenerationAutoHeight(
  mediaKinds: string[],
  textInputCount = 0,
  nodeWidth = 360,
): number {
  if (!mediaKinds.length && !textInputCount) return VIDEO_NODE_BASE_HEIGHT;
  const groupCount = new Set(mediaKinds).size;
  const imageCount = mediaKinds.filter((kind) => kind === "image").length;
  const audioCount = mediaKinds.filter((kind) => kind === "audio").length;
  const videoCount = mediaKinds.length - imageCount - audioCount;
  const listMediaRows = videoCount + Math.ceil(audioCount / 2);
  const imageColumns = Math.max(1, Math.floor((Math.max(180, nodeWidth - 32) + 6) / 66));
  const imageRows = imageCount ? Math.ceil(imageCount / imageColumns) : 0;
  const contentHeight = 391
    + listMediaRows * 51
    + imageRows * 66
    + groupCount * 30
    + textInputCount * 51
    + (textInputCount ? 30 : 0);
  return Math.min(
    2400,
    Math.max(
      VIDEO_NODE_BASE_HEIGHT,
      Math.ceil(contentHeight / CANVAS_GRID_SIZE) * CANVAS_GRID_SIZE,
    ),
  );
}

function generatedSeedsFromContent(content: JsonObject): string[] {
  const seeds = Array.isArray(content.generatedSeeds)
    ? content.generatedSeeds.filter((seed): seed is string => typeof seed === "string")
    : [];
  if (typeof content.lastGenerationSeed === "string") seeds.push(content.lastGenerationSeed);
  return [...new Set(seeds)];
}

function normalizedGeneratedVideoTitle(title: string): string {
  const match = /^生成视频 · Seed \d+(?: · (\d+))?$/.exec(title);
  if (!match) return title;
  return match[1] ? `视频预览 ${match[1]}` : "视频预览";
}

function formattedGenerationElapsed(content: JsonObject): string {
  const value = content.generationElapsedSeconds;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "耗时未记录";
  }
  const totalSeconds = Math.max(1, Math.round(value));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `耗时 ${hours}时${minutes}分${seconds}秒`;
  if (minutes) return `耗时 ${minutes}分${seconds}秒`;
  return `耗时 ${seconds}秒`;
}

function generatedPreviewPosition(
  generator: NodeRecord,
  existingNodes: NodeRecord[],
  width: number,
  height: number,
): { x: number; y: number } {
  const gap = CANVAS_GRID_SIZE;
  const x = snapCanvasCoordinate(generator.x + generator.width + gap * 2);
  let y = snapCanvasCoordinate(generator.y);
  for (let attempt = 0; attempt <= existingNodes.length; attempt += 1) {
    const blocked = existingNodes.some((node) => (
      x < node.x + node.width + gap
      && x + width + gap > node.x
      && y < node.y + node.height + gap
      && y + height + gap > node.y
    ));
    if (!blocked) return { x, y };
    y = snapCanvasCoordinate(y + height + gap);
  }
  return { x, y };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item))
    : [];
}

function generationSnapshotFromContent(content: JsonObject): GenerationSnapshot | null {
  const value = content.generationSnapshot;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as JsonObject;
  if (typeof snapshot.prompt !== "string" || !snapshot.prompt.trim()) return null;
  return {
    prompt: snapshot.prompt,
    durationSeconds: typeof snapshot.durationSeconds === "number"
      ? snapshot.durationSeconds
      : 15,
    primaryResolutionMegapixels: validVideoResolution(
      snapshot.primaryResolutionMegapixels,
      0.4,
    ),
    secondaryResolutionMegapixels: validVideoResolution(
      snapshot.secondaryResolutionMegapixels,
      0.5,
    ),
    imagePaths: stringArray(snapshot.imagePaths),
    audioPaths: stringArray(snapshot.audioPaths),
    videoPaths: stringArray(snapshot.videoPaths),
  };
}

function comfyOutputFromContent(content: JsonObject): ComfyOutputFile | null {
  const filename = typeof content.filename === "string" ? content.filename : "";
  const subfolder = typeof content.subfolder === "string" ? content.subfolder : "";
  const fileType = typeof content.fileType === "string" ? content.fileType : "output";
  const url = typeof content.videoUrl === "string" ? content.videoUrl : "";
  return filename && url ? { filename, subfolder, fileType, url } : null;
}

function mappedComfyOutputPath(root: string, content: JsonObject): string | null {
  const filenameValue = typeof content.filename === "string" ? content.filename : "";
  const filenameParts = filenameValue.split(/[\\/]/).filter(Boolean);
  const filename = filenameParts[filenameParts.length - 1] ?? "";
  if (!root.trim() || !filename) return null;
  const subfolder = typeof content.subfolder === "string" ? content.subfolder : "";
  const safeSubfolders = subfolder
    .split(/[\\/]/)
    .filter((part) => part && part !== "." && part !== ".." && !part.includes(":"));
  return [root.trim().replace(/[\\/]+$/, ""), ...safeSubfolders, filename].join("\\");
}

function videoGenerationModeFromContent(content: JsonObject): VideoGenerationMode {
  const value = content.generationMode;
  return typeof value === "string"
    && VIDEO_GENERATION_MODES.some((mode) => mode.value === value)
    ? value as VideoGenerationMode
    : "reference-to-video";
}

function videoDurationFromContent(content: JsonObject): number {
  const value = content.generationDuration;
  return typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= 15
    ? value
    : 15;
}

function validVideoResolution(value: unknown, fallback: number): number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0.2
    && value <= 2.0
    ? Math.round(value * 10) / 10
    : fallback;
}

function primaryVideoResolutionFromContent(content: JsonObject): number {
  return validVideoResolution(content.generationPrimaryResolution, 0.4);
}

function secondaryVideoResolutionFromContent(content: JsonObject): number {
  return validVideoResolution(
    content.generationSecondaryResolution ?? content.generationResolution,
    0.5,
  );
}

function seedModeFromContent(content: JsonObject): SeedMode {
  return content.seedMode === "fixed" ? "fixed" : "random";
}

function fixedSeedFromContent(content: JsonObject): string {
  return typeof content.generationSeed === "string"
    ? content.generationSeed
    : DEFAULT_GENERATION_SEED;
}

function randomFixedSeed(): string {
  const values = crypto.getRandomValues(new Uint32Array(2));
  return ((BigInt(values[0]) << 32n) | BigInt(values[1])).toString();
}

function frameRoleFromContent(
  content: JsonObject,
  sourceId: string,
  fallbackIndex: number,
): FrameRole {
  const roles = content.frameRoles;
  if (roles && typeof roles === "object" && !Array.isArray(roles)) {
    const role = (roles as Record<string, unknown>)[sourceId];
    if (role === "first" || role === "last") return role;
  }
  return fallbackIndex === 0 ? "first" : "last";
}

function validateVideoExecution(
  mode: VideoGenerationMode,
  content: JsonObject,
  mediaInputs: NodeRecord[],
  textInputs: NodeRecord[],
): { valid: boolean; message: string } {
  const images = mediaInputs.filter((input) => input.kind === "image");
  const audios = mediaInputs.filter((input) => input.kind === "audio");
  const videos = mediaInputs.filter((input) => input.kind === "video");

  if (mode === "text-to-video") {
    if (mediaInputs.length) {
      return { valid: false, message: "文生视频只允许连接文字，不能包含图片、音频或视频" };
    }
    if (!textInputs.length) {
      return { valid: false, message: "文生视频至少需要连接一个文字节点" };
    }
    if (!textInputs.some((input) => textFromContent(input.content).trim())) {
      return { valid: false, message: "已连接的文字节点内容为空，请先填写并保存" };
    }
    return { valid: true, message: "文生视频条件检查通过" };
  }

  if (mode === "first-last-frame") {
    if (audios.length || videos.length) {
      return { valid: false, message: "首尾帧模式不能接入音频或视频" };
    }
    if (!images.length) {
      return { valid: false, message: "首尾帧模式至少需要一张图片" };
    }
    if (images.length > 2) {
      return { valid: false, message: "首尾帧模式最多只能接入两张图片" };
    }
    const roles = images.map((image, index) => frameRoleFromContent(content, image.id, index));
    if (roles.length === 2 && roles[0] === roles[1]) {
      return { valid: false, message: "两张图片必须分别指定为首帧和尾帧" };
    }
    return { valid: true, message: "首尾帧条件检查通过" };
  }

  if (!mediaInputs.length) {
    return { valid: false, message: "参考生视频至少需要一个图片或音频素材" };
  }
  if (textInputs.length !== 1) {
    return { valid: false, message: "当前参考工作流必须且只能连接一个文字提示词节点" };
  }
  if (!textFromContent(textInputs[0].content).trim()) {
    return { valid: false, message: "已连接的文字节点内容为空，请先填写并保存" };
  }
  if (images.length > 9) {
    return { valid: false, message: "当前参考工作流最多支持9张图片" };
  }
  if (audios.length > 2) {
    return { valid: false, message: "当前参考工作流最多支持2个音频" };
  }
  if (videos.length) {
    return { valid: false, message: "当前参考工作流尚未配置视频参考输入" };
  }
  return {
    valid: true,
    message: `参考生视频条件检查通过：${images.length} 张图片、${audios.length} 个音频、${videos.length} 个视频`,
  };
}

function textFromContent(content: JsonObject): string {
  return typeof content.text === "string" ? content.text : JSON.stringify(content, null, 2);
}

function toFlowEdge(edge: EdgeRecord): Edge {
  return {
    id: edge.id,
    source: edge.sourceNodeId,
    target: edge.targetNodeId,
    type: "canvasEdge",
    className: "canvas-edge",
    animated: false,
    data: { record: edge },
  };
}

function CanvasEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const onDisconnect = (data as CanvasEdgeData | undefined)?.onDisconnect;
  const disconnect = () => onDisconnect?.(id);

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={style}
        className="canvas-edge"
        interactionWidth={24}
      />
      {onDisconnect && (
        <g
          className="canvas-edge-disconnect nodrag nopan"
          transform={`translate(${labelX} ${labelY})`}
          role="button"
          tabIndex={0}
          aria-label="断开连线"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            disconnect();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            disconnect();
          }}
        >
          <circle r="11" />
          <path d="M -3.5 -3.5 L 3.5 3.5 M 3.5 -3.5 L -3.5 3.5" />
        </g>
      )}
    </>
  );
}

const edgeTypes = { canvasEdge: CanvasEdge };

function CanvasNode({ id, data, selected }: NodeProps<CanvasFlowNode>) {
  const { getZoom } = useReactFlow<CanvasFlowNode, Edge>();
  const {
    record,
    matched,
    inputCount,
    mediaInputs,
    textInputCount,
    textInputs,
    queuePosition,
    onChange,
    onSave,
    onExecutionCheck,
    onExecute,
    onSecondarySample,
    onCancelExecution,
    onRevealGeneratedVideo,
    onRemoveInput,
    onDelete,
    onCopy,
  } = data;
  const [copied, setCopied] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(record.title);
  const [expanded, setExpanded] = useState(false);
  const [connectedTextEditor, setConnectedTextEditor] = useState<{
    id: string;
    title: string;
    content: JsonObject;
    text: string;
    savedText: string;
    saving: boolean;
  } | null>(null);
  const [draggedMediaId, setDraggedMediaId] = useState<string | null>(null);
  const [dragOverMediaId, setDragOverMediaId] = useState<string | null>(null);
  const [removingMediaId, setRemovingMediaId] = useState<string | null>(null);
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState(() => textFromContent(record.content));
  const [textDirty, setTextDirty] = useState(false);
  const [savingText, setSavingText] = useState(false);
  const [textEditorFocused, setTextEditorFocused] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const audioPreviewRefs = useRef(new Map<string, HTMLAudioElement>());
  const generatedVideoRef = useRef<HTMLVideoElement | null>(null);
  const videoResizeBaseRef = useRef<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const videoResizePointerRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    zoom: number;
    direction: readonly [number, number];
  } | null>(null);
  const videoResizeFrameRef = useRef<number | null>(null);
  const savedText = textFromContent(record.content);
  const isText = record.kind === "text";
  const isNote = record.kind === "note";
  const isImage = record.kind === "image";
  const isAudioAsset = record.kind === "audio";
  const isVideoAsset = record.kind === "video";
  const isVideoGeneration = record.kind === "video-generation";
  const isGeneratedVideo = record.kind === "generated-video";
  const videoGenerationMode = videoGenerationModeFromContent(record.content);
  const videoDuration = videoDurationFromContent(record.content);
  const primaryVideoResolution = primaryVideoResolutionFromContent(record.content);
  const secondaryVideoResolution = secondaryVideoResolutionFromContent(record.content);
  const seedMode = seedModeFromContent(record.content);
  const fixedSeed = fixedSeedFromContent(record.content);
  const validationStatus = record.content.status === "ready"
    ? "valid"
    : record.content.status === "succeeded"
      ? "valid"
      : record.content.status === "warning"
        ? "warning"
      : record.content.status === "running" || record.content.status === "cancelling"
        ? "running"
    : record.content.status === "invalid"
      ? "invalid"
      : null;
  const validationMessage = typeof record.content.validationMessage === "string"
    ? record.content.validationMessage
    : "";
  const assetPath = typeof record.content.assetPath === "string" ? record.content.assetPath : "";
  const originalName = typeof record.content.originalName === "string"
    ? record.content.originalName
    : record.title;
  const savedAspectRatio = typeof record.content.aspectRatio === "number"
    ? record.content.aspectRatio
    : null;
  const generatedVideoUrl = typeof record.content.videoUrl === "string"
    ? record.content.videoUrl
    : "";
  const generatedVideoSeed = typeof record.content.seed === "string"
    ? record.content.seed
    : "";
  const executionRunning = record.content.status === "running"
    || record.content.status === "cancelling";
  const executionCancelling = record.content.status === "cancelling";
  const executionProgress = typeof record.content.executionProgress === "number"
    && Number.isFinite(record.content.executionProgress)
    ? Math.max(0, Math.min(100, record.content.executionProgress))
    : null;
  const mediaInputGroups = [
    { kind: "image", label: "图片", inputs: mediaInputs.filter((input) => input.kind === "image") },
    { kind: "audio", label: "音频", inputs: mediaInputs.filter((input) => input.kind === "audio") },
    { kind: "video", label: "视频", inputs: mediaInputs.filter((input) => input.kind === "video") },
  ].filter((group) => group.inputs.length > 0);

  useEffect(() => {
    if (!editingTitle) setTitleDraft(record.title);
  }, [editingTitle, record.title]);

  useEffect(() => {
    if (!isGeneratedVideo || !generatedVideoUrl) return;
    const video = generatedVideoRef.current;
    if (!video) return;
    if (video.getAttribute("src") !== generatedVideoUrl) {
      video.src = generatedVideoUrl;
      video.load();
    }
    return () => {
      video.pause();
      if (video.readyState > 0) video.currentTime = 0;
    };
  }, [generatedVideoUrl, isGeneratedVideo]);

  useEffect(() => {
    if (!isGeneratedVideo) return;
    const normalizedTitle = normalizedGeneratedVideoTitle(record.title);
    if (normalizedTitle !== record.title) onChange(id, { title: normalizedTitle });
  }, [id, isGeneratedVideo, onChange, record.title]);

  useEffect(() => {
    if (!isGeneratedVideo || !validationMessage.startsWith("二采完成")) return;
    onChange(id, {
      content: {
        ...record.content,
        status: "idle",
        executionProgress: null,
        validationMessage: "",
      },
    });
  }, [id, isGeneratedVideo, onChange, record.content, validationMessage]);

  useEffect(() => {
    if (!textDirty) setTextDraft(savedText);
  }, [savedText, textDirty]);

  useEffect(() => () => {
    if (videoResizeFrameRef.current !== null) {
      window.cancelAnimationFrame(videoResizeFrameRef.current);
    }
  }, []);

  useEffect(() => {
    if (!editingTitle) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [editingTitle]);

  useEffect(() => {
    if (!expanded && !connectedTextEditor) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (connectedTextEditor) setConnectedTextEditor(null);
      else setExpanded(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [connectedTextEditor, expanded]);

  const finishTitleEdit = () => {
    if (titleDraft !== record.title) onChange(id, { title: titleDraft });
    setEditingTitle(false);
  };

  const changeText = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const nextText = event.currentTarget.value;
    setTextDraft(nextText);
    setTextDirty(nextText !== savedText);
  };

  const saveText = async () => {
    if (!textDirty || savingText) return;
    setSavingText(true);
    const saved = await onSave(id, {
      content: { ...record.content, text: textDraft },
    });
    if (saved) setTextDirty(false);
    setSavingText(false);
  };

  const openConnectedTextEditor = (input: NodeRecord) => {
    const inputText = textFromContent(input.content);
    setConnectedTextEditor({
      id: input.id,
      title: input.title || "未命名文本",
      content: input.content,
      text: inputText,
      savedText: inputText,
      saving: false,
    });
  };

  const saveConnectedText = async () => {
    if (
      !connectedTextEditor
      || connectedTextEditor.saving
      || connectedTextEditor.text === connectedTextEditor.savedText
    ) return;
    const editorId = connectedTextEditor.id;
    const textToSave = connectedTextEditor.text;
    const nextContent = { ...connectedTextEditor.content, text: textToSave };
    setConnectedTextEditor((current) => current ? { ...current, saving: true } : current);
    const saved = await onSave(editorId, { content: nextContent });
    setConnectedTextEditor((current) => {
      if (!current || current.id !== editorId) return current;
      return saved
        ? { ...current, content: nextContent, savedText: textToSave, saving: false }
        : { ...current, saving: false };
    });
  };

  const copyText = async () => {
    onCopy(textDraft);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  const copyGeneratedSeed = () => {
    if (!generatedVideoSeed) return;
    onCopy(generatedVideoSeed);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  const stopGeneratedVideoPlayback = () => {
    const video = generatedVideoRef.current;
    if (!video) return;
    video.pause();
    if (video.readyState > 0) video.currentTime = 0;
  };

  const applyNaturalMediaRatio = (naturalWidth: number, naturalHeight: number) => {
    if (savedAspectRatio || naturalWidth <= 0 || naturalHeight <= 0) return;
    const aspectRatio = naturalWidth / naturalHeight;
    const fittedHeight = Math.min(
      2400,
      Math.max(180, record.width / aspectRatio + MEDIA_NODE_CHROME_HEIGHT),
    );
    onChange(id, {
      content: {
        ...record.content,
        aspectRatio,
        naturalWidth,
        naturalHeight,
      },
      height: fittedHeight,
    });
  };

  const queueConstrainedVideoResize = (
    params: { x: number; y: number; width: number; height: number },
    direction: readonly number[],
  ) => {
    const base = videoResizeBaseRef.current ?? {
      x: record.x,
      y: record.y,
      width: record.width,
      height: record.height,
    };
    const aspectRatio = savedAspectRatio
      ?? base.width / Math.max(1, base.height - MEDIA_NODE_CHROME_HEIGHT);
    let width: number;
    let height: number;
    if (direction[0] !== 0) {
      width = Math.max(260, params.width);
      height = width / aspectRatio + MEDIA_NODE_CHROME_HEIGHT;
    } else {
      height = Math.max(180, params.height);
      width = (height - MEDIA_NODE_CHROME_HEIGHT) * aspectRatio;
      if (width < 260) {
        width = 260;
        height = width / aspectRatio + MEDIA_NODE_CHROME_HEIGHT;
      }
    }
    const horizontalDirection = direction[0] ?? 0;
    const verticalDirection = direction[1] ?? 0;
    const x = horizontalDirection < 0
      ? base.x + base.width - width
      : horizontalDirection > 0
        ? base.x
        : base.x + (base.width - width) / 2;
    const y = verticalDirection < 0
      ? base.y + base.height - height
      : verticalDirection > 0
        ? base.y
        : base.y + (base.height - height) / 2;
    if (videoResizeFrameRef.current !== null) {
      window.cancelAnimationFrame(videoResizeFrameRef.current);
    }
    videoResizeFrameRef.current = window.requestAnimationFrame(() => {
      videoResizeFrameRef.current = null;
      onChange(id, { x, y, width, height });
    });
  };

  const beginVideoResize = (
    event: ReactPointerEvent<HTMLDivElement>,
    direction: readonly [number, number],
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    videoResizeBaseRef.current = {
      x: record.x,
      y: record.y,
      width: record.width,
      height: record.height,
    };
    videoResizePointerRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      zoom: Math.max(0.01, getZoom()),
      direction,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveVideoResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = videoResizePointerRef.current;
    const base = videoResizeBaseRef.current;
    if (!drag || !base || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const deltaX = (event.clientX - drag.clientX) / drag.zoom;
    const deltaY = (event.clientY - drag.clientY) / drag.zoom;
    const [horizontalDirection, verticalDirection] = drag.direction;
    let width = base.width;
    let height = base.height;
    if (horizontalDirection !== 0 && verticalDirection !== 0) {
      const aspectRatio = savedAspectRatio
        ?? base.width / Math.max(1, base.height - MEDIA_NODE_CHROME_HEIGHT);
      const widthDelta = (
        horizontalDirection * deltaX
        + verticalDirection * deltaY / aspectRatio
      ) / (1 + 1 / (aspectRatio * aspectRatio));
      width += widthDelta;
    } else if (horizontalDirection !== 0) {
      width += horizontalDirection * deltaX;
    } else {
      height += verticalDirection * deltaY;
    }
    queueConstrainedVideoResize(
      { x: base.x, y: base.y, width, height },
      drag.direction,
    );
  };

  const finishVideoResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (videoResizePointerRef.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    videoResizePointerRef.current = null;
    videoResizeBaseRef.current = null;
  };

  const moveMediaInput = (sourceId: string, targetIndex: number) => {
    const orderedIds = mediaInputs.map((input) => input.id);
    const sourceIndex = orderedIds.indexOf(sourceId);
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= orderedIds.length) return;
    const nextOrder = [...orderedIds];
    const [movedId] = nextOrder.splice(sourceIndex, 1);
    nextOrder.splice(targetIndex, 0, movedId);
    if (nextOrder.every((inputId, index) => inputId === orderedIds[index])) return;
    onChange(id, {
      content: { ...record.content, mediaInputOrder: nextOrder },
    });
  };

  const mediaInputIdAtPoint = (clientX: number, clientY: number): string | null => {
    const target = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>("[data-media-input-id]");
    return target?.dataset.mediaInputId ?? null;
  };

  const moveMediaInputTo = (sourceId: string, targetId: string | null) => {
    const source = mediaInputs.find((input) => input.id === sourceId);
    const target = mediaInputs.find((input) => input.id === targetId);
    if (!source || !target || source.kind !== target.kind) return;
    moveMediaInput(sourceId, mediaInputs.indexOf(target));
  };

  const setFrameRole = (sourceId: string, role: FrameRole) => {
    const imageInputs = mediaInputs.filter((input) => input.kind === "image");
    const nextRoles: Record<string, FrameRole> = {};
    imageInputs.forEach((image, index) => {
      nextRoles[image.id] = frameRoleFromContent(record.content, image.id, index);
    });
    nextRoles[sourceId] = role;
    const otherImage = imageInputs.find(
      (image) => image.id !== sourceId && nextRoles[image.id] === role,
    );
    if (otherImage) nextRoles[otherImage.id] = role === "first" ? "last" : "first";
    onChange(id, {
      content: {
        ...record.content,
        frameRoles: nextRoles,
        status: "idle",
        validationMessage: "",
      },
    });
  };

  const checkAndExecute = async () => {
    const result = validateVideoExecution(
      videoGenerationMode,
      record.content,
      mediaInputs,
      textInputs,
    );
    const duplicateFixedSeed = result.valid
      && seedMode === "fixed"
      && generatedSeedsFromContent(record.content).includes(fixedSeed);
    if (duplicateFixedSeed) {
      const message = `固定种子 ${fixedSeed} 已经生成过，无需重复生成`;
      onChange(id, {
        content: {
          ...record.content,
          status: "warning",
          validationMessage: message,
        },
      });
      onExecutionCheck(message, true);
      return;
    }
    onChange(id, {
      content: {
        ...record.content,
        status: result.valid ? "ready" : "invalid",
        validationMessage: result.message,
      },
    });
    onExecutionCheck(result.message, result.valid);
    if (!result.valid) return;
    await onExecute(id);
  };

  const removeConnectedInput = async (sourceId: string) => {
    if (removingMediaId) return;
    setRemovingMediaId(sourceId);
    try {
      await onRemoveInput(id, sourceId);
    } finally {
      setRemovingMediaId(null);
    }
  };

  const toggleAudioPreview = async (inputId: string) => {
    const audio = audioPreviewRefs.current.get(inputId);
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    audioPreviewRefs.current.forEach((candidate, candidateId) => {
      if (candidateId !== inputId && !candidate.paused) candidate.pause();
    });
    try {
      await audio.play();
      setPlayingAudioId(inputId);
    } catch {
      setPlayingAudioId(null);
    }
  };

  return (
    <>
    <article className={`canvas-node kind-${record.kind} ${matched ? "" : "is-dimmed"}`}>
      <NodeResizer
        minWidth={260}
        minHeight={isAudioAsset ? AUDIO_NODE_MIN_HEIGHT : 180}
        isVisible={selected && !isVideoAsset && !isGeneratedVideo}
        lineClassName="node-resize-line"
        handleClassName="node-resize-handle"
        onResizeEnd={(_, params) => {
          onChange(id, {
            width: params.width,
            height: params.height,
            ...(isVideoGeneration
              ? { content: { ...record.content, manualHeight: params.height } }
              : {}),
          });
        }}
      />
      {selected && (isVideoAsset || isGeneratedVideo) && VIDEO_RESIZE_CONTROLS.map((control) => (
        <div
          key={control.position}
          className={`nodrag video-ratio-resizer is-${control.position}`}
          aria-hidden="true"
          onPointerDown={(event) => beginVideoResize(event, control.direction)}
          onPointerMove={moveVideoResize}
          onPointerUp={finishVideoResize}
          onPointerCancel={finishVideoResize}
          onLostPointerCapture={finishVideoResize}
        />
      ))}
      {(isVideoGeneration || isGeneratedVideo) && (
        <Handle type="target" position={Position.Left} className="node-handle target-handle" />
      )}
      <header className="node-header">
        <span className="node-kind-icon">
          {isImage
            ? <ImageIcon size={14} />
            : isNote
              ? <StickyNote size={14} />
            : isAudioAsset
              ? <Music size={14} />
              : isVideoAsset || isGeneratedVideo
              ? <Film size={14} />
              : isVideoGeneration
                ? <Clapperboard size={14} />
                : <FileText size={14} />}
        </span>
        <div className="node-title-group">
          {editingTitle ? (
            <input
              ref={titleInputRef}
              className="nodrag node-title node-title-editor"
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.currentTarget.value)}
              onBlur={finishTitleEdit}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setTitleDraft(record.title);
                  setEditingTitle(false);
                }
              }}
              aria-label="节点标题"
              spellCheck={false}
            />
          ) : (
            <span
              className="node-title node-title-display"
              title="双击修改标题"
              onDoubleClick={(event) => {
                event.stopPropagation();
                setEditingTitle(true);
              }}
            >
              {record.title || "未命名节点"}
            </span>
          )}
        </div>
        {(isText || isNote) && (
          <button
            className="nodrag node-action"
            onClick={() => setExpanded(true)}
            title="放大编辑"
            aria-label="放大编辑"
          >
            <Maximize2 size={13} />
          </button>
        )}
        {isGeneratedVideo && generatedVideoUrl && (
          <button
            className={`nodrag node-action generated-video-secondary-action ${executionRunning ? "is-cancel" : ""}`}
            disabled={executionCancelling}
            onClick={() => {
              if (executionRunning) void onCancelExecution(id);
              else void onSecondarySample(id);
            }}
            title={executionRunning ? "取消这次二采" : "单独对当前预览视频进行二采"}
            aria-label={executionRunning ? "取消二采" : "二采当前视频"}
          >
            {executionRunning
              ? <Square size={11} fill="currentColor" />
              : <Sparkles size={12} />}
          </button>
        )}
        {isGeneratedVideo && generatedVideoUrl && (
          <button
            className="nodrag node-action"
            onClick={() => void onRevealGeneratedVideo(id)}
            title="在 Windows 资源管理器中定位视频"
            aria-label="在 Windows 资源管理器中定位视频"
          >
            <FolderOpen size={13} />
          </button>
        )}
        {(isText || isNote) && (
          <button className="nodrag node-action" onClick={copyText} title="复制内容">
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        )}
        <button
          className="nodrag node-action danger"
          onClick={() => {
            if (isGeneratedVideo) stopGeneratedVideoPlayback();
            onDelete(id);
          }}
          title="删除节点"
        >
          <Trash2 size={14} />
        </button>
      </header>
      {(isText || isNote) && (
        <div className="text-editor-shell">
          <textarea
            className={`nodrag node-editor ${textEditorFocused ? "nowheel" : ""}`}
            value={textDraft}
            onChange={changeText}
            onFocus={() => setTextEditorFocused(true)}
            onBlur={() => setTextEditorFocused(false)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                void saveText();
              }
            }}
            aria-label="文本内容"
            spellCheck={false}
          />
          <button
            type="button"
            className="nodrag node-text-save"
            onClick={() => void saveText()}
            disabled={!textDirty || savingText}
            title={textDirty ? "保存文本（Ctrl+S）" : "内容已保存"}
          >
            <Save size={13} />
          </button>
        </div>
      )}
      {(isImage || isAudioAsset || isVideoAsset || isGeneratedVideo) && (
        <div className="nodrag media-node-body">
          {assetPath && isImage ? (
            <img
              src={convertFileSrc(assetPath)}
              alt={originalName}
              draggable={false}
              onLoad={(event) => applyNaturalMediaRatio(
                event.currentTarget.naturalWidth,
                event.currentTarget.naturalHeight,
              )}
            />
          ) : assetPath && isAudioAsset ? (
            <div className="audio-node-player">
              <Music size={28} />
              <audio src={convertFileSrc(assetPath)} controls preload="metadata" />
            </div>
          ) : assetPath && isVideoAsset ? (
            <video
              src={convertFileSrc(assetPath)}
              controls
              preload="metadata"
              onLoadedMetadata={(event) => applyNaturalMediaRatio(
                event.currentTarget.videoWidth,
                event.currentTarget.videoHeight,
              )}
            />
          ) : generatedVideoUrl && isGeneratedVideo ? (
            <>
              <video
                ref={generatedVideoRef}
                src={generatedVideoUrl}
                controls
                preload="metadata"
                onLoadedMetadata={(event) => applyNaturalMediaRatio(
                  event.currentTarget.videoWidth,
                  event.currentTarget.videoHeight,
                )}
              />
              {validationStatus && validationMessage && (
                <div className={`generated-video-execution is-${validationStatus}`}>
                  <span title={validationMessage}>{validationMessage}</span>
                  {executionRunning && (
                    <div
                      className={`video-execution-progress ${executionProgress === null ? "is-indeterminate" : ""}`}
                      role="progressbar"
                      aria-label="二采当前步骤进度"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={executionProgress ?? undefined}
                    >
                      <span style={executionProgress === null ? undefined : { width: `${executionProgress}%` }} />
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="asset-error">媒体资源不可用</div>
          )}
        </div>
      )}
      {isVideoGeneration && (
        <div className={`nodrag video-node-body ${mediaInputs.length ? "has-media" : ""}`}>
          <div className="video-mode-selector" aria-label="视频生成模式">
            {VIDEO_GENERATION_MODES.map((mode) => (
              <button
                key={mode.value}
                type="button"
                className={videoGenerationMode === mode.value ? "is-active" : ""}
                aria-pressed={videoGenerationMode === mode.value}
                onClick={() => onChange(id, {
                  content: {
                    ...record.content,
                    generationMode: mode.value,
                    status: "idle",
                    validationMessage: "",
                  },
                })}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <label className="video-duration-control">
            <span>生成时长</span>
            <span className="video-parameter-toggle-spacer" aria-hidden="true" />
            <input
              className="video-parameter-range"
              type="range"
              min="2"
              max="15"
              step="1"
              value={videoDuration}
              onChange={(event) => onChange(id, {
                content: {
                  ...record.content,
                  generationDuration: Number(event.currentTarget.value),
                  status: "idle",
                  validationMessage: "",
                },
              })}
              onPointerDown={(event) => event.stopPropagation()}
              aria-label="生成时长"
            />
            <output className="video-parameter-value">{videoDuration} 秒</output>
          </label>
          <div className="video-resolution-pair" aria-label="一采和二采分辨率">
            <label className="video-resolution-inline">
              <span>一采</span>
              <input
                className="video-parameter-range"
                type="range"
                min="0.2"
                max="2.0"
                step="0.1"
                value={primaryVideoResolution}
                onChange={(event) => onChange(id, {
                  content: {
                    ...record.content,
                    generationPrimaryResolution: Number(event.currentTarget.value),
                    status: "idle",
                    validationMessage: "",
                  },
                })}
                onPointerDown={(event) => event.stopPropagation()}
                aria-label="一采分辨率"
              />
              <output>{primaryVideoResolution.toFixed(1)} MP</output>
            </label>
            <label className="video-resolution-inline">
              <span>二采</span>
              <input
                className="video-parameter-range"
                type="range"
                min="0.2"
                max="2.0"
                step="0.1"
                value={secondaryVideoResolution}
                onChange={(event) => onChange(id, {
                  content: {
                    ...record.content,
                    generationSecondaryResolution: Number(event.currentTarget.value),
                    status: "idle",
                    validationMessage: "",
                  },
                })}
                onPointerDown={(event) => event.stopPropagation()}
                aria-label="二采分辨率"
              />
              <output>{secondaryVideoResolution.toFixed(1)} MP</output>
            </label>
          </div>
          <div className="video-seed-control">
            <span>生成种子</span>
            <div className="video-seed-mode" aria-label="种子模式">
              {(["random", "fixed"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={seedMode === mode ? "is-active" : ""}
                  aria-pressed={seedMode === mode}
                  onClick={() => onChange(id, {
                    content: {
                      ...record.content,
                      seedMode: mode,
                      status: "idle",
                      validationMessage: "",
                    },
                  })}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  {mode === "random" ? "随机" : "固定"}
                </button>
              ))}
            </div>
            {seedMode === "fixed" ? (
              <div className="video-seed-fixed">
                <input
                  className="video-seed-input"
                  type="text"
                  inputMode="numeric"
                  maxLength={20}
                  value={fixedSeed}
                  onChange={(event) => onChange(id, {
                    content: {
                      ...record.content,
                      generationSeed: event.currentTarget.value.replace(/\D/g, ""),
                      status: "idle",
                      validationMessage: "",
                    },
                  })}
                  onPointerDown={(event) => event.stopPropagation()}
                  aria-label="固定种子"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="video-seed-randomize"
                  title="随机生成固定种子"
                  aria-label="随机生成固定种子"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => onChange(id, {
                    content: {
                      ...record.content,
                      generationSeed: randomFixedSeed(),
                      status: "idle",
                      validationMessage: "",
                    },
                  })}
                >
                  <Dices size={14} />
                </button>
              </div>
            ) : (
              <span className="video-seed-hint">每次生成自动更换</span>
            )}
          </div>
          {textInputs.length > 0 && (
            <section className="video-input-group is-text video-text-input-group">
              <div className="video-input-group-heading">
                <FileText size={13} />
                <strong>文本</strong>
                <span>{textInputs.length}</span>
              </div>
              <ol className="video-input-list" aria-label="文本输入">
                {textInputs.map((input, index) => {
                  const inputText = textFromContent(input.content).trim().replace(/\s+/g, " ");
                  return (
                    <li key={input.id} className="video-input-item">
                      <span className="video-input-index">{index + 1}</span>
                      <span className="video-input-preview is-text">
                        <FileText size={16} />
                      </span>
                      <span className="video-input-copy">
                        <strong title={input.title}>{input.title || "未命名文本"}</strong>
                        <span className="video-text-input-preview" title={inputText}>
                          {inputText || "空文本"}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="nodrag video-input-expand"
                        aria-label={"放大编辑文本：" + (input.title || "未命名文本")}
                        title="放大查看和编辑提示词"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => openConnectedTextEditor(input)}
                      >
                        <Maximize2 size={13} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="nodrag video-input-remove"
                        disabled={removingMediaId === input.id}
                        aria-label={"从视频节点移除文本：" + (input.title || "未命名文本")}
                        title="从当前视频节点移除，不删除原文本节点"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => void removeConnectedInput(input.id)}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}
          {mediaInputs.length ? (
            <>
              <div className="video-input-heading">
                <div>
                  <strong>传入媒体</strong>
                  <span>图片直接拖动；音视频拖动右侧手柄</span>
                </div>
                <span>{mediaInputs.length}</span>
              </div>
              <div className={`video-input-groups ${selected ? "nowheel" : ""}`}>
                {mediaInputGroups.map((group) => (
                  <section key={group.kind} className={`video-input-group is-${group.kind}`}>
                    <div className="video-input-group-heading">
                      {group.kind === "image"
                        ? <ImageIcon size={13} />
                        : group.kind === "audio"
                          ? <Music size={13} />
                          : <Film size={13} />}
                      <strong>{group.label}</strong>
                      <span>{group.inputs.length}</span>
                    </div>
                    <ol
                      className={`video-input-list ${group.kind === "image" ? "is-image-grid" : ""} ${group.kind === "audio" ? "is-audio-grid" : ""}`}
                      aria-label={`${group.label}输入顺序`}
                    >
                      {group.inputs.map((input, index) => {
                        const inputAssetPath = typeof input.content.assetPath === "string"
                          ? input.content.assetPath
                          : "";
                        const inputName = typeof input.content.originalName === "string"
                          ? input.content.originalName
                          : input.title;
                        return (
                          <li
                            key={input.id}
                            data-media-input-id={input.id}
                            className={`video-input-item ${input.kind === "image" ? "is-image-tile nodrag" : ""} ${input.kind === "audio" ? "is-audio-tile" : ""} ${draggedMediaId === input.id ? "is-dragging" : ""} ${dragOverMediaId === input.id ? "is-drop-target" : ""}`}
                            title={input.kind === "image" || input.kind === "audio" ? inputName : undefined}
                            tabIndex={input.kind === "image" ? 0 : undefined}
                            aria-label={input.kind === "image" ? `图片 ${index + 1}：${inputName}` : undefined}
                            onPointerDown={(event) => {
                              if (input.kind !== "image" || event.button !== 0) return;
                              event.preventDefault();
                              event.stopPropagation();
                              event.currentTarget.setPointerCapture(event.pointerId);
                              setDraggedMediaId(input.id);
                              setDragOverMediaId(null);
                            }}
                            onPointerMove={(event) => {
                              if (
                                input.kind !== "image"
                                || !event.currentTarget.hasPointerCapture(event.pointerId)
                              ) return;
                              event.preventDefault();
                              event.stopPropagation();
                              const targetId = mediaInputIdAtPoint(event.clientX, event.clientY);
                              const target = mediaInputs.find((candidate) => candidate.id === targetId);
                              const reorderTarget = target
                                && target.id !== input.id
                                && target.kind === input.kind
                                ? target
                                : null;
                              setDragOverMediaId(reorderTarget?.id ?? null);
                              if (reorderTarget) moveMediaInputTo(input.id, reorderTarget.id);
                            }}
                            onPointerUp={(event) => {
                              if (
                                input.kind !== "image"
                                || !event.currentTarget.hasPointerCapture(event.pointerId)
                              ) return;
                              event.preventDefault();
                              event.stopPropagation();
                              moveMediaInputTo(
                                input.id,
                                mediaInputIdAtPoint(event.clientX, event.clientY),
                              );
                              event.currentTarget.releasePointerCapture(event.pointerId);
                              setDraggedMediaId(null);
                              setDragOverMediaId(null);
                            }}
                            onPointerCancel={(event) => {
                              if (input.kind !== "image") return;
                              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                                event.currentTarget.releasePointerCapture(event.pointerId);
                              }
                              setDraggedMediaId(null);
                              setDragOverMediaId(null);
                            }}
                            onLostPointerCapture={() => {
                              if (input.kind !== "image") return;
                              setDraggedMediaId(null);
                              setDragOverMediaId(null);
                            }}
                            onKeyDown={(event) => {
                              if (input.kind !== "image" || event.target !== event.currentTarget) return;
                              if (event.key === "ArrowLeft" && index > 0) {
                                event.preventDefault();
                                moveMediaInputTo(input.id, group.inputs[index - 1].id);
                              } else if (event.key === "ArrowRight" && index < group.inputs.length - 1) {
                                event.preventDefault();
                                moveMediaInputTo(input.id, group.inputs[index + 1].id);
                              }
                            }}
                          >
                            <span className="video-input-index">{index + 1}</span>
                            {input.kind === "audio" ? (
                              <>
                                <button
                                  type="button"
                                  className={`nodrag video-audio-play ${playingAudioId === input.id ? "is-playing" : ""}`}
                                  disabled={!inputAssetPath}
                                  aria-label={`${playingAudioId === input.id ? "暂停" : "播放"}${inputName}`}
                                  title={playingAudioId === input.id ? "暂停试听" : "播放试听"}
                                  onPointerDown={(event) => event.stopPropagation()}
                                  onClick={() => void toggleAudioPreview(input.id)}
                                >
                                  {playingAudioId === input.id
                                    ? <Pause size={12} fill="currentColor" />
                                    : <Play size={12} fill="currentColor" />}
                                </button>
                                {inputAssetPath && (
                                  <audio
                                    className="video-audio-preview-element"
                                    ref={(element) => {
                                      if (element) audioPreviewRefs.current.set(input.id, element);
                                      else audioPreviewRefs.current.delete(input.id);
                                    }}
                                    src={convertFileSrc(inputAssetPath)}
                                    preload="metadata"
                                    onPlay={() => setPlayingAudioId(input.id)}
                                    onPause={() => setPlayingAudioId((current) => (
                                      current === input.id ? null : current
                                    ))}
                                    onEnded={() => setPlayingAudioId((current) => (
                                      current === input.id ? null : current
                                    ))}
                                  />
                                )}
                              </>
                            ) : <span className={`video-input-preview is-${input.kind}`}>
                              {inputAssetPath && input.kind === "image" ? (
                                <img src={convertFileSrc(inputAssetPath)} alt="" draggable={false} />
                              ) : inputAssetPath && input.kind === "video" ? (
                                <video src={convertFileSrc(inputAssetPath)} muted preload="metadata" draggable={false} />
                              ) : input.kind === "image" ? (
                                <ImageIcon size={16} />
                              ) : input.kind === "audio" ? (
                                <Music size={16} />
                              ) : (
                                <Film size={16} />
                              )}
                            </span>}
                            {input.kind !== "image" && (
                              <span className="video-input-copy">
                                <strong title={inputName}>{inputName}</strong>
                                {input.kind !== "audio" && <span>{group.label}</span>}
                              </span>
                            )}
                            {videoGenerationMode === "first-last-frame" && input.kind === "image" && (
                              <select
                                className="nodrag frame-role-select is-image-tile-role"
                                value={frameRoleFromContent(record.content, input.id, index)}
                                onChange={(event) => setFrameRole(
                                  input.id,
                                  event.currentTarget.value as FrameRole,
                                )}
                                onPointerDown={(event) => event.stopPropagation()}
                                aria-label={`${inputName}的帧位置`}
                              >
                                <option value="first">首帧</option>
                                <option value="last">尾帧</option>
                              </select>
                            )}
                            <button
                              type="button"
                              className="nodrag video-input-remove"
                              disabled={removingMediaId === input.id}
                              aria-label={`从视频节点移除${inputName}`}
                              title="从当前视频节点移除，不删除原素材"
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={() => void removeConnectedInput(input.id)}
                            >
                              <Trash2 size={13} aria-hidden="true" />
                            </button>
                            {input.kind !== "image" && (
                            <button
                              type="button"
                              className="nodrag video-input-drag"
                              aria-label={`调整${group.label}第 ${index + 1} 项：${inputName}`}
                              title="在当前分类内拖动调整顺序；也可用上下方向键"
                              onPointerDown={(event) => {
                                if (event.button !== 0) return;
                                event.preventDefault();
                                event.stopPropagation();
                                event.currentTarget.setPointerCapture(event.pointerId);
                                setDraggedMediaId(input.id);
                                setDragOverMediaId(null);
                              }}
                              onPointerMove={(event) => {
                                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                                event.preventDefault();
                                event.stopPropagation();
                                const targetId = mediaInputIdAtPoint(event.clientX, event.clientY);
                                const target = mediaInputs.find((candidate) => candidate.id === targetId);
                                setDragOverMediaId(
                                  target && target.id !== input.id && target.kind === input.kind
                                    ? target.id
                                    : null,
                                );
                              }}
                              onPointerUp={(event) => {
                                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                                event.preventDefault();
                                event.stopPropagation();
                                moveMediaInputTo(
                                  input.id,
                                  mediaInputIdAtPoint(event.clientX, event.clientY),
                                );
                                event.currentTarget.releasePointerCapture(event.pointerId);
                                setDraggedMediaId(null);
                                setDragOverMediaId(null);
                              }}
                              onPointerCancel={(event) => {
                                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                                  event.currentTarget.releasePointerCapture(event.pointerId);
                                }
                                setDraggedMediaId(null);
                                setDragOverMediaId(null);
                              }}
                              onLostPointerCapture={() => {
                                setDraggedMediaId(null);
                                setDragOverMediaId(null);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "ArrowUp" && index > 0) {
                                  event.preventDefault();
                                  moveMediaInputTo(input.id, group.inputs[index - 1].id);
                                } else if (event.key === "ArrowDown" && index < group.inputs.length - 1) {
                                  event.preventDefault();
                                  moveMediaInputTo(input.id, group.inputs[index + 1].id);
                                }
                              }}
                            >
                              <GripVertical size={15} />
                            </button>
                            )}
                          </li>
                        );
                      })}
                    </ol>
                  </section>
                ))}
              </div>
            </>
          ) : (
            <div className="video-node-empty">
              <div className="video-placeholder"><Clapperboard size={28} /></div>
              <strong>视频生成节点</strong>
              <span>
                {videoGenerationMode === "text-to-video"
                  ? (textInputCount ? "文字提示词已连接，可以开始检查" : "从左侧连接文字提示词")
                  : videoGenerationMode === "first-last-frame"
                    ? "连接一至两张图片，并指定首帧或尾帧"
                    : (inputCount
                      ? "已连接文本提示词，可继续连接图片、音频或视频"
                      : "从左侧连接文本提示词、参考图片、音频或视频")}
              </span>
            </div>
          )}
          <div className="video-execution-row">
            <div className="video-execution-slot">
              {validationStatus && validationMessage ? (
                <div
                  className={`video-validation-message is-${validationStatus}`}
                  title={validationMessage}
                >
                  <span>{validationMessage}</span>
                  {executionRunning && (
                    <div
                      className={`video-execution-progress ${executionProgress === null ? "is-indeterminate" : ""}`}
                      role="progressbar"
                      aria-label="ComfyUI 当前步骤进度"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={executionProgress ?? undefined}
                    >
                      <span style={executionProgress === null ? undefined : { width: `${executionProgress}%` }} />
                    </div>
                  )}
                </div>
              ) : (
                <div className="video-validation-message is-idle">
                  <span>等待执行</span>
                </div>
              )}
            </div>
            <button
              type="button"
              className={`video-execute-button ${executionRunning ? "is-cancel" : ""}`}
              disabled={executionCancelling}
              onClick={() => {
                if (executionRunning) void onCancelExecution(id);
                else void checkAndExecute();
              }}
            >
              {executionRunning
                ? <Square size={12} fill="currentColor" />
                : <Play size={14} fill="currentColor" />}
              {executionRunning ? (executionCancelling ? "正在取消…" : "取消生成") : "开始执行"}
            </button>
          </div>
          <div className={`input-badge ${inputCount ? "has-input" : ""}`}>
            {inputCount
              ? `${mediaInputs.length} 个媒体${textInputCount ? ` · ${textInputCount} 个文本` : ""}`
              : "等待输入"}
          </div>
        </div>
      )}
      <footer className="node-footer">
        <span className={`source-dot ${record.source === "manual" ? "manual" : "external"}`} />
        <span>
          {isGeneratedVideo
            ? formattedGenerationElapsed(record.content)
            : record.source === "manual"
              ? "手动创建"
              : record.source}
        </span>
        <span className="node-footer-spacer" />
        {isGeneratedVideo && generatedVideoSeed ? (
          <div className="generated-video-seed">
            <span title={`Seed ${generatedVideoSeed}`}>Seed {generatedVideoSeed}</span>
            <button
              type="button"
              className="nodrag generated-video-seed-copy"
              onClick={copyGeneratedSeed}
              title={copied ? "Seed 已复制" : "复制 Seed"}
              aria-label={copied ? "Seed 已复制" : "复制 Seed"}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </div>
        ) : (
          <span>
            {(isText || isNote)
              ? `${textDraft.length.toLocaleString()} 字符`
              : (isImage || isAudioAsset || isVideoAsset || isGeneratedVideo)
                ? originalName
                : mediaInputs.length
                  ? `${mediaInputs.length} 个媒体输入`
                  : "尚未生成"}
          </span>
        )}
      </footer>
      {(isText || isImage || isAudioAsset || isVideoAsset || isVideoGeneration || isGeneratedVideo) && (
        <Handle type="source" position={Position.Right} className="node-handle source-handle" />
      )}
      {expanded && createPortal(
        <div className="expanded-editor-backdrop" onMouseDown={() => setExpanded(false)}>
          <section
            className={`expanded-editor-dialog ${isNote ? "is-note" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={`${record.title || "未命名节点"} 放大编辑`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="expanded-editor-header">
              <span className="node-kind-icon">
                {isNote ? <StickyNote size={15} /> : <FileText size={15} />}
              </span>
              <div>
                <strong>{record.title || "未命名节点"}</strong>
                <span>{textDraft.length.toLocaleString()} 字符{textDirty ? " · 未保存" : ""}</span>
              </div>
              <button
                className="expanded-save-button"
                onClick={() => void saveText()}
                disabled={!textDirty || savingText}
                title={textDirty ? "保存文本（Ctrl+S）" : "内容已保存"}
              >
                <Save size={15} />
                <span>{savingText ? "保存中" : "保存"}</span>
              </button>
              <button onClick={() => setExpanded(false)} title="关闭" aria-label="关闭放大编辑器">
                <X size={17} />
              </button>
            </header>
            <textarea
              className="expanded-text-editor"
              value={textDraft}
              onChange={changeText}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                  event.preventDefault();
                  void saveText();
                }
              }}
              autoFocus
              spellCheck={false}
              aria-label="放大文本内容"
            />
          </section>
        </div>,
        document.body,
      )}
      {connectedTextEditor && createPortal(
        <div
          className="expanded-editor-backdrop"
          onMouseDown={() => setConnectedTextEditor(null)}
        >
          <section
            className="expanded-editor-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`${connectedTextEditor.title} 放大编辑`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="expanded-editor-header">
              <span className="node-kind-icon"><FileText size={15} /></span>
              <div>
                <strong>{connectedTextEditor.title}</strong>
                <span>
                  {connectedTextEditor.text.length.toLocaleString()} 字符
                  {connectedTextEditor.text !== connectedTextEditor.savedText ? " · 未保存" : ""}
                </span>
              </div>
              <button
                className="expanded-save-button"
                onClick={() => void saveConnectedText()}
                disabled={
                  connectedTextEditor.saving
                  || connectedTextEditor.text === connectedTextEditor.savedText
                }
                title={
                  connectedTextEditor.text !== connectedTextEditor.savedText
                    ? "保存文本（Ctrl+S）"
                    : "内容已保存"
                }
              >
                <Save size={15} />
                <span>{connectedTextEditor.saving ? "保存中" : "保存"}</span>
              </button>
              <button
                onClick={() => setConnectedTextEditor(null)}
                title="关闭"
                aria-label="关闭提示词编辑器"
              >
                <X size={17} />
              </button>
            </header>
            <textarea
              className="expanded-text-editor"
              value={connectedTextEditor.text}
              onChange={(event) => {
                const nextText = event.currentTarget.value;
                setConnectedTextEditor((current) => (
                  current ? { ...current, text: nextText } : current
                ));
              }}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                  event.preventDefault();
                  void saveConnectedText();
                }
              }}
              autoFocus
              spellCheck={false}
              aria-label="放大提示词内容"
            />
          </section>
        </div>,
        document.body,
      )}
    </article>
    {queuePosition !== null && queuePosition > 0 && (
      <span
        className="comfy-queue-badge nodrag"
        title={`ComfyUI 等待队列第 ${queuePosition} 位`}
        aria-label={`ComfyUI 等待队列第 ${queuePosition} 位`}
      >
        {queuePosition}
      </span>
    )}
    </>
  );
}

const nodeTypes = { canvasNode: CanvasNode };

function nodePreviewColor(kind: string): string {
  if (kind === "image") return "#4eb9c8";
  if (kind === "audio") return "#c77dd6";
  if (kind === "note") return "#c8a957";
  if (kind === "video") return "#d8ad55";
  if (kind === "generated-video") return "#6fb5df";
  if (kind === "video-generation") return "#e48a65";
  return "#8b7cf6";
}

function ProjectThumbnail({ project }: { project: WorkspaceSnapshot }) {
  const preview = useMemo(() => {
    if (!project.nodes.length) return null;
    const minX = Math.min(...project.nodes.map((node) => node.x));
    const minY = Math.min(...project.nodes.map((node) => node.y));
    const maxX = Math.max(...project.nodes.map((node) => node.x + node.width));
    const maxY = Math.max(...project.nodes.map((node) => node.y + node.height));
    const padding = Math.max(50, Math.max(maxX - minX, maxY - minY) * 0.08);
    return {
      minX: minX - padding,
      minY: minY - padding,
      width: Math.max(1, maxX - minX + padding * 2),
      height: Math.max(1, maxY - minY + padding * 2),
      nodesById: new Map(project.nodes.map((node) => [node.id, node])),
    };
  }, [project.nodes]);
  const cover = project.nodes.find(
    (node) => node.kind === "image" && typeof node.content.assetPath === "string",
  );

  return (
    <div className="project-thumbnail">
      {cover && (
        <img
          className="project-cover-image"
          src={convertFileSrc(cover.content.assetPath as string)}
          alt=""
          draggable={false}
        />
      )}
      {preview ? (
        <svg
          viewBox={`${preview.minX} ${preview.minY} ${preview.width} ${preview.height}`}
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
        >
          {project.edges.map((edge) => {
            const source = preview.nodesById.get(edge.sourceNodeId);
            const target = preview.nodesById.get(edge.targetNodeId);
            if (!source || !target) return null;
            return (
              <line
                key={edge.id}
                x1={source.x + source.width}
                y1={source.y + source.height / 2}
                x2={target.x}
                y2={target.y + target.height / 2}
              />
            );
          })}
          {project.nodes.slice(0, 60).map((node) => (
            <rect
              key={node.id}
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              rx={12}
              fill={nodePreviewColor(node.kind)}
            />
          ))}
        </svg>
      ) : (
        <div className="empty-project-preview">
          <Sparkles size={24} />
          <span>空白画布</span>
        </div>
      )}
      <span className="preview-node-count">{project.nodes.length} 个节点</span>
    </div>
  );
}

function CanvasWorkspace() {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [canvasName, setCanvasName] = useState("Infinite Canvas");
  const [editingProjectName, setEditingProjectName] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [projects, setProjects] = useState<WorkspaceSnapshot[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [canvasBackground, setCanvasBackground] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [comfyOutputRoot, setComfyOutputRoot] = useState(() =>
    window.localStorage.getItem("infinite-canvas:comfy-output-root") ?? "",
  );
  const [comfyOutputRootDraft, setComfyOutputRootDraft] = useState(() =>
    window.localStorage.getItem("infinite-canvas:comfy-output-root") ?? "",
  );
  const [comfyInputRoot, setComfyInputRoot] = useState(() =>
    window.localStorage.getItem("infinite-canvas:comfy-input-root") ?? "",
  );
  const [comfyInputRootDraft, setComfyInputRootDraft] = useState(() =>
    window.localStorage.getItem("infinite-canvas:comfy-input-root") ?? "",
  );
  const [projectHomeReady, setProjectHomeReady] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<WorkspaceSnapshot | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [projectColumns, setProjectColumns] = useState(() => {
    const saved = Number(window.localStorage.getItem("infinite-canvas:project-columns"));
    return Number.isFinite(saved) && saved >= 3 && saved <= 8 ? saved : 4;
  });
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    window.localStorage.getItem("infinite-canvas:theme") === "light" ? "light" : "dark",
  );
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("正在打开画布…");
  const [comfyQueuePositions, setComfyQueuePositions] = useState<Record<string, number>>({});
  const [copiedApi, setCopiedApi] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [canvasContextMenu, setCanvasContextMenu] = useState<CanvasContextMenuState | null>(null);
  const saveTimers = useRef(new Map<string, number>());
  const pendingPatches = useRef(new Map<string, NodePatch>());
  const nodesSnapshot = useRef<CanvasFlowNode[]>([]);
  const edgesSnapshot = useRef<Edge[]>([]);
  const incomingPlacementReservations = useRef<NodeRecord[]>([]);
  const runningComfyClients = useRef(new Map<string, string>());
  const comfyQueuePollTimers = useRef(new Map<string, number>());
  const cancelledVideoNodes = useRef(new Set<string>());
  const comfyOutputRootRef = useRef(comfyOutputRoot);
  const comfyInputRootRef = useRef(comfyInputRoot);
  const makeFlowNodeRef = useRef<((record: NodeRecord, matched?: boolean) => CanvasFlowNode) | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  const projectNameInputRef = useRef<HTMLInputElement>(null);
  const deleteUndoStack = useRef<DeletedBatch[]>([]);
  const nodeClipboard = useRef<NodeClipboard | null>(null);
  const { setCenter, fitView, screenToFlowPosition } = useReactFlow<CanvasFlowNode, Edge>();

  useEffect(() => {
    nodesSnapshot.current = nodes;
    edgesSnapshot.current = edges;
  }, [edges, nodes]);

  useEffect(() => {
    window.localStorage.setItem("infinite-canvas:project-columns", String(projectColumns));
  }, [projectColumns]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("infinite-canvas:theme", theme);
  }, [theme]);

  useEffect(() => {
    comfyOutputRootRef.current = comfyOutputRoot;
  }, [comfyOutputRoot]);

  useEffect(() => {
    comfyInputRootRef.current = comfyInputRoot;
  }, [comfyInputRoot]);

  useEffect(() => () => {
    comfyQueuePollTimers.current.forEach((timer) => window.clearTimeout(timer));
    comfyQueuePollTimers.current.clear();
  }, []);

  const toggleTheme = () => setTheme((current) => current === "dark" ? "light" : "dark");

  const reportError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error);
    setNotice(`操作失败：${message}`);
  }, []);

  const persistPatch = useCallback(
    (id: string, patch: NodePatch) => {
      const previous = pendingPatches.current.get(id) ?? {};
      pendingPatches.current.set(id, { ...previous, ...patch });
      const activeTimer = saveTimers.current.get(id);
      if (activeTimer) window.clearTimeout(activeTimer);
      const timer = window.setTimeout(async () => {
        const nextPatch = pendingPatches.current.get(id);
        pendingPatches.current.delete(id);
        saveTimers.current.delete(id);
        if (!nextPatch) return;
        try {
          await invoke<NodeRecord>("update_node", { input: { id, ...nextPatch } });
          setNotice("所有更改已保存");
        } catch (error) {
          reportError(error);
        }
      }, 450);
      saveTimers.current.set(id, timer);
      setNotice("正在保存…");
    },
    [reportError],
  );

  const changeNode = useCallback(
    (id: string, patch: NodePatch) => {
      setNodes((current) =>
        current.map((node) => {
          if (node.id !== id) return node;
          const record = { ...node.data.record, ...patch };
          return {
            ...node,
            width: patch.width ?? node.width,
            height: patch.height ?? node.height,
            style: {
              ...node.style,
              width: patch.width ?? node.style?.width,
              height: patch.height ?? node.style?.height,
            },
            data: { ...node.data, record },
          };
        }),
      );
      persistPatch(id, patch);
    },
    [persistPatch, setNodes],
  );

  useEffect(() => {
    const recordsById = new Map(nodes.map((node) => [node.id, node.data.record]));
    const mediaKindsByTarget = new Map<string, string[]>();
    const textInputCountByTarget = new Map<string, number>();

    for (const edge of edges) {
      const source = recordsById.get(edge.source);
      if (!source) continue;
      if (source.kind === "text") {
        textInputCountByTarget.set(
          edge.target,
          (textInputCountByTarget.get(edge.target) ?? 0) + 1,
        );
        continue;
      }
      if (!["image", "audio", "video"].includes(source.kind)) continue;
      const kinds = mediaKindsByTarget.get(edge.target) ?? [];
      kinds.push(source.kind);
      mediaKindsByTarget.set(edge.target, kinds);
    }

    for (const node of nodes) {
      const record = node.data.record;
      if (record.kind === "audio") {
        if (record.height < AUDIO_NODE_MIN_HEIGHT) {
          changeNode(node.id, { height: AUDIO_NODE_MIN_HEIGHT });
        }
        continue;
      }
      if (record.kind !== "video-generation") continue;
      const storedManualHeight = typeof record.content.manualHeight === "number"
        ? record.content.manualHeight
        : null;
      const manualHeight = Math.max(180, storedManualHeight ?? record.height);
      const desiredHeight = Math.max(
        manualHeight,
        videoGenerationAutoHeight(
          mediaKindsByTarget.get(node.id) ?? [],
          textInputCountByTarget.get(node.id) ?? 0,
          record.width,
        ),
      );
      if (Math.abs(record.height - desiredHeight) < 0.5 && storedManualHeight !== null) continue;
      changeNode(node.id, {
        height: desiredHeight,
        ...(storedManualHeight === null
          ? { content: { ...record.content, manualHeight } }
          : {}),
      });
    }
  }, [changeNode, edges, nodes]);

  const rememberDeletedBatch = useCallback((batch: DeletedBatch) => {
    deleteUndoStack.current.push(batch);
    if (deleteUndoStack.current.length > 50) deleteUndoStack.current.shift();
  }, []);

  const flushNodePatches = useCallback(async (ids: string[]) => {
    await Promise.all(ids.map(async (id) => {
      const timer = saveTimers.current.get(id);
      if (timer) window.clearTimeout(timer);
      saveTimers.current.delete(id);
      const patch = pendingPatches.current.get(id);
      pendingPatches.current.delete(id);
      if (patch) await invoke<NodeRecord>("update_node", { input: { id, ...patch } });
    }));
  }, []);

  const saveNode = useCallback(
    async (id: string, patch: NodePatch): Promise<boolean> => {
      try {
        changeNode(id, patch);
        await flushNodePatches([id]);
        setNotice("文本已保存");
        return true;
      } catch (error) {
        reportError(error);
        return false;
      }
    },
    [changeNode, flushNodePatches, reportError],
  );

  const deleteNode = useCallback(
    async (id: string) => {
      try {
        await flushNodePatches([id]);
        const batch = await invoke<DeletedBatch>("delete_nodes_undoable", {
          input: { ids: [id] },
        });
        rememberDeletedBatch(batch);
        setNodes((current) => current.filter((node) => node.id !== id));
        setEdges((current) => current.filter((edge) => edge.source !== id && edge.target !== id));
        setNotice("节点已删除，按 Ctrl+Z 撤销");
      } catch (error) {
        reportError(error);
      }
    },
    [flushNodePatches, rememberDeletedBatch, reportError, setEdges, setNodes],
  );

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("内容已复制");
    } catch {
      setNotice("复制失败，请手动选择文本");
    }
  }, []);

  const reportExecutionCheck = useCallback((message: string, valid: boolean) => {
    setNotice(valid ? message : `无法执行：${message}`);
  }, []);

  const revealGeneratedVideo = useCallback(async (previewId: string) => {
    const preview = nodesSnapshot.current.find(
      (node) => node.id === previewId,
    )?.data.record;
    if (!preview) return;
    const currentOutputRoot = comfyOutputRootRef.current;
    if (!currentOutputRoot.trim()) {
      setComfyOutputRootDraft("");
      setSettingsOpen(true);
      setNotice("请先在设置中填写 ComfyUI 输出映射目录");
      return;
    }
    const mappedPath = mappedComfyOutputPath(currentOutputRoot, preview.content);
    const videoUrl = typeof preview.content.videoUrl === "string" ? preview.content.videoUrl : "";
    if (!mappedPath) {
      setNotice("当前预览缺少可定位的文件信息");
      return;
    }
    try {
      await revealItemInDir(mappedPath);
      setNotice(`已在资源管理器中定位：${mappedPath}`);
    } catch (error) {
      if (videoUrl) {
        await openUrl(videoUrl);
        setNotice("映射路径无法定位，已改为打开远程视频链接");
        return;
      }
      reportError(error);
    }
  }, [reportError]);

  const saveComfyDirectories = useCallback(() => {
    const normalizePath = (path: string) => path
      .trim()
      .replace(/^"|"$/g, "")
      .replace(/[\\/]+$/, "");
    const outputRoot = normalizePath(comfyOutputRootDraft);
    const inputRoot = normalizePath(comfyInputRootDraft);
    comfyOutputRootRef.current = outputRoot;
    comfyInputRootRef.current = inputRoot;
    setComfyOutputRoot(outputRoot);
    setComfyInputRoot(inputRoot);
    if (outputRoot) window.localStorage.setItem("infinite-canvas:comfy-output-root", outputRoot);
    else window.localStorage.removeItem("infinite-canvas:comfy-output-root");
    if (inputRoot) window.localStorage.setItem("infinite-canvas:comfy-input-root", inputRoot);
    else window.localStorage.removeItem("infinite-canvas:comfy-input-root");
    setSettingsOpen(false);
    setNotice("ComfyUI 目录设置已保存");
  }, [comfyInputRootDraft, comfyOutputRootDraft]);

  const clearComfyQueuePolling = useCallback((targetId: string) => {
    const timer = comfyQueuePollTimers.current.get(targetId);
    if (timer !== undefined) window.clearTimeout(timer);
    comfyQueuePollTimers.current.delete(targetId);
    setComfyQueuePositions((current) => {
      if (!(targetId in current)) return current;
      const next = { ...current };
      delete next[targetId];
      return next;
    });
  }, []);

  const startComfyQueuePolling = useCallback((targetId: string, clientId: string) => {
    clearComfyQueuePolling(targetId);
    const poll = async () => {
      if (runningComfyClients.current.get(targetId) !== clientId) return;
      try {
        const status = await invoke<ComfyQueueStatus | null>("get_comfyui_queue_status", {
          serverUrl: COMFYUI_SERVER_URL,
          clientId,
        });
        const position = status?.state === "queued" ? status.position : null;
        setComfyQueuePositions((current) => {
          if (position !== null && position > 0) {
            if (current[targetId] === position) return current;
            return { ...current, [targetId]: position };
          }
          if (!(targetId in current)) return current;
          const next = { ...current };
          delete next[targetId];
          return next;
        });
      } catch {
        // Queue polling is supplemental and must not interrupt generation.
      }
      if (runningComfyClients.current.get(targetId) !== clientId) return;
      const timer = window.setTimeout(() => void poll(), 1200);
      comfyQueuePollTimers.current.set(targetId, timer);
    };
    const timer = window.setTimeout(() => void poll(), 500);
    comfyQueuePollTimers.current.set(targetId, timer);
  }, [clearComfyQueuePolling]);

  const generationSnapshotForGenerator = useCallback((generatorId: string): GenerationSnapshot | null => {
    const generator = nodesSnapshot.current.find(
      (node) => node.id === generatorId,
    )?.data.record;
    if (!generator || generator.kind !== "video-generation") return null;
    const recordsById = new Map(
      nodesSnapshot.current.map((node) => [node.id, node.data.record]),
    );
    const inputRecords = edgesSnapshot.current
      .filter((edge) => edge.target === generatorId)
      .map((edge) => recordsById.get(edge.source))
      .filter((record): record is NodeRecord => Boolean(record));
    const textInputs = inputRecords.filter((record) => record.kind === "text");
    const mediaInputs = inputRecords.filter(
      (record) => record.kind === "image" || record.kind === "audio" || record.kind === "video",
    );
    const savedOrder = Array.isArray(generator.content.mediaInputOrder)
      ? generator.content.mediaInputOrder.filter(
        (inputId): inputId is string => typeof inputId === "string",
      )
      : [];
    const mediaById = new Map(mediaInputs.map((record) => [record.id, record]));
    const orderedMedia = savedOrder
      .map((inputId) => mediaById.get(inputId))
      .filter((record): record is NodeRecord => Boolean(record));
    const orderedIds = new Set(orderedMedia.map((record) => record.id));
    orderedMedia.push(...mediaInputs.filter((record) => !orderedIds.has(record.id)));
    const assetPaths = (kind: string) => orderedMedia
      .filter((record) => record.kind === kind)
      .map((record) => typeof record.content.assetPath === "string" ? record.content.assetPath : "")
      .filter(Boolean);
    return {
      prompt: textInputs.length === 1 ? textFromContent(textInputs[0].content) : "",
      durationSeconds: videoDurationFromContent(generator.content),
      primaryResolutionMegapixels: primaryVideoResolutionFromContent(generator.content),
      secondaryResolutionMegapixels: secondaryVideoResolutionFromContent(generator.content),
      imagePaths: assetPaths("image"),
      audioPaths: assetPaths("audio"),
      videoPaths: assetPaths("video"),
    };
  }, []);

  const executeVideoNode = useCallback(async (targetId: string) => {
    const target = nodesSnapshot.current.find((node) => node.id === targetId)?.data.record;
    if (!target) {
      setNotice("无法执行：找不到视频生成节点");
      return;
    }
    const requestedSeedMode = seedModeFromContent(target.content);
    const requestedFixedSeed = fixedSeedFromContent(target.content);
    if (
      requestedSeedMode === "fixed"
      && generatedSeedsFromContent(target.content).includes(requestedFixedSeed)
    ) {
      const message = `固定种子 ${requestedFixedSeed} 已经生成过，无需重复生成`;
      changeNode(targetId, {
        content: { ...target.content, status: "warning", validationMessage: message },
      });
      setNotice(message);
      return;
    }
    const mode = videoGenerationModeFromContent(target.content);
    if (mode !== "reference-to-video") {
      const message = mode === "first-last-frame"
        ? "首尾帧 API 工作流尚未配置"
        : "文生视频 API 工作流尚未配置";
      changeNode(targetId, {
        content: { ...target.content, status: "invalid", validationMessage: message },
      });
      setNotice(`无法执行：${message}`);
      return;
    }

    const snapshot = generationSnapshotForGenerator(targetId);
    if (!snapshot?.prompt.trim()) {
      setNotice("无法执行：找不到已保存的提示词与素材参数");
      return;
    }
    const clientId = crypto.randomUUID();
    const executionStartedAt = Date.now();
    cancelledVideoNodes.current.delete(targetId);
    runningComfyClients.current.set(targetId, clientId);
    startComfyQueuePolling(targetId, clientId);
    changeNode(targetId, {
      content: {
        ...target.content,
        status: "running",
        executionProgress: null,
        validationMessage: "正在上传素材并提交到远程 ComfyUI…",
      },
    });
    setNotice("正在上传素材并提交到远程 ComfyUI…");

    let progressSocket: WebSocket | null = null;
    try {
      progressSocket = await openComfyProgressSocket(clientId);
      if (cancelledVideoNodes.current.has(targetId)) {
        throw new Error("ComfyUI 生成已取消");
      }
      progressSocket?.addEventListener("message", (event) => {
        if (cancelledVideoNodes.current.has(targetId)) return;
        if (typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as JsonObject;
          if (message.type !== "progress" || !message.data || typeof message.data !== "object") return;
          const data = message.data as JsonObject;
          const value = typeof data.value === "number" ? data.value : null;
          const maximum = typeof data.max === "number" ? data.max : null;
          if (value === null || maximum === null || maximum <= 0) return;
          const progress = Math.max(0, Math.min(100, (value / maximum) * 100));
          const latest = nodesSnapshot.current.find((node) => node.id === targetId)?.data.record ?? target;
          changeNode(targetId, {
            content: {
              ...latest.content,
              status: "running",
              executionProgress: progress,
              validationMessage: `ComfyUI 正在生成：当前步骤 ${value}/${maximum}`,
            },
          });
        } catch {
          // ComfyUI also sends binary previews; they are intentionally ignored here.
        }
      });
      const result = await invoke<ComfySubmitResult>("submit_comfyui_workflow", {
        input: {
          serverUrl: COMFYUI_SERVER_URL,
          workflowPath: H3_REFERENCE_WORKFLOW_PATH,
          inputRootPath: comfyInputRootRef.current,
          clientId,
          prompt: snapshot.prompt,
          seedMode: seedModeFromContent(target.content),
          seed: fixedSeedFromContent(target.content),
          durationSeconds: snapshot.durationSeconds,
          primaryResolutionMegapixels: snapshot.primaryResolutionMegapixels,
          secondaryResolutionMegapixels: snapshot.secondaryResolutionMegapixels,
          secondarySamplingEnabled: false,
          imagePaths: snapshot.imagePaths,
          audioPaths: snapshot.audioPaths,
          videoPaths: snapshot.videoPaths,
          secondarySource: null,
        },
      });
      if (cancelledVideoNodes.current.has(targetId)) return;
      const generationElapsedSeconds = (Date.now() - executionStartedAt) / 1000;

      const previewWidth = 360;
      const previewHeight = 288;
      const placementRecords = nodesSnapshot.current.map((node) => node.data.record);
      const createdNodes: CanvasFlowNode[] = [];
      const createdEdges: Edge[] = [];
      for (const [index, output] of result.outputs.entries()) {
        const position = generatedPreviewPosition(
          target,
          placementRecords,
          previewWidth,
          previewHeight,
        );
        const previewResult = await invoke<CreateNodeResult>("create_node", {
          input: {
            canvasId: target.canvasId,
            kind: "generated-video",
            title: result.outputs.length > 1
              ? `视频预览 ${index + 1}`
              : "视频预览",
            content: {
              videoUrl: output.url,
              originalName: output.filename,
              filename: output.filename,
              subfolder: output.subfolder,
              fileType: output.fileType,
              seed: result.seed,
              comfyPromptId: result.promptId,
              comfyServerUrl: COMFYUI_SERVER_URL,
              sourceGeneratorId: targetId,
              generationSnapshot: snapshot,
              generationElapsedSeconds,
            },
            source: "comfyui",
            x: position.x,
            y: position.y,
            width: previewWidth,
            height: previewHeight,
          },
        });
        placementRecords.push(previewResult.node);
        const flowNode = makeFlowNodeRef.current?.(previewResult.node);
        if (flowNode) createdNodes.push(flowNode);

        const edgeRecord = await invoke<EdgeRecord>("create_edge", {
          input: {
            canvasId: target.canvasId,
            sourceNodeId: targetId,
            targetNodeId: previewResult.node.id,
            kind: "output",
            metadata: {
              seed: result.seed,
              promptId: result.promptId,
              outputIndex: index,
            },
          },
        });
        createdEdges.push(toFlowEdge(edgeRecord));
      }
      if (createdNodes.length) setNodes((current) => [...current, ...createdNodes]);
      if (createdEdges.length) setEdges((current) => [...current, ...createdEdges]);

      const latest = nodesSnapshot.current.find((node) => node.id === targetId)?.data.record ?? target;
      const nextContent = { ...latest.content };
      delete nextContent.generatedVideos;
      const generatedSeeds = [...new Set([
        ...generatedSeedsFromContent(latest.content),
        result.seed,
      ])];
      changeNode(targetId, {
        content: {
          ...nextContent,
          status: "succeeded",
          executionProgress: 100,
          validationMessage: `生成完成，已创建 ${result.outputs.length} 个独立预览节点`,
          comfyPromptId: result.promptId,
          comfyServerUrl: COMFYUI_SERVER_URL,
          lastGenerationSeed: result.seed,
          generatedSeeds,
          generationCount: (typeof latest.content.generationCount === "number"
            ? latest.content.generationCount
            : 0) + 1,
          generationDuration: videoDurationFromContent(latest.content),
          generationPrimaryResolution: primaryVideoResolutionFromContent(latest.content),
          generationSecondaryResolution: secondaryVideoResolutionFromContent(latest.content),
          secondarySamplingEnabled: false,
        },
      });
      setNotice(result.cleanupWarning
        ? `视频生成完成，但输入缓存清理失败：${result.cleanupWarning}`
        : `视频生成完成：已创建 ${result.outputs.length} 个预览节点`);
    } catch (error) {
      if (cancelledVideoNodes.current.has(targetId)) {
        const latest = nodesSnapshot.current.find((node) => node.id === targetId)?.data.record ?? target;
        changeNode(targetId, {
          content: {
            ...latest.content,
            status: "cancelled",
            executionProgress: null,
            validationMessage: "已取消 ComfyUI 生成",
          },
        });
        setNotice("已取消 ComfyUI 生成");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const latest = nodesSnapshot.current.find((node) => node.id === targetId)?.data.record ?? target;
      changeNode(targetId, {
        content: {
          ...latest.content,
          status: "invalid",
          executionProgress: null,
          validationMessage: `生成失败：${message}`,
        },
      });
      reportError(error);
    } finally {
      progressSocket?.close();
      clearComfyQueuePolling(targetId);
      if (runningComfyClients.current.get(targetId) === clientId) {
        runningComfyClients.current.delete(targetId);
      }
    }
  }, [changeNode, clearComfyQueuePolling, generationSnapshotForGenerator, reportError, setEdges, setNodes, startComfyQueuePolling]);

  const executeSecondarySample = useCallback(async (previewId: string) => {
    const preview = nodesSnapshot.current.find((node) => node.id === previewId)?.data.record;
    if (!preview || preview.kind !== "generated-video") {
      setNotice("无法二采：找不到视频预览节点");
      return;
    }
    const secondarySource = comfyOutputFromContent(preview.content);
    const sourceGeneratorId = typeof preview.content.sourceGeneratorId === "string"
      ? preview.content.sourceGeneratorId
      : "";
    const sourceGenerator = nodesSnapshot.current.find(
      (node) => node.id === sourceGeneratorId,
    )?.data.record;
    const storedSnapshot = generationSnapshotFromContent(preview.content);
    const fallbackSnapshot = sourceGeneratorId
      ? generationSnapshotForGenerator(sourceGeneratorId)
      : null;
    const baseSnapshot = storedSnapshot ?? fallbackSnapshot;
    const previewSeed = typeof preview.content.seed === "string" ? preview.content.seed : "";
    if (!secondarySource) {
      setNotice("无法二采：当前预览缺少远程视频文件信息");
      return;
    }
    if (!baseSnapshot?.prompt.trim()) {
      setNotice("无法二采：找不到该视频生成时使用的提示词与参考素材参数");
      return;
    }
    if (!previewSeed) {
      setNotice("无法二采：当前预览缺少生成 seed");
      return;
    }
    const snapshot: GenerationSnapshot = {
      ...baseSnapshot,
      secondaryResolutionMegapixels: sourceGenerator?.kind === "video-generation"
        ? secondaryVideoResolutionFromContent(sourceGenerator.content)
        : baseSnapshot.secondaryResolutionMegapixels,
    };
    const clientId = crypto.randomUUID();
    const executionStartedAt = Date.now();
    cancelledVideoNodes.current.delete(previewId);
    runningComfyClients.current.set(previewId, clientId);
    startComfyQueuePolling(previewId, clientId);
    changeNode(previewId, {
      content: {
        ...preview.content,
        status: "running",
        executionProgress: null,
        validationMessage: `正在准备当前视频的二采（${snapshot.secondaryResolutionMegapixels.toFixed(1)} MP）…`,
      },
    });
    setNotice("正在上传当前预览并提交二采…");

    let progressSocket: WebSocket | null = null;
    try {
      progressSocket = await openComfyProgressSocket(clientId);
      if (cancelledVideoNodes.current.has(previewId)) {
        throw new Error("ComfyUI 二采已取消");
      }
      let executingNodeId = "";
      progressSocket?.addEventListener("message", (event) => {
        if (cancelledVideoNodes.current.has(previewId) || typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as JsonObject;
          if (!message.data || typeof message.data !== "object") return;
          const data = message.data as JsonObject;
          const updateProgress = (progress: number | null, validationMessage: string) => {
            const latest = nodesSnapshot.current.find(
              (node) => node.id === previewId,
            )?.data.record ?? preview;
            changeNode(previewId, {
              content: {
                ...latest.content,
                status: "running",
                executionProgress: progress,
                validationMessage,
              },
            });
          };
          if (message.type === "executing") {
            executingNodeId = typeof data.node === "string" ? data.node : "";
            const stages: Record<string, { progress: number | null; label: string }> = {
              "9002": { progress: null, label: "正在读取选中的预览视频…" },
              "383": { progress: null, label: "正在调整二采画面尺寸…" },
              "386": { progress: null, label: "正在编码二采画面…" },
              "388": { progress: null, label: "正在编码视频音频…" },
              "390": { progress: null, label: "正在组合二采视频与音频…" },
              "363": { progress: null, label: "正在准备提示词与参考条件…" },
              "391": { progress: 8, label: "正在准备二采采样参数…" },
              "393": { progress: 8, label: "正在准备二采引导条件…" },
              "387": { progress: 10, label: "正在加载二采模型并准备采样…" },
              "395": { progress: 92, label: "采样完成，正在解码视频…" },
              "403": { progress: 95, label: "正在处理二采画面…" },
              "9000": { progress: 97, label: "正在合成二采视频…" },
              "9001": { progress: 99, label: "正在保存二采视频…" },
            };
            const stage = stages[executingNodeId];
            if (stage) updateProgress(stage.progress, stage.label);
            return;
          }
          if (message.type !== "progress") return;
          const progressNodeId = typeof data.node === "string" ? data.node : executingNodeId;
          if (progressNodeId !== "387") return;
          const value = typeof data.value === "number" ? data.value : null;
          const maximum = typeof data.max === "number" ? data.max : null;
          if (value === null || maximum === null || maximum <= 0) return;
          const progress = Math.max(10, Math.min(90, 10 + (value / maximum) * 80));
          updateProgress(progress, `正在二采采样：${value}/${maximum}`);
        } catch {
          // ComfyUI binary preview frames are intentionally ignored.
        }
      });
      const result = await invoke<ComfySubmitResult>("submit_comfyui_workflow", {
        input: {
          serverUrl: COMFYUI_SERVER_URL,
          workflowPath: H3_REFERENCE_WORKFLOW_PATH,
          inputRootPath: comfyInputRootRef.current,
          clientId,
          prompt: snapshot.prompt,
          seedMode: "fixed",
          seed: previewSeed,
          durationSeconds: snapshot.durationSeconds,
          primaryResolutionMegapixels: snapshot.primaryResolutionMegapixels,
          secondaryResolutionMegapixels: snapshot.secondaryResolutionMegapixels,
          secondarySamplingEnabled: true,
          imagePaths: snapshot.imagePaths,
          audioPaths: snapshot.audioPaths,
          videoPaths: snapshot.videoPaths,
          secondarySource,
        },
      });
      if (cancelledVideoNodes.current.has(previewId)) return;
      const generationElapsedSeconds = (Date.now() - executionStartedAt) / 1000;

      const previewWidth = 360;
      const previewHeight = 288;
      const placementRecords = nodesSnapshot.current.map((node) => node.data.record);
      const createdNodes: CanvasFlowNode[] = [];
      const createdEdges: Edge[] = [];
      for (const [index, output] of result.outputs.entries()) {
        const position = generatedPreviewPosition(
          preview,
          placementRecords,
          previewWidth,
          previewHeight,
        );
        const previewResult = await invoke<CreateNodeResult>("create_node", {
          input: {
            canvasId: preview.canvasId,
            kind: "generated-video",
            title: result.outputs.length > 1 ? `二采预览 ${index + 1}` : "二采预览",
            content: {
              videoUrl: output.url,
              originalName: output.filename,
              filename: output.filename,
              subfolder: output.subfolder,
              fileType: output.fileType,
              seed: result.seed,
              comfyPromptId: result.promptId,
              comfyServerUrl: COMFYUI_SERVER_URL,
              sourceGeneratorId,
              sourcePreviewId: previewId,
              generationSnapshot: snapshot,
              generationElapsedSeconds,
            },
            source: "comfyui",
            x: position.x,
            y: position.y,
            width: previewWidth,
            height: previewHeight,
          },
        });
        placementRecords.push(previewResult.node);
        const flowNode = makeFlowNodeRef.current?.(previewResult.node);
        if (flowNode) createdNodes.push(flowNode);
        const edgeRecord = await invoke<EdgeRecord>("create_edge", {
          input: {
            canvasId: preview.canvasId,
            sourceNodeId: previewId,
            targetNodeId: previewResult.node.id,
            kind: "secondary-output",
            metadata: {
              seed: result.seed,
              promptId: result.promptId,
              outputIndex: index,
              secondaryResolutionMegapixels: snapshot.secondaryResolutionMegapixels,
            },
          },
        });
        createdEdges.push(toFlowEdge(edgeRecord));
      }
      if (createdNodes.length) setNodes((current) => [...current, ...createdNodes]);
      if (createdEdges.length) setEdges((current) => [...current, ...createdEdges]);

      const latest = nodesSnapshot.current.find(
        (node) => node.id === previewId,
      )?.data.record ?? preview;
      changeNode(previewId, {
        content: {
          ...latest.content,
          status: "idle",
          executionProgress: null,
          validationMessage: "",
          generationSnapshot: snapshot,
        },
      });
      setNotice(result.cleanupWarning
        ? `二采完成，但输入缓存清理失败：${result.cleanupWarning}`
        : `二采完成：已创建 ${result.outputs.length} 个新预览节点`);
    } catch (error) {
      const latest = nodesSnapshot.current.find(
        (node) => node.id === previewId,
      )?.data.record ?? preview;
      if (cancelledVideoNodes.current.has(previewId)) {
        changeNode(previewId, {
          content: {
            ...latest.content,
            status: "cancelled",
            executionProgress: null,
            validationMessage: "已取消 ComfyUI 二采",
          },
        });
        setNotice("已取消 ComfyUI 二采");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      changeNode(previewId, {
        content: {
          ...latest.content,
          status: "invalid",
          executionProgress: null,
          validationMessage: `二采失败：${message}`,
        },
      });
      reportError(error);
    } finally {
      progressSocket?.close();
      clearComfyQueuePolling(previewId);
      if (runningComfyClients.current.get(previewId) === clientId) {
        runningComfyClients.current.delete(previewId);
      }
    }
  }, [changeNode, clearComfyQueuePolling, generationSnapshotForGenerator, reportError, setEdges, setNodes, startComfyQueuePolling]);

  const cancelVideoExecution = useCallback(async (targetId: string) => {
    const clientId = runningComfyClients.current.get(targetId);
    const target = nodesSnapshot.current.find((node) => node.id === targetId)?.data.record;
    if (!clientId || !target) {
      setNotice("当前没有可取消的 ComfyUI 任务");
      return;
    }
    cancelledVideoNodes.current.add(targetId);
    changeNode(targetId, {
      content: {
        ...target.content,
        status: "cancelling",
        validationMessage: "正在取消 ComfyUI 生成…",
      },
    });
    setNotice("正在取消 ComfyUI 生成…");
    try {
      const cleanupWarning = await invoke<string | null>("cancel_comfyui_workflow", {
        serverUrl: COMFYUI_SERVER_URL,
        clientId,
      });
      const latest = nodesSnapshot.current.find((node) => node.id === targetId)?.data.record ?? target;
      changeNode(targetId, {
        content: {
          ...latest.content,
          status: "cancelled",
          executionProgress: null,
          validationMessage: "已取消 ComfyUI 生成",
        },
      });
      setNotice(cleanupWarning
        ? `已取消 ComfyUI 生成，但输入缓存清理失败：${cleanupWarning}`
        : "已取消 ComfyUI 生成");
    } catch (error) {
      cancelledVideoNodes.current.delete(targetId);
      const message = error instanceof Error ? error.message : String(error);
      const latest = nodesSnapshot.current.find((node) => node.id === targetId)?.data.record ?? target;
      changeNode(targetId, {
        content: {
          ...latest.content,
          status: "invalid",
          executionProgress: null,
          validationMessage: `取消失败：${message}`,
        },
      });
      reportError(error);
    }
  }, [changeNode, reportError]);

  const disconnectEdge = useCallback(async (
    edgeId: string,
    successMessage = "连线已断开",
  ) => {
    const inputEdge = edgesSnapshot.current.find((edge) => edge.id === edgeId);
    if (!inputEdge) {
      setNotice("该连线已经断开");
      return;
    }

    try {
      await invoke("delete_edge", { id: inputEdge.id });
      setEdges((current) => current.filter((edge) => edge.id !== inputEdge.id));

      const target = nodesSnapshot.current.find(
        (node) => node.id === inputEdge.target,
      )?.data.record;
      if (target?.kind === "video-generation") {
        const mediaInputOrder = Array.isArray(target.content.mediaInputOrder)
          ? target.content.mediaInputOrder.filter((inputId) => inputId !== inputEdge.source)
          : [];
        const frameRoles = target.content.frameRoles
          && typeof target.content.frameRoles === "object"
          && !Array.isArray(target.content.frameRoles)
          ? { ...(target.content.frameRoles as Record<string, unknown>) }
          : {};
        delete frameRoles[inputEdge.source];
        changeNode(inputEdge.target, {
          content: {
            ...target.content,
            mediaInputOrder,
            frameRoles,
            status: "idle",
            validationMessage: "",
          },
        });
      }
      setNotice(successMessage);
    } catch (error) {
      reportError(error);
    }
  }, [changeNode, reportError, setEdges]);

  const removeInputFromVideoNode = useCallback(async (targetId: string, sourceId: string) => {
    const inputEdge = edgesSnapshot.current.find(
      (edge) => edge.source === sourceId && edge.target === targetId,
    );
    if (!inputEdge) {
      setNotice("该输入已经不在视频节点中");
      return;
    }
    await disconnectEdge(inputEdge.id, "输入已从视频节点移除");
  }, [disconnectEdge]);

  const copyNodesToClipboard = useCallback((nodeIds: string[]) => {
    const copiedIds = new Set(nodeIds);
    const copiedNodes = nodesSnapshot.current
      .filter((node) => copiedIds.has(node.id))
      .map((node) => ({
        ...node.data.record,
        content: structuredClone(node.data.record.content),
      }));
    if (!copiedNodes.length) return;

    const copiedVideoIds = new Set(
      copiedNodes
        .filter((node) => node.kind === "video-generation")
        .map((node) => node.id),
    );
    const videoInputEdges = edgesSnapshot.current
      .filter((edge) => copiedVideoIds.has(edge.target))
      .map((edge): NodeClipboardEdge => {
        const edgeRecord = (edge.data as { record?: EdgeRecord } | undefined)?.record;
        return {
          sourceId: edge.source,
          targetId: edge.target,
          kind: edgeRecord?.kind ?? "input",
          metadata: edgeRecord?.metadata
            ? structuredClone(edgeRecord.metadata)
            : {},
        };
      });

    nodeClipboard.current = {
      nodes: copiedNodes,
      videoInputEdges,
      pasteCount: 0,
    };
    setNotice(
      copiedNodes.length === 1
        ? `已复制节点“${copiedNodes[0].title || "未命名节点"}”`
        : `已复制 ${copiedNodes.length} 个节点`,
    );
  }, []);

  const makeFlowNode = useCallback(
    (record: NodeRecord, matched = true): CanvasFlowNode => ({
      id: record.id,
      type: "canvasNode",
      position: { x: record.x, y: record.y },
      width: record.width,
      height: record.height,
      style: { width: record.width, height: record.height },
      data: {
        record,
        matched,
        inputCount: 0,
        mediaInputs: [],
        textInputCount: 0,
        textInputs: [],
        queuePosition: null,
        onChange: changeNode,
        onSave: saveNode,
        onExecutionCheck: reportExecutionCheck,
        onExecute: executeVideoNode,
        onSecondarySample: executeSecondarySample,
        onCancelExecution: cancelVideoExecution,
        onRevealGeneratedVideo: revealGeneratedVideo,
        onRemoveInput: removeInputFromVideoNode,
        onDelete: deleteNode,
        onCopy: copyText,
      },
    }),
    [cancelVideoExecution, changeNode, copyText, deleteNode, executeSecondarySample, executeVideoNode, removeInputFromVideoNode, reportExecutionCheck, revealGeneratedVideo, saveNode],
  );
  makeFlowNodeRef.current = makeFlowNode;

  const pasteCopiedNodes = useCallback(async () => {
    const clipboard = nodeClipboard.current;
    if (!activeProjectId || !clipboard?.nodes.length) return;

    const pasteOffset = CANVAS_GRID_SIZE * 2 * (clipboard.pasteCount + 1);
    const createdByOriginalId = new Map<string, NodeRecord>();
    const createdNodes: CanvasFlowNode[] = [];
    try {
      for (const sourceNode of clipboard.nodes) {
        const result = await invoke<CreateNodeResult>("create_node", {
          input: {
            canvasId: activeProjectId,
            kind: sourceNode.kind,
            title: `${sourceNode.title || "未命名节点"} 副本`,
            content: structuredClone(sourceNode.content),
            source: "clipboard",
            x: snapCanvasCoordinate(sourceNode.x + pasteOffset),
            y: snapCanvasCoordinate(sourceNode.y + pasteOffset),
            width: sourceNode.width,
            height: sourceNode.height,
          },
        });
        createdByOriginalId.set(sourceNode.id, result.node);
        createdNodes.push({ ...makeFlowNode(result.node), selected: true });
      }

      const createdEdges: Edge[] = [];
      let missingLinks = 0;
      for (const copiedEdge of clipboard.videoInputEdges) {
        const pastedTarget = createdByOriginalId.get(copiedEdge.targetId);
        const sourceStillExists = nodesSnapshot.current.some(
          (node) => node.id === copiedEdge.sourceId,
        );
        if (!pastedTarget || !sourceStillExists) {
          missingLinks += 1;
          continue;
        }
        try {
          const edgeRecord = await invoke<EdgeRecord>("create_edge", {
            input: {
              canvasId: activeProjectId,
              sourceNodeId: copiedEdge.sourceId,
              targetNodeId: pastedTarget.id,
              kind: copiedEdge.kind,
              metadata: structuredClone(copiedEdge.metadata),
            },
          });
          createdEdges.push(toFlowEdge(edgeRecord));
        } catch {
          missingLinks += 1;
        }
      }

      setNodes((current) => [
        ...current.map((node) => ({ ...node, selected: false })),
        ...createdNodes,
      ]);
      if (createdEdges.length) {
        setEdges((current) => [...current, ...createdEdges]);
      }
      clipboard.pasteCount += 1;
      setNotice(
        missingLinks
          ? `已粘贴 ${createdNodes.length} 个节点，${missingLinks} 条原素材连线已失效`
          : `已粘贴 ${createdNodes.length} 个节点${createdEdges.length ? `，恢复 ${createdEdges.length} 条素材连线` : ""}`,
      );
    } catch (error) {
      reportError(error);
    }
  }, [activeProjectId, makeFlowNode, reportError, setEdges, setNodes]);

  useEffect(() => {
    const handleNodeClipboardShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.repeat) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "c" && !event.shiftKey) {
        const selectedIds = nodesSnapshot.current
          .filter((node) => node.selected)
          .map((node) => node.id);
        if (!selectedIds.length) return;
        event.preventDefault();
        copyNodesToClipboard(selectedIds);
      } else if (key === "v" && nodeClipboard.current) {
        event.preventDefault();
        void pasteCopiedNodes();
      }
    };

    window.addEventListener("keydown", handleNodeClipboardShortcut);
    return () => window.removeEventListener("keydown", handleNodeClipboardShortcut);
  }, [copyNodesToClipboard, pasteCopiedNodes]);

  const undoLastNodeDelete = useCallback(async () => {
    const batch = deleteUndoStack.current.pop();
    if (!batch) {
      setNotice("没有可撤销的节点删除");
      return;
    }
    try {
      const restored = await invoke<DeletedBatch>("restore_deleted_nodes", { batch });
      setNodes((current) => {
        const currentIds = new Set(current.map((node) => node.id));
        return [
          ...current,
          ...restored.nodes
            .filter((record) => !currentIds.has(record.id))
            .map((record) => makeFlowNode(record)),
        ];
      });
      setEdges((current) => {
        const currentIds = new Set(current.map((edge) => edge.id));
        return [
          ...current,
          ...restored.edges
            .filter((record) => !currentIds.has(record.id))
            .map(toFlowEdge),
        ];
      });
      setNotice(`已撤销删除，恢复 ${restored.nodes.length} 个节点`);
    } catch (error) {
      deleteUndoStack.current.push(batch);
      reportError(error);
    }
  }, [makeFlowNode, reportError, setEdges, setNodes]);

  useEffect(() => {
    const handleUndoShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.key.toLowerCase() !== "z") {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      void undoLastNodeDelete();
    };
    window.addEventListener("keydown", handleUndoShortcut);
    return () => window.removeEventListener("keydown", handleUndoShortcut);
  }, [undoLastNodeDelete]);

  const flushPendingPatches = useCallback(async () => {
    for (const timer of saveTimers.current.values()) window.clearTimeout(timer);
    saveTimers.current.clear();
    const patches = [...pendingPatches.current.entries()];
    pendingPatches.current.clear();
    await Promise.all(
      patches.map(([id, patch]) => invoke<NodeRecord>("update_node", { input: { id, ...patch } })),
    );
  }, []);

  const openProject = useCallback(
    async (projectId: string) => {
      try {
        setNotice("正在打开项目…");
        const snapshot = await invoke<WorkspaceSnapshot>("load_workspace", {
          canvasId: projectId,
        });
        const savedBackground = validCanvasColor(
          window.localStorage.getItem(`infinite-canvas:canvas-background:${projectId}`),
        );
        deleteUndoStack.current = [];
        activeProjectIdRef.current = projectId;
        setActiveProjectId(projectId);
        setCanvasBackground(savedBackground);
        setCanvasName(snapshot.canvas.name);
        setProjectNameDraft(snapshot.canvas.name);
        setEditingProjectName(false);
        setNodes(snapshot.nodes.map((record) => makeFlowNode(record)));
        setEdges(snapshot.edges.map(toFlowEdge));
        setSearch("");
        setNotice(snapshot.nodes.length ? "所有更改已保存" : "空白画布，创建第一个节点吧");
        window.setTimeout(() => {
          if (snapshot.nodes.length) {
            void fitView({ padding: 0.25, duration: 350, maxZoom: 1 });
          }
        }, 80);
      } catch (error) {
        reportError(error);
      }
    },
    [fitView, makeFlowNode, reportError, setEdges, setNodes],
  );

  const returnToProjects = useCallback(async () => {
    try {
      await flushPendingPatches();
      const snapshots = await invoke<WorkspaceSnapshot[]>("list_projects");
      setProjects(snapshots);
      deleteUndoStack.current = [];
      activeProjectIdRef.current = null;
      setActiveProjectId(null);
      setCanvasBackground(null);
      setNodes([]);
      setEdges([]);
      setDropActive(false);
    } catch (error) {
      reportError(error);
    }
  }, [flushPendingPatches, reportError, setEdges, setNodes]);

  const createProject = useCallback(async () => {
    const name = newProjectName.trim();
    if (!name) {
      setNotice("请输入项目名称");
      return;
    }
    try {
      const snapshot = await invoke<WorkspaceSnapshot>("create_project", {
        input: { name },
      });
      setProjects((current) => [snapshot, ...current]);
      setCreateProjectOpen(false);
      setNewProjectName("");
      await openProject(snapshot.canvas.id);
    } catch (error) {
      reportError(error);
    }
  }, [newProjectName, openProject, reportError]);

  const deleteProject = useCallback(async () => {
    if (!projectToDelete || deletingProjectId) return;
    const projectId = projectToDelete.canvas.id;
    const projectName = projectToDelete.canvas.name;
    setDeletingProjectId(projectId);
    try {
      await invoke("delete_project", { id: projectId });
      setProjects((current) => current.filter((project) => project.canvas.id !== projectId));
      window.localStorage.removeItem(`infinite-canvas:canvas-background:${projectId}`);
      setProjectToDelete(null);
      setNotice(`项目“${projectName}”已删除`);
    } catch (error) {
      reportError(error);
    } finally {
      setDeletingProjectId(null);
    }
  }, [deletingProjectId, projectToDelete, reportError]);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;

    const load = async () => {
      try {
        const [snapshots, runtimeInfo] = await Promise.all([
          invoke<WorkspaceSnapshot[]>("list_projects"),
          invoke<RuntimeInfo>("get_runtime_info"),
        ]);
        if (!mounted) return;
        setProjects(snapshots);
        setRuntime(runtimeInfo);
        setProjectHomeReady(true);

        unlisten = await listen<NodeRecord>("canvas://node-created", (event) => {
          void (async () => {
            let record = event.payload;
            if (activeProjectIdRef.current === record.canvasId) {
              const viewportCenter = screenToFlowPosition({
                x: window.innerWidth / 2,
                y: window.innerHeight / 2,
              });
              const position = incomingNodePosition(
                record,
                [
                  ...nodesSnapshot.current.map((node) => node.data.record),
                  ...incomingPlacementReservations.current,
                ],
                viewportCenter,
              );
              const reservedRecord = { ...record, ...position };
              incomingPlacementReservations.current.push(reservedRecord);
              try {
                record = await invoke<NodeRecord>("update_node", {
                  input: { id: record.id, ...position },
                });
              } catch (error) {
                reportError(error);
              } finally {
                incomingPlacementReservations.current = incomingPlacementReservations.current
                  .filter((candidate) => candidate.id !== record.id);
              }
            }
            if (!mounted) return;
            setProjects((current) => current.map((project) => {
              if (project.canvas.id !== record.canvasId) return project;
              if (project.nodes.some((node) => node.id === record.id)) return project;
              return {
                ...project,
                canvas: { ...project.canvas, updatedAt: record.updatedAt },
                nodes: [...project.nodes, record],
              };
            }));
            if (activeProjectIdRef.current !== record.canvasId) return;
            setNodes((current) => {
              if (current.some((node) => node.id === record.id)) return current;
              return [...current, makeFlowNode(record)];
            });
            setNotice(`已接收来自 ${record.source} 的新节点`);
          })();
        });
      } catch (error) {
        reportError(error);
      }
    };

    void load();
    return () => {
      mounted = false;
      unlisten?.();
      for (const timer of saveTimers.current.values()) window.clearTimeout(timer);
    };
  }, [makeFlowNode, reportError, screenToFlowPosition, setNodes]);

  const addTextNode = useCallback(async (position?: { x: number; y: number }) => {
    if (!activeProjectId) return;
    try {
      const result = await invoke<CreateNodeResult>("create_node", {
        input: {
          canvasId: activeProjectId,
          kind: "text",
          title: "新文本",
          content: { text: "" },
          source: "manual",
          ...(position ? { x: position.x, y: position.y } : {}),
          width: 320,
          height: 240,
        },
      });
      setNodes((current) => [...current, makeFlowNode(result.node)]);
      setNotice("新文本节点已创建");
      if (!position) window.setTimeout(() => {
        void setCenter(
          result.node.x + result.node.width / 2,
          result.node.y + result.node.height / 2,
          { zoom: 1, duration: 350 },
        );
      }, 60);
    } catch (error) {
      reportError(error);
    }
  }, [activeProjectId, makeFlowNode, reportError, setCenter, setNodes]);

  const addNoteNode = useCallback(async (position?: { x: number; y: number }) => {
    if (!activeProjectId) return;
    try {
      const result = await invoke<CreateNodeResult>("create_node", {
        input: {
          canvasId: activeProjectId,
          kind: "note",
          title: "备注",
          content: { text: "" },
          source: "manual",
          ...(position ? { x: position.x, y: position.y } : {}),
          width: 300,
          height: 200,
        },
      });
      setNodes((current) => [...current, makeFlowNode(result.node)]);
      setNotice("备注节点已创建");
      if (!position) window.setTimeout(() => {
        void setCenter(
          result.node.x + result.node.width / 2,
          result.node.y + result.node.height / 2,
          { zoom: 1, duration: 350 },
        );
      }, 60);
    } catch (error) {
      reportError(error);
    }
  }, [activeProjectId, makeFlowNode, reportError, setCenter, setNodes]);

  const addVideoNode = useCallback(async (position?: { x: number; y: number }) => {
    if (!activeProjectId) return;
    try {
      const result = await invoke<CreateNodeResult>("create_node", {
        input: {
          canvasId: activeProjectId,
          kind: "video-generation",
          title: "视频生成",
          content: {
            provider: "",
            model: "",
            status: "idle",
            generationMode: "reference-to-video",
            generationDuration: 15,
            generationPrimaryResolution: 0.4,
            generationSecondaryResolution: 0.5,
            secondarySamplingEnabled: false,
            seedMode: "random",
            generationSeed: DEFAULT_GENERATION_SEED,
            manualHeight: VIDEO_NODE_BASE_HEIGHT,
          },
          source: "manual",
          ...(position ? { x: position.x, y: position.y } : {}),
          width: 360,
          height: VIDEO_NODE_BASE_HEIGHT,
        },
      });
      setNodes((current) => [...current, makeFlowNode(result.node)]);
      setNotice("视频生成节点已创建");
      if (!position) window.setTimeout(() => {
        void setCenter(
          result.node.x + result.node.width / 2,
          result.node.y + result.node.height / 2,
          { zoom: 1, duration: 350 },
        );
      }, 60);
    } catch (error) {
      reportError(error);
    }
  }, [activeProjectId, makeFlowNode, reportError, setCenter, setNodes]);

  const openCanvasContextMenu = useCallback((event: MouseEvent | ReactMouseEvent) => {
    event.preventDefault();
    const flowPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const menuWidth = 190;
    const menuHeight = 180;
    setCanvasContextMenu({
      screenX: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      screenY: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
      flowX: snapCanvasCoordinate(flowPosition.x),
      flowY: snapCanvasCoordinate(flowPosition.y),
    });
  }, [screenToFlowPosition]);

  const createNodeFromContextMenu = useCallback((kind: "text" | "note" | "video-generation") => {
    if (!canvasContextMenu) return;
    const position = { x: canvasContextMenu.flowX, y: canvasContextMenu.flowY };
    setCanvasContextMenu(null);
    if (kind === "text") void addTextNode(position);
    else if (kind === "note") void addNoteNode(position);
    else void addVideoNode(position);
  }, [addNoteNode, addTextNode, addVideoNode, canvasContextMenu]);

  useEffect(() => {
    if (!canvasContextMenu) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if ((event.target as HTMLElement | null)?.closest(".canvas-context-menu")) return;
      setCanvasContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCanvasContextMenu(null);
    };
    const closeMenu = () => setCanvasContextMenu(null);
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", closeMenu);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", closeMenu);
    };
  }, [canvasContextMenu]);

  const importMedia = useCallback(
    async (paths: string[], screenPosition: { x: number; y: number }) => {
      if (!activeProjectId) return;
      const flowPosition = screenToFlowPosition(screenPosition);
      const basePosition = {
        x: snapCanvasCoordinate(flowPosition.x),
        y: snapCanvasCoordinate(flowPosition.y),
      };
      let imported = 0;
      const failures: string[] = [];

      for (const [index, path] of paths.entries()) {
        try {
          const result = await invoke<CreateNodeResult>("import_media", {
            path,
            canvasId: activeProjectId,
            x: basePosition.x + index * CANVAS_GRID_SIZE,
            y: basePosition.y + index * CANVAS_GRID_SIZE,
          });
          setNodes((current) => [...current, makeFlowNode(result.node)]);
          imported += 1;
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }

      if (imported && !failures.length) {
        setNotice(`已导入 ${imported} 个媒体文件`);
      } else if (imported) {
        setNotice(`已导入 ${imported} 个媒体文件，${failures.length} 个文件未导入`);
      } else {
        setNotice(`媒体导入失败：${failures[0] ?? "没有可用文件"}`);
      }
    },
    [activeProjectId, makeFlowNode, screenToFlowPosition, setNodes],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const registerDropHandler = async () => {
      unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        if (disposed) return;
        if (!activeProjectIdRef.current) return;
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setDropActive(true);
          return;
        }
        if (event.payload.type === "leave") {
          setDropActive(false);
          return;
        }
        setDropActive(false);
        const ratio = window.devicePixelRatio || 1;
        void importMedia(event.payload.paths, {
          x: event.payload.position.x / ratio,
          y: event.payload.position.y / ratio,
        });
      });
    };

    void registerDropHandler().catch(reportError);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [importMedia, reportError]);

  const connectionValidationError = useCallback(
    (connection: Connection | Edge): string | null => {
      if (!connection.source || !connection.target || connection.source === connection.target) {
        return "无效的节点连接";
      }
      const source = nodes.find((node) => node.id === connection.source)?.data.record;
      const target = nodes.find((node) => node.id === connection.target)?.data.record;
      if (!source || !target) return "找不到要连接的节点";
      if (!(["text", "image", "audio", "video"].includes(source.kind) && target.kind === "video-generation")) {
        return "只能将文字、图片、音频或视频连接到视频生成节点";
      }
      if (edges.some(
        (edge) => edge.source === connection.source && edge.target === connection.target,
      )) {
        return "这两个节点已经连接";
      }

      const mode = videoGenerationModeFromContent(target.content);
      if (mode === "text-to-video" && source.kind !== "text") {
        return "文生视频只允许连接文字节点";
      }
      if (mode === "first-last-frame") {
        if (source.kind === "audio" || source.kind === "video") {
          return "首尾帧模式不能连接音频或视频";
        }
        if (source.kind === "image") {
          const imageCount = edges
            .filter((edge) => edge.target === target.id)
            .map((edge) => nodes.find((node) => node.id === edge.source)?.data.record)
            .filter((record) => record?.kind === "image")
            .length;
          if (imageCount >= 2) return "首尾帧模式最多只能连接两张图片";
        }
      }

      return null;
    },
    [edges, nodes],
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge) => connectionValidationError(connection) === null,
    [connectionValidationError],
  );

  const connectNodes = useCallback(
    async (connection: Connection) => {
      if (!activeProjectId) return;
      const validationError = connectionValidationError(connection);
      if (validationError) {
        setNotice(validationError);
        return;
      }
      const sourceKind = nodes.find((node) => node.id === connection.source)?.data.record.kind;
      try {
        const record = await invoke<EdgeRecord>("create_edge", {
          input: {
            canvasId: activeProjectId,
            sourceNodeId: connection.source,
            targetNodeId: connection.target,
            kind: "input",
            metadata: { sourceKind },
          },
        });
        setEdges((current) =>
          current.some((edge) => edge.id === record.id)
            ? current
            : [...current, toFlowEdge(record)],
        );
        setNotice("节点已连接");
      } catch (error) {
        reportError(error);
      }
    },
    [activeProjectId, connectionValidationError, nodes, reportError, setEdges],
  );

  const deleteElements = useCallback(
    async ({
      nodes: deletedNodes,
      edges: deletedEdges,
    }: { nodes: CanvasFlowNode[]; edges: Edge[] }) => {
      try {
        if (deletedNodes.length) {
          await flushNodePatches(deletedNodes.map((node) => node.id));
          const batch = await invoke<DeletedBatch>("delete_nodes_undoable", {
            input: { ids: deletedNodes.map((node) => node.id) },
          });
          rememberDeletedBatch(batch);
          setNotice(
            `${deletedNodes.length} 个节点已删除，按 Ctrl+Z 撤销`,
          );
          return;
        }
        await Promise.all(deletedEdges.map((edge) => invoke("delete_edge", { id: edge.id })));
        setNotice("连线已删除");
      } catch (error) {
        reportError(error);
      }
    },
    [flushNodePatches, rememberDeletedBatch, reportError],
  );

  const matchedIds = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return new Set(nodes.map((node) => node.id));
    return new Set(
      nodes
        .filter((node) => {
          const record = node.data.record;
          return `${record.title}\n${textFromContent(record.content)}\n${record.source}`
            .toLocaleLowerCase()
            .includes(query);
        })
        .map((node) => node.id),
    );
  }, [nodes, search]);

  const interactiveEdges = useMemo(
    () => edges.map((edge) => ({
      ...edge,
      type: "canvasEdge",
      data: {
        ...edge.data,
        onDisconnect: (edgeId: string) => void disconnectEdge(edgeId),
      },
    })),
    [disconnectEdge, edges],
  );

  const visibleNodes = useMemo(
    () => {
      const recordsById = new Map(nodes.map((node) => [node.id, node.data.record]));
      return nodes.map((node) => {
        if (node.data.record.kind !== "video-generation") {
          return {
            ...node,
            data: {
              ...node.data,
              matched: matchedIds.has(node.id),
              inputCount: 0,
              mediaInputs: [],
              textInputCount: 0,
              textInputs: [],
              queuePosition: comfyQueuePositions[node.id] ?? null,
            },
          };
        }

        const inputRecords = edges
          .filter((edge) => edge.target === node.id)
          .map((edge) => recordsById.get(edge.source))
          .filter((record): record is NodeRecord => Boolean(record));
        const connectedMedia = inputRecords.filter(
          (record) => record.kind === "image" || record.kind === "audio" || record.kind === "video",
        );
        const connectedText = inputRecords.filter((record) => record.kind === "text");
        const connectedMediaById = new Map(connectedMedia.map((record) => [record.id, record]));
        const savedOrder = Array.isArray(node.data.record.content.mediaInputOrder)
          ? node.data.record.content.mediaInputOrder.filter(
            (inputId): inputId is string => typeof inputId === "string",
          )
          : [];
        const orderedMedia = savedOrder
          .map((inputId) => connectedMediaById.get(inputId))
          .filter((record): record is NodeRecord => Boolean(record));
        const orderedIds = new Set(orderedMedia.map((record) => record.id));
        orderedMedia.push(...connectedMedia.filter((record) => !orderedIds.has(record.id)));

        return {
          ...node,
          data: {
            ...node.data,
            matched: matchedIds.has(node.id),
            inputCount: inputRecords.length,
            mediaInputs: orderedMedia,
            textInputCount: connectedText.length,
            textInputs: connectedText,
            queuePosition: comfyQueuePositions[node.id] ?? null,
          },
        };
      });
    },
    [comfyQueuePositions, edges, matchedIds, nodes],
  );

  const focusFirstMatch = () => {
    const node = nodes.find((candidate) => matchedIds.has(candidate.id));
    if (!node) return;
    void setCenter(
      node.position.x + (node.width ?? 320) / 2,
      node.position.y + (node.height ?? 240) / 2,
      { zoom: 1, duration: 350 },
    );
  };

  const copyApiAddress = async () => {
    if (!runtime) return;
    await copyText(runtime.baseUrl);
    setCopiedApi(true);
    window.setTimeout(() => setCopiedApi(false), 1200);
  };

  const changeCanvasBackground = (color: string) => {
    if (!activeProjectId) return;
    const nextColor = validCanvasColor(color);
    if (!nextColor) return;
    setCanvasBackground(nextColor);
    window.localStorage.setItem(
      `infinite-canvas:canvas-background:${activeProjectId}`,
      nextColor,
    );
    setNotice("画布背景颜色已保存");
  };

  const resetCanvasBackground = () => {
    if (!activeProjectId) return;
    window.localStorage.removeItem(`infinite-canvas:canvas-background:${activeProjectId}`);
    setCanvasBackground(null);
    setNotice("画布背景颜色已恢复默认");
  };

  const beginProjectNameEdit = () => {
    setProjectNameDraft(canvasName);
    setEditingProjectName(true);
    window.setTimeout(() => {
      projectNameInputRef.current?.focus();
      projectNameInputRef.current?.select();
    });
  };

  const saveProjectName = async () => {
    if (!activeProjectId) return;
    const name = projectNameDraft.trim();
    setEditingProjectName(false);
    if (!name) {
      setProjectNameDraft(canvasName);
      setNotice("项目名称不能为空");
      return;
    }
    if (name === canvasName) return;
    try {
      const updated = await invoke<CanvasRecord>("update_project", {
        input: { id: activeProjectId, name },
      });
      setCanvasName(updated.name);
      setProjectNameDraft(updated.name);
      setProjects((current) => current.map((project) =>
        project.canvas.id === updated.id
          ? { ...project, canvas: updated }
          : project,
      ));
      setNotice("项目名称已保存");
    } catch (error) {
      setProjectNameDraft(canvasName);
      reportError(error);
    }
  };

  const openAppSettings = () => {
    setComfyOutputRootDraft(comfyOutputRoot);
    setComfyInputRootDraft(comfyInputRoot);
    setSettingsOpen(true);
  };

  const appSettingsDialog = settingsOpen && createPortal(
    <div className="project-dialog-backdrop" onMouseDown={() => setSettingsOpen(false)}>
      <form
        className="project-dialog app-settings-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          saveComfyDirectories();
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="project-dialog-icon"><Settings2 size={21} /></div>
        <div>
          <h2>应用设置</h2>
          <p>配置远程 ComfyUI 输入和输出目录在 Windows 中对应的映射路径。</p>
        </div>
        <label>
          ComfyUI 输入映射目录
          <input
            autoFocus
            value={comfyInputRootDraft}
            onChange={(event) => setComfyInputRootDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setSettingsOpen(false);
              }
            }}
            placeholder="例如：X:\ComfyUI_windows_portable\ComfyUI\input"
            spellCheck={false}
          />
          <small>
            用于在任务结束后删除本次上传的 infinite-canvas 缓存目录；留空则不自动清理。
          </small>
        </label>
        <label>
          ComfyUI 输出映射目录
          <input
            value={comfyOutputRootDraft}
            onChange={(event) => setComfyOutputRootDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setSettingsOpen(false);
              }
            }}
            placeholder="例如：X:\ComfyUI_windows_portable\ComfyUI\output"
            spellCheck={false}
          />
          <small>
            请选择或填写远端 ComfyUI 的 output 根目录，不要包含生成任务的子文件夹和文件名。
          </small>
        </label>
        <div className="project-dialog-actions">
          <button type="button" className="dialog-cancel" onClick={() => setSettingsOpen(false)}>
            取消
          </button>
          <button type="submit" className="primary-button">
            保存设置
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );

  if (!activeProjectId) {
    return (
      <main className="project-home">
        <header className="project-home-header">
          <div className="project-home-brand">
            <div className="project-home-mark"><Sparkles size={22} /></div>
            <div>
              <strong>InfiniteCanvas</strong>
              <span>项目工作区</span>
            </div>
          </div>
          <div className="project-header-actions">
            <label className="project-columns-control">
              <span>每行项目数</span>
              <input
                type="range"
                min={3}
                max={8}
                step={1}
                value={projectColumns}
                onChange={(event) => setProjectColumns(Number(event.currentTarget.value))}
                aria-label="每行显示项目数量"
              />
              <output>{projectColumns}</output>
            </label>
            <button
              className="system-settings-button"
              onClick={openAppSettings}
              title="应用设置"
              aria-label="打开应用设置"
            >
              <Settings2 size={16} />
            </button>
            <button
              className="theme-toggle-button"
              onClick={toggleTheme}
              title={theme === "dark" ? "切换到白色模式" : "切换到黑暗模式"}
              aria-label={theme === "dark" ? "切换到白色模式" : "切换到黑暗模式"}
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </div>
        </header>

        <section className="project-home-content">
          <div className="project-section-heading">
            <div>
              <span className="eyebrow">PROJECTS</span>
              <h1>选择一个画布项目</h1>
              <p>每个项目拥有独立的节点、图片、连接和生成流程。</p>
            </div>
            <span className="project-total">{projects.length} 个项目</span>
          </div>

          <div
            className="project-grid"
            style={{ gridTemplateColumns: `repeat(${projectColumns}, minmax(0, 1fr))` }}
          >
            <button
              className="new-project-card"
              onClick={() => setCreateProjectOpen(true)}
              disabled={!projectHomeReady}
            >
              <span className="new-project-icon"><Plus size={26} /></span>
              <strong>新建项目</strong>
              <span>创建一张新的无限画布</span>
            </button>

            {projects.map((project) => (
              <article
                className="project-card"
                key={project.canvas.id}
                role="button"
                tabIndex={0}
                onClick={() => void openProject(project.canvas.id)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  void openProject(project.canvas.id);
                }}
              >
                <ProjectThumbnail project={project} />
                <div className="project-card-info">
                  <div>
                    <strong>{project.canvas.name}</strong>
                    <span>
                      更新于 {new Intl.DateTimeFormat("zh-CN", {
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      }).format(new Date(project.canvas.updatedAt))}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="project-delete"
                    aria-label={`删除项目：${project.canvas.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setProjectToDelete(project);
                    }}
                  >
                    删除 <Trash2 size={13} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>

        {createProjectOpen && (
          <div className="project-dialog-backdrop" onMouseDown={() => setCreateProjectOpen(false)}>
            <form
              className="project-dialog"
              onSubmit={(event) => {
                event.preventDefault();
                void createProject();
              }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="project-dialog-icon"><FolderKanban size={22} /></div>
              <div>
                <h2>新建项目</h2>
                <p>项目会创建一张独立的无限画布。</p>
              </div>
              <label>
                项目名称
                <input
                  autoFocus
                  value={newProjectName}
                  onChange={(event) => setNewProjectName(event.currentTarget.value)}
                  placeholder="例如：产品宣传片"
                  maxLength={120}
                />
              </label>
              <div className="project-dialog-actions">
                <button type="button" className="dialog-cancel" onClick={() => setCreateProjectOpen(false)}>
                  取消
                </button>
                <button type="submit" className="primary-button" disabled={!newProjectName.trim()}>
                  创建并进入
                </button>
              </div>
            </form>
          </div>
        )}

        {projectToDelete && (
          <div
            className="project-dialog-backdrop"
            onMouseDown={() => {
              if (!deletingProjectId) setProjectToDelete(null);
            }}
          >
            <div
              className="project-dialog project-delete-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="delete-project-title"
              aria-describedby="delete-project-description"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="project-dialog-icon"><Trash2 size={22} /></div>
              <div>
                <h2 id="delete-project-title">确认删除项目？</h2>
                <p id="delete-project-description">
                  “{projectToDelete.canvas.name}”中的所有节点和连线都会被永久删除，此操作无法撤销。
                </p>
              </div>
              <div className="project-dialog-actions">
                <button
                  type="button"
                  className="dialog-cancel"
                  autoFocus
                  disabled={Boolean(deletingProjectId)}
                  onClick={() => setProjectToDelete(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="dialog-danger"
                  disabled={Boolean(deletingProjectId)}
                  onClick={() => void deleteProject()}
                >
                  <Trash2 size={14} />
                  {deletingProjectId ? "正在删除…" : "确认删除"}
                </button>
              </div>
            </div>
          </div>
        )}
        {appSettingsDialog}
      </main>
    );
  }

  return (
    <main
      className="app-shell"
      style={canvasBackground ? { background: canvasBackground } : undefined}
    >
      <ReactFlow<CanvasFlowNode, Edge>
        nodes={visibleNodes}
        edges={interactiveEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={connectNodes}
        onPaneClick={() => setCanvasContextMenu(null)}
        onPaneContextMenu={openCanvasContextMenu}
        isValidConnection={isValidConnection}
        onDelete={deleteElements}
        onNodeDragStop={(_, node) => persistPatch(node.id, { x: node.position.x, y: node.position.y })}
        minZoom={0.12}
        maxZoom={2.2}
        snapToGrid
        snapGrid={CANVAS_SNAP_GRID}
        defaultEdgeOptions={{ type: "canvasEdge", animated: false }}
        deleteKeyCode={["Backspace", "Delete"]}
        selectionOnDrag
        panOnScroll
        fitView
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={CANVAS_GRID_SIZE}
          size={1.2}
          color={canvasGridColor(canvasBackground, theme)}
        />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={(node) =>
            (node.data as CanvasNodeData | undefined)?.record.kind === "image"
              ? "#4eb9c8"
              : (node.data as CanvasNodeData | undefined)?.record.kind === "audio"
                ? "#c77dd6"
              : (node.data as CanvasNodeData | undefined)?.record.kind === "note"
                ? "#c8a957"
              : (node.data as CanvasNodeData | undefined)?.record.kind === "video"
                ? "#d8ad55"
              : (node.data as CanvasNodeData | undefined)?.record.kind === "video-generation"
                ? "#e48a65"
              : (node.data as CanvasNodeData | undefined)?.record.kind === "generated-video"
                ? "#6fb5df"
                : "#8b7cf6"
          }
          maskColor={theme === "light" ? "rgba(238, 240, 245, 0.72)" : "rgba(9, 11, 17, 0.75)"}
        />

        <Panel position="top-left" className="brand-panel">
          <button className="project-back-button" onClick={() => void returnToProjects()} title="返回项目首页">
            <ArrowLeft size={16} />
          </button>
          <div className="active-project-identity">
            {editingProjectName ? (
              <input
                ref={projectNameInputRef}
                className="project-name-editor"
                value={projectNameDraft}
                onChange={(event) => setProjectNameDraft(event.currentTarget.value)}
                onBlur={() => void saveProjectName()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setProjectNameDraft(canvasName);
                    setEditingProjectName(false);
                  }
                }}
                maxLength={120}
                aria-label="项目名称"
              />
            ) : (
              <button className="project-name-button" onClick={beginProjectNameEdit} title="修改项目名称">
                <strong>{canvasName}</strong>
                <Pencil size={12} />
              </button>
            )}
            <span>InfiniteCanvas · Project</span>
          </div>
        </Panel>

        <Panel position="top-center" className="toolbar-panel">
          <label className="search-field">
            <Search size={15} />
            <input
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              onKeyDown={(event) => event.key === "Enter" && focusFirstMatch()}
              placeholder="搜索节点"
            />
            {search && (
              <button onClick={() => setSearch("")} title="清空搜索"><X size={13} /></button>
            )}
          </label>
          {search && <span className="match-count">{matchedIds.size} 个结果</span>}
        </Panel>

        <Panel position="top-right" className="api-panel">
          <span className="live-indicator"><Radio size={14} /> 本地 API</span>
          <label className="canvas-color-picker" title="选择当前项目的画布背景颜色">
            <Palette size={14} />
            <input
              type="color"
              value={canvasBackground ?? (theme === "light" ? "#eef0f5" : "#090b11")}
              onChange={(event) => changeCanvasBackground(event.currentTarget.value)}
              aria-label="画布背景颜色"
            />
          </label>
          {canvasBackground && (
            <button
              className="canvas-background-reset"
              onClick={resetCanvasBackground}
              title="恢复默认画布背景颜色"
              aria-label="恢复默认画布背景颜色"
            >
              <RotateCcw size={13} />
            </button>
          )}
          <button
            className="canvas-theme-toggle"
            onClick={toggleTheme}
            title={theme === "dark" ? "切换到白色模式" : "切换到黑暗模式"}
            aria-label={theme === "dark" ? "切换到白色模式" : "切换到黑暗模式"}
          >
            {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
          </button>
          <button onClick={copyApiAddress} disabled={!runtime} title="复制 API 地址">
            {copiedApi ? <Check size={14} /> : <Copy size={14} />}
            {runtime?.baseUrl.replace("http://", "") ?? "正在启动"}
          </button>
        </Panel>

        <Panel position="bottom-center" className="status-panel">
          <Link2 size={13} />
          <span>{notice}</span>
          <span className="status-separator">·</span>
          <span>{nodes.length} 个节点</span>
          <span className="status-separator">·</span>
          <span>{edges.length} 条连接</span>
        </Panel>

        {dropActive && (
          <div className="drop-overlay" aria-hidden="true">
            <div className="drop-message">
              <Upload size={28} />
              <strong>释放图片、音频或视频，添加到画布</strong>
              <span>保持媒体原始比例，不拉伸、不裁切</span>
            </div>
          </div>
        )}
      </ReactFlow>
      {canvasContextMenu && createPortal(
        <div
          className="canvas-context-menu"
          style={{ left: canvasContextMenu.screenX, top: canvasContextMenu.screenY }}
          role="menu"
          aria-label="新建节点"
          onContextMenu={(event) => event.preventDefault()}
        >
          <span className="canvas-context-menu-title">新建节点</span>
          <button type="button" role="menuitem" onClick={() => createNodeFromContextMenu("text")}>
            <FileText size={15} />
            <span><strong>文本节点</strong><small>输入提示词或普通文本</small></span>
          </button>
          <button type="button" role="menuitem" onClick={() => createNodeFromContextMenu("note")}>
            <StickyNote size={15} />
            <span><strong>备注节点</strong><small>记录说明和想法</small></span>
          </button>
          <button type="button" role="menuitem" onClick={() => createNodeFromContextMenu("video-generation")}>
            <Clapperboard size={15} />
            <span><strong>视频生成节点</strong><small>连接素材并提交生成</small></span>
          </button>
        </div>,
        document.body,
      )}
    </main>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <CanvasWorkspace />
    </ReactFlowProvider>
  );
}
