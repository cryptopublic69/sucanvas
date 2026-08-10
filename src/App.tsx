import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
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
  NodeResizeControl,
  NodeResizer,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  ResizeControlVariant,
  SelectionMode,
  ViewportPortal,
  getBezierPath,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  Copy,
  DatabaseBackup,
  Dices,
  FileText,
  Film,
  FolderOpen,
  FolderKanban,
  GripVertical,
  History,
  Image as ImageIcon,
  Info,
  Link2,
  LockKeyhole,
  LocateFixed,
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
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Star,
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
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import suCanvasLogo from "../src-tauri/icons/128x128@2x.png";
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

interface PromptVersionRecord {
  id: string;
  label: string;
  text: string;
  createdAt: string;
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
  imagePaths: string[];
  imageRoles: FrameRole[];
  audioPaths: string[];
  videoPaths: string[];
  workflowModuleId: string;
  workflowModuleRevision: string;
}

interface VideoRegenerationRequest {
  sourcePreview: NodeRecord;
  snapshot: GenerationSnapshot;
  seed: string;
}

interface VideoRegenerationDraft {
  previewId: string;
  previewTitle: string;
  originalSnapshot: GenerationSnapshot;
  seed: string;
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
  disabled?: boolean;
}

function SettingsSelect({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  placeholder = "请选择",
}: {
  value: string;
  options: SettingsSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  placeholder?: string;
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
        <div className="settings-custom-select-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={option.value === value ? "is-active" : ""}
              disabled={option.disabled}
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
  activeTaskCount: number;
  inputCount: number;
  outputCount: number;
  mediaInputs: NodeRecord[];
  textInputCount: number;
  textInputs: NodeRecord[];
  promptNodeTitle: string;
  h3LoraOptions: string[];
  workflowModules: WorkflowModuleRecord[];
  workflowModuleDefaults: Partial<Record<WorkflowModuleSlot, string>>;
  onH3LoraPreferenceChange: (preference: H3LoraPreferencePatch) => void;
  onChange: (id: string, patch: NodePatch) => void;
  onExecutionCheck: (message: string, valid: boolean) => void;
  onExecute: (id: string) => Promise<void>;
  onSecondarySample: (id: string) => Promise<void>;
  onConfigureSecondarySample: (id: string) => void;
  onRegenerateVideo: (id: string) => Promise<void>;
  onConfigureRegenerateVideo: (id: string) => void;
  onLocatePrompt: (id: string, target?: "prompt" | "generator") => void;
  onCancelExecution: (id: string) => Promise<void>;
  onRevealGeneratedVideo: (id: string) => Promise<void>;
  onRemoveInput: (targetId: string, sourceId: string) => Promise<void>;
  onActivateTextInput: (targetId: string, sourceId: string) => void;
  onDelete: (id: string, deleteSourceFile?: boolean) => void;
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
const EMPTY_NODE_RECORDS: NodeRecord[] = [];
const AUDIO_NODE_MIN_HEIGHT = 240;
const VIDEO_GENERATION_NODE_WIDTH = 360;
const VIDEO_NODE_BASE_HEIGHT = 600;
const VIDEO_NODE_MAX_VISIBLE_TEXT_INPUTS = 10;
const VIDEO_NODE_TEXT_ROW_HEIGHT = 51;
const MEDIA_NODE_CHROME_HEIGHT = 73;
const IMAGE_NODE_CHROME_HEIGHT = 38;
const GENERATED_VIDEO_FOOTER_HEIGHT = 38;
const LEGACY_GENERATED_VIDEO_PREVIEW_WIDTH = 360;
const GENERATED_VIDEO_PREVIEW_WIDTH = 420;
const GENERATED_VIDEO_PORTRAIT_PREVIEW_WIDTH = 300;
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
): number {
  const groupCount = new Set(mediaKinds).size;
  const imageCount = mediaKinds.filter((kind) => kind === "image").length;
  const audioCount = mediaKinds.filter((kind) => kind === "audio").length;
  const videoCount = mediaKinds.length - imageCount - audioCount;
  const listMediaRows = videoCount + Math.ceil(audioCount / 2);
  const imageColumns = Math.max(1, Math.floor((Math.max(180, nodeWidth - 32) + 6) / 66));
  const imageRows = imageCount ? Math.ceil(imageCount / imageColumns) : 0;
  const textRows = Math.max(
    1,
    Math.min(VIDEO_NODE_MAX_VISIBLE_TEXT_INPUTS, textInputCount),
  );
  const contentHeight = 463
    + listMediaRows * 51
    + imageRows * 66
    + groupCount * 30
    + textRows * VIDEO_NODE_TEXT_ROW_HEIGHT
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
  return {
    prompt: snapshot.prompt,
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
    imagePaths: stringArray(snapshot.imagePaths),
    imageRoles: stringArray(snapshot.imageRoles).filter(
      (role): role is FrameRole => role === "first" || role === "last",
    ),
    audioPaths: stringArray(snapshot.audioPaths),
    videoPaths: stringArray(snapshot.videoPaths),
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
    : "max";
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

function promptVersionsFromContent(content: JsonObject): PromptVersionRecord[] {
  if (content.promptVersionNode !== true || !Array.isArray(content.promptVersions)) return [];
  return content.promptVersions.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const version = value as JsonObject;
    if (
      typeof version.id !== "string"
      || typeof version.label !== "string"
      || typeof version.text !== "string"
    ) return [];
    return [{
      id: version.id,
      label: version.label,
      text: version.text,
      createdAt: typeof version.createdAt === "string" ? version.createdAt : "",
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
    outputCount,
    mediaInputs,
    textInputCount,
    textInputs,
    promptNodeTitle,
    h3LoraOptions,
    workflowModules,
    onH3LoraPreferenceChange,
    onChange,
    onExecutionCheck,
    onExecute,
    onSecondarySample,
    onConfigureSecondarySample,
    onRegenerateVideo,
    onConfigureRegenerateVideo,
    onLocatePrompt,
    onCancelExecution,
    onRevealGeneratedVideo,
    onRemoveInput,
    onActivateTextInput,
    onDelete,
    onCopy,
  } = data;
  const [copied, setCopied] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [errorCopied, setErrorCopied] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(record.title);
  const [titleOverflowing, setTitleOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [previewColorMenuOpen, setPreviewColorMenuOpen] = useState(false);
  const [aspectRatioMenuOpen, setAspectRatioMenuOpen] = useState(false);
  const [workflowModuleMenuOpen, setWorkflowModuleMenuOpen] = useState(false);
  const [loraMenuOpen, setLoraMenuOpen] = useState(false);
  const [secondaryLoraMenuOpen, setSecondaryLoraMenuOpen] = useState(false);
  const [promptVersionMenuOpen, setPromptVersionMenuOpen] = useState(false);
  const [generatedInfoOpen, setGeneratedInfoOpen] = useState(false);
  const [connectedTextEditor, setConnectedTextEditor] = useState<{
    id: string;
    title: string;
    content: JsonObject;
    text: string;
  } | null>(null);
  const [draggedMediaId, setDraggedMediaId] = useState<string | null>(null);
  const [dragOverMediaId, setDragOverMediaId] = useState<string | null>(null);
  const [draggedTextId, setDraggedTextId] = useState<string | null>(null);
  const [dragOverTextId, setDragOverTextId] = useState<string | null>(null);
  const [removingMediaId, setRemovingMediaId] = useState<string | null>(null);
  const [clearingImages, setClearingImages] = useState(false);
  const [imageIdsPendingClear, setImageIdsPendingClear] = useState<string[] | null>(null);
  const [clearingTexts, setClearingTexts] = useState(false);
  const [textIdsPendingClear, setTextIdsPendingClear] = useState<string[] | null>(null);
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState(() => textFromContent(record.content));
  const [textEditorFocused, setTextEditorFocused] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleDisplayRef = useRef<HTMLSpanElement>(null);
  const previewColorControlRef = useRef<HTMLDivElement>(null);
  const aspectRatioControlRef = useRef<HTMLDivElement>(null);
  const workflowModuleControlRef = useRef<HTMLDivElement>(null);
  const loraControlRef = useRef<HTMLDivElement>(null);
  const secondaryLoraControlRef = useRef<HTMLDivElement>(null);
  const promptVersionControlRef = useRef<HTMLDivElement>(null);
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
  const savedText = textFromContent(record.content);
  const isText = record.kind === "text";
  const isPromptVersionNode = isText && record.content.promptVersionNode === true;
  const promptVersions = isPromptVersionNode ? promptVersionsFromContent(record.content) : [];
  const activePromptVersion = isPromptVersionNode
    ? activePromptVersionFromContent(record.content)
    : null;
  const bestPromptVersionId = typeof record.content.bestPromptVersionId === "string"
    ? record.content.bestPromptVersionId
    : "";
  const isNote = record.kind === "note";
  const isImage = record.kind === "image";
  const isAudioAsset = record.kind === "audio";
  const isVideoAsset = record.kind === "video";
  const isVideoGeneration = record.kind === "video-generation";
  const isGeneratedVideo = record.kind === "generated-video";
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
      && module.capability === "video-generation",
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
  const savedAspectRatio = typeof record.content.aspectRatio === "number"
    ? record.content.aspectRatio
    : null;
  const videoChromeHeight = isGeneratedVideo
    ? GENERATED_VIDEO_FOOTER_HEIGHT
    : isImage
      ? IMAGE_NODE_CHROME_HEIGHT
      : MEDIA_NODE_CHROME_HEIGHT;
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
  const generatedVideoSnapshot = isGeneratedVideo
    ? generationSnapshotFromContent(record.content)
    : null;
  const generatedVideoPrompt = generatedVideoSnapshot?.prompt ?? "";
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
    if (!isImage || !savedAspectRatio || record.content.imageLayoutVersion === 1) return;
    const fittedHeight = Math.min(
      2400,
      record.width / savedAspectRatio + IMAGE_NODE_CHROME_HEIGHT,
    );
    onChange(id, {
      height: fittedHeight,
      content: {
        ...record.content,
        imageLayoutVersion: 1,
      },
    });
  }, [id, isImage, onChange, record.content, record.width, savedAspectRatio]);

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
    if (!generatedInfoOpen) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
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
    if (isPromptVersionNode && activePromptVersion) {
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

  const createPromptVersion = () => {
    if (!isPromptVersionNode) return;
    const nextIndex = promptVersions.reduce((highest, version) => {
      const parsed = Number.parseInt(version.label.replace(/^v/i, ""), 10);
      return Number.isFinite(parsed) ? Math.max(highest, parsed) : highest;
    }, 0) + 1;
    const nextVersion: PromptVersionRecord = {
      id: crypto.randomUUID(),
      label: `v${nextIndex}`,
      text: textDraft,
      createdAt: new Date().toISOString(),
    };
    onChange(id, {
      content: {
        ...record.content,
        text: nextVersion.text,
        promptVersionNode: true,
        promptVersions: [...promptVersions, nextVersion],
        activePromptVersionId: nextVersion.id,
      },
    });
    setPromptVersionMenuOpen(false);
  };

  const selectPromptVersion = (version: PromptVersionRecord) => {
    setTextDraft(version.text);
    onChange(id, {
      content: {
        ...record.content,
        text: version.text,
        activePromptVersionId: version.id,
      },
    });
    setPromptVersionMenuOpen(false);
  };

  const markActivePromptVersionBest = () => {
    if (!activePromptVersion) return;
    onChange(id, {
      content: {
        ...record.content,
        bestPromptVersionId: activePromptVersion.id,
      },
    });
  };

  const openConnectedTextEditor = (input: NodeRecord) => {
    const inputText = textFromContent(input.content);
    const versionLabel = activePromptVersionLabelFromContent(input.content);
    setConnectedTextEditor({
      id: input.id,
      title: `${input.title || "未命名文本"}${versionLabel ? ` · ${versionLabel}` : ""}`,
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

  const copyValidationError = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!validationMessage) return;
    onCopy(validationMessage);
    setErrorCopied(true);
    window.setTimeout(() => setErrorCopied(false), 1200);
  };

  const markGeneratedVideoFullyPlayed = () => {
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
        ...(isImage ? { imageLayoutVersion: 1 } : {}),
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

  return (
    <article
      className={`canvas-node kind-${record.kind} ${isPromptVersionNode ? "is-prompt-version-node" : ""} ${usesSecondaryGreenTheme ? "is-secondary-preview" : ""} ${usesCustomPreviewTheme ? "has-custom-preview-color" : ""} ${relationHighlighted ? "is-relation-highlighted" : ""} ${matched ? "" : "is-dimmed"}`}
      style={previewThemeStyle}
    >
      <NodeResizer
        minWidth={260}
        minHeight={isAudioAsset ? AUDIO_NODE_MIN_HEIGHT : 180}
        isVisible={selected && !isImage && !isVideoAsset && !isGeneratedVideo && !isVideoGeneration}
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
      {(isVideoGeneration || isGeneratedVideo) && (
        <Handle type="target" position={Position.Left} className="node-handle target-handle" />
      )}
      {!isGeneratedVideo && !isImage && !isAudioAsset && (
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
                : isPromptVersionNode
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
          title={isGenerationPlaceholder
            ? "取消任务并删除占位节点"
            : "删除节点"}
          aria-label={isGenerationPlaceholder ? "取消任务并删除占位节点" : "删除节点"}
        >
          {isGenerationPlaceholder ? <X size={14} /> : <Trash2 size={14} />}
        </button>
      </header>
      )}
      {(isText || isNote) && (isPromptVersionNode ? (
        <div className="prompt-version-shell">
          <div className="prompt-version-toolbar">
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
                aria-label="选择提示词版本"
              >
                <History size={12} />
                <strong>{activePromptVersion?.label ?? "v1"}</strong>
                <span>{promptVersions.length} 个版本</span>
                <ChevronDown size={12} />
              </button>
              {promptVersionMenuOpen && (
                <div className="prompt-version-menu" role="menu" aria-label="提示词历史版本">
                  <header>
                    <strong>历史版本</strong>
                    <span>点击切换生成版本</span>
                  </header>
                  <div className="prompt-version-menu-list">
                    {[...promptVersions].reverse().map((version) => (
                      <button
                        key={version.id}
                        type="button"
                        role="menuitem"
                        className={version.id === activePromptVersion?.id ? "is-active" : ""}
                        onClick={() => selectPromptVersion(version)}
                      >
                        <span className="prompt-version-label">{version.label}</span>
                        <span className="prompt-version-summary">
                          <strong>{version.id === activePromptVersion?.id ? "当前用于生成" : "历史版本"}</strong>
                          <small>{version.text.trim().replace(/\s+/g, " ") || "空提示词"}</small>
                        </span>
                        {version.id === bestPromptVersionId && (
                          <Star size={12} fill="currentColor" aria-label="最佳版本" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <button
              type="button"
              className={`nodrag prompt-version-best ${activePromptVersion?.id === bestPromptVersionId ? "is-active" : ""}`}
              onClick={markActivePromptVersionBest}
              title={activePromptVersion?.id === bestPromptVersionId ? "当前版本已标记为最佳" : "标记当前版本为最佳"}
              aria-label="标记当前版本为最佳"
            >
              <Star size={13} fill={activePromptVersion?.id === bestPromptVersionId ? "currentColor" : "none"} />
            </button>
            <button
              type="button"
              className="nodrag prompt-version-create"
              onClick={createPromptVersion}
              title="复制当前内容并创建新版本"
            >
              <Plus size={13} />
              新版本
            </button>
          </div>
          <div className="text-editor-shell prompt-version-editor-shell">
            <textarea
              className={`nodrag node-editor ${textEditorFocused ? "nowheel" : ""}`}
              value={textDraft}
              onChange={changeText}
              onFocus={() => setTextEditorFocused(true)}
              onBlur={() => setTextEditorFocused(false)}
              aria-label={`${activePromptVersion?.label ?? "当前版本"}提示词内容`}
              spellCheck={false}
            />
          </div>
        </div>
      ) : (
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
      ))}
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
      {isGeneratedVideo && (
        <footer className="generated-video-footer">
          <div className="generated-video-footer-status">
            <span className={`source-dot ${isSecondaryPreview ? "is-secondary" : ""}`} />
            <span>
              {isGenerationPlaceholder
                ? placeholderActive ? "处理中" : "未完成"
                : `${formattedGenerationElapsed(record.content)}${generatedVideoSnapshot
                  ? ` / ${generatedVideoSnapshot.durationSeconds}秒`
                  : ""}`}
            </span>
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
                title="点击直接重新生成；Ctrl+点击可调整一采参数"
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
                    <div>
                      <span>一采 LoRA</span>
                      <strong title={generatedVideoSnapshot.loraName}>
                        {h3LoraDisplayName(generatedVideoSnapshot.loraName)}
                      </strong>
                    </div>
                    <div>
                      <span>一采强度</span>
                      <strong>
                        {generatedVideoSnapshot.loraBypassed
                          ? "未应用（Bypass）"
                          : generatedVideoSnapshot.loraStrengthRecorded === false
                            ? "未记录"
                            : `×${generatedVideoSnapshot.loraStrength.toFixed(2)}`}
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
                        <dt>调度 Steps</dt><dd>{generatedVideoSnapshot.secondarySchedulerSteps}</dd>
                        <dt>LoRA</dt>
                        <dd title={generatedVideoSnapshot.secondaryLoraName || "二采 Bypass"}>
                          {generatedVideoSnapshot.secondaryLoraBypassed
                            ? "未应用（Bypass）"
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
          <button
            type="button"
            className="nodrag node-action danger"
            onClick={(event) => {
              stopGeneratedVideoPlayback();
              onDelete(id, event.ctrlKey && !isGenerationPlaceholder);
            }}
            title={isGenerationPlaceholder
              ? "取消任务并删除占位节点"
              : "删除视频；Ctrl+点击将跳过确认并永久删除源文件"}
            aria-label={isGenerationPlaceholder ? "取消任务并删除占位节点" : "删除节点"}
          >
            {isGenerationPlaceholder ? <X size={14} /> : <Trash2 size={14} />}
          </button>
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
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        if ((event.target as HTMLElement).closest("button")) return;
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
      {!isGeneratedVideo && (
        <footer className="node-footer">
          <span className={`source-dot ${record.source === "manual" ? "manual" : "external"}`} />
          <span>{record.source === "manual" ? "手动创建" : record.source}</span>
          <span className="node-footer-spacer" />
          <span className="node-footer-detail">
            {(isText || isNote)
              ? isPromptVersionNode
                ? `${activePromptVersion?.label ?? "v1"} · ${promptVersions.length} 个版本 · ${textDraft.length.toLocaleString()} 字符`
                : `${textDraft.length.toLocaleString()} 字符`
              : (isImage || isAudioAsset || isVideoAsset)
                ? originalName
                : mediaInputs.length
                  ? `${mediaInputs.length} 个媒体输入`
                  : "尚未生成"}
          </span>
          {(isImage || isAudioAsset) && (
            <button
              type="button"
              className="nodrag node-action danger media-footer-delete"
              onClick={() => onDelete(id)}
              title="删除节点"
              aria-label="删除节点"
            >
              <Trash2 size={14} />
            </button>
          )}
        </footer>
      )}
      {(isText || isImage || isAudioAsset || isVideoAsset || isVideoGeneration || isGeneratedVideo) && (
        <Handle
          type="source"
          position={Position.Right}
          className={`node-handle source-handle ${outputCount > 0 ? "is-connected" : ""}`}
        />
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
  const [activeSettingsSection, setActiveSettingsSection] = useState<"general" | "workflows" | "model" | "backup" | "privacy" | "security">("general");
  const [appBackupBusy, setAppBackupBusy] = useState(false);
  const [appBackupMessage, setAppBackupMessage] = useState("");
  const [appBackupMessageKind, setAppBackupMessageKind] = useState<"success" | "error">("success");
  const [appBackupRestorePath, setAppBackupRestorePath] = useState<string | null>(null);
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
  const [uiFontSize, setUiFontSize] = useState<UiFontSize>(() =>
    window.localStorage.getItem(UI_FONT_SIZE_STORAGE_KEY) === "medium" ? "medium" : "small",
  );
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [search, setSearch] = useState("");
  const [relationAnchorId, setRelationAnchorId] = useState<string | null>(null);
  const [spacePanActive, setSpacePanActive] = useState(false);
  const [middlePanActive, setMiddlePanActive] = useState(false);
  const [notice, setNotice] = useState("正在打开画布…");
  const [comfyQueueCounts, setComfyQueueCounts] = useState<ComfyQueueSummary>({
    runningCount: 0,
    pendingCount: 0,
    totalCount: 0,
  });
  const [h3LoraOptions, setH3LoraOptions] = useState<string[]>([DEFAULT_H3_LORA_NAME]);
  const [h3LoraCatalogLoaded, setH3LoraCatalogLoaded] = useState(false);
  const [h3LoraPreference, setH3LoraPreference] = useState(h3LoraPreferenceFromStorage);
  const [h3DiffusionModelOptions, setH3DiffusionModelOptions] = useState<string[]>([DEFAULT_H3_DIFFUSION_MODEL_NAME]);
  const [h3DiffusionModelCatalogLoaded, setH3DiffusionModelCatalogLoaded] = useState(false);
  const [h3DiffusionModelName, setH3DiffusionModelName] = useState(DEFAULT_H3_DIFFUSION_MODEL_NAME);
  const [h3ModelParameters, setH3ModelParameters] = useState(h3ModelParametersFromStorage);
  const [h3ModelParametersDraft, setH3ModelParametersDraft] = useState(h3ModelParameters);
  const [workflowModules, setWorkflowModules] = useState<WorkflowModuleRecord[]>([]);
  const [workflowModuleDefaults, setWorkflowModuleDefaults] = useState(workflowModuleDefaultsFromStorage);
  const [workflowModulesReady, setWorkflowModulesReady] = useState(false);
  const [workflowModulesBusy, setWorkflowModulesBusy] = useState(false);
  const [showDeletedWorkflowModules, setShowDeletedWorkflowModules] = useState(false);
  const [selectedWorkflowModuleId, setSelectedWorkflowModuleId] = useState("");
  const [workflowModuleNameDraft, setWorkflowModuleNameDraft] = useState("MiniMax H3 全能参考");
  const [workflowModuleRevisionDraft, setWorkflowModuleRevisionDraft] = useState("当前");
  const [workflowModuleCapabilityDraft, setWorkflowModuleCapabilityDraft] = useState<WorkflowCapability>("video-generation");
  const [workflowModuleVariantDraft, setWorkflowModuleVariantDraft] = useState<WorkflowVariant>("reference-to-video");
  const [workflowModulePathDraft, setWorkflowModulePathDraft] = useState(h3WorkflowPath);
  const [workflowModuleValidation, setWorkflowModuleValidation] = useState<WorkflowModuleValidation | null>(null);
  const [workflowModuleReplacementId, setWorkflowModuleReplacementId] = useState("");
  const [workflowModuleBindingsDraft, setWorkflowModuleBindingsDraft] = useState("");
  const [workflowModuleDeletionMode, setWorkflowModuleDeletionMode] = useState<"trash" | "purge" | null>(null);
  const [workflowModuleRestoreRequest, setWorkflowModuleRestoreRequest] = useState<{
    moduleId: string;
    moduleName: string;
    bundlePath: string;
  } | null>(null);
  const workflowModulesInitializationRef = useRef<Promise<WorkflowModuleRecord[]> | null>(null);
  const [activeComfyTaskCounts, setActiveComfyTaskCounts] = useState<Record<string, number>>({});
  const [copiedApi, setCopiedApi] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);
  const [spacingGuides, setSpacingGuides] = useState<SpacingGuide[]>([]);
  const [canvasContextMenu, setCanvasContextMenu] = useState<CanvasContextMenuState | null>(null);
  const [videoDeletionRequest, setVideoDeletionRequest] = useState<VideoDeletionRequest | null>(null);
  const [videoRegenerationDraft, setVideoRegenerationDraft] = useState<VideoRegenerationDraft | null>(null);
  const [secondarySampleDraft, setSecondarySampleDraft] = useState<SecondarySampleDraft | null>(null);
  const saveTimers = useRef(new Map<string, number>());
  const pendingPatches = useRef(new Map<string, NodePatch>());
  const nodesSnapshot = useRef<CanvasFlowNode[]>([]);
  const edgesSnapshot = useRef<Edge[]>([]);
  const contentNodesCache = useRef<CanvasFlowNode[]>([]);
  const visibleNodeCache = useRef(new Map<string, VisibleNodeCacheEntry>());
  const alignmentGuidesSnapshot = useRef<AlignmentGuide[]>([]);
  const spacingGuidesSnapshot = useRef<SpacingGuide[]>([]);
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
  const videoRegenerationDialogRef = useRef<HTMLFormElement>(null);
  const secondarySampleDialogRef = useRef<HTMLFormElement>(null);
  const deleteUndoStack = useRef<DeletedBatch[]>([]);
  const nodeDeletionInProgress = useRef(false);
  const nodeClipboard = useRef<NodeClipboard | null>(null);
  const alignedDragPositions = useRef(new Map<string, { x: number; y: number }>());
  const { setCenter, fitView, screenToFlowPosition, getViewport } = useReactFlow<CanvasFlowNode, Edge>();

  const reserveNodePlacement = useCallback((
    canvasId: string,
    requestedPosition: { x: number; y: number } | undefined,
    width: number,
    height: number,
  ) => {
    const viewportCenter = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
    const startingPosition = requestedPosition ?? {
      x: viewportCenter.x - width / 2,
      y: viewportCenter.y - height / 2,
    };
    const position = nonOverlappingNodePosition(
      startingPosition,
      width,
      height,
      [
        ...nodesSnapshot.current.map(recordAtCurrentFlowPosition),
        ...incomingPlacementReservations.current,
      ],
    );
    const reservationId = `node-placement:${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    incomingPlacementReservations.current.push({
      id: reservationId,
      canvasId,
      kind: "placement-reservation",
      title: "",
      content: {},
      source: "placement-reservation",
      requestId: reservationId,
      ...position,
      width,
      height,
      status: "reserved",
      createdAt: now,
      updatedAt: now,
    });
    return { reservationId, position };
  }, [screenToFlowPosition]);

  const finishNodePlacementReservation = useCallback((
    reservationId: string,
    createdNodes: NodeRecord[] = [],
  ) => {
    incomingPlacementReservations.current = [
      ...incomingPlacementReservations.current.filter((node) => node.id !== reservationId),
      ...createdNodes,
    ];
    if (!createdNodes.length) return;
    const createdIds = new Set(createdNodes.map((node) => node.id));
    window.setTimeout(() => {
      incomingPlacementReservations.current = incomingPlacementReservations.current
        .filter((node) => !createdIds.has(node.id));
    }, 0);
  }, []);

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

  const contentNodes = useMemo(() => {
    const previous = contentNodesCache.current;
    const contentUnchanged = previous.length === nodes.length
      && previous.every((node, index) => (
        node.id === nodes[index].id && node.data === nodes[index].data
      ));
    if (contentUnchanged) return previous;
    contentNodesCache.current = nodes;
    return nodes;
  }, [nodes]);

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
    const stopMiddlePan = () => setMiddlePanActive(false);
    const preventMiddleAutoScroll = (event: MouseEvent) => {
      if (event.button !== 1) return;
      const target = event.target;
      if (target instanceof Element && target.closest(".react-flow")) {
        event.preventDefault();
      }
    };
    document.addEventListener("mousedown", preventMiddleAutoScroll, true);
    document.addEventListener("auxclick", preventMiddleAutoScroll, true);
    window.addEventListener("pointerup", stopMiddlePan);
    window.addEventListener("pointercancel", stopMiddlePan);
    window.addEventListener("blur", stopMiddlePan);
    return () => {
      document.removeEventListener("mousedown", preventMiddleAutoScroll, true);
      document.removeEventListener("auxclick", preventMiddleAutoScroll, true);
      window.removeEventListener("pointerup", stopMiddlePan);
      window.removeEventListener("pointercancel", stopMiddlePan);
      window.removeEventListener("blur", stopMiddlePan);
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
    document.documentElement.dataset.fontSize = uiFontSize;
    window.localStorage.setItem(UI_FONT_SIZE_STORAGE_KEY, uiFontSize);
  }, [uiFontSize]);

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

  const defaultH3WorkflowModuleId = workflowModuleDefaults["video-generation:reference-to-video"] ?? "";

  useEffect(() => {
    if (!activeProjectId || !workflowModulesReady) return;
    let disposed = false;
    const refresh = async () => {
      setH3LoraCatalogLoaded(false);
      try {
        const loras = await invoke<string[]>("get_comfyui_h3_loras", {
          serverUrl: COMFYUI_SERVER_URL,
          workflowModuleId: defaultH3WorkflowModuleId || undefined,
        });
        if (!disposed) {
          setH3LoraOptions((current) => (
            current.length === loras.length
            && current.every((item, index) => sameH3LoraName(item, loras[index]))
              ? current
              : loras
          ));
          setH3LoraCatalogLoaded(true);
          if (loras.length) {
            setH3LoraPreference((current) => {
              const fallback = loras.find((lora) => sameH3LoraName(lora, DEFAULT_H3_LORA_NAME))
                ?? loras[0];
              const primaryAvailable = loras.some(
                (lora) => sameH3LoraName(lora, current.loraName),
              );
              const secondaryAvailable = current.secondaryLoraBypassed || loras.some(
                (lora) => sameH3LoraName(lora, current.secondaryLoraName),
              );
              if (primaryAvailable && secondaryAvailable) return current;
              return {
                ...current,
                ...(!primaryAvailable ? { loraName: fallback } : {}),
                ...(!secondaryAvailable ? { secondaryLoraName: fallback } : {}),
              };
            });
          }
        }
      } catch {
        // Preserve the last successful catalog while ComfyUI is temporarily offline.
      }
    };
    void refresh();
    return () => {
      disposed = true;
    };
  }, [activeProjectId, defaultH3WorkflowModuleId, workflowModulesReady]);

  useEffect(() => {
    if (!workflowModulesReady) return;
    let disposed = false;
    setH3DiffusionModelCatalogLoaded(false);
    void invoke<string[]>("get_comfyui_h3_diffusion_models", {
      serverUrl: COMFYUI_SERVER_URL,
      workflowModuleId: defaultH3WorkflowModuleId || undefined,
    }).then((models) => {
      if (disposed) return;
      setH3DiffusionModelOptions(models);
      setH3DiffusionModelCatalogLoaded(true);
      if (!models.length) return;
      setH3DiffusionModelName((current) => (
        models.some((model) => sameH3DiffusionModelName(model, current))
          ? current
          : models.find((model) => sameH3DiffusionModelName(model, DEFAULT_H3_DIFFUSION_MODEL_NAME))
            ?? models[0]
      ));
    }).catch(() => {
      // Preserve the last successful catalog while ComfyUI is temporarily offline.
    });
    return () => {
      disposed = true;
    };
  }, [defaultH3WorkflowModuleId, workflowModulesReady]);

  const toggleTheme = () => setTheme((current) => current === "dark" ? "light" : "dark");

  const reportError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error);
    setNotice(`操作失败：${message}`);
  }, []);

  useEffect(() => {
    void invoke<Record<string, string> | null>("take_restored_frontend_settings")
      .then((settings) => {
        if (!settings) return;
        Object.keys(window.localStorage)
          .filter((key) => key.startsWith("infinite-canvas:"))
          .forEach((key) => window.localStorage.removeItem(key));
        Object.entries(settings).forEach(([key, value]) => {
          window.localStorage.setItem(key, value);
        });
        window.location.reload();
      })
      .catch(reportError);
  }, [reportError]);

  const portableFrontendSettings = useCallback(() => {
    const settings: Record<string, string> = {};
    Object.keys(window.localStorage)
      .filter((key) => key.startsWith("infinite-canvas:") && key !== COMFY_TASK_STORAGE_KEY)
      .forEach((key) => {
        const value = window.localStorage.getItem(key);
        if (value !== null) settings[key] = value;
      });
    return settings;
  }, []);

  const exportFullAppBackup = useCallback(async () => {
    let destinationPath: string | null;
    const now = new Date();
    const timestamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      "-",
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join("");
    try {
      destinationPath = await saveDialog({
        title: "保存 SuCanvas 软件备份",
        defaultPath: `SuCanvas-软件备份-${timestamp}.sucanvas-backup`,
        filters: [{ name: "SuCanvas 软件备份", extensions: ["sucanvas-backup"] }],
      });
    } catch (error) {
      reportError(error);
      return;
    }
    if (!destinationPath) return;
    setAppBackupBusy(true);
    setAppBackupMessage("");
    try {
      const result = await invoke<AppBackupSummary>("export_app_backup", {
        destinationPath,
        frontendSettings: portableFrontendSettings(),
      });
      setAppBackupMessageKind("success");
      setAppBackupMessage(`备份完成：${result.fileCount} 个数据文件`);
      setNotice(`软件备份已保存到 ${result.path}`);
      await revealItemInDir(result.path);
    } catch (error) {
      setAppBackupMessageKind("error");
      setAppBackupMessage(error instanceof Error ? error.message : String(error));
      reportError(error);
    } finally {
      setAppBackupBusy(false);
    }
  }, [portableFrontendSettings, reportError]);

  const chooseFullAppBackupToRestore = useCallback(async () => {
    let bundlePath: string | null;
    try {
      bundlePath = await openDialog({
        directory: false,
        multiple: false,
        title: "选择 SuCanvas 软件备份",
        filters: [{ name: "SuCanvas 软件备份", extensions: ["sucanvas-backup"] }],
      });
    } catch (error) {
      reportError(error);
      return;
    }
    if (bundlePath) setAppBackupRestorePath(bundlePath);
  }, [reportError]);

  const restoreFullAppBackup = useCallback(async () => {
    if (!appBackupRestorePath) return;
    setAppBackupBusy(true);
    setAppBackupMessage("");
    try {
      const result = await invoke<AppRestoreSummary>("stage_app_backup_restore", {
        bundlePath: appBackupRestorePath,
      });
      setAppBackupRestorePath(null);
      setAppBackupMessageKind("success");
      setAppBackupMessage(`备份已校验，${result.fileCount} 个数据文件将在下次启动时恢复。请关闭并重新打开软件。`);
      setNotice("恢复已准备完成，请关闭并重新打开 SuCanvas");
    } catch (error) {
      setAppBackupMessageKind("error");
      setAppBackupMessage(error instanceof Error ? error.message : String(error));
      reportError(error);
    } finally {
      setAppBackupBusy(false);
    }
  }, [appBackupRestorePath, reportError]);

  const refreshWorkflowModules = useCallback(async (includeDeleted = true) => {
    const modules = await invoke<WorkflowModuleRecord[]>("list_workflow_modules", {
      includeDeleted,
    });
    setWorkflowModules(modules);
    return modules;
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      WORKFLOW_MODULE_DEFAULTS_STORAGE_KEY,
      JSON.stringify(workflowModuleDefaults),
    );
  }, [workflowModuleDefaults]);

  useEffect(() => {
    let disposed = false;
    const loadOrCreate = async () => {
      let modules = await invoke<WorkflowModuleRecord[]>("list_workflow_modules", {
        includeDeleted: true,
      });
      if (!modules.length) {
        const created = await invoke<WorkflowModuleRecord>("save_workflow_module", {
          input: {
            name: "MiniMax H3 全能参考",
            capability: "video-generation",
            variant: "reference-to-video",
            revision: "当前",
            adapterKind: WORKFLOW_PACKAGE_ENGINE,
            sourceWorkflowPath: h3WorkflowPathRef.current,
            defaults: {
              ...h3ModelParameters,
              diffusionModelName: h3DiffusionModelName,
              loraName: h3LoraPreference.loraName,
              loraStrength: h3LoraPreference.loraStrength,
            },
          },
        });
        modules = [created];
      }
      return modules;
    };
    const initialize = async () => {
      try {
        if (!workflowModulesInitializationRef.current) {
          workflowModulesInitializationRef.current = loadOrCreate().catch((error) => {
            workflowModulesInitializationRef.current = null;
            throw error;
          });
        }
        const modules = await workflowModulesInitializationRef.current;
        if (disposed) return;
        setWorkflowModules(modules);
        const activeModules = modules.filter((module) => !module.deletedAt);
        setWorkflowModuleDefaults((current) => {
          const next = { ...current };
          for (const slot of WORKFLOW_MODULE_SLOTS) {
            const configured = next[slot];
            if (configured && activeModules.some((module) => module.id === configured && workflowSlotForModule(module) === slot)) {
              continue;
            }
            const fallback = activeModules.find((module) => workflowSlotForModule(module) === slot);
            if (fallback) next[slot] = fallback.id;
            else delete next[slot];
          }
          return next;
        });
        const selected = activeModules[0] ?? modules[0];
        if (selected) setSelectedWorkflowModuleId(selected.id);
      } catch (error) {
        if (!disposed) reportError(error);
      } finally {
        if (!disposed) setWorkflowModulesReady(true);
      }
    };
    void initialize();
    return () => {
      disposed = true;
    };
  }, [reportError]);

  const selectedWorkflowModule = workflowModules.find(
    (module) => module.id === selectedWorkflowModuleId,
  ) ?? null;

  useEffect(() => {
    if (!selectedWorkflowModule) return;
    setWorkflowModuleNameDraft(selectedWorkflowModule.name);
    setWorkflowModuleRevisionDraft(selectedWorkflowModule.revision);
    setWorkflowModuleCapabilityDraft(selectedWorkflowModule.capability);
    setWorkflowModuleVariantDraft(selectedWorkflowModule.variant);
    setWorkflowModulePathDraft(selectedWorkflowModule.workflowPath);
    setWorkflowModuleValidation(null);
    setWorkflowModuleReplacementId("");
    setWorkflowModuleBindingsDraft(JSON.stringify(selectedWorkflowModule.bindings, null, 2));
    setH3DiffusionModelName(selectedWorkflowModule.defaults.diffusionModelName);
  }, [selectedWorkflowModule]);

  const workflowModuleUsageCount = useCallback((moduleId: string) => {
    const records = new Map<string, NodeRecord>();
    for (const project of projects) {
      for (const record of project.nodes) records.set(record.id, record);
    }
    for (const node of nodesSnapshot.current) records.set(node.id, node.data.record);
    let count = 0;
    for (const record of records.values()) {
      const explicitModuleId = typeof record.content.workflowModuleId === "string"
        ? record.content.workflowModuleId
        : "";
      const implicitModuleId = record.kind === "video-generation"
        ? workflowModuleDefaults[workflowSlotForVideoMode(videoGenerationModeFromContent(record.content))] ?? ""
        : "";
      if ((explicitModuleId || implicitModuleId) === moduleId) count += 1;
      const snapshot = record.content.generationSnapshot;
      if (
        snapshot
        && typeof snapshot === "object"
        && !Array.isArray(snapshot)
      ) {
        const snapshotModuleId = typeof (snapshot as JsonObject).workflowModuleId === "string"
          ? (snapshot as JsonObject).workflowModuleId as string
          : workflowModuleDefaults["video-generation:reference-to-video"] ?? "";
        if (snapshotModuleId === moduleId) count += 1;
      }
    }
    return count;
  }, [projects, workflowModuleDefaults]);

  const validateWorkflowModuleDraft = useCallback(async () => {
    setWorkflowModulesBusy(true);
    try {
      const validation = await invoke<WorkflowModuleValidation>("validate_workflow_module_source", {
        sourceWorkflowPath: workflowModulePathDraft,
        adapterKind: selectedWorkflowModule?.adapterKind ?? WORKFLOW_PACKAGE_ENGINE,
        variant: workflowModuleVariantDraft,
        bindings: workflowBindingsFromDraft(workflowModuleBindingsDraft),
      });
      setWorkflowModuleValidation(validation);
      setNotice(validation.compatible ? "工作流与当前适配规则兼容" : "工作流兼容性检查未通过");
    } catch (error) {
      setWorkflowModuleValidation(null);
      reportError(error);
    } finally {
      setWorkflowModulesBusy(false);
    }
  }, [reportError, selectedWorkflowModule, workflowModuleBindingsDraft, workflowModulePathDraft, workflowModuleVariantDraft]);

  const saveWorkflowModuleDraft = useCallback(async (overwrite: boolean) => {
    if (overwrite && !selectedWorkflowModule) return;
    setWorkflowModulesBusy(true);
    try {
      const bindings = workflowBindingsFromDraft(workflowModuleBindingsDraft);
      const saved = await invoke<WorkflowModuleRecord>("save_workflow_module", {
        input: {
          id: overwrite ? selectedWorkflowModule?.id : undefined,
          name: workflowModuleNameDraft,
          capability: workflowModuleCapabilityDraft,
          variant: workflowModuleVariantDraft,
          revision: workflowModuleRevisionDraft,
          adapterKind: selectedWorkflowModule?.adapterKind ?? WORKFLOW_PACKAGE_ENGINE,
          sourceWorkflowPath: workflowModulePathDraft,
          bindings,
          adapter: overwrite && selectedWorkflowModule
            ? {
              ...selectedWorkflowModule.adapter,
              capability: workflowModuleCapabilityDraft,
              variant: workflowModuleVariantDraft,
              bindings: bindings ?? selectedWorkflowModule.bindings,
            }
            : undefined,
          uiSchema: overwrite ? selectedWorkflowModule?.uiSchema : undefined,
          defaults: overwrite && selectedWorkflowModule
            ? selectedWorkflowModule.defaults
            : {
              ...h3ModelParameters,
              diffusionModelName: h3DiffusionModelName,
              loraName: h3LoraPreference.loraName,
              loraStrength: h3LoraPreference.loraStrength,
            },
        },
      });
      await refreshWorkflowModules(true);
      setSelectedWorkflowModuleId(saved.id);
      const savedSlot = workflowSlotForModule(saved);
      setWorkflowModuleDefaults((current) => current[savedSlot]
        ? current
        : { ...current, [savedSlot]: saved.id });
      setWorkflowModuleValidation({ compatible: true, issues: [] });
      setNotice(overwrite ? `方案“${saved.name}”已覆盖，并建立恢复点` : `方案“${saved.name}”已创建`);
    } catch (error) {
      reportError(error);
    } finally {
      setWorkflowModulesBusy(false);
    }
  }, [h3DiffusionModelName, h3LoraPreference, h3ModelParameters, refreshWorkflowModules, reportError, selectedWorkflowModule, workflowModuleBindingsDraft, workflowModuleCapabilityDraft, workflowModuleNameDraft, workflowModulePathDraft, workflowModuleRevisionDraft, workflowModuleVariantDraft]);

  const setDefaultWorkflowModule = useCallback((module: WorkflowModuleRecord) => {
    setWorkflowModuleDefaults((current) => ({ ...current, [workflowSlotForModule(module)]: module.id }));
    if (module.capability === "video-generation" && module.variant !== "text-to-video") {
      setH3ModelParameters({
        primaryVideoSteps: module.defaults.primaryVideoSteps,
        primaryAudioSteps: module.defaults.primaryAudioSteps,
        secondarySchedulerSteps: module.defaults.secondarySchedulerSteps,
        primaryBrightness: module.defaults.primaryBrightness,
        primaryContrast: module.defaults.primaryContrast,
        primarySaturation: module.defaults.primarySaturation,
        secondaryBrightness: module.defaults.secondaryBrightness,
        secondaryContrast: module.defaults.secondaryContrast,
        secondarySaturation: module.defaults.secondarySaturation,
      });
      setH3LoraPreference((current) => ({
        ...current,
        loraName: module.defaults.loraName,
        loraStrength: module.defaults.loraStrength,
      }));
      setH3DiffusionModelName(module.defaults.diffusionModelName);
    }
    setNotice(`“${module.name}”已设为${workflowVariantLabel(module)}默认方案`);
  }, []);

  const replaceWorkflowModuleReferences = useCallback(async (
    sourceModuleId: string,
    replacement: WorkflowModuleRecord,
  ) => {
    const records = new Map<string, NodeRecord>();
    for (const project of projects) {
      for (const record of project.nodes) records.set(record.id, record);
    }
    for (const node of nodesSnapshot.current) records.set(node.id, node.data.record);
    const updatedRecords = new Map<string, NodeRecord>();
    for (const record of records.values()) {
      let changed = false;
      let content = record.content;
      const contentModuleId = typeof content.workflowModuleId === "string"
        ? content.workflowModuleId
        : "";
      const implicitContentModuleId = record.kind === "video-generation"
        ? workflowModuleDefaults[workflowSlotForVideoMode(videoGenerationModeFromContent(content))] ?? ""
        : "";
      if ((contentModuleId || implicitContentModuleId) === sourceModuleId) {
        content = {
          ...content,
          workflowModuleReplacedFrom: typeof content.workflowModuleReplacedFrom === "string"
            ? content.workflowModuleReplacedFrom
            : sourceModuleId,
          workflowModuleId: replacement.id,
          workflowModuleRevision: replacement.revision,
        };
        changed = true;
      }
      const snapshotValue = content.generationSnapshot;
      if (
        snapshotValue
        && typeof snapshotValue === "object"
        && !Array.isArray(snapshotValue)
      ) {
        const snapshotModuleId = typeof (snapshotValue as JsonObject).workflowModuleId === "string"
          ? (snapshotValue as JsonObject).workflowModuleId as string
          : workflowModuleDefaults["video-generation:reference-to-video"] ?? "";
        if (snapshotModuleId === sourceModuleId) {
          content = {
            ...content,
            generationSnapshot: {
              ...(snapshotValue as JsonObject),
              workflowModuleReplacedFrom: typeof (snapshotValue as JsonObject).workflowModuleReplacedFrom === "string"
                ? (snapshotValue as JsonObject).workflowModuleReplacedFrom
                : sourceModuleId,
              workflowModuleId: replacement.id,
              workflowModuleRevision: replacement.revision,
            },
          };
          changed = true;
        }
      }
      if (!changed) continue;
      const updated = await invoke<NodeRecord>("update_node", {
        input: { id: record.id, content },
      });
      updatedRecords.set(updated.id, updated);
    }
    if (!updatedRecords.size) return;
    setProjects((current) => current.map((project) => ({
      ...project,
      nodes: project.nodes.map((record) => updatedRecords.get(record.id) ?? record),
    })));
    setNodes((current) => current.map((node) => {
      const updated = updatedRecords.get(node.id);
      return updated ? { ...node, data: { ...node.data, record: updated } } : node;
    }));
  }, [projects, setNodes, workflowModuleDefaults]);

  const trashSelectedWorkflowModule = useCallback(async () => {
    if (!selectedWorkflowModule || selectedWorkflowModule.deletedAt) return;
    const replacement = workflowModules.find((module) => (
      !module.deletedAt
      && module.id === workflowModuleReplacementId
      && workflowSlotForModule(module) === workflowSlotForModule(selectedWorkflowModule)
    ));
    setWorkflowModulesBusy(true);
    try {
      if (replacement) {
        await replaceWorkflowModuleReferences(selectedWorkflowModule.id, replacement);
      }
      await invoke("trash_workflow_module", { id: selectedWorkflowModule.id });
      const modules = await refreshWorkflowModules(true);
      const next = modules.find((module) => !module.deletedAt);
      setSelectedWorkflowModuleId(next?.id ?? selectedWorkflowModule.id);
      setWorkflowModuleDefaults((current) => {
        const nextDefaults = { ...current };
        const slot = workflowSlotForModule(selectedWorkflowModule);
        if (nextDefaults[slot] === selectedWorkflowModule.id) {
          const fallback = modules.find((module) => !module.deletedAt && workflowSlotForModule(module) === slot);
          if (fallback) nextDefaults[slot] = fallback.id;
          else delete nextDefaults[slot];
        }
        return nextDefaults;
      });
      setNotice(`方案“${selectedWorkflowModule.name}”已移入回收站`);
    } catch (error) {
      reportError(error);
    } finally {
      setWorkflowModulesBusy(false);
    }
  }, [refreshWorkflowModules, replaceWorkflowModuleReferences, reportError, selectedWorkflowModule, workflowModuleReplacementId, workflowModules]);

  const restoreSelectedWorkflowModule = useCallback(async () => {
    if (!selectedWorkflowModule?.deletedAt) return;
    setWorkflowModulesBusy(true);
    try {
      const restored = await invoke<WorkflowModuleRecord>("restore_workflow_module", {
        id: selectedWorkflowModule.id,
      });
      await refreshWorkflowModules(true);
      setSelectedWorkflowModuleId(restored.id);
      setNotice(`方案“${restored.name}”已恢复`);
    } catch (error) {
      reportError(error);
    } finally {
      setWorkflowModulesBusy(false);
    }
  }, [refreshWorkflowModules, reportError, selectedWorkflowModule]);

  const purgeSelectedWorkflowModule = useCallback(async () => {
    if (!selectedWorkflowModule?.deletedAt) return;
    setWorkflowModulesBusy(true);
    try {
      await invoke("purge_workflow_module", { id: selectedWorkflowModule.id });
      const modules = await refreshWorkflowModules(true);
      setSelectedWorkflowModuleId(modules[0]?.id ?? "");
      setNotice("方案已彻底删除");
    } catch (error) {
      reportError(error);
    } finally {
      setWorkflowModulesBusy(false);
    }
  }, [refreshWorkflowModules, reportError, selectedWorkflowModule]);

  const restoreSelectedWorkflowModuleBackup = useCallback(async () => {
    if (!selectedWorkflowModule) return;
    setWorkflowModulesBusy(true);
    try {
      const restored = await invoke<WorkflowModuleRecord>("restore_workflow_module_backup", {
        id: selectedWorkflowModule.id,
      });
      await refreshWorkflowModules(true);
      setSelectedWorkflowModuleId(restored.id);
      setNotice(`方案“${restored.name}”已恢复到上一个覆盖前状态`);
    } catch (error) {
      reportError(error);
    } finally {
      setWorkflowModulesBusy(false);
    }
  }, [refreshWorkflowModules, reportError, selectedWorkflowModule]);

  const exportSelectedWorkflowModule = useCallback(async () => {
    if (!selectedWorkflowModule) return;
    setWorkflowModulesBusy(true);
    try {
      const exportPath = await invoke<string>("export_workflow_module", {
        id: selectedWorkflowModule.id,
      });
      await revealItemInDir(exportPath);
      setNotice(`方案已导出到 ${exportPath}`);
    } catch (error) {
      reportError(error);
    } finally {
      setWorkflowModulesBusy(false);
    }
  }, [reportError, selectedWorkflowModule]);

  const importWorkflowModuleBundle = useCallback(async () => {
    let bundlePath: string | null;
    try {
      bundlePath = await openDialog({
        directory: false,
        multiple: false,
        title: "选择工作流方案备份",
        filters: [{ name: "工作流方案备份", extensions: ["zip"] }],
      });
    } catch (error) {
      reportError(error);
      return;
    }
    if (!bundlePath) return;
    setWorkflowModulesBusy(true);
    try {
      const imported = await invoke<WorkflowModuleRecord>("import_workflow_module_bundle", {
        bundlePath,
      });
      await refreshWorkflowModules(true);
      setSelectedWorkflowModuleId(imported.id);
      const importedSlot = workflowSlotForModule(imported);
      setWorkflowModuleDefaults((current) => current[importedSlot]
        ? current
        : { ...current, [importedSlot]: imported.id });
      setNotice(`备份已导入为新方案“${imported.name}”`);
    } catch (error) {
      reportError(error);
    } finally {
      setWorkflowModulesBusy(false);
    }
  }, [refreshWorkflowModules, reportError]);

  const requestWorkflowModuleRestore = useCallback(async () => {
    if (!selectedWorkflowModule) return;
    let bundlePath: string | null;
    try {
      bundlePath = await openDialog({
        directory: false,
        multiple: false,
        title: "选择用于恢复当前方案的备份",
        filters: [{ name: "工作流方案备份", extensions: ["zip"] }],
      });
    } catch (error) {
      reportError(error);
      return;
    }
    if (!bundlePath) return;
    setWorkflowModuleRestoreRequest({
      moduleId: selectedWorkflowModule.id,
      moduleName: selectedWorkflowModule.name,
      bundlePath,
    });
  }, [reportError, selectedWorkflowModule]);

  const restoreWorkflowModuleFromBundle = useCallback(async () => {
    if (!workflowModuleRestoreRequest) return;
    setWorkflowModulesBusy(true);
    try {
      const restored = await invoke<WorkflowModuleRecord>("restore_workflow_module_bundle", {
        id: workflowModuleRestoreRequest.moduleId,
        bundlePath: workflowModuleRestoreRequest.bundlePath,
      });
      await refreshWorkflowModules(true);
      setSelectedWorkflowModuleId(restored.id);
      setWorkflowModuleRestoreRequest(null);
      setNotice(`当前方案已从备份恢复为“${restored.name}”，覆盖前状态已保存为恢复点`);
    } catch (error) {
      reportError(error);
    } finally {
      setWorkflowModulesBusy(false);
    }
  }, [refreshWorkflowModules, reportError, workflowModuleRestoreRequest]);

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

  const rememberH3LoraPreference = useCallback((patch: H3LoraPreferencePatch) => {
    setH3LoraPreference((current) => {
      const next = { ...current, ...patch };
      const content: JsonObject = {
        loraName: next.loraName,
        loraStrength: next.loraStrength,
        loraBypassed: next.loraBypassed,
        secondaryLoraName: next.secondaryLoraName,
        secondaryLoraStrength: next.secondaryLoraStrength,
        secondaryLoraBypassed: next.secondaryLoraBypassed,
      };
      return {
        loraName: h3LoraNameFromContent(content),
        loraStrength: h3LoraStrengthFromContent(content),
        loraBypassed: h3LoraBypassedFromContent(content),
        secondaryLoraName: h3SecondaryLoraNameFromContent(content),
        secondaryLoraStrength: h3SecondaryLoraStrengthFromContent(content),
        secondaryLoraBypassed: h3SecondaryLoraBypassedFromContent(content),
      };
    });
  }, []);

  useEffect(() => {
    if (!h3LoraCatalogLoaded || !h3LoraOptions.length) return;
    const fallback = h3LoraOptions.find((lora) => sameH3LoraName(lora, DEFAULT_H3_LORA_NAME))
      ?? h3LoraOptions[0];
    for (const node of nodesSnapshot.current) {
      const record = node.data.record;
      if (record.kind !== "video-generation") continue;
      const currentLoraName = h3LoraNameFromContent(record.content);
      const currentSecondaryLoraName = h3SecondaryLoraNameFromContent(record.content);
      const primaryNeedsReplacement = Boolean(currentLoraName) && !h3LoraOptions.some(
        (lora) => sameH3LoraName(lora, currentLoraName),
      );
      const secondaryNeedsReplacement = Boolean(currentSecondaryLoraName)
        && !h3SecondaryLoraBypassedFromContent(record.content)
        && !h3LoraOptions.some((lora) => sameH3LoraName(lora, currentSecondaryLoraName));
      if (!primaryNeedsReplacement && !secondaryNeedsReplacement) continue;
      changeNode(record.id, {
        content: {
          ...record.content,
          ...(primaryNeedsReplacement ? { generationLoraName: fallback } : {}),
          ...(secondaryNeedsReplacement ? { generationSecondaryLoraName: fallback } : {}),
          status: "idle",
          validationMessage: "",
        },
      });
    }
  }, [changeNode, h3LoraCatalogLoaded, h3LoraOptions]);

  useEffect(() => {
    if (!workflowModulesReady) return;
    const activeModules = workflowModules.filter((module) => !module.deletedAt);
    for (const node of nodesSnapshot.current) {
      const record = node.data.record;
      if (record.kind === "video-generation") {
        const configuredId = typeof record.content.workflowModuleId === "string"
          ? record.content.workflowModuleId
          : "";
        if (configuredId) continue;
        const slot = workflowSlotForVideoMode(videoGenerationModeFromContent(record.content));
        const fallbackId = workflowModuleDefaults[slot] ?? "";
        const fallback = activeModules.find((module) => module.id === fallbackId && workflowSlotForModule(module) === slot);
        if (!fallback) continue;
        changeNode(record.id, {
          content: {
            ...record.content,
            workflowModuleId: fallback.id,
            workflowModuleRevision: fallback.revision,
          },
        });
        continue;
      }
      if (record.kind !== "generated-video") continue;
      const snapshotValue = record.content.generationSnapshot;
      if (!snapshotValue || typeof snapshotValue !== "object" || Array.isArray(snapshotValue)) continue;
      const snapshot = snapshotValue as JsonObject;
      if (typeof snapshot.workflowModuleId === "string" && snapshot.workflowModuleId) continue;
      const sourceGeneratorId = typeof record.content.sourceGeneratorId === "string"
        ? record.content.sourceGeneratorId
        : "";
      const sourceGenerator = nodesSnapshot.current.find((candidate) => candidate.id === sourceGeneratorId)?.data.record;
      const sourceModuleId = sourceGenerator && typeof sourceGenerator.content.workflowModuleId === "string"
        ? sourceGenerator.content.workflowModuleId
        : workflowModuleDefaults["video-generation:reference-to-video"] ?? "";
      const fallback = activeModules.find((module) => module.id === sourceModuleId);
      if (!fallback) continue;
      changeNode(record.id, {
        content: {
          ...record.content,
          generationSnapshot: {
            ...snapshot,
            workflowModuleId: fallback.id,
            workflowModuleRevision: fallback.revision,
          },
        },
      });
    }
  }, [changeNode, workflowModuleDefaults, workflowModules, workflowModulesReady]);

  useEffect(() => {
    if (!activeProjectId) return;
    const reconstructedTasks = contentNodes
      .map((node) => node.data.record)
      .filter((record) => {
        const status = record.content.status;
        return status === "running"
          || status === "cancelling"
          || (status === "invalid" && record.content.validationMessage === "生成任务已中断或未记录");
      })
      .map(persistedComfyTaskFromPlaceholder)
      .filter((task): task is PersistedComfyTask => Boolean(task))
      .filter((task) => !persistedComfyTasks.current.some(
        (candidate) => candidate.clientId === task.clientId,
      ));
    if (reconstructedTasks.length) {
      savePersistedComfyTasks([
        ...persistedComfyTasks.current,
        ...reconstructedTasks,
      ]);
    }
    const persistedNodeIds = new Set(
      persistedComfyTasks.current
        .filter((task) => task.canvasId === activeProjectId)
        .flatMap((task) => [task.nodeId, task.placeholderNodeId].filter(
          (nodeId): nodeId is string => Boolean(nodeId),
        )),
    );
    contentNodes.forEach((node) => {
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
  }, [activeProjectId, changeNode, contentNodes, savePersistedComfyTasks]);

  useEffect(() => {
    const recordsById = new Map(contentNodes.map((node) => [node.id, node.data.record]));
    const mediaKindsByTarget = new Map<string, string[]>();
    const textInputCountByTarget = new Map<string, number>();
    const textInputIdsByTarget = new Map<string, string[]>();

    for (const edge of edges) {
      const source = recordsById.get(edge.source);
      if (!source) continue;
      if (source.kind === "text") {
        textInputCountByTarget.set(
          edge.target,
          (textInputCountByTarget.get(edge.target) ?? 0) + 1,
        );
        textInputIdsByTarget.set(edge.target, [
          ...(textInputIdsByTarget.get(edge.target) ?? []),
          source.id,
        ]);
        continue;
      }
      if (!["image", "audio", "video"].includes(source.kind)) continue;
      const kinds = mediaKindsByTarget.get(edge.target) ?? [];
      kinds.push(source.kind);
      mediaKindsByTarget.set(edge.target, kinds);
    }

    for (const node of contentNodes) {
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
      const currentTextInputCount = textInputCountByTarget.get(node.id) ?? 0;
      const storedLayoutTextInputCount = typeof record.content.layoutTextInputCount === "number"
        && Number.isFinite(record.content.layoutTextInputCount)
        ? Math.max(0, Math.floor(record.content.layoutTextInputCount))
        : null;
      const mediaKinds = mediaKindsByTarget.get(node.id) ?? [];
      const fullContentHeight = videoGenerationAutoHeight(
        mediaKinds,
        currentTextInputCount,
        record.width,
      );
      let desiredHeight = Math.min(
        fullContentHeight,
        Math.max(VIDEO_NODE_BASE_HEIGHT, record.height),
      );
      if (storedLayoutTextInputCount === null) {
        const currentTextOnlyHeight = videoGenerationAutoHeight(
          [],
          currentTextInputCount,
          record.width,
        );
        desiredHeight = Math.min(
          fullContentHeight,
          Math.max(desiredHeight, currentTextOnlyHeight),
        );
      } else if (storedLayoutTextInputCount !== currentTextInputCount) {
        const previousContentHeight = videoGenerationAutoHeight(
          mediaKinds,
          storedLayoutTextInputCount,
          record.width,
        );
        desiredHeight = Math.min(
          fullContentHeight,
          Math.max(
            VIDEO_NODE_BASE_HEIGHT,
            record.height + fullContentHeight - previousContentHeight,
          ),
        );
      }
      const connectedTextRecords = (textInputIdsByTarget.get(node.id) ?? [])
        .map((inputId) => recordsById.get(inputId))
        .filter((input): input is NodeRecord => input?.kind === "text");
      const connectedTextIds = orderedNodeRecordsFromContent(
        record.content,
        "textInputOrder",
        connectedTextRecords,
      ).map((input) => input.id);
      const storedActiveTextId = typeof record.content.activeTextInputId === "string"
        ? record.content.activeTextInputId
        : "";
      const activeTextInputId = connectedTextIds.includes(storedActiveTextId)
        ? storedActiveTextId
        : connectedTextIds[0] ?? "";
      if (
        Math.abs(record.height - desiredHeight) < 0.5
        && storedManualHeight !== null
        && Math.abs(storedManualHeight - desiredHeight) < 0.5
        && storedActiveTextId === activeTextInputId
        && storedLayoutTextInputCount === currentTextInputCount
      ) continue;
      changeNode(node.id, {
        height: desiredHeight,
        content: {
          ...record.content,
          manualHeight: desiredHeight,
          activeTextInputId,
          layoutTextInputCount: currentTextInputCount,
        },
      });
    }
  }, [changeNode, contentNodes, edges]);

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
    async (nodesToDelete: CanvasFlowNode[], deleteSourceFiles = false) => {
      if (!nodesToDelete.length || nodeDeletionInProgress.current) return;
      nodeDeletionInProgress.current = true;
      const records = nodesToDelete.map((node) => node.data.record);
      try {
        const generatedVideoRecords = records.filter((record) => (
          record.content.generationPlaceholder !== true
          && record.kind === "generated-video"
        ));
        const choice = deleteSourceFiles && generatedVideoRecords.length > 0
          ? "node-and-file"
          : await requestVideoDeletionChoice(records);
        if (choice === "cancel") return;

        const cancelledPlaceholderTaskCount = await cancelTasksForDeletedPlaceholders(records);

        const ids = records.map((record) => record.id);
        await flushNodePatches(ids);
        const batch = await invoke<DeletedBatch>("delete_nodes_undoable", {
          input: { ids },
        });

        if (choice === "node-and-file") {
          const filePaths = videoFilePathsForRecords(
            deleteSourceFiles ? generatedVideoRecords : records,
          );
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
    async (id: string, deleteSourceFile = false) => {
      const node = nodesSnapshot.current.find((candidate) => candidate.id === id);
      if (node) await deleteCanvasNodes([node], deleteSourceFile);
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

  const saveH3ModelParameters = useCallback(async () => {
    const {
      primaryVideoSteps,
      primaryAudioSteps,
      secondarySchedulerSteps,
      primaryBrightness,
      primaryContrast,
      primarySaturation,
      secondaryBrightness,
      secondaryContrast,
      secondarySaturation,
    } = h3ModelParametersDraft;
    if (!Number.isInteger(primaryVideoSteps) || primaryVideoSteps < 1 || primaryVideoSteps > 1000) {
      setNotice("一采 Video Steps 必须是 1 到 1000 的整数");
      return;
    }
    if (!Number.isInteger(primaryAudioSteps) || primaryAudioSteps < primaryVideoSteps || primaryAudioSteps > 1000) {
      setNotice("一采 Audio Steps 必须是 1 到 1000 的整数，且不能小于 Video Steps");
      return;
    }
    if (!Number.isInteger(secondarySchedulerSteps) || secondarySchedulerSteps < 1 || secondarySchedulerSteps > 10000) {
      setNotice("二采基本调度器 Steps 必须是 1 到 10000 的整数");
      return;
    }
    const invalidColorAdjustment = ([
      ["一采亮度", primaryBrightness],
      ["一采对比度", primaryContrast],
      ["一采饱和度", primarySaturation],
      ["二采亮度", secondaryBrightness],
      ["二采对比度", secondaryContrast],
      ["二采饱和度", secondarySaturation],
    ] as const).find(([, value]) => (
      typeof value !== "number"
      || !Number.isFinite(value)
      || value < 0
      || value > 3
    ));
    if (invalidColorAdjustment) {
      setNotice(`${invalidColorAdjustment[0]}必须是 0.00 到 3.00 之间的数值`);
      return;
    }
    const module = selectedWorkflowModule?.capability === "video-generation"
      && selectedWorkflowModule.variant !== "text-to-video"
      && !selectedWorkflowModule.deletedAt
      ? selectedWorkflowModule
      : workflowModules.find((candidate) => (
        !candidate.deletedAt
        && candidate.id === workflowModuleDefaults["video-generation:reference-to-video"]
      ));
    if (!module) {
      setNotice("没有可保存模型参数的视频生成方案");
      return;
    }
    setWorkflowModulesBusy(true);
    try {
      await invoke<WorkflowModuleRecord>("save_workflow_module", {
        input: {
          id: module.id,
          name: module.name,
          capability: module.capability,
          variant: module.variant,
          revision: module.revision,
          adapterKind: module.adapterKind,
          sourceWorkflowPath: module.workflowPath,
          bindings: module.bindings,
          adapter: module.adapter,
          uiSchema: module.uiSchema,
          defaults: {
            ...h3ModelParametersDraft,
            diffusionModelName: h3DiffusionModelName,
            loraName: h3LoraPreference.loraName,
            loraStrength: h3LoraPreference.loraStrength,
          },
        },
      });
      await refreshWorkflowModules(true);
    } catch (error) {
      reportError(error);
      return;
    } finally {
      setWorkflowModulesBusy(false);
    }
    setH3ModelParameters(h3ModelParametersDraft);
    window.localStorage.setItem(
      H3_MODEL_PARAMETERS_STORAGE_KEY,
      JSON.stringify(h3ModelParametersDraft),
    );
    setSettingsOpen(false);
    setNotice("模型参数已保存");
  }, [h3DiffusionModelName, h3LoraPreference, h3ModelParametersDraft, refreshWorkflowModules, reportError, selectedWorkflowModule, workflowModuleDefaults, workflowModules]);

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
    const mode = videoGenerationModeFromContent(generator.content);
    const assetPaths = (kind: string) => orderedMedia
      .filter((record) => record.kind === kind)
      .map((record) => typeof record.content.assetPath === "string" ? record.content.assetPath : "")
      .filter(Boolean);
    const imageAssets = orderedMedia
      .filter((record) => record.kind === "image")
      .map((record, index) => ({
        path: typeof record.content.assetPath === "string" ? record.content.assetPath : "",
        role: frameRoleFromContent(generator.content, record.id, index),
      }))
      .filter((asset) => Boolean(asset.path));
    const capability = workflowCapabilityForVideoMode(mode);
    const slot = workflowSlotForVideoMode(mode);
    const configuredModuleId = typeof generator.content.workflowModuleId === "string"
      ? generator.content.workflowModuleId
      : workflowModuleDefaults[slot] ?? "";
    const workflowModule = workflowModules.find((module) => (
      !module.deletedAt
      && module.capability === capability
      && module.variant === mode
      && module.id === configuredModuleId
    ));
    const moduleParameters = workflowModule?.defaults ?? {
      ...h3ModelParameters,
      diffusionModelName: h3DiffusionModelNameFromContent(generator.content),
      loraName: h3LoraNameFromContent(generator.content),
      loraStrength: h3LoraStrengthFromContent(generator.content),
    };
    const activeTextInput = activeTextInputFromContent(generator.content, textInputs);
    const activePromptVersion = activeTextInput
      ? activePromptVersionFromContent(activeTextInput.content)
      : null;
    return {
      prompt: activeTextInput ? textFromContent(activeTextInput.content) : "",
      promptNodeId: activeTextInput?.id ?? "",
      promptNodeTitle: activeTextInput?.title ?? "",
      promptNodeIdSource: activeTextInput ? "captured" : "",
      promptVersionId: activePromptVersion?.id ?? "",
      promptVersionLabel: activePromptVersion?.label ?? "",
      durationSeconds: videoDurationFromContent(generator.content),
      aspectRatio: videoAspectRatioFromContent(generator.content),
      primaryResolutionMegapixels: primaryVideoResolutionFromContent(generator.content),
      secondaryResolutionMegapixels: secondaryVideoResolutionFromContent(generator.content),
      primaryVideoSteps: primaryVideoStepsFromContent(
        generator.content,
        moduleParameters.primaryVideoSteps,
      ),
      primaryAudioSteps: moduleParameters.primaryAudioSteps,
      secondarySchedulerSteps: secondarySchedulerStepsFromContent(
        generator.content,
        moduleParameters.secondarySchedulerSteps,
      ),
      primaryBrightness: moduleParameters.primaryBrightness,
      primaryContrast: moduleParameters.primaryContrast,
      primarySaturation: moduleParameters.primarySaturation,
      secondaryBrightness: moduleParameters.secondaryBrightness,
      secondaryContrast: moduleParameters.secondaryContrast,
      secondarySaturation: moduleParameters.secondarySaturation,
      diffusionModelName: moduleParameters.diffusionModelName,
      loraName: h3LoraNameFromContent(generator.content),
      loraStrength: h3LoraStrengthFromContent(generator.content),
      loraStrengthRecorded: true,
      loraBypassed: h3LoraBypassedFromContent(generator.content),
      secondaryLoraName: h3SecondaryLoraNameFromContent(generator.content),
      secondaryLoraStrength: h3SecondaryLoraStrengthFromContent(generator.content),
      secondaryLoraStrengthRecorded: true,
      secondaryLoraBypassed: h3SecondaryLoraBypassedFromContent(generator.content),
      refImageSize: refImageSizeFromContent(generator.content),
      refImageSizeRecorded: true,
      imagePaths: imageAssets.map((asset) => asset.path),
      imageRoles: mode === "first-last-frame"
        ? imageAssets.map((asset) => asset.role)
        : [],
      audioPaths: assetPaths("audio"),
      videoPaths: assetPaths("video"),
      workflowModuleId: workflowModule?.id ?? "",
      workflowModuleRevision: workflowModule?.revision ?? "",
    };
  }, [h3ModelParameters, workflowModuleDefaults, workflowModules]);

  const generatedPreviewHeightForAspectRatio = useCallback((aspectRatio: VideoAspectRatio) => {
    const previewWidth = generatedVideoPreviewWidthForRatio(videoAspectRatioValue(aspectRatio));
    return Math.min(
      2400,
      Math.max(
        180,
        previewWidth / videoAspectRatioValue(aspectRatio)
          + GENERATED_VIDEO_FOOTER_HEIGHT,
      ),
    );
  }, []);

  const createGenerationPlaceholder = useCallback(async ({
    source,
    clientId,
    snapshot,
    secondary,
    sourceGeneratorId,
    edgeSourceId = source.id,
    placeBelowSource = false,
  }: {
    source: NodeRecord;
    clientId: string;
    snapshot: GenerationSnapshot;
    secondary: boolean;
    sourceGeneratorId: string;
    edgeSourceId?: string;
    placeBelowSource?: boolean;
  }) => {
    const previewWidth = generatedVideoPreviewWidthForRatio(videoAspectRatioValue(snapshot.aspectRatio));
    const previewHeight = generatedPreviewHeightForAspectRatio(snapshot.aspectRatio);
    const placementRecords = [
      ...nodesSnapshot.current.map(recordAtCurrentFlowPosition),
      ...incomingPlacementReservations.current,
    ];
    const position = placeBelowSource
      ? generatedPreviewPositionBelow(source, placementRecords, previewWidth, previewHeight)
      : generatedPreviewPosition(source, placementRecords, previewWidth, previewHeight);
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
          sourceNodeId: edgeSourceId,
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

  const finalizeGenerationPlaceholder = useCallback(async (
    placeholder: NodeRecord,
    patch: JsonObject,
  ): Promise<NodeRecord | null> => {
    if (completedGenerationPlaceholders.current.has(placeholder.id)) return null;
    completedGenerationPlaceholders.current.add(placeholder.id);
    const visiblePlaceholder = nodesSnapshot.current.find(
      (node) => node.id === placeholder.id,
    )?.data.record;
    const latestPlaceholder = visiblePlaceholder?.content.generationPlaceholder === true
      ? visiblePlaceholder
      : placeholder;
    try {
      await flushNodePatches([placeholder.id]);
      const record = await invoke<NodeRecord>("update_node", {
        input: {
          id: placeholder.id,
          content: {
            ...latestPlaceholder.content,
            ...patch,
          },
        },
      });
      setNodes((current) => current.map((node) => node.id === placeholder.id
        ? { ...node, data: { ...node.data, record } }
        : node));
      return record;
    } catch (error) {
      if (String(error).includes("node not found")) {
        return null;
      }
      completedGenerationPlaceholders.current.delete(placeholder.id);
      throw error;
    }
  }, [flushNodePatches, setNodes]);

  const completeGenerationPlaceholder = useCallback(async (
    placeholderNodeId: string | undefined,
    title: string,
    content: JsonObject,
  ): Promise<NodeRecord | null> => {
    if (!placeholderNodeId) return null;
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

  const executeVideoNode = useCallback(async (
    targetId: string,
    regeneration?: VideoRegenerationRequest,
  ) => {
    const targetNode = nodesSnapshot.current.find((node) => node.id === targetId);
    if (!targetNode) {
      setNotice("无法执行：找不到视频生成节点");
      return;
    }
    const target = recordAtCurrentFlowPosition(targetNode);
    const requestedSeedMode = regeneration ? "fixed" : seedModeFromContent(target.content);
    const requestedFixedSeed = regeneration?.seed ?? fixedSeedFromContent(target.content);
    const activeClients = runningComfyClients.current.get(targetId);
    if (target.content.status === "cancelling") {
      setNotice("当前任务正在取消，请稍后再提交");
      return;
    }
    if (
      !regeneration
      && requestedSeedMode === "fixed"
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
    const snapshot = regeneration?.snapshot ?? generationSnapshotForGenerator(targetId);
    if (!snapshot?.prompt.trim()) {
      setNotice("无法执行：找不到已保存的提示词与素材参数");
      return;
    }
    const mode = videoGenerationModeFromContent(target.content);
    const capability = workflowCapabilityForVideoMode(mode);
    const slot = workflowSlotForVideoMode(mode);
    const configuredModuleId = regeneration
      ? snapshot.workflowModuleId
      : typeof target.content.workflowModuleId === "string"
        ? target.content.workflowModuleId
        : workflowModuleDefaults[slot] ?? "";
    const configuredModule = workflowModules.find((module) => (
      !module.deletedAt
      && module.id === configuredModuleId
      && (regeneration || (
        module.capability === capability
        && module.variant === mode
      ))
    ));
    if (!configuredModule) {
      const label = WORKFLOW_VIDEO_VARIANTS.find((item) => item.value === mode)?.label ?? mode;
      const message = configuredModuleId
        ? `当前节点绑定的${label}方案已缺失，请重新选择`
        : `${label}尚未配置工作流方案`;
      changeNode(targetId, {
        content: { ...target.content, status: "invalid", validationMessage: message },
      });
      setNotice(`无法执行：${message}`);
      return;
    }

    if (configuredModule.variant === "first-last-frame") {
      const mediaError = snapshot.audioPaths.length || snapshot.videoPaths.length
        ? "首尾帧模式不能包含音频或视频参考"
        : snapshot.imagePaths.length !== 2
          ? `首尾帧模式必须提供两张有效图片（首帧和尾帧），当前为 ${snapshot.imagePaths.length} 张`
          : null;
      if (mediaError) {
        changeNode(targetId, {
          content: { ...target.content, status: "invalid", validationMessage: mediaError },
        });
        setNotice(`无法执行：${mediaError}`);
        return;
      }
    }
    if (configuredModule.variant === "image-to-video") {
      const mediaError = snapshot.audioPaths.length || snapshot.videoPaths.length
        ? "图生视频模式不能包含音频或视频参考"
        : snapshot.imagePaths.length !== 1
          ? `图生视频模式必须提供一张有效的首帧图片，当前为 ${snapshot.imagePaths.length} 张`
          : null;
      if (mediaError) {
        changeNode(targetId, {
          content: { ...target.content, status: "invalid", validationMessage: mediaError },
        });
        setNotice(`无法执行：${mediaError}`);
        return;
      }
    }
    if (configuredModule.variant === "last-frame-to-video") {
      const mediaError = snapshot.audioPaths.length || snapshot.videoPaths.length
        ? "尾帧生视频模式不能包含音频或视频参考"
        : snapshot.imagePaths.length !== 1
          ? `尾帧生视频模式必须提供一张有效的尾帧图片，当前为 ${snapshot.imagePaths.length} 张`
          : null;
      if (mediaError) {
        changeNode(targetId, {
          content: { ...target.content, status: "invalid", validationMessage: mediaError },
        });
        setNotice(`无法执行：${mediaError}`);
        return;
      }
    }

    if (!snapshot.loraBypassed && !snapshot.loraName) {
      const message = "请先选择一采 LoRA";
      changeNode(targetId, {
        content: { ...target.content, status: "invalid", validationMessage: message },
      });
      setNotice(`无法执行：${message}`);
      return;
    }
    if (!snapshot.secondaryLoraBypassed && !snapshot.secondaryLoraName) {
      const message = "请先选择二采 LoRA";
      changeNode(targetId, {
        content: { ...target.content, status: "invalid", validationMessage: message },
      });
      setNotice(`无法执行：${message}`);
      return;
    }
    if (
      h3LoraCatalogLoaded
      && !snapshot.loraBypassed
      && !h3LoraOptions.some((lora) => sameH3LoraName(lora, snapshot.loraName))
    ) {
      const message = h3LoraOptions.length
        ? "所选 LoRA 已不在 MinimaxH3 目录中，请重新选择"
        : "MinimaxH3 目录中没有可用 LoRA，请添加 LoRA 或开启 Bypass";
      changeNode(targetId, {
        content: { ...target.content, status: "invalid", validationMessage: message },
      });
      setNotice(`无法执行：${message}`);
      return;
    }
    if (
      h3LoraCatalogLoaded
      && !snapshot.secondaryLoraBypassed
      && !h3LoraOptions.some((lora) => sameH3LoraName(lora, snapshot.secondaryLoraName))
    ) {
      const message = h3LoraOptions.length
        ? "所选二采 LoRA 已不在 MinimaxH3 目录中，请重新选择"
        : "MinimaxH3 目录中没有可用二采 LoRA，请添加 LoRA 或开启二采 Bypass";
      changeNode(targetId, {
        content: { ...target.content, status: "invalid", validationMessage: message },
      });
      setNotice(`无法执行：${message}`);
      return;
    }
    if (
      h3DiffusionModelCatalogLoaded
      && !h3DiffusionModelOptions.some((model) => (
        sameH3DiffusionModelName(model, snapshot.diffusionModelName)
      ))
    ) {
      const message = h3DiffusionModelOptions.length
        ? "所选 MiniMax H3 基础模型已不在 diffusion_models/MinimaxH3 目录中，请重新选择"
        : "diffusion_models/MinimaxH3 目录中没有可用基础模型";
      changeNode(targetId, {
        content: { ...target.content, status: "invalid", validationMessage: message },
      });
      setNotice(`无法执行：${message}`);
      return;
    }
    const clientId = crypto.randomUUID();
    const taskSubmittedAt = Date.now();
    let placeholder: NodeRecord;
    try {
      placeholder = await createGenerationPlaceholder({
        source: regeneration?.sourcePreview ?? target,
        clientId,
        snapshot,
        secondary: false,
        sourceGeneratorId: targetId,
        edgeSourceId: targetId,
        placeBelowSource: Boolean(regeneration),
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
    let preserveComfyTaskRecord = false;
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
          workflowModuleId: snapshot.workflowModuleId,
          workflowPath: h3WorkflowPathRef.current,
          inputRootPath: comfyInputRootRef.current,
          clientId,
          prompt: snapshot.prompt,
          seedMode: requestedSeedMode,
          seed: requestedFixedSeed,
          durationSeconds: snapshot.durationSeconds,
          aspectRatio: snapshot.aspectRatio,
          primaryResolutionMegapixels: snapshot.primaryResolutionMegapixels,
          secondaryResolutionMegapixels: snapshot.secondaryResolutionMegapixels,
          primaryVideoSteps: snapshot.primaryVideoSteps,
          primaryAudioSteps: snapshot.primaryAudioSteps,
          secondarySchedulerSteps: snapshot.secondarySchedulerSteps,
          primaryBrightness: snapshot.primaryBrightness,
          primaryContrast: snapshot.primaryContrast,
          primarySaturation: snapshot.primarySaturation,
          secondaryBrightness: snapshot.secondaryBrightness,
          secondaryContrast: snapshot.secondaryContrast,
          secondarySaturation: snapshot.secondarySaturation,
          secondarySamplingEnabled: false,
          diffusionModelName: snapshot.diffusionModelName,
          loraName: snapshot.loraName,
          loraStrength: snapshot.loraStrength,
          loraBypassed: snapshot.loraBypassed,
          secondaryLoraName: snapshot.secondaryLoraName,
          secondaryLoraStrength: snapshot.secondaryLoraStrength,
          secondaryLoraBypassed: snapshot.secondaryLoraBypassed,
          refImageSize: snapshot.refImageSize,
          imagePaths: snapshot.imagePaths,
          imageRoles: snapshot.imageRoles,
          audioPaths: snapshot.audioPaths,
          videoPaths: snapshot.videoPaths,
          secondarySource: null,
        },
      });
      if (!result.outputs.length) throw new Error("ComfyUI 没有返回视频输出");
      if (cancelledComfyClients.current.has(clientId)) return;
      const generationElapsedSeconds = validExecutionElapsedSeconds(result.executionElapsedSeconds);

      const previewWidth = generatedVideoPreviewWidthForRatio(videoAspectRatioValue(snapshot.aspectRatio));
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
          const position = regeneration
            ? generatedPreviewPositionBelow(
              regeneration.sourcePreview,
              placementRecords,
              previewWidth,
              previewHeight,
            )
            : generatedPreviewPosition(target, placementRecords, previewWidth, previewHeight);
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
        try {
          await finalizeGenerationPlaceholder(placeholder, {
            status: "cancelled",
            executionProgress: null,
            validationMessage: "已取消 ComfyUI 生成",
          });
        } catch (error) {
          preserveComfyTaskRecord = true;
          reportError(error);
        }
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
      try {
        await finalizeGenerationPlaceholder(placeholder, {
          status: "invalid",
          executionProgress: null,
          validationMessage: `生成失败：${message}`,
        });
      } catch (placeholderError) {
        preserveComfyTaskRecord = true;
        reportError(placeholderError);
      }
      reportError(error);
    } finally {
      progressSocket?.close();
      cancelledComfyClients.current.delete(clientId);
      ownedComfyClients.current.delete(clientId);
      if (!preserveComfyTaskRecord) forgetComfyTask(clientId);
      unregisterComfyTask(targetId, clientId);
    }
  }, [changeNode, completeGenerationPlaceholder, createGenerationPlaceholder, finalizeGenerationPlaceholder, forgetComfyTask, generatedPreviewHeightForAspectRatio, generationSnapshotForGenerator, h3DiffusionModelCatalogLoaded, h3DiffusionModelOptions, h3LoraCatalogLoaded, h3LoraOptions, registerComfyTask, rememberComfyTask, reportError, setEdges, setNodes, unregisterComfyTask, updateGenerationPlaceholder, workflowModuleDefaults, workflowModules]);

  const regenerateGeneratedVideo = useCallback(async (
    previewId: string,
    snapshotOverride?: GenerationSnapshot,
    seedOverride?: string,
  ) => {
    const previewNode = nodesSnapshot.current.find((node) => node.id === previewId);
    if (!previewNode || previewNode.data.record.kind !== "generated-video") {
      setNotice("无法重新生成：找不到视频预览节点");
      return;
    }
    const sourcePreview = recordAtCurrentFlowPosition(previewNode);
    if (typeof sourcePreview.content.sourcePreviewId === "string") {
      setNotice("二采视频不支持重新生成");
      return;
    }
    if (sourcePreview.content.generationPlaceholder === true) {
      setNotice("当前视频仍在生成中");
      return;
    }
    const storedSnapshot = generationSnapshotFromContent(sourcePreview.content);
    const snapshot = snapshotOverride ?? storedSnapshot;
    const sourceGeneratorId = typeof sourcePreview.content.sourceGeneratorId === "string"
      ? sourcePreview.content.sourceGeneratorId
      : "";
    const sourceGenerator = nodesSnapshot.current.find(
      (node) => node.id === sourceGeneratorId && node.data.record.kind === "video-generation",
    )?.data.record;
    if (!snapshot || !sourceGenerator) {
      setNotice("无法重新生成：该视频缺少历史参数快照或原视频生成节点");
      return;
    }

    let seed = seedOverride;
    if (!seed) {
      const excludedSeeds = new Set([
        ...generatedSeedsFromContent(sourceGenerator.content),
        typeof sourcePreview.content.seed === "string" ? sourcePreview.content.seed : "",
      ]);
      seed = randomFixedSeed();
      while (excludedSeeds.has(seed)) seed = randomFixedSeed();
    }
    await executeVideoNode(sourceGeneratorId, { sourcePreview, snapshot, seed });
  }, [executeVideoNode]);

  const configureGeneratedVideoRegeneration = useCallback((previewId: string) => {
    const previewNode = nodesSnapshot.current.find((node) => node.id === previewId);
    if (!previewNode || previewNode.data.record.kind !== "generated-video") {
      setNotice("无法设置重新生成参数：找不到视频预览节点");
      return;
    }
    const preview = previewNode.data.record;
    if (typeof preview.content.sourcePreviewId === "string") {
      setNotice("二采视频不支持重新生成");
      return;
    }
    const snapshot = generationSnapshotFromContent(preview.content);
    if (!snapshot) {
      setNotice("无法设置重新生成参数：该视频没有完整的历史参数快照");
      return;
    }
    const seed = typeof preview.content.seed === "string" ? preview.content.seed.trim() : "";
    if (!/^\d+$/.test(seed)) {
      setNotice("无法设置重新生成参数：该视频没有有效的历史 Seed");
      return;
    }
    setVideoRegenerationDraft({
      previewId,
      previewTitle: preview.title || "视频预览",
      originalSnapshot: snapshot,
      seed,
      primaryResolutionMegapixels: snapshot.primaryResolutionMegapixels,
      loraStrength: snapshot.loraStrength,
      primaryVideoSteps: snapshot.primaryVideoSteps,
      primaryAudioSteps: snapshot.primaryAudioSteps,
      primaryBrightness: snapshot.primaryBrightness,
      primaryContrast: snapshot.primaryContrast,
      primarySaturation: snapshot.primarySaturation,
      refImageSize: snapshot.refImageSize,
    });
  }, []);

  const adjustVideoRegenerationNumber = useCallback((
    field: VideoRegenerationNumericField,
    deltaY: number,
    min: number,
    max: number,
    step: number,
  ) => {
    if (!deltaY) return;
    setVideoRegenerationDraft((current) => {
      if (!current) return current;
      const direction = deltaY < 0 ? 1 : -1;
      const next = Math.min(max, Math.max(min, current[field] + direction * step));
      const precision = step.toString().split(".")[1]?.length ?? 0;
      return { ...current, [field]: Number(next.toFixed(precision)) };
    });
  }, []);

  useEffect(() => {
    if (!videoRegenerationDraft) return;
    const handleRegenerationDialogWheel = (event: WheelEvent) => {
      const dialog = videoRegenerationDialogRef.current;
      const target = event.target;
      if (!dialog || !(target instanceof HTMLElement) || !dialog.contains(target)) return;
      event.stopImmediatePropagation();
      const input = target.closest<HTMLInputElement>("input[data-regeneration-field]");
      if (!input) return;
      event.preventDefault();
      const field = input.dataset.regenerationField as VideoRegenerationNumericField | undefined;
      if (!field || !(field in VIDEO_REGENERATION_NUMBER_CONFIG)) return;
      const { min, max, step } = VIDEO_REGENERATION_NUMBER_CONFIG[field];
      adjustVideoRegenerationNumber(field, event.deltaY, min, max, step);
    };
    window.addEventListener("wheel", handleRegenerationDialogWheel, {
      capture: true,
      passive: false,
    });
    return () => window.removeEventListener("wheel", handleRegenerationDialogWheel, true);
  }, [adjustVideoRegenerationNumber, videoRegenerationDraft]);

  const submitConfiguredVideoRegeneration = useCallback(async () => {
    const draft = videoRegenerationDraft;
    if (!draft) return;
    if (!/^\d+$/.test(draft.seed) || BigInt(draft.seed) > 18446744073709551615n) {
      setNotice("Seed 必须是 0 到 18446744073709551615 之间的整数");
      return;
    }
    if (
      !Number.isFinite(draft.primaryResolutionMegapixels)
      || draft.primaryResolutionMegapixels < 0.2
      || draft.primaryResolutionMegapixels > 2
    ) {
      setNotice("一采分辨率必须在 0.2 到 2.0 MP 之间");
      return;
    }
    if (!Number.isFinite(draft.loraStrength) || draft.loraStrength < 0 || draft.loraStrength > 2) {
      setNotice("一采 LoRA 强度必须在 0.00 到 2.00 之间");
      return;
    }
    if (!Number.isInteger(draft.primaryVideoSteps) || draft.primaryVideoSteps < 1 || draft.primaryVideoSteps > 1000) {
      setNotice("一采 Video Steps 必须是 1 到 1000 的整数");
      return;
    }
    if (
      !Number.isInteger(draft.primaryAudioSteps)
      || draft.primaryAudioSteps < draft.primaryVideoSteps
      || draft.primaryAudioSteps > 1000
    ) {
      setNotice("一采 Audio Steps 必须是整数，且不能小于 Video Steps");
      return;
    }
    const invalidColorValue = [
      draft.primaryBrightness,
      draft.primaryContrast,
      draft.primarySaturation,
    ].some((value) => !Number.isFinite(value) || value < 0 || value > 3);
    if (invalidColorValue) {
      setNotice("亮度、对比度和饱和度必须在 0.00 到 3.00 之间");
      return;
    }
    const snapshot: GenerationSnapshot = {
      ...draft.originalSnapshot,
      primaryResolutionMegapixels: Math.round(draft.primaryResolutionMegapixels * 10) / 10,
      loraStrength: Math.round(draft.loraStrength * 100) / 100,
      loraStrengthRecorded: true,
      primaryVideoSteps: draft.primaryVideoSteps,
      primaryAudioSteps: draft.primaryAudioSteps,
      primaryBrightness: Math.round(draft.primaryBrightness * 100) / 100,
      primaryContrast: Math.round(draft.primaryContrast * 100) / 100,
      primarySaturation: Math.round(draft.primarySaturation * 100) / 100,
      refImageSize: draft.refImageSize,
      refImageSizeRecorded: true,
    };
    setVideoRegenerationDraft(null);
    await regenerateGeneratedVideo(draft.previewId, snapshot, draft.seed);
  }, [regenerateGeneratedVideo, videoRegenerationDraft]);

  const configureSecondarySample = useCallback((previewId: string) => {
    const previewNode = nodesSnapshot.current.find((node) => node.id === previewId);
    if (!previewNode || previewNode.data.record.kind !== "generated-video") {
      setNotice("无法设置二采参数：找不到视频预览节点");
      return;
    }
    const preview = previewNode.data.record;
    if (preview.content.generationPlaceholder === true) {
      setNotice("当前视频仍在生成中");
      return;
    }
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
    if (!baseSnapshot?.prompt.trim()) {
      setNotice("无法设置二采参数：该视频没有完整的历史参数快照");
      return;
    }
    const workflowModule = workflowModules.find((module) => (
      !module.deletedAt && module.id === baseSnapshot.workflowModuleId
    ));
    if (!workflowModule) {
      setNotice("无法设置二采参数：该视频使用的工作流方案已缺失");
      return;
    }
    const seed = typeof preview.content.seed === "string" ? preview.content.seed.trim() : "";
    if (!/^\d+$/.test(seed)) {
      setNotice("无法设置二采参数：该视频没有有效的历史 Seed");
      return;
    }
    setSecondarySampleDraft({
      previewId,
      previewTitle: preview.title || "视频预览",
      seed,
      secondaryResolutionMegapixels: sourceGenerator?.kind === "video-generation"
        ? secondaryVideoResolutionFromContent(sourceGenerator.content)
        : baseSnapshot.secondaryResolutionMegapixels,
      secondarySchedulerSteps: sourceGenerator?.kind === "video-generation"
        ? secondarySchedulerStepsFromContent(
          sourceGenerator.content,
          workflowModule.defaults.secondarySchedulerSteps,
        )
        : baseSnapshot.secondarySchedulerSteps,
      secondaryLoraStrength: sourceGenerator?.kind === "video-generation"
        ? h3SecondaryLoraStrengthFromContent(sourceGenerator.content)
        : baseSnapshot.secondaryLoraStrength,
      secondaryLoraBypassed: true,
      secondaryBrightness: workflowModule.defaults.secondaryBrightness,
      secondaryContrast: workflowModule.defaults.secondaryContrast,
      secondarySaturation: workflowModule.defaults.secondarySaturation,
      refImageSize: baseSnapshot.refImageSize,
    });
  }, [generationSnapshotForGenerator, workflowModules]);

  const adjustSecondarySampleNumber = useCallback((
    field: SecondarySampleNumericField,
    deltaY: number,
    min: number,
    max: number,
    step: number,
  ) => {
    if (!deltaY) return;
    setSecondarySampleDraft((current) => {
      if (!current) return current;
      const direction = deltaY < 0 ? 1 : -1;
      const next = Math.min(max, Math.max(min, current[field] + direction * step));
      const precision = step.toString().split(".")[1]?.length ?? 0;
      return { ...current, [field]: Number(next.toFixed(precision)) };
    });
  }, []);

  useEffect(() => {
    if (!secondarySampleDraft) return;
    const handleSecondarySampleDialogWheel = (event: WheelEvent) => {
      const dialog = secondarySampleDialogRef.current;
      const target = event.target;
      if (!dialog || !(target instanceof HTMLElement) || !dialog.contains(target)) return;
      event.stopImmediatePropagation();
      const input = target.closest<HTMLInputElement>("input[data-secondary-sample-field]");
      if (!input) return;
      event.preventDefault();
      const field = input.dataset.secondarySampleField as SecondarySampleNumericField | undefined;
      if (!field || !(field in SECONDARY_SAMPLE_NUMBER_CONFIG)) return;
      const { min, max, step } = SECONDARY_SAMPLE_NUMBER_CONFIG[field];
      adjustSecondarySampleNumber(field, event.deltaY, min, max, step);
    };
    window.addEventListener("wheel", handleSecondarySampleDialogWheel, {
      capture: true,
      passive: false,
    });
    return () => window.removeEventListener("wheel", handleSecondarySampleDialogWheel, true);
  }, [adjustSecondarySampleNumber, secondarySampleDraft]);

  const executeSecondarySample = useCallback(async (
    previewId: string,
    overrides?: SecondarySampleOverrides,
    seedOverride?: string,
  ) => {
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
    const requestedSeed = seedOverride ?? previewSeed;
    if (!secondarySource) {
      setNotice("无法二采：当前预览缺少远程视频文件信息");
      return;
    }
    if (!baseSnapshot?.prompt.trim()) {
      setNotice("无法二采：找不到该视频生成时使用的提示词与参考素材参数");
      return;
    }
    if (!requestedSeed) {
      setNotice("无法二采：当前预览缺少生成 seed");
      return;
    }
    const workflowModule = workflowModules.find((module) => (
      !module.deletedAt && module.id === baseSnapshot.workflowModuleId
    ));
    if (!workflowModule) {
      const message = baseSnapshot.workflowModuleId
        ? "该视频生成时使用的工作流方案已缺失，请先恢复方案"
        : "该视频没有记录工作流方案，无法安全二采";
      changeNode(previewId, {
        content: { ...preview.content, status: "invalid", validationMessage: message },
      });
      setNotice(`无法二采：${message}`);
      return;
    }
    const snapshot: GenerationSnapshot = {
      ...baseSnapshot,
      diffusionModelName: workflowModule.defaults.diffusionModelName,
      secondaryResolutionMegapixels: sourceGenerator?.kind === "video-generation"
        ? secondaryVideoResolutionFromContent(sourceGenerator.content)
        : baseSnapshot.secondaryResolutionMegapixels,
      secondarySchedulerSteps: sourceGenerator?.kind === "video-generation"
        ? secondarySchedulerStepsFromContent(
          sourceGenerator.content,
          workflowModule.defaults.secondarySchedulerSteps,
        )
        : baseSnapshot.secondarySchedulerSteps,
      secondaryBrightness: workflowModule.defaults.secondaryBrightness,
      secondaryContrast: workflowModule.defaults.secondaryContrast,
      secondarySaturation: workflowModule.defaults.secondarySaturation,
      secondaryLoraName: sourceGenerator?.kind === "video-generation"
        ? h3SecondaryLoraNameFromContent(sourceGenerator.content)
        : baseSnapshot.secondaryLoraName,
      secondaryLoraStrength: sourceGenerator?.kind === "video-generation"
        ? h3SecondaryLoraStrengthFromContent(sourceGenerator.content)
        : baseSnapshot.secondaryLoraStrength,
      secondaryLoraStrengthRecorded: true,
      secondaryLoraBypassed: sourceGenerator?.kind === "video-generation"
        ? h3SecondaryLoraBypassedFromContent(sourceGenerator.content)
        : baseSnapshot.secondaryLoraBypassed,
      ...overrides,
      ...(overrides ? { refImageSizeRecorded: true } : {}),
    };
    if (!snapshot.secondaryLoraBypassed && !snapshot.secondaryLoraName) {
      const message = "请先选择二采 LoRA";
      changeNode(previewId, {
        content: { ...preview.content, status: "invalid", validationMessage: message },
      });
      setNotice(`无法二采：${message}`);
      return;
    }
    if (
      h3LoraCatalogLoaded
      && !snapshot.secondaryLoraBypassed
      && !h3LoraOptions.some((lora) => sameH3LoraName(lora, snapshot.secondaryLoraName))
    ) {
      const message = h3LoraOptions.length
        ? "二采使用的 LoRA 已不在 MinimaxH3 目录中，请重新选择"
        : "MinimaxH3 目录中没有可用 LoRA，请添加 LoRA 或开启 Bypass";
      changeNode(previewId, {
        content: { ...preview.content, status: "invalid", validationMessage: message },
      });
      setNotice(`无法二采：${message}`);
      return;
    }
    if (
      h3DiffusionModelCatalogLoaded
      && !h3DiffusionModelOptions.some((model) => (
        sameH3DiffusionModelName(model, snapshot.diffusionModelName)
      ))
    ) {
      const message = h3DiffusionModelOptions.length
        ? "二采使用的基础模型已不在 diffusion_models/MinimaxH3 目录中，请重新选择"
        : "diffusion_models/MinimaxH3 目录中没有可用基础模型";
      changeNode(previewId, {
        content: { ...preview.content, status: "invalid", validationMessage: message },
      });
      setNotice(`无法二采：${message}`);
      return;
    }
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
    let preserveComfyTaskRecord = false;
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
          workflowModuleId: snapshot.workflowModuleId,
          workflowPath: h3WorkflowPathRef.current,
          inputRootPath: comfyInputRootRef.current,
          clientId,
          prompt: snapshot.prompt,
          seedMode: "fixed",
          seed: requestedSeed,
          durationSeconds: snapshot.durationSeconds,
          aspectRatio: snapshot.aspectRatio,
          primaryResolutionMegapixels: snapshot.primaryResolutionMegapixels,
          secondaryResolutionMegapixels: snapshot.secondaryResolutionMegapixels,
          primaryVideoSteps: snapshot.primaryVideoSteps,
          primaryAudioSteps: snapshot.primaryAudioSteps,
          secondarySchedulerSteps: snapshot.secondarySchedulerSteps,
          primaryBrightness: snapshot.primaryBrightness,
          primaryContrast: snapshot.primaryContrast,
          primarySaturation: snapshot.primarySaturation,
          secondaryBrightness: snapshot.secondaryBrightness,
          secondaryContrast: snapshot.secondaryContrast,
          secondarySaturation: snapshot.secondarySaturation,
          secondarySamplingEnabled: true,
          diffusionModelName: snapshot.diffusionModelName,
          loraName: snapshot.loraName,
          loraStrength: snapshot.loraStrength,
          loraBypassed: snapshot.loraBypassed,
          secondaryLoraName: snapshot.secondaryLoraName,
          secondaryLoraStrength: snapshot.secondaryLoraStrength,
          secondaryLoraBypassed: snapshot.secondaryLoraBypassed,
          refImageSize: snapshot.refImageSize,
          imagePaths: snapshot.imagePaths,
          imageRoles: snapshot.imageRoles,
          audioPaths: snapshot.audioPaths,
          videoPaths: snapshot.videoPaths,
          secondarySource,
        },
      });
      if (!result.outputs.length) throw new Error("ComfyUI 二采没有返回视频输出");
      if (cancelledComfyClients.current.has(clientId)) return;
      const generationElapsedSeconds = validExecutionElapsedSeconds(result.executionElapsedSeconds);

      const previewWidth = generatedVideoPreviewWidthForRatio(videoAspectRatioValue(snapshot.aspectRatio));
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
        try {
          await finalizeGenerationPlaceholder(placeholder, {
            status: "cancelled",
            executionProgress: null,
            validationMessage: "已取消 ComfyUI 二采",
          });
        } catch (error) {
          preserveComfyTaskRecord = true;
          reportError(error);
        }
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
      try {
        await finalizeGenerationPlaceholder(placeholder, {
          status: "invalid",
          executionProgress: null,
          validationMessage: `二采失败：${message}`,
        });
      } catch (placeholderError) {
        preserveComfyTaskRecord = true;
        reportError(placeholderError);
      }
      reportError(error);
    } finally {
      progressSocket?.close();
      cancelledComfyClients.current.delete(clientId);
      ownedComfyClients.current.delete(clientId);
      if (!preserveComfyTaskRecord) forgetComfyTask(clientId);
      unregisterComfyTask(previewId, clientId);
    }
  }, [changeNode, completeGenerationPlaceholder, createGenerationPlaceholder, finalizeGenerationPlaceholder, forgetComfyTask, generatedPreviewHeightForAspectRatio, generationSnapshotForGenerator, h3DiffusionModelCatalogLoaded, h3DiffusionModelOptions, h3LoraCatalogLoaded, h3LoraOptions, registerComfyTask, rememberComfyTask, reportError, setEdges, setNodes, unregisterComfyTask, updateGenerationPlaceholder, workflowModules]);

  const submitConfiguredSecondarySample = useCallback(async () => {
    const draft = secondarySampleDraft;
    if (!draft) return;
    if (!/^\d+$/.test(draft.seed) || BigInt(draft.seed) > 18446744073709551615n) {
      setNotice("Seed 必须是 0 到 18446744073709551615 之间的整数");
      return;
    }
    if (
      !Number.isFinite(draft.secondaryResolutionMegapixels)
      || draft.secondaryResolutionMegapixels < 0.2
      || draft.secondaryResolutionMegapixels > 2
    ) {
      setNotice("二采分辨率必须在 0.2 到 2.0 MP 之间");
      return;
    }
    if (
      !Number.isFinite(draft.secondaryLoraStrength)
      || draft.secondaryLoraStrength < 0
      || draft.secondaryLoraStrength > 2
    ) {
      setNotice("二采 LoRA 强度必须在 0.00 到 2.00 之间");
      return;
    }
    if (
      !Number.isInteger(draft.secondarySchedulerSteps)
      || draft.secondarySchedulerSteps < 1
      || draft.secondarySchedulerSteps > 10000
    ) {
      setNotice("二采 Scheduler Steps 必须是 1 到 10000 的整数");
      return;
    }
    const invalidColorValue = [
      draft.secondaryBrightness,
      draft.secondaryContrast,
      draft.secondarySaturation,
    ].some((value) => !Number.isFinite(value) || value < 0 || value > 3);
    if (invalidColorValue) {
      setNotice("二采亮度、对比度和饱和度必须在 0.00 到 3.00 之间");
      return;
    }
    const overrides: SecondarySampleOverrides = {
      secondaryResolutionMegapixels: Math.round(draft.secondaryResolutionMegapixels * 10) / 10,
      secondaryLoraStrength: Math.round(draft.secondaryLoraStrength * 100) / 100,
      secondarySchedulerSteps: draft.secondarySchedulerSteps,
      secondaryBrightness: Math.round(draft.secondaryBrightness * 100) / 100,
      secondaryContrast: Math.round(draft.secondaryContrast * 100) / 100,
      secondarySaturation: Math.round(draft.secondarySaturation * 100) / 100,
      secondaryLoraBypassed: draft.secondaryLoraBypassed,
      refImageSize: draft.refImageSize,
    };
    setSecondarySampleDraft(null);
    await executeSecondarySample(draft.previewId, overrides, draft.seed);
  }, [executeSecondarySample, secondarySampleDraft]);

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
        const textInputOrder = Array.isArray(target.content.textInputOrder)
          ? target.content.textInputOrder.filter((inputId) => inputId !== inputEdge.source)
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
            textInputOrder,
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

  const activateTextInput = useCallback((targetId: string, sourceId: string) => {
    const target = nodesSnapshot.current.find((node) => node.id === targetId)?.data.record;
    const source = nodesSnapshot.current.find((node) => node.id === sourceId)?.data.record;
    const isConnected = edgesSnapshot.current.some(
      (edge) => edge.source === sourceId && edge.target === targetId,
    );
    if (target?.kind !== "video-generation" || source?.kind !== "text" || !isConnected) return;
    setRelationAnchorId(sourceId);
    if (target.content.activeTextInputId === sourceId) return;
    changeNode(targetId, {
      content: {
        ...target.content,
        activeTextInputId: sourceId,
        status: "idle",
        validationMessage: "",
      },
    });
    setNotice(`已切换当前文本：${source.title || "未命名文本"}`);
  }, [changeNode]);

  const locateGeneratedVideoPrompt = useCallback((
    previewId: string,
    target: "prompt" | "generator" = "prompt",
  ) => {
    const previewNode = nodesSnapshot.current.find(
      (node) => node.id === previewId && node.data.record.kind === "generated-video",
    );
    const preview = previewNode?.data.record;
    if (!preview) {
      setNotice("无法定位：找不到当前视频预览节点");
      return;
    }
    if (target === "generator") {
      const sourceGeneratorId = typeof preview.content.sourceGeneratorId === "string"
        ? preview.content.sourceGeneratorId
        : "";
      const generatorNode = sourceGeneratorId
        ? nodesSnapshot.current.find((node) => (
          node.id === sourceGeneratorId && node.data.record.kind === "video-generation"
        ))
        : undefined;
      if (!generatorNode) {
        setNotice(sourceGeneratorId
          ? "无法定位：关联的视频生成节点已被删除"
          : "无法定位：该视频没有记录关联的视频生成节点");
        return;
      }
      const width = generatorNode.width ?? generatorNode.data.record.width ?? 360;
      const height = generatorNode.height ?? generatorNode.data.record.height ?? VIDEO_NODE_BASE_HEIGHT;
      setRelationAnchorId(null);
      setNodes((current) => current.map((node) => ({
        ...node,
        selected: node.id === generatorNode.id,
      })));
      void setCenter(
        generatorNode.position.x + width / 2,
        generatorNode.position.y + height / 2,
        { zoom: 1, duration: 350 },
      );
      setNotice(`已定位视频生成节点：${generatorNode.data.record.title || "视频生成"}`);
      return;
    }
    const snapshot = preview ? generationSnapshotFromContent(preview.content) : null;
    if (!snapshot) {
      setNotice("无法定位：该视频没有保存生成提示词信息");
      return;
    }

    let promptNode = snapshot.promptNodeId
      ? nodesSnapshot.current.find((node) => (
        node.id === snapshot.promptNodeId && node.data.record.kind === "text"
      ))
      : undefined;
    if (!promptNode && !snapshot.promptNodeId) {
      const exactMatches = nodesSnapshot.current.filter((node) => (
        node.data.record.kind === "text"
        && textFromContent(node.data.record.content) === snapshot.prompt
      ));
      if (exactMatches.length === 1) promptNode = exactMatches[0];
    }
    if (!promptNode) {
      setNotice(snapshot.promptNodeId
        ? "无法定位：该视频使用的提示词文本框已被删除"
        : "无法定位：没有找到唯一匹配的提示词文本框");
      return;
    }

    const width = promptNode.width ?? promptNode.data.record.width ?? 320;
    const height = promptNode.height ?? promptNode.data.record.height ?? 240;
    setRelationAnchorId(promptNode.id);
    setNodes((current) => current.map((node) => ({
      ...node,
      selected: node.id === promptNode.id,
    })));
    void setCenter(
      promptNode.position.x + width / 2,
      promptNode.position.y + height / 2,
      { zoom: 1, duration: 350 },
    );
    setNotice(`已定位提示词：${promptNode.data.record.title || "未命名文本"}`);
  }, [setCenter, setNodes]);

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
        outputCount: 0,
        mediaInputs: [],
        textInputCount: 0,
        textInputs: [],
        promptNodeTitle: "",
        h3LoraOptions,
        workflowModules,
        workflowModuleDefaults,
        onH3LoraPreferenceChange: rememberH3LoraPreference,
        onChange: changeNode,
        onExecutionCheck: reportExecutionCheck,
        onExecute: executeVideoNode,
        onSecondarySample: executeSecondarySample,
        onConfigureSecondarySample: configureSecondarySample,
        onRegenerateVideo: regenerateGeneratedVideo,
        onConfigureRegenerateVideo: configureGeneratedVideoRegeneration,
        onLocatePrompt: locateGeneratedVideoPrompt,
        onCancelExecution: cancelVideoExecution,
        onRevealGeneratedVideo: revealGeneratedVideo,
        onRemoveInput: removeInputFromVideoNode,
        onActivateTextInput: activateTextInput,
        onDelete: deleteNode,
        onCopy: copyText,
      },
    }),
    [activeComfyTaskCounts, activateTextInput, cancelVideoExecution, changeNode, configureGeneratedVideoRegeneration, configureSecondarySample, copyText, deleteNode, executeSecondarySample, executeVideoNode, h3LoraOptions, locateGeneratedVideoPrompt, regenerateGeneratedVideo, rememberH3LoraPreference, removeInputFromVideoNode, reportExecutionCheck, revealGeneratedVideo, workflowModuleDefaults, workflowModules],
  );
  makeFlowNodeRef.current = makeFlowNode;

  const restoreCompletedComfyTask = useCallback(async (
    task: PersistedComfyTask,
    recovered: ComfyClientTaskStatus,
  ) => {
    const sourceNode = nodesSnapshot.current.find((node) => node.id === task.nodeId);
    if (!sourceNode || recovered.status !== "success" || !recovered.promptId) return null;
    const alreadyRestored = nodesSnapshot.current.find((node) => (
      node.data.record.kind === "generated-video"
      && node.data.record.content.comfyPromptId === recovered.promptId
    ));
    if (alreadyRestored) {
      if (task.placeholderNodeId && task.placeholderNodeId !== alreadyRestored.id) {
        await flushNodePatches([task.placeholderNodeId]);
        try {
          await invoke("delete_node", { id: task.placeholderNodeId });
        } catch (error) {
          if (!String(error).includes("node not found")) throw error;
        }
        completedGenerationPlaceholders.current.add(task.placeholderNodeId);
        setNodes((current) => current.filter((node) => node.id !== task.placeholderNodeId));
        setEdges((current) => current.filter((edge) => (
          edge.source !== task.placeholderNodeId && edge.target !== task.placeholderNodeId
        )));
      }
      return sourceNode.data.record.content;
    }

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
    const previewWidth = generatedVideoPreviewWidthForRatio(videoAspectRatioValue(task.snapshot.aspectRatio));
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
  }, [changeNode, completeGenerationPlaceholder, flushNodePatches, generatedPreviewHeightForAspectRatio, setEdges, setNodes]);

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
    const sourceLeft = Math.min(...clipboard.nodes.map((node) => node.x));
    const sourceTop = Math.min(...clipboard.nodes.map((node) => node.y));
    const sourceRight = Math.max(...clipboard.nodes.map((node) => node.x + node.width));
    const sourceBottom = Math.max(...clipboard.nodes.map((node) => node.y + node.height));
    const placement = reserveNodePlacement(
      activeProjectId,
      { x: sourceLeft + pasteOffset, y: sourceTop + pasteOffset },
      sourceRight - sourceLeft,
      sourceBottom - sourceTop,
    );
    const placementDelta = {
      x: placement.position.x - sourceLeft,
      y: placement.position.y - sourceTop,
    };
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
            x: snapCanvasCoordinate(sourceNode.x + placementDelta.x),
            y: snapCanvasCoordinate(sourceNode.y + placementDelta.y),
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

      finishNodePlacementReservation(
        placement.reservationId,
        [...createdByOriginalId.values()],
      );
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
      finishNodePlacementReservation(placement.reservationId);
      reportError(error);
    }
  }, [activeProjectId, finishNodePlacementReservation, makeFlowNode, reportError, reserveNodePlacement, setEdges, setNodes]);

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
    const placement = reserveNodePlacement(
      activeProjectId,
      position,
      VIDEO_GENERATION_NODE_WIDTH,
      240,
    );
    try {
      const result = await invoke<CreateNodeResult>("create_node", {
        input: {
          canvasId: activeProjectId,
          kind: "text",
          title: "新文本",
          content: { text: "" },
          source: "manual",
          x: placement.position.x,
          y: placement.position.y,
          width: VIDEO_GENERATION_NODE_WIDTH,
          height: 240,
        },
      });
      finishNodePlacementReservation(placement.reservationId, [result.node]);
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
      finishNodePlacementReservation(placement.reservationId);
      reportError(error);
    }
  }, [activeProjectId, finishNodePlacementReservation, makeFlowNode, reportError, reserveNodePlacement, setCenter, setNodes]);

  const addPromptVersionNode = useCallback(async (position?: { x: number; y: number }) => {
    if (!activeProjectId) return;
    const placement = reserveNodePlacement(
      activeProjectId,
      position,
      VIDEO_GENERATION_NODE_WIDTH,
      320,
    );
    const initialVersion: PromptVersionRecord = {
      id: crypto.randomUUID(),
      label: "v1",
      text: "",
      createdAt: new Date().toISOString(),
    };
    try {
      const result = await invoke<CreateNodeResult>("create_node", {
        input: {
          canvasId: activeProjectId,
          kind: "text",
          title: "提示词版本",
          content: {
            text: "",
            promptVersionNode: true,
            promptVersions: [initialVersion],
            activePromptVersionId: initialVersion.id,
            bestPromptVersionId: "",
          },
          source: "manual",
          x: placement.position.x,
          y: placement.position.y,
          width: VIDEO_GENERATION_NODE_WIDTH,
          height: 320,
        },
      });
      finishNodePlacementReservation(placement.reservationId, [result.node]);
      setNodes((current) => [...current, makeFlowNode(result.node)]);
      setNotice("提示词版本节点已创建");
      if (!position) window.setTimeout(() => {
        void setCenter(
          result.node.x + result.node.width / 2,
          result.node.y + result.node.height / 2,
          { zoom: 1, duration: 350 },
        );
      }, 60);
    } catch (error) {
      finishNodePlacementReservation(placement.reservationId);
      reportError(error);
    }
  }, [activeProjectId, finishNodePlacementReservation, makeFlowNode, reportError, reserveNodePlacement, setCenter, setNodes]);

  const addNoteNode = useCallback(async (position?: { x: number; y: number }) => {
    if (!activeProjectId) return;
    const placement = reserveNodePlacement(activeProjectId, position, 300, 200);
    try {
      const result = await invoke<CreateNodeResult>("create_node", {
        input: {
          canvasId: activeProjectId,
          kind: "note",
          title: "备注",
          content: { text: "" },
          source: "manual",
          x: placement.position.x,
          y: placement.position.y,
          width: 300,
          height: 200,
        },
      });
      finishNodePlacementReservation(placement.reservationId, [result.node]);
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
      finishNodePlacementReservation(placement.reservationId);
      reportError(error);
    }
  }, [activeProjectId, finishNodePlacementReservation, makeFlowNode, reportError, reserveNodePlacement, setCenter, setNodes]);

  const addVideoNode = useCallback(async (position?: { x: number; y: number }) => {
    if (!activeProjectId) return;
    const placement = reserveNodePlacement(
      activeProjectId,
      position,
      VIDEO_GENERATION_NODE_WIDTH,
      VIDEO_NODE_BASE_HEIGHT,
    );
    const defaultWorkflowModule = workflowModules.find((module) => (
      !module.deletedAt
      && module.capability === "video-generation"
      && module.variant === "reference-to-video"
      && module.id === workflowModuleDefaults["video-generation:reference-to-video"]
    ));
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
            workflowModuleId: defaultWorkflowModule?.id ?? "",
            workflowModuleRevision: defaultWorkflowModule?.revision ?? "",
            generationDiffusionModelName: defaultWorkflowModule?.defaults.diffusionModelName ?? h3DiffusionModelName,
            generationLoraName: "",
            generationLoraStrength: 1,
            generationLoraBypassed: false,
            generationSecondaryLoraName: "",
            generationSecondaryLoraStrength: 1,
            generationSecondaryLoraBypassed: false,
            generationRefImageSize: "max",
            generationPrimaryVideoSteps: 8,
            generationSecondarySchedulerSteps: 8,
            seedMode: "random",
            generationSeed: DEFAULT_GENERATION_SEED,
            manualHeight: VIDEO_NODE_BASE_HEIGHT,
            layoutTextInputCount: 0,
          },
          source: "manual",
          x: placement.position.x,
          y: placement.position.y,
          width: VIDEO_GENERATION_NODE_WIDTH,
          height: VIDEO_NODE_BASE_HEIGHT,
        },
      });
      finishNodePlacementReservation(placement.reservationId, [result.node]);
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
      finishNodePlacementReservation(placement.reservationId);
      reportError(error);
    }
  }, [activeProjectId, finishNodePlacementReservation, h3DiffusionModelName, makeFlowNode, reportError, reserveNodePlacement, setCenter, setNodes, workflowModuleDefaults, workflowModules]);

  const openCanvasContextMenu = useCallback((event: MouseEvent | ReactMouseEvent) => {
    event.preventDefault();
    const flowPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const menuWidth = uiFontSize === "medium" ? 220 : 190;
    const menuHeight = uiFontSize === "medium" ? 264 : 228;
    setCanvasContextMenu({
      screenX: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      screenY: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
      flowX: snapCanvasCoordinate(flowPosition.x),
      flowY: snapCanvasCoordinate(flowPosition.y),
    });
  }, [screenToFlowPosition, uiFontSize]);

  const createNodeFromContextMenu = useCallback((kind: "text" | "prompt-version" | "note" | "video-generation") => {
    if (!canvasContextMenu) return;
    const position = { x: canvasContextMenu.flowX, y: canvasContextMenu.flowY };
    setCanvasContextMenu(null);
    if (kind === "text") void addTextNode(position);
    else if (kind === "prompt-version") void addPromptVersionNode(position);
    else if (kind === "note") void addNoteNode(position);
    else void addVideoNode(position);
  }, [addNoteNode, addPromptVersionNode, addTextNode, addVideoNode, canvasContextMenu]);

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
          let importedNode = result.node;
          if (importedNode.kind === "image") {
            const importedAssetPath = typeof importedNode.content.assetPath === "string"
              ? importedNode.content.assetPath
              : "";
            if (importedAssetPath) {
              try {
                const naturalSize = await loadImageNaturalSize(importedAssetPath);
                const aspectRatio = naturalSize.width / naturalSize.height;
                const fittedWidth = aspectRatio < 1
                  ? GENERATED_VIDEO_PORTRAIT_PREVIEW_WIDTH
                  : importedNode.width;
                const fittedHeight = Math.min(
                  2400,
                  fittedWidth / aspectRatio + IMAGE_NODE_CHROME_HEIGHT,
                );
                importedNode = await invoke<NodeRecord>("update_node", {
                  input: {
                    id: importedNode.id,
                    width: fittedWidth,
                    height: fittedHeight,
                    content: {
                      ...importedNode.content,
                      aspectRatio,
                      naturalWidth: naturalSize.width,
                      naturalHeight: naturalSize.height,
                      imageLayoutVersion: 1,
                    },
                  },
                });
              } catch {
                // Fall back to the existing on-load ratio correction if metadata cannot be read here.
              }
            }
          }
          const placement = reserveNodePlacement(
            activeProjectId,
            {
              x: basePosition.x + index * CANVAS_GRID_SIZE,
              y: basePosition.y + index * CANVAS_GRID_SIZE,
            },
            importedNode.width,
            importedNode.height,
          );
          try {
            importedNode = await invoke<NodeRecord>("update_node", {
              input: {
                id: importedNode.id,
                x: placement.position.x,
                y: placement.position.y,
              },
            });
            finishNodePlacementReservation(placement.reservationId, [importedNode]);
          } catch (error) {
            finishNodePlacementReservation(placement.reservationId);
            throw error;
          }
          setNodes((current) => [...current, makeFlowNode(importedNode)]);
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
    [activeProjectId, finishNodePlacementReservation, makeFlowNode, reserveNodePlacement, screenToFlowPosition, setNodes],
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
      const source = contentNodes.find((node) => node.id === connection.source)?.data.record;
      const target = contentNodes.find((node) => node.id === connection.target)?.data.record;
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
            .map((edge) => contentNodes.find((node) => node.id === edge.source)?.data.record)
            .filter((record) => record?.kind === "image")
            .length;
          if (imageCount >= 2) return "首尾帧模式最多只能连接两张图片";
        }
      }
      if (mode === "image-to-video") {
        if (source.kind === "audio" || source.kind === "video") {
          return "图生视频模式不能连接音频或视频参考";
        }
        if (source.kind === "image") {
          const imageCount = edges
            .filter((edge) => edge.target === target.id)
            .map((edge) => contentNodes.find((node) => node.id === edge.source)?.data.record)
            .filter((record) => record?.kind === "image")
            .length;
          if (imageCount >= 1) return "图生视频模式只能连接一张首帧图片";
        }
      }
      if (mode === "last-frame-to-video") {
        if (source.kind === "audio" || source.kind === "video") {
          return "尾帧生视频模式不能连接音频或视频参考";
        }
        if (source.kind === "image") {
          const imageCount = edges
            .filter((edge) => edge.target === target.id)
            .map((edge) => contentNodes.find((node) => node.id === edge.source)?.data.record)
            .filter((record) => record?.kind === "image")
            .length;
          if (imageCount >= 1) return "尾帧生视频模式只能连接一张尾帧图片";
        }
      }

      return null;
    },
    [contentNodes, edges],
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
      const sourceNode = nodesSnapshot.current.find((node) => node.id === connection.source);
      const targetNode = nodesSnapshot.current.find((node) => node.id === connection.target);
      if (!sourceNode || !targetNode || !connection.target) {
        setNotice("找不到要连接的节点");
        return;
      }
      const selectedTextNodes = sourceNode.selected && sourceNode.data.record.kind === "text"
        ? nodesSnapshot.current
            .filter((node) => node.selected && node.data.record.kind === "text")
            .sort((left, right) => {
              const leftTitle = left.data.record.title.trim() || "未命名文本";
              const rightTitle = right.data.record.title.trim() || "未命名文本";
              return leftTitle.localeCompare(rightTitle, "zh-CN", {
                numeric: true,
                sensitivity: "base",
              }) || left.id.localeCompare(right.id);
            })
        : [sourceNode];
      const batchSources = selectedTextNodes.length > 1 ? selectedTextNodes : [sourceNode];
      const alreadyConnectedSourceIds = new Set(
        edgesSnapshot.current
          .filter((edge) => edge.target === connection.target)
          .map((edge) => edge.source),
      );
      const sourcesToConnect = batchSources.filter(
        (node) => !alreadyConnectedSourceIds.has(node.id),
      );
      if (!sourcesToConnect.length) {
        setNotice("选中的文字节点已经全部连接");
        return;
      }
      try {
        const createdEdges: Edge[] = [];
        const createdSourceIds: string[] = [];
        const failures: string[] = [];
        for (const source of sourcesToConnect) {
          try {
            const record = await invoke<EdgeRecord>("create_edge", {
              input: {
                canvasId: activeProjectId,
                sourceNodeId: source.id,
                targetNodeId: connection.target,
                kind: "input",
                metadata: { sourceKind: source.data.record.kind },
              },
            });
            createdEdges.push(toFlowEdge(record));
            createdSourceIds.push(source.id);
          } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error));
          }
        }
        if (createdEdges.length) {
          setEdges((current) => {
            const currentIds = new Set(current.map((edge) => edge.id));
            return [
              ...current,
              ...createdEdges.filter((edge) => !currentIds.has(edge.id)),
            ];
          });
        }

        if (createdSourceIds.length && targetNode.data.record.kind === "video-generation") {
          const existingTextRecords = edgesSnapshot.current
            .filter((edge) => edge.target === targetNode.id)
            .map((edge) => nodesSnapshot.current.find((node) => node.id === edge.source)?.data.record)
            .filter((record): record is NodeRecord => record?.kind === "text");
          const existingTextOrder = orderedNodeRecordsFromContent(
            targetNode.data.record.content,
            "textInputOrder",
            existingTextRecords,
          ).map((record) => record.id);
          changeNode(targetNode.id, {
            content: {
              ...targetNode.data.record.content,
              textInputOrder: [...existingTextOrder, ...createdSourceIds],
            },
          });
        }

        if (!createdEdges.length) {
          setNotice(`文字节点连接失败：${failures[0] ?? "没有可连接的节点"}`);
        } else if (batchSources.length > 1) {
          setNotice(
            failures.length
              ? `已按标题升序连接 ${createdEdges.length} 个文本，${failures.length} 个失败`
              : `已按标题升序连接 ${createdEdges.length} 个文本`,
          );
        } else {
          setNotice("节点已连接");
        }
      } catch (error) {
        reportError(error);
      }
    },
    [activeProjectId, changeNode, connectionValidationError, reportError, setEdges],
  );

  const deleteSelectedElements = useCallback(async (deleteSourceFiles = false) => {
    const selectedNodes = nodesSnapshot.current.filter((node) => node.selected);
    if (selectedNodes.length) {
      if (deleteSourceFiles) {
        const generatedVideos = selectedNodes.filter((node) => (
          node.data.record.kind === "generated-video"
          && node.data.record.content.generationPlaceholder !== true
        ));
        if (generatedVideos.length) {
          await deleteCanvasNodes(generatedVideos, true);
          return;
        }
      }
      await deleteCanvasNodes(selectedNodes, false);
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
      void deleteSelectedElements(event.key === "Delete" && event.ctrlKey);
    };
    window.addEventListener("keydown", handleDeleteShortcut);
    return () => window.removeEventListener("keydown", handleDeleteShortcut);
  }, [deleteSelectedElements]);

  const matchedIds = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return new Set(contentNodes.map((node) => node.id));
    return new Set(
      contentNodes
        .filter((node) => {
          const record = node.data.record;
          return `${record.title}\n${textFromContent(record.content)}\n${record.source}`
            .toLocaleLowerCase()
            .includes(query);
        })
        .map((node) => node.id),
    );
  }, [contentNodes, search]);

  useEffect(() => {
    const promptNodeIdsByText = new Map<string, string[]>();
    contentNodes.forEach((node) => {
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
    contentNodes.forEach((node) => {
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
  }, [changeNode, contentNodes, flushNodePatches, reportError]);

  const relationHighlightedIds = useMemo(() => {
    if (!relationAnchorId) return new Set<string>();
    const recordsById = new Map(contentNodes.map((node) => [node.id, node.data.record]));
    const anchor = recordsById.get(relationAnchorId);
    if (!anchor || (anchor.kind !== "text" && anchor.kind !== "generated-video")) {
      return new Set<string>();
    }

    if (anchor.kind === "text") {
      const relatedIds = new Set<string>([anchor.id]);
      contentNodes.forEach((node) => {
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
  }, [contentNodes, relationAnchorId]);

  const handleNodeRelationClick = useCallback((node: CanvasFlowNode) => {
    const kind = node.data.record.kind;
    if (kind === "text") {
      const targetIds = new Set(
        edgesSnapshot.current
          .filter((edge) => edge.source === node.id)
          .map((edge) => edge.target),
      );
      targetIds.forEach((targetId) => activateTextInput(targetId, node.id));
    }
    setRelationAnchorId(kind === "text" || kind === "generated-video" ? node.id : null);
  }, [activateTextInput]);

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
      const recordsById = new Map(contentNodes.map((node) => [node.id, node.data.record]));
      const inputRecordsByTarget = new Map<string, NodeRecord[]>();
      const outputCountBySource = new Map<string, number>();
      edges.forEach((edge) => {
        outputCountBySource.set(edge.source, (outputCountBySource.get(edge.source) ?? 0) + 1);
        const source = recordsById.get(edge.source);
        if (!source) return;
        const inputRecords = inputRecordsByTarget.get(edge.target);
        if (inputRecords) inputRecords.push(source);
        else inputRecordsByTarget.set(edge.target, [source]);
      });
      const previousCache = visibleNodeCache.current;
      const nextCache = new Map<string, VisibleNodeCacheEntry>();
      const results = nodes.map((node) => {
        const previous = previousCache.get(node.id);
        const inputRecords = node.data.record.kind === "video-generation"
          ? inputRecordsByTarget.get(node.id) ?? EMPTY_NODE_RECORDS
          : EMPTY_NODE_RECORDS;
        const connectedMedia = inputRecords.filter(
          (record) => record.kind === "image" || record.kind === "audio" || record.kind === "video",
        );
        const connectedText = inputRecords.filter((record) => record.kind === "text");
        const orderedText = orderedNodeRecordsFromContent(
          node.data.record.content,
          "textInputOrder",
          connectedText,
        );
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

        const previousData = previous?.result.data;
        const mediaInputs = previousData && nodeRecordArraysEqual(previousData.mediaInputs, orderedMedia)
          ? previousData.mediaInputs
          : orderedMedia;
        const textInputs = previousData && nodeRecordArraysEqual(previousData.textInputs, orderedText)
          ? previousData.textInputs
          : orderedText;
        const matched = matchedIds.has(node.id);
        const relationHighlighted = relationHighlightedIds.has(node.id);
        const activeTaskCount = activeComfyTaskCounts[node.id] ?? 0;
        const outputCount = outputCountBySource.get(node.id) ?? 0;
        const generationSnapshot = node.data.record.kind === "generated-video"
          ? generationSnapshotFromContent(node.data.record.content)
          : null;
        const linkedPromptNode = generationSnapshot?.promptNodeId
          ? recordsById.get(generationSnapshot.promptNodeId)
          : null;
        const promptNodeTitle = linkedPromptNode?.kind === "text"
          ? linkedPromptNode.title
          : generationSnapshot?.promptNodeTitle ?? "";
        const presentationUnchanged = Boolean(
          previous
          && previous.source.data === node.data
          && previousData?.matched === matched
          && previousData.relationHighlighted === relationHighlighted
          && previousData.activeTaskCount === activeTaskCount
          && previousData.inputCount === inputRecords.length
          && previousData.outputCount === outputCount
          && previousData.mediaInputs === mediaInputs
          && previousData.textInputCount === connectedText.length
          && previousData.textInputs === textInputs
          && previousData.promptNodeTitle === promptNodeTitle
          && previousData.h3LoraOptions === h3LoraOptions
          && previousData.workflowModules === workflowModules
          && previousData.workflowModuleDefaults === workflowModuleDefaults,
        );
        const data = presentationUnchanged
          ? previousData!
          : {
              ...node.data,
              matched,
              relationHighlighted,
              activeTaskCount,
              inputCount: inputRecords.length,
              outputCount,
              mediaInputs,
              textInputCount: connectedText.length,
              textInputs,
              promptNodeTitle,
              h3LoraOptions,
              workflowModules,
              workflowModuleDefaults,
            };
        const result = previous?.source === node && previous.result.data === data
          ? previous.result
          : { ...node, data };
        nextCache.set(node.id, { source: node, result });
        return result;
      });
      visibleNodeCache.current = nextCache;
      return results;
    },
    [activeComfyTaskCounts, contentNodes, edges, h3LoraOptions, matchedIds, nodes, relationHighlightedIds, workflowModuleDefaults, workflowModules],
  );

  const updateGuideOverlays = useCallback((nextAlignment: AlignmentGuide[], nextSpacing: SpacingGuide[]) => {
    if (!guidesEqual(alignmentGuidesSnapshot.current, nextAlignment)) {
      alignmentGuidesSnapshot.current = nextAlignment;
      setAlignmentGuides(nextAlignment);
    }
    if (!guidesEqual(spacingGuidesSnapshot.current, nextSpacing)) {
      spacingGuidesSnapshot.current = nextSpacing;
      setSpacingGuides(nextSpacing);
    }
  }, []);

  const beginAlignedNodeDrag = useCallback(() => {
    alignedDragPositions.current.clear();
    updateGuideOverlays([], []);
  }, [updateGuideOverlays]);

  const updateAlignedNodeDrag = useCallback((node: CanvasFlowNode, draggedNodes: CanvasFlowNode[]) => {
    const movingNodes = draggedNodes.length ? draggedNodes : [node];
    const movingIds = new Set(movingNodes.map((movingNode) => movingNode.id));
    const candidateNodes = nodesSnapshot.current.filter((candidate) => !movingIds.has(candidate.id));
    const viewport = getViewport();
    const zoom = Math.max(viewport.zoom, 0.01);
    const tolerance = ALIGNMENT_SNAP_TOLERANCE_PX / zoom;
    const visibleBounds: CanvasNodeBounds = {
      left: -viewport.x / zoom,
      right: (window.innerWidth - viewport.x) / zoom,
      top: -viewport.y / zoom,
      bottom: (window.innerHeight - viewport.y) / zoom,
    };
    const visibleCandidateNodes = candidateNodes.filter((candidate) => (
      boundsIntersect(canvasNodeBounds(candidate), visibleBounds)
    ));
    const edgeAlignment = findEdgeAlignment(movingNodes, visibleCandidateNodes, tolerance);
    const spacing = findEqualSpacing(movingNodes, visibleCandidateNodes, tolerance);
    const edgeVerticalGuide = edgeAlignment.guides.find((guide) => guide.orientation === "vertical");
    const edgeHorizontalGuide = edgeAlignment.guides.find((guide) => guide.orientation === "horizontal");
    const useHorizontalSpacing = Boolean(
      spacing.horizontal
      && (!edgeVerticalGuide || spacing.horizontal.distance <= Math.abs(edgeAlignment.deltaX)),
    );
    const useVerticalSpacing = Boolean(
      spacing.vertical
      && (!edgeHorizontalGuide || spacing.vertical.distance <= Math.abs(edgeAlignment.deltaY)),
    );
    const deltaX = useHorizontalSpacing ? spacing.horizontal!.delta : edgeAlignment.deltaX;
    const deltaY = useVerticalSpacing ? spacing.vertical!.delta : edgeAlignment.deltaY;
    const guides = edgeAlignment.guides.filter((guide) => (
      !(useHorizontalSpacing && guide.orientation === "vertical")
      && !(useVerticalSpacing && guide.orientation === "horizontal")
    ));
    const activeSpacingGuides = [
      ...(useHorizontalSpacing ? spacing.horizontal!.guides : []),
      ...(useVerticalSpacing ? spacing.vertical!.guides : []),
    ];
    const finalPositions = new Map(
      movingNodes.map((movingNode) => [
        movingNode.id,
        {
          x: movingNode.position.x + deltaX,
          y: movingNode.position.y + deltaY,
        },
      ]),
    );
    alignedDragPositions.current = finalPositions;
    updateGuideOverlays(guides, activeSpacingGuides);

    if (deltaX === 0 && deltaY === 0) return;
    setNodes((current) => current.map((candidate) => {
      const position = finalPositions.get(candidate.id);
      return position ? { ...candidate, position } : candidate;
    }));
  }, [getViewport, setNodes, updateGuideOverlays]);

  const finishAlignedNodeDrag = useCallback((node: CanvasFlowNode, draggedNodes: CanvasFlowNode[]) => {
    const movedNodes = draggedNodes.length ? draggedNodes : [node];
    const finalPositions = new Map(
      movedNodes.map((movedNode) => [
        movedNode.id,
        alignedDragPositions.current.get(movedNode.id) ?? movedNode.position,
      ]),
    );
    setNodes((current) => current.map((candidate) => {
      const position = finalPositions.get(candidate.id);
      return position ? { ...candidate, position } : candidate;
    }));
    finalPositions.forEach((position, nodeId) => {
      persistPatch(nodeId, { x: position.x, y: position.y });
    });
    alignedDragPositions.current.clear();
    updateGuideOverlays([], []);
  }, [persistPatch, setNodes, updateGuideOverlays]);

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
    setH3ModelParametersDraft(h3ModelParameters);
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

  const workflowModuleDeletionUsage = selectedWorkflowModule
    ? workflowModuleUsageCount(selectedWorkflowModule.id)
    : 0;
  const workflowModuleDeletionReplacement = selectedWorkflowModule
    ? workflowModules.find((module) => (
      !module.deletedAt
      && module.id === workflowModuleReplacementId
      && workflowSlotForModule(module) === workflowSlotForModule(selectedWorkflowModule)
    ))
    : undefined;
  const workflowModuleDeletionDescription = selectedWorkflowModule && workflowModuleDeletionMode === "trash"
    ? workflowModuleDeletionUsage
      ? workflowModuleDeletionReplacement
        ? `仍有 ${workflowModuleDeletionUsage} 个节点或生成快照引用该方案。继续后会先替换为“${workflowModuleDeletionReplacement.name}”，再移入回收站。`
        : `仍有 ${workflowModuleDeletionUsage} 个节点或生成快照引用该方案。继续后这些节点会显示方案缺失。`
      : `“${selectedWorkflowModule.name}”将移入方案回收站，之后仍可恢复。`
    : selectedWorkflowModule
      ? `“${selectedWorkflowModule.name}”及其全部恢复点将被永久删除，此操作无法撤销。`
      : "";

  const appSettingsDialog = settingsOpen && createPortal(
    <>
    <div className="project-dialog-backdrop" onMouseDown={() => {
      if (!workflowModuleDeletionMode && !workflowModuleRestoreRequest) setSettingsOpen(false);
    }}>
      <form
        className="project-dialog app-settings-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (activeSettingsSection === "general") saveComfySettings();
          if (activeSettingsSection === "model") void saveH3ModelParameters();
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="app-settings-header">
          <div className="project-dialog-icon"><Settings2 size={21} /></div>
          <div>
            <h2>应用设置</h2>
            <p>管理 SuCanvas 的连接、工作流、完整备份和本机安全。</p>
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
              <span><strong>基础设置</strong><small>ComfyUI 映射目录</small></span>
            </button>
            <button
              type="button"
              className={activeSettingsSection === "workflows" ? "is-active" : ""}
              onClick={() => setActiveSettingsSection("workflows")}
            >
              <Clapperboard size={16} />
              <span><strong>工作流方案</strong><small>多功能与多套方案</small></span>
            </button>
            <button
              type="button"
              className={activeSettingsSection === "model" ? "is-active" : ""}
              onClick={() => {
                const module = workflowModules.find((candidate) => (
                  !candidate.deletedAt
                  && candidate.id === workflowModuleDefaults["video-generation:reference-to-video"]
                ));
                if (module) {
                  setSelectedWorkflowModuleId(module.id);
                  setH3DiffusionModelName(module.defaults.diffusionModelName);
                  setH3ModelParametersDraft({
                    primaryVideoSteps: module.defaults.primaryVideoSteps,
                    primaryAudioSteps: module.defaults.primaryAudioSteps,
                    secondarySchedulerSteps: module.defaults.secondarySchedulerSteps,
                    primaryBrightness: module.defaults.primaryBrightness,
                    primaryContrast: module.defaults.primaryContrast,
                    primarySaturation: module.defaults.primarySaturation,
                    secondaryBrightness: module.defaults.secondaryBrightness,
                    secondaryContrast: module.defaults.secondaryContrast,
                    secondarySaturation: module.defaults.secondarySaturation,
                  });
                }
                setActiveSettingsSection("model");
              }}
            >
              <SlidersHorizontal size={16} />
              <span><strong>模型参数</strong><small>模型、音频与画面</small></span>
            </button>
            <button
              type="button"
              className={activeSettingsSection === "backup" ? "is-active" : ""}
              onClick={() => setActiveSettingsSection("backup")}
            >
              <DatabaseBackup size={16} />
              <span><strong>数据备份</strong><small>整机迁移与恢复</small></span>
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
                  <p>调整界面显示，并配置远程 ComfyUI 的 Windows 映射路径。</p>
                </div>
                <section className="ui-font-size-setting" aria-labelledby="ui-font-size-setting-title">
                  <div>
                    <strong id="ui-font-size-setting-title">界面字号</strong>
                    <small>中字号会同步扩大文字、控件高度和菜单间距。</small>
                  </div>
                  <div className="ui-font-size-options" role="radiogroup" aria-label="界面字号">
                    {(["small", "medium"] as const).map((size) => (
                      <button
                        key={size}
                        type="button"
                        role="radio"
                        aria-checked={uiFontSize === size}
                        className={uiFontSize === size ? "is-active" : ""}
                        onClick={() => setUiFontSize(size)}
                      >
                        <span aria-hidden="true">Aa</span>
                        {size === "small" ? "小" : "中"}
                      </button>
                    ))}
                  </div>
                </section>
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
            {activeSettingsSection === "workflows" && (
              <section className="settings-pane workflow-settings-pane" aria-labelledby="workflow-settings-title">
                <div className="settings-pane-heading workflow-settings-heading">
                  <div>
                    <h3 id="workflow-settings-title">工作流方案</h3>
                    <p>每个功能可并存多套方案；每套方案独立保存工作流、节点映射、参数默认值和恢复点。</p>
                  </div>
                  <label className="workflow-trash-toggle">
                    <input
                      type="checkbox"
                      checked={showDeletedWorkflowModules}
                      onChange={(event) => setShowDeletedWorkflowModules(event.currentTarget.checked)}
                    />
                    显示回收站
                  </label>
                </div>
                <div className="workflow-module-manager">
                  <aside className="workflow-module-list" aria-label="工作流方案列表">
                    {WORKFLOW_CAPABILITIES.map((capability) => {
                      const modules = workflowModules.filter((module) => (
                        module.capability === capability.value
                        && (showDeletedWorkflowModules || !module.deletedAt)
                      ));
                      return (
                        <section key={capability.value} className="workflow-module-group">
                          <header>
                            <strong>{capability.label}</strong>
                            <span>{modules.length}</span>
                          </header>
                          {modules.map((module) => (
                            <button
                              key={module.id}
                              type="button"
                              className={`${selectedWorkflowModuleId === module.id ? "is-active" : ""} ${module.deletedAt ? "is-deleted" : ""}`}
                              onClick={() => setSelectedWorkflowModuleId(module.id)}
                            >
                              <span>{module.name}</span>
                              <small>
                                {workflowVariantLabel(module)} · {module.revision}
                                {workflowModuleDefaults[workflowSlotForModule(module)] === module.id ? " · 默认" : ""}
                                {module.deletedAt ? " · 回收站" : ""}
                              </small>
                            </button>
                          ))}
                          {!modules.length && <p>尚无方案</p>}
                        </section>
                      );
                    })}
                    <button
                      type="button"
                      className="workflow-module-new"
                      onClick={() => {
                        setSelectedWorkflowModuleId("");
                        setWorkflowModuleNameDraft("新工作流方案");
                        setWorkflowModuleRevisionDraft("当前");
                        setWorkflowModuleCapabilityDraft("video-generation");
                        setWorkflowModuleVariantDraft("reference-to-video");
                        setWorkflowModulePathDraft(h3WorkflowPathDraft || DEFAULT_H3_REFERENCE_WORKFLOW_PATH);
                        setWorkflowModuleValidation(null);
                        setWorkflowModuleBindingsDraft("");
                      }}
                    >
                      <Plus size={14} /> 新建方案
                    </button>
                    <button
                      type="button"
                      className="workflow-module-new"
                      onClick={() => void importWorkflowModuleBundle()}
                      disabled={workflowModulesBusy}
                    >
                      <Upload size={13} /> 导入备份为新方案
                    </button>
                  </aside>
                  <div className="workflow-module-editor">
                    <div className="workflow-module-editor-title">
                      <div>
                        <strong>{selectedWorkflowModule ? "编辑方案" : "新建方案"}</strong>
                        <small>{selectedWorkflowModule?.adapter.adapterId ?? WORKFLOW_PACKAGE_ENGINE}</small>
                      </div>
                      {selectedWorkflowModule && !selectedWorkflowModule.deletedAt && (
                        <div className="workflow-module-title-actions">
                          <button
                            type="button"
                            className={workflowModuleDefaults[workflowSlotForModule(selectedWorkflowModule)] === selectedWorkflowModule.id ? "is-default" : ""}
                            onClick={() => setDefaultWorkflowModule(selectedWorkflowModule)}
                          >
                            {workflowModuleDefaults[workflowSlotForModule(selectedWorkflowModule)] === selectedWorkflowModule.id
                              ? "当前默认"
                              : "设为此功能默认"}
                          </button>
                          <button
                            type="button"
                            className="workflow-module-delete-icon"
                            aria-label="删除方案"
                            title="删除方案"
                            disabled={workflowModulesBusy}
                            onClick={() => setWorkflowModuleDeletionMode("trash")}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="workflow-module-fields">
                      <label>
                        方案名称
                        <input
                          value={workflowModuleNameDraft}
                          onChange={(event) => setWorkflowModuleNameDraft(event.currentTarget.value)}
                          disabled={Boolean(selectedWorkflowModule?.deletedAt)}
                        />
                      </label>
                      <label>
                        修订名称
                        <input
                          value={workflowModuleRevisionDraft}
                          onChange={(event) => setWorkflowModuleRevisionDraft(event.currentTarget.value)}
                          placeholder="例如：v1、稳定版、当前"
                          disabled={Boolean(selectedWorkflowModule?.deletedAt)}
                        />
                      </label>
                      <div className="workflow-module-field">
                        <span>功能类型</span>
                        <SettingsSelect
                          value={workflowModuleCapabilityDraft}
                          onChange={(value) => {
                            const capability = value as WorkflowCapability;
                            setWorkflowModuleCapabilityDraft(capability);
                            setWorkflowModuleVariantDraft(capability === "image-generation"
                              ? "image-generation"
                              : "reference-to-video");
                          }}
                          disabled={Boolean(selectedWorkflowModule?.deletedAt)}
                          ariaLabel="工作流功能类型"
                          options={WORKFLOW_CAPABILITIES.map((capability) => ({
                            value: capability.value,
                            label: `${capability.label}${capability.value === "video-generation" ? "" : "（等待对应适配器）"}`,
                            disabled: capability.value !== "video-generation",
                          }))}
                        />
                      </div>
                      {workflowModuleCapabilityDraft === "video-generation" && (
                        <div className="workflow-module-field">
                          <span>视频生成子类型</span>
                          <SettingsSelect
                            value={workflowModuleVariantDraft}
                            onChange={(value) => {
                              const variant = value as WorkflowVariant;
                              setWorkflowModuleVariantDraft(variant);
                              setWorkflowModuleValidation(null);
                              if (!selectedWorkflowModule) {
                                setWorkflowModuleBindingsDraft("");
                                setWorkflowModulePathDraft(
                                  variant === "first-last-frame"
                                    ? DEFAULT_H3_FIRST_LAST_WORKFLOW_PATH
                                    : variant === "image-to-video"
                                      ? DEFAULT_H3_IMAGE_TO_VIDEO_WORKFLOW_PATH
                                      : variant === "last-frame-to-video"
                                        ? DEFAULT_H3_LAST_FRAME_TO_VIDEO_WORKFLOW_PATH
                                      : h3WorkflowPathDraft || DEFAULT_H3_REFERENCE_WORKFLOW_PATH,
                                );
                              }
                            }}
                            disabled={Boolean(selectedWorkflowModule?.deletedAt)}
                            ariaLabel="视频生成子类型"
                            options={WORKFLOW_VIDEO_VARIANTS.map((variant) => ({
                              value: variant.value,
                              label: `${variant.label}${variant.value === "text-to-video" ? "（等待对应适配器）" : ""}`,
                              disabled: variant.value === "text-to-video",
                            }))}
                          />
                        </div>
                      )}
                    </div>
                    <label className="workflow-module-path-field">
                      API 工作流 JSON
                      <input
                        value={workflowModulePathDraft}
                        onChange={(event) => {
                          setWorkflowModulePathDraft(event.currentTarget.value);
                          setWorkflowModuleValidation(null);
                        }}
                        placeholder="D:\\...\\workflow_api.json"
                        spellCheck={false}
                        disabled={Boolean(selectedWorkflowModule?.deletedAt)}
                      />
                      <small>
                        保存后会复制到应用的独立方案仓库，原始 JSON 后续移动或删除不会影响已保存方案。
                      </small>
                    </label>
                    <details className="workflow-bindings-editor">
                      <summary>高级节点映射</summary>
                      <p>工作流节点 ID 变化时在这里调整映射。留空会使用当前 H3 多参默认映射。</p>
                      <textarea
                        value={workflowModuleBindingsDraft}
                        onChange={(event) => {
                          setWorkflowModuleBindingsDraft(event.currentTarget.value);
                          setWorkflowModuleValidation(null);
                        }}
                        spellCheck={false}
                        disabled={Boolean(selectedWorkflowModule?.deletedAt)}
                        placeholder="留空使用默认节点映射"
                      />
                    </details>
                    {workflowModuleValidation && (
                      <div className={`workflow-module-validation ${workflowModuleValidation.compatible ? "is-valid" : "is-invalid"}`}>
                        <strong>{workflowModuleValidation.compatible ? "兼容性检查通过" : "兼容性检查未通过"}</strong>
                        {workflowModuleValidation.issues.map((issue) => <span key={issue}>{issue}</span>)}
                      </div>
                    )}
                    {selectedWorkflowModule && (
                      <div className="workflow-module-meta">
                        <span>内部副本：{selectedWorkflowModule.sourceWorkflowName}</span>
                        <span>恢复点：{selectedWorkflowModule.backupCount}</span>
                        <span>引用：{workflowModuleUsageCount(selectedWorkflowModule.id)}</span>
                      </div>
                    )}
                    {selectedWorkflowModule && !selectedWorkflowModule.deletedAt && workflowModuleUsageCount(selectedWorkflowModule.id) > 0 && (
                      <div className="workflow-module-replacement">
                        <span>删除时替换引用（可选）</span>
                        <SettingsSelect
                          value={workflowModuleReplacementId}
                          onChange={setWorkflowModuleReplacementId}
                          ariaLabel="删除方案时替换引用"
                          options={[
                            { value: "", label: "不替换，相关节点显示方案缺失" },
                            ...workflowModules.filter((module) => (
                              !module.deletedAt
                              && module.id !== selectedWorkflowModule.id
                              && workflowSlotForModule(module) === workflowSlotForModule(selectedWorkflowModule)
                            )).map((module) => ({
                              value: module.id,
                              label: `${module.name} · ${module.revision}`,
                            })),
                          ]}
                        />
                      </div>
                    )}
                    <div className="workflow-module-actions">
                      {!selectedWorkflowModule?.deletedAt ? (
                        <>
                          <button type="button" onClick={() => void validateWorkflowModuleDraft()} disabled={workflowModulesBusy}>
                            验证适配
                          </button>
                          <button type="button" onClick={() => void saveWorkflowModuleDraft(false)} disabled={workflowModulesBusy}>
                            另存为新方案
                          </button>
                          {selectedWorkflowModule && (
                            <button type="button" onClick={() => void exportSelectedWorkflowModule()} disabled={workflowModulesBusy}>
                              导出备份
                            </button>
                          )}
                          {selectedWorkflowModule && (
                            <button type="button" onClick={() => void requestWorkflowModuleRestore()} disabled={workflowModulesBusy}>
                              从备份恢复当前方案
                            </button>
                          )}
                          {selectedWorkflowModule && selectedWorkflowModule.backupCount > 0 && (
                            <button type="button" onClick={() => void restoreSelectedWorkflowModuleBackup()} disabled={workflowModulesBusy}>
                              恢复到覆盖前状态
                            </button>
                          )}
                          {selectedWorkflowModule && (
                            <button type="button" className="primary-button workflow-module-save-button" onClick={() => void saveWorkflowModuleDraft(true)} disabled={workflowModulesBusy}>
                              保存
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          <button type="button" className="primary-button" onClick={() => void restoreSelectedWorkflowModule()} disabled={workflowModulesBusy}>
                            恢复方案
                          </button>
                          <button type="button" className="dialog-danger" onClick={() => setWorkflowModuleDeletionMode("purge")} disabled={workflowModulesBusy}>
                            彻底删除
                          </button>
                        </>
                      )}
                    </div>
                    {!workflowModulesReady && <p className="workflow-module-loading">正在读取工作流方案…</p>}
                  </div>
                </div>
              </section>
            )}
            {activeSettingsSection === "model" && (
              <section className="settings-pane model-settings-pane" aria-labelledby="model-settings-title">
                <div className="settings-pane-heading">
                  <h3 id="model-settings-title">模型参数</h3>
                  <p>参数独立保存在所选工作流方案中，不会影响其他并存方案。</p>
                </div>
                <div className="model-workflow-module-select">
                  <span>编辑方案</span>
                  <SettingsSelect
                    value={selectedWorkflowModule?.capability === "video-generation" ? selectedWorkflowModule.id : ""}
                    onChange={(value) => {
                      const module = workflowModules.find((candidate) => candidate.id === value);
                      if (!module) return;
                      setSelectedWorkflowModuleId(module.id);
                      setH3DiffusionModelName(module.defaults.diffusionModelName);
                      setH3ModelParametersDraft({
                        primaryVideoSteps: module.defaults.primaryVideoSteps,
                        primaryAudioSteps: module.defaults.primaryAudioSteps,
                        secondarySchedulerSteps: module.defaults.secondarySchedulerSteps,
                        primaryBrightness: module.defaults.primaryBrightness,
                        primaryContrast: module.defaults.primaryContrast,
                        primarySaturation: module.defaults.primarySaturation,
                        secondaryBrightness: module.defaults.secondaryBrightness,
                        secondaryContrast: module.defaults.secondaryContrast,
                        secondarySaturation: module.defaults.secondarySaturation,
                      });
                      setH3LoraPreference((current) => ({
                        ...current,
                        loraName: module.defaults.loraName,
                        loraStrength: module.defaults.loraStrength,
                      }));
                    }}
                    ariaLabel="模型参数编辑方案"
                    placeholder="没有可用方案"
                    options={workflowModules.filter((module) => (
                      !module.deletedAt
                      && module.capability === "video-generation"
                      && module.variant !== "text-to-video"
                    )).map((module) => ({
                      value: module.id,
                      label: `${module.name} · ${module.revision}`,
                    }))}
                  />
                </div>
                <div className="model-workflow-module-select model-diffusion-model-select">
                  <span>MiniMax H3 基础模型</span>
                  <SettingsSelect
                    value={h3DiffusionModelName}
                    onChange={setH3DiffusionModelName}
                    ariaLabel="MiniMax H3 基础模型"
                    placeholder={h3DiffusionModelCatalogLoaded ? "MinimaxH3 目录中没有可用模型" : "正在读取 ComfyUI 模型…"}
                    disabled={!h3DiffusionModelOptions.length}
                    options={h3DiffusionModelOptions.map((model) => ({
                      value: model,
                      label: h3DiffusionModelDisplayName(model),
                    }))}
                  />
                  <small>来自 ComfyUI 的 models/diffusion_models/MinimaxH3 目录，保存后应用于当前工作流方案。</small>
                </div>
                <section className="h3-model-parameters" aria-label="H3 模型参数">
                  {selectedWorkflowModule?.uiSchema.groups.map((group, groupIndex) => (
                    <div className="h3-model-parameter-group" key={group.id}>
                      <strong>{group.title}</strong>
                      <div className="h3-model-parameters-grid">
                        {group.fields.filter((field) => (
                          field.key !== "primaryVideoSteps"
                          && field.key !== "secondarySchedulerSteps"
                        )).map((field, fieldIndex) => (
                          <label key={field.key}>
                            {field.label}
                            <ModelParameterNumberInput
                              autoFocus={groupIndex === 0 && fieldIndex === 0}
                              min={field.minKey
                                ? h3ModelParametersDraft[field.minKey] || field.min
                                : field.min}
                              max={field.max}
                              step={field.step}
                              value={h3ModelParametersDraft[field.key]}
                              onChange={(value) => setH3ModelParametersDraft((current) => ({
                                ...current,
                                [field.key]: value,
                              }))}
                            />
                          </label>
                        ))}
                      </div>
                      {group.id === "sampling-steps"
                        ? <small className="h3-model-parameters-note">Video Steps 与二采 Steps 已移至视频节点；这里保留一采 Audio Steps。</small>
                        : group.note && <small className="h3-model-parameters-note">{group.note}</small>}
                    </div>
                  ))}
                </section>
              </section>
            )}
            {activeSettingsSection === "backup" && (
              <section className="settings-pane app-backup-settings" aria-labelledby="app-backup-settings-title">
                <div className="settings-pane-heading">
                  <h3 id="app-backup-settings-title">数据备份与恢复</h3>
                  <p>将项目数据库、素材、工作流方案与适配器、方案恢复点和软件设置保存为一个完整备份。</p>
                </div>
                <div className="app-backup-card">
                  <span className="app-backup-card-icon"><DatabaseBackup size={19} /></span>
                  <div>
                    <strong>一键备份整个软件</strong>
                    <p>备份时创建数据库一致性快照，不会直接复制正在写入的数据库。备份文件可以保存到移动硬盘或同步盘。</p>
                  </div>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => void exportFullAppBackup()}
                    disabled={appBackupBusy}
                  >
                    {appBackupBusy ? "处理中…" : "立即备份"}
                  </button>
                </div>
                <div className="app-backup-card">
                  <span className="app-backup-card-icon is-restore"><RotateCcw size={19} /></span>
                  <div>
                    <strong>从完整备份恢复</strong>
                    <p>适用于新电脑安装后的整机恢复。软件会先校验备份，并保留恢复前的数据目录；重新启动后生效。</p>
                  </div>
                  <button
                    type="button"
                    className="app-backup-restore-button"
                    onClick={() => void chooseFullAppBackupToRestore()}
                    disabled={appBackupBusy}
                  >
                    选择备份恢复
                  </button>
                </div>
                <div className="app-backup-includes">
                  <strong>备份内容</strong>
                  <span>项目和节点数据库</span>
                  <span>已导入的图片、音频、视频素材</span>
                  <span>全部工作流与适配器</span>
                  <span>方案备份、应用锁和界面设置</span>
                </div>
                {runtime?.dataPath && (
                  <p className="app-backup-data-path" title={runtime.dataPath}>
                    当前数据库：{runtime.dataPath}
                  </p>
                )}
                <p className="app-backup-external-note">
                  ComfyUI 输出目录中的生成文件属于外部数据，不在软件备份内；如需长期保留，请同时备份 ComfyUI output 目录。
                </p>
                {appBackupMessage && (
                  <p className={`app-backup-message is-${appBackupMessageKind}`} role="status">
                    {appBackupMessage}
                  </p>
                )}
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
          {activeSettingsSection === "model" && (
            <button type="submit" className="primary-button">
              保存模型参数
            </button>
          )}
        </div>
      </form>
    </div>
    {workflowModuleDeletionMode && selectedWorkflowModule && (
      <div
        className="project-dialog-backdrop workflow-delete-dialog-backdrop"
        onMouseDown={() => {
          if (!workflowModulesBusy) setWorkflowModuleDeletionMode(null);
        }}
      >
        <div
          className="project-dialog project-delete-dialog workflow-delete-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="workflow-delete-title"
          aria-describedby="workflow-delete-description"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="project-dialog-icon"><Trash2 size={22} /></div>
          <div>
            <h2 id="workflow-delete-title">
              {workflowModuleDeletionMode === "trash" ? "将方案移入回收站？" : "彻底删除工作流方案？"}
            </h2>
            <p id="workflow-delete-description">{workflowModuleDeletionDescription}</p>
            {workflowModuleDeletionMode === "purge" && (
              <p className="workflow-delete-warning">方案文件和恢复点删除后无法找回。</p>
            )}
          </div>
          <div className="project-dialog-actions">
            <button
              type="button"
              className="dialog-cancel"
              autoFocus
              disabled={workflowModulesBusy}
              onClick={() => setWorkflowModuleDeletionMode(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="dialog-danger"
              disabled={workflowModulesBusy}
              onClick={() => {
                const mode = workflowModuleDeletionMode;
                setWorkflowModuleDeletionMode(null);
                if (mode === "trash") void trashSelectedWorkflowModule();
                else void purgeSelectedWorkflowModule();
              }}
            >
              <Trash2 size={14} />
              {workflowModuleDeletionMode === "trash" ? "移入回收站" : "永久删除"}
            </button>
          </div>
        </div>
      </div>
    )}
    {appBackupRestorePath && (
      <div
        className="project-dialog-backdrop app-backup-restore-backdrop"
        onMouseDown={() => {
          if (!appBackupBusy) setAppBackupRestorePath(null);
        }}
      >
        <div
          className="project-dialog project-delete-dialog app-backup-restore-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="app-backup-restore-title"
          aria-describedby="app-backup-restore-description"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="project-dialog-icon"><RotateCcw size={22} /></div>
          <div>
            <h2 id="app-backup-restore-title">恢复整个软件数据？</h2>
            <p id="app-backup-restore-description">
              当前项目、素材、工作流和软件设置将在下次启动时被备份中的内容替换。恢复前的 data 目录会自动保留。
            </p>
            <p className="app-backup-restore-file" title={appBackupRestorePath}>{appBackupRestorePath}</p>
          </div>
          <div className="project-dialog-actions">
            <button
              type="button"
              className="dialog-cancel"
              autoFocus
              disabled={appBackupBusy}
              onClick={() => setAppBackupRestorePath(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={appBackupBusy}
              onClick={() => void restoreFullAppBackup()}
            >
              {appBackupBusy ? "校验中…" : "确认恢复"}
            </button>
          </div>
        </div>
      </div>
    )}
    {workflowModuleRestoreRequest && (
      <div
        className="project-dialog-backdrop workflow-delete-dialog-backdrop"
        onMouseDown={() => {
          if (!workflowModulesBusy) setWorkflowModuleRestoreRequest(null);
        }}
      >
        <div
          className="project-dialog project-delete-dialog workflow-delete-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="workflow-restore-title"
          aria-describedby="workflow-restore-description"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="project-dialog-icon"><RotateCcw size={22} /></div>
          <div>
            <h2 id="workflow-restore-title">从备份恢复当前方案？</h2>
            <p id="workflow-restore-description">
              将使用“{workflowModuleRestoreRequest.bundlePath.split(/[\\/]/).pop()}”完整替换当前方案“{workflowModuleRestoreRequest.moduleName}”。
            </p>
            <p className="workflow-delete-warning">当前内容会先自动保存为恢复点，需要时仍可撤回。</p>
          </div>
          <div className="project-dialog-actions">
            <button
              type="button"
              className="dialog-cancel"
              autoFocus
              disabled={workflowModulesBusy}
              onClick={() => setWorkflowModuleRestoreRequest(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={workflowModulesBusy}
              onClick={() => void restoreWorkflowModuleFromBundle()}
            >
              <RotateCcw size={14} />
              {workflowModulesBusy ? "正在恢复…" : "确认恢复"}
            </button>
          </div>
        </div>
      </div>
    )}
    </>,
    document.body,
  );

  if (!activeProjectId) {
    return (
      <main className="project-home">
        <header className="project-home-header">
          <div className="project-home-brand">
            <div className="project-home-mark">
              <img src={suCanvasLogo} alt="" />
            </div>
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
      onPointerDownCapture={(event) => {
        if (event.button === 1) setMiddlePanActive(true);
      }}
    >
      <ReactFlow<CanvasFlowNode, Edge>
        className={[
          spacePanActive ? "is-space-pan-active" : "",
          middlePanActive ? "is-middle-pan-active" : "",
        ].filter(Boolean).join(" ") || undefined}
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
        onNodeDragStart={beginAlignedNodeDrag}
        onNodeDrag={(_, node, draggedNodes) => updateAlignedNodeDrag(node, draggedNodes)}
        onNodeDragStop={(_, node, draggedNodes) => finishAlignedNodeDrag(node, draggedNodes)}
        minZoom={0.12}
        maxZoom={2.2}
        onlyRenderVisibleElements
        defaultEdgeOptions={{ type: "canvasEdge", animated: false }}
        connectionLineStyle={{
          stroke: "#646d82",
          strokeWidth: 2.5,
          vectorEffect: "non-scaling-stroke",
        }}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode="Control"
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        panActivationKeyCode="Space"
        panOnDrag={[1]}
        panOnScroll
        proOptions={{ hideAttribution: true }}
        fitView
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={CANVAS_GRID_SIZE}
          size={1.2}
          color={canvasGridColor(canvasBackground, theme)}
        />
        <ViewportPortal>
          {alignmentGuides.map((guide) => (
            <div
              key={`${guide.orientation}-${guide.position}`}
              className={`alignment-guide is-${guide.orientation}`}
              style={guide.orientation === "vertical"
                ? {
                    left: guide.position,
                    top: guide.start,
                    height: Math.max(1, guide.end - guide.start),
                  }
                : {
                    left: guide.start,
                    top: guide.position,
                    width: Math.max(1, guide.end - guide.start),
                  }}
            />
          ))}
          {spacingGuides.map((guide, index) => (
            <div
              key={`${guide.orientation}-${guide.position}-${guide.start}-${index}`}
              className={`spacing-guide is-${guide.orientation}`}
              style={guide.orientation === "horizontal"
                ? {
                    left: guide.start,
                    top: guide.position,
                    width: Math.max(1, guide.end - guide.start),
                  }
                : {
                    left: guide.position,
                    top: guide.start,
                    height: Math.max(1, guide.end - guide.start),
                  }}
            />
          ))}
        </ViewportPortal>
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

        {SHOW_NODE_SEARCH && (
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
        )}

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
      {videoRegenerationDraft && createPortal(
        <div
          className="project-dialog-backdrop"
          onMouseDown={() => setVideoRegenerationDraft(null)}
        >
          <form
            ref={videoRegenerationDialogRef}
            className="project-dialog video-regeneration-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void submitConfiguredVideoRegeneration();
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="project-dialog-icon"><RotateCcw size={21} /></div>
            <div>
              <h2>调整参数重新生成</h2>
              <p>默认使用“{videoRegenerationDraft.previewTitle}”保存的一采参数，只覆盖下列项目。</p>
            </div>
            <div className="video-regeneration-fields">
              <label>
                Seed
                <div className="video-regeneration-seed">
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={20}
                    value={videoRegenerationDraft.seed}
                    onChange={(event) => setVideoRegenerationDraft((current) => current && ({
                      ...current,
                      seed: event.currentTarget.value.replace(/\D/g, ""),
                    }))}
                    aria-label="重新生成 Seed"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    title="随机生成新 Seed"
                    aria-label="随机生成新 Seed"
                    onClick={() => setVideoRegenerationDraft((current) => {
                      if (!current) return current;
                      let seed = randomFixedSeed();
                      while (seed === current.seed) seed = randomFixedSeed();
                      return { ...current, seed };
                    })}
                  >
                    <Dices size={14} />
                  </button>
                </div>
              </label>
              <label>
                一采分辨率（MP）
                <ModelParameterNumberInput
                  regenerationField="primaryResolutionMegapixels"
                  min={0.2}
                  max={2}
                  step={0.1}
                  value={videoRegenerationDraft.primaryResolutionMegapixels}
                  onChange={(value) => setVideoRegenerationDraft((current) => current && ({
                    ...current,
                    primaryResolutionMegapixels: value,
                  }))}
                />
              </label>
              <label>
                一采 LoRA 强度
                <ModelParameterNumberInput
                  regenerationField="loraStrength"
                  min={0}
                  max={2}
                  step={0.05}
                  value={videoRegenerationDraft.loraStrength}
                  onChange={(value) => setVideoRegenerationDraft((current) => current && ({
                    ...current,
                    loraStrength: value,
                  }))}
                />
              </label>
              <label>
                Video Steps
                <ModelParameterNumberInput
                  regenerationField="primaryVideoSteps"
                  min={1}
                  max={1000}
                  step={1}
                  value={videoRegenerationDraft.primaryVideoSteps}
                  onChange={(value) => setVideoRegenerationDraft((current) => current && ({
                    ...current,
                    primaryVideoSteps: value,
                  }))}
                />
              </label>
              <label>
                Audio Steps
                <ModelParameterNumberInput
                  regenerationField="primaryAudioSteps"
                  min={1}
                  max={1000}
                  step={1}
                  value={videoRegenerationDraft.primaryAudioSteps}
                  onChange={(value) => setVideoRegenerationDraft((current) => current && ({
                    ...current,
                    primaryAudioSteps: value,
                  }))}
                />
              </label>
              <label>
                亮度
                <ModelParameterNumberInput
                  regenerationField="primaryBrightness"
                  min={0}
                  max={3}
                  step={0.05}
                  value={videoRegenerationDraft.primaryBrightness}
                  onChange={(value) => setVideoRegenerationDraft((current) => current && ({
                    ...current,
                    primaryBrightness: value,
                  }))}
                />
              </label>
              <label>
                对比度
                <ModelParameterNumberInput
                  regenerationField="primaryContrast"
                  min={0}
                  max={3}
                  step={0.05}
                  value={videoRegenerationDraft.primaryContrast}
                  onChange={(value) => setVideoRegenerationDraft((current) => current && ({
                    ...current,
                    primaryContrast: value,
                  }))}
                />
              </label>
              <label>
                饱和度
                <ModelParameterNumberInput
                  regenerationField="primarySaturation"
                  min={0}
                  max={3}
                  step={0.05}
                  value={videoRegenerationDraft.primarySaturation}
                  onChange={(value) => setVideoRegenerationDraft((current) => current && ({
                    ...current,
                    primarySaturation: value,
                  }))}
                />
              </label>
              <fieldset className="video-regeneration-ref-mode">
                <legend>参考图模式</legend>
                <div>
                  {REF_IMAGE_SIZE_OPTIONS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={videoRegenerationDraft.refImageSize === option ? "is-active" : ""}
                      onClick={() => setVideoRegenerationDraft((current) => current && ({
                        ...current,
                        refImageSize: option,
                      }))}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </fieldset>
            </div>
            <p className="video-regeneration-note">
              提示词、素材、模型、LoRA 文件、时长和画面比例仍使用当前视频的历史快照。Seed 默认保持不变，点击色子才会随机更换。
            </p>
            <div className="project-dialog-actions">
              <button type="button" className="dialog-cancel" onClick={() => setVideoRegenerationDraft(null)}>
                取消
              </button>
              <button type="submit" className="primary-button">
                <RotateCcw size={13} />
                生成
              </button>
            </div>
          </form>
        </div>,
        document.body,
      )}
      {secondarySampleDraft && createPortal(
        <div
          className="project-dialog-backdrop"
          onMouseDown={() => setSecondarySampleDraft(null)}
        >
          <form
            ref={secondarySampleDialogRef}
            className="project-dialog video-regeneration-dialog secondary-sample-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void submitConfiguredSecondarySample();
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="project-dialog-icon"><Sparkles size={21} /></div>
            <div>
              <h2>调整二采参数</h2>
              <p>默认使用“{secondarySampleDraft.previewTitle}”当前可用的二采设置，只覆盖下列项目。</p>
            </div>
            <div className="video-regeneration-fields">
              <label>
                Seed
                <div className="video-regeneration-seed">
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={20}
                    value={secondarySampleDraft.seed}
                    onChange={(event) => setSecondarySampleDraft((current) => current && ({
                      ...current,
                      seed: event.currentTarget.value.replace(/\D/g, ""),
                    }))}
                    aria-label="二采 Seed"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    title="点击色子随机生成新 Seed"
                    aria-label="随机生成新 Seed"
                    onClick={() => setSecondarySampleDraft((current) => {
                      if (!current) return current;
                      let seed = randomFixedSeed();
                      while (seed === current.seed) seed = randomFixedSeed();
                      return { ...current, seed };
                    })}
                  >
                    <Dices size={14} />
                  </button>
                </div>
              </label>
              <label>
                二采分辨率（MP）
                <ModelParameterNumberInput
                  secondarySampleField="secondaryResolutionMegapixels"
                  min={0.2}
                  max={2}
                  step={0.1}
                  value={secondarySampleDraft.secondaryResolutionMegapixels}
                  onChange={(value) => setSecondarySampleDraft((current) => current && ({
                    ...current,
                    secondaryResolutionMegapixels: value,
                  }))}
                />
              </label>
              <label>
                二采 LoRA 强度
                <div className={`secondary-sample-lora-control ${secondarySampleDraft.secondaryLoraBypassed ? "is-bypassed" : "is-enabled"}`}>
                  <ModelParameterNumberInput
                    secondarySampleField="secondaryLoraStrength"
                    min={0}
                    max={2}
                    step={0.05}
                    disabled={secondarySampleDraft.secondaryLoraBypassed}
                    value={secondarySampleDraft.secondaryLoraStrength}
                    onChange={(value) => setSecondarySampleDraft((current) => current && ({
                      ...current,
                      secondaryLoraStrength: value,
                    }))}
                  />
                  <div className="secondary-sample-lora-inline-switch">
                    <button
                      type="button"
                      className="video-lora-bypass-switch"
                      role="switch"
                      aria-checked={!secondarySampleDraft.secondaryLoraBypassed}
                      aria-label="启用二采 LoRA"
                      title={secondarySampleDraft.secondaryLoraBypassed
                        ? "二采 LoRA 已关闭，点击启用"
                        : "二采 LoRA 已启用，点击关闭"}
                      onClick={() => setSecondarySampleDraft((current) => current && ({
                        ...current,
                        secondaryLoraBypassed: !current.secondaryLoraBypassed,
                      }))}
                    >
                      <span aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </label>
              <label>
                Scheduler Steps
                <ModelParameterNumberInput
                  secondarySampleField="secondarySchedulerSteps"
                  min={1}
                  max={10000}
                  step={1}
                  value={secondarySampleDraft.secondarySchedulerSteps}
                  onChange={(value) => setSecondarySampleDraft((current) => current && ({
                    ...current,
                    secondarySchedulerSteps: value,
                  }))}
                />
              </label>
              <label>
                亮度
                <ModelParameterNumberInput
                  secondarySampleField="secondaryBrightness"
                  min={0}
                  max={3}
                  step={0.05}
                  value={secondarySampleDraft.secondaryBrightness}
                  onChange={(value) => setSecondarySampleDraft((current) => current && ({
                    ...current,
                    secondaryBrightness: value,
                  }))}
                />
              </label>
              <label>
                对比度
                <ModelParameterNumberInput
                  secondarySampleField="secondaryContrast"
                  min={0}
                  max={3}
                  step={0.05}
                  value={secondarySampleDraft.secondaryContrast}
                  onChange={(value) => setSecondarySampleDraft((current) => current && ({
                    ...current,
                    secondaryContrast: value,
                  }))}
                />
              </label>
              <label>
                饱和度
                <ModelParameterNumberInput
                  secondarySampleField="secondarySaturation"
                  min={0}
                  max={3}
                  step={0.05}
                  value={secondarySampleDraft.secondarySaturation}
                  onChange={(value) => setSecondarySampleDraft((current) => current && ({
                    ...current,
                    secondarySaturation: value,
                  }))}
                />
              </label>
              <fieldset className="video-regeneration-ref-mode">
                <legend>参考图模式</legend>
                <div>
                  {REF_IMAGE_SIZE_OPTIONS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={secondarySampleDraft.refImageSize === option ? "is-active" : ""}
                      onClick={() => setSecondarySampleDraft((current) => current && ({
                        ...current,
                        refImageSize: option,
                      }))}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </fieldset>
            </div>
            <p className="video-regeneration-note">
              Seed 默认保持原视频数值，点击色子才会随机更换。二采 LoRA 默认关闭，其余提示词、素材、模型及 LoRA 文件保持原二采逻辑。
            </p>
            <div className="project-dialog-actions">
              <button type="button" className="dialog-cancel" onClick={() => setSecondarySampleDraft(null)}>
                取消
              </button>
              <button type="submit" className="primary-button">
                <Sparkles size={13} />
                开始二采
              </button>
            </div>
          </form>
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
          <button type="button" role="menuitem" onClick={() => createNodeFromContextMenu("video-generation")}>
            <Clapperboard size={15} />
            <span><strong>视频生成节点</strong><small>连接素材并提交生成</small></span>
          </button>
          <button type="button" role="menuitem" onClick={() => createNodeFromContextMenu("text")}>
            <FileText size={15} />
            <span><strong>文本节点</strong><small>输入提示词或普通文本</small></span>
          </button>
          <button type="button" role="menuitem" onClick={() => createNodeFromContextMenu("prompt-version")}>
            <History size={15} />
            <span><strong>提示词版本节点</strong><small>保留 v1、v2、v3 并选择生成版本</small></span>
          </button>
          <button type="button" role="menuitem" onClick={() => createNodeFromContextMenu("note")}>
            <StickyNote size={15} />
            <span><strong>备注节点</strong><small>记录说明和想法</small></span>
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
        <div className="app-lock-mark">
          <img src={suCanvasLogo} alt="" />
        </div>
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
    document.documentElement.dataset.fontSize =
      window.localStorage.getItem(UI_FONT_SIZE_STORAGE_KEY) === "medium" ? "medium" : "small";
    void checkAppLock();
  }, [checkAppLock]);

  if (accessState === "checking") {
    return (
      <main className="app-lock-screen is-loading" aria-label="正在检查应用锁">
        <div className="app-lock-loading-mark">
          <img src={suCanvasLogo} alt="" />
        </div>
      </main>
    );
  }

  if (accessState === "error") {
    return (
      <main className="app-lock-screen">
        <div className="app-lock-card app-lock-error-card">
          <div className="app-lock-mark">
            <img src={suCanvasLogo} alt="" />
          </div>
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
