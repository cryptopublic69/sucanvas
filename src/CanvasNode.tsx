import { convertFileSrc } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";
import {
  BaseEdge,
  Edge,
  EdgeLabelRenderer,
  EdgeProps,
  Handle,
  Node,
  NodeProps,
  NodeResizeControl,
  NodeResizer,
  Position,
  ResizeControlVariant,
  getBezierPath,
  useReactFlow,
} from "@xyflow/react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  Copy,
  Dices,
  Eye,
  FileText,
  Film,
  FolderOpen,
  GripVertical,
  History,
  Image as ImageIcon,
  Info,
  LocateFixed,
  Maximize2,
  Music,
  Pause,
  Palette,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Scaling,
  Sparkles,
  Square,
  Star,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import {
  ChangeEvent,
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  WheelEvent as ReactWheelEvent,
  memo,
  useEffect,
  useRef,
  useState,
} from "react";

type JsonObject = Record<string, unknown>;

function markdownInline(source: string): ReactNode[] {
  const tokens = source.split(/(`[^`]*`|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\([^)]+\)|\*[^*]+\*|_[^_]+_)/g);
  return tokens.filter(Boolean).map((token, index) => {
    if (token.startsWith("`") && token.endsWith("`")) {
      return <code key={index}>{token.slice(1, -1)}</code>;
    }
    if ((token.startsWith("**") && token.endsWith("**")) || (token.startsWith("__") && token.endsWith("__"))) {
      return <strong key={index}>{token.slice(2, -2)}</strong>;
    }
    if ((token.startsWith("*") && token.endsWith("*")) || (token.startsWith("_") && token.endsWith("_"))) {
      return <em key={index}>{token.slice(1, -1)}</em>;
    }
    const link = token.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/);
    if (link) {
      const href = link[2];
      if (/^(https?:|mailto:|#)/i.test(href)) {
        return <a key={index} href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noreferrer">{link[1]}</a>;
      }
    }
    return token;
  });
}

function markdownTableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const character of body) {
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  if (escaped) cell += "\\";
  cells.push(cell.trim());
  return cells;
}

function isMarkdownTableDivider(cells: string[]) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function MarkdownPreview({
  source,
  className = "",
  enableSpaceTablePan = false,
}: {
  source: string;
  className?: string;
  enableSpaceTablePan?: boolean;
}) {
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [tableDragging, setTableDragging] = useState(false);
  const tableDragRef = useRef<{ pointerId: number; startX: number; startScrollLeft: number; element: HTMLDivElement } | null>(null);

  useEffect(() => {
    if (!enableSpaceTablePan) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpaceHeld(true);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpaceHeld(false);
    };
    const clearSpaceState = () => setSpaceHeld(false);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", clearSpaceState);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", clearSpaceState);
    };
  }, [enableSpaceTablePan]);

  const startTableDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enableSpaceTablePan || !spaceHeld || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget;
    tableDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: element.scrollLeft,
      element,
    };
    element.setPointerCapture(event.pointerId);
    setTableDragging(true);
  };

  const moveTableDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = tableDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    drag.element.scrollLeft = drag.startScrollLeft - (event.clientX - drag.startX);
  };

  const endTableDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = tableDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (drag.element.hasPointerCapture(event.pointerId)) drag.element.releasePointerCapture(event.pointerId);
    tableDragRef.current = null;
    setTableDragging(false);
  };

  const blocks: ReactNode[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  let codeLines: string[] | null = null;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const key = `paragraph-${blocks.length}`;
    blocks.push(<p key={key}>{paragraph.map((line, index) => (
      <span key={index}>{index > 0 && <br />}{markdownInline(line)}</span>
    ))}</p>);
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("```")) {
      flushParagraph();
      if (codeLines) {
        blocks.push(<pre key={`code-${blocks.length}`}><code>{codeLines.join("\n")}</code></pre>);
        codeLines = null;
      } else {
        codeLines = [];
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    const tableHeader = markdownTableCells(line);
    const tableDivider = index + 1 < lines.length ? markdownTableCells(lines[index + 1]) : null;
    if (tableHeader && tableDivider && tableHeader.length === tableDivider.length && isMarkdownTableDivider(tableDivider)) {
      flushParagraph();
      const rows: string[][] = [];
      index += 1;
      while (index + 1 < lines.length) {
        const nextRow = markdownTableCells(lines[index + 1]);
        if (!nextRow || nextRow.length !== tableHeader.length) break;
        index += 1;
        rows.push(nextRow);
      }
      const key = `table-${blocks.length}`;
      blocks.push(
        <div
          key={key}
          className={`markdown-table-wrap ${enableSpaceTablePan ? "is-space-draggable" : ""} ${tableDragging ? "is-space-dragging" : ""}`.trim()}
          onPointerDown={startTableDrag}
          onPointerMove={moveTableDrag}
          onPointerUp={endTableDrag}
          onPointerCancel={endTableDrag}
          title={enableSpaceTablePan ? "按住空格键后左右拖动查看表格" : undefined}
        >
          <table className="markdown-table">
            <thead>
              <tr>{tableHeader.map((cell, cellIndex) => <th key={cellIndex}>{markdownInline(cell)}</th>)}</tr>
            </thead>
            {rows.length > 0 && (
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{markdownInline(cell)}</td>)}</tr>
                ))}
              </tbody>
            )}
          </table>
        </div>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const content = markdownInline(heading[2]);
      const key = `heading-${blocks.length}`;
      if (heading[1].length === 1) blocks.push(<h1 key={key}>{content}</h1>);
      else if (heading[1].length === 2) blocks.push(<h2 key={key}>{content}</h2>);
      else if (heading[1].length === 3) blocks.push(<h3 key={key}>{content}</h3>);
      else blocks.push(<h4 key={key}>{content}</h4>);
      continue;
    }
    if (/^([-*_])\1\1+\s*$/.test(line)) {
      flushParagraph();
      blocks.push(<hr key={`rule-${blocks.length}`} />);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      blocks.push(<blockquote key={`quote-${blocks.length}`}>{markdownInline(quote[1])}</blockquote>);
      continue;
    }
    const unordered = line.match(/^[-*+]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      const items: ReactNode[] = [<li key={index}>{markdownInline(unordered[1])}</li>];
      while (index + 1 < lines.length) {
        const next = lines[index + 1].match(/^[-*+]\s+(.+)$/);
        if (!next) break;
        index += 1;
        items.push(<li key={index}>{markdownInline(next[1])}</li>);
      }
      blocks.push(<ul key={`list-${blocks.length}`}>{items}</ul>);
      continue;
    }
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      const items: ReactNode[] = [<li key={index}>{markdownInline(ordered[1])}</li>];
      while (index + 1 < lines.length) {
        const next = lines[index + 1].match(/^\d+[.)]\s+(.+)$/);
        if (!next) break;
        index += 1;
        items.push(<li key={index}>{markdownInline(next[1])}</li>);
      }
      blocks.push(<ol key={`ordered-${blocks.length}`}>{items}</ol>);
      continue;
    }
    paragraph.push(line);
  }
  if (codeLines) blocks.push(<pre key={`code-${blocks.length}`}><code>{codeLines.join("\n")}</code></pre>);
  flushParagraph();
  return <div className={`nodrag markdown-preview ${className}`.trim()}>{blocks.length ? blocks : <p className="is-empty">暂无内容</p>}</div>;
}

function scrollElementWithWheel(event: ReactWheelEvent<HTMLDivElement>) {
  if (event.ctrlKey) return;
  const element = event.currentTarget;
  const rawDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX)
    ? event.deltaY
    : event.deltaX;
  const multiplier = event.deltaMode === 1
    ? 32
    : event.deltaMode === 2
      ? element.clientHeight
      : 1;
  element.scrollTop += rawDelta * multiplier;
  event.preventDefault();
  event.stopPropagation();
}

interface CanvasRecord {
  id: string;
  name: string;
  isPrivate: boolean;
  previewImagePath: string | null;
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

interface PromptVersionRecord {
  id: string;
  label: string;
  title: string;
  text: string;
  information: string;
  referenceSelection?: StoryboardReferenceSelection;
  generationOptions?: {
    durationSeconds: number;
  };
  durationOverrideSeconds?: number;
  createdAt: string;
  requestId?: string;
  source?: string;
  derivedFrom?: Array<{
    nodeId: string;
    versionId: string;
    versionLabel: string;
  }>;
}

type ContentNodeType = "plot" | "script" | "storyboard" | "prompt";

const CONTENT_NODE_TYPE_OPTIONS: Array<{ value: ContentNodeType; label: string }> = [
  { value: "plot", label: "剧情概念" },
  { value: "script", label: "剧本" },
  { value: "storyboard", label: "分镜" },
  { value: "prompt", label: "生成提示词" },
];

function isContentIterationContent(content: JsonObject): boolean {
  return content.contentNode === true
    || content.promptVersionNode === true
    || content.storySceneNode === true;
}

function contentNodeTypeFromContent(content: JsonObject): ContentNodeType {
  if (content.contentType === "plot"
    || content.contentType === "script"
    || content.contentType === "storyboard"
    || content.contentType === "prompt") {
    return content.contentType;
  }
  return content.storySceneNode === true ? "storyboard" : "prompt";
}

function contentNodeTypeLabel(type: ContentNodeType): string {
  return CONTENT_NODE_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? "内容";
}

interface PromptSceneBindingRecord {
  promptSetId: string;
  promptSetTitle: string;
  canvasId: string;
  sceneKey: string;
  sceneTitle: string;
  nodeId: string;
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

interface FolderGroupingUndoRecord {
  parentCanvasId: string;
  childCanvasId: string;
  folderNodeId: string;
  nodes: NodeRecord[];
  edges: EdgeRecord[];
  promptSceneBindings: PromptSceneBindingRecord[];
  duplicatedInputNodes: Array<{
    sourceNodeId: string;
    duplicateNodeId: string;
  }>;
}

interface GroupNodesIntoFolderResult {
  parent: WorkspaceSnapshot;
  child: WorkspaceSnapshot;
  folderNodeId: string;
  removedCrossingEdgeCount: number;
  movedNodeCount: number;
  copiedInputNodeCount: number;
  undo: FolderGroupingUndoRecord;
}

interface CreateEmptyFolderResult {
  parent: WorkspaceSnapshot;
  child: WorkspaceSnapshot;
  folderNodeId: string;
}

interface FolderMergeSourceSnapshot {
  folderNode: NodeRecord;
  childCanvas: CanvasRecord;
  folderLinkCreatedAt: string;
  nodes: NodeRecord[];
  edges: EdgeRecord[];
  promptSceneBindings: PromptSceneBindingRecord[];
}

interface FolderMergeUndoRecord {
  parentCanvasId: string;
  mergedChildCanvasId: string;
  mergedFolderNodeId: string;
  sources: FolderMergeSourceSnapshot[];
  parentEdges: EdgeRecord[];
  deduplicatedInputNodes: Array<{
    originalSourceNodeId: string;
    keptNodeId: string;
    removedNodeIds: string[];
  }>;
}

interface MergeFoldersResult {
  parent: WorkspaceSnapshot;
  child: WorkspaceSnapshot;
  folderNodeId: string;
  mergedNodeCount: number;
  sourceFolderCount: number;
  deduplicatedInputNodeCount: number;
  undo: FolderMergeUndoRecord;
}

interface CancelFolderUndoRecord {
  parentCanvasId: string;
  source: FolderMergeSourceSnapshot;
  parentEdges: EdgeRecord[];
  restoredSourceEdges: EdgeRecord[];
}

interface CancelFolderResult {
  parent: WorkspaceSnapshot;
  movedNodeCount: number;
  undo: CancelFolderUndoRecord;
}

interface CanvasFolderLinkRecord {
  folderNodeId: string;
  childCanvasId: string;
  createdAt: string;
}

interface FolderTreeUndoRecord {
  parentCanvasId: string;
  rootFolderNodeId: string;
  canvases: CanvasRecord[];
  nodes: NodeRecord[];
  edges: EdgeRecord[];
  folderLinks: CanvasFolderLinkRecord[];
  promptSceneBindings: PromptSceneBindingRecord[];
}

interface DeleteFolderResult {
  parent: WorkspaceSnapshot;
  deletedContentNodeCount: number;
  undo: FolderTreeUndoRecord;
}

interface RuntimeInfo {
  baseUrl: string;
  dataPath: string;
  canvasId: string;
}

interface AppLockStatus {
  enabled: boolean;
}

interface AppBackupSummary {
  path: string;
  createdAt: string;
  fileCount: number;
  totalBytes: number;
}

interface AppRestoreSummary {
  createdAt: string;
  sourceAppVersion: string;
  fileCount: number;
  totalBytes: number;
  requiresRestart: boolean;
}

interface CreateNodeResult {
  node: NodeRecord;
  created: boolean;
}

interface ResizeImageResult {
  node: NodeRecord;
  edge: EdgeRecord;
}

interface DeletedBatch {
  nodes: NodeRecord[];
  edges: EdgeRecord[];
  promptSceneBindings?: PromptSceneBindingRecord[];
}

interface RestoreNodeReplacementResult {
  node: NodeRecord;
  restored: DeletedBatch;
}

type CanvasUndoEntry =
  | { kind: "node-delete"; batch: DeletedBatch }
  | { kind: "prompt-migration"; previousNode: NodeRecord; deleted: DeletedBatch }
  | { kind: "prompt-version-delete"; previousNode: NodeRecord }
  | { kind: "folder-group"; grouping: FolderGroupingUndoRecord }
  | { kind: "folder-merge"; merge: FolderMergeUndoRecord }
  | { kind: "folder-cancel"; cancellation: CancelFolderUndoRecord }
  | { kind: "folder-delete"; deletion: FolderTreeUndoRecord };

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

type StoryboardReferenceKind = "image" | "audio" | "video";

interface StoryboardReferenceAsset {
  sourceId: string;
  kind: StoryboardReferenceKind;
  label: string;
  subjectLabel?: string;
  role: string;
}

interface StoryboardReferenceSelection {
  sceneKey: string;
  assets: StoryboardReferenceAsset[];
}

interface StoryboardReferenceMapping extends StoryboardReferenceAsset {
  title: string;
}

interface StoryboardReferenceResolution {
  selection: StoryboardReferenceSelection | null;
  selectedMedia: NodeRecord[];
  mappings: StoryboardReferenceMapping[];
  skippedCount: number;
  error: string;
}

interface GenerationSnapshot {
  prompt: string;
  promptInformation: string;
  promptNodeId: string;
  promptNodeTitle: string;
  promptNodeIdSource: "captured" | "verified" | "";
  promptVersionId: string;
  promptVersionLabel: string;
  durationSeconds: number;
  aspectRatio: VideoAspectRatio;
  primaryResolutionMegapixels: number;
  secondaryResolutionMegapixels: number;
  primaryVideoSteps: number;
  primaryAudioSteps: number;
  secondarySchedulerSteps: number;
  primaryBrightness: number;
  primaryContrast: number;
  primarySaturation: number;
  secondaryBrightness: number;
  secondaryContrast: number;
  secondarySaturation: number;
  diffusionModelName: string;
  loraName: string;
  loraStrength: number;
  loraStrengthRecorded?: boolean;
  loraBypassed: boolean;
  secondaryLoraName: string;
  secondaryLoraStrength: number;
  secondaryLoraStrengthRecorded?: boolean;
  secondaryLoraBypassed: boolean;
  refImageSize: RefImageSize;
  refImageSizeRecorded?: boolean;
  strictPromptTags?: boolean;
  imagePaths: string[];
  imageRoles: FrameRole[];
  audioPaths: string[];
  videoPaths: string[];
  referenceCompilerMode?: boolean;
  referenceSelection?: StoryboardReferenceSelection | null;
  referenceSelectionError?: string;
  referenceMappings?: StoryboardReferenceMapping[];
  referenceCandidateCount?: number;
  workflowModuleId: string;
  workflowModuleRevision: string;
}

interface VideoRegenerationRequest {
  sourcePreview: NodeRecord;
  snapshot: GenerationSnapshot;
  seed: string;
}

interface VideoExecutionOptions {
  clientId?: string;
  snapshot?: GenerationSnapshot;
  placeholderPosition?: { x: number; y: number };
  allowFixedSeedRepeat?: boolean;
}

interface VideoRegenerationPromptOption {
  key: string;
  label: string;
  prompt: string;
  information: string;
  referenceSelection: StoryboardReferenceSelection | null;
  promptNodeId: string;
  promptNodeTitle: string;
  promptNodeIdSource: "captured" | "verified" | "";
  promptVersionId: string;
  promptVersionLabel: string;
}

interface VideoRegenerationDraft {
  previewId: string;
  previewTitle: string;
  originalSnapshot: GenerationSnapshot;
  promptOptions: VideoRegenerationPromptOption[];
  selectedPromptKey: string;
  seed: string;
  durationSeconds: number;
  primaryResolutionMegapixels: number;
  loraStrength: number;
  primaryVideoSteps: number;
  primaryAudioSteps: number;
  primaryBrightness: number;
  primaryContrast: number;
  primarySaturation: number;
  refImageSize: RefImageSize;
}

type VideoRegenerationNumericField = "primaryResolutionMegapixels"
  | "durationSeconds"
  | "loraStrength"
  | "primaryVideoSteps"
  | "primaryAudioSteps"
  | "primaryBrightness"
  | "primaryContrast"
  | "primarySaturation";

const VIDEO_REGENERATION_NUMBER_CONFIG: Record<
  VideoRegenerationNumericField,
  { min: number; max: number; step: number }
> = {
  primaryResolutionMegapixels: { min: 0.2, max: 2, step: 0.1 },
  durationSeconds: { min: 2, max: 15, step: 1 },
  loraStrength: { min: 0, max: 2, step: 0.05 },
  primaryVideoSteps: { min: 1, max: 1000, step: 1 },
  primaryAudioSteps: { min: 1, max: 1000, step: 1 },
  primaryBrightness: { min: 0, max: 3, step: 0.05 },
  primaryContrast: { min: 0, max: 3, step: 0.05 },
  primarySaturation: { min: 0, max: 3, step: 0.05 },
};

type SecondarySampleOverrides = Pick<
  GenerationSnapshot,
  | "secondaryResolutionMegapixels"
  | "secondarySchedulerSteps"
  | "secondaryBrightness"
  | "secondaryContrast"
  | "secondarySaturation"
  | "secondaryLoraStrength"
  | "secondaryLoraBypassed"
  | "refImageSize"
>;

interface SecondarySampleDraft extends SecondarySampleOverrides {
  previewId: string;
  previewTitle: string;
  seed: string;
}

type SecondarySampleNumericField = Exclude<
  keyof SecondarySampleOverrides,
  "refImageSize" | "secondaryLoraBypassed"
>;

const SECONDARY_SAMPLE_NUMBER_CONFIG: Record<
  SecondarySampleNumericField,
  { min: number; max: number; step: number }
> = {
  secondaryResolutionMegapixels: { min: 0.2, max: 2, step: 0.1 },
  secondaryLoraStrength: { min: 0, max: 2, step: 0.05 },
  secondarySchedulerSteps: { min: 1, max: 10000, step: 1 },
  secondaryBrightness: { min: 0, max: 3, step: 0.05 },
  secondaryContrast: { min: 0, max: 3, step: 0.05 },
  secondarySaturation: { min: 0, max: 3, step: 0.05 },
};

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
  nodeIds?: string[];
  clickedNodeId?: string;
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
  loraBypassed: boolean;
  secondaryLoraName: string;
  secondaryLoraStrength: number;
  secondaryLoraBypassed: boolean;
}

type H3LoraPreferencePatch = Partial<H3LoraPreference>;

interface H3ModelParameters {
  primaryVideoSteps: number;
  primaryAudioSteps: number;
  secondarySchedulerSteps: number;
  primaryBrightness: number;
  primaryContrast: number;
  primarySaturation: number;
  secondaryBrightness: number;
  secondaryContrast: number;
  secondarySaturation: number;
}

interface VideoGenerationDefaults {
  generationMode: VideoGenerationMode;
  workflowModuleId: string;
  workflowModuleRevision: string;
  generationDiffusionModelName: string;
  generationDuration: number;
  generationAspectRatio: VideoAspectRatio;
  generationPrimaryResolution: number;
  generationSecondaryResolution: number;
  generationLoraName: string;
  generationLoraStrength: number;
  generationLoraBypassed: boolean;
  generationSecondaryLoraName: string;
  generationSecondaryLoraStrength: number;
  generationSecondaryLoraBypassed: boolean;
  generationPrimaryVideoSteps: number;
  generationSecondarySchedulerSteps: number;
  seedMode: SeedMode;
  generationSeed: string;
  generationStrictPromptTags: boolean;
  generationRefImageSize: RefImageSize;
}

type WorkflowCapability = "video-generation" | "image-generation";
type WorkflowVariant = "reference-to-video" | "first-last-frame" | "image-to-video" | "last-frame-to-video" | "text-to-video" | "image-generation";
type UiFontSize = "small" | "medium";
type WorkflowModuleSlot = "video-generation:reference-to-video"
  | "video-generation:first-last-frame"
  | "video-generation:image-to-video"
  | "video-generation:last-frame-to-video"
  | "video-generation:text-to-video"
  | "image-generation";

interface WorkflowModuleDefaults extends H3ModelParameters {
  diffusionModelName: string;
  loraName: string;
  loraStrength: number;
}

interface WorkflowBindings {
  promptNodeId: string;
  seedNodeId: string;
  durationNodeId: string;
  primaryResolutionNodeId: string;
  secondaryResolutionNodeId: string;
  primaryLoraNodeId: string;
  secondaryLoraNodeId: string;
  primarySamplerNodeId: string;
  secondarySchedulerNodeId: string;
  secondaryGuiderNodeId: string;
  primaryOutputNodeId: string;
  secondaryOutputNodeId: string;
  primaryColorNodeId: string;
  secondaryColorNodeId: string;
  cleanVideoNodeId: string;
  cleanSaveNodeId: string;
  secondaryVideoInputNodeId: string;
  conditioningNodeId: string;
  audioNodeIds: string[];
  imageNodeIds: string[];
  primaryAudioOutputNodeId: string;
  primaryAudioOutputIndex: number;
  secondaryAudioOutputNodeId: string;
  secondaryAudioOutputIndex: number;
  secondaryResizeNodeId: string;
  secondaryAudioEncodeNodeId: string;
  diffusionModelNodeId: string;
  diffusionModelClassType: string;
  diffusionModelDirectory: string;
  loraClassType: string;
  loraDirectory: string;
}

interface WorkflowAdapter {
  schemaVersion: number;
  engineApiVersion: string;
  adapterId: string;
  capability: WorkflowCapability;
  variant: WorkflowVariant;
  bindings: WorkflowBindings;
}

interface WorkflowUiField {
  key: keyof H3ModelParameters;
  label: string;
  type: "number";
  min: number;
  max: number;
  step: number;
  default: number;
  minKey?: keyof H3ModelParameters;
}

interface WorkflowUiGroup {
  id: string;
  title: string;
  fields: WorkflowUiField[];
  note: string;
}

interface WorkflowUiSchema {
  schemaVersion: number;
  groups: WorkflowUiGroup[];
}

interface WorkflowModuleRecord {
  id: string;
  name: string;
  capability: WorkflowCapability;
  variant: WorkflowVariant;
  revision: string;
  packageSchemaVersion: number;
  engineApiVersion: string;
  adapterKind: string;
  adapterEntry: string;
  uiSchemaEntry: string;
  sourceWorkflowName: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  bindings: WorkflowBindings;
  defaults: WorkflowModuleDefaults;
  workflowPath: string;
  adapterPath: string;
  uiSchemaPath: string;
  adapter: WorkflowAdapter;
  uiSchema: WorkflowUiSchema;
  backupCount: number;
}

interface WorkflowModuleValidation {
  compatible: boolean;
  issues: string[];
}

interface ModelParameterNumberInputProps {
  value: number;
  min: number;
  max: number;
  step: number;
  autoFocus?: boolean;
  disabled?: boolean;
  regenerationField?: VideoRegenerationNumericField;
  secondarySampleField?: SecondarySampleNumericField;
  onChange: (value: number) => void;
}

function ModelParameterNumberInput({
  value,
  min,
  max,
  step,
  autoFocus = false,
  disabled = false,
  regenerationField,
  secondarySampleField,
  onChange,
}: ModelParameterNumberInputProps) {
  const precision = step.toString().split(".")[1]?.length ?? 0;
  const adjust = (direction: -1 | 1) => {
    const current = Number.isFinite(value) ? value : min;
    const next = Math.min(max, Math.max(min, current + direction * step));
    onChange(Number(next.toFixed(precision)));
  };
  return (
    <div className="model-parameter-number-input">
      <input
        autoFocus={autoFocus}
        disabled={disabled}
        data-regeneration-field={regenerationField}
        data-secondary-sample-field={secondarySampleField}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <span className="model-parameter-stepper">
        <button type="button" disabled={disabled} onClick={() => adjust(1)} title="增加" aria-label="增加">
          <ChevronUp size={12} strokeWidth={2} />
        </button>
        <button type="button" disabled={disabled} onClick={() => adjust(-1)} title="减少" aria-label="减少">
          <ChevronDown size={12} strokeWidth={2} />
        </button>
      </span>
    </div>
  );
}

function CompactIntegerInput({
  value,
  min,
  max,
  ariaLabel,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  ariaLabel: string;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [focused, value]);

  const validDraftValue = (text: string) => {
    if (!/^\d+$/.test(text)) return null;
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
  };
  const restoreOrCommit = () => {
    const parsed = validDraftValue(draft);
    if (parsed === null) {
      setDraft(String(value));
      return;
    }
    onChange(parsed);
    setDraft(String(parsed));
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      value={draft}
      aria-label={ariaLabel}
      onFocus={() => setFocused(true)}
      onChange={(event) => {
        const next = event.currentTarget.value;
        if (next !== "" && !/^\d+$/.test(next)) return;
        setDraft(next);
        const parsed = validDraftValue(next);
        if (parsed !== null) onChange(parsed);
      }}
      onBlur={() => {
        restoreOrCommit();
        setFocused(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          restoreOrCommit();
          event.currentTarget.blur();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setDraft(String(value));
          event.currentTarget.blur();
          return;
        }
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        const current = validDraftValue(draft) ?? value;
        const next = Math.min(max, Math.max(min, current + (event.key === "ArrowUp" ? 1 : -1)));
        setDraft(String(next));
        onChange(next);
      }}
      onPointerDown={(event) => event.stopPropagation()}
    />
  );
}

function CompactDecimalInput({
  value,
  min,
  max,
  disabled = false,
  ariaLabel,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [focused, value]);

  const parsedDraftValue = (text: string) => {
    if (text === "" || text === "." || !/^\d*(?:\.\d*)?$/.test(text)) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const commitDraft = () => {
    const parsed = parsedDraftValue(draft);
    if (parsed === null) {
      setDraft(String(value));
      return;
    }
    const normalized = Math.min(max, Math.max(min, parsed));
    onChange(normalized);
    setDraft(String(normalized));
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      pattern="[0-9]*[.]?[0-9]*"
      value={draft}
      disabled={disabled}
      aria-label={ariaLabel}
      onFocus={() => setFocused(true)}
      onChange={(event) => {
        const next = event.currentTarget.value;
        if (!/^\d*(?:\.\d*)?$/.test(next)) return;
        setDraft(next);
        const parsed = parsedDraftValue(next);
        if (parsed !== null && parsed >= min && parsed <= max) onChange(parsed);
      }}
      onBlur={() => {
        commitDraft();
        setFocused(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commitDraft();
          event.currentTarget.blur();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setDraft(String(value));
          event.currentTarget.blur();
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
    />
  );
}

interface SettingsSelectOption {
  value: string;
  label: string;
  title?: string;
  disabled?: boolean;
}

function SettingsSelect({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  placeholder = "请选择",
  title,
}: {
  value: string;
  options: SettingsSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  placeholder?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const controlRef = useRef<HTMLDivElement>(null);
  const selectedOption = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof globalThis.Node && controlRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div ref={controlRef} className="settings-custom-select">
      <button
        type="button"
        className="settings-custom-select-toggle"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={title ?? selectedOption?.title}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>{selectedOption?.label ?? placeholder}</span>
        <ChevronDown className="settings-custom-select-arrow" size={13} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="settings-custom-select-menu nowheel"
          role="listbox"
          aria-label={ariaLabel}
          onWheelCapture={(event) => {
            if (!event.ctrlKey) event.stopPropagation();
          }}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={option.value === value ? "is-active" : ""}
              disabled={option.disabled}
              title={option.title}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface CanvasNodeData extends Record<string, unknown> {
  record: NodeRecord;
  matched: boolean;
  relationHighlighted: boolean;
  relationPromptVersionLabel: string;
  activeTaskCount: number;
  inputCount: number;
  outputCount: number;
  contentParents: NodeRecord[];
  mediaInputs: NodeRecord[];
  textInputCount: number;
  textInputs: NodeRecord[];
  promptNodeTitle: string;
  h3LoraOptions: string[];
  workflowModules: WorkflowModuleRecord[];
  workflowModuleDefaults: Partial<Record<WorkflowModuleSlot, string>>;
  onH3LoraPreferenceChange: (preference: H3LoraPreferencePatch) => void;
  onChange: (id: string, patch: NodePatch) => void;
  onSaveNode: (id: string) => Promise<void>;
  onMarkGeneratedVideoFullyPlayed: (id: string) => void;
  onExecutionCheck: (message: string, valid: boolean) => void;
  onExecute: (id: string) => Promise<void>;
  onBatchExecute: (id: string) => Promise<void>;
  onSecondarySample: (id: string) => Promise<void>;
  onConfigureSecondarySample: (id: string) => void;
  onRegenerateVideo: (id: string) => Promise<void>;
  onConfigureRegenerateVideo: (id: string) => void;
  onLocatePrompt: (id: string, target?: "prompt" | "generator") => void;
  onCancelExecution: (id: string) => Promise<void>;
  onRevealGeneratedVideo: (id: string) => Promise<void>;
  onRemoveInput: (targetId: string, sourceId: string) => Promise<void>;
  onActivateTextInput: (targetId: string, sourceId: string) => void;
  onDeletePromptVersion: (nodeId: string, versionId: string) => Promise<void>;
  onResizeImage: (id: string, maxEdge: number) => Promise<void>;
  onOpenFolder: (id: string) => void;
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
  sourceCanvasId: string;
  pasteCount: number;
}

interface CanvasEdgeData extends Record<string, unknown> {
  record?: EdgeRecord;
  onDisconnect?: (edgeId: string) => void;
}

type CanvasFlowNode = Node<CanvasNodeData, "canvasNode">;

interface AlignmentGuide {
  orientation: "vertical" | "horizontal";
  position: number;
  start: number;
  end: number;
}

interface SpacingGuide extends AlignmentGuide {
  distance: number;
}

interface SpacingAxisMatch {
  delta: number;
  distance: number;
  guides: SpacingGuide[];
}

interface VisibleNodeCacheEntry {
  source: CanvasFlowNode;
  result: CanvasFlowNode;
}

interface CanvasNodeBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function recordAtCurrentFlowPosition(node: CanvasFlowNode): NodeRecord {
  return {
    ...node.data.record,
    x: node.position.x,
    y: node.position.y,
  };
}

function canvasNodeBounds(node: CanvasFlowNode): CanvasNodeBounds {
  const width = node.measured?.width ?? node.width ?? node.data.record.width;
  const height = node.measured?.height ?? node.height ?? node.data.record.height;
  return {
    left: node.position.x,
    right: node.position.x + width,
    top: node.position.y,
    bottom: node.position.y + height,
  };
}

function combinedCanvasNodeBounds(nodes: CanvasFlowNode[]): CanvasNodeBounds {
  const first = canvasNodeBounds(nodes[0]);
  return nodes.slice(1).reduce((combined, node) => {
    const bounds = canvasNodeBounds(node);
    return {
      left: Math.min(combined.left, bounds.left),
      right: Math.max(combined.right, bounds.right),
      top: Math.min(combined.top, bounds.top),
      bottom: Math.max(combined.bottom, bounds.bottom),
    };
  }, first);
}

function boundsOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return Math.min(endA, endB) > Math.max(startA, startB);
}

function overlapMidpoint(startA: number, endA: number, startB: number, endB: number): number {
  return (Math.max(startA, startB) + Math.min(endA, endB)) / 2;
}

function boundsIntersect(first: CanvasNodeBounds, second: CanvasNodeBounds): boolean {
  return first.right >= second.left
    && first.left <= second.right
    && first.bottom >= second.top
    && first.top <= second.bottom;
}

function guidesEqual(first: AlignmentGuide[], second: AlignmentGuide[]): boolean {
  return first.length === second.length && first.every((guide, index) => {
    const other = second[index];
    return guide.orientation === other.orientation
      && guide.position === other.position
      && guide.start === other.start
      && guide.end === other.end;
  });
}

function nodeRecordArraysEqual(first: NodeRecord[], second: NodeRecord[]): boolean {
  return first.length === second.length && first.every((record, index) => record === second[index]);
}

function findEqualSpacing(
  draggedNodes: CanvasFlowNode[],
  candidateNodes: CanvasFlowNode[],
  tolerance: number,
): { horizontal: SpacingAxisMatch | null; vertical: SpacingAxisMatch | null } {
  const dragged = combinedCanvasNodeBounds(draggedNodes);
  const candidates = candidateNodes.map(canvasNodeBounds);
  let horizontal: SpacingAxisMatch | null = null;
  let vertical: SpacingAxisMatch | null = null;

  const nearestLeft = candidates
    .filter((bounds) => bounds.right <= dragged.left + tolerance
      && boundsOverlap(bounds.top, bounds.bottom, dragged.top, dragged.bottom))
    .sort((a, b) => b.right - a.right)[0];
  if (nearestLeft) {
    const preceding = candidates
      .filter((bounds) => bounds !== nearestLeft
        && bounds.right <= nearestLeft.left
        && boundsOverlap(bounds.top, bounds.bottom, nearestLeft.top, nearestLeft.bottom))
      .sort((a, b) => b.right - a.right)[0];
    if (preceding) {
      const referenceGap = nearestLeft.left - preceding.right;
      const delta = nearestLeft.right + referenceGap - dragged.left;
      const distance = Math.abs(delta);
      if (referenceGap >= 0 && distance <= tolerance) {
        const snapped = { ...dragged, left: dragged.left + delta, right: dragged.right + delta };
        horizontal = {
          delta,
          distance,
          guides: [
            {
              orientation: "horizontal",
              position: overlapMidpoint(preceding.top, preceding.bottom, nearestLeft.top, nearestLeft.bottom),
              start: preceding.right,
              end: nearestLeft.left,
              distance: referenceGap,
            },
            {
              orientation: "horizontal",
              position: overlapMidpoint(nearestLeft.top, nearestLeft.bottom, snapped.top, snapped.bottom),
              start: nearestLeft.right,
              end: snapped.left,
              distance: referenceGap,
            },
          ],
        };
      }
    }
  }

  const nearestRight = candidates
    .filter((bounds) => bounds.left >= dragged.right - tolerance
      && boundsOverlap(bounds.top, bounds.bottom, dragged.top, dragged.bottom))
    .sort((a, b) => a.left - b.left)[0];
  if (nearestLeft && nearestRight) {
    const leftGap = dragged.left - nearestLeft.right;
    const rightGap = nearestRight.left - dragged.right;
    const delta = (rightGap - leftGap) / 2;
    const distance = Math.abs(delta);
    const equalGap = leftGap + delta;
    if (equalGap >= 0 && distance <= tolerance && (!horizontal || distance <= horizontal.distance)) {
      const snapped = { ...dragged, left: dragged.left + delta, right: dragged.right + delta };
      horizontal = {
        delta,
        distance,
        guides: [
          {
            orientation: "horizontal",
            position: overlapMidpoint(nearestLeft.top, nearestLeft.bottom, snapped.top, snapped.bottom),
            start: nearestLeft.right,
            end: snapped.left,
            distance: equalGap,
          },
          {
            orientation: "horizontal",
            position: overlapMidpoint(snapped.top, snapped.bottom, nearestRight.top, nearestRight.bottom),
            start: snapped.right,
            end: nearestRight.left,
            distance: equalGap,
          },
        ],
      };
    }
  }
  if (nearestRight) {
    const following = candidates
      .filter((bounds) => bounds !== nearestRight
        && bounds.left >= nearestRight.right
        && boundsOverlap(bounds.top, bounds.bottom, nearestRight.top, nearestRight.bottom))
      .sort((a, b) => a.left - b.left)[0];
    if (following) {
      const referenceGap = following.left - nearestRight.right;
      const delta = nearestRight.left - referenceGap - dragged.right;
      const distance = Math.abs(delta);
      if (referenceGap >= 0 && distance <= tolerance && (!horizontal || distance < horizontal.distance)) {
        const snapped = { ...dragged, left: dragged.left + delta, right: dragged.right + delta };
        horizontal = {
          delta,
          distance,
          guides: [
            {
              orientation: "horizontal",
              position: overlapMidpoint(snapped.top, snapped.bottom, nearestRight.top, nearestRight.bottom),
              start: snapped.right,
              end: nearestRight.left,
              distance: referenceGap,
            },
            {
              orientation: "horizontal",
              position: overlapMidpoint(nearestRight.top, nearestRight.bottom, following.top, following.bottom),
              start: nearestRight.right,
              end: following.left,
              distance: referenceGap,
            },
          ],
        };
      }
    }
  }

  const nearestAbove = candidates
    .filter((bounds) => bounds.bottom <= dragged.top + tolerance
      && boundsOverlap(bounds.left, bounds.right, dragged.left, dragged.right))
    .sort((a, b) => b.bottom - a.bottom)[0];
  if (nearestAbove) {
    const preceding = candidates
      .filter((bounds) => bounds !== nearestAbove
        && bounds.bottom <= nearestAbove.top
        && boundsOverlap(bounds.left, bounds.right, nearestAbove.left, nearestAbove.right))
      .sort((a, b) => b.bottom - a.bottom)[0];
    if (preceding) {
      const referenceGap = nearestAbove.top - preceding.bottom;
      const delta = nearestAbove.bottom + referenceGap - dragged.top;
      const distance = Math.abs(delta);
      if (referenceGap >= 0 && distance <= tolerance) {
        const snapped = { ...dragged, top: dragged.top + delta, bottom: dragged.bottom + delta };
        vertical = {
          delta,
          distance,
          guides: [
            {
              orientation: "vertical",
              position: overlapMidpoint(preceding.left, preceding.right, nearestAbove.left, nearestAbove.right),
              start: preceding.bottom,
              end: nearestAbove.top,
              distance: referenceGap,
            },
            {
              orientation: "vertical",
              position: overlapMidpoint(nearestAbove.left, nearestAbove.right, snapped.left, snapped.right),
              start: nearestAbove.bottom,
              end: snapped.top,
              distance: referenceGap,
            },
          ],
        };
      }
    }
  }

  const nearestBelow = candidates
    .filter((bounds) => bounds.top >= dragged.bottom - tolerance
      && boundsOverlap(bounds.left, bounds.right, dragged.left, dragged.right))
    .sort((a, b) => a.top - b.top)[0];
  if (nearestAbove && nearestBelow) {
    const upperGap = dragged.top - nearestAbove.bottom;
    const lowerGap = nearestBelow.top - dragged.bottom;
    const delta = (lowerGap - upperGap) / 2;
    const distance = Math.abs(delta);
    const equalGap = upperGap + delta;
    if (equalGap >= 0 && distance <= tolerance && (!vertical || distance <= vertical.distance)) {
      const snapped = { ...dragged, top: dragged.top + delta, bottom: dragged.bottom + delta };
      vertical = {
        delta,
        distance,
        guides: [
          {
            orientation: "vertical",
            position: overlapMidpoint(nearestAbove.left, nearestAbove.right, snapped.left, snapped.right),
            start: nearestAbove.bottom,
            end: snapped.top,
            distance: equalGap,
          },
          {
            orientation: "vertical",
            position: overlapMidpoint(snapped.left, snapped.right, nearestBelow.left, nearestBelow.right),
            start: snapped.bottom,
            end: nearestBelow.top,
            distance: equalGap,
          },
        ],
      };
    }
  }
  if (nearestBelow) {
    const following = candidates
      .filter((bounds) => bounds !== nearestBelow
        && bounds.top >= nearestBelow.bottom
        && boundsOverlap(bounds.left, bounds.right, nearestBelow.left, nearestBelow.right))
      .sort((a, b) => a.top - b.top)[0];
    if (following) {
      const referenceGap = following.top - nearestBelow.bottom;
      const delta = nearestBelow.top - referenceGap - dragged.bottom;
      const distance = Math.abs(delta);
      if (referenceGap >= 0 && distance <= tolerance && (!vertical || distance < vertical.distance)) {
        const snapped = { ...dragged, top: dragged.top + delta, bottom: dragged.bottom + delta };
        vertical = {
          delta,
          distance,
          guides: [
            {
              orientation: "vertical",
              position: overlapMidpoint(snapped.left, snapped.right, nearestBelow.left, nearestBelow.right),
              start: snapped.bottom,
              end: nearestBelow.top,
              distance: referenceGap,
            },
            {
              orientation: "vertical",
              position: overlapMidpoint(nearestBelow.left, nearestBelow.right, following.left, following.right),
              start: nearestBelow.bottom,
              end: following.top,
              distance: referenceGap,
            },
          ],
        };
      }
    }
  }

  return { horizontal, vertical };
}

function findEdgeAlignment(
  draggedNodes: CanvasFlowNode[],
  candidateNodes: CanvasFlowNode[],
  tolerance: number,
): { deltaX: number; deltaY: number; guides: AlignmentGuide[] } {
  const draggedBounds = combinedCanvasNodeBounds(draggedNodes);
  const draggedVerticalEdges = [draggedBounds.left, draggedBounds.right];
  const draggedHorizontalEdges = [draggedBounds.top, draggedBounds.bottom];
  let bestVertical: { distance: number; delta: number; target: CanvasNodeBounds; position: number } | null = null;
  let bestHorizontal: { distance: number; delta: number; target: CanvasNodeBounds; position: number } | null = null;

  for (const candidate of candidateNodes) {
    const target = canvasNodeBounds(candidate);
    for (const targetEdge of [target.left, target.right]) {
      for (const draggedEdge of draggedVerticalEdges) {
        const delta = targetEdge - draggedEdge;
        const distance = Math.abs(delta);
        if (distance <= tolerance && (!bestVertical || distance < bestVertical.distance)) {
          bestVertical = { distance, delta, target, position: targetEdge };
        }
      }
    }
    for (const targetEdge of [target.top, target.bottom]) {
      for (const draggedEdge of draggedHorizontalEdges) {
        const delta = targetEdge - draggedEdge;
        const distance = Math.abs(delta);
        if (distance <= tolerance && (!bestHorizontal || distance < bestHorizontal.distance)) {
          bestHorizontal = { distance, delta, target, position: targetEdge };
        }
      }
    }
  }

  const guides: AlignmentGuide[] = [];
  const snappedBounds = {
    left: draggedBounds.left + (bestVertical?.delta ?? 0),
    right: draggedBounds.right + (bestVertical?.delta ?? 0),
    top: draggedBounds.top + (bestHorizontal?.delta ?? 0),
    bottom: draggedBounds.bottom + (bestHorizontal?.delta ?? 0),
  };
  if (bestVertical) {
    guides.push({
      orientation: "vertical",
      position: bestVertical.position,
      start: Math.min(snappedBounds.top, bestVertical.target.top),
      end: Math.max(snappedBounds.bottom, bestVertical.target.bottom),
    });
  }
  if (bestHorizontal) {
    guides.push({
      orientation: "horizontal",
      position: bestHorizontal.position,
      start: Math.min(snappedBounds.left, bestHorizontal.target.left),
      end: Math.max(snappedBounds.right, bestHorizontal.target.right),
    });
  }

  return {
    deltaX: bestVertical?.delta ?? 0,
    deltaY: bestHorizontal?.delta ?? 0,
    guides,
  };
}

const CANVAS_GRID_SIZE = 24;
const ALIGNMENT_SNAP_TOLERANCE_PX = 6;
const NODE_HANDLE_BASE_SIZE_PX = 16;
const NODE_HANDLE_MIN_SCREEN_SIZE_PX = 9;
const EMPTY_NODE_RECORDS: NodeRecord[] = [];
const AUDIO_NODE_MIN_HEIGHT = 240;
const LEGACY_VIDEO_GENERATION_NODE_WIDTH = 360;
const VIDEO_GENERATION_NODE_WIDTH = 460;
const VIDEO_NODE_BASE_HEIGHT = 696;
const VIDEO_NODE_MAX_VISIBLE_TEXT_INPUTS = 10;
const VIDEO_NODE_TEXT_ROW_HEIGHT = 67;
const VIDEO_NODE_IMAGE_GRID_COLUMNS = 5;
const VIDEO_NODE_IMAGE_GRID_GAP = 6;
const VIDEO_NODE_BODY_HORIZONTAL_PADDING = 28;
const VIDEO_NODE_EXECUTION_AREA_HEIGHT = 72;
const MATERIAL_NOTE_HEIGHT = 37;
const MATERIAL_NODE_LAYOUT_VERSION = 2;
const MEDIA_NODE_CHROME_HEIGHT = 73 + MATERIAL_NOTE_HEIGHT;
const IMAGE_NODE_CHROME_HEIGHT = 38 + MATERIAL_NOTE_HEIGHT;
const IMAGE_RESIZE_DEFAULT_STORAGE_KEY = "infinite-canvas:image-resize-max-edge";
const DEFAULT_IMAGE_RESIZE_MAX_EDGE = 2048;
const MIN_IMAGE_RESIZE_MAX_EDGE = 32;
const MAX_IMAGE_RESIZE_MAX_EDGE = 16_384;
const GENERATED_VIDEO_FOOTER_HEIGHT = 38;
const LEGACY_GENERATED_VIDEO_PREVIEW_WIDTH = 360;
const GENERATED_VIDEO_PREVIEW_WIDTH = 420;
const GENERATED_VIDEO_PORTRAIT_PREVIEW_WIDTH = 300;
const BATCH_GENERATION_PREVIEW_GAP_OFFSET = 130;
const GENERATED_VIDEO_PREVIEW_LAYOUT_VERSION = 5;
const DEFAULT_GENERATED_VIDEO_ASPECT_RATIO = 16 / 9;
const SHOW_NODE_SEARCH = false;
const COMFYUI_SERVER_URL = "http://192.168.5.108:8188";
const DEFAULT_GENERATION_SEED = "56456340597885880";
const DEFAULT_H3_DIFFUSION_MODEL_NAME = "MinimaxH3\\minimax_h3_fl2va_pruned_int8_convrot.safetensors";
const DEFAULT_H3_LORA_NAME = "MinimaxH3\\minimax_h3_turbo_4STEPS_comfyui.safetensors";
const H3_LORA_PREFERENCE_STORAGE_KEY = "infinite-canvas:h3-lora-preference";
const DEFAULT_H3_MODEL_PARAMETERS: H3ModelParameters = {
  primaryVideoSteps: 6,
  primaryAudioSteps: 8,
  secondarySchedulerSteps: 4,
  primaryBrightness: 1,
  primaryContrast: 0.9,
  primarySaturation: 0.9,
  secondaryBrightness: 1,
  secondaryContrast: 0.9,
  secondarySaturation: 1,
};

function imageResizeDefaultFromStorage(): number {
  const saved = Number(window.localStorage.getItem(IMAGE_RESIZE_DEFAULT_STORAGE_KEY));
  return Number.isInteger(saved)
    && saved >= MIN_IMAGE_RESIZE_MAX_EDGE
    && saved <= MAX_IMAGE_RESIZE_MAX_EDGE
    ? saved
    : DEFAULT_IMAGE_RESIZE_MAX_EDGE;
}

function stablePlaceholderUnit(key: string): number {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function generatedPlaceholderPositionStyle(nodeId: string, blobIndex: number): CSSProperties {
  const horizontalOffset = stablePlaceholderUnit(`${nodeId}:${blobIndex}:x`) * 30 - 15;
  const verticalOffset = stablePlaceholderUnit(`${nodeId}:${blobIndex}:y`) * 24 - 12;
  const startX = stablePlaceholderUnit(`${nodeId}:${blobIndex}:start-x`) * 16 - 8;
  const startY = stablePlaceholderUnit(`${nodeId}:${blobIndex}:start-y`) * 16 - 8;
  const angle = stablePlaceholderUnit(`${nodeId}:${blobIndex}:angle`) * Math.PI * 2;
  const travelDistance = 24;
  const endX = startX + Math.cos(angle) * travelDistance;
  const endY = startY + Math.sin(angle) * travelDistance;
  const phaseDelay = stablePlaceholderUnit(`${nodeId}:${blobIndex}:phase`) * 7;
  return {
    "--placeholder-blob-x": `${horizontalOffset.toFixed(2)}%`,
    "--placeholder-blob-y": `${verticalOffset.toFixed(2)}%`,
    "--placeholder-motion-start-x": `${startX.toFixed(2)}%`,
    "--placeholder-motion-start-y": `${startY.toFixed(2)}%`,
    "--placeholder-motion-end-x": `${endX.toFixed(2)}%`,
    "--placeholder-motion-end-y": `${endY.toFixed(2)}%`,
    animationDelay: `-${phaseDelay.toFixed(2)}s`,
  } as CSSProperties;
}
const H3_MODEL_PARAMETERS_STORAGE_KEY = "infinite-canvas:h3-model-parameters";
const VIDEO_GENERATION_DEFAULTS_STORAGE_KEY = "infinite-canvas:video-generation-defaults";
const DEFAULT_H3_REFERENCE_WORKFLOW_PATH = "D:\\Data\\CodexProjects\\InfiniteCanvas\\workflows\\MiniMax+H3全能参考工作流.json";
const DEFAULT_H3_FIRST_LAST_WORKFLOW_PATH = "D:\\Data\\CodexProjects\\InfiniteCanvas\\workflows\\MiniMax+H3首尾帧工作流.json";
const DEFAULT_H3_IMAGE_TO_VIDEO_WORKFLOW_PATH = "D:\\Data\\CodexProjects\\InfiniteCanvas\\workflows\\MiniMax+H3图生视频工作流.json";
const DEFAULT_H3_LAST_FRAME_TO_VIDEO_WORKFLOW_PATH = "D:\\Data\\CodexProjects\\InfiniteCanvas\\workflows\\MiniMax+H3尾帧生视频工作流.json";
const H3_REFERENCE_WORKFLOW_STORAGE_KEY = "infinite-canvas:h3-reference-workflow-path";
const WORKFLOW_MODULE_DEFAULTS_STORAGE_KEY = "infinite-canvas:workflow-module-defaults";
const WORKFLOW_PACKAGE_ENGINE = "workflow-package-v1";
const WORKFLOW_CAPABILITIES: Array<{ value: WorkflowCapability; label: string }> = [
  { value: "video-generation", label: "视频生成" },
  { value: "image-generation", label: "图片生成" },
];
const WORKFLOW_VIDEO_VARIANTS: Array<{ value: Exclude<WorkflowVariant, "image-generation">; label: string }> = [
  { value: "reference-to-video", label: "多参生视频" },
  { value: "first-last-frame", label: "首尾帧" },
  { value: "image-to-video", label: "图生视频" },
  { value: "last-frame-to-video", label: "尾帧生视频" },
  { value: "text-to-video", label: "文生视频" },
];
const WORKFLOW_MODULE_SLOTS: WorkflowModuleSlot[] = [
  "video-generation:reference-to-video",
  "video-generation:first-last-frame",
  "video-generation:image-to-video",
  "video-generation:last-frame-to-video",
  "video-generation:text-to-video",
  "image-generation",
];
const COMFY_TASK_STORAGE_KEY = "infinite-canvas:comfy-tasks";
const PRIVATE_PROJECT_VISIBILITY_STORAGE_KEY = "infinite-canvas:show-private-projects";
const UI_FONT_SIZE_STORAGE_KEY = "infinite-canvas:ui-font-size";
const VIDEO_RESIZE_CONTROLS = [
  { position: "top-left", direction: [-1, -1] },
  { position: "top-right", direction: [1, -1] },
  { position: "bottom-right", direction: [1, 1] },
  { position: "bottom-left", direction: [-1, 1] },
] as const;
const VIDEO_GENERATION_MODES = [
  { value: "reference-to-video", label: "参考生视频" },
  { value: "first-last-frame", label: "首尾帧" },
  { value: "image-to-video", label: "图生视频" },
  { value: "last-frame-to-video", label: "尾帧生视频" },
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
const REF_IMAGE_SIZE_OPTIONS = ["max", "match"] as const;
const VIDEO_PREVIEW_DEFAULT_COLOR = "#6fb5df";
const VIDEO_PREVIEW_SECONDARY_COLOR = "#2f6f50";
const NOTE_DEFAULT_COLOR = "#7a6728";
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

function loadImageNaturalSize(path: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.decoding = "async";
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
      } else {
        reject(new Error("图片没有可用的尺寸信息"));
      }
    };
    image.onerror = () => reject(new Error("无法读取图片尺寸"));
    image.src = convertFileSrc(path);
  });
}

type VideoGenerationMode = typeof VIDEO_GENERATION_MODES[number]["value"];
type VideoAspectRatio = typeof VIDEO_ASPECT_RATIO_OPTIONS[number]["value"];
type RefImageSize = typeof REF_IMAGE_SIZE_OPTIONS[number];
type FrameRole = "first" | "last";
type SeedMode = "random" | "fixed";

function generatedVideoPreviewWidthForRatio(aspectRatio: number): number {
  return aspectRatio < 1
    ? GENERATED_VIDEO_PORTRAIT_PREVIEW_WIDTH
    : GENERATED_VIDEO_PREVIEW_WIDTH;
}

function batchGenerationPreviewStep(previewWidth: number): number {
  const gap = previewWidth + BATCH_GENERATION_PREVIEW_GAP_OFFSET;
  return previewWidth + gap;
}

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

function nonOverlappingNodePosition(
  requestedPosition: { x: number; y: number },
  width: number,
  height: number,
  existingNodes: Array<Pick<NodeRecord, "x" | "y" | "width" | "height">>,
): { x: number; y: number } {
  const gap = CANVAS_GRID_SIZE;
  const x = snapCanvasCoordinate(requestedPosition.x);
  let y = snapCanvasCoordinate(requestedPosition.y);

  for (let attempt = 0; attempt <= existingNodes.length; attempt += 1) {
    const blockers = existingNodes.filter((node) => (
      x < node.x + node.width + gap
      && x + width + gap > node.x
      && y < node.y + node.height + gap
      && y + height + gap > node.y
    ));
    if (!blockers.length) break;
    const nextY = snapCanvasCoordinate(
      Math.max(...blockers.map((node) => node.y + node.height)) + gap,
    );
    if (nextY <= y) break;
    y = nextY;
  }

  return { x, y };
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
  storyboardReferenceCompiler = false,
): number {
  const groupCount = new Set(mediaKinds).size;
  const imageCount = mediaKinds.filter((kind) => kind === "image").length;
  const audioCount = mediaKinds.filter((kind) => kind === "audio").length;
  const videoCount = mediaKinds.length - imageCount - audioCount;
  const listMediaRows = videoCount + Math.ceil(audioCount / 2);
  // `.video-input-list.is-image-grid` always has five equal-width columns.
  // Use that real CSS geometry rather than the old 66px estimate, otherwise a
  // wider node underestimates its image grid and clips its execution controls.
  const imageTileWidth = Math.max(
    1,
    (Math.max(180, nodeWidth - VIDEO_NODE_BODY_HORIZONTAL_PADDING)
      - VIDEO_NODE_IMAGE_GRID_GAP * (VIDEO_NODE_IMAGE_GRID_COLUMNS - 1))
      / VIDEO_NODE_IMAGE_GRID_COLUMNS,
  );
  // The image group always appends a clear-all tile, so it also occupies a grid cell.
  const imageRows = imageCount
    ? Math.ceil((imageCount + 1) / VIDEO_NODE_IMAGE_GRID_COLUMNS)
    : 0;
  const textRows = Math.max(
    1,
    Math.min(VIDEO_NODE_MAX_VISIBLE_TEXT_INPUTS, textInputCount),
  );
  const contentHeight = 568
    + listMediaRows * 67
    + groupCount * 36
    + textRows * VIDEO_NODE_TEXT_ROW_HEIGHT
    + (storyboardReferenceCompiler ? 190 : 0)
    + VIDEO_NODE_EXECUTION_AREA_HEIGHT
    + imageRows * Math.ceil(imageTileWidth);
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

function copiedPromptVersionContent(
  content: JsonObject,
  versionIdMap: ReadonlyMap<string, string>,
): JsonObject {
  const copied = structuredClone(content);
  if (!Array.isArray(copied.promptVersions)) return copied;
  copied.promptVersions = copied.promptVersions.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const version = value as JsonObject;
    const versionId = typeof version.id === "string" ? version.id : "";
    const copiedVersionId = versionIdMap.get(versionId);
    return copiedVersionId ? { ...version, id: copiedVersionId } : version;
  });
  for (const key of ["activePromptVersionId", "bestPromptVersionId"]) {
    const versionId = typeof copied[key] === "string" ? copied[key] : "";
    const copiedVersionId = versionIdMap.get(versionId);
    if (copiedVersionId) copied[key] = copiedVersionId;
  }
  return copied;
}

function copiedNodeContentForProject(
  content: JsonObject,
  sourceCanvasId: string,
  targetCanvasId: string,
  nodeIdMap: ReadonlyMap<string, string>,
  versionIdMap: ReadonlyMap<string, string>,
): JsonObject {
  const copied = structuredClone(content);
  const retainExternalReference = sourceCanvasId === targetCanvasId;
  const remapNodeId = (value: unknown): string => {
    if (typeof value !== "string") return "";
    return nodeIdMap.get(value) ?? (retainExternalReference ? value : "");
  };
  const remapNodeIdList = (value: unknown): string[] => (
    Array.isArray(value)
      ? value.map(remapNodeId).filter(Boolean)
      : []
  );

  for (const key of ["mediaInputOrder", "textInputOrder"]) {
    if (Array.isArray(copied[key])) copied[key] = remapNodeIdList(copied[key]);
  }
  if (Array.isArray(copied.promptVersions)) {
    copied.promptVersions = copied.promptVersions.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const version = { ...(value as JsonObject) };
      if (!Array.isArray(version.derivedFrom)) return version;
      version.derivedFrom = version.derivedFrom.flatMap((source) => {
        if (!source || typeof source !== "object" || Array.isArray(source)) return [];
        const item = source as JsonObject;
        const nodeId = remapNodeId(item.nodeId);
        if (!nodeId || typeof item.versionId !== "string") return [];
        return [{
          ...item,
          nodeId,
          versionId: versionIdMap.get(item.versionId) ?? item.versionId,
        }];
      });
      return version;
    });
  }
  for (const key of ["activeTextInputId", "sourceGeneratorId", "sourcePreviewId", "resizedFromNodeId"]) {
    if (typeof copied[key] !== "string") continue;
    const remappedId = remapNodeId(copied[key]);
    if (remappedId) copied[key] = remappedId;
    else delete copied[key];
  }
  if (copied.frameRoles && typeof copied.frameRoles === "object" && !Array.isArray(copied.frameRoles)) {
    copied.frameRoles = Object.fromEntries(
      Object.entries(copied.frameRoles as Record<string, unknown>)
        .map(([nodeId, role]) => [remapNodeId(nodeId), role] as const)
        .filter(([nodeId]) => Boolean(nodeId)),
    );
  }
  if (copied.generationSnapshot
    && typeof copied.generationSnapshot === "object"
    && !Array.isArray(copied.generationSnapshot)) {
    const snapshot = { ...(copied.generationSnapshot as JsonObject) };
    const remappedPromptNodeId = remapNodeId(snapshot.promptNodeId);
    if (remappedPromptNodeId) snapshot.promptNodeId = remappedPromptNodeId;
    else delete snapshot.promptNodeId;
    if (typeof snapshot.promptVersionId === "string") {
      const remappedVersionId = versionIdMap.get(snapshot.promptVersionId);
      if (remappedVersionId) snapshot.promptVersionId = remappedVersionId;
    }
    copied.generationSnapshot = snapshot;
  }
  return copied;
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
  const availableYBelow = (x: number, startingY: number): number => {
    let y = startingY;
    for (let attempt = 0; attempt <= existingNodes.length; attempt += 1) {
      const blockers = existingNodes.filter((node) => (
        x < node.x + node.width + verticalGap
        && x + width + verticalGap > node.x
        && y < node.y + node.height + verticalGap
        && y + height + verticalGap > node.y
      ));
      if (!blockers.length) return y;
      const nextY = Math.max(...blockers.map((node) => node.y + node.height)) + verticalGap;
      if (nextY <= y) break;
      y = nextY;
    }
    return y;
  };
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
    const x = latestPreview.x;
    return {
      x,
      y: availableYBelow(x, latestPreview.y + latestPreview.height + verticalGap),
    };
  }

  const x = snapCanvasCoordinate(generator.x + generator.width + horizontalGap);
  return { x, y: availableYBelow(x, generator.y) };
}

function generatedPreviewPositionBelow(
  source: NodeRecord,
  existingNodes: NodeRecord[],
  width: number,
  height: number,
): { x: number; y: number } {
  const gap = CANVAS_GRID_SIZE / 2;
  const x = source.x;
  let y = source.y + source.height + gap;
  for (let attempt = 0; attempt <= existingNodes.length; attempt += 1) {
    const blockers = existingNodes.filter((node) => (
      node.id !== source.id
      && x < node.x + node.width + gap
      && x + width + gap > node.x
      && y < node.y + node.height + gap
      && y + height + gap > node.y
    ));
    if (!blockers.length) break;
    const nextY = Math.max(...blockers.map((node) => node.y + node.height)) + gap;
    if (nextY <= y) break;
    y = nextY;
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
        promptInformation: typeof task.snapshot.promptInformation === "string"
          ? task.snapshot.promptInformation
          : "",
        promptNodeId: typeof task.snapshot.promptNodeId === "string"
          ? task.snapshot.promptNodeId
          : "",
        promptNodeTitle: typeof task.snapshot.promptNodeTitle === "string"
          ? task.snapshot.promptNodeTitle
          : "",
        promptNodeIdSource: task.snapshot.promptNodeIdSource === "captured"
          || task.snapshot.promptNodeIdSource === "verified"
          ? task.snapshot.promptNodeIdSource
          : "",
        promptVersionId: typeof task.snapshot.promptVersionId === "string"
          ? task.snapshot.promptVersionId
          : "",
        promptVersionLabel: typeof task.snapshot.promptVersionLabel === "string"
          ? task.snapshot.promptVersionLabel
          : "",
        aspectRatio: videoAspectRatioFromContent({
          generationAspectRatio: task.snapshot.aspectRatio,
        }),
        refImageSize: refImageSizeFromContent(task.snapshot as unknown as JsonObject),
        refImageSizeRecorded: typeof task.snapshot.refImageSize === "string",
        ...h3ModelParametersFromContent(task.snapshot as unknown as JsonObject),
        diffusionModelName: h3DiffusionModelNameFromContent(task.snapshot as unknown as JsonObject),
        loraBypassed: h3LoraBypassedFromContent(task.snapshot as unknown as JsonObject),
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
  const restoredSelection = storyboardReferenceSelectionFromValue(
    snapshot.referenceSelection,
  ).selection;
  const referenceMappings = Array.isArray(snapshot.referenceMappings)
    ? snapshot.referenceMappings.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const mapping = value as JsonObject;
        if (
          typeof mapping.sourceId !== "string"
          || (mapping.kind !== "image" && mapping.kind !== "audio" && mapping.kind !== "video")
          || typeof mapping.label !== "string"
          || typeof mapping.role !== "string"
          || typeof mapping.title !== "string"
        ) return [];
        return [{
          sourceId: mapping.sourceId,
          kind: mapping.kind,
          label: mapping.label,
          ...(typeof mapping.subjectLabel === "string"
            ? { subjectLabel: mapping.subjectLabel }
            : {}),
          role: mapping.role,
          title: mapping.title,
        } satisfies StoryboardReferenceMapping];
      })
    : [];
  return {
    prompt: snapshot.prompt,
    promptInformation: typeof snapshot.promptInformation === "string"
      ? snapshot.promptInformation
      : "",
    promptNodeId: typeof snapshot.promptNodeId === "string" ? snapshot.promptNodeId : "",
    promptNodeTitle: typeof snapshot.promptNodeTitle === "string" ? snapshot.promptNodeTitle : "",
    promptNodeIdSource: snapshot.promptNodeIdSource === "captured"
      || snapshot.promptNodeIdSource === "verified"
      ? snapshot.promptNodeIdSource
      : "",
    promptVersionId: typeof snapshot.promptVersionId === "string" ? snapshot.promptVersionId : "",
    promptVersionLabel: typeof snapshot.promptVersionLabel === "string"
      ? snapshot.promptVersionLabel
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
    ...h3ModelParametersFromContent(snapshot),
    diffusionModelName: h3DiffusionModelNameFromContent(snapshot),
    loraName: h3LoraNameFromContent(snapshot),
    loraStrength: h3LoraStrengthFromContent(snapshot),
    loraStrengthRecorded: typeof snapshot.generationLoraStrength === "number"
      || typeof snapshot.loraStrength === "number",
    loraBypassed: h3LoraBypassedFromContent(snapshot),
    secondaryLoraName: h3SecondaryLoraNameFromContent(snapshot),
    secondaryLoraStrength: h3SecondaryLoraStrengthFromContent(snapshot),
    secondaryLoraStrengthRecorded: typeof snapshot.generationSecondaryLoraStrength === "number"
      || typeof snapshot.secondaryLoraStrength === "number",
    secondaryLoraBypassed: h3SecondaryLoraBypassedFromContent(snapshot),
    refImageSize: refImageSizeFromContent(snapshot),
    refImageSizeRecorded: typeof snapshot.refImageSize === "string"
      || typeof snapshot.generationRefImageSize === "string",
    strictPromptTags: strictPromptTagsFromContent(snapshot),
    imagePaths: stringArray(snapshot.imagePaths),
    imageRoles: stringArray(snapshot.imageRoles).filter(
      (role): role is FrameRole => role === "first" || role === "last",
    ),
    audioPaths: stringArray(snapshot.audioPaths),
    videoPaths: stringArray(snapshot.videoPaths),
    referenceCompilerMode: snapshot.referenceCompilerMode === true,
    referenceSelection: restoredSelection,
    referenceSelectionError: typeof snapshot.referenceSelectionError === "string"
      ? snapshot.referenceSelectionError
      : "",
    referenceMappings,
    referenceCandidateCount: typeof snapshot.referenceCandidateCount === "number"
      && Number.isFinite(snapshot.referenceCandidateCount)
      ? Math.max(0, Math.floor(snapshot.referenceCandidateCount))
      : 0,
    workflowModuleId: typeof snapshot.workflowModuleId === "string" ? snapshot.workflowModuleId : "",
    workflowModuleRevision: typeof snapshot.workflowModuleRevision === "string"
      ? snapshot.workflowModuleRevision
      : "",
  };
}

function persistedComfyTaskFromPlaceholder(record: NodeRecord): PersistedComfyTask | null {
  if (record.kind !== "generated-video" || record.content.generationPlaceholder !== true) {
    return null;
  }
  const clientId = typeof record.content.placeholderClientId === "string"
    ? record.content.placeholderClientId
    : "";
  const sourceGeneratorId = typeof record.content.sourceGeneratorId === "string"
    ? record.content.sourceGeneratorId
    : "";
  const sourcePreviewId = typeof record.content.sourcePreviewId === "string"
    ? record.content.sourcePreviewId
    : "";
  const snapshot = generationSnapshotFromContent(record.content);
  if (!clientId || !sourceGeneratorId || !snapshot) return null;
  const parsedStartedAt = Date.parse(record.createdAt);
  return {
    clientId,
    nodeId: sourcePreviewId || sourceGeneratorId,
    canvasId: record.canvasId,
    snapshot,
    startedAt: Number.isFinite(parsedStartedAt) ? parsedStartedAt : Date.now(),
    kind: sourcePreviewId ? "secondary" : "generation",
    ...(sourcePreviewId ? { sourceGeneratorId } : {}),
    placeholderNodeId: record.id,
  };
}

function comfyOutputFromContent(content: JsonObject): ComfyOutputFile | null {
  const filename = typeof content.filename === "string" ? content.filename : "";
  const subfolder = typeof content.subfolder === "string" ? content.subfolder : "";
  const fileType = typeof content.fileType === "string" ? content.fileType : "output";
  const url = typeof content.videoUrl === "string" ? content.videoUrl : "";
  return filename && url ? { filename, subfolder, fileType, url } : null;
}

function cacheBustedGeneratedVideoUrl(content: JsonObject): string {
  const url = typeof content.videoUrl === "string" ? content.videoUrl : "";
  const promptId = typeof content.comfyPromptId === "string" ? content.comfyPromptId : "";
  if (!url || !promptId) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("infinite_canvas_prompt", promptId);
    return parsed.toString();
  } catch {
    return url;
  }
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

function workflowCapabilityForVideoMode(mode: VideoGenerationMode): WorkflowCapability {
  void mode;
  return "video-generation";
}

function workflowSlotForVideoMode(mode: VideoGenerationMode): WorkflowModuleSlot {
  return `video-generation:${mode}`;
}

function workflowSlotForModule(module: Pick<WorkflowModuleRecord, "capability" | "variant">): WorkflowModuleSlot {
  return module.capability === "image-generation"
    ? "image-generation"
    : `video-generation:${module.variant as VideoGenerationMode}`;
}

function workflowVariantLabel(module: Pick<WorkflowModuleRecord, "capability" | "variant">): string {
  if (module.capability === "image-generation") return "图片生成";
  return WORKFLOW_VIDEO_VARIANTS.find((variant) => variant.value === module.variant)?.label ?? module.variant;
}

function workflowModuleDefaultsFromStorage(): Partial<Record<WorkflowModuleSlot, string>> {
  try {
    const raw = window.localStorage.getItem(WORKFLOW_MODULE_DEFAULTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const legacyReferenceDefault = typeof parsed["multi-reference-video"] === "string"
      ? parsed["multi-reference-video"]
      : "";
    return Object.fromEntries(
      WORKFLOW_MODULE_SLOTS
        .map((slot) => [
          slot,
          typeof parsed[slot] === "string"
            ? parsed[slot]
            : slot === "video-generation:reference-to-video"
              ? legacyReferenceDefault
              : "",
        ] as const)
        .filter(([, moduleId]) => moduleId),
    );
  } catch {
    return {};
  }
}

function workflowBindingsFromDraft(value: string): WorkflowBindings | undefined {
  const trimmed = value.trim();
  return trimmed ? JSON.parse(trimmed) as WorkflowBindings : undefined;
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

function refImageSizeFromContent(content: JsonObject): RefImageSize {
  const value = content.generationRefImageSize ?? content.refImageSize;
  return typeof value === "string"
    && REF_IMAGE_SIZE_OPTIONS.includes(value as RefImageSize)
    ? value as RefImageSize
    : "match";
}

function validVideoResolution(value: unknown, fallback: number): number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0.2
    && value <= 2.0
    ? Math.round(value * 10) / 10
    : fallback;
}

function validH3Step(value: unknown, fallback: number, maximum: number): number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 1
    && value <= maximum
    ? value
    : fallback;
}

function validH3ColorAdjustment(value: unknown, fallback: number): number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= 3
    ? Math.round(value * 100) / 100
    : fallback;
}

function h3ModelParametersFromContent(content: JsonObject): H3ModelParameters {
  const primaryVideoSteps = validH3Step(
    content.primaryVideoSteps,
    DEFAULT_H3_MODEL_PARAMETERS.primaryVideoSteps,
    1000,
  );
  const primaryAudioSteps = Math.max(
    primaryVideoSteps,
    validH3Step(
      content.primaryAudioSteps,
      DEFAULT_H3_MODEL_PARAMETERS.primaryAudioSteps,
      1000,
    ),
  );
  return {
    primaryVideoSteps,
    primaryAudioSteps,
    secondarySchedulerSteps: validH3Step(
      content.secondarySchedulerSteps,
      DEFAULT_H3_MODEL_PARAMETERS.secondarySchedulerSteps,
      10000,
    ),
    primaryBrightness: validH3ColorAdjustment(
      content.primaryBrightness,
      DEFAULT_H3_MODEL_PARAMETERS.primaryBrightness,
    ),
    primaryContrast: validH3ColorAdjustment(
      content.primaryContrast,
      DEFAULT_H3_MODEL_PARAMETERS.primaryContrast,
    ),
    primarySaturation: validH3ColorAdjustment(
      content.primarySaturation,
      DEFAULT_H3_MODEL_PARAMETERS.primarySaturation,
    ),
    secondaryBrightness: validH3ColorAdjustment(
      content.secondaryBrightness,
      DEFAULT_H3_MODEL_PARAMETERS.secondaryBrightness,
    ),
    secondaryContrast: validH3ColorAdjustment(
      content.secondaryContrast,
      DEFAULT_H3_MODEL_PARAMETERS.secondaryContrast,
    ),
    secondarySaturation: validH3ColorAdjustment(
      content.secondarySaturation,
      DEFAULT_H3_MODEL_PARAMETERS.secondarySaturation,
    ),
  };
}

function h3ModelParametersFromStorage(): H3ModelParameters {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(H3_MODEL_PARAMETERS_STORAGE_KEY) ?? "null",
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return h3ModelParametersFromContent(parsed as JsonObject);
  } catch {
    return { ...DEFAULT_H3_MODEL_PARAMETERS };
  }
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

function primaryVideoStepsFromContent(content: JsonObject, fallback: number): number {
  return validH3Step(
    content.generationPrimaryVideoSteps ?? content.primaryVideoSteps,
    fallback,
    1000,
  );
}

function secondarySchedulerStepsFromContent(content: JsonObject, fallback: number): number {
  return validH3Step(
    content.generationSecondarySchedulerSteps ?? content.secondarySchedulerSteps,
    fallback,
    10000,
  );
}

function isMinimaxH3AssetName(value: string): boolean {
  const [directory, ...filenameParts] = value.trim().replace(/\//g, "\\").split("\\");
  return directory.toLocaleLowerCase() === "minimaxh3" && filenameParts.join("\\").trim().length > 0;
}

function h3DiffusionModelNameFromContent(content: JsonObject): string {
  const value = content.diffusionModelName ?? content.generationDiffusionModelName;
  return typeof value === "string" && isMinimaxH3AssetName(value)
    ? value
    : DEFAULT_H3_DIFFUSION_MODEL_NAME;
}

function sameH3DiffusionModelName(left: string, right: string): boolean {
  return left.trim().replace(/\//g, "\\").toLowerCase()
    === right.trim().replace(/\//g, "\\").toLowerCase();
}

function h3DiffusionModelDisplayName(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function sameH3LoraName(left: string, right: string): boolean {
  return left.trim().replace(/\//g, "\\").toLowerCase()
    === right.trim().replace(/\//g, "\\").toLowerCase();
}

function h3LoraNameFromContent(content: JsonObject): string {
  const value = content.generationLoraName ?? content.loraName;
  if (value === "") return "";
  return typeof value === "string" && isMinimaxH3AssetName(value)
    ? value
    : DEFAULT_H3_LORA_NAME;
}

function h3LoraStrengthFromContent(content: JsonObject): number {
  const value = content.generationLoraStrength ?? content.loraStrength;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2
    ? Math.round(value * 20) / 20
    : 1;
}

function h3LoraBypassedFromContent(content: JsonObject): boolean {
  return content.generationLoraBypassed === true || content.loraBypassed === true;
}

function h3SecondaryLoraNameFromContent(content: JsonObject): string {
  const value = content.generationSecondaryLoraName ?? content.secondaryLoraName;
  return typeof value === "string" && isMinimaxH3AssetName(value)
    ? value
    : "";
}

function h3SecondaryLoraStrengthFromContent(content: JsonObject): number {
  const value = content.generationSecondaryLoraStrength ?? content.secondaryLoraStrength;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2
    ? Math.round(value * 20) / 20
    : 1;
}

function h3SecondaryLoraBypassedFromContent(content: JsonObject): boolean {
  const value = content.generationSecondaryLoraBypassed ?? content.secondaryLoraBypassed;
  return typeof value === "boolean" ? value : !h3SecondaryLoraNameFromContent(content);
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
      loraBypassed: h3LoraBypassedFromContent(content),
      secondaryLoraName: h3SecondaryLoraNameFromContent(content),
      secondaryLoraStrength: h3SecondaryLoraStrengthFromContent(content),
      secondaryLoraBypassed: h3SecondaryLoraBypassedFromContent(content),
    };
  } catch {
    return {
      loraName: DEFAULT_H3_LORA_NAME,
      loraStrength: 1,
      loraBypassed: false,
      secondaryLoraName: "",
      secondaryLoraStrength: 1,
      secondaryLoraBypassed: true,
    };
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

function strictPromptTagsFromContent(content: JsonObject): boolean | undefined {
  const value = content.generationStrictPromptTags ?? content.strictPromptTags;
  return typeof value === "boolean" ? value : undefined;
}

function randomFixedSeed(): string {
  const values = crypto.getRandomValues(new Uint32Array(2));
  return ((BigInt(values[0]) << 32n) | BigInt(values[1])).toString();
}

function defaultVideoGenerationDefaults(): VideoGenerationDefaults {
  return {
    generationMode: "reference-to-video",
    workflowModuleId: "",
    workflowModuleRevision: "",
    generationDiffusionModelName: DEFAULT_H3_DIFFUSION_MODEL_NAME,
    generationDuration: 15,
    generationAspectRatio: "16:9",
    generationPrimaryResolution: 0.3,
    generationSecondaryResolution: 0.7,
    generationLoraName: "",
    generationLoraStrength: 1,
    generationLoraBypassed: false,
    generationSecondaryLoraName: "",
    generationSecondaryLoraStrength: 1,
    generationSecondaryLoraBypassed: false,
    generationPrimaryVideoSteps: 8,
    generationSecondarySchedulerSteps: 8,
    seedMode: "random",
    generationSeed: DEFAULT_GENERATION_SEED,
    generationStrictPromptTags: true,
    generationRefImageSize: "match",
  };
}

function videoGenerationDefaultsFromStorage(): VideoGenerationDefaults {
  const fallback = defaultVideoGenerationDefaults();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(VIDEO_GENERATION_DEFAULTS_STORAGE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const content = parsed as JsonObject;
    return {
      generationMode: videoGenerationModeFromContent(content),
      workflowModuleId: typeof content.workflowModuleId === "string" ? content.workflowModuleId : fallback.workflowModuleId,
      workflowModuleRevision: typeof content.workflowModuleRevision === "string"
        ? content.workflowModuleRevision
        : fallback.workflowModuleRevision,
      generationDiffusionModelName: h3DiffusionModelNameFromContent(content),
      generationDuration: videoDurationFromContent(content),
      generationAspectRatio: videoAspectRatioFromContent(content),
      generationPrimaryResolution: primaryVideoResolutionFromContent(content),
      generationSecondaryResolution: secondaryVideoResolutionFromContent(content),
      generationLoraName: h3LoraNameFromContent(content),
      generationLoraStrength: h3LoraStrengthFromContent(content),
      generationLoraBypassed: h3LoraBypassedFromContent(content),
      generationSecondaryLoraName: h3SecondaryLoraNameFromContent(content),
      generationSecondaryLoraStrength: h3SecondaryLoraStrengthFromContent(content),
      generationSecondaryLoraBypassed: h3SecondaryLoraBypassedFromContent(content),
      generationPrimaryVideoSteps: primaryVideoStepsFromContent(content, fallback.generationPrimaryVideoSteps),
      generationSecondarySchedulerSteps: secondarySchedulerStepsFromContent(
        content,
        fallback.generationSecondarySchedulerSteps,
      ),
      seedMode: seedModeFromContent(content),
      generationSeed: fixedSeedFromContent(content),
      generationStrictPromptTags: strictPromptTagsFromContent(content) ?? fallback.generationStrictPromptTags,
      generationRefImageSize: refImageSizeFromContent(content),
    };
  } catch {
    return fallback;
  }
}

function VideoGenerationLoraDefaultsFields({
  label,
  loraName,
  loraStrength,
  loraBypassed,
  steps,
  stepsLabel,
  h3LoraOptions,
  secondary = false,
  onChange,
}: {
  label: string;
  loraName: string;
  loraStrength: number;
  loraBypassed: boolean;
  steps: number;
  stepsLabel: string;
  h3LoraOptions: string[];
  secondary?: boolean;
  onChange: (patch: Partial<VideoGenerationDefaults>) => void;
}) {
  const selectedLoraAvailable = !loraName
    || h3LoraOptions.some((option) => sameH3LoraName(option, loraName));
  const prefix = secondary ? "二采" : "一采";
  return (
    <div className={`video-defaults-lora-fields ${secondary ? "is-secondary" : ""} ${loraBypassed ? "is-bypassed" : ""}`}>
      <div className="video-defaults-lora-model-row">
        <span>{label}</span>
        <SettingsSelect
          value={loraName}
          disabled={(!secondary && loraBypassed) || !h3LoraOptions.length}
          ariaLabel={`默认${prefix} LoRA`}
          placeholder={selectedLoraAvailable ? "未选择 LoRA" : "未找到 LoRA"}
          title={loraName || undefined}
          options={h3LoraOptions.map((lora) => ({
            value: lora,
            label: h3LoraDisplayName(lora),
            title: lora,
          }))}
          onChange={(nextLoraName) => onChange(secondary
            ? { generationSecondaryLoraName: nextLoraName }
            : { generationLoraName: nextLoraName })}
        />
        <button
          type="button"
          className="video-lora-bypass-switch video-defaults-lora-toggle"
          role="switch"
          aria-checked={!loraBypassed}
          aria-label={`启用默认${prefix} LoRA`}
          title={loraBypassed ? `启用${prefix} LoRA` : `关闭${prefix} LoRA`}
          onClick={() => onChange(secondary
            ? { generationSecondaryLoraBypassed: !loraBypassed }
            : { generationLoraBypassed: !loraBypassed })}
        ><span aria-hidden="true" /></button>
      </div>
      <div className="video-defaults-lora-controls-row">
        <span>权重</span>
        <input
          className="video-parameter-range"
          type="range"
          style={{ "--video-range-progress": `${(loraStrength / 2) * 100}%` } as CSSProperties}
          disabled={loraBypassed}
          min="0"
          max="2"
          step="0.05"
          value={loraStrength}
          onChange={(event) => onChange(secondary
            ? { generationSecondaryLoraStrength: Number(event.currentTarget.value) }
            : { generationLoraStrength: Number(event.currentTarget.value) })}
          aria-label={`默认${prefix} LoRA 权重`}
        />
        <CompactDecimalInput
          value={loraStrength}
          min={0}
          max={2}
          disabled={loraBypassed}
          ariaLabel={`手动输入默认${prefix} LoRA 权重`}
          onChange={(nextStrength) => onChange(secondary
            ? { generationSecondaryLoraStrength: nextStrength }
            : { generationLoraStrength: nextStrength })}
        />
        <span>{stepsLabel}</span>
        <CompactIntegerInput
          value={steps}
          min={1}
          max={secondary ? 10000 : 1000}
          ariaLabel={`默认${prefix}${stepsLabel}`}
          onChange={(nextSteps) => onChange(secondary
            ? { generationSecondarySchedulerSteps: nextSteps }
            : { generationPrimaryVideoSteps: nextSteps })}
        />
      </div>
    </div>
  );
}

function VideoGenerationDefaultsEditor({
  value,
  workflowModules,
  h3LoraOptions,
  onChange,
}: {
  value: VideoGenerationDefaults;
  workflowModules: WorkflowModuleRecord[];
  h3LoraOptions: string[];
  onChange: (patch: Partial<VideoGenerationDefaults>) => void;
}) {
  const availableModules = workflowModules.filter((module) => (
    !module.deletedAt && module.capability === "video-generation"
  ));
  return (
    <div className="video-node-body has-media video-defaults-editor">
      <section className="video-defaults-card video-defaults-basic-card">
      <div className="video-workflow-module-select">
        <span>生成方案</span>
        <SettingsSelect
          value={value.workflowModuleId}
          ariaLabel="新视频节点默认生成方案"
          placeholder={availableModules.length ? "请选择方案" : "未配置可用方案"}
          options={availableModules.map((module) => ({
            value: module.id,
            label: `${module.name} · ${module.revision}`,
          }))}
          onChange={(moduleId) => {
            const module = availableModules.find((candidate) => candidate.id === moduleId);
            if (!module) return;
            onChange({
              workflowModuleId: module.id,
              workflowModuleRevision: module.revision,
              generationMode: module.variant as VideoGenerationMode,
              generationDiffusionModelName: module.defaults.diffusionModelName,
              generationLoraName: module.defaults.loraName,
              generationLoraStrength: module.defaults.loraStrength,
              generationPrimaryVideoSteps: module.defaults.primaryVideoSteps,
              generationSecondarySchedulerSteps: module.defaults.secondarySchedulerSteps,
            });
          }}
        />
      </div>
      <div className="video-duration-control">
        <label className="video-duration-inline">
          <span>视频时长</span>
          <input
            className="video-parameter-range"
            type="range"
            style={{ "--video-range-progress": `${((value.generationDuration - 2) / 13) * 100}%` } as CSSProperties}
            min="2"
            max="15"
            step="1"
            value={value.generationDuration}
            onChange={(event) => onChange({ generationDuration: Number(event.currentTarget.value) })}
            aria-label="默认生成时长"
          />
          <output>{value.generationDuration} 秒</output>
        </label>
        <label className="video-aspect-ratio-inline video-defaults-aspect-ratio">
          <span className="video-aspect-ratio-label">画面比例</span>
          <SettingsSelect
            value={value.generationAspectRatio}
            ariaLabel="默认画面比例"
            options={VIDEO_ASPECT_RATIO_OPTIONS.map((option) => ({ value: option.value, label: option.value }))}
            onChange={(generationAspectRatio) => onChange({
              generationAspectRatio: generationAspectRatio as VideoAspectRatio,
            })}
          />
        </label>
      </div>
      <div className="video-resolution-pair" aria-label="默认一采和二采分辨率">
        {([
          ["一采大小", "generationPrimaryResolution", value.generationPrimaryResolution],
          ["二采大小", "generationSecondaryResolution", value.generationSecondaryResolution],
        ] as const).map(([label, key, resolution]) => (
          <label className="video-resolution-inline" key={key}>
            <span>{label}</span>
            <input
              className="video-parameter-range"
              type="range"
              style={{ "--video-range-progress": `${((resolution - 0.2) / 1.8) * 100}%` } as CSSProperties}
              min="0.2"
              max="2.0"
              step="0.1"
              value={resolution}
              onChange={(event) => onChange({ [key]: Number(event.currentTarget.value) })}
              aria-label={`默认${label}分辨率`}
            />
            <output>{resolution.toFixed(1)} MP</output>
          </label>
        ))}
      </div>
      </section>
      <section className="video-defaults-card video-defaults-sampling-card is-primary">
        <header>
          <div><strong>一采参数</strong></div>
        </header>
      <VideoGenerationLoraDefaultsFields
        label="LoRA 模型"
        loraName={value.generationLoraName}
        loraStrength={value.generationLoraStrength}
        loraBypassed={value.generationLoraBypassed}
        steps={value.generationPrimaryVideoSteps}
        stepsLabel="视频步数"
        h3LoraOptions={h3LoraOptions}
        onChange={onChange}
      />
      </section>
      <section className="video-defaults-card video-defaults-sampling-card is-secondary">
        <header>
          <div><strong>二采参数</strong></div>
        </header>
      <VideoGenerationLoraDefaultsFields
        label="LoRA 模型"
        loraName={value.generationSecondaryLoraName}
        loraStrength={value.generationSecondaryLoraStrength}
        loraBypassed={value.generationSecondaryLoraBypassed}
        steps={value.generationSecondarySchedulerSteps}
        stepsLabel="调度步数"
        h3LoraOptions={h3LoraOptions}
        secondary
        onChange={onChange}
      />
      </section>
      <div className="video-defaults-seed-row">
        <div className="video-seed-control">
          <span>生成种子</span>
          <div className="video-seed-mode" aria-label="默认种子模式">
            {(["random", "fixed"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={value.seedMode === mode ? "is-active" : ""}
                aria-pressed={value.seedMode === mode}
                onClick={() => onChange({ seedMode: mode })}
              >{mode === "random" ? "随机" : "固定"}</button>
            ))}
          </div>
          {value.seedMode === "fixed" ? (
            <div className="video-seed-fixed">
              <input
                className="video-seed-input"
                type="text"
                inputMode="numeric"
                maxLength={20}
                value={value.generationSeed}
                onChange={(event) => onChange({ generationSeed: event.currentTarget.value.replace(/\D/g, "") })}
                aria-label="默认固定种子"
                spellCheck={false}
              />
              <button type="button" className="video-seed-randomize" title="随机生成固定种子" aria-label="随机生成默认固定种子" onClick={() => onChange({ generationSeed: randomFixedSeed() })}>
                <Dices size={14} />
              </button>
            </div>
          ) : <span className="video-seed-hint">每次生成自动更换</span>}
        </div>
        <div className="strict-prompt-tags-control">
          <span>严格提示词</span>
          <button
            type="button"
            role="switch"
            aria-checked={value.generationStrictPromptTags}
            className="video-lora-bypass-switch video-defaults-lora-toggle"
            onClick={() => onChange({ generationStrictPromptTags: !value.generationStrictPromptTags })}
            title={value.generationStrictPromptTags ? "当前严格校验提示词素材标签" : "当前不严格校验提示词素材标签"}
            aria-label="启用严格提示词校验"
          ><span aria-hidden="true" /></button>
        </div>
      </div>
    </div>
  );
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

function activeTextInputFromContent(
  content: JsonObject,
  textInputs: NodeRecord[],
): NodeRecord | null {
  const orderedInputs = orderedNodeRecordsFromContent(content, "textInputOrder", textInputs);
  const activeId = typeof content.activeTextInputId === "string"
    ? content.activeTextInputId
    : "";
  return orderedInputs.find((input) => input.id === activeId) ?? orderedInputs[0] ?? null;
}

function promptDurationSecondsFromVersion(version: PromptVersionRecord | null): number | null {
  if (!version) return null;
  const override = version.durationOverrideSeconds;
  if (typeof override === "number" && Number.isInteger(override) && override >= 2 && override <= 15) {
    return override;
  }
  const recommended = version.generationOptions?.durationSeconds;
  return typeof recommended === "number" && Number.isInteger(recommended) && recommended >= 2 && recommended <= 15
    ? recommended
    : null;
}

function generationOptionsFromValue(value: unknown): { durationSeconds: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const durationSeconds = (value as JsonObject).durationSeconds;
  return typeof durationSeconds === "number"
    && Number.isInteger(durationSeconds)
    && durationSeconds >= 2
    && durationSeconds <= 15
    ? { durationSeconds }
    : null;
}

function durationOverrideSecondsFromValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= 15
    ? value
    : null;
}

function orderedNodeRecordsFromContent(
  content: JsonObject,
  orderKey: string,
  records: NodeRecord[],
): NodeRecord[] {
  const savedOrder = Array.isArray(content[orderKey])
    ? content[orderKey].filter((id): id is string => typeof id === "string")
    : [];
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const ordered = savedOrder
    .map((id) => recordsById.get(id))
    .filter((record): record is NodeRecord => Boolean(record));
  const orderedIds = new Set(ordered.map((record) => record.id));
  ordered.push(...records.filter((record) => !orderedIds.has(record.id)));
  return ordered;
}

function manualSavedPromptContentFromContent(content: JsonObject): JsonObject | null {
  const saved = content.manualSavedPromptContent;
  return saved && typeof saved === "object" && !Array.isArray(saved)
    ? saved as JsonObject
    : null;
}

function promptContentForExecution(content: JsonObject): JsonObject {
  return manualSavedPromptContentFromContent(content) ?? content;
}

function storyboardReferenceSelectionFromValue(
  value: unknown,
): { selection: StoryboardReferenceSelection | null; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { selection: null, error: "当前提示词缺少内部素材选择数据" };
  }
  const object = value as JsonObject;
  if (typeof object.sceneKey !== "string" || !object.sceneKey.trim()) {
    return { selection: null, error: "内部素材选择缺少 sceneKey" };
  }
  if (!Array.isArray(object.assets)) {
    return { selection: null, error: "内部素材选择缺少 assets 数组" };
  }

  const assets: StoryboardReferenceAsset[] = [];
  const sourceIds = new Set<string>();
  const counters: Record<StoryboardReferenceKind, number> = { image: 0, audio: 0, video: 0 };
  const prefixes: Record<StoryboardReferenceKind, string> = {
    image: "Picture",
    audio: "Audio",
    video: "Video",
  };
  const subjectLabels: string[] = [];
  for (const [index, rawAsset] of object.assets.entries()) {
    if (!rawAsset || typeof rawAsset !== "object" || Array.isArray(rawAsset)) {
      return { selection: null, error: `内部素材选择第 ${index + 1} 项无效` };
    }
    const asset = rawAsset as JsonObject;
    const kind = asset.kind;
    if (kind !== "image" && kind !== "audio" && kind !== "video") {
      return { selection: null, error: `内部素材选择第 ${index + 1} 项的 kind 无效` };
    }
    if (typeof asset.sourceId !== "string" || !asset.sourceId.trim()) {
      return { selection: null, error: `内部素材选择第 ${index + 1} 项缺少 sourceId` };
    }
    if (sourceIds.has(asset.sourceId)) {
      return { selection: null, error: `内部素材选择重复引用素材 ${asset.sourceId}` };
    }
    sourceIds.add(asset.sourceId);
    counters[kind] += 1;
    const expectedLabel = `${prefixes[kind]} ${counters[kind]}`;
    if (asset.label !== expectedLabel) {
      return {
        selection: null,
        error: `${prefixes[kind]} 标签必须连续编号，当前应为 ${expectedLabel}`,
      };
    }
    if (typeof asset.role !== "string" || !asset.role.trim()) {
      return { selection: null, error: `${expectedLabel} 缺少明确的 role` };
    }
    const subjectLabel = typeof asset.subjectLabel === "string"
      ? asset.subjectLabel.trim()
      : "";
    if (subjectLabel && !/^Subject [1-9]\d*$/.test(subjectLabel)) {
      return { selection: null, error: `${expectedLabel} 的 subjectLabel 格式无效` };
    }
    if (subjectLabel && !subjectLabels.includes(subjectLabel)) subjectLabels.push(subjectLabel);
    assets.push({
      sourceId: asset.sourceId,
      kind,
      label: expectedLabel,
      ...(subjectLabel ? { subjectLabel } : {}),
      role: asset.role.trim(),
    });
  }
  for (const [index, subjectLabel] of subjectLabels.entries()) {
    if (subjectLabel !== `Subject ${index + 1}`) {
      return { selection: null, error: "Subject 标签必须按首次出现顺序从 Subject 1 连续编号" };
    }
  }
  return {
    selection: { sceneKey: object.sceneKey.trim(), assets },
    error: "",
  };
}

function referenceSelectionFromContent(content: JsonObject): StoryboardReferenceSelection | null {
  return storyboardReferenceSelectionFromValue(content.referenceSelection).selection;
}

function storyboardPromptFields(record: NodeRecord | null): {
  prompt: string;
  information: string;
  referenceSelection: StoryboardReferenceSelection | null;
  durationSeconds: number | null;
} {
  if (!record) return { prompt: "", information: "", referenceSelection: null, durationSeconds: null };
  const content = promptContentForExecution(record.content);
  const activeVersion = activePromptVersionFromContent(content);
  return {
    prompt: activeVersion?.text ?? textFromContent(content),
    information: activeVersion?.information ?? informationFromContent(content),
    referenceSelection: activeVersion?.referenceSelection ?? referenceSelectionFromContent(content),
    durationSeconds: promptDurationSecondsFromVersion(activeVersion),
  };
}

function resolveStoryboardReferenceSelection(
  prompt: string,
  referenceSelection: StoryboardReferenceSelection | null,
  mediaInputs: NodeRecord[],
): StoryboardReferenceResolution {
  const parsed = storyboardReferenceSelectionFromValue(referenceSelection);
  if (!parsed.selection) {
    return {
      selection: null,
      selectedMedia: [],
      mappings: [],
      skippedCount: mediaInputs.length,
      error: parsed.error,
    };
  }
  if (!parsed.selection.assets.length) {
    return {
      selection: parsed.selection,
      selectedMedia: [],
      mappings: [],
      skippedCount: mediaInputs.length,
      error: "当前分镜没有选中参考素材，应改用普通文生视频节点",
    };
  }

  const candidatesById = new Map(mediaInputs.map((record) => [record.id, record]));
  const selectedMedia: NodeRecord[] = [];
  const mappings: StoryboardReferenceMapping[] = [];
  for (const asset of parsed.selection.assets) {
    const candidate = candidatesById.get(asset.sourceId);
    if (!candidate) {
      return {
        selection: parsed.selection,
        selectedMedia: [],
        mappings: [],
        skippedCount: mediaInputs.length,
        error: `${asset.label} 对应的候选素材已断开或不存在：${asset.sourceId}`,
      };
    }
    if (candidate.kind !== asset.kind) {
      return {
        selection: parsed.selection,
        selectedMedia: [],
        mappings: [],
        skippedCount: mediaInputs.length,
        error: `${asset.label} 的实际素材类型是 ${candidate.kind}，与内部选择的 ${asset.kind} 不一致`,
      };
    }
    const assetPath = typeof candidate.content.assetPath === "string"
      ? candidate.content.assetPath.trim()
      : "";
    if (!assetPath) {
      return {
        selection: parsed.selection,
        selectedMedia: [],
        mappings: [],
        skippedCount: mediaInputs.length,
        error: `${asset.label} 对应素材没有可提交的本地文件路径`,
      };
    }
    selectedMedia.push(candidate);
    mappings.push({ ...asset, title: candidate.title || candidate.id });
  }

  const imageCount = parsed.selection.assets.filter((asset) => asset.kind === "image").length;
  const audioCount = parsed.selection.assets.filter((asset) => asset.kind === "audio").length;
  const videoCount = parsed.selection.assets.filter((asset) => asset.kind === "video").length;
  if (imageCount > 9) {
    return { selection: parsed.selection, selectedMedia: [], mappings: [], skippedCount: mediaInputs.length, error: `当前分镜选中了 ${imageCount} 张图片，单次最多 9 张` };
  }
  if (audioCount > 2) {
    return { selection: parsed.selection, selectedMedia: [], mappings: [], skippedCount: mediaInputs.length, error: `当前分镜选中了 ${audioCount} 个音频，单次最多 2 个` };
  }
  if (videoCount > 1) {
    return { selection: parsed.selection, selectedMedia: [], mappings: [], skippedCount: mediaInputs.length, error: `当前分镜选中了 ${videoCount} 个视频，单次最多 1 个` };
  }
  if (videoCount) {
    return { selection: parsed.selection, selectedMedia: [], mappings, skippedCount: mediaInputs.length, error: "当前 H3 工作流适配器尚未配置视频参考输入；候选视频可以保留，但本次不能选中提交" };
  }

  const promptLabels = new Set<string>();
  for (const match of prompt.matchAll(/<(Picture|Audio|Video|Subject)\s+([1-9]\d*)>/g)) {
    promptLabels.add(`${match[1]} ${match[2]}`);
  }
  const assetLabels = new Set(parsed.selection.assets.map((asset) => asset.label));
  const subjectLabelSet = new Set(
    parsed.selection.assets.flatMap((asset) => asset.subjectLabel ? [asset.subjectLabel] : []),
  );
  for (const label of [...assetLabels, ...subjectLabelSet]) {
    if (!promptLabels.has(label)) {
      return { selection: parsed.selection, selectedMedia: [], mappings, skippedCount: mediaInputs.length, error: `英文提示词缺少素材标签 <${label}>` };
    }
  }
  for (const label of promptLabels) {
    const allowed = label.startsWith("Subject ") ? subjectLabelSet : assetLabels;
    if (!allowed.has(label)) {
      return { selection: parsed.selection, selectedMedia: [], mappings, skippedCount: mediaInputs.length, error: `英文提示词引用了内部素材选择中不存在的标签 <${label}>` };
    }
  }

  return {
    selection: parsed.selection,
    selectedMedia,
    mappings,
    skippedCount: Math.max(0, mediaInputs.length - selectedMedia.length),
    error: "",
  };
}

function storyboardReferenceCandidateCatalog(
  generatorId: string,
  mediaInputs: NodeRecord[],
): string {
  return JSON.stringify({
    schema: "infinite-canvas-h3-candidate-catalog/v1",
    generatorId,
    assets: mediaInputs.map((record, index) => ({
      sourceId: record.id,
      kind: record.kind,
      globalOrder: index + 1,
      title: record.title || record.id,
      semanticDescription: materialNoteFromContent(record.content).trim(),
    })),
  }, null, 2);
}

function h3ReferenceAssetCatalog(
  generatorId: string,
  mediaInputs: NodeRecord[],
): string {
  const referenceCounts: Record<"image" | "audio" | "video", number> = {
    image: 0,
    audio: 0,
    video: 0,
  };
  const labelPrefixes: Record<"image" | "audio" | "video", string> = {
    image: "Picture",
    audio: "Audio",
    video: "Video",
  };
  const limits = { images: 9, audios: 3, videos: 1 };
  const assetCounts = { images: 0, audios: 0, videos: 0 };

  const assets = mediaInputs.map((record, index) => {
    const kind = record.kind as "image" | "audio" | "video";
    referenceCounts[kind] += 1;
    if (kind === "image") assetCounts.images += 1;
    if (kind === "audio") assetCounts.audios += 1;
    if (kind === "video") assetCounts.videos += 1;
    return {
      sourceId: record.id,
      kind,
      globalOrder: index + 1,
      referenceLabel: `${labelPrefixes[kind]} ${referenceCounts[kind]}`,
      title: record.title || record.id,
      semanticDescription: materialNoteFromContent(record.content).trim(),
      required: true,
    };
  });

  return JSON.stringify({
    schema: "infinite-canvas-h3-reference-assets/v1",
    generatorId,
    route: "reference-to-video",
    assetPolicy: "all-listed-assets-required",
    limits,
    assetCounts,
    isWithinLimits: assetCounts.images <= limits.images
      && assetCounts.audios <= limits.audios
      && assetCounts.videos <= limits.videos,
    assets,
  }, null, 2);
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
  const activeTextInput = activeTextInputFromContent(content, textInputs);

  if (content.storyboardReferenceCompiler === true) {
    if (mode !== "reference-to-video") {
      return { valid: false, message: "分镜联动节点只支持全能参考生成方案" };
    }
    if (!textInputs.length || !activeTextInput) {
      return { valid: false, message: "分镜联动节点至少需要连接一个带素材选择数据的提示词节点" };
    }
    const fields = storyboardPromptFields(activeTextInput);
    if (!fields.prompt.trim()) {
      return { valid: false, message: "当前选中的文字节点内容为空，请先填写" };
    }
    if (fields.durationSeconds === null) {
      return { valid: false, message: "当前分镜提示词尚未设置时长，请在生成提示词节点中填写 2–15 秒" };
    }
    const selection = resolveStoryboardReferenceSelection(
      fields.prompt,
      fields.referenceSelection,
      mediaInputs,
    );
    if (selection.error) return { valid: false, message: selection.error };
    const selectedImages = selection.mappings.filter((asset) => asset.kind === "image").length;
    const selectedAudios = selection.mappings.filter((asset) => asset.kind === "audio").length;
    return {
      valid: true,
      message: `${selection.selection?.sceneKey ?? "当前分镜"} 检查通过：提交 ${selectedImages} 图、${selectedAudios} 音频，屏蔽 ${selection.skippedCount} 项`,
    };
  }

  if (mode === "text-to-video") {
    if (mediaInputs.length) {
      return { valid: false, message: "文生视频只允许连接文字，不能包含图片、音频或视频" };
    }
    if (!textInputs.length) {
      return { valid: false, message: "文生视频至少需要连接一个文字节点" };
    }
    if (!activeTextInput || !textFromContent(activeTextInput.content).trim()) {
      return { valid: false, message: "当前选中的文字节点内容为空，请先填写" };
    }
    return { valid: true, message: "文生视频条件检查通过" };
  }

  if (mode === "first-last-frame") {
    if (audios.length || videos.length) {
      return { valid: false, message: "首尾帧模式不能接入音频或视频" };
    }
    if (images.length !== 2) {
      return {
        valid: false,
        message: `首尾帧模式必须接入两张图片（首帧和尾帧），当前已接入 ${images.length} 张`,
      };
    }
    const roles = images.map((image, index) => frameRoleFromContent(content, image.id, index));
    if (roles[0] === roles[1]) {
      return { valid: false, message: "两张图片必须分别指定为首帧和尾帧" };
    }
    return { valid: true, message: "首尾帧条件检查通过" };
  }

  if (mode === "image-to-video") {
    if (audios.length || videos.length) {
      return { valid: false, message: "图生视频模式不能接入音频或视频参考" };
    }
    if (images.length !== 1) {
      return {
        valid: false,
        message: `图生视频模式必须接入一张首帧图片，当前已接入 ${images.length} 张`,
      };
    }
    return { valid: true, message: "图生视频条件检查通过" };
  }

  if (mode === "last-frame-to-video") {
    if (audios.length || videos.length) {
      return { valid: false, message: "尾帧生视频模式不能接入音频或视频参考" };
    }
    if (images.length !== 1) {
      return {
        valid: false,
        message: `尾帧生视频模式必须接入一张尾帧图片，当前已接入 ${images.length} 张`,
      };
    }
    return { valid: true, message: "尾帧生视频条件检查通过" };
  }

  if (!mediaInputs.length) {
    return { valid: false, message: "参考生视频至少需要一个图片或音频素材" };
  }
  if (!textInputs.length) {
    return { valid: false, message: "当前参考工作流至少需要连接一个文字提示词节点" };
  }
  if (!activeTextInput || !textFromContent(activeTextInput.content).trim()) {
    return { valid: false, message: "当前选中的文字节点内容为空，请先填写" };
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

function informationFromContent(content: JsonObject): string {
  return typeof content.information === "string" ? content.information : "";
}

function materialNoteFromContent(content: JsonObject): string {
  return typeof content.materialNote === "string" ? content.materialNote : "";
}

function promptVersionsFromContent(content: JsonObject): PromptVersionRecord[] {
  if (!isContentIterationContent(content) || !Array.isArray(content.promptVersions)) return [];
  return content.promptVersions.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const version = value as JsonObject;
    if (
      typeof version.id !== "string"
      || typeof version.label !== "string"
      || typeof version.text !== "string"
    ) return [];
    const referenceSelection = storyboardReferenceSelectionFromValue(
      version.referenceSelection,
    ).selection;
    const generationOptions = generationOptionsFromValue(version.generationOptions);
    const durationOverrideSeconds = durationOverrideSecondsFromValue(version.durationOverrideSeconds);
    return [{
      id: version.id,
      label: version.label,
      title: typeof version.title === "string" ? version.title : version.label,
      text: version.text,
      information: typeof version.information === "string" ? version.information : "",
      ...(referenceSelection ? { referenceSelection } : {}),
      ...(generationOptions ? { generationOptions } : {}),
      ...(durationOverrideSeconds !== null ? { durationOverrideSeconds } : {}),
      createdAt: typeof version.createdAt === "string" ? version.createdAt : "",
      ...(typeof version.requestId === "string" ? { requestId: version.requestId } : {}),
      ...(typeof version.source === "string" ? { source: version.source } : {}),
      ...(Array.isArray(version.derivedFrom)
        ? {
            derivedFrom: version.derivedFrom.flatMap((source) => {
              if (!source || typeof source !== "object" || Array.isArray(source)) return [];
              const item = source as JsonObject;
              return typeof item.nodeId === "string" && typeof item.versionId === "string"
                ? [{
                    nodeId: item.nodeId,
                    versionId: item.versionId,
                    versionLabel: typeof item.versionLabel === "string" ? item.versionLabel : "",
                  }]
                : [];
            }),
          }
        : {}),
    }];
  });
}

function activePromptVersionFromContent(content: JsonObject): PromptVersionRecord | null {
  const versions = promptVersionsFromContent(content);
  const activeId = typeof content.activePromptVersionId === "string"
    ? content.activePromptVersionId
    : "";
  return versions.find((version) => version.id === activeId) ?? versions[0] ?? null;
}

function activePromptVersionLabelFromContent(content: JsonObject): string {
  return activePromptVersionFromContent(content)?.label ?? "";
}

function nextPromptVersionLabel(versions: PromptVersionRecord[]): string {
  const nextIndex = versions.reduce((highest, version) => {
    const parsed = Number.parseInt(version.label.replace(/^v/i, ""), 10);
    return Number.isFinite(parsed) ? Math.max(highest, parsed) : highest;
  }, 0) + 1;
  return `v${nextIndex}`;
}

function toFlowEdge(edge: EdgeRecord): Edge {
  return {
    id: edge.id,
    source: edge.sourceNodeId,
    target: edge.targetNodeId,
    type: "canvasEdge",
    className: edge.kind === "content-derivation" || edge.kind === "scene-branch"
      ? "canvas-edge is-content-derivation"
      : "canvas-edge",
    animated: false,
    data: { record: edge },
  };
}

// React Flow resolves completed edges at the outside edge of the 16px handle,
// while the handle's visual center sits on the node border. Pull the rendered
// path back by the handle radius so lines visibly meet the node frame.
const NODE_HANDLE_EDGE_INSET = 8;

function edgeEndpointAtNodeBorder(
  x: number,
  y: number,
  position: Position,
): { x: number; y: number } {
  switch (position) {
    case Position.Left:
      return { x: x + NODE_HANDLE_EDGE_INSET, y };
    case Position.Right:
      return { x: x - NODE_HANDLE_EDGE_INSET, y };
    case Position.Top:
      return { x, y: y + NODE_HANDLE_EDGE_INSET };
    case Position.Bottom:
      return { x, y: y - NODE_HANDLE_EDGE_INSET };
  }
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
  const [isDisconnectVisible, setDisconnectVisible] = useState(false);
  const disconnectHideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sourcePoint = edgeEndpointAtNodeBorder(sourceX, sourceY, sourcePosition);
  const targetPoint = edgeEndpointAtNodeBorder(targetX, targetY, targetPosition);
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX: sourcePoint.x,
    sourceY: sourcePoint.y,
    sourcePosition,
    targetX: targetPoint.x,
    targetY: targetPoint.y,
    targetPosition,
  });
  const onDisconnect = (data as CanvasEdgeData | undefined)?.onDisconnect;
  const edgeKind = (data as CanvasEdgeData | undefined)?.record?.kind;
  const disconnect = () => onDisconnect?.(id);
  const showDisconnect = () => {
    if (disconnectHideTimer.current !== undefined) {
      window.clearTimeout(disconnectHideTimer.current);
      disconnectHideTimer.current = undefined;
    }
    setDisconnectVisible(true);
  };
  const hideDisconnect = () => {
    if (disconnectHideTimer.current !== undefined) window.clearTimeout(disconnectHideTimer.current);
    disconnectHideTimer.current = window.setTimeout(() => {
      disconnectHideTimer.current = undefined;
      setDisconnectVisible(false);
    }, 100);
  };

  useEffect(() => () => {
    if (disconnectHideTimer.current !== undefined) window.clearTimeout(disconnectHideTimer.current);
  }, []);

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={style}
        className={`canvas-edge ${edgeKind === "content-derivation" || edgeKind === "scene-branch" ? "is-content-derivation" : ""}`}
        interactionWidth={24}
      />
      {onDisconnect && (
        <EdgeLabelRenderer>
          <div
            className="canvas-edge-disconnect-hit-area nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onPointerEnter={showDisconnect}
            onPointerLeave={hideDisconnect}
          >
            <button
              type="button"
              className={`canvas-edge-disconnect ${isDisconnectVisible ? "is-visible" : ""}`}
              aria-label="断开连线"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                disconnect();
              }}
            >
              <X size={13} strokeWidth={1.7} aria-hidden="true" />
            </button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { canvasEdge: CanvasEdge };

function CanvasNode({ id, data, selected }: NodeProps<CanvasFlowNode>) {
  const { getZoom, setNodes } = useReactFlow<CanvasFlowNode, Edge>();
  const ctrlSelectionPointerId = useRef<number | null>(null);
  const {
    record,
    matched,
    relationHighlighted,
    relationPromptVersionLabel,
    activeTaskCount,
    inputCount,
    outputCount,
    contentParents,
    mediaInputs,
    textInputCount,
    textInputs,
    promptNodeTitle,
    h3LoraOptions,
    workflowModules,
    onH3LoraPreferenceChange,
    onChange,
    onSaveNode,
    onMarkGeneratedVideoFullyPlayed,
    onExecutionCheck,
    onExecute,
    onBatchExecute,
    onSecondarySample,
    onConfigureSecondarySample,
    onRegenerateVideo,
    onConfigureRegenerateVideo,
    onLocatePrompt,
    onCancelExecution,
    onRevealGeneratedVideo,
    onRemoveInput,
    onActivateTextInput,
    onDeletePromptVersion,
    onResizeImage,
    onOpenFolder,
    onCopy,
  } = data;
  const [copied, setCopied] = useState(false);
  const [copiedMarkdownTarget, setCopiedMarkdownTarget] = useState<string | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);
  const [errorCopied, setErrorCopied] = useState(false);
  const [referenceCatalogCopied, setReferenceCatalogCopied] = useState(false);
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(record.title);
  const [materialNoteDraft, setMaterialNoteDraft] = useState(() => materialNoteFromContent(record.content));
  const [materialNoteFocused, setMaterialNoteFocused] = useState(false);
  const [titleOverflowing, setTitleOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [previewColorMenuOpen, setPreviewColorMenuOpen] = useState(false);
  const [aspectRatioMenuOpen, setAspectRatioMenuOpen] = useState(false);
  const [workflowModuleMenuOpen, setWorkflowModuleMenuOpen] = useState(false);
  const [loraMenuOpen, setLoraMenuOpen] = useState(false);
  const [secondaryLoraMenuOpen, setSecondaryLoraMenuOpen] = useState(false);
  const [promptVersionMenuOpen, setPromptVersionMenuOpen] = useState(false);
  const [contentTypeMenuOpen, setContentTypeMenuOpen] = useState(false);
  const [editingPromptVersionTitleId, setEditingPromptVersionTitleId] = useState<string | null>(null);
  const [promptVersionTitleDraft, setPromptVersionTitleDraft] = useState("");
  const [textInformationOpen, setTextInformationOpen] = useState(false);
  // Editing is the default in the compact node, regardless of where its
  // content came from. Markdown is an explicit user-selected preview mode.
  const [nodeMarkdownPreview, setNodeMarkdownPreview] = useState(false);
  const [informationMarkdownPreview, setInformationMarkdownPreview] = useState(true);
  // Content iteration is read first in the expanded dialog; its editor remains
  // one explicit toggle away. Compact nodes stay editing-first.
  const [expandedTextMarkdownPreview, setExpandedTextMarkdownPreview] = useState(
    () => isContentIterationContent(record.content),
  );
  const [expandedInformationMarkdownPreview, setExpandedInformationMarkdownPreview] = useState(true);
  const [expandedInformationHidden, setExpandedInformationHidden] = useState(false);
  const [connectedTextMarkdownPreview, setConnectedTextMarkdownPreview] = useState(true);
  const [connectedInformationMarkdownPreview, setConnectedInformationMarkdownPreview] = useState(true);
  const [connectedInformationHidden, setConnectedInformationHidden] = useState(false);
  const [generatedInfoOpen, setGeneratedInfoOpen] = useState(false);
  const [generatedPromptDialogOpen, setGeneratedPromptDialogOpen] = useState(false);
  const [imageResizeDialogOpen, setImageResizeDialogOpen] = useState(false);
  const [imageResizeDraft, setImageResizeDraft] = useState(() => String(imageResizeDefaultFromStorage()));
  const [imageResizeError, setImageResizeError] = useState("");
  const [imageResizing, setImageResizing] = useState(false);
  const [savingTextNodeId, setSavingTextNodeId] = useState<string | null>(null);
  const [manualSaveStateByNodeId, setManualSaveStateByNodeId] = useState<Record<string, {
    savedText: string;
    savedInformation: string;
    currentText: string;
    currentInformation: string;
  }>>({});
  const [manualSaveVersionTitleStateByKey, setManualSaveVersionTitleStateByKey] = useState<Record<string, {
    savedTitle: string;
    currentTitle: string;
  }>>({});
  const [connectedTextEditor, setConnectedTextEditor] = useState<{
    id: string;
    title: string;
    baseTitle: string;
    content: JsonObject;
    text: string;
    information: string;
  } | null>(null);
  const [editorExitConfirmation, setEditorExitConfirmation] = useState<{
    target: "expanded" | "connected";
    nodeId: string;
    versionId?: string;
  } | null>(null);
  const [savingEditorExit, setSavingEditorExit] = useState(false);
  const [draggedMediaId, setDraggedMediaId] = useState<string | null>(null);
  const [dragOverMediaId, setDragOverMediaId] = useState<string | null>(null);
  const [draggedTextId, setDraggedTextId] = useState<string | null>(null);
  const [dragOverTextId, setDragOverTextId] = useState<string | null>(null);
  const textRowDragRef = useRef<{
    pointerId: number;
    inputId: string;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const suppressTextInputClickRef = useRef(false);
  const [removingMediaId, setRemovingMediaId] = useState<string | null>(null);
  const [clearingImages, setClearingImages] = useState(false);
  const [imageIdsPendingClear, setImageIdsPendingClear] = useState<string[] | null>(null);
  const [clearingTexts, setClearingTexts] = useState(false);
  const [textIdsPendingClear, setTextIdsPendingClear] = useState<string[] | null>(null);
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState(() => textFromContent(record.content));
  const [informationDraft, setInformationDraft] = useState(() => informationFromContent(record.content));
  const [textEditorFocused, setTextEditorFocused] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleDisplayRef = useRef<HTMLSpanElement>(null);
  const previewColorControlRef = useRef<HTMLDivElement>(null);
  const aspectRatioControlRef = useRef<HTMLDivElement>(null);
  const workflowModuleControlRef = useRef<HTMLDivElement>(null);
  const loraControlRef = useRef<HTMLDivElement>(null);
  const secondaryLoraControlRef = useRef<HTMLDivElement>(null);
  const promptVersionControlRef = useRef<HTMLDivElement>(null);
  const contentTypeControlRef = useRef<HTMLDivElement>(null);
  const textInformationRef = useRef<HTMLDivElement>(null);
  const generatedInfoRef = useRef<HTMLDivElement>(null);
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
  const isText = record.kind === "text";
  const isContentIterationNode = isText && isContentIterationContent(record.content);
  const contentNodeType = contentNodeTypeFromContent(record.content);
  const allPromptVersions = isContentIterationNode ? promptVersionsFromContent(record.content) : [];
  // The type remains adjustable while there is only one version. Once history
  // branches beyond v1, keep the node-level type stable across every version.
  const isContentTypeLocked = isContentIterationNode && allPromptVersions.length > 1;
  const storedActivePromptVersion = isContentIterationNode
    ? activePromptVersionFromContent(record.content)
    : null;
  const activeParentVersions = contentParents.flatMap((parent) => {
    const version = activePromptVersionFromContent(parent.content);
    return version ? [{ nodeId: parent.id, versionId: version.id, versionLabel: version.label }] : [];
  });
  // 上游版本仅作为新版本的来源快照和历史追溯信息，不能决定下游版本的可见性。
  // 否则上游的局部更新会隐藏仍有效、但关联旧上游版本的下游内容。
  const promptVersions = allPromptVersions;
  const activePromptVersion = promptVersions.find(
    (version) => version.id === storedActivePromptVersion?.id,
  ) ?? promptVersions[promptVersions.length - 1] ?? null;
  const savedText = isContentIterationNode
    ? activePromptVersion?.text ?? ""
    : textFromContent(record.content);
  const contentSourceLabel = (source: { nodeId: string; versionLabel: string }) => {
    const parent = contentParents.find((candidate) => candidate.id === source.nodeId);
    const parentType = parent
      ? contentNodeTypeLabel(contentNodeTypeFromContent(parent.content))
      : "上游内容";
    const parentTitle = parent?.title.trim();
    return `${parentType}${parentTitle ? `《${parentTitle}》` : ""} ${source.versionLabel || "未命名版本"}`;
  };
  const versionProvenance = (version: PromptVersionRecord | null | undefined) => {
    const sources = (version?.derivedFrom ?? []).filter((source) => (
      contentParents.some((parent) => parent.id === source.nodeId)
    ));
    return sources.length
      ? sources.map(contentSourceLabel).join("、")
      : "未记录上游版本";
  };
  const nextVersionProvenance = activeParentVersions.length
    ? activeParentVersions.map(contentSourceLabel).join("、")
    : "无上游内容";
  const connectedPromptVersions = connectedTextEditor && isContentIterationContent(connectedTextEditor.content)
    ? promptVersionsFromContent(connectedTextEditor.content)
    : [];
  const connectedActivePromptVersion = connectedTextEditor && isContentIterationContent(connectedTextEditor.content)
    ? activePromptVersionFromContent(connectedTextEditor.content)
    : null;
  const savedInformation = isContentIterationNode
    ? activePromptVersion?.information ?? ""
    : informationFromContent(record.content);
  const bestPromptVersionId = typeof record.content.bestPromptVersionId === "string"
    ? record.content.bestPromptVersionId
    : "";
  const isNote = record.kind === "note";
  const isImage = record.kind === "image";
  const isAudioAsset = record.kind === "audio";
  const isVideoAsset = record.kind === "video";
  const isReferenceAsset = isImage || isAudioAsset || isVideoAsset;
  const isVideoGeneration = record.kind === "video-generation";
  const isStoryboardReferenceCompiler = isVideoGeneration
    && record.content.storyboardReferenceCompiler === true;
  const isGeneratedVideo = record.kind === "generated-video";
  const isFolder = record.kind === "folder";
  const sourceLabel = record.source === "manual"
    ? "手动创建"
    : record.source === "image-resize"
      ? "尺寸调整"
      : isFolder
        ? "子画布目录"
      : record.source;
  const isSecondaryPreview = isGeneratedVideo
    && typeof record.content.sourcePreviewId === "string";
  const supportsPreviewColor = isText || isNote || (
    isGeneratedVideo
    && typeof record.content.videoUrl === "string"
    && Boolean(record.content.videoUrl)
  );
  const storedPreviewThemeColor = previewThemeColorFromContent(record.content);
  const previewThemeColor = isNote && storedPreviewThemeColor === VIDEO_PREVIEW_DEFAULT_COLOR
    ? null
    : storedPreviewThemeColor;
  const previewDisplayColor = previewThemeColor
    ?? (isNote
      ? NOTE_DEFAULT_COLOR
      : isSecondaryPreview
        ? VIDEO_PREVIEW_SECONDARY_COLOR
        : VIDEO_PREVIEW_DEFAULT_COLOR);
  const usesDefaultPreviewTheme = !isNote
    && previewDisplayColor === VIDEO_PREVIEW_DEFAULT_COLOR;
  const usesSecondaryGreenTheme = isGeneratedVideo
    && previewDisplayColor === VIDEO_PREVIEW_SECONDARY_COLOR;
  const usesCustomPreviewTheme = supportsPreviewColor
    && (Boolean(previewThemeColor) || isNote)
    && !usesDefaultPreviewTheme
    && !usesSecondaryGreenTheme;
  const previewHighlightColor = VIDEO_PREVIEW_COLOR_PRESETS.find(
    (preset) => preset.value === previewDisplayColor,
  )?.highlight ?? previewDisplayColor;
  const previewColorPresets = isNote
    ? [
        {
          ...VIDEO_PREVIEW_COLOR_PRESETS.find((preset) => preset.value === NOTE_DEFAULT_COLOR)!,
          label: "默认颜色",
        },
        ...VIDEO_PREVIEW_COLOR_PRESETS.filter((preset) => (
          preset.value !== VIDEO_PREVIEW_DEFAULT_COLOR
          && preset.value !== NOTE_DEFAULT_COLOR
        )),
      ]
    : VIDEO_PREVIEW_COLOR_PRESETS;
  const previewThemeStyle = supportsPreviewColor
    ? {
        "--preview-theme-color": previewDisplayColor,
        "--preview-highlight-color": previewHighlightColor,
      } as CSSProperties
    : undefined;
  const videoGenerationMode = videoGenerationModeFromContent(record.content);
  const availableWorkflowModules = workflowModules.filter(
    (module) => !module.deletedAt
      && module.capability === "video-generation"
      && (!isStoryboardReferenceCompiler || module.variant === "reference-to-video"),
  );
  const configuredWorkflowModuleId = typeof record.content.workflowModuleId === "string"
    ? record.content.workflowModuleId
    : "";
  const selectedNodeWorkflowModule = availableWorkflowModules.find(
    (module) => module.id === configuredWorkflowModuleId,
  ) ?? null;
  const videoDuration = videoDurationFromContent(record.content);
  const videoAspectRatio = videoAspectRatioFromContent(record.content);
  const refImageSize = refImageSizeFromContent(record.content);
  const videoGenerationFullHeight = isVideoGeneration
    ? videoGenerationAutoHeight(
        mediaInputs.map((input) => input.kind),
        textInputs.length,
        record.width,
        isStoryboardReferenceCompiler,
      )
    : record.height;
  const activeTextInputId = activeTextInputFromContent(record.content, textInputs)?.id ?? "";
  const primaryVideoResolution = primaryVideoResolutionFromContent(record.content);
  const secondaryVideoResolution = secondaryVideoResolutionFromContent(record.content);
  const primaryVideoSteps = primaryVideoStepsFromContent(
    record.content,
    selectedNodeWorkflowModule?.defaults.primaryVideoSteps ?? DEFAULT_H3_MODEL_PARAMETERS.primaryVideoSteps,
  );
  const secondarySchedulerSteps = secondarySchedulerStepsFromContent(
    record.content,
    selectedNodeWorkflowModule?.defaults.secondarySchedulerSteps
      ?? DEFAULT_H3_MODEL_PARAMETERS.secondarySchedulerSteps,
  );
  const primaryVideoStepsMaximum = selectedNodeWorkflowModule?.defaults.primaryAudioSteps ?? 1000;
  const h3LoraName = h3LoraNameFromContent(record.content);
  const h3LoraStrength = h3LoraStrengthFromContent(record.content);
  const h3LoraBypassed = h3LoraBypassedFromContent(record.content);
  const availableH3LoraName = h3LoraOptions.find((lora) => sameH3LoraName(lora, h3LoraName));
  const h3SecondaryLoraName = h3SecondaryLoraNameFromContent(record.content);
  const h3SecondaryLoraStrength = h3SecondaryLoraStrengthFromContent(record.content);
  const h3SecondaryLoraBypassed = h3SecondaryLoraBypassedFromContent(record.content);
  const availableH3SecondaryLoraName = h3LoraOptions.find(
    (lora) => sameH3LoraName(lora, h3SecondaryLoraName),
  );
  const selectableH3Loras = h3LoraOptions;
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
  const naturalWidth = typeof record.content.naturalWidth === "number"
    && Number.isFinite(record.content.naturalWidth)
    && record.content.naturalWidth > 0
    ? Math.round(record.content.naturalWidth)
    : null;
  const naturalHeight = typeof record.content.naturalHeight === "number"
    && Number.isFinite(record.content.naturalHeight)
    && record.content.naturalHeight > 0
    ? Math.round(record.content.naturalHeight)
    : null;
  const imageDimensionLabel = naturalWidth && naturalHeight
    ? `${naturalWidth} × ${naturalHeight}`
    : "读取尺寸…";
  const savedAspectRatio = typeof record.content.aspectRatio === "number"
    ? record.content.aspectRatio
    : null;
  const videoChromeHeight = isGeneratedVideo
    ? GENERATED_VIDEO_FOOTER_HEIGHT
    : isImage
      ? IMAGE_NODE_CHROME_HEIGHT
      : MEDIA_NODE_CHROME_HEIGHT;
  const generatedVideoUrl = cacheBustedGeneratedVideoUrl(record.content);
  const isGenerationPlaceholder = isGeneratedVideo
    && record.content.generationPlaceholder === true
    && !generatedVideoUrl;
  const placeholderActive = record.content.status === "running"
    || record.content.status === "cancelling";
  const generatedVideoSeed = typeof record.content.seed === "string"
    ? record.content.seed
    : "";
  const generatedVideoSnapshot = isGeneratedVideo
    ? generationSnapshotFromContent(record.content)
    : null;
  const generatedVideoPrompt = generatedVideoSnapshot?.prompt ?? "";
  const generatedVideoPromptInformation = generatedVideoSnapshot?.promptInformation ?? "";
  const generatedVideoPromptBaseTitle = promptNodeTitle
    || generatedVideoSnapshot?.promptNodeTitle
    || "";
  const generatedVideoPromptTitle = generatedVideoSnapshot?.promptVersionLabel
    ? `${generatedVideoPromptBaseTitle || "提示词"} · ${generatedVideoSnapshot.promptVersionLabel}`
    : generatedVideoPromptBaseTitle;
  const isUnplayedGeneratedVideo = isGeneratedVideo
    && Boolean(generatedVideoUrl)
    && record.content.hasBeenPlayed === false;
  const executionRunning = activeTaskCount > 0;
  const executionCancelling = record.content.status === "cancelling";
  const executionProgress = typeof record.content.executionProgress === "number"
    && Number.isFinite(record.content.executionProgress)
    ? Math.max(0, Math.min(100, record.content.executionProgress))
    : null;
  const generatedVideoFooterStatus = isGenerationPlaceholder
    ? placeholderActive ? "处理中" : "未完成"
    : `${formattedGenerationElapsed(record.content)}${generatedVideoSnapshot
      ? ` / ${generatedVideoSnapshot.durationSeconds}秒`
      : ""}`;
  const preservesGeneratedVideoToolbarCtrlClick = (target: EventTarget | null) => (
    isGeneratedVideo
    && target instanceof Element
    && Boolean(target.closest(".generated-video-footer button"))
  );
  const mediaInputGroups = [
    { kind: "image", label: "图片", inputs: mediaInputs.filter((input) => input.kind === "image") },
    { kind: "audio", label: "音频", inputs: mediaInputs.filter((input) => input.kind === "audio") },
    { kind: "video", label: "视频", inputs: mediaInputs.filter((input) => input.kind === "video") },
  ].filter((group) => group.inputs.length > 0);
  const activeStoryboardPrompt = isStoryboardReferenceCompiler
    ? activeTextInputFromContent(record.content, textInputs)
    : null;
  const activeStoryboardFields = storyboardPromptFields(activeStoryboardPrompt);
  const displayedVideoDuration = isStoryboardReferenceCompiler
    ? activeStoryboardFields.durationSeconds
    : videoDuration;
  const activeStoryboardSelection = isStoryboardReferenceCompiler
    ? resolveStoryboardReferenceSelection(
        activeStoryboardFields.prompt,
        activeStoryboardFields.referenceSelection,
        mediaInputs,
      )
    : null;
  const storyboardCandidateCatalog = isStoryboardReferenceCompiler
    ? storyboardReferenceCandidateCatalog(id, mediaInputs)
    : "";
  const regularH3ReferenceCatalog = !isStoryboardReferenceCompiler
    && videoGenerationMode === "reference-to-video"
    ? h3ReferenceAssetCatalog(id, mediaInputs)
    : "";
  const referenceCatalog = isStoryboardReferenceCompiler
    ? storyboardCandidateCatalog
    : regularH3ReferenceCatalog;

  useEffect(() => {
    if (!editingTitle) setTitleDraft(record.title);
  }, [editingTitle, record.title]);

  useEffect(() => {
    if (!materialNoteFocused) setMaterialNoteDraft(materialNoteFromContent(record.content));
  }, [materialNoteFocused, record.content]);

  useEffect(() => {
    if (!isGeneratedVideo || !generatedVideoUrl) return;
    const video = generatedVideoRef.current;
    if (!video) return;
    if (video.getAttribute("src") !== generatedVideoUrl) {
      video.src = generatedVideoUrl;
      video.load();
    }
    const handleFullscreenChange = () => {
      if (document.fullscreenElement) return;
      const body = video.closest(".media-node-body");
      if (!body?.matches(":hover")) video.pause();
    };
    video.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      video.removeEventListener("fullscreenchange", handleFullscreenChange);
      video.pause();
      if (video.readyState > 0) video.currentTime = 0;
    };
  }, [generatedVideoUrl, isGeneratedVideo]);

  useEffect(() => {
    if (
      !isGeneratedVideo
      || !savedAspectRatio
      || record.content.previewLayoutVersion === GENERATED_VIDEO_PREVIEW_LAYOUT_VERSION
    ) return;
    const usesPreviousDefaultWidth = [
      LEGACY_GENERATED_VIDEO_PREVIEW_WIDTH,
      GENERATED_VIDEO_PREVIEW_WIDTH,
    ].some((width) => Math.abs(record.width - width) < 0.5);
    const fittedWidth = usesPreviousDefaultWidth
      ? generatedVideoPreviewWidthForRatio(savedAspectRatio)
      : record.width;
    const fittedHeight = Math.min(
      2400,
      Math.max(180, fittedWidth / savedAspectRatio + GENERATED_VIDEO_FOOTER_HEIGHT),
    );
    onChange(id, {
      width: fittedWidth,
      height: fittedHeight,
      content: {
        ...record.content,
        previewLayoutVersion: GENERATED_VIDEO_PREVIEW_LAYOUT_VERSION,
      },
    });
  }, [id, isGeneratedVideo, onChange, record.content, record.width, savedAspectRatio]);

  useEffect(() => {
    if ((!isImage && !isVideoAsset) || !savedAspectRatio || record.content.materialNodeLayoutVersion === MATERIAL_NODE_LAYOUT_VERSION) return;
    const fittedHeight = Math.min(
      2400,
      record.width / savedAspectRatio + (isImage ? IMAGE_NODE_CHROME_HEIGHT : MEDIA_NODE_CHROME_HEIGHT),
    );
    onChange(id, {
      height: fittedHeight,
      content: {
        ...record.content,
        materialNodeLayoutVersion: MATERIAL_NODE_LAYOUT_VERSION,
      },
    });
  }, [id, isImage, isVideoAsset, onChange, record.content, record.width, savedAspectRatio]);

  useEffect(() => {
    if (!isGeneratedVideo) return;
    const normalizedTitle = normalizedGeneratedVideoTitle(record.title);
    if (normalizedTitle !== record.title) onChange(id, { title: normalizedTitle });
  }, [id, isGeneratedVideo, onChange, record.title]);

  useEffect(() => {
    if (isContentIterationNode && (record.title === "提示词版本" || record.title === "提示词迭代")) {
      onChange(id, { title: "内容迭代" });
    }
  }, [id, isContentIterationNode, onChange, record.title]);

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

  useEffect(() => {
    setInformationDraft(savedInformation);
  }, [savedInformation]);

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
    if (!workflowModuleMenuOpen) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof globalThis.Node && workflowModuleControlRef.current?.contains(target)) return;
      setWorkflowModuleMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown, true);
  }, [workflowModuleMenuOpen]);

  useEffect(() => {
    if (!textInformationOpen) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof globalThis.Node && textInformationRef.current?.contains(target)) return;
      setTextInformationOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown, true);
  }, [textInformationOpen]);

  useEffect(() => {
    if (!textInformationOpen) return;
    const panel = textInformationRef.current?.querySelector<HTMLElement>(".text-information-panel");
    const textarea = panel?.querySelector<HTMLTextAreaElement>("textarea");
    if (!panel || !textarea) return;
    const containInformationWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      const rawDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX)
        ? event.deltaY
        : event.deltaX;
      const multiplier = event.deltaMode === 1
        ? 32
        : event.deltaMode === 2
          ? textarea.clientHeight
          : 1;
      textarea.scrollTop += rawDelta * multiplier;
      event.preventDefault();
      event.stopPropagation();
    };
    panel.addEventListener("wheel", containInformationWheel, { passive: false });
    return () => panel.removeEventListener("wheel", containInformationWheel);
  }, [textInformationOpen]);

  useEffect(() => {
    if (!generatedInfoOpen) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (target instanceof globalThis.Node && generatedInfoRef.current?.contains(target)) return;
      setGeneratedInfoOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown, true);
  }, [generatedInfoOpen]);

  useEffect(() => {
    if (!loraMenuOpen) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof globalThis.Node && loraControlRef.current?.contains(target)) return;
      setLoraMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown, true);
  }, [loraMenuOpen]);

  useEffect(() => {
    if (!secondaryLoraMenuOpen) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof globalThis.Node && secondaryLoraControlRef.current?.contains(target)) return;
      setSecondaryLoraMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown, true);
  }, [secondaryLoraMenuOpen]);

  useEffect(() => {
    if (!promptVersionMenuOpen) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof globalThis.Node && promptVersionControlRef.current?.contains(target)) return;
      setPromptVersionMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown, true);
  }, [promptVersionMenuOpen]);

  useEffect(() => {
    if (!contentTypeMenuOpen) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof globalThis.Node && contentTypeControlRef.current?.contains(target)) return;
      setContentTypeMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown, true);
  }, [contentTypeMenuOpen]);

  useEffect(() => {
    if (promptVersionMenuOpen) return;
    setEditingPromptVersionTitleId(null);
    setPromptVersionTitleDraft("");
  }, [promptVersionMenuOpen]);
  const finishTitleEdit = () => {
    if (titleDraft !== record.title) onChange(id, { title: titleDraft });
    setEditingTitle(false);
  };

  const finishMaterialNoteEdit = () => {
    const previousNote = materialNoteFromContent(record.content);
    if (materialNoteDraft !== previousNote) {
      onChange(id, {
        content: {
          ...record.content,
          materialNote: materialNoteDraft,
        },
      });
    }
    setMaterialNoteFocused(false);
  };

  const markTextNodeChanged = (
    nodeId: string,
    nextText: string,
    nextInformation: string,
    originalText: string,
    originalInformation: string,
  ) => {
    setManualSaveStateByNodeId((current) => {
      const previous = current[nodeId] ?? {
        savedText: originalText,
        savedInformation: originalInformation,
        currentText: originalText,
        currentInformation: originalInformation,
      };
      return {
        ...current,
        [nodeId]: {
          ...previous,
          currentText: nextText,
          currentInformation: nextInformation,
        },
      };
    });
  };

  const isTextNodeManuallyUnsaved = (nodeId: string) => {
    const state = manualSaveStateByNodeId[nodeId];
    return Boolean(state) && (
      state.currentText !== state.savedText
      || state.currentInformation !== state.savedInformation
    );
  };

  const promptVersionSaveKey = (nodeId: string, versionId: string) => `${nodeId}:${versionId}`;

  const markPromptVersionTitleChanged = (
    nodeId: string,
    versionId: string,
    nextTitle: string,
    originalTitle: string,
  ) => {
    const key = promptVersionSaveKey(nodeId, versionId);
    setManualSaveVersionTitleStateByKey((current) => {
      const previous = current[key] ?? { savedTitle: originalTitle, currentTitle: originalTitle };
      return {
        ...current,
        [key]: { ...previous, currentTitle: nextTitle },
      };
    });
  };

  const isPromptVersionTitleManuallyUnsaved = (nodeId: string, versionId?: string) => {
    if (!versionId) return false;
    const state = manualSaveVersionTitleStateByKey[promptVersionSaveKey(nodeId, versionId)];
    return Boolean(state) && state.currentTitle !== state.savedTitle;
  };

  const isNodeManuallyUnsaved = (nodeId: string, versionId?: string) => (
    isTextNodeManuallyUnsaved(nodeId)
    || isPromptVersionTitleManuallyUnsaved(nodeId, versionId)
  );

  const clearManualSaveState = (nodeId: string) => {
    setManualSaveStateByNodeId((current) => {
      if (!current[nodeId]) return current;
      const { [nodeId]: _discarded, ...remaining } = current;
      return remaining;
    });
    setManualSaveVersionTitleStateByKey((current) => {
      const prefix = `${nodeId}:`;
      let changed = false;
      const remaining = Object.fromEntries(Object.entries(current).filter(([key]) => {
        const shouldKeep = !key.startsWith(prefix);
        if (!shouldKeep) changed = true;
        return shouldKeep;
      }));
      return changed ? remaining : current;
    });
  };

  const discardTextNodeManualChanges = (nodeId: string, content: JsonObject) => {
    const savedContent = manualSavedPromptContentFromContent(content);
    if (savedContent) {
      const restoredContent = { ...savedContent };
      const restoredVersion = activePromptVersionFromContent(restoredContent);
      if (nodeId === id) {
        setTextDraft(restoredVersion?.text ?? textFromContent(restoredContent));
        setInformationDraft(restoredVersion?.information ?? informationFromContent(restoredContent));
      }
      onChange(nodeId, { content: restoredContent });
    }
    clearManualSaveState(nodeId);
  };

  const createInitialPromptVersion = (nextText: string, nextInformation: string) => {
    if (
      !isContentIterationNode
      || allPromptVersions.length !== 0
      || (!nextText.trim() && !nextInformation.trim())
    ) return false;
    const initialVersion: PromptVersionRecord = {
      id: crypto.randomUUID(),
      label: "v1",
      title: record.title || "内容",
      text: nextText,
      information: nextInformation,
      createdAt: new Date().toISOString(),
      derivedFrom: contentParents.flatMap((parent) => {
        const parentVersion = activePromptVersionFromContent(parent.content);
        return parentVersion
          ? [{
              nodeId: parent.id,
              versionId: parentVersion.id,
              versionLabel: parentVersion.label,
            }]
          : [];
      }),
    };
    onChange(id, {
      content: {
        ...record.content,
        text: initialVersion.text,
        information: initialVersion.information,
        contentNode: true,
        contentType: contentNodeType,
        promptVersions: [initialVersion],
        activePromptVersionId: initialVersion.id,
        bestPromptVersionId: "",
      },
    });
    return true;
  };

  const changeText = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const nextText = event.currentTarget.value;
    setTextDraft(nextText);
    markTextNodeChanged(id, nextText, informationDraft, savedText, savedInformation);
    if (createInitialPromptVersion(nextText, informationDraft)) return;
    if (isContentIterationNode && activePromptVersion) {
      onChange(id, {
        content: {
          ...record.content,
          text: nextText,
          promptVersions: promptVersions.map((version) => (
            version.id === activePromptVersion.id ? { ...version, text: nextText } : version
          )),
        },
      });
      return;
    }
    onChange(id, {
      content: { ...record.content, text: nextText },
    });
  };

  const changeInformation = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const nextInformation = event.currentTarget.value;
    setInformationDraft(nextInformation);
    markTextNodeChanged(id, textDraft, nextInformation, savedText, savedInformation);
    if (createInitialPromptVersion(textDraft, nextInformation)) return;
    if (isContentIterationNode && activePromptVersion) {
      onChange(id, {
        content: {
          ...record.content,
          information: nextInformation,
          promptVersions: promptVersions.map((version) => (
            version.id === activePromptVersion.id
              ? { ...version, information: nextInformation }
              : version
          )),
        },
      });
      return;
    }
    onChange(id, {
      content: { ...record.content, information: nextInformation },
    });
  };

  const createPromptVersion = () => {
    if (!isContentIterationNode) return;
    const nextText = "";
    const nextInformation = "";
    const derivedFrom = contentParents.flatMap((parent) => {
      const parentVersion = activePromptVersionFromContent(parent.content);
      return parentVersion
        ? [{
            nodeId: parent.id,
            versionId: parentVersion.id,
            versionLabel: parentVersion.label,
          }]
        : [];
    });
    const nextVersion: PromptVersionRecord = {
      id: crypto.randomUUID(),
      label: nextPromptVersionLabel(allPromptVersions),
      title: activePromptVersion?.title || record.title || "内容",
      text: nextText,
      information: nextInformation,
      createdAt: new Date().toISOString(),
      ...(activePromptVersion?.generationOptions
        ? { generationOptions: activePromptVersion.generationOptions }
        : {}),
      ...(activePromptVersion?.durationOverrideSeconds !== undefined
        ? { durationOverrideSeconds: activePromptVersion.durationOverrideSeconds }
        : {}),
      ...(derivedFrom.length ? { derivedFrom } : {}),
    };
    setTextDraft(nextText);
    setInformationDraft(nextInformation);
    markTextNodeChanged(id, nextText, nextInformation, savedText, savedInformation);
    onChange(id, {
      content: {
        ...record.content,
        text: nextVersion.text,
        information: nextVersion.information,
        contentNode: true,
        contentType: contentNodeType,
        promptVersions: [...promptVersions, nextVersion],
        activePromptVersionId: nextVersion.id,
      },
    });
    setPromptVersionMenuOpen(false);
  };

  const changeContentNodeType = (nextType: ContentNodeType) => {
    if (isContentTypeLocked) return;
    onChange(id, {
      content: {
        ...record.content,
        contentNode: true,
        contentType: nextType,
      },
    });
    setContentTypeMenuOpen(false);
  };

  const selectPromptVersion = (version: PromptVersionRecord) => {
    setTextDraft(version.text);
    setInformationDraft(version.information);
    markTextNodeChanged(id, version.text, version.information, savedText, savedInformation);
    onChange(id, {
      content: {
        ...record.content,
        text: version.text,
        information: version.information,
        activePromptVersionId: version.id,
      },
    });
    setPromptVersionMenuOpen(false);
  };

  const changeActivePromptDuration = (rawValue: string) => {
    if (contentNodeType !== "prompt" || !activePromptVersion) return;
    const nextDuration = Number(rawValue);
    if (!Number.isInteger(nextDuration) || nextDuration < 2 || nextDuration > 15) return;
    onChange(id, {
      content: {
        ...record.content,
        promptVersions: allPromptVersions.map((version) => (
          version.id === activePromptVersion.id
            ? { ...version, durationOverrideSeconds: nextDuration }
            : version
        )),
      },
    });
  };

  const deletePromptVersion = async (versionId: string) => {
    await onDeletePromptVersion(id, versionId);
    setPromptVersionMenuOpen(false);
  };

  const beginPromptVersionTitleEdit = (version: PromptVersionRecord) => {
    setEditingPromptVersionTitleId(version.id);
    setPromptVersionTitleDraft(version.title);
  };

  const cancelPromptVersionTitleEdit = () => {
    const version = promptVersions.find((candidate) => candidate.id === editingPromptVersionTitleId);
    if (version) {
      markPromptVersionTitleChanged(id, version.id, version.title, version.title);
    }
    setEditingPromptVersionTitleId(null);
    setPromptVersionTitleDraft("");
  };

  const changePromptVersionTitleDraft = (version: PromptVersionRecord, nextTitle: string) => {
    setPromptVersionTitleDraft(nextTitle);
    markPromptVersionTitleChanged(id, version.id, nextTitle, version.title);
  };

  const commitPromptVersionTitleEdit = (versionId: string) => {
    const nextTitle = promptVersionTitleDraft.trim() || "未命名版本";
    const version = promptVersions.find((candidate) => candidate.id === versionId);
    if (version) markPromptVersionTitleChanged(id, version.id, nextTitle, version.title);
    markTextNodeChanged(id, textDraft, informationDraft, savedText, savedInformation);
    onChange(id, {
      content: {
        ...record.content,
        promptVersions: promptVersions.map((version) => (
          version.id === versionId ? { ...version, title: nextTitle } : version
        )),
      },
    });
    setEditingPromptVersionTitleId(null);
    setPromptVersionTitleDraft("");
  };

  const markActivePromptVersionBest = () => {
    if (!activePromptVersion) return;
    markTextNodeChanged(id, textDraft, informationDraft, savedText, savedInformation);
    onChange(id, {
      content: {
        ...record.content,
        bestPromptVersionId: activePromptVersion.id,
      },
    });
  };

  const openConnectedTextEditor = (input: NodeRecord) => {
    const inputText = textFromContent(input.content);
    const inputPromptVersion = activePromptVersionFromContent(input.content);
    const versionLabel = inputPromptVersion?.label ?? "";
    const baseTitle = input.title || "未命名文本";
    setConnectedTextEditor({
      id: input.id,
      title: `${inputPromptVersion?.title || baseTitle}${versionLabel ? ` · ${versionLabel}` : ""}`,
      baseTitle,
      content: input.content,
      text: inputText,
      information: inputPromptVersion?.information ?? informationFromContent(input.content),
    });
    setConnectedTextMarkdownPreview(true);
    setConnectedInformationMarkdownPreview(true);
    setConnectedInformationHidden(false);
  };

  const selectConnectedPromptVersion = (version: PromptVersionRecord) => {
    if (!connectedTextEditor) return;
    const nextContent = {
      ...connectedTextEditor.content,
      text: version.text,
      information: version.information,
      activePromptVersionId: version.id,
    };
    setConnectedTextEditor({
      ...connectedTextEditor,
      title: `${version.title || connectedTextEditor.baseTitle} · ${version.label}`,
      content: nextContent,
      text: version.text,
      information: version.information,
    });
    markTextNodeChanged(
      connectedTextEditor.id,
      version.text,
      version.information,
      connectedTextEditor.text,
      connectedTextEditor.information,
    );
    onChange(connectedTextEditor.id, { content: nextContent });
  };

  const changeConnectedPromptField = (
    field: "text" | "information",
    value: string,
  ) => {
    if (!connectedTextEditor) return;
    const activeVersion = activePromptVersionFromContent(connectedTextEditor.content);
    const versions = promptVersionsFromContent(connectedTextEditor.content);
    const nextContent = {
      ...connectedTextEditor.content,
      [field]: value,
      ...(activeVersion
        ? {
            promptVersions: versions.map((version) => (
              version.id === activeVersion.id ? { ...version, [field]: value } : version
            )),
          }
        : {}),
    };
    setConnectedTextEditor({
      ...connectedTextEditor,
      content: nextContent,
      [field]: value,
    });
    markTextNodeChanged(
      connectedTextEditor.id,
      field === "text" ? value : connectedTextEditor.text,
      field === "information" ? value : connectedTextEditor.information,
      connectedTextEditor.text,
      connectedTextEditor.information,
    );
    onChange(connectedTextEditor.id, { content: nextContent });
  };

  const copyMarkdown = (target: string, value: string) => {
    onCopy(value);
    setCopiedMarkdownTarget(target);
    window.setTimeout(() => {
      setCopiedMarkdownTarget((current) => current === target ? null : current);
    }, 1200);
  };

  const saveTextNode = async (nodeId: string, versionId?: string) => {
    if (savingTextNodeId === nodeId) return false;
    const stateAtSave = manualSaveStateByNodeId[nodeId];
    const versionTitleKey = versionId ? promptVersionSaveKey(nodeId, versionId) : null;
    const versionTitleStateAtSave = versionTitleKey
      ? manualSaveVersionTitleStateByKey[versionTitleKey]
      : undefined;
    setSavingTextNodeId(nodeId);
    try {
      await onSaveNode(nodeId);
      setManualSaveStateByNodeId((current) => {
        const state = current[nodeId];
        if (
          !state
          || !stateAtSave
          || state.currentText !== stateAtSave.currentText
          || state.currentInformation !== stateAtSave.currentInformation
        ) return current;
        return {
          ...current,
          [nodeId]: {
            ...state,
            savedText: state.currentText,
            savedInformation: state.currentInformation,
          },
        };
      });
      if (versionTitleKey && versionTitleStateAtSave) {
        setManualSaveVersionTitleStateByKey((current) => {
          const state = current[versionTitleKey];
          if (!state || state.currentTitle !== versionTitleStateAtSave.currentTitle) return current;
          return {
            ...current,
            [versionTitleKey]: { ...state, savedTitle: state.currentTitle },
          };
        });
      }
      return true;
    } catch {
      // The parent already shows the failed save reason in the global notice.
      return false;
    } finally {
      setSavingTextNodeId((current) => (current === nodeId ? null : current));
    }
  };

  const saveTextWithShortcut = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
    nodeId: string,
    versionId?: string,
  ) => {
    if (
      event.nativeEvent.isComposing
      || !(event.ctrlKey || event.metaKey)
      || event.altKey
      || event.key.toLowerCase() !== "s"
    ) return;
    event.preventDefault();
    event.stopPropagation();
    void saveTextNode(nodeId, versionId);
  };

  const requestCloseExpandedEditor = () => {
    if (isText && isNodeManuallyUnsaved(id, activePromptVersion?.id)) {
      setEditorExitConfirmation({
        target: "expanded",
        nodeId: id,
        versionId: activePromptVersion?.id,
      });
      return;
    }
    setExpanded(false);
    setExpandedTextMarkdownPreview(true);
    setExpandedInformationMarkdownPreview(true);
    setExpandedInformationHidden(false);
  };

  const requestCloseConnectedTextEditor = () => {
    if (!connectedTextEditor) return;
    if (isNodeManuallyUnsaved(connectedTextEditor.id, connectedActivePromptVersion?.id)) {
      setEditorExitConfirmation({
        target: "connected",
        nodeId: connectedTextEditor.id,
        versionId: connectedActivePromptVersion?.id,
      });
      return;
    }
    setConnectedTextEditor(null);
    setConnectedTextMarkdownPreview(true);
    setConnectedInformationMarkdownPreview(true);
    setConnectedInformationHidden(false);
  };

  const exitEditorWithoutManualSave = () => {
    const confirmation = editorExitConfirmation;
    if (!confirmation) return;
    setEditorExitConfirmation(null);
    if (confirmation.target === "connected") {
      if (connectedTextEditor) {
        discardTextNodeManualChanges(confirmation.nodeId, connectedTextEditor.content);
      }
      setConnectedTextEditor(null);
      setConnectedTextMarkdownPreview(true);
      setConnectedInformationMarkdownPreview(true);
      setConnectedInformationHidden(false);
    } else {
      discardTextNodeManualChanges(confirmation.nodeId, record.content);
      setExpanded(false);
      setExpandedTextMarkdownPreview(true);
      setExpandedInformationMarkdownPreview(true);
      setExpandedInformationHidden(false);
    }
  };

  const saveAndExitEditor = async () => {
    const confirmation = editorExitConfirmation;
    if (!confirmation || savingEditorExit) return;
    setSavingEditorExit(true);
    try {
      const saved = await saveTextNode(confirmation.nodeId, confirmation.versionId);
      if (!saved) return;
      setEditorExitConfirmation(null);
      if (confirmation.target === "connected") {
        setConnectedTextEditor(null);
        setConnectedTextMarkdownPreview(true);
        setConnectedInformationMarkdownPreview(true);
        setConnectedInformationHidden(false);
      } else {
        setExpanded(false);
        setExpandedTextMarkdownPreview(true);
        setExpandedInformationMarkdownPreview(true);
        setExpandedInformationHidden(false);
      }
    } finally {
      setSavingEditorExit(false);
    }
  };

  useEffect(() => {
    if ((!expanded && !connectedTextEditor) || editorExitConfirmation) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (connectedTextEditor) requestCloseConnectedTextEditor();
      else requestCloseExpandedEditor();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [connectedTextEditor, editorExitConfirmation, expanded, requestCloseConnectedTextEditor, requestCloseExpandedEditor]);

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

  const copyValidationError = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!validationMessage) return;
    onCopy(validationMessage);
    setErrorCopied(true);
    window.setTimeout(() => setErrorCopied(false), 1200);
  };

  const copyReferenceCatalog = () => {
    if (!referenceCatalog) return;
    onCopy(referenceCatalog);
    setReferenceCatalogCopied(true);
    window.setTimeout(() => setReferenceCatalogCopied(false), 1200);
  };

  const markGeneratedVideoFullyPlayed = () => {
    if (!isUnplayedGeneratedVideo) return;
    onMarkGeneratedVideoFullyPlayed(id);
  };

  const markGeneratedVideoAtPlaybackEnd = (video: HTMLVideoElement) => {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    if (!video.ended && video.currentTime < video.duration - 0.01) return;
    markGeneratedVideoFullyPlayed();
  };

  const applyNaturalMediaRatio = (naturalWidth: number, naturalHeight: number) => {
    if (savedAspectRatio || naturalWidth <= 0 || naturalHeight <= 0) return;
    const aspectRatio = naturalWidth / naturalHeight;
    const fittedWidth = isImage && aspectRatio < 1
      ? GENERATED_VIDEO_PORTRAIT_PREVIEW_WIDTH
      : record.width;
    const fittedHeight = isGeneratedVideo
      ? Math.min(
        2400,
        Math.max(180, fittedWidth / aspectRatio + GENERATED_VIDEO_FOOTER_HEIGHT),
      )
      : isImage
        ? Math.min(2400, fittedWidth / aspectRatio + IMAGE_NODE_CHROME_HEIGHT)
      : mediaNodeHeightForAspectRatio(fittedWidth, aspectRatio);
    onChange(id, {
      content: {
        ...record.content,
        aspectRatio,
        naturalWidth,
        naturalHeight,
        ...((isImage || isVideoAsset) ? { materialNodeLayoutVersion: MATERIAL_NODE_LAYOUT_VERSION } : {}),
      },
      width: fittedWidth,
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
      ?? base.width / Math.max(1, base.height - videoChromeHeight);
    let width: number;
    let height: number;
    const minimumHeight = isImage ? IMAGE_NODE_CHROME_HEIGHT + 1 : 180;
    if (direction[0] !== 0) {
      width = Math.max(260, params.width);
      height = width / aspectRatio + videoChromeHeight;
    } else {
      height = Math.max(minimumHeight, params.height);
      width = (height - videoChromeHeight) * aspectRatio;
      if (width < 260) {
        width = 260;
        height = width / aspectRatio + videoChromeHeight;
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
        ?? base.width / Math.max(1, base.height - videoChromeHeight);
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

  const moveTextInput = (sourceId: string, targetIndex: number) => {
    const orderedIds = textInputs.map((input) => input.id);
    const sourceIndex = orderedIds.indexOf(sourceId);
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= orderedIds.length) return;
    const nextOrder = [...orderedIds];
    const [movedId] = nextOrder.splice(sourceIndex, 1);
    nextOrder.splice(targetIndex, 0, movedId);
    if (nextOrder.every((inputId, index) => inputId === orderedIds[index])) return;
    onChange(id, {
      content: { ...record.content, textInputOrder: nextOrder },
    });
  };

  const textInputIdAtPoint = (clientX: number, clientY: number): string | null => {
    const target = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>("[data-text-input-id]");
    return target?.dataset.textInputId ?? null;
  };

  const moveTextInputTo = (sourceId: string, targetId: string | null) => {
    const targetIndex = textInputs.findIndex((input) => input.id === targetId);
    if (targetIndex < 0) return;
    moveTextInput(sourceId, targetIndex);
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

  const checkAndExecuteBatch = async () => {
    const result = validateVideoExecution(
      videoGenerationMode,
      record.content,
      mediaInputs,
      textInputs,
    );
    const emptyTextIndex = textInputs.findIndex(
      (input) => !storyboardPromptFields(input).prompt.trim(),
    );
    const compilerInvalidIndex = isStoryboardReferenceCompiler
      ? textInputs.findIndex((input) => {
          const fields = storyboardPromptFields(input);
          return Boolean(resolveStoryboardReferenceSelection(
            fields.prompt,
            fields.referenceSelection,
            mediaInputs,
          ).error);
        })
      : -1;
    const compilerInvalidMessage = compilerInvalidIndex >= 0
      ? resolveStoryboardReferenceSelection(
          storyboardPromptFields(textInputs[compilerInvalidIndex]).prompt,
          storyboardPromptFields(textInputs[compilerInvalidIndex]).referenceSelection,
          mediaInputs,
        ).error
      : "";
    const batchValidation = !result.valid
      ? result
      : textInputs.length < 2
        ? { valid: false, message: "批量提交至少需要接入两个文字提示词" }
        : emptyTextIndex >= 0
          ? { valid: false, message: `第 ${emptyTextIndex + 1} 个文字提示词内容为空，请先填写` }
          : compilerInvalidIndex >= 0
            ? { valid: false, message: `第 ${compilerInvalidIndex + 1} 个分镜不可执行：${compilerInvalidMessage}` }
          : { valid: true, message: `批量提交条件检查通过：共 ${textInputs.length} 个任务` };
    onChange(id, {
      content: {
        ...record.content,
        status: batchValidation.valid ? "ready" : "invalid",
        validationMessage: batchValidation.message,
      },
    });
    onExecutionCheck(batchValidation.message, batchValidation.valid);
    if (!batchValidation.valid) return;
    if (batchSubmitting) return;
    setBatchSubmitting(true);
    try {
      await onBatchExecute(id);
    } finally {
      setBatchSubmitting(false);
    }
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

  const clearConnectedTexts = async () => {
    if (!textIdsPendingClear?.length || clearingTexts) return;
    setClearingTexts(true);
    try {
      for (const inputId of textIdsPendingClear) {
        await onRemoveInput(id, inputId);
      }
      if (
        connectedTextEditor
        && textIdsPendingClear.includes(connectedTextEditor.id)
      ) {
        setConnectedTextEditor(null);
      }
      setTextIdsPendingClear(null);
    } finally {
      setClearingTexts(false);
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

  const playMediaVideoOnHover = (event: ReactMouseEvent<HTMLDivElement>) => {
    const video = event.currentTarget.querySelector("video");
    if (!video) return;
    void video.play().catch(() => {
      // Some system WebViews may block the first unmuted playback before user interaction.
    });
  };

  const pauseMediaVideoOnLeave = (event: ReactMouseEvent<HTMLDivElement>) => {
    const video = event.currentTarget.querySelector("video");
    if (!video || document.fullscreenElement === video) return;
    video.pause();
  };

  const playGeneratedVideoFullscreen = () => {
    const video = generatedVideoRef.current;
    if (!video) return;
    void video.play().catch(() => {});
    void video.requestFullscreen().catch(() => {});
  };

  const runImageResize = async (maxEdge: number, rememberDefault: boolean) => {
    if (!isImage || imageResizing) return;
    setImageResizeError("");
    setImageResizing(true);
    try {
      await onResizeImage(id, maxEdge);
      if (rememberDefault) {
        window.localStorage.setItem(IMAGE_RESIZE_DEFAULT_STORAGE_KEY, String(maxEdge));
      }
      setImageResizeDialogOpen(false);
    } catch (error) {
      setImageResizeError(error instanceof Error ? error.message : String(error));
    } finally {
      setImageResizing(false);
    }
  };

  const submitImageResize = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const maxEdge = Number(imageResizeDraft);
    if (
      !Number.isInteger(maxEdge)
      || maxEdge < MIN_IMAGE_RESIZE_MAX_EDGE
      || maxEdge > MAX_IMAGE_RESIZE_MAX_EDGE
    ) {
      setImageResizeError(
        `请输入 ${MIN_IMAGE_RESIZE_MAX_EDGE}–${MAX_IMAGE_RESIZE_MAX_EDGE} 之间的整数`,
      );
      return;
    }
    void runImageResize(maxEdge, true);
  };

  return (
    <article
      className={`canvas-node kind-${record.kind} ${isStoryboardReferenceCompiler ? "is-storyboard-reference-compiler" : ""} ${selected ? "is-selected" : ""} ${isContentIterationNode ? `is-content-iteration-node content-type-${contentNodeType}` : ""} ${usesSecondaryGreenTheme ? "is-secondary-preview" : ""} ${usesCustomPreviewTheme ? "has-custom-preview-color" : ""} ${relationHighlighted ? "is-relation-highlighted" : ""} ${matched ? "" : "is-dimmed"}`}
      style={previewThemeStyle}
      onPointerDownCapture={(event) => {
        if (preservesGeneratedVideoToolbarCtrlClick(event.target)) {
          ctrlSelectionPointerId.current = null;
          return;
        }
        if (event.button !== 0 || !event.ctrlKey) {
          ctrlSelectionPointerId.current = null;
          return;
        }
        ctrlSelectionPointerId.current = event.pointerId;
        event.preventDefault();
        event.stopPropagation();
        setNodes((current) => current.map((node) => (
          node.id === id ? { ...node, selected: !node.selected } : node
        )));
      }}
      onPointerMoveCapture={(event) => {
        if (ctrlSelectionPointerId.current !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerUpCapture={(event) => {
        if (ctrlSelectionPointerId.current !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerCancelCapture={(event) => {
        if (ctrlSelectionPointerId.current !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        ctrlSelectionPointerId.current = null;
      }}
      onClickCapture={(event) => {
        if (preservesGeneratedVideoToolbarCtrlClick(event.target)) {
          ctrlSelectionPointerId.current = null;
          return;
        }
        if (!event.ctrlKey && ctrlSelectionPointerId.current === null) return;
        event.preventDefault();
        event.stopPropagation();
        ctrlSelectionPointerId.current = null;
      }}
      onDoubleClickCapture={(event) => {
        if (preservesGeneratedVideoToolbarCtrlClick(event.target)) return;
        if (!event.ctrlKey) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <NodeResizer
        minWidth={260}
        minHeight={isAudioAsset ? AUDIO_NODE_MIN_HEIGHT : 180}
        autoScale={false}
        isVisible={selected && !isImage && !isVideoAsset && !isGeneratedVideo && !isVideoGeneration && !isFolder}
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
      {selected && isVideoGeneration && videoGenerationFullHeight > VIDEO_NODE_BASE_HEIGHT && (
        <NodeResizeControl
          position="bottom"
          variant={ResizeControlVariant.Line}
          resizeDirection="vertical"
          minWidth={record.width}
          maxWidth={record.width}
          minHeight={VIDEO_NODE_BASE_HEIGHT}
          maxHeight={videoGenerationFullHeight}
          className="video-generation-height-resizer nodrag"
          onResizeEnd={(_, params) => {
            onChange(id, {
              height: params.height,
              content: { ...record.content, manualHeight: params.height },
            });
          }}
        />
      )}
      {selected && (isImage || isVideoAsset || isGeneratedVideo) && VIDEO_RESIZE_CONTROLS.map((control) => (
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
      {(isVideoGeneration || isGeneratedVideo || isContentIterationNode) && (
        <Handle
          type="target"
          position={Position.Left}
          className={`node-handle target-handle ${isContentIterationNode ? "content-derivation-target-handle" : ""}`}
          title={isContentIterationNode ? "连接上游创作内容" : undefined}
        />
      )}
      {!isGeneratedVideo && !isImage && !isAudioAsset && (
      <header className="node-header">
        <span className="node-kind-icon">
          {isImage
              ? <ImageIcon size={14} />
            : isFolder
              ? <FolderOpen size={14} />
            : isNote
              ? <StickyNote size={14} />
            : isAudioAsset
              ? <Music size={14} />
              : isVideoAsset || isGeneratedVideo
              ? <Film size={14} />
              : isVideoGeneration
                ? isStoryboardReferenceCompiler
                  ? <Sparkles size={14} />
                  : <Clapperboard size={14} />
                : isContentIterationNode
                  ? <History size={14} />
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
        {!isContentIterationNode && (isText || isNote) && (
          <button
            type="button"
            className={`nodrag node-action ${nodeMarkdownPreview ? "is-active-markdown" : ""}`}
            onClick={() => setNodeMarkdownPreview((preview) => !preview)}
            title={nodeMarkdownPreview ? "切换到 Markdown 编辑" : "预览 Markdown"}
            aria-label={nodeMarkdownPreview ? "切换到 Markdown 编辑" : "预览 Markdown"}
          >
            {nodeMarkdownPreview ? <Pencil size={13} /> : <Eye size={13} />}
          </button>
        )}
        {!isContentIterationNode && (isText || isNote) && (
          <button
            type="button"
            className="nodrag node-action"
            onClick={() => copyMarkdown("node", textDraft)}
            title="复制 Markdown 原文"
            aria-label="复制 Markdown 原文"
          >
            {copiedMarkdownTarget === "node" ? <Check size={14} /> : <Copy size={14} />}
          </button>
        )}
        {(isText || isNote) && (
          <button
            type="button"
            className={`nodrag node-action ${isNodeManuallyUnsaved(id, activePromptVersion?.id) ? "is-manual-save-dirty" : ""}`}
            onClick={() => void saveTextNode(id, activePromptVersion?.id)}
            disabled={savingTextNodeId === id}
            title={savingTextNodeId === id
              ? "正在保存到数据库…"
              : isNodeManuallyUnsaved(id, activePromptVersion?.id)
                ? "有未手动保存的修改，点击立即保存到数据库"
                : "立即保存到数据库"}
            aria-label={savingTextNodeId === id ? "正在保存文本节点" : "立即保存文本节点到数据库"}
          >
            <Save size={13} />
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
              title={isText
                ? "选择文本节点颜色"
                : isNote
                  ? "选择备注节点颜色"
                  : "选择视频预览颜色"}
              aria-label={isText
                ? "选择文本节点颜色"
                : isNote
                  ? "选择备注节点颜色"
                  : "选择视频预览颜色"}
              aria-expanded={previewColorMenuOpen}
            >
              <Palette size={13} />
            </button>
            {previewColorMenuOpen && (
              <div
                className="node-preview-color-presets"
                role="menu"
                aria-label={isText
                  ? "文本节点颜色预设"
                  : isNote
                    ? "备注节点颜色预设"
                    : "视频预览颜色预设"}
              >
                {previewColorPresets.map((preset) => (
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
                      className={!isNote && preset.value === VIDEO_PREVIEW_DEFAULT_COLOR ? "is-default" : ""}
                      aria-hidden="true"
                    />
                    {preset.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {isText && (
          <div
            ref={textInformationRef}
            className="nodrag text-information-control"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className={`node-action text-information-button ${textInformationOpen ? "is-active" : ""}`}
              onClick={() => {
                setPreviewColorMenuOpen(false);
                setTextInformationOpen((open) => {
                  const nextOpen = !open;
                  if (nextOpen) setInformationMarkdownPreview(true);
                  return nextOpen;
                });
              }}
              title="查看和编辑备注"
              aria-label="查看和编辑备注"
              aria-expanded={textInformationOpen}
            >
              <Info size={13} />
            </button>
            {textInformationOpen && (
              <aside
                className="text-information-panel nowheel"
                aria-label="提示词备注"
              >
                <header>
                  <div>
                    <strong>备注</strong>
                    <span>{isContentIterationNode
                      ? `${activePromptVersion?.label ?? "未创建版本"} · 备注`
                      : "当前提示词 · 备注"}</span>
                  </div>
                  <button
                    type="button"
                    className={`markdown-mode-toggle ${informationMarkdownPreview ? "is-active" : ""}`}
                    onClick={() => setInformationMarkdownPreview((preview) => !preview)}
                    title={informationMarkdownPreview ? "切换到 Markdown 编辑" : "预览 Markdown"}
                    aria-label={informationMarkdownPreview ? "切换到 Markdown 编辑" : "预览 Markdown"}
                  >
                    {informationMarkdownPreview ? <Pencil size={13} /> : <Eye size={13} />}
                  </button>
                  <button
                    type="button"
                    className="markdown-copy-button"
                    onClick={() => copyMarkdown("node-information", informationDraft)}
                    title="复制 Markdown 原文"
                    aria-label="复制 Markdown 原文"
                  >
                    {copiedMarkdownTarget === "node-information" ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </header>
                {informationMarkdownPreview ? (
                  <MarkdownPreview source={informationDraft} className="text-information-markdown-preview nowheel" />
                ) : (
                  <textarea
                    className="nowheel"
                    value={informationDraft}
                    onChange={changeInformation}
                    onKeyDown={(event) => saveTextWithShortcut(event, id, activePromptVersion?.id)}
                    placeholder={isContentIterationNode ? "这里记录本版本的备注…" : "这里记录当前文本的备注…"}
                    spellCheck={false}
                    aria-label="提示词备注内容"
                  />
                )}
                <footer>{informationDraft.length.toLocaleString()} 字符 · 自动保存</footer>
              </aside>
            )}
          </div>
        )}
      </header>
      )}
      {(isText || isNote) && (isContentIterationNode ? (
        <div className="prompt-version-shell">
          <div className="prompt-version-toolbar">
            <div
              ref={contentTypeControlRef}
              className="nodrag content-type-control"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="content-type-toggle"
                onClick={() => setContentTypeMenuOpen((open) => !open)}
                disabled={isContentTypeLocked}
                aria-expanded={contentTypeMenuOpen}
                aria-label="选择内容类型"
              >
                <strong>{contentNodeTypeLabel(contentNodeType)}</strong>
                <ChevronDown size={12} />
              </button>
              {contentTypeMenuOpen && (
                <div className="content-type-menu" role="menu" aria-label="内容类型">
                  {CONTENT_NODE_TYPE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={contentNodeType === option.value}
                      className={contentNodeType === option.value ? "is-active" : ""}
                      onClick={() => changeContentNodeType(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div
              ref={promptVersionControlRef}
              className="nodrag prompt-version-control"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="prompt-version-toggle"
                onClick={() => setPromptVersionMenuOpen((open) => !open)}
                aria-expanded={promptVersionMenuOpen}
                aria-label="选择内容版本"
              >
                <History size={12} />
                <strong>{activePromptVersion?.label ?? "未创建"}</strong>
                <span>{`${promptVersions.length} 个版本`}</span>
                <ChevronDown size={12} />
              </button>
              {promptVersionMenuOpen && (
                <div className="prompt-version-menu" role="menu" aria-label="内容历史版本">
                  <header>
                    <strong>历史版本</strong>
                    <span>点击切换当前版本</span>
                  </header>
                  <div
                    className="prompt-version-menu-list nowheel"
                    onWheelCapture={scrollElementWithWheel}
                  >
                    {!promptVersions.length && (
                      <div className="prompt-version-empty">尚无版本，点击“新版本”创建 v1</div>
                    )}
                    {[...promptVersions].reverse().map((version) => (
                      <div
                        key={version.id}
                        className={`prompt-version-menu-item ${version.id === activePromptVersion?.id ? "is-active" : ""}`}
                      >
                        {editingPromptVersionTitleId === version.id ? (
                          <div className="prompt-version-title-editor">
                            <span className="prompt-version-label">{version.label}</span>
                            <input
                              value={promptVersionTitleDraft}
                              onChange={(event) => changePromptVersionTitleDraft(version, event.currentTarget.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  commitPromptVersionTitleEdit(version.id);
                                } else if (event.key === "Escape") {
                                  event.preventDefault();
                                  cancelPromptVersionTitleEdit();
                                }
                              }}
                              autoFocus
                              aria-label={`${version.label} 版本标题`}
                            />
                            <button
                              type="button"
                              onClick={() => commitPromptVersionTitleEdit(version.id)}
                              title="保存标题"
                              aria-label={`保存 ${version.label} 标题`}
                            >
                              <Check size={12} />
                            </button>
                            <button
                              type="button"
                              onClick={cancelPromptVersionTitleEdit}
                              title="取消修改"
                              aria-label={`取消修改 ${version.label} 标题`}
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              type="button"
                              role="menuitem"
                              className="prompt-version-select"
                              onClick={() => selectPromptVersion(version)}
                            >
                              <span className="prompt-version-label">{version.label}</span>
                              <span className="prompt-version-summary">
                                <strong>{version.id === activePromptVersion?.id
                                  ? `当前 · ${version.title || "未命名版本"}`
                                  : version.title || "未命名版本"}</strong>
                              </span>
                              {version.id === bestPromptVersionId && (
                                <Star size={12} fill="currentColor" aria-label="最佳版本" />
                              )}
                            </button>
                            <button
                              type="button"
                              className="prompt-version-edit"
                              onClick={() => beginPromptVersionTitleEdit(version)}
                              title={`修改 ${version.label} 标题`}
                              aria-label={`修改 ${version.label} 标题`}
                            >
                              <Pencil size={12} />
                            </button>
                            <button
                              type="button"
                              className="prompt-version-delete"
                              onClick={() => void deletePromptVersion(version.id)}
                              title={`删除 ${version.label}`}
                              aria-label={`删除 ${version.label}`}
                            >
                              <Trash2 size={12} />
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <button
              type="button"
              className={`nodrag prompt-version-best ${activePromptVersion?.id === bestPromptVersionId ? "is-active" : ""}`}
              onClick={markActivePromptVersionBest}
              disabled={!activePromptVersion}
              title={!activePromptVersion
                ? "尚未创建版本"
                : activePromptVersion.id === bestPromptVersionId
                  ? "当前版本已标记为最佳"
                  : "标记当前版本为最佳"}
              aria-label="标记当前版本为最佳"
            >
              <Star size={13} fill={activePromptVersion?.id === bestPromptVersionId ? "currentColor" : "none"} />
            </button>
          </div>
          <div className="text-editor-shell prompt-version-editor-shell">
            {nodeMarkdownPreview ? (
              <MarkdownPreview source={textDraft} className="node-markdown-preview nowheel" />
            ) : (
              <textarea
                className={`nodrag node-editor ${textEditorFocused ? "nowheel" : ""}`}
                value={textDraft}
                onChange={changeText}
                onKeyDown={(event) => saveTextWithShortcut(event, id, activePromptVersion?.id)}
                onFocus={() => setTextEditorFocused(true)}
                onBlur={() => setTextEditorFocused(false)}
                aria-label={`${activePromptVersion?.label ?? "当前版本"}提示词内容`}
                spellCheck={false}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="text-editor-shell">
          {nodeMarkdownPreview ? (
            <MarkdownPreview source={textDraft} className="node-markdown-preview nowheel" />
          ) : (
            <textarea
              className={`nodrag node-editor ${textEditorFocused ? "nowheel" : ""}`}
              value={textDraft}
              onChange={changeText}
              onKeyDown={(event) => saveTextWithShortcut(event, id, activePromptVersion?.id)}
              onFocus={() => setTextEditorFocused(true)}
              onBlur={() => setTextEditorFocused(false)}
              aria-label="文本内容"
              spellCheck={false}
            />
          )}
        </div>
      ))}
      {isFolder && (
        <button
          type="button"
          className="nodrag folder-node-body"
          onClick={() => onOpenFolder(id)}
          title={`打开目录“${record.title}”`}
          aria-label={`打开目录“${record.title}”`}
        >
          <span className="folder-node-icon"><FolderOpen size={40} /></span>
          <strong>进入子画布</strong>
          <small>{typeof record.content.nodeCount === "number" ? `${record.content.nodeCount} 个节点` : "打开目录"}</small>
        </button>
      )}
      {(isImage || isAudioAsset || isVideoAsset || isGeneratedVideo) && (
        <div
          className={isVideoAsset ? "nodrag media-node-body" : "media-node-body"}
          onMouseEnter={isVideoAsset || isGeneratedVideo ? playMediaVideoOnHover : undefined}
          onMouseLeave={isVideoAsset || isGeneratedVideo ? pauseMediaVideoOnLeave : undefined}
        >
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
              <audio className="nodrag nowheel" src={convertFileSrc(assetPath)} controls preload="metadata" />
            </div>
          ) : assetPath && isVideoAsset ? (
            <video
              src={convertFileSrc(assetPath)}
              preload="metadata"
              playsInline
              onLoadedMetadata={(event) => applyNaturalMediaRatio(
                event.currentTarget.videoWidth,
                event.currentTarget.videoHeight,
              )}
            />
          ) : generatedVideoUrl && isGeneratedVideo ? (
            <>
              {isUnplayedGeneratedVideo && (
                <span className="generated-video-new-badge" aria-label="新生成且尚未完整播放">
                  NEW
                </span>
              )}
              <video
                ref={generatedVideoRef}
                src={generatedVideoUrl}
                preload="metadata"
                playsInline
                onEnded={markGeneratedVideoFullyPlayed}
                onTimeUpdate={(event) => markGeneratedVideoAtPlaybackEnd(event.currentTarget)}
                onLoadedMetadata={(event) => applyNaturalMediaRatio(
                  event.currentTarget.videoWidth,
                  event.currentTarget.videoHeight,
                )}
              />
              {validationStatus && validationMessage && (
                <div className={`generated-video-execution is-${validationStatus}`}>
                  <span title={validationMessage}>{validationMessage}</span>
                  {validationStatus === "invalid" && (
                    <button
                      type="button"
                      className="nodrag video-error-copy-button"
                      onClick={copyValidationError}
                      title={errorCopied ? "已复制完整报错信息" : "复制完整报错信息"}
                      aria-label={errorCopied ? "已复制完整报错信息" : "复制完整报错信息"}
                    >
                      {errorCopied ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                  )}
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
                <span
                  className="generated-video-placeholder-blob blob-blue"
                  style={generatedPlaceholderPositionStyle(id, 0)}
                />
                <span
                  className="generated-video-placeholder-blob blob-mist"
                  style={generatedPlaceholderPositionStyle(id, 1)}
                />
                <span
                  className="generated-video-placeholder-blob blob-sky"
                  style={generatedPlaceholderPositionStyle(id, 2)}
                />
                <span
                  className="generated-video-placeholder-blob blob-shadow"
                  style={generatedPlaceholderPositionStyle(id, 3)}
                />
              </div>
              <div className="generated-video-placeholder-status">
                <span className="generated-video-placeholder-message" title={validationMessage}>
                  {validationMessage || (placeholderActive ? "正在等待 ComfyUI 返回视频…" : "生成任务未完成")}
                </span>
                {placeholderActive && (
                  <output className="generated-video-placeholder-percent">
                    {executionProgress === null ? "处理中" : `${Math.round(executionProgress)}%`}
                  </output>
                )}
              </div>
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
      {isReferenceAsset && (
        <div className="nodrag material-note-field">
          <label>
            <span>素材备注</span>
            <input
              className="nodrag nowheel"
              value={materialNoteDraft}
              onPointerDown={(event) => event.stopPropagation()}
              onFocus={() => setMaterialNoteFocused(true)}
              onChange={(event) => setMaterialNoteDraft(event.currentTarget.value)}
              onBlur={finishMaterialNoteEdit}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setMaterialNoteDraft(materialNoteFromContent(record.content));
                  event.currentTarget.blur();
                }
              }}
              aria-label="素材备注"
              spellCheck={false}
            />
          </label>
        </div>
      )}
      {isGeneratedVideo && (
        <footer className="generated-video-footer">
          <div className="generated-video-footer-status">
            <span className={`source-dot ${isSecondaryPreview ? "is-secondary" : ""}`} />
            <span title={generatedVideoFooterStatus}>{generatedVideoFooterStatus}</span>
          </div>
          <span className="generated-video-footer-spacer" />
          <div className="generated-video-actions" aria-label="视频预览操作">
            {generatedVideoUrl && (
              <button
                type="button"
                className={`nodrag node-action generated-video-secondary-action ${executionRunning ? "is-cancel" : ""}`}
                disabled={executionCancelling}
                onClick={(event) => {
                  if (executionRunning) void onCancelExecution(id);
                  else if (event.ctrlKey) onConfigureSecondarySample(id);
                  else void onSecondarySample(id);
                }}
                title={executionRunning ? "取消这次二采" : "点击直接二采；Ctrl+点击可调整二采参数"}
                aria-label={executionRunning ? "取消二采" : "二采当前视频"}
              >
                {executionRunning
                  ? <Square size={11} fill="currentColor" />
                  : <Sparkles size={12} />}
              </button>
            )}
            {generatedVideoUrl && !isSecondaryPreview && (
              <button
                type="button"
                className="nodrag node-action generated-video-regenerate-action"
                onClick={(event) => {
                  if (event.ctrlKey) onConfigureRegenerateVideo(id);
                  else void onRegenerateVideo(id);
                }}
                title="点击直接重新生成；Ctrl+点击可选择提示词版本并调整参数"
                aria-label="重新生成该视频"
              >
                <RotateCcw size={12} />
              </button>
            )}
            {generatedVideoUrl && generatedVideoSnapshot && (
              <button
                type="button"
                className="nodrag node-action generated-video-locate-prompt-action"
                onClick={(event) => onLocatePrompt(id, event.ctrlKey ? "generator" : "prompt")}
                title="点击定位提示词；Ctrl+点击定位关联的视频生成节点"
                aria-label="定位提示词或视频生成节点"
              >
                <LocateFixed size={12} />
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
                  onClick={() => {
                    setGeneratedInfoOpen(false);
                    setPreviewColorMenuOpen((open) => !open);
                  }}
                  title="选择视频预览颜色"
                  aria-label="选择视频预览颜色"
                  aria-expanded={previewColorMenuOpen}
                >
                  <Palette size={13} />
                </button>
                {previewColorMenuOpen && (
                  <div className="node-preview-color-presets" role="menu" aria-label="视频预览颜色预设">
                    {previewColorPresets.map((preset) => (
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
          {generatedVideoUrl && (
            <button
              type="button"
              className="nodrag node-action"
              onClick={() => void onRevealGeneratedVideo(id)}
              title="在 Windows 资源管理器中定位视频"
              aria-label="在 Windows 资源管理器中定位视频"
            >
              <FolderOpen size={13} />
            </button>
          )}
          {generatedVideoUrl && (
            <button
              type="button"
              className="nodrag node-action generated-video-fullscreen-button"
              onClick={playGeneratedVideoFullscreen}
              title="全屏播放视频"
              aria-label="全屏播放视频"
            >
              <Maximize2 size={13} />
            </button>
          )}
          {generatedVideoSnapshot && (
            <div ref={generatedInfoRef} className="nodrag generated-video-info-control">
              <button
                type="button"
                className={`node-action generated-video-info-button ${generatedInfoOpen ? "is-active" : ""}`}
                onClick={() => {
                  setPreviewColorMenuOpen(false);
                  setGeneratedInfoOpen((open) => !open);
                }}
                title="查看生成信息"
                aria-label="查看生成信息"
                aria-expanded={generatedInfoOpen}
              >
                <Info size={13} />
              </button>
              {generatedInfoOpen && (
                <aside
                  className="generated-video-info-panel"
                  aria-label="视频生成信息"
                  onWheelCapture={(event) => {
                    if (!event.ctrlKey) event.stopPropagation();
                  }}
                >
                  <header>
                    <div>
                      <strong>生成信息</strong>
                      <span>{isSecondaryPreview ? "二采预览" : "一采预览"}</span>
                    </div>
                  </header>
                  <section className="generated-video-info-summary">
                    <div>
                      <span>Seed</span>
                      <strong title={generatedVideoSeed || "未记录"}>{generatedVideoSeed || "未记录"}</strong>
                      <button
                        type="button"
                        disabled={!generatedVideoSeed}
                        onClick={copyGeneratedSeed}
                        title={copied ? "Seed 已复制" : "复制 Seed"}
                        aria-label={copied ? "Seed 已复制" : "复制 Seed"}
                      >
                        {copied ? <Check size={12} /> : <Copy size={12} />}
                      </button>
                    </div>
                    <div>
                      <span>基础</span>
                      <strong>{generatedVideoSnapshot.durationSeconds} 秒 · {generatedVideoSnapshot.aspectRatio}</strong>
                    </div>
                    <div>
                      <span>耗时</span>
                      <strong>{formattedGenerationElapsed(record.content)}</strong>
                    </div>
                    <div>
                      <span>模型</span>
                      <strong title={generatedVideoSnapshot.diffusionModelName}>
                        {h3DiffusionModelDisplayName(generatedVideoSnapshot.diffusionModelName)}
                      </strong>
                    </div>
                  </section>
                  <section className="generated-video-stage-info">
                    <h4>一采</h4>
                    <dl>
                      <dt>分辨率</dt><dd>{generatedVideoSnapshot.primaryResolutionMegapixels.toFixed(1)} MP</dd>
                      <dt>参考图模式</dt>
                      <dd>{generatedVideoSnapshot.refImageSizeRecorded === false ? "未记录" : generatedVideoSnapshot.refImageSize}</dd>
                      <dt>视频 / 音频 Steps</dt><dd>{generatedVideoSnapshot.primaryVideoSteps} / {generatedVideoSnapshot.primaryAudioSteps}</dd>
                      <dt>LoRA</dt>
                      <dd title={generatedVideoSnapshot.loraName || "一采 Bypass"}>
                        {generatedVideoSnapshot.loraBypassed
                          ? "未应用（Bypass）"
                          : h3LoraDisplayName(generatedVideoSnapshot.loraName)}
                      </dd>
                      <dt>LoRA 强度</dt>
                      <dd>
                        {generatedVideoSnapshot.loraBypassed
                          ? "—"
                          : generatedVideoSnapshot.loraStrengthRecorded === false
                            ? "未记录"
                            : `×${generatedVideoSnapshot.loraStrength.toFixed(2)}`}
                      </dd>
                      <dt>亮度 / 对比度 / 饱和度</dt>
                      <dd>{generatedVideoSnapshot.primaryBrightness.toFixed(2)} / {generatedVideoSnapshot.primaryContrast.toFixed(2)} / {generatedVideoSnapshot.primarySaturation.toFixed(2)}</dd>
                    </dl>
                  </section>
                  {isSecondaryPreview && (
                    <section className="generated-video-stage-info">
                      <h4>二采</h4>
                      <dl>
                        <dt>分辨率</dt><dd>{generatedVideoSnapshot.secondaryResolutionMegapixels.toFixed(1)} MP</dd>
                        <dt>参考图模式</dt>
                        <dd>{generatedVideoSnapshot.refImageSizeRecorded === false ? "未记录" : generatedVideoSnapshot.refImageSize}</dd>
                        <dt>视频 Steps</dt><dd>{generatedVideoSnapshot.secondarySchedulerSteps}</dd>
                        <dt>LoRA</dt>
                        <dd title={generatedVideoSnapshot.secondaryLoraBypassed
                          ? "—"
                          : generatedVideoSnapshot.secondaryLoraName}>
                          {generatedVideoSnapshot.secondaryLoraBypassed
                            ? "—"
                            : h3LoraDisplayName(generatedVideoSnapshot.secondaryLoraName)}
                        </dd>
                        <dt>LoRA 强度</dt>
                        <dd>
                          {generatedVideoSnapshot.secondaryLoraBypassed
                            ? "—"
                            : generatedVideoSnapshot.secondaryLoraStrengthRecorded === false
                              ? "未记录"
                              : `×${generatedVideoSnapshot.secondaryLoraStrength.toFixed(2)}`}
                        </dd>
                        <dt>亮度 / 对比度 / 饱和度</dt>
                        <dd>{generatedVideoSnapshot.secondaryBrightness.toFixed(2)} / {generatedVideoSnapshot.secondaryContrast.toFixed(2)} / {generatedVideoSnapshot.secondarySaturation.toFixed(2)}</dd>
                      </dl>
                    </section>
                  )}
                  <section className="generated-video-prompt-info">
                    <div>
                      <h4 title={generatedVideoPromptTitle || "提示词"}>
                        提示词{generatedVideoPromptTitle ? ` ${generatedVideoPromptTitle}` : ""}
                      </h4>
                      <button
                        type="button"
                        disabled={!generatedVideoPrompt && !generatedVideoPromptInformation}
                        onClick={() => {
                          setGeneratedInfoOpen(false);
                          setGeneratedPromptDialogOpen(true);
                        }}
                        title="在大窗中查看提示词和备注"
                        aria-label="在大窗中查看提示词和备注"
                      >
                        <Maximize2 size={12} />
                      </button>
                      <button
                        type="button"
                        disabled={!generatedVideoPrompt}
                        onClick={copyGeneratedPrompt}
                        title={promptCopied ? "提示词已复制" : "复制提示词"}
                        aria-label={promptCopied ? "提示词已复制" : "复制提示词"}
                      >
                        {promptCopied ? <Check size={12} /> : <Copy size={12} />}
                      </button>
                    </div>
                    <p title={generatedVideoPrompt}>{generatedVideoPrompt || "未记录提示词"}</p>
                  </section>
                </aside>
              )}
            </div>
          )}
          {generatedPromptDialogOpen && createPortal(
            <div
              className="expanded-editor-backdrop"
              onMouseDown={() => setGeneratedPromptDialogOpen(false)}
            >
              <section
                className="expanded-editor-dialog is-prompt-version is-readonly"
                role="dialog"
                aria-modal="true"
                aria-label="生成时提示词与备注"
                onMouseDown={(event) => event.stopPropagation()}
              >
                <header className="expanded-editor-header">
                  <span className="node-kind-icon"><FileText size={15} /></span>
                  <div>
                    <strong>{generatedVideoPromptTitle || "生成时提示词"}</strong>
                    <span>生成时快照 · 只读</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setGeneratedPromptDialogOpen(false)}
                    title="关闭"
                    aria-label="关闭提示词查看窗口"
                  >
                    <X size={17} />
                  </button>
                </header>
                <div className="expanded-prompt-layout">
                  <section className="expanded-prompt-pane is-prompt">
                    <header>
                      <strong>提示词</strong>
                      <span>{generatedVideoPrompt.length.toLocaleString()} 字符</span>
                    </header>
                    <textarea
                      className="expanded-text-editor"
                      value={generatedVideoPrompt}
                      readOnly
                      spellCheck={false}
                      placeholder="未记录提示词"
                      aria-label="生成时提示词，只读"
                    />
                  </section>
                  <section className="expanded-prompt-pane is-information">
                    <header>
                      <strong>备注</strong>
                      <span>{generatedVideoPromptInformation.length.toLocaleString()} 字符</span>
                    </header>
                    <textarea
                      className="expanded-text-editor"
                      value={generatedVideoPromptInformation}
                      readOnly
                      spellCheck={false}
                      placeholder="未记录中文信息"
                      aria-label="生成时备注，只读"
                    />
                  </section>
                </div>
              </section>
            </div>,
            document.body,
          )}
          </div>
        </footer>
      )}
      {isVideoGeneration && (
        <div className="nodrag video-node-body has-media">
          <div className="video-workflow-module-select">
            <span>生成方案</span>
            <div ref={workflowModuleControlRef} className="video-lora-select video-workflow-module-dropdown">
              <button
                type="button"
                className="nodrag nowheel video-lora-select-toggle"
                disabled={!availableWorkflowModules.length}
                aria-haspopup="menu"
                aria-expanded={workflowModuleMenuOpen}
                aria-label="当前节点的工作流方案"
                title={selectedNodeWorkflowModule
                  ? `${selectedNodeWorkflowModule.name} · ${selectedNodeWorkflowModule.revision}`
                  : availableWorkflowModules.length ? "请选择方案" : "未配置可用方案"}
                onClick={() => {
                  setAspectRatioMenuOpen(false);
                  setLoraMenuOpen(false);
                  setSecondaryLoraMenuOpen(false);
                  setWorkflowModuleMenuOpen((open) => !open);
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <span>
                  {selectedNodeWorkflowModule
                    ? `${selectedNodeWorkflowModule.name} · ${selectedNodeWorkflowModule.revision}`
                    : availableWorkflowModules.length ? "请选择方案" : "未配置可用方案"}
                </span>
                <span className="video-lora-select-arrow" aria-hidden="true">▾</span>
              </button>
              {workflowModuleMenuOpen && (
                <div className="video-lora-select-menu video-workflow-module-menu" role="menu" aria-label="视频生成方案">
                  {availableWorkflowModules.map((module) => (
                    <button
                      key={module.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selectedNodeWorkflowModule?.id === module.id}
                      className={selectedNodeWorkflowModule?.id === module.id ? "is-active" : ""}
                      title={`${module.name} · ${module.revision}`}
                      onClick={() => {
                        onChange(id, {
                          content: {
                            ...record.content,
                            generationMode: module.variant as VideoGenerationMode,
                            workflowModuleId: module.id,
                            workflowModuleRevision: module.revision,
                            generationDiffusionModelName: module.defaults.diffusionModelName,
                            generationLoraName: module.defaults.loraName,
                            generationLoraStrength: module.defaults.loraStrength,
                            generationPrimaryVideoSteps: module.defaults.primaryVideoSteps,
                            generationSecondarySchedulerSteps: module.defaults.secondarySchedulerSteps,
                            status: "idle",
                            validationMessage: "",
                          },
                        });
                        setWorkflowModuleMenuOpen(false);
                      }}
                    >
                      {module.name} · {module.revision}
                    </button>
                  ))}
                </div>
              )}
            </div>
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
                value={displayedVideoDuration ?? 2}
                disabled={isStoryboardReferenceCompiler}
                onChange={(event) => {
                  if (isStoryboardReferenceCompiler) return;
                  onChange(id, {
                    content: {
                      ...record.content,
                      generationDuration: Number(event.currentTarget.value),
                      status: "idle",
                      validationMessage: "",
                    },
                  });
                }}
                onPointerDown={(event) => event.stopPropagation()}
                aria-label={isStoryboardReferenceCompiler ? "当前分镜提示词时长，只读" : "生成时长"}
              />
              <output title={isStoryboardReferenceCompiler
                ? "由当前高亮的生成提示词决定；请在生成提示词节点中调整"
                : undefined}
              >{displayedVideoDuration === null ? "未设置" : `${displayedVideoDuration} 秒`}</output>
            </label>
            <div ref={aspectRatioControlRef} className="video-aspect-ratio-inline">
              <button
                type="button"
                className="nodrag nowheel video-aspect-ratio-toggle"
                aria-haspopup="menu"
                aria-expanded={aspectRatioMenuOpen}
                onClick={() => {
                  setLoraMenuOpen(false);
                  setSecondaryLoraMenuOpen(false);
                  setAspectRatioMenuOpen((open) => !open);
                }}
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
          <div className={`video-lora-control is-primary ${h3LoraBypassed ? "is-bypassed" : ""} ${loraMenuOpen ? "is-menu-open" : ""}`}>
            <span>1采 LoRA</span>
            <div ref={loraControlRef} className="video-lora-select">
              <button
                type="button"
                className="nodrag nowheel video-lora-select-toggle"
                disabled={h3LoraBypassed || !selectableH3Loras.length}
                aria-haspopup="menu"
                aria-expanded={loraMenuOpen}
                title={availableH3LoraName ?? (h3LoraName
                  ? "所选一采 LoRA 已不在 MinimaxH3 目录中"
                  : "一采 LoRA 未选择")}
                onClick={() => {
                  setAspectRatioMenuOpen(false);
                  setWorkflowModuleMenuOpen(false);
                  setSecondaryLoraMenuOpen(false);
                  setLoraMenuOpen((open) => !open);
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <span>{availableH3LoraName
                  ? h3LoraDisplayName(availableH3LoraName)
                  : h3LoraName ? "未找到 LoRA" : "未选择 LoRA"}</span>
                <span className="video-lora-select-arrow" aria-hidden="true">▾</span>
              </button>
              {loraMenuOpen && !h3LoraBypassed && (
                <div className="video-lora-select-menu" role="menu" aria-label="MiniMax H3 LoRA">
                  {selectableH3Loras.map((lora) => (
                    <button
                      key={lora}
                      type="button"
                      role="menuitemradio"
                      aria-checked={sameH3LoraName(h3LoraName, lora)}
                      className={sameH3LoraName(h3LoraName, lora) ? "is-active" : ""}
                      title={lora}
                      onClick={() => {
                        onH3LoraPreferenceChange({ loraName: lora, loraStrength: h3LoraStrength });
                        onChange(id, {
                          content: {
                            ...record.content,
                            generationLoraName: lora,
                            status: "idle",
                            validationMessage: "",
                          },
                        });
                        setLoraMenuOpen(false);
                      }}
                    >
                      {h3LoraDisplayName(lora)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <input
              className="video-parameter-range"
              type="range"
              disabled={h3LoraBypassed}
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
            <label className="video-lora-strength" title="LoRA 权重">
              <span aria-hidden="true">×</span>
              <CompactDecimalInput
                value={h3LoraStrength}
                min={0}
                max={2}
                disabled={h3LoraBypassed}
                ariaLabel="手动输入一采 LoRA 权重"
                onChange={(loraStrength) => {
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
              />
            </label>
            <label className="video-lora-steps" title="一采 Video Steps">
              <span>S</span>
              <CompactIntegerInput
                value={primaryVideoSteps}
                min={1}
                max={primaryVideoStepsMaximum}
                ariaLabel="一采 Video Steps"
                onChange={(value) => {
                  onChange(id, {
                    content: {
                      ...record.content,
                      generationPrimaryVideoSteps: value,
                      status: "idle",
                      validationMessage: "",
                    },
                  });
                }}
              />
            </label>
            <button
              type="button"
              className="video-lora-bypass-switch"
              role="switch"
              aria-checked={!h3LoraBypassed}
              aria-label="启用一采 LoRA"
              title={h3LoraBypassed ? "LoRA 已关闭，点击启用" : "LoRA 已启用，点击关闭"}
              onClick={() => {
                setLoraMenuOpen(false);
                onH3LoraPreferenceChange({ loraBypassed: !h3LoraBypassed });
                onChange(id, {
                  content: {
                    ...record.content,
                    generationLoraBypassed: !h3LoraBypassed,
                    status: "idle",
                    validationMessage: "",
                  },
                });
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <span aria-hidden="true" />
            </button>
          </div>
          <div className={`video-lora-control is-secondary ${h3SecondaryLoraBypassed ? "is-bypassed" : ""} ${secondaryLoraMenuOpen ? "is-menu-open" : ""}`}>
            <span>2采 LoRA</span>
            <div ref={secondaryLoraControlRef} className="video-lora-select">
              <button
                type="button"
                className="nodrag nowheel video-lora-select-toggle"
                disabled={!selectableH3Loras.length}
                aria-haspopup="menu"
                aria-expanded={secondaryLoraMenuOpen}
                title={availableH3SecondaryLoraName ?? (h3SecondaryLoraName
                  ? "所选二采 LoRA 已不在 MinimaxH3 目录中"
                  : "二采 LoRA 未设置")}
                onClick={() => {
                  setAspectRatioMenuOpen(false);
                  setWorkflowModuleMenuOpen(false);
                  setLoraMenuOpen(false);
                  setSecondaryLoraMenuOpen((open) => !open);
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <span>{availableH3SecondaryLoraName
                  ? h3LoraDisplayName(availableH3SecondaryLoraName)
                  : h3SecondaryLoraName ? "未找到 LoRA" : "未选择 LoRA"}</span>
                <span className="video-lora-select-arrow" aria-hidden="true">▾</span>
              </button>
              {secondaryLoraMenuOpen && (
                <div className="video-lora-select-menu" role="menu" aria-label="MiniMax H3 二采 LoRA">
                  {selectableH3Loras.map((lora) => (
                    <button
                      key={lora}
                      type="button"
                      role="menuitemradio"
                      aria-checked={sameH3LoraName(h3SecondaryLoraName, lora)}
                      className={sameH3LoraName(h3SecondaryLoraName, lora) ? "is-active" : ""}
                      title={lora}
                      onClick={() => {
                        onH3LoraPreferenceChange({
                          secondaryLoraName: lora,
                          secondaryLoraStrength: h3SecondaryLoraStrength,
                          secondaryLoraBypassed: false,
                        });
                        onChange(id, {
                          content: {
                            ...record.content,
                            generationSecondaryLoraName: lora,
                            generationSecondaryLoraStrength: h3SecondaryLoraStrength,
                            generationSecondaryLoraBypassed: false,
                            status: "idle",
                            validationMessage: "",
                          },
                        });
                        setSecondaryLoraMenuOpen(false);
                      }}
                    >
                      {h3LoraDisplayName(lora)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <input
              className="video-parameter-range"
              type="range"
              disabled={h3SecondaryLoraBypassed}
              min="0"
              max="2"
              step="0.05"
              value={h3SecondaryLoraStrength}
              title={`二采 LoRA 权重：${h3SecondaryLoraStrength.toFixed(2)}`}
              aria-label="二采 LoRA 权重"
              onChange={(event) => {
                const secondaryLoraStrength = Number(event.currentTarget.value);
                onH3LoraPreferenceChange({ secondaryLoraStrength });
                onChange(id, {
                  content: {
                    ...record.content,
                    generationSecondaryLoraStrength: secondaryLoraStrength,
                    status: "idle",
                    validationMessage: "",
                  },
                });
              }}
              onPointerDown={(event) => event.stopPropagation()}
            />
            <label className="video-lora-strength" title="二采 LoRA 权重">
              <span aria-hidden="true">×</span>
              <CompactDecimalInput
                value={h3SecondaryLoraStrength}
                min={0}
                max={2}
                disabled={h3SecondaryLoraBypassed}
                ariaLabel="手动输入二采 LoRA 权重"
                onChange={(secondaryLoraStrength) => {
                  onH3LoraPreferenceChange({ secondaryLoraStrength });
                  onChange(id, {
                    content: {
                      ...record.content,
                      generationSecondaryLoraStrength: secondaryLoraStrength,
                      status: "idle",
                      validationMessage: "",
                    },
                  });
                }}
              />
            </label>
            <label className="video-lora-steps" title="二采基本调度 Steps">
              <span>S</span>
              <CompactIntegerInput
                value={secondarySchedulerSteps}
                min={1}
                max={10000}
                ariaLabel="二采基本调度 Steps"
                onChange={(value) => {
                  onChange(id, {
                    content: {
                      ...record.content,
                      generationSecondarySchedulerSteps: value,
                      status: "idle",
                      validationMessage: "",
                    },
                  });
                }}
              />
            </label>
            <button
              type="button"
              className="video-lora-bypass-switch"
              role="switch"
              aria-checked={!h3SecondaryLoraBypassed}
              aria-label="启用二采 LoRA"
              title={h3SecondaryLoraBypassed
                ? "二采 LoRA 已关闭，点击启用"
                : "二采 LoRA 已启用，点击关闭"}
              onClick={() => {
                setSecondaryLoraMenuOpen(false);
                onH3LoraPreferenceChange({
                  secondaryLoraBypassed: !h3SecondaryLoraBypassed,
                });
                onChange(id, {
                  content: {
                    ...record.content,
                    generationSecondaryLoraBypassed: !h3SecondaryLoraBypassed,
                    status: "idle",
                    validationMessage: "",
                  },
                });
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <span aria-hidden="true" />
            </button>
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
            <div className={`video-input-group-heading ${textInputs.length ? "has-text-clear" : ""}`}>
              <FileText size={13} />
              <strong>文本</strong>
              <span>{textInputs.length}</span>
              {textInputs.length > 0 && (
                <button
                  type="button"
                  className="nodrag video-text-clear-button"
                  disabled={clearingTexts}
                  title="清除当前视频节点的全部文本连接"
                  aria-label={`清除全部 ${textInputs.length} 个文本连接`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    setTextIdsPendingClear(textInputs.map((input) => input.id));
                  }}
                >
                  <Trash2 size={12} aria-hidden="true" />
                </button>
              )}
            </div>
            <ol className="video-input-list" role="listbox" aria-label="文本输入">
              {textInputs.length ? (
                textInputs.map((input, index) => {
                  const inputText = textFromContent(input.content).trim().replace(/\s+/g, " ");
                  return (
                    <li
                      key={input.id}
                      data-text-input-id={input.id}
                      className={`video-input-item is-text-input ${activeTextInputId === input.id ? "is-active-text" : ""} ${draggedTextId === input.id ? "is-dragging" : ""} ${dragOverTextId === input.id ? "is-drop-target" : ""}`}
                      role="option"
                      aria-selected={activeTextInputId === input.id}
                      tabIndex={0}
                      title={activeTextInputId === input.id ? "当前提示词" : "点击设为当前提示词"}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
                        event.currentTarget.setPointerCapture(event.pointerId);
                        textRowDragRef.current = {
                          pointerId: event.pointerId,
                          inputId: input.id,
                          startX: event.clientX,
                          startY: event.clientY,
                          moved: false,
                        };
                        suppressTextInputClickRef.current = false;
                        setDraggedTextId(input.id);
                        setDragOverTextId(null);
                      }}
                      onPointerMove={(event) => {
                        const drag = textRowDragRef.current;
                        if (
                          !drag
                          || drag.pointerId !== event.pointerId
                          || drag.inputId !== input.id
                          || !event.currentTarget.hasPointerCapture(event.pointerId)
                        ) return;
                        event.stopPropagation();
                        if (!drag.moved) {
                          const distance = Math.hypot(
                            event.clientX - drag.startX,
                            event.clientY - drag.startY,
                          );
                          if (distance < 4) return;
                          drag.moved = true;
                        }
                        event.preventDefault();
                        const targetId = textInputIdAtPoint(event.clientX, event.clientY);
                        setDragOverTextId(targetId && targetId !== input.id ? targetId : null);
                        if (targetId && targetId !== input.id) moveTextInputTo(input.id, targetId);
                      }}
                      onPointerUp={(event) => {
                        const drag = textRowDragRef.current;
                        if (
                          !drag
                          || drag.pointerId !== event.pointerId
                          || drag.inputId !== input.id
                          || !event.currentTarget.hasPointerCapture(event.pointerId)
                        ) return;
                        event.stopPropagation();
                        if (drag.moved) {
                          event.preventDefault();
                          moveTextInputTo(
                            input.id,
                            textInputIdAtPoint(event.clientX, event.clientY),
                          );
                          suppressTextInputClickRef.current = true;
                          window.setTimeout(() => {
                            suppressTextInputClickRef.current = false;
                          }, 0);
                        }
                        event.currentTarget.releasePointerCapture(event.pointerId);
                        textRowDragRef.current = null;
                        setDraggedTextId(null);
                        setDragOverTextId(null);
                      }}
                      onPointerCancel={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                          event.currentTarget.releasePointerCapture(event.pointerId);
                        }
                        textRowDragRef.current = null;
                        suppressTextInputClickRef.current = false;
                        setDraggedTextId(null);
                        setDragOverTextId(null);
                      }}
                      onLostPointerCapture={() => {
                        textRowDragRef.current = null;
                        setDraggedTextId(null);
                        setDragOverTextId(null);
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        if ((event.target as HTMLElement).closest("button")) return;
                        if (suppressTextInputClickRef.current) {
                          suppressTextInputClickRef.current = false;
                          return;
                        }
                        onActivateTextInput(id, input.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        onActivateTextInput(id, input.id);
                      }}
                    >
                      <button
                        type="button"
                        className="nodrag video-input-index video-text-order-handle"
                        aria-label={`调整第 ${index + 1} 个文本的顺序`}
                        title="按住拖动调整文本顺序"
                        onPointerDown={(event) => {
                          if (event.button !== 0) return;
                          event.preventDefault();
                          event.stopPropagation();
                          event.currentTarget.setPointerCapture(event.pointerId);
                          setDraggedTextId(input.id);
                          setDragOverTextId(null);
                        }}
                        onPointerMove={(event) => {
                          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                          event.preventDefault();
                          event.stopPropagation();
                          const targetId = textInputIdAtPoint(event.clientX, event.clientY);
                          setDragOverTextId(targetId && targetId !== input.id ? targetId : null);
                          if (targetId && targetId !== input.id) moveTextInputTo(input.id, targetId);
                        }}
                        onPointerUp={(event) => {
                          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                          event.preventDefault();
                          event.stopPropagation();
                          moveTextInputTo(
                            input.id,
                            textInputIdAtPoint(event.clientX, event.clientY),
                          );
                          event.currentTarget.releasePointerCapture(event.pointerId);
                          setDraggedTextId(null);
                          setDragOverTextId(null);
                        }}
                        onPointerCancel={(event) => {
                          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                            event.currentTarget.releasePointerCapture(event.pointerId);
                          }
                          setDraggedTextId(null);
                          setDragOverTextId(null);
                        }}
                        onLostPointerCapture={() => {
                          setDraggedTextId(null);
                          setDragOverTextId(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowUp" && index > 0) {
                            event.preventDefault();
                            moveTextInputTo(input.id, textInputs[index - 1].id);
                          } else if (event.key === "ArrowDown" && index < textInputs.length - 1) {
                            event.preventDefault();
                            moveTextInputTo(input.id, textInputs[index + 1].id);
                          }
                        }}
                      >
                        {index + 1}
                      </button>
                      <span className="video-input-preview is-text">
                        <FileText size={16} />
                      </span>
                      <span className="video-input-copy">
                        <strong title={input.title}>
                          {input.title || "未命名文本"}
                          {activePromptVersionLabelFromContent(input.content)
                            ? ` · ${activePromptVersionLabelFromContent(input.content)}`
                            : ""}
                        </strong>
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
          {isStoryboardReferenceCompiler && (
            <section className={`storyboard-reference-panel ${activeStoryboardSelection?.error ? "is-invalid" : "is-valid"}`}>
              <header>
                <span className="storyboard-reference-panel-title">
                  <Sparkles size={13} aria-hidden="true" />
                  <strong>智能 H3 分镜提示词</strong>
                </span>
                <span className="storyboard-reference-scene">
                  {activeStoryboardSelection?.selection?.sceneKey || "未识别分镜"}
                </span>
              </header>
              <div
                className="storyboard-reference-status"
                title={activeStoryboardSelection?.error || undefined}
              >
                {!activeStoryboardPrompt
                  ? "连接提示词后按其内部素材选择筛选实际提交素材"
                  : activeStoryboardSelection?.error
                    ? activeStoryboardSelection.error
                    : `本次提交 ${activeStoryboardSelection?.selectedMedia.length ?? 0} 项，屏蔽 ${activeStoryboardSelection?.skippedCount ?? 0} 项`}
              </div>
              {Boolean(activeStoryboardSelection?.mappings.length) && (
                <ol className="storyboard-reference-mappings">
                  {activeStoryboardSelection!.mappings.map((mapping) => {
                    const globalIndex = mediaInputs.findIndex((input) => input.id === mapping.sourceId) + 1;
                    return (
                      <li key={mapping.sourceId} title={`${mapping.title} · ${mapping.role}`}>
                        <span>素材 {globalIndex}</span>
                        <strong>→ {mapping.label}</strong>
                        {mapping.subjectLabel && <em>/ {mapping.subjectLabel}</em>}
                        <small>{mapping.title}</small>
                      </li>
                    );
                  })}
                </ol>
              )}
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
                    <div className={`video-input-group-heading ${group.kind === "image" && videoGenerationMode === "reference-to-video" ? "has-ref-image-size" : ""}`}>
                      {group.kind === "image"
                        ? <ImageIcon size={13} />
                        : group.kind === "audio"
                          ? <Music size={13} />
                          : <Film size={13} />}
                      <strong>{group.label}</strong>
                      {group.kind === "image" && videoGenerationMode === "reference-to-video" && (
                        <div className="nodrag video-ref-image-size" role="group" aria-label="参考图片尺寸模式">
                          {REF_IMAGE_SIZE_OPTIONS.map((option) => (
                            <button
                              key={option}
                              type="button"
                              className={refImageSize === option ? "is-active" : ""}
                              aria-pressed={refImageSize === option}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={() => onChange(id, {
                                content: {
                                  ...record.content,
                                  generationRefImageSize: option,
                                  status: "idle",
                                  validationMessage: "",
                                },
                              })}
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                      )}
                      <span className="video-input-asset-count">{group.inputs.length}</span>
                      {group.kind === "image" && Boolean(referenceCatalog) && (
                        <button
                          type="button"
                          className="nodrag storyboard-reference-copy"
                          aria-label={isStoryboardReferenceCompiler ? "复制图片候选清单" : "复制 H3 参考资产清单"}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            copyReferenceCatalog();
                          }}
                        >
                          {referenceCatalogCopied ? <Check size={12} /> : <Copy size={12} />}
                        </button>
                      )}
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
                                <video
                                  src={convertFileSrc(inputAssetPath)}
                                  muted
                                  preload="metadata"
                                  playsInline
                                  draggable={false}
                                  onMouseEnter={(event) => void event.currentTarget.play().catch(() => {})}
                                  onMouseLeave={(event) => event.currentTarget.pause()}
                                />
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
              <span>
                {videoGenerationMode === "text-to-video"
                  ? (textInputCount ? "文字提示词已连接，可以开始检查" : "从左侧连接文字提示词")
                  : videoGenerationMode === "first-last-frame"
                    ? "连接两张图片，并分别指定首帧和尾帧"
                    : videoGenerationMode === "image-to-video"
                      ? "连接一张图片作为视频首帧"
                      : videoGenerationMode === "last-frame-to-video"
                        ? "连接一张图片作为视频尾帧"
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
                  {validationStatus === "invalid" && (
                    <button
                      type="button"
                      className="nodrag video-error-copy-button"
                      onClick={copyValidationError}
                      title={errorCopied ? "已复制完整报错信息" : "复制完整报错信息"}
                      aria-label={errorCopied ? "已复制完整报错信息" : "复制完整报错信息"}
                    >
                      {errorCopied ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                  )}
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
              {executionRunning || batchSubmitting ? (
                <button
                  type="button"
                  className="video-cancel-button"
                  disabled={executionCancelling || activeTaskCount === 0}
                  onClick={() => void onCancelExecution(id)}
                  title={activeTaskCount === 0
                    ? "正在提交首个任务，暂时无法取消"
                    : `取消最早提交的任务；当前共有 ${activeTaskCount} 个任务`}
                  aria-label={activeTaskCount === 0
                    ? "正在提交首个任务，暂时无法取消"
                    : `取消最早提交的任务；当前共有 ${activeTaskCount} 个任务`}
                >
                  <X size={13} />
                  {activeTaskCount || null}
                </button>
              ) : (
                <button
                  type="button"
                  className="video-execute-button video-batch-execute-button"
                  disabled={textInputs.length < 2}
                  title={textInputs.length < 2
                    ? "至少接入两个文字提示词后才能批量提交"
                    : `按当前文本顺序批量提交 ${textInputs.length} 个生成任务`}
                  aria-label={textInputs.length < 2
                    ? "至少接入两个文字提示词后才能批量提交"
                    : `批量提交 ${textInputs.length} 个生成任务`}
                  onClick={() => void checkAndExecuteBatch()}
                >
                  <Clapperboard size={15} />
                </button>
              )}
              <button
                type="button"
                className="video-execute-button"
                disabled={batchSubmitting || executionCancelling || (seedMode === "fixed" && executionRunning)}
                title={batchSubmitting
                  ? "批量任务正在按顺序提交，请稍后"
                  : seedMode === "fixed" && executionRunning
                  ? "固定种子已有任务正在执行，不能重复排队"
                  : "提交一个新的生成任务"}
                aria-label={batchSubmitting
                  ? "批量任务正在按顺序提交，请稍后"
                  : seedMode === "fixed" && executionRunning
                  ? "固定种子已有任务正在执行，不能重复排队"
                  : "开始执行"}
                onClick={() => void checkAndExecute()}
              >
                <Play size={15} fill="currentColor" />
              </button>
            </div>
          </div>
          <div className={`input-badge ${inputCount ? "has-input" : ""}`}>
            {inputCount
              ? `${mediaInputs.length} 个媒体${textInputCount ? ` · ${textInputCount} 个文本` : ""}`
              : "等待输入"}
          </div>
        </div>
      )}
      {!isGeneratedVideo && (
        <footer className="node-footer">
          <span className={`source-dot ${record.source === "manual" ? "manual" : "external"}`} />
          <span>{sourceLabel}</span>
          {isImage && <span className="image-dimension-label">{imageDimensionLabel}</span>}
          {isContentIterationNode && relationPromptVersionLabel && (
            <span
              className="prompt-relation-version"
              title={`当前关联视频使用 ${relationPromptVersionLabel} 生成`}
            >
              {relationPromptVersionLabel}
            </span>
          )}
          <span className="node-footer-spacer" />
          {!isImage && <span className="node-footer-detail">
            {isFolder
              ? typeof record.content.nodeCount === "number"
                ? `${record.content.nodeCount} 个节点`
                : "子画布"
              : (isText || isNote)
              ? isContentIterationNode
                ? `${promptVersions.length} 个版本`
                : `${textDraft.length.toLocaleString()} 字符`
              : (isAudioAsset || isVideoAsset)
                ? originalName
                : mediaInputs.length
                  ? `${mediaInputs.length} 个媒体输入`
                  : "尚未生成"}
          </span>}
          {isImage && (
            <button
              type="button"
              className="nodrag node-action media-footer-resize"
              disabled={imageResizing}
              onClick={(event) => {
                if (event.ctrlKey) {
                  const savedDefault = imageResizeDefaultFromStorage();
                  setImageResizeDraft(String(savedDefault));
                  setImageResizeError("");
                  setImageResizeDialogOpen(true);
                  return;
                }
                void runImageResize(imageResizeDefaultFromStorage(), false);
              }}
              title="Resize 图片；Ctrl+单击设置最长边"
              aria-label="Resize 图片；Ctrl 加单击设置最长边"
            >
              <Scaling size={14} />
            </button>
          )}
        </footer>
      )}
      {(isText || isImage || isAudioAsset || isVideoAsset || isVideoGeneration || isGeneratedVideo) && !isFolder && (
        <Handle
          type="source"
          position={Position.Right}
          className={`node-handle source-handle ${isContentIterationNode ? "content-derivation-source-handle" : ""} ${outputCount > 0 ? "is-connected" : ""}`}
          title={isContentIterationNode ? "连接下游创作内容或视频节点" : undefined}
        />
      )}
      {imageResizeDialogOpen && createPortal(
        <div
          className="project-dialog-backdrop image-resize-dialog-backdrop"
          onMouseDown={() => {
            if (!imageResizing) setImageResizeDialogOpen(false);
          }}
        >
          <form
            className="project-dialog image-resize-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`image-resize-title-${id}`}
            onSubmit={submitImageResize}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="project-dialog-icon"><Scaling size={22} /></div>
            <div>
              <h2 id={`image-resize-title-${id}`}>Resize 图片</h2>
              <p>
                保持原始宽高比，将最长边缩放到指定像素。小于目标尺寸的图片不会被放大。
              </p>
            </div>
            <label>
              最长边像素
              <input
                type="number"
                min={MIN_IMAGE_RESIZE_MAX_EDGE}
                max={MAX_IMAGE_RESIZE_MAX_EDGE}
                step={1}
                value={imageResizeDraft}
                disabled={imageResizing}
                autoFocus
                onChange={(event) => {
                  setImageResizeDraft(event.currentTarget.value);
                  setImageResizeError("");
                }}
              />
            </label>
            {imageResizeError && <p className="image-resize-error">{imageResizeError}</p>}
            <div className="project-dialog-actions">
              <button
                type="button"
                className="dialog-cancel"
                disabled={imageResizing}
                onClick={() => setImageResizeDialogOpen(false)}
              >
                取消
              </button>
              <button type="submit" className="primary-button" disabled={imageResizing}>
                <Scaling size={14} />
                {imageResizing ? "处理中…" : "执行 Resize"}
              </button>
            </div>
          </form>
        </div>,
        document.body,
      )}
      {expanded && createPortal(
        <div className="expanded-editor-backdrop" onMouseDown={requestCloseExpandedEditor}>
          <section
            className={`expanded-editor-dialog ${isNote ? "is-note" : ""} ${isText ? "is-prompt-version" : ""}`}
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
                {isContentIterationNode && activePromptVersion && editingPromptVersionTitleId === activePromptVersion.id ? (
                  <input
                    className="expanded-editor-title-editor"
                    value={promptVersionTitleDraft}
                    onChange={(event) => changePromptVersionTitleDraft(activePromptVersion, event.currentTarget.value)}
                    onBlur={() => commitPromptVersionTitleEdit(activePromptVersion.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.blur();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        cancelPromptVersionTitleEdit();
                      }
                    }}
                    autoFocus
                    spellCheck={false}
                    aria-label={`${activePromptVersion.label} 版本标题`}
                  />
                ) : (
                  <strong
                    className={isContentIterationNode && activePromptVersion ? "is-editable" : ""}
                    onDoubleClick={() => {
                      if (activePromptVersion) beginPromptVersionTitleEdit(activePromptVersion);
                    }}
                    title={isContentIterationNode && activePromptVersion
                      ? "双击修改当前版本标题"
                      : undefined}
                  >
                    {isContentIterationNode
                      ? activePromptVersion?.title || record.title || "未命名版本"
                      : record.title || "未命名节点"}
                  </strong>
                )}
                <span>{isContentIterationNode && activePromptVersion
                  ? `${activePromptVersion.label} · ${textDraft.length.toLocaleString()} 字符 · 自动保存 · 可手动保存`
                  : `${textDraft.length.toLocaleString()} 字符 · 自动保存 · 可手动保存`}</span>
                {isContentIterationNode && activePromptVersion && (
                  <span className="content-version-header-provenance">
                    来源：{versionProvenance(activePromptVersion)}
                  </span>
                )}
              </div>
              {isContentIterationNode && (
                contentNodeType === "prompt" && activePromptVersion && (
                  <label className="expanded-editor-duration-control">
                    <span>时长</span>
                    <input
                      type="number"
                      min="2"
                      max="15"
                      step="1"
                      value={promptDurationSecondsFromVersion(activePromptVersion) ?? ""}
                      onChange={(event) => changeActivePromptDuration(event.currentTarget.value)}
                      onPointerDown={(event) => event.stopPropagation()}
                      aria-label="当前生成提示词时长，2 到 15 秒"
                      placeholder="未设置"
                    />
                    <small>{activePromptVersion.durationOverrideSeconds !== undefined
                      ? "手动"
                      : activePromptVersion.generationOptions ? "推荐" : "未设置"}</small>
                  </label>
                )
              )}
              {isContentIterationNode && (
                <div className="expanded-editor-version-control">
                  <span>版本</span>
                  <SettingsSelect
                    value={activePromptVersion?.id ?? ""}
                    options={[...promptVersions].reverse().map((version) => ({
                      value: version.id,
                      label: version.label,
                      title: `${version.label} · ${version.title || "未命名版本"}`,
                    }))}
                    onChange={(versionId) => {
                      const version = promptVersions.find(
                        (candidate) => candidate.id === versionId,
                      );
                      if (version) selectPromptVersion(version);
                    }}
                    disabled={!promptVersions.length}
                    ariaLabel="切换提示词版本"
                    placeholder="未创建"
                  />
                </div>
              )}
              {isContentIterationNode && (
                <button
                  type="button"
                  className="expanded-editor-create-version"
                  onClick={createPromptVersion}
                  title={`创建空白的新版本；将锁定来源：${nextVersionProvenance}`}
                  aria-label={`添加空白新版本；将锁定来源：${nextVersionProvenance}`}
                >
                  <Plus size={14} />
                  添加新版本
                </button>
              )}
              {isContentIterationNode && (
                <button
                  type="button"
                  className="expanded-editor-delete-version"
                  onClick={() => {
                    if (activePromptVersion) void deletePromptVersion(activePromptVersion.id);
                  }}
                  disabled={!activePromptVersion}
                  title={activePromptVersion
                    ? `删除当前版本 ${activePromptVersion.label}`
                    : "尚未创建版本"}
                  aria-label={activePromptVersion
                    ? `删除当前版本 ${activePromptVersion.label}`
                    : "尚未创建版本"}
                >
                  <Trash2 size={14} />
                  删除版本
                </button>
              )}
              {isNote && (
                <>
                  <button
                    type="button"
                    className={`markdown-mode-toggle ${expandedTextMarkdownPreview ? "is-active" : ""}`}
                    onClick={() => setExpandedTextMarkdownPreview((preview) => !preview)}
                    title={expandedTextMarkdownPreview ? "切换到 Markdown 编辑" : "预览 Markdown"}
                    aria-label={expandedTextMarkdownPreview ? "切换到 Markdown 编辑" : "预览 Markdown"}
                  >
                    {expandedTextMarkdownPreview ? <Pencil size={14} /> : <Eye size={14} />}
                  </button>
                  <button
                    type="button"
                    className="markdown-copy-button"
                    onClick={() => copyMarkdown("expanded-note", textDraft)}
                    title="复制 Markdown 原文"
                    aria-label="复制 Markdown 原文"
                  >
                    {copiedMarkdownTarget === "expanded-note" ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </>
              )}
              <button
                type="button"
                className={isNodeManuallyUnsaved(id, activePromptVersion?.id) ? "is-manual-save-dirty" : ""}
                onClick={() => void saveTextNode(id, activePromptVersion?.id)}
                disabled={savingTextNodeId === id}
                title={savingTextNodeId === id
                  ? "正在保存到数据库…"
                  : isNodeManuallyUnsaved(id, activePromptVersion?.id)
                    ? "有未手动保存的修改，点击立即保存到数据库"
                    : "立即保存到数据库"}
                aria-label={savingTextNodeId === id ? "正在保存文本节点" : "立即保存文本节点到数据库"}
              >
                <Save size={16} />
              </button>
              <button onClick={requestCloseExpandedEditor} title="关闭" aria-label="关闭放大编辑器">
                <X size={17} />
              </button>
            </header>
            {isText ? (
              <div className={`expanded-prompt-layout ${expandedInformationHidden ? "is-information-hidden" : ""}`}>
                <section className="expanded-prompt-pane is-prompt">
                  <header>
                    <strong>提示词</strong>
                    <span>{textDraft.length.toLocaleString()} 字符</span>
                    <button
                      type="button"
                      className={`markdown-mode-toggle ${expandedTextMarkdownPreview ? "is-active" : ""}`}
                      onClick={() => setExpandedTextMarkdownPreview((preview) => !preview)}
                      title={expandedTextMarkdownPreview ? "切换到 Markdown 编辑" : "预览 Markdown"}
                      aria-label={expandedTextMarkdownPreview ? "切换到 Markdown 编辑" : "预览 Markdown"}
                    >
                      {expandedTextMarkdownPreview ? <Pencil size={14} /> : <Eye size={14} />}
                    </button>
                    <button
                      type="button"
                      className="markdown-copy-button"
                      onClick={() => copyMarkdown("expanded-text", textDraft)}
                      title="复制 Markdown 原文"
                      aria-label="复制 Markdown 原文"
                    >
                      {copiedMarkdownTarget === "expanded-text" ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                    <button
                      type="button"
                      className="expanded-information-toggle"
                      onClick={(event) => {
                        event.currentTarget.blur();
                        setExpandedInformationHidden((hidden) => !hidden);
                      }}
                      title={expandedInformationHidden ? "显示备注栏" : "隐藏备注栏"}
                      aria-label={expandedInformationHidden ? "显示备注栏" : "隐藏备注栏"}
                      aria-pressed={expandedInformationHidden}
                    >
                      {expandedInformationHidden ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
                    </button>
                  </header>
                  {expandedTextMarkdownPreview ? (
                    <MarkdownPreview source={textDraft} className="expanded-markdown-preview" enableSpaceTablePan />
                  ) : (
                    <textarea
                      className="expanded-text-editor"
                      value={textDraft}
                      onChange={changeText}
                      onKeyDown={(event) => saveTextWithShortcut(event, id, activePromptVersion?.id)}
                      autoFocus
                      spellCheck={false}
                      aria-label="提示词内容"
                    />
                  )}
                </section>
                <section className="expanded-prompt-pane is-information">
                  <header>
                    <strong>备注</strong>
                    <span>{informationDraft.length.toLocaleString()} 字符</span>
                    <button
                      type="button"
                      className={`markdown-mode-toggle ${expandedInformationMarkdownPreview ? "is-active" : ""}`}
                      onClick={() => setExpandedInformationMarkdownPreview((preview) => !preview)}
                      title={expandedInformationMarkdownPreview ? "切换到 Markdown 编辑" : "预览 Markdown"}
                      aria-label={expandedInformationMarkdownPreview ? "切换到 Markdown 编辑" : "预览 Markdown"}
                    >
                      {expandedInformationMarkdownPreview ? <Pencil size={14} /> : <Eye size={14} />}
                    </button>
                    <button
                      type="button"
                      className="markdown-copy-button"
                      onClick={() => copyMarkdown("expanded-information", informationDraft)}
                      title="复制 Markdown 原文"
                      aria-label="复制 Markdown 原文"
                    >
                      {copiedMarkdownTarget === "expanded-information" ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </header>
                  {expandedInformationMarkdownPreview ? (
                  <MarkdownPreview source={informationDraft} className="expanded-markdown-preview is-information" enableSpaceTablePan />
                  ) : (
                    <textarea
                      className="expanded-text-editor"
                      value={informationDraft}
                      onChange={changeInformation}
                      onKeyDown={(event) => saveTextWithShortcut(event, id, activePromptVersion?.id)}
                      spellCheck={false}
                      placeholder={isContentIterationNode ? "这里记录本版本的备注…" : "这里记录当前文本的备注…"}
                      aria-label="提示词备注"
                    />
                  )}
                </section>
              </div>
            ) : (
              <>
                {expandedTextMarkdownPreview ? (
                  <MarkdownPreview source={textDraft} className="expanded-markdown-preview" />
                ) : (
                  <textarea
                    className="expanded-text-editor"
                    value={textDraft}
                    onChange={changeText}
                    onKeyDown={(event) => saveTextWithShortcut(event, id, activePromptVersion?.id)}
                    autoFocus
                    spellCheck={false}
                    aria-label="放大文本内容"
                  />
                )}
              </>
            )}
          </section>
        </div>,
        document.body,
      )}
      {connectedTextEditor && createPortal(
        <div
          className="expanded-editor-backdrop"
          onMouseDown={requestCloseConnectedTextEditor}
        >
          <section
            className="expanded-editor-dialog is-prompt-version"
            role="dialog"
            aria-modal="true"
            aria-label={`${connectedTextEditor.title} 放大编辑`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="expanded-editor-header">
              <span className="node-kind-icon"><FileText size={15} /></span>
              <div>
                <strong>{connectedTextEditor.title}</strong>
                <span>{connectedTextEditor.text.length.toLocaleString()} 字符 · 自动保存 · 可手动保存</span>
              </div>
              {isContentIterationContent(connectedTextEditor.content) && (
                <div className="expanded-editor-version-control">
                  <span>版本</span>
                  <SettingsSelect
                    value={connectedActivePromptVersion?.id ?? ""}
                    options={[...connectedPromptVersions].reverse().map((version) => ({
                      value: version.id,
                      label: `${version.label} · ${version.title || "未命名版本"}`,
                    }))}
                    onChange={(versionId) => {
                      const version = connectedPromptVersions.find(
                        (candidate) => candidate.id === versionId,
                      );
                      if (version) selectConnectedPromptVersion(version);
                    }}
                    disabled={!connectedPromptVersions.length}
                    ariaLabel="切换已连接提示词版本"
                    placeholder="未创建"
                  />
                </div>
              )}
              <button
                type="button"
                className={isNodeManuallyUnsaved(connectedTextEditor.id, connectedActivePromptVersion?.id) ? "is-manual-save-dirty" : ""}
                onClick={() => void saveTextNode(connectedTextEditor.id, connectedActivePromptVersion?.id)}
                disabled={savingTextNodeId === connectedTextEditor.id}
                title={savingTextNodeId === connectedTextEditor.id
                  ? "正在保存到数据库…"
                  : isNodeManuallyUnsaved(connectedTextEditor.id, connectedActivePromptVersion?.id)
                    ? "有未手动保存的修改，点击立即保存到数据库"
                    : "立即保存到数据库"}
                aria-label={savingTextNodeId === connectedTextEditor.id ? "正在保存已连接文本节点" : "立即保存已连接文本节点到数据库"}
              >
                <Save size={16} />
              </button>
              <button
                onClick={requestCloseConnectedTextEditor}
                title="关闭"
                aria-label="关闭提示词编辑器"
              >
                <X size={17} />
              </button>
            </header>
            <div className={`expanded-prompt-layout ${connectedInformationHidden ? "is-information-hidden" : ""}`}>
              <section className="expanded-prompt-pane is-prompt">
                <header>
                  <strong>提示词</strong>
                  <span>{connectedTextEditor.text.length.toLocaleString()} 字符</span>
                  <button
                    type="button"
                    className={`markdown-mode-toggle ${connectedTextMarkdownPreview ? "is-active" : ""}`}
                    onClick={() => setConnectedTextMarkdownPreview((preview) => !preview)}
                    title={connectedTextMarkdownPreview ? "切换到 Markdown 编辑" : "预览 Markdown"}
                    aria-label={connectedTextMarkdownPreview ? "切换到 Markdown 编辑" : "预览 Markdown"}
                  >
                    {connectedTextMarkdownPreview ? <Pencil size={14} /> : <Eye size={14} />}
                  </button>
                  <button
                    type="button"
                    className="markdown-copy-button"
                    onClick={() => copyMarkdown("connected-text", connectedTextEditor.text)}
                    title="复制 Markdown 原文"
                    aria-label="复制 Markdown 原文"
                  >
                    {copiedMarkdownTarget === "connected-text" ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                  <button
                    type="button"
                    className="expanded-information-toggle"
                    onClick={(event) => {
                      event.currentTarget.blur();
                      setConnectedInformationHidden((hidden) => !hidden);
                    }}
                    title={connectedInformationHidden ? "显示备注栏" : "隐藏备注栏"}
                    aria-label={connectedInformationHidden ? "显示备注栏" : "隐藏备注栏"}
                    aria-pressed={connectedInformationHidden}
                  >
                    {connectedInformationHidden ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
                  </button>
                </header>
                {connectedTextMarkdownPreview ? (
                  <MarkdownPreview source={connectedTextEditor.text} className="expanded-markdown-preview" enableSpaceTablePan />
                ) : (
                  <textarea
                    className="expanded-text-editor"
                    value={connectedTextEditor.text}
                    onChange={(event) => changeConnectedPromptField("text", event.currentTarget.value)}
                    onKeyDown={(event) => saveTextWithShortcut(event, connectedTextEditor.id, connectedActivePromptVersion?.id)}
                    autoFocus
                    spellCheck={false}
                    aria-label="已连接提示词内容"
                  />
                )}
              </section>
              <section className="expanded-prompt-pane is-information">
                <header>
                  <strong>备注</strong>
                  <span>{connectedTextEditor.information.length.toLocaleString()} 字符</span>
                  <button
                    type="button"
                    className={`markdown-mode-toggle ${connectedInformationMarkdownPreview ? "is-active" : ""}`}
                    onClick={() => setConnectedInformationMarkdownPreview((preview) => !preview)}
                    title={connectedInformationMarkdownPreview ? "切换到 Markdown 编辑" : "预览 Markdown"}
                    aria-label={connectedInformationMarkdownPreview ? "切换到 Markdown 编辑" : "预览 Markdown"}
                  >
                    {connectedInformationMarkdownPreview ? <Pencil size={14} /> : <Eye size={14} />}
                  </button>
                  <button
                    type="button"
                    className="markdown-copy-button"
                    onClick={() => copyMarkdown("connected-information", connectedTextEditor.information)}
                    title="复制 Markdown 原文"
                    aria-label="复制 Markdown 原文"
                  >
                    {copiedMarkdownTarget === "connected-information" ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </header>
                {connectedInformationMarkdownPreview ? (
                  <MarkdownPreview source={connectedTextEditor.information} className="expanded-markdown-preview is-information" enableSpaceTablePan />
                ) : (
                  <textarea
                    className="expanded-text-editor"
                    value={connectedTextEditor.information}
                    onChange={(event) => changeConnectedPromptField("information", event.currentTarget.value)}
                    onKeyDown={(event) => saveTextWithShortcut(event, connectedTextEditor.id, connectedActivePromptVersion?.id)}
                    spellCheck={false}
                    placeholder={isContentIterationContent(connectedTextEditor.content) ? "这里记录本版本的备注…" : "这里保存当前文本的备注…"}
                    aria-label="已连接提示词备注"
                  />
                )}
              </section>
            </div>
          </section>
        </div>,
        document.body,
      )}
      {editorExitConfirmation && createPortal(
        <div
          className="project-dialog-backdrop editor-exit-confirm-backdrop"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <section
            className="project-dialog editor-exit-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`editor-exit-title-${id}`}
            aria-describedby={`editor-exit-description-${id}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="project-dialog-icon"><Save size={22} /></div>
            <div>
              <h2 id={`editor-exit-title-${id}`}>提示词尚未手动保存</h2>
              <p id={`editor-exit-description-${id}`}>
                当前修改仍显示为绿色保存状态。是否先保存到数据库再退出？
              </p>
            </div>
            <div className="project-dialog-actions">
              <button
                type="button"
                className="dialog-cancel"
                disabled={savingEditorExit}
                onClick={() => setEditorExitConfirmation(null)}
              >
                继续编辑
              </button>
              <button
                type="button"
                className="dialog-danger"
                disabled={savingEditorExit}
                onClick={exitEditorWithoutManualSave}
              >
                不保存退出
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={savingEditorExit}
                onClick={() => void saveAndExitEditor()}
              >
                <Save size={14} />
                {savingEditorExit ? "保存中…" : "保存并退出"}
              </button>
            </div>
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
      {textIdsPendingClear && createPortal(
        <div
          className="project-dialog-backdrop"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={() => {
            if (!clearingTexts) setTextIdsPendingClear(null);
          }}
        >
          <div
            className="project-dialog project-delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`clear-texts-title-${id}`}
            aria-describedby={`clear-texts-description-${id}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="project-dialog-icon"><Trash2 size={22} /></div>
            <div>
              <h2 id={`clear-texts-title-${id}`}>确认清除全部文本连接？</h2>
              <p id={`clear-texts-description-${id}`}>
                将从当前视频生成节点断开全部 {textIdsPendingClear.length} 个文本连接。原始文字节点不会被删除，图片、音频和视频连接不受影响。
              </p>
            </div>
            <div className="project-dialog-actions">
              <button
                type="button"
                className="dialog-cancel"
                autoFocus
                disabled={clearingTexts}
                onClick={() => setTextIdsPendingClear(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="dialog-danger"
                disabled={clearingTexts}
                onClick={() => void clearConnectedTexts()}
              >
                <Trash2 size={14} />
                {clearingTexts ? "正在清除…" : "确认清除"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </article>
  );
}

const MemoizedCanvasNode = memo(
  CanvasNode,
  (previous, next) => previous.id === next.id
    && previous.selected === next.selected
    && previous.data === next.data,
);
const nodeTypes = { canvasNode: MemoizedCanvasNode };

export {
  ALIGNMENT_SNAP_TOLERANCE_PX,
  AUDIO_NODE_MIN_HEIGHT,
  CANVAS_GRID_SIZE,
  COMFYUI_SERVER_URL,
  COMFY_TASK_STORAGE_KEY,
  DEFAULT_H3_DIFFUSION_MODEL_NAME,
  DEFAULT_H3_FIRST_LAST_WORKFLOW_PATH,
  DEFAULT_H3_IMAGE_TO_VIDEO_WORKFLOW_PATH,
  DEFAULT_H3_LAST_FRAME_TO_VIDEO_WORKFLOW_PATH,
  DEFAULT_H3_LORA_NAME,
  DEFAULT_H3_REFERENCE_WORKFLOW_PATH,
  EMPTY_NODE_RECORDS,
  GENERATED_VIDEO_FOOTER_HEIGHT,
  GENERATED_VIDEO_PORTRAIT_PREVIEW_WIDTH,
  H3_LORA_PREFERENCE_STORAGE_KEY,
  H3_MODEL_PARAMETERS_STORAGE_KEY,
  H3_REFERENCE_WORKFLOW_STORAGE_KEY,
  IMAGE_NODE_CHROME_HEIGHT,
  ModelParameterNumberInput,
  NODE_HANDLE_BASE_SIZE_PX,
  NODE_HANDLE_MIN_SCREEN_SIZE_PX,
  PRIVATE_PROJECT_VISIBILITY_STORAGE_KEY,
  REF_IMAGE_SIZE_OPTIONS,
  SECONDARY_SAMPLE_NUMBER_CONFIG,
  SHOW_NODE_SEARCH,
  SettingsSelect,
  UI_FONT_SIZE_STORAGE_KEY,
  VIDEO_GENERATION_DEFAULTS_STORAGE_KEY,
  LEGACY_VIDEO_GENERATION_NODE_WIDTH,
  VIDEO_GENERATION_NODE_WIDTH,
  VIDEO_NODE_BASE_HEIGHT,
  VIDEO_REGENERATION_NUMBER_CONFIG,
  VideoGenerationDefaultsEditor,
  WORKFLOW_CAPABILITIES,
  WORKFLOW_MODULE_DEFAULTS_STORAGE_KEY,
  WORKFLOW_MODULE_SLOTS,
  WORKFLOW_PACKAGE_ENGINE,
  WORKFLOW_VIDEO_VARIANTS,
  activePromptVersionFromContent,
  activeTextInputFromContent,
  appendUniqueById,
  batchGenerationPreviewStep,
  boundsIntersect,
  canvasGridColor,
  canvasNodeBounds,
  comfyOutputFromContent,
  comfyPreviewRequestId,
  comfyProgressFromSocketData,
  copiedNodeContentForProject,
  copiedPromptVersionContent,
  copiedVideoGenerationContent,
  edgeTypes,
  findEdgeAlignment,
  findEqualSpacing,
  fixedSeedFromContent,
  frameRoleFromContent,
  generatedPreviewPosition,
  generatedPreviewPositionBelow,
  generatedSeedsFromContent,
  generatedVideoPreviewWidthForRatio,
  generationSnapshotFromContent,
  guidesEqual,
  h3DiffusionModelDisplayName,
  h3DiffusionModelNameFromContent,
  h3LoraBypassedFromContent,
  h3LoraNameFromContent,
  h3LoraPreferenceFromStorage,
  h3LoraStrengthFromContent,
  h3ModelParametersFromStorage,
  h3SecondaryLoraBypassedFromContent,
  h3SecondaryLoraNameFromContent,
  h3SecondaryLoraStrengthFromContent,
  incomingNodePosition,
  informationFromContent,
  isContentIterationContent,
  isSecondaryComfyTask,
  loadImageNaturalSize,
  mappedComfyOutputPath,
  nodeRecordArraysEqual,
  nodeTypes,
  nonOverlappingNodePosition,
  openComfyProgressSocket,
  orderedNodeRecordsFromContent,
  persistedComfyTaskFromPlaceholder,
  persistedComfyTasksFromStorage,
  primaryVideoResolutionFromContent,
  primaryVideoStepsFromContent,
  promptDurationSecondsFromVersion,
  promptVersionsFromContent,
  randomFixedSeed,
  recordAtCurrentFlowPosition,
  refImageSizeFromContent,
  sameH3DiffusionModelName,
  sameH3LoraName,
  secondarySchedulerStepsFromContent,
  secondaryVideoResolutionFromContent,
  seedModeFromContent,
  snapCanvasCoordinate,
  referenceSelectionFromContent,
  resolveStoryboardReferenceSelection,
  strictPromptTagsFromContent,
  textFromContent,
  toFlowEdge,
  validCanvasColor,
  validExecutionElapsedSeconds,
  videoAspectRatioFromContent,
  videoAspectRatioValue,
  videoDurationFromContent,
  videoGenerationAutoHeight,
  videoGenerationDefaultsFromStorage,
  videoGenerationModeFromContent,
  workflowBindingsFromDraft,
  workflowCapabilityForVideoMode,
  workflowModuleDefaultsFromStorage,
  workflowSlotForModule,
  workflowSlotForVideoMode,
  workflowVariantLabel,
};

export type {
  AlignmentGuide,
  AppBackupSummary,
  AppLockStatus,
  AppRestoreSummary,
  CancelFolderResult,
  CanvasContextMenuState,
  CanvasEdgeData,
  CanvasFlowNode,
  CanvasNodeBounds,
  CanvasNodeData,
  CanvasRecord,
  CanvasUndoEntry,
  ComfyClientTaskStatus,
  ComfyQueueSummary,
  ComfySubmitResult,
  CreateNodeResult,
  CreateEmptyFolderResult,
  DeleteFolderResult,
  DeletedBatch,
  EdgeRecord,
  GenerationSnapshot,
  GroupNodesIntoFolderResult,
  H3LoraPreferencePatch,
  JsonObject,
  MergeFoldersResult,
  NodeClipboard,
  NodeClipboardEdge,
  NodePatch,
  NodeRecord,
  PersistedComfyTask,
  ResizeImageResult,
  RestoreNodeReplacementResult,
  RuntimeInfo,
  SecondarySampleDraft,
  SecondarySampleNumericField,
  SecondarySampleOverrides,
  SpacingGuide,
  StoryboardReferenceMapping,
  StoryboardReferenceResolution,
  StoryboardReferenceSelection,
  UiFontSize,
  VideoAspectRatio,
  VideoDeletionChoice,
  VideoDeletionRequest,
  VideoExecutionOptions,
  VideoGenerationMode,
  VideoRegenerationDraft,
  VideoRegenerationNumericField,
  VideoRegenerationPromptOption,
  VideoRegenerationRequest,
  VisibleNodeCacheEntry,
  WorkflowCapability,
  WorkflowModuleRecord,
  WorkflowModuleValidation,
  WorkflowVariant,
  WorkspaceSnapshot,
};
