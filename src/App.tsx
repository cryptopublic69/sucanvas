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
  LockKeyhole,
  Moon,
  Maximize2,
  Music,
  Pause,
  Palette,
  PenLine,
  Pencil,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Square,
  StickyNote,
  Sun,
  Trash2,
  Upload,
  Eye,
  EyeOff,
  X,
} from "lucide-react";
import {
  ChangeEvent,
  CSSProperties,
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
  isPrivate: boolean;
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

interface AppLockStatus {
  enabled: boolean;
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
  executionElapsedSeconds?: number | null;
  cleanupWarning?: string;
}

interface ComfyQueueSummary {
  runningCount: number;
  pendingCount: number;
  totalCount: number;
}

interface ComfyClientTaskStatus {
  clientId: string;
  promptId: string | null;
  status: "running" | "pending" | "success" | "error" | "cancelled" | "missing";
  seed: string | null;
  outputs: ComfyOutputFile[];
  executionElapsedSeconds?: number | null;
}

interface GenerationSnapshot {
  prompt: string;
  promptNodeId: string;
  promptNodeIdSource: "captured" | "verified" | "";
  durationSeconds: number;
  aspectRatio: VideoAspectRatio;
  primaryResolutionMegapixels: number;
  secondaryResolutionMegapixels: number;
  loraName: string;
  loraStrength: number;
  imagePaths: string[];
  audioPaths: string[];
  videoPaths: string[];
}

interface PersistedComfyTask {
  clientId: string;
  nodeId: string;
  canvasId: string;
  snapshot: GenerationSnapshot;
  startedAt: number;
  kind?: "generation" | "secondary";
  sourceGeneratorId?: string;
  placeholderNodeId?: string;
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

type VideoDeletionChoice = "cancel" | "node-only" | "node-and-file";

interface VideoDeletionRequest {
  videoCount: number;
  filePaths: string[];
  resolve: (choice: VideoDeletionChoice) => void;
}

interface H3LoraPreference {
  loraName: string;
  loraStrength: number;
}

interface CanvasNodeData extends Record<string, unknown> {
  record: NodeRecord;
  matched: boolean;
  relationHighlighted: boolean;
  activeTaskCount: number;
  inputCount: number;
  mediaInputs: NodeRecord[];
  textInputCount: number;
  textInputs: NodeRecord[];
  h3LoraOptions: string[];
  onH3LoraPreferenceChange: (preference: H3LoraPreference) => void;
  onChange: (id: string, patch: NodePatch) => void;
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

function recordAtCurrentFlowPosition(node: CanvasFlowNode): NodeRecord {
  return {
    ...node.data.record,
    x: node.position.x,
    y: node.position.y,
  };
}

const CANVAS_GRID_SIZE = 24;
const CANVAS_SNAP_GRID: [number, number] = [CANVAS_GRID_SIZE, CANVAS_GRID_SIZE];
const AUDIO_NODE_MIN_HEIGHT = 240;
const VIDEO_NODE_BASE_HEIGHT = 480;
const MEDIA_NODE_CHROME_HEIGHT = 73;
const GENERATED_VIDEO_PREVIEW_WIDTH = 360;
const DEFAULT_GENERATED_VIDEO_ASPECT_RATIO = 16 / 9;
const COMFYUI_SERVER_URL = "http://192.168.5.108:8188";
const DEFAULT_GENERATION_SEED = "56456340597885880";
const DEFAULT_H3_LORA_NAME = "MinimaxH3\\minimax_h3_turbo_4STEPS_comfyui.safetensors";
const H3_LORA_PREFERENCE_STORAGE_KEY = "infinite-canvas:h3-lora-preference";
const DEFAULT_H3_REFERENCE_WORKFLOW_PATH = "D:\\Downloads\\MiniMax+H3全能参考工作流.json";
const H3_REFERENCE_WORKFLOW_STORAGE_KEY = "infinite-canvas:h3-reference-workflow-path";
const COMFY_TASK_STORAGE_KEY = "infinite-canvas:comfy-tasks";
const PRIVATE_PROJECT_VISIBILITY_STORAGE_KEY = "infinite-canvas:show-private-projects";
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
const VIDEO_ASPECT_RATIO_OPTIONS = [
  { value: "16:9", ratio: 16 / 9 },
  { value: "9:16", ratio: 9 / 16 },
  { value: "4:3", ratio: 4 / 3 },
  { value: "3:4", ratio: 3 / 4 },
  { value: "3:2", ratio: 3 / 2 },
  { value: "2:3", ratio: 2 / 3 },
  { value: "1:1", ratio: 1 },
] as const;
const VIDEO_PREVIEW_DEFAULT_COLOR = "#6fb5df";
const VIDEO_PREVIEW_SECONDARY_COLOR = "#2f6f50";
const VIDEO_PREVIEW_DEFAULT_HIGHLIGHT_COLOR = "#8b7cf6";
const VIDEO_PREVIEW_SECONDARY_HIGHLIGHT_COLOR = "#59d58a";
const VIDEO_PREVIEW_COLOR_PRESETS = [
  { value: VIDEO_PREVIEW_DEFAULT_COLOR, highlight: VIDEO_PREVIEW_DEFAULT_HIGHLIGHT_COLOR, label: "默认颜色" },
  { value: VIDEO_PREVIEW_SECONDARY_COLOR, highlight: VIDEO_PREVIEW_SECONDARY_HIGHLIGHT_COLOR, label: "墨绿色" },
  { value: "#7a343b", highlight: "#ff6b7a", label: "暗红色" },
  { value: "#7a6728", highlight: "#f0c84b", label: "暗黄色" },
  { value: "#315b80", highlight: "#5bbcff", label: "暗蓝色" },
] as const;

function mediaNodeHeightForAspectRatio(width: number, aspectRatio: number): number {
  return Math.min(
    2400,
    Math.max(180, width / aspectRatio + MEDIA_NODE_CHROME_HEIGHT),
  );
}

type VideoGenerationMode = typeof VIDEO_GENERATION_MODES[number]["value"];
type VideoAspectRatio = typeof VIDEO_ASPECT_RATIO_OPTIONS[number]["value"];
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

function comfyProgressFromSocketData(data: unknown): {
  value: number;
  maximum: number;
  progress: number;
} | null {
  if (typeof data !== "string") return null;
  try {
    const message = JSON.parse(data) as JsonObject;
    if (message.type !== "progress" || !message.data || typeof message.data !== "object") return null;
    const progressData = message.data as JsonObject;
    const value = typeof progressData.value === "number" ? progressData.value : null;
    const maximum = typeof progressData.max === "number" ? progressData.max : null;
    if (value === null || maximum === null || maximum <= 0) return null;
    return {
      value,
      maximum,
      progress: Math.max(0, Math.min(100, (value / maximum) * 100)),
    };
  } catch {
    // ComfyUI also sends binary previews; they are intentionally ignored here.
    return null;
  }
}

function comfyPreviewRequestId(
  canvasId: string,
  sourceNodeId: string,
  promptId: string,
  outputIndex: number,
): string {
  return `comfy-preview:${canvasId}:${sourceNodeId}:${promptId}:${outputIndex}`;
}

function appendUniqueById<T extends { id: string }>(current: T[], additions: T[]): T[] {
  if (!additions.length) return current;
  const ids = new Set(current.map((item) => item.id));
  const uniqueAdditions = additions.filter((item) => {
    if (ids.has(item.id)) return false;
    ids.add(item.id);
    return true;
  });
  return uniqueAdditions.length ? [...current, ...uniqueAdditions] : current;
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
  const groupCount = new Set(mediaKinds).size;
  const imageCount = mediaKinds.filter((kind) => kind === "image").length;
  const audioCount = mediaKinds.filter((kind) => kind === "audio").length;
  const videoCount = mediaKinds.length - imageCount - audioCount;
  const listMediaRows = videoCount + Math.ceil(audioCount / 2);
  const imageColumns = Math.max(1, Math.floor((Math.max(180, nodeWidth - 32) + 6) / 66));
  const imageRows = imageCount ? Math.ceil(imageCount / imageColumns) : 0;
  const textRows = Math.max(1, textInputCount);
  const contentHeight = 439
    + listMediaRows * 51
    + imageRows * 66
    + groupCount * 30
    + textRows * 51
    + 30;
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

function copiedVideoGenerationContent(content: JsonObject): JsonObject {
  const copied = structuredClone(content);
  for (const key of [
    "comfyPromptId",
    "comfyServerUrl",
    "generatedSeeds",
    "generatedVideos",
    "generationCount",
    "generationElapsedSeconds",
    "generationSnapshot",
    "lastGenerationSeed",
  ]) {
    delete copied[key];
  }
  return {
    ...copied,
    status: "idle",
    executionProgress: null,
    validationMessage: "",
  };
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

function validExecutionElapsedSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function previewThemeColorFromContent(content: JsonObject): string | null {
  const value = content.previewThemeColor;
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

function generatedPreviewPosition(
  generator: NodeRecord,
  existingNodes: NodeRecord[],
  width: number,
  height: number,
): { x: number; y: number } {
  const horizontalGap = CANVAS_GRID_SIZE * 2;
  const verticalGap = CANVAS_GRID_SIZE / 2;
  const previousPreviews = existingNodes.filter((node) => (
    node.kind === "generated-video"
    && node.content.sourceGeneratorId === generator.id
    && typeof node.content.sourcePreviewId !== "string"
  ));
  const latestPreview = previousPreviews.reduce<NodeRecord | null>((latest, node) => {
    if (!latest) return node;
    const latestCreatedAt = Date.parse(latest.createdAt) || 0;
    const nodeCreatedAt = Date.parse(node.createdAt) || 0;
    return nodeCreatedAt >= latestCreatedAt ? node : latest;
  }, null);
  if (latestPreview) {
    return {
      x: latestPreview.x,
      y: latestPreview.y + latestPreview.height + verticalGap,
    };
  }

  const x = snapCanvasCoordinate(generator.x + generator.width + horizontalGap);
  let y = generator.y;
  for (let attempt = 0; attempt <= existingNodes.length; attempt += 1) {
    const blocked = existingNodes.some((node) => (
      x < node.x + node.width + verticalGap
      && x + width + verticalGap > node.x
      && y < node.y + node.height + verticalGap
      && y + height + verticalGap > node.y
    ));
    if (!blocked) return { x, y };
    y += height + verticalGap;
  }
  return { x, y };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item))
    : [];
}

function persistedComfyTasksFromStorage(): PersistedComfyTask[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(COMFY_TASK_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((task): task is PersistedComfyTask => (
      task && typeof task === "object"
      && typeof task.clientId === "string"
      && typeof task.nodeId === "string"
      && typeof task.canvasId === "string"
      && typeof task.startedAt === "number"
      && task.snapshot && typeof task.snapshot === "object"
      && (task.kind === undefined || task.kind === "generation" || task.kind === "secondary")
      && (task.sourceGeneratorId === undefined || typeof task.sourceGeneratorId === "string")
      && (task.placeholderNodeId === undefined || typeof task.placeholderNodeId === "string")
    )).map((task) => ({
      ...task,
      snapshot: {
        ...task.snapshot,
        promptNodeId: typeof task.snapshot.promptNodeId === "string"
          ? task.snapshot.promptNodeId
          : "",
        promptNodeIdSource: task.snapshot.promptNodeIdSource === "captured"
          || task.snapshot.promptNodeIdSource === "verified"
          ? task.snapshot.promptNodeIdSource
          : "",
        aspectRatio: videoAspectRatioFromContent({
          generationAspectRatio: task.snapshot.aspectRatio,
        }),
      },
    }));
  } catch {
    return [];
  }
}

function isSecondaryComfyTask(task: PersistedComfyTask): boolean {
  return task.kind === "secondary";
}

function generationSnapshotFromContent(content: JsonObject): GenerationSnapshot | null {
  const value = content.generationSnapshot;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as JsonObject;
  if (typeof snapshot.prompt !== "string" || !snapshot.prompt.trim()) return null;
  return {
    prompt: snapshot.prompt,
    promptNodeId: typeof snapshot.promptNodeId === "string" ? snapshot.promptNodeId : "",
    promptNodeIdSource: snapshot.promptNodeIdSource === "captured"
      || snapshot.promptNodeIdSource === "verified"
      ? snapshot.promptNodeIdSource
      : "",
    durationSeconds: typeof snapshot.durationSeconds === "number"
      ? snapshot.durationSeconds
      : 15,
    aspectRatio: videoAspectRatioFromContent({
      generationAspectRatio: snapshot.aspectRatio,
    }),
    primaryResolutionMegapixels: validVideoResolution(
      snapshot.primaryResolutionMegapixels,
      0.4,
    ),
    secondaryResolutionMegapixels: validVideoResolution(
      snapshot.secondaryResolutionMegapixels,
      0.5,
    ),
    loraName: h3LoraNameFromContent(snapshot),
    loraStrength: h3LoraStrengthFromContent(snapshot),
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

function videoAspectRatioFromContent(content: JsonObject): VideoAspectRatio {
  const value = content.generationAspectRatio ?? content.aspectRatioLabel;
  return typeof value === "string"
    && VIDEO_ASPECT_RATIO_OPTIONS.some((option) => option.value === value)
    ? value as VideoAspectRatio
    : "16:9";
}

function videoAspectRatioValue(value: VideoAspectRatio): number {
  return VIDEO_ASPECT_RATIO_OPTIONS.find((option) => option.value === value)?.ratio
    ?? DEFAULT_GENERATED_VIDEO_ASPECT_RATIO;
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

function isMinimaxH3LoraName(value: string): boolean {
  const [directory, ...filenameParts] = value.trim().replace(/\//g, "\\").split("\\");
  return directory.toLocaleLowerCase() === "minimaxh3" && filenameParts.join("\\").trim().length > 0;
}

function h3LoraNameFromContent(content: JsonObject): string {
  const value = content.generationLoraName ?? content.loraName;
  return typeof value === "string" && isMinimaxH3LoraName(value)
    ? value
    : DEFAULT_H3_LORA_NAME;
}

function h3LoraStrengthFromContent(content: JsonObject): number {
  const value = content.generationLoraStrength ?? content.loraStrength;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2
    ? Math.round(value * 20) / 20
    : 1;
}

function h3LoraDisplayName(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function h3LoraPreferenceFromStorage(): H3LoraPreference {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(H3_LORA_PREFERENCE_STORAGE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const content = parsed as JsonObject;
    return {
      loraName: h3LoraNameFromContent(content),
      loraStrength: h3LoraStrengthFromContent(content),
    };
  } catch {
    return { loraName: DEFAULT_H3_LORA_NAME, loraStrength: 1 };
  }
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
      return { valid: false, message: "已连接的文字节点内容为空，请先填写" };
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
    return { valid: false, message: "已连接的文字节点内容为空，请先填写" };
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
    relationHighlighted,
    activeTaskCount,
    inputCount,
    mediaInputs,
    textInputCount,
    textInputs,
    h3LoraOptions,
    onH3LoraPreferenceChange,
    onChange,
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
  const [promptCopied, setPromptCopied] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(record.title);
  const [titleOverflowing, setTitleOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [previewColorMenuOpen, setPreviewColorMenuOpen] = useState(false);
  const [aspectRatioMenuOpen, setAspectRatioMenuOpen] = useState(false);
  const [connectedTextEditor, setConnectedTextEditor] = useState<{
    id: string;
    title: string;
    content: JsonObject;
    text: string;
  } | null>(null);
  const [draggedMediaId, setDraggedMediaId] = useState<string | null>(null);
  const [dragOverMediaId, setDragOverMediaId] = useState<string | null>(null);
  const [removingMediaId, setRemovingMediaId] = useState<string | null>(null);
  const [clearingImages, setClearingImages] = useState(false);
  const [imageIdsPendingClear, setImageIdsPendingClear] = useState<string[] | null>(null);
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState(() => textFromContent(record.content));
  const [textEditorFocused, setTextEditorFocused] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleDisplayRef = useRef<HTMLSpanElement>(null);
  const previewColorControlRef = useRef<HTMLDivElement>(null);
  const aspectRatioControlRef = useRef<HTMLDivElement>(null);
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
  const isSecondaryPreview = isGeneratedVideo
    && typeof record.content.sourcePreviewId === "string";
  const supportsPreviewColor = isText || (
    isGeneratedVideo
    && typeof record.content.videoUrl === "string"
    && Boolean(record.content.videoUrl)
  );
  const previewThemeColor = previewThemeColorFromContent(record.content);
  const previewDisplayColor = previewThemeColor
    ?? (isSecondaryPreview ? VIDEO_PREVIEW_SECONDARY_COLOR : VIDEO_PREVIEW_DEFAULT_COLOR);
  const usesDefaultPreviewTheme = previewDisplayColor === VIDEO_PREVIEW_DEFAULT_COLOR;
  const usesSecondaryGreenTheme = isGeneratedVideo
    && previewDisplayColor === VIDEO_PREVIEW_SECONDARY_COLOR;
  const usesCustomPreviewTheme = supportsPreviewColor
    && Boolean(previewThemeColor)
    && !usesDefaultPreviewTheme
    && !usesSecondaryGreenTheme;
  const previewHighlightColor = VIDEO_PREVIEW_COLOR_PRESETS.find(
    (preset) => preset.value === previewDisplayColor,
  )?.highlight ?? previewDisplayColor;
  const previewThemeStyle = supportsPreviewColor
    ? {
        "--preview-theme-color": previewDisplayColor,
        "--preview-highlight-color": previewHighlightColor,
      } as CSSProperties
    : undefined;
  const videoGenerationMode = videoGenerationModeFromContent(record.content);
  const videoDuration = videoDurationFromContent(record.content);
  const videoAspectRatio = videoAspectRatioFromContent(record.content);
  const primaryVideoResolution = primaryVideoResolutionFromContent(record.content);
  const secondaryVideoResolution = secondaryVideoResolutionFromContent(record.content);
  const h3LoraName = h3LoraNameFromContent(record.content);
  const h3LoraStrength = h3LoraStrengthFromContent(record.content);
  const selectableH3Loras = h3LoraOptions.includes(h3LoraName)
    ? h3LoraOptions
    : [h3LoraName, ...h3LoraOptions];
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
  const isGenerationPlaceholder = isGeneratedVideo
    && record.content.generationPlaceholder === true
    && !generatedVideoUrl;
  const placeholderActive = record.content.status === "running"
    || record.content.status === "cancelling";
  const generatedVideoSeed = typeof record.content.seed === "string"
    ? record.content.seed
    : "";
  const generatedVideoPrompt = generationSnapshotFromContent(record.content)?.prompt ?? "";
  const isUnplayedGeneratedVideo = isGeneratedVideo
    && Boolean(generatedVideoUrl)
    && record.content.hasBeenPlayed === false;
  const executionRunning = activeTaskCount > 0;
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
    setTextDraft(savedText);
  }, [savedText]);

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
    const titleElement = titleDisplayRef.current;
    if (!titleElement || editingTitle) {
      setTitleOverflowing(false);
      return;
    }
    const measureOverflow = () => {
      setTitleOverflowing(titleElement.scrollWidth > titleElement.clientWidth + 1);
    };
    measureOverflow();
    const observer = new ResizeObserver(measureOverflow);
    observer.observe(titleElement);
    return () => observer.disconnect();
  }, [editingTitle, record.title]);

  useEffect(() => {
    if (!previewColorMenuOpen) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof globalThis.Node && previewColorControlRef.current?.contains(target)) return;
      setPreviewColorMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown, true);
  }, [previewColorMenuOpen]);

  useEffect(() => {
    if (!aspectRatioMenuOpen) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof globalThis.Node && aspectRatioControlRef.current?.contains(target)) return;
      setAspectRatioMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown, true);
  }, [aspectRatioMenuOpen]);

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
    onChange(id, {
      content: { ...record.content, text: nextText },
    });
  };

  const openConnectedTextEditor = (input: NodeRecord) => {
    const inputText = textFromContent(input.content);
    setConnectedTextEditor({
      id: input.id,
      title: input.title || "未命名文本",
      content: input.content,
      text: inputText,
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

  const copyGeneratedPrompt = () => {
    if (!generatedVideoPrompt) return;
    onCopy(generatedVideoPrompt);
    setPromptCopied(true);
    window.setTimeout(() => setPromptCopied(false), 1200);
  };

  const markGeneratedVideoPlayed = () => {
    if (!isUnplayedGeneratedVideo) return;
    onChange(id, {
      content: {
        ...record.content,
        hasBeenPlayed: true,
      },
    });
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
    const fittedHeight = mediaNodeHeightForAspectRatio(record.width, aspectRatio);
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

  const clearConnectedImages = async () => {
    if (!imageIdsPendingClear?.length || clearingImages) return;
    setClearingImages(true);
    try {
      for (const inputId of imageIdsPendingClear) {
        await onRemoveInput(id, inputId);
      }
      setImageIdsPendingClear(null);
    } finally {
      setClearingImages(false);
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
    <article
      className={`canvas-node kind-${record.kind} ${usesSecondaryGreenTheme ? "is-secondary-preview" : ""} ${usesCustomPreviewTheme ? "has-custom-preview-color" : ""} ${relationHighlighted ? "is-relation-highlighted" : ""} ${matched ? "" : "is-dimmed"}`}
      style={previewThemeStyle}
    >
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
              ref={titleDisplayRef}
              className="node-title node-title-display"
              title={titleOverflowing ? (record.title || "未命名节点") : "双击修改标题"}
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
        {supportsPreviewColor && (
          <div
            ref={previewColorControlRef}
            className="nodrag node-preview-color-control"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="node-preview-color-picker"
              onClick={() => setPreviewColorMenuOpen((open) => !open)}
              title={isText ? "选择文本节点颜色" : "选择视频预览颜色"}
              aria-label={isText ? "选择文本节点颜色" : "选择视频预览颜色"}
              aria-expanded={previewColorMenuOpen}
            >
              <Palette size={13} />
            </button>
            {previewColorMenuOpen && (
              <div
                className="node-preview-color-presets"
                role="menu"
                aria-label={isText ? "文本节点颜色预设" : "视频预览颜色预设"}
              >
                {VIDEO_PREVIEW_COLOR_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    role="menuitem"
                    className={previewDisplayColor === preset.value ? "is-active" : ""}
                    style={{ "--preview-preset-color": preset.value } as CSSProperties}
                    onClick={() => {
                      onChange(id, {
                        content: {
                          ...record.content,
                          previewThemeColor: preset.value,
                        },
                      });
                      setPreviewColorMenuOpen(false);
                    }}
                    title={preset.label}
                    aria-label={preset.label}
                  >
                    <span
                      className={preset.value === VIDEO_PREVIEW_DEFAULT_COLOR ? "is-default" : ""}
                      aria-hidden="true"
                    />
                    {preset.label}
                  </button>
                ))}
              </div>
            )}
          </div>
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
          title={isGenerationPlaceholder ? "取消任务并删除占位节点" : "删除节点"}
          aria-label={isGenerationPlaceholder ? "取消任务并删除占位节点" : "删除节点"}
        >
          {isGenerationPlaceholder ? <X size={14} /> : <Trash2 size={14} />}
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
            aria-label="文本内容"
            spellCheck={false}
          />
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
              {isUnplayedGeneratedVideo && (
                <span className="generated-video-new-badge" aria-label="新生成且尚未播放">
                  NEW
                </span>
              )}
              <video
                ref={generatedVideoRef}
                src={generatedVideoUrl}
                controls
                preload="metadata"
                onPlay={markGeneratedVideoPlayed}
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
          ) : isGenerationPlaceholder ? (
            <div className={`generated-video-placeholder ${placeholderActive ? "is-active" : "is-stopped"}`}>
              <div className="generated-video-placeholder-flow" aria-hidden="true">
                <span className="generated-video-placeholder-blob blob-blue" />
                <span className="generated-video-placeholder-blob blob-mist" />
                <span className="generated-video-placeholder-blob blob-sky" />
                <span className="generated-video-placeholder-blob blob-shadow" />
              </div>
              <span className="generated-video-placeholder-message" title={validationMessage}>
                {validationMessage || (placeholderActive ? "正在等待 ComfyUI 返回视频…" : "生成任务未完成")}
              </span>
              {placeholderActive && (
                <div
                  className={`video-execution-progress ${executionProgress === null ? "is-indeterminate" : ""}`}
                  role="progressbar"
                  aria-label={isSecondaryPreview ? "二次采样生成进度" : "视频生成进度"}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={executionProgress ?? undefined}
                >
                  <span style={executionProgress === null ? undefined : { width: `${executionProgress}%` }} />
                </div>
              )}
            </div>
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
          <div className="video-duration-control">
            <label className="video-duration-inline">
              <span>时长</span>
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
              <output>{videoDuration} 秒</output>
            </label>
            <div ref={aspectRatioControlRef} className="video-aspect-ratio-inline">
              <button
                type="button"
                className="nodrag nowheel video-aspect-ratio-toggle"
                aria-haspopup="menu"
                aria-expanded={aspectRatioMenuOpen}
                onClick={() => setAspectRatioMenuOpen((open) => !open)}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <span className="video-aspect-ratio-label">画面比例</span>
                <span className="video-aspect-ratio-value">{videoAspectRatio}</span>
                <span className="video-aspect-ratio-arrow" aria-hidden="true">▾</span>
              </button>
              {aspectRatioMenuOpen && (
                <div className="video-aspect-ratio-menu" role="menu" aria-label="画面比例">
                  {VIDEO_ASPECT_RATIO_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={videoAspectRatio === option.value}
                      className={videoAspectRatio === option.value ? "is-active" : ""}
                      onClick={() => {
                        onChange(id, {
                          content: {
                            ...record.content,
                            generationAspectRatio: option.value,
                            status: "idle",
                            validationMessage: "",
                          },
                        });
                        setAspectRatioMenuOpen(false);
                      }}
                    >
                      {option.value}
                    </button>
                  ))}
                </div>
              )}
              {/* Native select option fonts are ignored by Windows WebView2, so this menu is custom. */}
            </div>
          </div>
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
          <div className="video-lora-control">
            <span>H3 LoRA</span>
            <select
              className="nodrag nowheel"
              value={h3LoraName}
              title={h3LoraName}
              aria-label="MiniMax H3 LoRA"
              onChange={(event) => {
                const loraName = event.currentTarget.value;
                onH3LoraPreferenceChange({ loraName, loraStrength: h3LoraStrength });
                onChange(id, {
                  content: {
                    ...record.content,
                    generationLoraName: loraName,
                    status: "idle",
                    validationMessage: "",
                  },
                });
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {selectableH3Loras.map((lora) => (
                <option key={lora} value={lora}>{h3LoraDisplayName(lora)}</option>
              ))}
            </select>
            <input
              className="video-parameter-range"
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={h3LoraStrength}
              title={`LoRA 权重：${h3LoraStrength.toFixed(2)}`}
              aria-label="LoRA 权重"
              onChange={(event) => {
                const loraStrength = Number(event.currentTarget.value);
                onH3LoraPreferenceChange({ loraName: h3LoraName, loraStrength });
                onChange(id, {
                  content: {
                    ...record.content,
                    generationLoraStrength: loraStrength,
                    status: "idle",
                    validationMessage: "",
                  },
                });
              }}
              onPointerDown={(event) => event.stopPropagation()}
            />
            <output title="LoRA 权重">×{h3LoraStrength.toFixed(2)}</output>
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
          <section className="video-input-group is-text video-text-input-group">
            <div className="video-input-group-heading">
              <FileText size={13} />
              <strong>文本</strong>
              <span>{textInputs.length}</span>
            </div>
            <ol className="video-input-list" aria-label="文本输入">
              {textInputs.length ? (
                textInputs.map((input, index) => {
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
                })
              ) : (
                <li className="video-input-item is-empty">
                  <span className="video-input-index">—</span>
                  <span className="video-input-preview is-text">
                    <FileText size={16} />
                  </span>
                  <span className="video-input-copy">
                    <strong>无</strong>
                    <span className="video-text-input-preview">未连接提示词</span>
                  </span>
                </li>
              )}
            </ol>
          </section>
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
                      {group.kind === "image" && (
                        <li className="video-image-clear-slot nodrag">
                          <button
                            type="button"
                            className="video-image-clear-button"
                            disabled={clearingImages}
                            title="清空当前视频节点的全部参考图片"
                            aria-label={`清空全部 ${group.inputs.length} 张参考图片`}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => setImageIdsPendingClear(group.inputs.map((input) => input.id))}
                          >
                            <Trash2 size={15} aria-hidden="true" />
                            <span>{clearingImages ? "清除中" : "清空"}</span>
                          </button>
                        </li>
                      )}
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
            <div className="video-execution-actions">
              <button
                type="button"
                className="video-execute-button"
                disabled={executionCancelling || (seedMode === "fixed" && executionRunning)}
                title={seedMode === "fixed" && executionRunning
                  ? "固定种子已有任务正在执行，不能重复排队"
                  : "提交一个新的生成任务"}
                aria-label={seedMode === "fixed" && executionRunning
                  ? "固定种子已有任务正在执行，不能重复排队"
                  : "开始执行"}
                onClick={() => void checkAndExecute()}
              >
                <Play size={15} fill="currentColor" />
              </button>
              {executionRunning && (
                <button
                  type="button"
                  className="video-cancel-button"
                  disabled={executionCancelling}
                  onClick={() => void onCancelExecution(id)}
                  title={`取消最早提交的任务；当前共有 ${activeTaskCount} 个任务`}
                  aria-label={`取消最早提交的任务；当前共有 ${activeTaskCount} 个任务`}
                >
                  <X size={13} />
                  {activeTaskCount}
                </button>
              )}
            </div>
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
            ? isGenerationPlaceholder
              ? placeholderActive ? "正在生成" : "生成未完成"
              : formattedGenerationElapsed(record.content)
            : record.source === "manual"
              ? "手动创建"
              : record.source}
        </span>
        {isGeneratedVideo && !isGenerationPlaceholder && generatedVideoPrompt && (
          <button
            type="button"
            className="nodrag generated-video-prompt-copy"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              copyGeneratedPrompt();
            }}
            title={promptCopied ? "提示词已复制" : "复制生成提示词"}
            aria-label={promptCopied ? "提示词已复制" : "复制生成提示词"}
          >
            {promptCopied ? <Check size={12} /> : <PenLine size={12} />}
          </button>
        )}
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
                ? isGenerationPlaceholder
                  ? isSecondaryPreview ? "二采预览占位" : "视频预览占位"
                  : originalName
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
                <span>{textDraft.length.toLocaleString()} 字符 · 自动保存</span>
              </div>
              <button onClick={() => setExpanded(false)} title="关闭" aria-label="关闭放大编辑器">
                <X size={17} />
              </button>
            </header>
            <textarea
              className="expanded-text-editor"
              value={textDraft}
              onChange={changeText}
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
                <span>{connectedTextEditor.text.length.toLocaleString()} 字符 · 自动保存</span>
              </div>
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
                const nextContent = { ...connectedTextEditor.content, text: nextText };
                setConnectedTextEditor((current) => (
                  current ? { ...current, content: nextContent, text: nextText } : current
                ));
                onChange(connectedTextEditor.id, { content: nextContent });
              }}
              autoFocus
              spellCheck={false}
              aria-label="放大提示词内容"
            />
          </section>
        </div>,
        document.body,
      )}
      {imageIdsPendingClear && createPortal(
        <div
          className="project-dialog-backdrop"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={() => {
            if (!clearingImages) setImageIdsPendingClear(null);
          }}
        >
          <div
            className="project-dialog project-delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`clear-images-title-${id}`}
            aria-describedby={`clear-images-description-${id}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="project-dialog-icon"><Trash2 size={22} /></div>
            <div>
              <h2 id={`clear-images-title-${id}`}>确认清空图片素材？</h2>
              <p id={`clear-images-description-${id}`}>
                将从当前视频生成节点断开全部 {imageIdsPendingClear.length} 张参考图片。原始图片素材节点不会被删除，文字、音频和视频连接不受影响。
              </p>
            </div>
            <div className="project-dialog-actions">
              <button
                type="button"
                className="dialog-cancel"
                autoFocus
                disabled={clearingImages}
                onClick={() => setImageIdsPendingClear(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="dialog-danger"
                disabled={clearingImages}
                onClick={() => void clearConnectedImages()}
              >
                <Trash2 size={14} />
                {clearingImages ? "正在清空…" : "确认清空"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </article>
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
  const [canvasName, setCanvasName] = useState("SuCanvas");
  const [editingProjectName, setEditingProjectName] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [projects, setProjects] = useState<WorkspaceSnapshot[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [canvasBackground, setCanvasBackground] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeSettingsSection, setActiveSettingsSection] = useState<"general" | "privacy" | "security">("general");
  const [showPrivateProjects, setShowPrivateProjects] = useState(() =>
    window.localStorage.getItem(PRIVATE_PROJECT_VISIBILITY_STORAGE_KEY) !== "false",
  );
  const [privateProjectSearch, setPrivateProjectSearch] = useState("");
  const [privateProjectBusyId, setPrivateProjectBusyId] = useState<string | null>(null);
  const [appLockEnabled, setAppLockEnabled] = useState(false);
  const [appLockStatusReady, setAppLockStatusReady] = useState(false);
  const [appLockCurrentPassword, setAppLockCurrentPassword] = useState("");
  const [appLockNewPassword, setAppLockNewPassword] = useState("");
  const [appLockConfirmPassword, setAppLockConfirmPassword] = useState("");
  const [appLockPasswordVisible, setAppLockPasswordVisible] = useState(false);
  const [appLockBusy, setAppLockBusy] = useState(false);
  const [appLockMessage, setAppLockMessage] = useState("");
  const [appLockMessageKind, setAppLockMessageKind] = useState<"success" | "error">("success");
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
  const [h3WorkflowPath, setH3WorkflowPath] = useState(() =>
    window.localStorage.getItem(H3_REFERENCE_WORKFLOW_STORAGE_KEY)
      ?? DEFAULT_H3_REFERENCE_WORKFLOW_PATH,
  );
  const [h3WorkflowPathDraft, setH3WorkflowPathDraft] = useState(() =>
    window.localStorage.getItem(H3_REFERENCE_WORKFLOW_STORAGE_KEY)
      ?? DEFAULT_H3_REFERENCE_WORKFLOW_PATH,
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
  const [relationAnchorId, setRelationAnchorId] = useState<string | null>(null);
  const [spacePanActive, setSpacePanActive] = useState(false);
  const [notice, setNotice] = useState("正在打开画布…");
  const [comfyQueueCounts, setComfyQueueCounts] = useState<ComfyQueueSummary>({
    runningCount: 0,
    pendingCount: 0,
    totalCount: 0,
  });
  const [h3LoraOptions, setH3LoraOptions] = useState<string[]>([DEFAULT_H3_LORA_NAME]);
  const [h3LoraPreference, setH3LoraPreference] = useState(h3LoraPreferenceFromStorage);
  const [activeComfyTaskCounts, setActiveComfyTaskCounts] = useState<Record<string, number>>({});
  const [copiedApi, setCopiedApi] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [canvasContextMenu, setCanvasContextMenu] = useState<CanvasContextMenuState | null>(null);
  const [videoDeletionRequest, setVideoDeletionRequest] = useState<VideoDeletionRequest | null>(null);
  const saveTimers = useRef(new Map<string, number>());
  const pendingPatches = useRef(new Map<string, NodePatch>());
  const nodesSnapshot = useRef<CanvasFlowNode[]>([]);
  const edgesSnapshot = useRef<Edge[]>([]);
  const incomingPlacementReservations = useRef<NodeRecord[]>([]);
  const runningComfyClients = useRef(new Map<string, Set<string>>());
  const cancelledComfyClients = useRef(new Set<string>());
  const ownedComfyClients = useRef(new Set<string>());
  const recoveringComfyClients = useRef(new Set<string>());
  const missingRecoveredTaskPolls = useRef(new Map<string, number>());
  const recoveredComfySockets = useRef(new Map<string, WebSocket>());
  const connectingRecoveredComfyClients = useRef(new Set<string>());
  const recoveredNodeActiveKeys = useRef(new Map<string, string>());
  const completedGenerationPlaceholders = useRef(new Set<string>());
  const persistedComfyTasks = useRef<PersistedComfyTask[]>(persistedComfyTasksFromStorage());
  const comfyOutputRootRef = useRef(comfyOutputRoot);
  const comfyInputRootRef = useRef(comfyInputRoot);
  const h3WorkflowPathRef = useRef(h3WorkflowPath);
  const makeFlowNodeRef = useRef<((record: NodeRecord, matched?: boolean) => CanvasFlowNode) | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  const projectNameInputRef = useRef<HTMLInputElement>(null);
  const deleteUndoStack = useRef<DeletedBatch[]>([]);
  const nodeDeletionInProgress = useRef(false);
  const nodeClipboard = useRef<NodeClipboard | null>(null);
  const { setCenter, fitView, screenToFlowPosition } = useReactFlow<CanvasFlowNode, Edge>();

  const savePersistedComfyTasks = useCallback((tasks: PersistedComfyTask[]) => {
    persistedComfyTasks.current = tasks;
    window.localStorage.setItem(COMFY_TASK_STORAGE_KEY, JSON.stringify(tasks));
  }, []);

  const rememberComfyTask = useCallback((task: PersistedComfyTask) => {
    savePersistedComfyTasks([
      ...persistedComfyTasks.current.filter((candidate) => candidate.clientId !== task.clientId),
      task,
    ]);
  }, [savePersistedComfyTasks]);

  const forgetComfyTask = useCallback((clientId: string) => {
    savePersistedComfyTasks(
      persistedComfyTasks.current.filter((task) => task.clientId !== clientId),
    );
  }, [savePersistedComfyTasks]);

  const registerComfyTask = useCallback((nodeId: string, clientId: string) => {
    const clients = runningComfyClients.current.get(nodeId) ?? new Set<string>();
    clients.add(clientId);
    runningComfyClients.current.set(nodeId, clients);
    setActiveComfyTaskCounts((current) => ({ ...current, [nodeId]: clients.size }));
  }, []);

  const unregisterComfyTask = useCallback((nodeId: string, clientId: string) => {
    const clients = runningComfyClients.current.get(nodeId);
    if (!clients) return;
    clients.delete(clientId);
    if (clients.size) {
      setActiveComfyTaskCounts((current) => ({ ...current, [nodeId]: clients.size }));
      return;
    }
    runningComfyClients.current.delete(nodeId);
    setActiveComfyTaskCounts((current) => {
      const next = { ...current };
      delete next[nodeId];
      return next;
    });
  }, []);

  useEffect(() => {
    nodesSnapshot.current = nodes;
    edgesSnapshot.current = edges;
  }, [edges, nodes]);

  useEffect(() => {
    const pauseOtherVideos = (event: Event) => {
      const playingVideo = event.target;
      if (!(playingVideo instanceof HTMLVideoElement)) return;
      document.querySelectorAll("video").forEach((video) => {
        if (video !== playingVideo && !video.paused) video.pause();
      });
    };
    document.addEventListener("play", pauseOtherVideos, true);
    return () => document.removeEventListener("play", pauseOtherVideos, true);
  }, []);

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => (
      target instanceof HTMLElement
      && (target.isContentEditable || target.matches("input, textarea, select"))
    );
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || isEditableTarget(event.target)) return;
      event.preventDefault();
      setSpacePanActive(true);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpacePanActive(false);
    };
    const stopSpacePan = () => setSpacePanActive(false);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", stopSpacePan);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", stopSpacePan);
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem("infinite-canvas:project-columns", String(projectColumns));
  }, [projectColumns]);

  useEffect(() => {
    window.localStorage.setItem(
      PRIVATE_PROJECT_VISIBILITY_STORAGE_KEY,
      String(showPrivateProjects),
    );
  }, [showPrivateProjects]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("infinite-canvas:theme", theme);
  }, [theme]);

  useEffect(() => {
    let disposed = false;
    void invoke<AppLockStatus>("get_app_lock_status")
      .then((status) => {
        if (!disposed) setAppLockEnabled(status.enabled);
      })
      .catch((error) => {
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        setAppLockMessageKind("error");
        setAppLockMessage(`无法读取应用锁状态：${message}`);
      })
      .finally(() => {
        if (!disposed) setAppLockStatusReady(true);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      H3_LORA_PREFERENCE_STORAGE_KEY,
      JSON.stringify(h3LoraPreference),
    );
  }, [h3LoraPreference]);

  useEffect(() => {
    comfyOutputRootRef.current = comfyOutputRoot;
  }, [comfyOutputRoot]);

  useEffect(() => {
    comfyInputRootRef.current = comfyInputRoot;
  }, [comfyInputRoot]);

  useEffect(() => {
    h3WorkflowPathRef.current = h3WorkflowPath;
  }, [h3WorkflowPath]);

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const summary = await invoke<ComfyQueueSummary>("get_comfyui_queue_summary", {
          serverUrl: COMFYUI_SERVER_URL,
        });
        if (!disposed) setComfyQueueCounts(summary);
      } catch {
        // Global queue visibility is supplemental and must not interrupt editing or generation.
      }
      if (!disposed) timer = window.setTimeout(() => void poll(), 1200);
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    void invoke<string[]>("get_comfyui_h3_loras", { serverUrl: COMFYUI_SERVER_URL })
      .then((loras) => {
        if (!disposed && loras.length) setH3LoraOptions(loras);
      })
      .catch(() => {
        // Keep the workflow's default H3 LoRA available while ComfyUI is offline.
      });
    return () => {
      disposed = true;
    };
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

  const rememberH3LoraPreference = useCallback((preference: H3LoraPreference) => {
    const content: JsonObject = {
      loraName: preference.loraName,
      loraStrength: preference.loraStrength,
    };
    setH3LoraPreference({
      loraName: h3LoraNameFromContent(content),
      loraStrength: h3LoraStrengthFromContent(content),
    });
  }, []);

  useEffect(() => {
    if (!activeProjectId) return;
    const persistedNodeIds = new Set(
      persistedComfyTasks.current
        .filter((task) => task.canvasId === activeProjectId)
        .flatMap((task) => [task.nodeId, task.placeholderNodeId].filter(
          (nodeId): nodeId is string => Boolean(nodeId),
        )),
    );
    nodes.forEach((node) => {
      const status = node.data.record.content.status;
      if (status !== "running" && status !== "cancelling") return;
      if (persistedNodeIds.has(node.id) || runningComfyClients.current.has(node.id)) return;
      const isPlaceholder = node.data.record.content.generationPlaceholder === true;
      changeNode(node.id, {
        content: {
          ...node.data.record.content,
          status: isPlaceholder ? "invalid" : "idle",
          executionProgress: null,
          validationMessage: isPlaceholder ? "生成任务已中断或未记录" : "",
        },
      });
    });
  }, [activeProjectId, changeNode, nodes]);

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

  const videoFilePathsForRecords = useCallback((records: NodeRecord[]) => {
    const paths = records.flatMap((record) => {
      if (record.kind === "video") {
        const assetPath = typeof record.content.assetPath === "string"
          ? record.content.assetPath.trim()
          : "";
        return assetPath ? [assetPath] : [];
      }
      if (record.kind === "generated-video") {
        const mappedPath = mappedComfyOutputPath(comfyOutputRootRef.current, record.content);
        return mappedPath ? [mappedPath] : [];
      }
      return [];
    });
    return [...new Set(paths)];
  }, []);

  const requestVideoDeletionChoice = useCallback((records: NodeRecord[]) => {
    const videoRecords = records.filter(
      (record) => record.content.generationPlaceholder !== true
        && (record.kind === "video" || record.kind === "generated-video"),
    );
    if (!videoRecords.length) return Promise.resolve<VideoDeletionChoice>("node-only");
    const filePaths = videoFilePathsForRecords(videoRecords);
    return new Promise<VideoDeletionChoice>((resolve) => {
      setVideoDeletionRequest({
        videoCount: videoRecords.length,
        filePaths,
        resolve,
      });
    });
  }, [videoFilePathsForRecords]);

  const finishVideoDeletionChoice = useCallback((choice: VideoDeletionChoice) => {
    const request = videoDeletionRequest;
    if (!request) return;
    setVideoDeletionRequest(null);
    request.resolve(choice);
  }, [videoDeletionRequest]);

  const cancelTasksForDeletedPlaceholders = useCallback(async (records: NodeRecord[]) => {
    const tasks = records
      .filter((record) => record.content.generationPlaceholder === true)
      .map((record) => {
        const clientId = typeof record.content.placeholderClientId === "string"
          ? record.content.placeholderClientId
          : "";
        return persistedComfyTasks.current.find((task) => task.clientId === clientId) ?? null;
      })
      .filter((task): task is PersistedComfyTask => Boolean(task));
    const uniqueTasks = [...new Map(tasks.map((task) => [task.clientId, task])).values()];

    for (const task of uniqueTasks) {
      cancelledComfyClients.current.add(task.clientId);
      try {
        await invoke<string | null>("cancel_comfyui_workflow", {
          serverUrl: COMFYUI_SERVER_URL,
          clientId: task.clientId,
        });
      } catch (error) {
        cancelledComfyClients.current.delete(task.clientId);
        throw error;
      }

      const remainingTaskCount = [...(runningComfyClients.current.get(task.nodeId) ?? [])]
        .filter((clientId) => clientId !== task.clientId)
        .length;
      const sourceNode = nodesSnapshot.current.find((node) => node.id === task.nodeId)?.data.record;
      if (sourceNode) {
        changeNode(task.nodeId, {
          content: {
            ...sourceNode.content,
            status: remainingTaskCount ? "running" : "cancelled",
            executionProgress: null,
            validationMessage: remainingTaskCount
              ? `已通过删除占位取消任务，仍有 ${remainingTaskCount} 个任务`
              : `已通过删除占位取消 ComfyUI ${isSecondaryComfyTask(task) ? "二采" : "生成"}`,
          },
        });
      }
      if (task.placeholderNodeId) {
        const placeholderNode = nodesSnapshot.current.find(
          (node) => node.id === task.placeholderNodeId,
        )?.data.record;
        if (placeholderNode?.content.generationPlaceholder === true) {
          changeNode(task.placeholderNodeId, {
            content: {
              ...placeholderNode.content,
              status: "cancelled",
              executionProgress: null,
              validationMessage: "已通过删除占位取消任务",
            },
          });
        }
        completedGenerationPlaceholders.current.add(task.placeholderNodeId);
      }
      if (!ownedComfyClients.current.has(task.clientId)) {
        forgetComfyTask(task.clientId);
        unregisterComfyTask(task.nodeId, task.clientId);
        cancelledComfyClients.current.delete(task.clientId);
      }
    }
    return uniqueTasks.length;
  }, [changeNode, forgetComfyTask, unregisterComfyTask]);

  const deleteCanvasNodes = useCallback(
    async (nodesToDelete: CanvasFlowNode[]) => {
      if (!nodesToDelete.length || nodeDeletionInProgress.current) return;
      nodeDeletionInProgress.current = true;
      const records = nodesToDelete.map((node) => node.data.record);
      try {
        const choice = await requestVideoDeletionChoice(records);
        if (choice === "cancel") return;

        const cancelledPlaceholderTaskCount = await cancelTasksForDeletedPlaceholders(records);

        const ids = records.map((record) => record.id);
        await flushNodePatches(ids);
        const batch = await invoke<DeletedBatch>("delete_nodes_undoable", {
          input: { ids },
        });

        if (choice === "node-and-file") {
          const filePaths = videoFilePathsForRecords(records);
          try {
            await invoke<number>("delete_video_files", { paths: filePaths });
          } catch (error) {
            await invoke<DeletedBatch>("restore_deleted_nodes", { batch });
            throw error;
          }
        } else if (!cancelledPlaceholderTaskCount) {
          rememberDeletedBatch(batch);
        }

        const deletedIds = new Set(ids);
        setNodes((current) => current.filter((node) => !deletedIds.has(node.id)));
        setEdges((current) => current.filter(
          (edge) => !deletedIds.has(edge.source) && !deletedIds.has(edge.target),
        ));
        setNotice(choice === "node-and-file"
          ? `${ids.length} 个节点及其视频文件已永久删除`
          : cancelledPlaceholderTaskCount
            ? `已取消 ${cancelledPlaceholderTaskCount} 个任务并删除对应占位节点`
            : `${ids.length} 个节点已删除，按 Ctrl+Z 撤销`);
      } catch (error) {
        reportError(error);
      } finally {
        nodeDeletionInProgress.current = false;
      }
    },
    [
      flushNodePatches,
      cancelTasksForDeletedPlaceholders,
      rememberDeletedBatch,
      reportError,
      requestVideoDeletionChoice,
      setEdges,
      setNodes,
      videoFilePathsForRecords,
    ],
  );

  const deleteNode = useCallback(
    async (id: string) => {
      const node = nodesSnapshot.current.find((candidate) => candidate.id === id);
      if (node) await deleteCanvasNodes([node]);
    },
    [deleteCanvasNodes],
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

  const saveComfySettings = useCallback(() => {
    const normalizePath = (path: string) => path
      .trim()
      .replace(/^"|"$/g, "")
      .replace(/[\\/]+$/, "");
    const outputRoot = normalizePath(comfyOutputRootDraft);
    const inputRoot = normalizePath(comfyInputRootDraft);
    const workflowPath = normalizePath(h3WorkflowPathDraft)
      || DEFAULT_H3_REFERENCE_WORKFLOW_PATH;
    comfyOutputRootRef.current = outputRoot;
    comfyInputRootRef.current = inputRoot;
    h3WorkflowPathRef.current = workflowPath;
    setComfyOutputRoot(outputRoot);
    setComfyInputRoot(inputRoot);
    setH3WorkflowPath(workflowPath);
    if (outputRoot) window.localStorage.setItem("infinite-canvas:comfy-output-root", outputRoot);
    else window.localStorage.removeItem("infinite-canvas:comfy-output-root");
    if (inputRoot) window.localStorage.setItem("infinite-canvas:comfy-input-root", inputRoot);
    else window.localStorage.removeItem("infinite-canvas:comfy-input-root");
    window.localStorage.setItem(H3_REFERENCE_WORKFLOW_STORAGE_KEY, workflowPath);
    setSettingsOpen(false);
    setNotice("ComfyUI 设置已保存");
  }, [comfyInputRootDraft, comfyOutputRootDraft, h3WorkflowPathDraft]);

  const clearAppLockPasswordFields = useCallback(() => {
    setAppLockCurrentPassword("");
    setAppLockNewPassword("");
    setAppLockConfirmPassword("");
    setAppLockPasswordVisible(false);
  }, []);

  const saveAppLockPassword = useCallback(async () => {
    if (appLockNewPassword.length < 4) {
      setAppLockMessageKind("error");
      setAppLockMessage("新密码至少需要 4 个字符");
      return;
    }
    if (appLockNewPassword !== appLockConfirmPassword) {
      setAppLockMessageKind("error");
      setAppLockMessage("两次输入的新密码不一致");
      return;
    }
    setAppLockBusy(true);
    setAppLockMessage("");
    try {
      await invoke("set_app_lock_password", {
        input: {
          currentPassword: appLockEnabled ? appLockCurrentPassword : null,
          newPassword: appLockNewPassword,
        },
      });
      setAppLockEnabled(true);
      clearAppLockPasswordFields();
      setAppLockMessageKind("success");
      setAppLockMessage(appLockEnabled ? "应用锁密码已修改" : "应用锁已启用，下次启动时需要输入密码");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAppLockMessageKind("error");
      setAppLockMessage(message);
    } finally {
      setAppLockBusy(false);
    }
  }, [appLockConfirmPassword, appLockCurrentPassword, appLockEnabled, appLockNewPassword, clearAppLockPasswordFields]);

  const turnOffAppLock = useCallback(async () => {
    setAppLockBusy(true);
    setAppLockMessage("");
    try {
      await invoke("disable_app_lock", { password: appLockCurrentPassword });
      setAppLockEnabled(false);
      clearAppLockPasswordFields();
      setAppLockMessageKind("success");
      setAppLockMessage("应用锁已关闭");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAppLockMessageKind("error");
      setAppLockMessage(message);
    } finally {
      setAppLockBusy(false);
    }
  }, [appLockCurrentPassword, clearAppLockPasswordFields]);

  const changeProjectPrivacy = useCallback(async (projectId: string, isPrivate: boolean) => {
    if (privateProjectBusyId) return;
    setPrivateProjectBusyId(projectId);
    try {
      const updated = await invoke<CanvasRecord>("set_project_private", {
        input: { id: projectId, isPrivate },
      });
      setProjects((current) => current.map((project) =>
        project.canvas.id === updated.id
          ? { ...project, canvas: updated }
          : project,
      ));
      setNotice(isPrivate ? `项目“${updated.name}”已设为私密` : `项目“${updated.name}”已取消私密`);
    } catch (error) {
      reportError(error);
    } finally {
      setPrivateProjectBusyId(null);
    }
  }, [privateProjectBusyId, reportError]);

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
      promptNodeId: textInputs.length === 1 ? textInputs[0].id : "",
      promptNodeIdSource: textInputs.length === 1 ? "captured" : "",
      durationSeconds: videoDurationFromContent(generator.content),
      aspectRatio: videoAspectRatioFromContent(generator.content),
      primaryResolutionMegapixels: primaryVideoResolutionFromContent(generator.content),
      secondaryResolutionMegapixels: secondaryVideoResolutionFromContent(generator.content),
      loraName: h3LoraNameFromContent(generator.content),
      loraStrength: h3LoraStrengthFromContent(generator.content),
      imagePaths: assetPaths("image"),
      audioPaths: assetPaths("audio"),
      videoPaths: assetPaths("video"),
    };
  }, []);

  const generatedPreviewHeightForAspectRatio = useCallback((aspectRatio: VideoAspectRatio) => {
    return mediaNodeHeightForAspectRatio(
      GENERATED_VIDEO_PREVIEW_WIDTH,
      videoAspectRatioValue(aspectRatio),
    );
  }, []);

  const createGenerationPlaceholder = useCallback(async ({
    source,
    clientId,
    snapshot,
    secondary,
    sourceGeneratorId,
  }: {
    source: NodeRecord;
    clientId: string;
    snapshot: GenerationSnapshot;
    secondary: boolean;
    sourceGeneratorId: string;
  }) => {
    const previewWidth = GENERATED_VIDEO_PREVIEW_WIDTH;
    const previewHeight = generatedPreviewHeightForAspectRatio(snapshot.aspectRatio);
    const position = generatedPreviewPosition(
      source,
      [
        ...nodesSnapshot.current.map(recordAtCurrentFlowPosition),
        ...incomingPlacementReservations.current,
      ],
      previewWidth,
      previewHeight,
    );
    const reservationId = `generation-placeholder:${clientId}`;
    const placeholderContent: JsonObject = {
      generationPlaceholder: true,
      placeholderClientId: clientId,
      status: "running",
      executionProgress: null,
      validationMessage: secondary
        ? `正在准备二次采样（${snapshot.secondaryResolutionMegapixels.toFixed(1)} MP）…`
        : "正在上传素材并提交到远程 ComfyUI…",
      sourceGeneratorId,
      ...(secondary ? { sourcePreviewId: source.id } : {}),
      generationSnapshot: snapshot,
    };
    const reservation: NodeRecord = {
      ...source,
      id: reservationId,
      kind: "generated-video",
      title: secondary ? "二采预览（生成中）" : "视频预览（生成中）",
      content: placeholderContent,
      source: "comfyui-placeholder",
      requestId: reservationId,
      x: position.x,
      y: position.y,
      width: previewWidth,
      height: previewHeight,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    incomingPlacementReservations.current.push(reservation);
    let createdNodeId = "";
    try {
      const result = await invoke<CreateNodeResult>("create_node", {
        input: {
          canvasId: source.canvasId,
          kind: "generated-video",
          title: reservation.title,
          content: placeholderContent,
          source: reservation.source,
          requestId: reservation.requestId,
          x: position.x,
          y: position.y,
          width: previewWidth,
          height: previewHeight,
        },
      });
      createdNodeId = result.node.id;
      completedGenerationPlaceholders.current.delete(result.node.id);
      incomingPlacementReservations.current = incomingPlacementReservations.current
        .map((candidate) => candidate.id === reservationId ? result.node : candidate);
      const edgeRecord = await invoke<EdgeRecord>("create_edge", {
        input: {
          canvasId: source.canvasId,
          sourceNodeId: source.id,
          targetNodeId: result.node.id,
          kind: secondary ? "secondary-output" : "output",
          metadata: {
            placeholder: true,
            clientId,
            ...(secondary ? {
              secondaryResolutionMegapixels: snapshot.secondaryResolutionMegapixels,
            } : {}),
          },
        },
      });
      const flowNode = makeFlowNodeRef.current?.(result.node);
      if (flowNode) setNodes((current) => appendUniqueById(current, [flowNode]));
      setEdges((current) => appendUniqueById(current, [toFlowEdge(edgeRecord)]));
      return result.node;
    } catch (error) {
      if (createdNodeId) {
        try {
          await invoke<DeletedBatch>("delete_nodes_undoable", {
            input: { ids: [createdNodeId] },
          });
        } catch {
          // Preserve the original placeholder creation error.
        }
      }
      throw error;
    } finally {
      window.setTimeout(() => {
        incomingPlacementReservations.current = incomingPlacementReservations.current
          .filter((candidate) => candidate.id !== reservationId && candidate.id !== createdNodeId);
      }, 0);
    }
  }, [generatedPreviewHeightForAspectRatio, setEdges, setNodes]);

  const updateGenerationPlaceholder = useCallback((
    placeholderNodeId: string | undefined,
    patch: JsonObject,
  ) => {
    if (!placeholderNodeId || completedGenerationPlaceholders.current.has(placeholderNodeId)) return;
    const placeholder = nodesSnapshot.current.find(
      (node) => node.id === placeholderNodeId,
    )?.data.record;
    if (!placeholder || placeholder.content.generationPlaceholder !== true) return;
    changeNode(placeholderNodeId, {
      content: {
        ...placeholder.content,
        ...patch,
      },
    });
  }, [changeNode]);

  const completeGenerationPlaceholder = useCallback(async (
    placeholderNodeId: string | undefined,
    title: string,
    content: JsonObject,
  ): Promise<NodeRecord | null> => {
    if (!placeholderNodeId || !nodesSnapshot.current.some(
      (node) => node.id === placeholderNodeId,
    )) return null;
    completedGenerationPlaceholders.current.add(placeholderNodeId);
    try {
      await flushNodePatches([placeholderNodeId]);
      const record = await invoke<NodeRecord>("update_node", {
        input: {
          id: placeholderNodeId,
          title,
          content,
        },
      });
      setNodes((current) => current.map((node) => node.id === placeholderNodeId
        ? { ...node, data: { ...node.data, record } }
        : node));
      return record;
    } catch (error) {
      completedGenerationPlaceholders.current.delete(placeholderNodeId);
      throw error;
    }
  }, [flushNodePatches, setNodes]);

  const executeVideoNode = useCallback(async (targetId: string) => {
    const targetNode = nodesSnapshot.current.find((node) => node.id === targetId);
    if (!targetNode) {
      setNotice("无法执行：找不到视频生成节点");
      return;
    }
    const target = recordAtCurrentFlowPosition(targetNode);
    const requestedSeedMode = seedModeFromContent(target.content);
    const requestedFixedSeed = fixedSeedFromContent(target.content);
    const activeClients = runningComfyClients.current.get(targetId);
    if (target.content.status === "cancelling") {
      setNotice("当前任务正在取消，请稍后再提交");
      return;
    }
    if (
      requestedSeedMode === "fixed"
      && (generatedSeedsFromContent(target.content).includes(requestedFixedSeed)
        || Boolean(activeClients?.size))
    ) {
      const message = activeClients?.size
        ? `固定种子 ${requestedFixedSeed} 已有任务正在执行，不能重复排队`
        : `固定种子 ${requestedFixedSeed} 已经生成过，无需重复生成`;
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
    const taskSubmittedAt = Date.now();
    let placeholder: NodeRecord;
    try {
      placeholder = await createGenerationPlaceholder({
        source: target,
        clientId,
        snapshot,
        secondary: false,
        sourceGeneratorId: targetId,
      });
    } catch (error) {
      reportError(error);
      return;
    }
    ownedComfyClients.current.add(clientId);
    rememberComfyTask({
      clientId,
      nodeId: targetId,
      canvasId: target.canvasId,
      snapshot,
      startedAt: taskSubmittedAt,
      kind: "generation",
      placeholderNodeId: placeholder.id,
    });
    cancelledComfyClients.current.delete(clientId);
    registerComfyTask(targetId, clientId);
    const queuedTaskCount = runningComfyClients.current.get(targetId)?.size ?? 1;
    changeNode(targetId, {
      content: {
        ...target.content,
        status: "running",
        executionProgress: null,
        validationMessage: queuedTaskCount > 1
          ? `已提交第 ${queuedTaskCount} 个任务，正在等待 ComfyUI 执行…`
          : "正在上传素材并提交到远程 ComfyUI…",
      },
    });
    setNotice(queuedTaskCount > 1
      ? `已为当前节点排队 ${queuedTaskCount} 个生成任务`
      : "正在上传素材并提交到远程 ComfyUI…");

    let progressSocket: WebSocket | null = null;
    try {
      progressSocket = await openComfyProgressSocket(clientId);
      if (cancelledComfyClients.current.has(clientId)) {
        throw new Error("ComfyUI 生成已取消");
      }
      progressSocket?.addEventListener("message", (event) => {
        if (cancelledComfyClients.current.has(clientId)) return;
        const update = comfyProgressFromSocketData(event.data);
        if (!update) return;
        const latest = nodesSnapshot.current.find((node) => node.id === targetId)?.data.record ?? target;
        changeNode(targetId, {
          content: {
            ...latest.content,
            status: "running",
            executionProgress: update.progress,
            validationMessage: `ComfyUI 正在生成：当前步骤 ${update.value}/${update.maximum}`,
          },
        });
        updateGenerationPlaceholder(placeholder.id, {
          status: "running",
          executionProgress: update.progress,
          validationMessage: `ComfyUI 正在生成：当前步骤 ${update.value}/${update.maximum}`,
        });
      });
      const result = await invoke<ComfySubmitResult>("submit_comfyui_workflow", {
        input: {
          serverUrl: COMFYUI_SERVER_URL,
          workflowPath: h3WorkflowPathRef.current,
          inputRootPath: comfyInputRootRef.current,
          clientId,
          prompt: snapshot.prompt,
          seedMode: seedModeFromContent(target.content),
          seed: fixedSeedFromContent(target.content),
          durationSeconds: snapshot.durationSeconds,
          aspectRatio: snapshot.aspectRatio,
          primaryResolutionMegapixels: snapshot.primaryResolutionMegapixels,
          secondaryResolutionMegapixels: snapshot.secondaryResolutionMegapixels,
          secondarySamplingEnabled: false,
          loraName: snapshot.loraName,
          loraStrength: snapshot.loraStrength,
          imagePaths: snapshot.imagePaths,
          audioPaths: snapshot.audioPaths,
          videoPaths: snapshot.videoPaths,
          secondarySource: null,
        },
      });
      if (!result.outputs.length) throw new Error("ComfyUI 没有返回视频输出");
      if (cancelledComfyClients.current.has(clientId)) return;
      const generationElapsedSeconds = validExecutionElapsedSeconds(result.executionElapsedSeconds);

      const previewWidth = GENERATED_VIDEO_PREVIEW_WIDTH;
      const previewHeight = generatedPreviewHeightForAspectRatio(snapshot.aspectRatio);
      const placementRecords = [
        ...nodesSnapshot.current.map(recordAtCurrentFlowPosition),
        ...incomingPlacementReservations.current,
      ];
      const createdNodes: CanvasFlowNode[] = [];
      const createdEdges: Edge[] = [];
      const reservationIds = new Set<string>();
      try {
        for (const [index, output] of result.outputs.entries()) {
          const title = result.outputs.length > 1
            ? `视频预览 ${index + 1}`
            : "视频预览";
          const outputContent: JsonObject = {
            videoUrl: output.url,
            originalName: output.filename,
            filename: output.filename,
            subfolder: output.subfolder,
            fileType: output.fileType,
            seed: result.seed,
            comfyPromptId: result.promptId,
            comfyServerUrl: COMFYUI_SERVER_URL,
            sourceGeneratorId: targetId,
            outputIndex: index,
            aspectRatio: videoAspectRatioValue(snapshot.aspectRatio),
            generationSnapshot: snapshot,
            hasBeenPlayed: false,
            ...(generationElapsedSeconds === null ? {} : { generationElapsedSeconds }),
          };
          if (index === 0) {
            const completedPlaceholder = await completeGenerationPlaceholder(
              placeholder.id,
              title,
              outputContent,
            );
            if (completedPlaceholder) {
              placementRecords.push(completedPlaceholder);
              continue;
            }
          }
          const position = generatedPreviewPosition(
            target,
            placementRecords,
            previewWidth,
            previewHeight,
          );
          const reservationId = `generated-preview:${clientId}:${index}`;
          const reservedRecord: NodeRecord = {
            ...target,
            id: reservationId,
            kind: "generated-video",
            content: { sourceGeneratorId: targetId },
            x: position.x,
            y: position.y,
            width: previewWidth,
            height: previewHeight,
            createdAt: new Date().toISOString(),
          };
          reservationIds.add(reservationId);
          incomingPlacementReservations.current.push(reservedRecord);
          const previewResult = await invoke<CreateNodeResult>("create_node", {
            input: {
              canvasId: target.canvasId,
              kind: "generated-video",
              title,
              content: outputContent,
              source: "comfyui",
              requestId: comfyPreviewRequestId(target.canvasId, targetId, result.promptId, index),
              x: position.x,
              y: position.y,
              width: previewWidth,
              height: previewHeight,
            },
          });
          incomingPlacementReservations.current = incomingPlacementReservations.current
            .map((candidate) => candidate.id === reservationId ? previewResult.node : candidate);
          reservationIds.delete(reservationId);
          reservationIds.add(previewResult.node.id);
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
      } catch (error) {
        incomingPlacementReservations.current = incomingPlacementReservations.current
          .filter((candidate) => !reservationIds.has(candidate.id));
        throw error;
      }
      if (createdNodes.length) setNodes((current) => appendUniqueById(current, createdNodes));
      if (createdEdges.length) setEdges((current) => appendUniqueById(current, createdEdges));
      window.setTimeout(() => {
        incomingPlacementReservations.current = incomingPlacementReservations.current
          .filter((candidate) => !reservationIds.has(candidate.id));
      }, 0);

      const latest = nodesSnapshot.current.find((node) => node.id === targetId)?.data.record ?? target;
      const nextContent = { ...latest.content };
      delete nextContent.generatedVideos;
      const generatedSeeds = [...new Set([
        ...generatedSeedsFromContent(latest.content),
        result.seed,
      ])];
      const remainingTaskCount = Math.max(
        0,
        (runningComfyClients.current.get(targetId)?.size ?? 1) - 1,
      );
      changeNode(targetId, {
        content: {
          ...nextContent,
          status: remainingTaskCount ? "running" : "succeeded",
          executionProgress: remainingTaskCount ? null : 100,
          validationMessage: remainingTaskCount
            ? `本次生成完成，仍有 ${remainingTaskCount} 个任务正在执行或排队`
            : `生成完成，已创建 ${result.outputs.length} 个独立预览节点`,
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
      const remainingTaskCount = Math.max(
        0,
        (runningComfyClients.current.get(targetId)?.size ?? 1) - 1,
      );
      if (cancelledComfyClients.current.has(clientId)) {
        const latest = nodesSnapshot.current.find((node) => node.id === targetId)?.data.record ?? target;
        changeNode(targetId, {
          content: {
            ...latest.content,
            status: remainingTaskCount ? "cancelling" : "cancelled",
            executionProgress: null,
            validationMessage: remainingTaskCount
              ? `已取消一个任务，仍有 ${remainingTaskCount} 个任务正在执行或排队`
              : "已取消 ComfyUI 生成",
          },
        });
        updateGenerationPlaceholder(placeholder.id, {
          status: "cancelled",
          executionProgress: null,
          validationMessage: "已取消 ComfyUI 生成",
        });
        setNotice(remainingTaskCount
          ? `已取消一个任务，仍有 ${remainingTaskCount} 个任务`
          : "已取消 ComfyUI 生成");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const latest = nodesSnapshot.current.find((node) => node.id === targetId)?.data.record ?? target;
      changeNode(targetId, {
        content: {
          ...latest.content,
          status: remainingTaskCount ? "running" : "invalid",
          executionProgress: null,
          validationMessage: remainingTaskCount
            ? `一个任务生成失败，仍有 ${remainingTaskCount} 个任务正在执行或排队`
            : `生成失败：${message}`,
        },
      });
      updateGenerationPlaceholder(placeholder.id, {
        status: "invalid",
        executionProgress: null,
        validationMessage: `生成失败：${message}`,
      });
      reportError(error);
    } finally {
      progressSocket?.close();
      cancelledComfyClients.current.delete(clientId);
      ownedComfyClients.current.delete(clientId);
      forgetComfyTask(clientId);
      unregisterComfyTask(targetId, clientId);
    }
  }, [changeNode, completeGenerationPlaceholder, createGenerationPlaceholder, forgetComfyTask, generatedPreviewHeightForAspectRatio, generationSnapshotForGenerator, registerComfyTask, rememberComfyTask, reportError, setEdges, setNodes, unregisterComfyTask, updateGenerationPlaceholder]);

  const executeSecondarySample = useCallback(async (previewId: string) => {
    const previewNode = nodesSnapshot.current.find((node) => node.id === previewId);
    if (!previewNode || previewNode.data.record.kind !== "generated-video") {
      setNotice("无法二采：找不到视频预览节点");
      return;
    }
    const preview = recordAtCurrentFlowPosition(previewNode);
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
    const taskSubmittedAt = Date.now();
    let placeholder: NodeRecord;
    try {
      placeholder = await createGenerationPlaceholder({
        source: preview,
        clientId,
        snapshot,
        secondary: true,
        sourceGeneratorId,
      });
    } catch (error) {
      reportError(error);
      return;
    }
    ownedComfyClients.current.add(clientId);
    rememberComfyTask({
      clientId,
      nodeId: previewId,
      canvasId: preview.canvasId,
      snapshot,
      startedAt: taskSubmittedAt,
      kind: "secondary",
      sourceGeneratorId,
      placeholderNodeId: placeholder.id,
    });
    cancelledComfyClients.current.delete(clientId);
    registerComfyTask(previewId, clientId);
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
      if (cancelledComfyClients.current.has(clientId)) {
        throw new Error("ComfyUI 二采已取消");
      }
      let executingNodeId = "";
      progressSocket?.addEventListener("message", (event) => {
        if (cancelledComfyClients.current.has(clientId) || typeof event.data !== "string") return;
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
            updateGenerationPlaceholder(placeholder.id, {
              status: "running",
              executionProgress: progress,
              validationMessage,
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
          workflowPath: h3WorkflowPathRef.current,
          inputRootPath: comfyInputRootRef.current,
          clientId,
          prompt: snapshot.prompt,
          seedMode: "fixed",
          seed: previewSeed,
          durationSeconds: snapshot.durationSeconds,
          aspectRatio: snapshot.aspectRatio,
          primaryResolutionMegapixels: snapshot.primaryResolutionMegapixels,
          secondaryResolutionMegapixels: snapshot.secondaryResolutionMegapixels,
          secondarySamplingEnabled: true,
          loraName: snapshot.loraName,
          loraStrength: snapshot.loraStrength,
          imagePaths: snapshot.imagePaths,
          audioPaths: snapshot.audioPaths,
          videoPaths: snapshot.videoPaths,
          secondarySource,
        },
      });
      if (!result.outputs.length) throw new Error("ComfyUI 二采没有返回视频输出");
      if (cancelledComfyClients.current.has(clientId)) return;
      const generationElapsedSeconds = validExecutionElapsedSeconds(result.executionElapsedSeconds);

      const previewWidth = GENERATED_VIDEO_PREVIEW_WIDTH;
      const previewHeight = generatedPreviewHeightForAspectRatio(snapshot.aspectRatio);
      const placementRecords = nodesSnapshot.current.map(recordAtCurrentFlowPosition);
      const createdNodes: CanvasFlowNode[] = [];
      const createdEdges: Edge[] = [];
      for (const [index, output] of result.outputs.entries()) {
        const title = result.outputs.length > 1 ? `二采预览 ${index + 1}` : "二采预览";
        const outputContent: JsonObject = {
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
          outputIndex: index,
          aspectRatio: videoAspectRatioValue(snapshot.aspectRatio),
          generationSnapshot: snapshot,
          hasBeenPlayed: false,
          ...(generationElapsedSeconds === null ? {} : { generationElapsedSeconds }),
        };
        if (index === 0) {
          const completedPlaceholder = await completeGenerationPlaceholder(
            placeholder.id,
            title,
            outputContent,
          );
          if (completedPlaceholder) {
            placementRecords.push(completedPlaceholder);
            continue;
          }
        }
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
            title,
            content: outputContent,
            source: "comfyui",
            requestId: comfyPreviewRequestId(preview.canvasId, previewId, result.promptId, index),
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
      if (createdNodes.length) setNodes((current) => appendUniqueById(current, createdNodes));
      if (createdEdges.length) setEdges((current) => appendUniqueById(current, createdEdges));

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
      if (cancelledComfyClients.current.has(clientId)) {
        changeNode(previewId, {
          content: {
            ...latest.content,
            status: "cancelled",
            executionProgress: null,
            validationMessage: "已取消 ComfyUI 二采",
          },
        });
        updateGenerationPlaceholder(placeholder.id, {
          status: "cancelled",
          executionProgress: null,
          validationMessage: "已取消 ComfyUI 二采",
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
      updateGenerationPlaceholder(placeholder.id, {
        status: "invalid",
        executionProgress: null,
        validationMessage: `二采失败：${message}`,
      });
      reportError(error);
    } finally {
      progressSocket?.close();
      cancelledComfyClients.current.delete(clientId);
      ownedComfyClients.current.delete(clientId);
      forgetComfyTask(clientId);
      unregisterComfyTask(previewId, clientId);
    }
  }, [changeNode, completeGenerationPlaceholder, createGenerationPlaceholder, forgetComfyTask, generatedPreviewHeightForAspectRatio, generationSnapshotForGenerator, registerComfyTask, rememberComfyTask, reportError, setEdges, setNodes, unregisterComfyTask, updateGenerationPlaceholder]);

  const cancelVideoExecution = useCallback(async (targetId: string) => {
    const clientIds = [...(runningComfyClients.current.get(targetId) ?? [])];
    const clientId = clientIds.find(
      (candidate) => !cancelledComfyClients.current.has(candidate),
    );
    const target = nodesSnapshot.current.find((node) => node.id === targetId)?.data.record;
    if (!clientId || !target) {
      setNotice("当前没有可取消的 ComfyUI 任务");
      return;
    }
    const persistedTask = persistedComfyTasks.current.find(
      (task) => task.clientId === clientId,
    );
    const taskLabel = persistedTask && isSecondaryComfyTask(persistedTask) ? "二采" : "生成";
    cancelledComfyClients.current.add(clientId);
    changeNode(targetId, {
      content: {
        ...target.content,
        status: "cancelling",
        validationMessage: clientIds.length > 1
          ? `正在取消最早提交的任务，之后还剩 ${clientIds.length - 1} 个…`
          : `正在取消 ComfyUI ${taskLabel}…`,
      },
    });
    updateGenerationPlaceholder(persistedTask?.placeholderNodeId, {
      status: "cancelling",
      validationMessage: `正在取消 ComfyUI ${taskLabel}…`,
    });
    setNotice(clientIds.length > 1
      ? `正在取消最早提交的任务，之后还剩 ${clientIds.length - 1} 个…`
      : `正在取消 ComfyUI ${taskLabel}…`);

    try {
      const cleanupWarning = await invoke<string | null>("cancel_comfyui_workflow", {
        serverUrl: COMFYUI_SERVER_URL,
        clientId,
      });
      if (!ownedComfyClients.current.has(clientId)) {
        forgetComfyTask(clientId);
        cancelledComfyClients.current.delete(clientId);
        unregisterComfyTask(targetId, clientId);
      }
      const remainingTaskCount = [...(runningComfyClients.current.get(targetId) ?? [])]
        .filter((candidate) => candidate !== clientId)
        .length;
      const latest = nodesSnapshot.current.find((node) => node.id === targetId)?.data.record ?? target;
      changeNode(targetId, {
        content: {
          ...latest.content,
          status: remainingTaskCount ? "running" : "cancelled",
          executionProgress: null,
          validationMessage: remainingTaskCount
            ? `已取消最早提交的任务，仍有 ${remainingTaskCount} 个任务`
            : `已取消 ComfyUI ${taskLabel}`,
        },
      });
      updateGenerationPlaceholder(persistedTask?.placeholderNodeId, {
        status: "cancelled",
        executionProgress: null,
        validationMessage: `已取消 ComfyUI ${taskLabel}`,
      });
      setNotice(cleanupWarning
        ? `${taskLabel}已取消，但输入缓存清理失败：${cleanupWarning}`
        : remainingTaskCount
          ? `已取消最早提交的任务，仍有 ${remainingTaskCount} 个任务`
          : `已取消 ComfyUI ${taskLabel}`);
    } catch (error) {
      cancelledComfyClients.current.delete(clientId);
      const message = error instanceof Error ? error.message : String(error);
      const latest = nodesSnapshot.current.find((node) => node.id === targetId)?.data.record ?? target;
      changeNode(targetId, {
        content: {
          ...latest.content,
          status: "running",
          executionProgress: null,
          validationMessage: `取消${taskLabel}失败：${message}`,
        },
      });
      updateGenerationPlaceholder(persistedTask?.placeholderNodeId, {
        status: "running",
        executionProgress: null,
        validationMessage: `取消${taskLabel}失败：${message}`,
      });
      reportError(error);
    }
  }, [changeNode, forgetComfyTask, reportError, unregisterComfyTask, updateGenerationPlaceholder]);

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
        ...recordAtCurrentFlowPosition(node),
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
        relationHighlighted: false,
        activeTaskCount: activeComfyTaskCounts[record.id] ?? 0,
        inputCount: 0,
        mediaInputs: [],
        textInputCount: 0,
        textInputs: [],
        h3LoraOptions,
        onH3LoraPreferenceChange: rememberH3LoraPreference,
        onChange: changeNode,
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
    [activeComfyTaskCounts, cancelVideoExecution, changeNode, copyText, deleteNode, executeSecondarySample, executeVideoNode, h3LoraOptions, rememberH3LoraPreference, removeInputFromVideoNode, reportExecutionCheck, revealGeneratedVideo],
  );
  makeFlowNodeRef.current = makeFlowNode;

  const restoreCompletedComfyTask = useCallback(async (
    task: PersistedComfyTask,
    recovered: ComfyClientTaskStatus,
  ) => {
    const sourceNode = nodesSnapshot.current.find((node) => node.id === task.nodeId);
    if (!sourceNode || recovered.status !== "success" || !recovered.promptId) return null;
    const alreadyRestored = nodesSnapshot.current.some((node) => (
      node.data.record.kind === "generated-video"
      && node.data.record.content.comfyPromptId === recovered.promptId
    ));
    if (alreadyRestored) return null;

    const secondaryTask = isSecondaryComfyTask(task);
    const source = recordAtCurrentFlowPosition(sourceNode);
    const sourceGeneratorId = secondaryTask
      ? task.sourceGeneratorId
        || (typeof source.content.sourceGeneratorId === "string"
          ? source.content.sourceGeneratorId
          : "")
      : task.nodeId;
    const generationElapsedSeconds = validExecutionElapsedSeconds(
      recovered.executionElapsedSeconds,
    );
    const previewWidth = GENERATED_VIDEO_PREVIEW_WIDTH;
    const previewHeight = generatedPreviewHeightForAspectRatio(task.snapshot.aspectRatio);
    const placementRecords = [
      ...nodesSnapshot.current.map(recordAtCurrentFlowPosition),
      ...incomingPlacementReservations.current,
    ];
    const createdNodes: CanvasFlowNode[] = [];
    const createdEdges: Edge[] = [];
    const reservationIds = new Set<string>();
    try {
      for (const [index, output] of recovered.outputs.entries()) {
        const title = secondaryTask
          ? recovered.outputs.length > 1 ? `二采预览 ${index + 1}` : "二采预览"
          : recovered.outputs.length > 1 ? `视频预览 ${index + 1}` : "视频预览";
        const outputContent: JsonObject = {
          videoUrl: output.url,
          originalName: output.filename,
          filename: output.filename,
          subfolder: output.subfolder,
          fileType: output.fileType,
          seed: recovered.seed ?? "",
          comfyPromptId: recovered.promptId,
          comfyServerUrl: COMFYUI_SERVER_URL,
          sourceGeneratorId,
          ...(secondaryTask ? { sourcePreviewId: task.nodeId } : {}),
          outputIndex: index,
          aspectRatio: videoAspectRatioValue(task.snapshot.aspectRatio),
          generationSnapshot: task.snapshot,
          hasBeenPlayed: false,
          ...(generationElapsedSeconds === null ? {} : { generationElapsedSeconds }),
        };
        if (index === 0) {
          const completedPlaceholder = await completeGenerationPlaceholder(
            task.placeholderNodeId,
            title,
            outputContent,
          );
          if (completedPlaceholder) {
            placementRecords.push(completedPlaceholder);
            continue;
          }
        }
        const position = generatedPreviewPosition(
          source,
          placementRecords,
          previewWidth,
          previewHeight,
        );
        const reservationId = `recovered-preview:${task.clientId}:${index}`;
        const reservation: NodeRecord = {
          ...source,
          id: reservationId,
          kind: "generated-video",
          content: {
            sourceGeneratorId,
            ...(secondaryTask ? { sourcePreviewId: task.nodeId } : {}),
          },
          x: position.x,
          y: position.y,
          width: previewWidth,
          height: previewHeight,
          createdAt: new Date().toISOString(),
        };
        reservationIds.add(reservationId);
        incomingPlacementReservations.current.push(reservation);
        const previewResult = await invoke<CreateNodeResult>("create_node", {
          input: {
            canvasId: task.canvasId,
            kind: "generated-video",
            title,
            content: outputContent,
            source: "comfyui-recovery",
            requestId: comfyPreviewRequestId(
              task.canvasId,
              task.nodeId,
              recovered.promptId,
              index,
            ),
            x: position.x,
            y: position.y,
            width: previewWidth,
            height: previewHeight,
          },
        });
        incomingPlacementReservations.current = incomingPlacementReservations.current
          .map((candidate) => candidate.id === reservationId ? previewResult.node : candidate);
        reservationIds.delete(reservationId);
        reservationIds.add(previewResult.node.id);
        placementRecords.push(previewResult.node);
        const flowNode = makeFlowNodeRef.current?.(previewResult.node);
        if (flowNode) createdNodes.push(flowNode);
        const edgeRecord = await invoke<EdgeRecord>("create_edge", {
          input: {
            canvasId: task.canvasId,
            sourceNodeId: task.nodeId,
            targetNodeId: previewResult.node.id,
            kind: secondaryTask ? "secondary-output" : "output",
            metadata: {
              seed: recovered.seed ?? "",
              promptId: recovered.promptId,
              outputIndex: index,
              recovered: true,
              ...(secondaryTask ? {
                secondaryResolutionMegapixels: task.snapshot.secondaryResolutionMegapixels,
              } : {}),
            },
          },
        });
        createdEdges.push(toFlowEdge(edgeRecord));
      }
    } catch (error) {
      incomingPlacementReservations.current = incomingPlacementReservations.current
        .filter((candidate) => !reservationIds.has(candidate.id));
      throw error;
    }
    if (createdNodes.length) setNodes((current) => appendUniqueById(current, createdNodes));
    if (createdEdges.length) setEdges((current) => appendUniqueById(current, createdEdges));
    window.setTimeout(() => {
      incomingPlacementReservations.current = incomingPlacementReservations.current
        .filter((candidate) => !reservationIds.has(candidate.id));
    }, 0);

    const latest = nodesSnapshot.current.find((node) => node.id === task.nodeId)?.data.record
      ?? source;
    if (secondaryTask) {
      const restoredContent: JsonObject = {
        ...latest.content,
        status: "idle",
        executionProgress: null,
        validationMessage: "",
        generationSnapshot: task.snapshot,
      };
      changeNode(task.nodeId, { content: restoredContent });
      return restoredContent;
    }
    const generatedSeeds = recovered.seed
      ? [...new Set([...generatedSeedsFromContent(latest.content), recovered.seed])]
      : generatedSeedsFromContent(latest.content);
    const remainingTaskCount = Math.max(
      0,
      (runningComfyClients.current.get(task.nodeId)?.size ?? 1) - 1,
    );
    const restoredContent: JsonObject = {
      ...latest.content,
      status: remainingTaskCount ? "running" : "succeeded",
      executionProgress: remainingTaskCount ? null : 100,
      validationMessage: remainingTaskCount
        ? `已恢复一个完成任务，仍有 ${remainingTaskCount} 个任务正在执行或排队`
        : `已恢复完成任务并创建 ${recovered.outputs.length} 个视频预览`,
      comfyPromptId: recovered.promptId,
      comfyServerUrl: COMFYUI_SERVER_URL,
      lastGenerationSeed: recovered.seed ?? "",
      generatedSeeds,
      generationCount: (typeof latest.content.generationCount === "number"
        ? latest.content.generationCount
        : 0) + 1,
    };
    changeNode(task.nodeId, { content: restoredContent });
    return restoredContent;
  }, [changeNode, completeGenerationPlaceholder, generatedPreviewHeightForAspectRatio, setEdges, setNodes]);

  useEffect(() => {
    if (!activeProjectId) return;
    let disposed = false;
    let timer: number | null = null;
    const closeRecoveredProgressSocket = (clientId: string) => {
      const socket = recoveredComfySockets.current.get(clientId);
      recoveredComfySockets.current.delete(clientId);
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    };
    const ensureRecoveredProgressSocket = (task: PersistedComfyTask) => {
      if (
        recoveredComfySockets.current.has(task.clientId)
        || connectingRecoveredComfyClients.current.has(task.clientId)
      ) return;
      connectingRecoveredComfyClients.current.add(task.clientId);
      void openComfyProgressSocket(task.clientId).then((socket) => {
        connectingRecoveredComfyClients.current.delete(task.clientId);
        if (
          !socket
          || disposed
          || !persistedComfyTasks.current.some((candidate) => candidate.clientId === task.clientId)
        ) {
          socket?.close();
          return;
        }
        recoveredComfySockets.current.set(task.clientId, socket);
        socket.addEventListener("message", (event) => {
          if (disposed) return;
          const update = comfyProgressFromSocketData(event.data);
          if (!update) return;
          const node = nodesSnapshot.current.find((candidate) => candidate.id === task.nodeId);
          if (!node) return;
          const secondaryTask = isSecondaryComfyTask(task);
          recoveredNodeActiveKeys.current.set(task.nodeId, `${task.clientId}:running`);
          changeNode(task.nodeId, {
            content: {
              ...node.data.record.content,
              status: "running",
              executionProgress: update.progress,
              validationMessage: secondaryTask
                ? `ComfyUI 正在二采：当前步骤 ${update.value}/${update.maximum}`
                : `ComfyUI 正在生成：当前步骤 ${update.value}/${update.maximum}`,
            },
          });
          updateGenerationPlaceholder(task.placeholderNodeId, {
            status: "running",
            executionProgress: update.progress,
            validationMessage: secondaryTask
              ? `ComfyUI 正在二采：当前步骤 ${update.value}/${update.maximum}`
              : `ComfyUI 正在生成：当前步骤 ${update.value}/${update.maximum}`,
          });
        });
        socket.addEventListener("close", () => {
          if (recoveredComfySockets.current.get(task.clientId) === socket) {
            recoveredComfySockets.current.delete(task.clientId);
          }
          if (recoveredNodeActiveKeys.current.get(task.nodeId)?.startsWith(`${task.clientId}:`)) {
            recoveredNodeActiveKeys.current.delete(task.nodeId);
          }
        }, { once: true });
      });
    };
    const pollRecoveredTasks = async () => {
      const tasks = persistedComfyTasks.current.filter((task) => (
        task.canvasId === activeProjectId
        && !ownedComfyClients.current.has(task.clientId)
      ));
      if (tasks.length) {
        tasks.forEach((task) => {
          const clients = runningComfyClients.current.get(task.nodeId);
          if (!clients?.has(task.clientId)) registerComfyTask(task.nodeId, task.clientId);
        });
        try {
          const statuses = await invoke<ComfyClientTaskStatus[]>(
            "get_comfyui_client_task_statuses",
            { serverUrl: COMFYUI_SERVER_URL, clientIds: tasks.map((task) => task.clientId) },
          );
          const updatedNodeContents = new Map<string, JsonObject>();
          for (const recovered of statuses) {
            if (disposed) return;
            const task = tasks.find((candidate) => candidate.clientId === recovered.clientId);
            if (!task || !persistedComfyTasks.current.some(
              (candidate) => candidate.clientId === task.clientId,
            )) continue;
            if (recovered.status !== "missing") {
              missingRecoveredTaskPolls.current.delete(task.clientId);
            }
            if (recovered.status === "running" || recovered.status === "pending") {
              ensureRecoveredProgressSocket(task);
              continue;
            }
            if (recovered.status === "success" && recovered.outputs.length) {
              closeRecoveredProgressSocket(task.clientId);
              if (recoveringComfyClients.current.has(task.clientId)) continue;
              recoveringComfyClients.current.add(task.clientId);
              try {
                const restoredContent = await restoreCompletedComfyTask(task, recovered);
                if (restoredContent) updatedNodeContents.set(task.nodeId, restoredContent);
                forgetComfyTask(task.clientId);
                unregisterComfyTask(task.nodeId, task.clientId);
                setNotice(isSecondaryComfyTask(task)
                  ? "已恢复 ComfyUI 完成二采及二采预览"
                  : "已恢复 ComfyUI 完成任务及视频预览");
              } finally {
                recoveringComfyClients.current.delete(task.clientId);
              }
              continue;
            }
            if (recovered.status === "missing") {
              const missingPolls = (missingRecoveredTaskPolls.current.get(task.clientId) ?? 0) + 1;
              missingRecoveredTaskPolls.current.set(task.clientId, missingPolls);
              if (missingPolls < 3) continue;
            }
            if (
              recovered.status === "error"
              || recovered.status === "cancelled"
              || recovered.status === "missing"
              || (recovered.status === "success" && !recovered.outputs.length)
            ) {
              closeRecoveredProgressSocket(task.clientId);
              const node = nodesSnapshot.current.find((candidate) => candidate.id === task.nodeId);
              if (node) {
                const secondaryTask = isSecondaryComfyTask(task);
                const recoveryLabel = secondaryTask ? "二采恢复" : "恢复";
                const validationMessage = recovered.status === "missing"
                  ? `${recoveryLabel}失败：任务不在 ComfyUI 队列或最近历史记录中`
                  : recovered.status === "success"
                    ? `${recoveryLabel}失败：ComfyUI 历史记录中没有视频输出`
                    : recovered.status === "cancelled"
                      ? `已取消恢复的 ComfyUI ${secondaryTask ? "二采" : "任务"}`
                      : `恢复的 ComfyUI ${secondaryTask ? "二采" : "任务"}执行失败`;
                changeNode(task.nodeId, {
                  content: {
                    ...node.data.record.content,
                    status: recovered.status === "cancelled" ? "cancelled" : "invalid",
                    executionProgress: null,
                    validationMessage,
                  },
                });
                updateGenerationPlaceholder(task.placeholderNodeId, {
                  status: recovered.status === "cancelled" ? "cancelled" : "invalid",
                  executionProgress: null,
                  validationMessage,
                });
              }
              missingRecoveredTaskPolls.current.delete(task.clientId);
              forgetComfyTask(task.clientId);
              unregisterComfyTask(task.nodeId, task.clientId);
            }
          }

          const activeByNode = new Map<string, {
            task: PersistedComfyTask;
            status: "running" | "pending";
          }>();
          for (const recovered of statuses) {
            if (recovered.status !== "running" && recovered.status !== "pending") continue;
            const task = tasks.find((candidate) => candidate.clientId === recovered.clientId);
            if (!task || !persistedComfyTasks.current.some(
              (candidate) => candidate.clientId === task.clientId,
            )) continue;
            const current = activeByNode.get(task.nodeId);
            if (!current || (current.status === "pending" && recovered.status === "running")) {
              activeByNode.set(task.nodeId, { task, status: recovered.status });
            }
          }
          const recoveredNodeIds = new Set(tasks.map((task) => task.nodeId));
          for (const nodeId of recoveredNodeIds) {
            const active = activeByNode.get(nodeId);
            if (!active) {
              recoveredNodeActiveKeys.current.delete(nodeId);
              continue;
            }
            const activeKey = `${active.task.clientId}:${active.status}`;
            if (recoveredNodeActiveKeys.current.get(nodeId) === activeKey) continue;
            recoveredNodeActiveKeys.current.set(nodeId, activeKey);
            const node = nodesSnapshot.current.find((candidate) => candidate.id === nodeId);
            if (!node) continue;
            const secondaryTask = isSecondaryComfyTask(active.task);
            changeNode(nodeId, {
              content: {
                ...(updatedNodeContents.get(nodeId) ?? node.data.record.content),
                status: "running",
                executionProgress: null,
                validationMessage: active.status === "running"
                  ? secondaryTask
                    ? "已恢复 ComfyUI 执行中的二采，正在重新接收进度…"
                    : "已恢复 ComfyUI 执行中任务，正在重新接收进度…"
                  : secondaryTask
                    ? "已恢复 ComfyUI 排队中的二采"
                  : "已恢复 ComfyUI 排队任务",
              },
            });
            updateGenerationPlaceholder(active.task.placeholderNodeId, {
              status: "running",
              executionProgress: null,
              validationMessage: active.status === "running"
                ? secondaryTask
                  ? "已恢复 ComfyUI 执行中的二采，正在重新接收进度…"
                  : "已恢复 ComfyUI 执行中任务，正在重新接收进度…"
                : secondaryTask
                  ? "已恢复 ComfyUI 排队中的二采"
                  : "已恢复 ComfyUI 排队任务",
            });
          }
        } catch (error) {
          if (!disposed) reportError(error);
        }
      }
      if (!disposed) timer = window.setTimeout(() => void pollRecoveredTasks(), 2000);
    };
    void pollRecoveredTasks();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      persistedComfyTasks.current
        .filter((task) => task.canvasId === activeProjectId)
        .forEach((task) => closeRecoveredProgressSocket(task.clientId));
    };
  }, [activeProjectId, changeNode, forgetComfyTask, registerComfyTask, reportError, restoreCompletedComfyTask, unregisterComfyTask, updateGenerationPlaceholder]);

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
            content: sourceNode.kind === "video-generation"
              ? copiedVideoGenerationContent(sourceNode.content)
              : structuredClone(sourceNode.content),
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
        || target instanceof HTMLSelectElement
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
      } else if (key === "d" && !event.shiftKey) {
        const selectedIds = nodesSnapshot.current
          .filter((node) => node.selected)
          .map((node) => node.id);
        if (!selectedIds.length) return;
        event.preventDefault();
        copyNodesToClipboard(selectedIds);
        void pasteCopiedNodes();
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
        setRelationAnchorId(null);
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
      setRelationAnchorId(null);
      setCanvasBackground(null);
      setNodes([]);
      setEdges([]);
      setDropActive(false);
    } catch (error) {
      reportError(error);
    }
  }, [flushPendingPatches, reportError, setEdges, setNodes]);

  useEffect(() => {
    const handlePrivateProjectVisibilityShortcut = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.shiftKey || event.repeat) return;
      if (event.key.toLowerCase() !== "h") return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      const activeProjectIsPrivate = activeProjectId !== null
        && projects.some((project) => (
          project.canvas.id === activeProjectId && project.canvas.isPrivate
        ));
      setShowPrivateProjects((show) => !show);
      if (activeProjectIsPrivate) void returnToProjects();
    };

    window.addEventListener("keydown", handlePrivateProjectVisibilityShortcut);
    return () => window.removeEventListener("keydown", handlePrivateProjectVisibilityShortcut);
  }, [activeProjectId, projects, returnToProjects]);

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
                  ...nodesSnapshot.current.map(recordAtCurrentFlowPosition),
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
            window.setTimeout(() => {
              incomingPlacementReservations.current = incomingPlacementReservations.current
                .filter((candidate) => candidate.id !== record.id);
            }, 0);
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
            generationAspectRatio: "16:9",
            generationPrimaryResolution: 0.3,
            generationSecondaryResolution: 0.7,
            secondarySamplingEnabled: false,
            generationLoraName: h3LoraPreference.loraName,
            generationLoraStrength: h3LoraPreference.loraStrength,
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
  }, [activeProjectId, h3LoraPreference, makeFlowNode, reportError, setCenter, setNodes]);

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

  const deleteSelectedElements = useCallback(async () => {
    const selectedNodes = nodesSnapshot.current.filter((node) => node.selected);
    if (selectedNodes.length) {
      await deleteCanvasNodes(selectedNodes);
      return;
    }
    const selectedEdges = edgesSnapshot.current.filter((edge) => edge.selected);
    if (!selectedEdges.length) return;
    try {
      await Promise.all(selectedEdges.map((edge) => invoke("delete_edge", { id: edge.id })));
      const deletedEdgeIds = new Set(selectedEdges.map((edge) => edge.id));
      setEdges((current) => current.filter((edge) => !deletedEdgeIds.has(edge.id)));
      setNotice(`${selectedEdges.length} 条连线已删除`);
    } catch (error) {
      reportError(error);
    }
  }, [deleteCanvasNodes, reportError, setEdges]);

  useEffect(() => {
    const handleDeleteShortcut = (event: KeyboardEvent) => {
      if (event.key !== "Backspace" && event.key !== "Delete") return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      const hasSelection = nodesSnapshot.current.some((node) => node.selected)
        || edgesSnapshot.current.some((edge) => edge.selected);
      if (!hasSelection) return;
      event.preventDefault();
      void deleteSelectedElements();
    };
    window.addEventListener("keydown", handleDeleteShortcut);
    return () => window.removeEventListener("keydown", handleDeleteShortcut);
  }, [deleteSelectedElements]);

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

  useEffect(() => {
    const promptNodeIdsByText = new Map<string, string[]>();
    nodes.forEach((node) => {
      const record = node.data.record;
      if (record.kind !== "text") return;
      const prompt = textFromContent(record.content);
      if (!prompt) return;
      promptNodeIdsByText.set(prompt, [
        ...(promptNodeIdsByText.get(prompt) ?? []),
        record.id,
      ]);
    });

    const updatedVideoIds: string[] = [];
    nodes.forEach((node) => {
      const record = node.data.record;
      if (record.kind !== "generated-video") return;
      const snapshotValue = record.content.generationSnapshot;
      if (!snapshotValue || typeof snapshotValue !== "object" || Array.isArray(snapshotValue)) return;
      const snapshot = snapshotValue as JsonObject;
      if (
        snapshot.promptNodeIdSource === "captured"
        && typeof snapshot.promptNodeId === "string"
        && snapshot.promptNodeId
      ) {
        return;
      }
      const prompt = typeof snapshot.prompt === "string" ? snapshot.prompt : "";
      const matchingPromptNodeIds = promptNodeIdsByText.get(prompt) ?? [];
      const promptNodeId = matchingPromptNodeIds.length === 1
        ? matchingPromptNodeIds[0]
        : "";
      const promptNodeIdSource = promptNodeId ? "verified" : "";
      if (
        snapshot.promptNodeId === promptNodeId
        && snapshot.promptNodeIdSource === promptNodeIdSource
      ) {
        return;
      }
      changeNode(record.id, {
        content: {
          ...record.content,
          generationSnapshot: { ...snapshot, promptNodeId, promptNodeIdSource },
        },
      });
      updatedVideoIds.push(record.id);
    });
    if (updatedVideoIds.length) {
      void flushNodePatches(updatedVideoIds).catch(reportError);
    }
  }, [changeNode, flushNodePatches, nodes, reportError]);

  const relationHighlightedIds = useMemo(() => {
    if (!relationAnchorId) return new Set<string>();
    const recordsById = new Map(nodes.map((node) => [node.id, node.data.record]));
    const anchor = recordsById.get(relationAnchorId);
    if (!anchor || (anchor.kind !== "text" && anchor.kind !== "generated-video")) {
      return new Set<string>();
    }

    if (anchor.kind === "text") {
      const relatedIds = new Set<string>([anchor.id]);
      nodes.forEach((node) => {
        const record = node.data.record;
        if (record.kind !== "generated-video") return;
        const snapshot = generationSnapshotFromContent(record.content);
        if (!snapshot) return;
        if (snapshot.promptNodeId === anchor.id) {
          relatedIds.add(record.id);
        }
      });
      return relatedIds;
    }

    const relatedIds = new Set<string>([anchor.id]);
    const snapshot = generationSnapshotFromContent(anchor.content);
    if (!snapshot) return relatedIds;
    if (snapshot.promptNodeId) {
      const promptNode = recordsById.get(snapshot.promptNodeId);
      if (promptNode?.kind === "text") relatedIds.add(promptNode.id);
    }
    return relatedIds;
  }, [nodes, relationAnchorId]);

  const handleNodeRelationClick = useCallback((node: CanvasFlowNode) => {
    const kind = node.data.record.kind;
    setRelationAnchorId(kind === "text" || kind === "generated-video" ? node.id : null);
  }, []);

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
              relationHighlighted: relationHighlightedIds.has(node.id),
              activeTaskCount: activeComfyTaskCounts[node.id] ?? 0,
              inputCount: 0,
              mediaInputs: [],
              textInputCount: 0,
              textInputs: [],
              h3LoraOptions,
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
            relationHighlighted: relationHighlightedIds.has(node.id),
            activeTaskCount: activeComfyTaskCounts[node.id] ?? 0,
            inputCount: inputRecords.length,
            mediaInputs: orderedMedia,
            textInputCount: connectedText.length,
            textInputs: connectedText,
            h3LoraOptions,
          },
        };
      });
    },
    [activeComfyTaskCounts, edges, h3LoraOptions, matchedIds, nodes, relationHighlightedIds],
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
    setH3WorkflowPathDraft(h3WorkflowPath);
    clearAppLockPasswordFields();
    setAppLockMessage("");
    setPrivateProjectSearch("");
    setActiveSettingsSection("general");
    setSettingsOpen(true);
  };

  const comfyQueueIndicator = comfyQueueCounts.totalCount > 0 ? (
    <span
      className="comfy-queue-summary"
      title={`当前 ${comfyQueueCounts.totalCount} 个任务，${comfyQueueCounts.runningCount} 个正在执行，${comfyQueueCounts.pendingCount} 个等待中`}
      aria-label={`当前 ${comfyQueueCounts.totalCount} 个任务，${comfyQueueCounts.runningCount} 个正在执行，${comfyQueueCounts.pendingCount} 个等待中`}
    >
      <span aria-hidden="true" />
      {comfyQueueCounts.totalCount}
    </span>
  ) : null;

  const privateProjectCount = projects.filter((project) => project.canvas.isPrivate).length;
  const normalizedPrivateProjectSearch = privateProjectSearch.trim().toLocaleLowerCase();
  const filteredPrivateProjects = normalizedPrivateProjectSearch
    ? projects.filter((project) =>
      project.canvas.name.toLocaleLowerCase().includes(normalizedPrivateProjectSearch),
    )
    : projects;
  const visibleProjects = showPrivateProjects
    ? projects
    : projects.filter((project) => !project.canvas.isPrivate);

  const appSettingsDialog = settingsOpen && createPortal(
    <div className="project-dialog-backdrop" onMouseDown={() => setSettingsOpen(false)}>
      <form
        className="project-dialog app-settings-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (activeSettingsSection === "general") saveComfySettings();
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="app-settings-header">
          <div className="project-dialog-icon"><Settings2 size={21} /></div>
          <div>
            <h2>应用设置</h2>
            <p>管理 SuCanvas 的基础连接、私密项目和本机安全。</p>
          </div>
        </div>
        <div className="app-settings-body">
          <nav className="app-settings-nav" aria-label="设置类目">
            <button
              type="button"
              className={activeSettingsSection === "general" ? "is-active" : ""}
              onClick={() => setActiveSettingsSection("general")}
            >
              <Settings2 size={16} />
              <span><strong>基础设置</strong><small>工作流与目录</small></span>
            </button>
            <button
              type="button"
              className={activeSettingsSection === "privacy" ? "is-active" : ""}
              onClick={() => setActiveSettingsSection("privacy")}
            >
              <FolderKanban size={16} />
              <span><strong>私密项目</strong><small>隐藏与显示</small></span>
            </button>
            <button
              type="button"
              className={activeSettingsSection === "security" ? "is-active" : ""}
              onClick={() => setActiveSettingsSection("security")}
            >
              <LockKeyhole size={16} />
              <span><strong>应用锁</strong><small>密码与验证</small></span>
            </button>
          </nav>
          <div className="app-settings-content">
            {activeSettingsSection === "general" && (
              <section className="settings-pane general-settings-pane" aria-labelledby="general-settings-title">
                <div className="settings-pane-heading">
                  <h3 id="general-settings-title">基础设置</h3>
                  <p>配置 H3 API 工作流，以及远程 ComfyUI 输入和输出目录的 Windows 映射路径。</p>
                </div>
        <label>
          H3 API 工作流文件
          <input
            autoFocus
            value={h3WorkflowPathDraft}
            onChange={(event) => setH3WorkflowPathDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setSettingsOpen(false);
              }
            }}
            placeholder="例如：D:\\SuCanvas\\workflows\\MiniMax-H3-api.json"
            spellCheck={false}
          />
          <small>
            请填写本机 H3 API 格式工作流 JSON 的完整路径。移动或重命名文件后，只需在这里更新路径。
          </small>
        </label>
        <label>
          ComfyUI 输入映射目录
          <input
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
            请填写 ComfyUI 的 input 根目录，例如
            X:\ComfyUI_windows_portable\ComfyUI\input。不要包含 infinite-canvas；程序会自动创建并在任务结束后清理
            infinite-canvas\任务ID。留空则不自动清理。
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
              </section>
            )}
            {activeSettingsSection === "privacy" && (
        <section className="private-project-settings settings-pane" aria-labelledby="private-project-settings-title">
          <div className="private-project-settings-heading">
            <span className="private-project-settings-icon"><LockKeyhole size={16} /></span>
            <div>
              <strong id="private-project-settings-title">私密项目</strong>
              <small>被设为私密的项目默认不会出现在项目首页，项目数据不会被删除。</small>
            </div>
            <button
              type="button"
              className={`private-project-visibility ${showPrivateProjects ? "is-active" : ""}`}
              role="switch"
              aria-checked={showPrivateProjects}
              onClick={() => setShowPrivateProjects((show) => !show)}
              title="显示或隐藏私密项目（Ctrl+H）"
            >
              {showPrivateProjects ? <Eye size={14} /> : <EyeOff size={14} />}
              {showPrivateProjects ? "正在显示" : "显示私密项目"}
            </button>
          </div>
          <div className="private-project-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={privateProjectSearch}
              onChange={(event) => setPrivateProjectSearch(event.currentTarget.value)}
              placeholder="搜索项目名称"
              aria-label="搜索私密项目设置中的项目"
              spellCheck={false}
            />
            <span>{filteredPrivateProjects.length} / {projects.length}</span>
            {privateProjectSearch && (
              <button
                type="button"
                onClick={() => setPrivateProjectSearch("")}
                title="清空搜索"
                aria-label="清空项目搜索"
              >
                <X size={13} />
              </button>
            )}
          </div>
          <div className="private-project-list">
            {filteredPrivateProjects.map((project) => {
              const busy = privateProjectBusyId === project.canvas.id;
              return (
                <div className="private-project-row" key={project.canvas.id}>
                  <span className="private-project-row-icon">
                    {project.canvas.isPrivate ? <LockKeyhole size={14} /> : <FolderKanban size={14} />}
                  </span>
                  <span className="private-project-row-name" title={project.canvas.name}>
                    {project.canvas.name}
                  </span>
                  <button
                    type="button"
                    className={`private-project-toggle ${project.canvas.isPrivate ? "is-private" : ""}`}
                    role="switch"
                    aria-checked={project.canvas.isPrivate}
                    aria-label={`${project.canvas.name}：${project.canvas.isPrivate ? "取消私密" : "设为私密"}`}
                    onClick={() => void changeProjectPrivacy(project.canvas.id, !project.canvas.isPrivate)}
                    disabled={Boolean(privateProjectBusyId)}
                  >
                    <span aria-hidden="true" />
                    {busy ? "保存中" : project.canvas.isPrivate ? "私密" : "普通"}
                  </button>
                </div>
              );
            })}
            {filteredPrivateProjects.length === 0 && (
              <div className="private-project-empty">没有匹配的项目</div>
            )}
          </div>
          <p className="private-project-note">
            这是界面隐藏功能，不会加密项目文件；需要防止他人打开软件时，请同时启用本机应用锁。显示开关状态会在重启后继续保留。
          </p>
        </section>
            )}
            {activeSettingsSection === "security" && (
        <section className="app-lock-settings settings-pane" aria-labelledby="app-lock-settings-title">
          <div className="app-lock-settings-heading">
            <span className="app-lock-settings-icon"><LockKeyhole size={16} /></span>
            <div>
              <strong id="app-lock-settings-title">本机应用锁</strong>
              <small>密码经 Argon2 加盐哈希后保存在本机，不会保存明文。</small>
            </div>
            <span className={`app-lock-status ${appLockEnabled ? "is-enabled" : ""}`}>
              {!appLockStatusReady ? "读取中" : appLockEnabled ? "已启用" : "未启用"}
            </span>
          </div>
          {appLockStatusReady && (
            <div className="app-lock-fields">
              {appLockEnabled && (
                <label>
                  当前密码
                  <div className="password-input-wrap">
                    <input
                      type={appLockPasswordVisible ? "text" : "password"}
                      value={appLockCurrentPassword}
                      onChange={(event) => setAppLockCurrentPassword(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void saveAppLockPassword();
                        }
                      }}
                      autoComplete="current-password"
                      disabled={appLockBusy}
                    />
                    <button
                      type="button"
                      onClick={() => setAppLockPasswordVisible((visible) => !visible)}
                      title={appLockPasswordVisible ? "隐藏密码" : "显示密码"}
                      aria-label={appLockPasswordVisible ? "隐藏密码" : "显示密码"}
                    >
                      {appLockPasswordVisible ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </label>
              )}
              <div className="app-lock-new-passwords">
                <label>
                  {appLockEnabled ? "新密码" : "设置密码"}
                  <input
                    type={appLockPasswordVisible ? "text" : "password"}
                    value={appLockNewPassword}
                    onChange={(event) => setAppLockNewPassword(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void saveAppLockPassword();
                      }
                    }}
                    autoComplete="new-password"
                    placeholder="至少 4 个字符"
                    maxLength={128}
                    disabled={appLockBusy}
                  />
                </label>
                <label>
                  确认新密码
                  <input
                    type={appLockPasswordVisible ? "text" : "password"}
                    value={appLockConfirmPassword}
                    onChange={(event) => setAppLockConfirmPassword(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void saveAppLockPassword();
                      }
                    }}
                    autoComplete="new-password"
                    maxLength={128}
                    disabled={appLockBusy}
                  />
                </label>
              </div>
              {appLockMessage && (
                <p className={`app-lock-message is-${appLockMessageKind}`} role="status">
                  {appLockMessage}
                </p>
              )}
              <div className="app-lock-actions">
                {appLockEnabled && (
                  <button
                    type="button"
                    className="app-lock-disable"
                    onClick={() => void turnOffAppLock()}
                    disabled={appLockBusy || !appLockCurrentPassword}
                  >
                    关闭应用锁
                  </button>
                )}
                <button
                  type="button"
                  className="app-lock-save"
                  onClick={() => void saveAppLockPassword()}
                  disabled={appLockBusy || !appLockNewPassword || !appLockConfirmPassword || (appLockEnabled && !appLockCurrentPassword)}
                >
                  {appLockBusy ? "处理中…" : appLockEnabled ? "修改密码" : "启用应用锁"}
                </button>
              </div>
            </div>
          )}
        </section>
            )}
          </div>
        </div>
        <div className="project-dialog-actions">
          <button type="button" className="dialog-cancel" onClick={() => setSettingsOpen(false)}>
            关闭
          </button>
          {activeSettingsSection === "general" && (
            <button type="submit" className="primary-button">
              保存基础设置
            </button>
          )}
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
              <strong>SuCanvas</strong>
              <span>项目工作区</span>
            </div>
          </div>
          <div className="project-header-actions">
            {comfyQueueIndicator}
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
            <span className="project-total">
              {visibleProjects.length} 个项目
              {!showPrivateProjects && privateProjectCount > 0 ? ` · 已隐藏 ${privateProjectCount} 个` : ""}
            </span>
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

            {visibleProjects.map((project) => (
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
                    <strong>
                      <span className="project-name-text">{project.canvas.name}</span>
                      {project.canvas.isPrivate && (
                        <span className="project-private-badge" title="私密项目">
                          <LockKeyhole size={10} /> 私密
                        </span>
                      )}
                    </strong>
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
        className={spacePanActive ? "is-space-pan-active" : undefined}
        nodes={visibleNodes}
        edges={interactiveEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={!spacePanActive}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={connectNodes}
        onNodeClick={(_, node) => handleNodeRelationClick(node)}
        onPaneClick={() => {
          setCanvasContextMenu(null);
          setRelationAnchorId(null);
        }}
        onPaneContextMenu={openCanvasContextMenu}
        isValidConnection={isValidConnection}
        onNodeDragStop={(_, node, draggedNodes) => {
          const movedNodes = draggedNodes.length ? draggedNodes : [node];
          movedNodes.forEach((movedNode) => {
            persistPatch(movedNode.id, {
              x: movedNode.position.x,
              y: movedNode.position.y,
            });
          });
        }}
        minZoom={0.12}
        maxZoom={2.2}
        snapToGrid
        snapGrid={CANVAS_SNAP_GRID}
        defaultEdgeOptions={{ type: "canvasEdge", animated: false }}
        connectionLineStyle={{
          stroke: "#646d82",
          strokeWidth: 2.5,
          vectorEffect: "non-scaling-stroke",
        }}
        deleteKeyCode={null}
        selectionKeyCode="Control"
        multiSelectionKeyCode="Control"
        selectionOnDrag={false}
        panActivationKeyCode="Space"
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
            <span>SuCanvas · Project</span>
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
          {comfyQueueIndicator}
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
      {videoDeletionRequest && createPortal(
        <div
          className="project-dialog-backdrop"
          onMouseDown={() => finishVideoDeletionChoice("cancel")}
        >
          <div
            className="project-dialog project-delete-dialog video-delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-video-title"
            aria-describedby="delete-video-description"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="project-dialog-icon"><Trash2 size={22} /></div>
            <div>
              <h2 id="delete-video-title">删除视频节点？</h2>
              <p id="delete-video-description">
                即将删除 {videoDeletionRequest.videoCount} 个视频节点。
                {videoDeletionRequest.filePaths.length
                  ? ` 检测到 ${videoDeletionRequest.filePaths.length} 个本地视频文件，可选择一并永久删除。`
                  : " 当前没有可定位的本地视频文件，只能删除节点。"}
              </p>
              {videoDeletionRequest.filePaths.length > 0 && (
                <p className="video-delete-warning">
                  同时删除文件后无法撤销，Ctrl+Z 也不能恢复真实视频文件。
                </p>
              )}
            </div>
            <div className="project-dialog-actions">
              <button
                type="button"
                className="dialog-cancel"
                autoFocus
                onClick={() => finishVideoDeletionChoice("cancel")}
              >
                取消
              </button>
              <button
                type="button"
                className="dialog-cancel video-delete-node-only"
                onClick={() => finishVideoDeletionChoice("node-only")}
              >
                仅删除节点
              </button>
              {videoDeletionRequest.filePaths.length > 0 && (
                <button
                  type="button"
                  className="dialog-danger"
                  onClick={() => finishVideoDeletionChoice("node-and-file")}
                >
                  <Trash2 size={14} />
                  同时删除文件
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
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

function AppLockScreen({ onUnlock }: { onUnlock: () => void }) {
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const unlock = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError("");
    try {
      const accepted = await invoke<boolean>("verify_app_lock_password", { password });
      if (!accepted) {
        setPassword("");
        setError("密码错误，请重新输入");
        return;
      }
      onUnlock();
    } catch (unlockError) {
      const message = unlockError instanceof Error ? unlockError.message : String(unlockError);
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="app-lock-screen">
      <form
        className="app-lock-card"
        onSubmit={(event) => {
          event.preventDefault();
          void unlock();
        }}
      >
        <div className="app-lock-mark"><LockKeyhole size={25} /></div>
        <span className="app-lock-eyebrow">SUCANVAS</span>
        <h1>应用已锁定</h1>
        <p>输入本机应用锁密码以继续。</p>
        <label>
          密码
          <div className="app-lock-screen-input">
            <input
              autoFocus
              type={passwordVisible ? "text" : "password"}
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              autoComplete="current-password"
              disabled={busy}
            />
            <button
              type="button"
              onClick={() => setPasswordVisible((visible) => !visible)}
              title={passwordVisible ? "隐藏密码" : "显示密码"}
              aria-label={passwordVisible ? "隐藏密码" : "显示密码"}
            >
              {passwordVisible ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </label>
        <div className={`app-lock-screen-feedback ${error ? "is-error" : ""}`} aria-live="polite">
          {error || "密码只在本机验证"}
        </div>
        <button className="app-lock-unlock" type="submit" disabled={!password || busy}>
          {busy ? "正在验证…" : "解锁"}
        </button>
      </form>
    </main>
  );
}

export default function App() {
  const [accessState, setAccessState] = useState<"checking" | "locked" | "unlocked" | "error">("checking");
  const [statusError, setStatusError] = useState("");

  const checkAppLock = useCallback(async () => {
    setAccessState("checking");
    setStatusError("");
    try {
      const status = await invoke<AppLockStatus>("get_app_lock_status");
      setAccessState(status.enabled ? "locked" : "unlocked");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusError(message);
      setAccessState("error");
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme =
      window.localStorage.getItem("infinite-canvas:theme") === "light" ? "light" : "dark";
    void checkAppLock();
  }, [checkAppLock]);

  if (accessState === "checking") {
    return (
      <main className="app-lock-screen is-loading" aria-label="正在检查应用锁">
        <div className="app-lock-loading-mark"><LockKeyhole size={23} /></div>
      </main>
    );
  }

  if (accessState === "error") {
    return (
      <main className="app-lock-screen">
        <div className="app-lock-card app-lock-error-card">
          <div className="app-lock-mark"><LockKeyhole size={25} /></div>
          <h1>无法读取应用锁</h1>
          <p>{statusError}</p>
          <button className="app-lock-unlock" type="button" onClick={() => void checkAppLock()}>
            重试
          </button>
        </div>
      </main>
    );
  }

  if (accessState === "locked") {
    return <AppLockScreen onUnlock={() => setAccessState("unlocked")} />;
  }

  return (
    <ReactFlowProvider>
      <CanvasWorkspace />
    </ReactFlowProvider>
  );
}
