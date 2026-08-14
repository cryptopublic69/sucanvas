import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { createPortal } from "react-dom";
import {
  Background,
  BackgroundVariant,
  Connection,
  Controls,
  Edge,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  ViewportPortal,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStore,
  useStoreApi,
} from "@xyflow/react";
import {
  ArrowLeft,
  Check,
  Clapperboard,
  Copy,
  DatabaseBackup,
  Dices,
  Eye,
  EyeOff,
  FileText,
  FolderKanban,
  FolderOpen,
  FolderPlus,
  History,
  Image as ImageIcon,
  Link2,
  LockKeyhole,
  Moon,
  Palette,
  Pencil,
  Plus,
  Radio,
  RotateCcw,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  StickyNote,
  Sun,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import suCanvasLogo from "../src-tauri/icons/128x128@2x.png";
import "./App.css";
import {
  ALIGNMENT_SNAP_TOLERANCE_PX,
  AUDIO_NODE_MIN_HEIGHT,
  CANVAS_GRID_SIZE,
  COMFYUI_SERVER_URL_STORAGE_KEY,
  COMFY_TASK_STORAGE_KEY,
  DEFAULT_H3_DIFFUSION_MODEL_NAME,
  DEFAULT_H3_FIRST_LAST_WORKFLOW_PATH,
  DEFAULT_H3_IMAGE_TO_VIDEO_WORKFLOW_PATH,
  DEFAULT_H3_LAST_FRAME_TO_VIDEO_WORKFLOW_PATH,
  DEFAULT_H3_LORA_NAME,
  DEFAULT_H3_REFERENCE_WORKFLOW_PATH,
  DEFAULT_COMFYUI_SERVER_URL,
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
} from "./CanvasNode";
import type {
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
} from "./CanvasNode";

function nodePreviewColor(kind: string): string {
  if (kind === "folder") return "#8b7cf6";
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
  const automaticCover = project.nodes.find(
    (node) => node.kind === "image" && typeof node.content.assetPath === "string",
  );
  const automaticCoverPath = automaticCover?.content.assetPath as string | undefined;
  const coverPath = project.canvas.previewImagePath || automaticCoverPath;

  return (
    <div className="project-thumbnail">
      {coverPath && (
        <img
          key={coverPath}
          className="project-cover-image"
          src={convertFileSrc(coverPath)}
          alt=""
          draggable={false}
          onError={(event) => {
            if (
              automaticCoverPath
              && automaticCoverPath !== coverPath
              && event.currentTarget.dataset.fallbackApplied !== "true"
            ) {
              event.currentTarget.dataset.fallbackApplied = "true";
              event.currentTarget.src = convertFileSrc(automaticCoverPath);
            } else {
              event.currentTarget.style.display = "none";
            }
          }}
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
          {project.nodes.map((node) => (
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
  const [canvasPath, setCanvasPath] = useState<CanvasRecord[]>([]);
  const [canvasBackground, setCanvasBackground] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeSettingsSection, setActiveSettingsSection] = useState<"general" | "workflows" | "video-defaults" | "model" | "backup" | "privacy" | "security">("general");
  const [appBackupBusy, setAppBackupBusy] = useState(false);
  const [appBackupMessage, setAppBackupMessage] = useState("");
  const [appBackupMessageKind, setAppBackupMessageKind] = useState<"success" | "error">("success");
  const [appBackupRestorePath, setAppBackupRestorePath] = useState<string | null>(null);
  const [showPrivateProjects, setShowPrivateProjects] = useState(() =>
    window.localStorage.getItem(PRIVATE_PROJECT_VISIBILITY_STORAGE_KEY) !== "false",
  );
  const [privateProjectVisibilityUnlockOpen, setPrivateProjectVisibilityUnlockOpen] = useState(false);
  const [privateProjectVisibilityPassword, setPrivateProjectVisibilityPassword] = useState("");
  const [privateProjectVisibilityUnlockBusy, setPrivateProjectVisibilityUnlockBusy] = useState(false);
  const [privateProjectVisibilityUnlockError, setPrivateProjectVisibilityUnlockError] = useState("");
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
  const [comfyUiServerUrl, setComfyUiServerUrl] = useState(() =>
    window.localStorage.getItem(COMFYUI_SERVER_URL_STORAGE_KEY) ?? DEFAULT_COMFYUI_SERVER_URL,
  );
  const [comfyUiServerUrlDraft, setComfyUiServerUrlDraft] = useState(() =>
    window.localStorage.getItem(COMFYUI_SERVER_URL_STORAGE_KEY) ?? DEFAULT_COMFYUI_SERVER_URL,
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
  const [ctrlNodeSelectionActive, setCtrlNodeSelectionActive] = useState(false);
  const [spacePanActive, setSpacePanActive] = useState(false);
  const [middlePanActive, setMiddlePanActive] = useState(false);
  const [notice, setNoticeValue] = useState("正在打开画布…");
  const [noticeToastMessage, setNoticeToastMessage] = useState("");
  const [noticeToastSequence, setNoticeToastSequence] = useState(0);
  const [noticeToastVisible, setNoticeToastVisible] = useState(false);
  const setNotice = useCallback((message: string) => {
    setNoticeValue(message);
  }, []);
  const showGlobalNotice = useCallback((message: string) => {
    setNoticeValue(message);
    setNoticeToastMessage(message);
    setNoticeToastSequence((current) => current + 1);
  }, []);
  const [comfyQueueCounts, setComfyQueueCounts] = useState<ComfyQueueSummary>({
    runningCount: 0,
    pendingCount: 0,
    totalCount: 0,
  });
  const [h3LoraOptions, setH3LoraOptions] = useState<string[]>([]);
  const [h3LoraCatalogLoaded, setH3LoraCatalogLoaded] = useState(false);
  const [h3LoraPreference, setH3LoraPreference] = useState(h3LoraPreferenceFromStorage);
  const [h3DiffusionModelOptions, setH3DiffusionModelOptions] = useState<string[]>([DEFAULT_H3_DIFFUSION_MODEL_NAME]);
  const [h3DiffusionModelCatalogLoaded, setH3DiffusionModelCatalogLoaded] = useState(false);
  const [h3DiffusionModelName, setH3DiffusionModelName] = useState(DEFAULT_H3_DIFFUSION_MODEL_NAME);
  const [h3ModelParameters, setH3ModelParameters] = useState(h3ModelParametersFromStorage);
  const [h3ModelParametersDraft, setH3ModelParametersDraft] = useState(h3ModelParameters);
  const [videoGenerationDefaults, setVideoGenerationDefaults] = useState(videoGenerationDefaultsFromStorage);
  const [videoGenerationDefaultsDraft, setVideoGenerationDefaultsDraft] = useState(videoGenerationDefaults);
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
  const [folderGroupingBusy, setFolderGroupingBusy] = useState(false);
  const [videoDeletionRequest, setVideoDeletionRequest] = useState<VideoDeletionRequest | null>(null);
  const [videoRegenerationDraft, setVideoRegenerationDraft] = useState<VideoRegenerationDraft | null>(null);
  const [videoRegenerationInformationOpen, setVideoRegenerationInformationOpen] = useState(false);
  const [secondarySampleDraft, setSecondarySampleDraft] = useState<SecondarySampleDraft | null>(null);
  const selectedVideoRegenerationPrompt = videoRegenerationDraft?.promptOptions.find(
    (option) => option.key === videoRegenerationDraft.selectedPromptKey,
  ) ?? null;
  const saveTimers = useRef(new Map<string, number>());
  const pendingPatches = useRef(new Map<string, NodePatch>());
  const contentGraphSyncTimer = useRef<number | null>(null);
  const contentGraphSyncSequence = useRef(0);
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
  const externalFileDragActive = useRef(false);
  const recoveredNodeActiveKeys = useRef(new Map<string, string>());
  const completedGenerationPlaceholders = useRef(new Set<string>());
  const persistedComfyTasks = useRef<PersistedComfyTask[]>(persistedComfyTasksFromStorage());
  const comfyOutputRootRef = useRef(comfyOutputRoot);
  const comfyInputRootRef = useRef(comfyInputRoot);
  const comfyUiServerUrlRef = useRef(comfyUiServerUrl);
  const h3WorkflowPathRef = useRef(h3WorkflowPath);
  const makeFlowNodeRef = useRef<((record: NodeRecord, matched?: boolean) => CanvasFlowNode) | null>(null);
  const openFolderRef = useRef<(nodeId: string) => void>(() => undefined);
  const activeProjectIdRef = useRef<string | null>(null);
  const projectNameInputRef = useRef<HTMLInputElement>(null);
  const videoRegenerationDialogRef = useRef<HTMLFormElement>(null);
  const secondarySampleDialogRef = useRef<HTMLFormElement>(null);
  const undoStack = useRef<CanvasUndoEntry[]>([]);
  const nodeDeletionInProgress = useRef(false);
  const nodeClipboard = useRef<NodeClipboard | null>(null);
  const alignedDragPositions = useRef(new Map<string, { x: number; y: number }>());
  const { setCenter, fitView, screenToFlowPosition, getViewport } = useReactFlow<CanvasFlowNode, Edge>();
  const flowStore = useStoreApi<CanvasFlowNode, Edge>();
  const canvasZoom = useStore((state) => state.transform[2]);
  const nodeHandleScreenScale = Math.max(
    1,
    NODE_HANDLE_MIN_SCREEN_SIZE_PX / (NODE_HANDLE_BASE_SIZE_PX * Math.max(canvasZoom, 0.01)),
  );

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
    if (!noticeToastMessage.trim()) return;
    setNoticeToastVisible(true);
    const timer = window.setTimeout(() => setNoticeToastVisible(false), 2600);
    return () => window.clearTimeout(timer);
  }, [noticeToastMessage, noticeToastSequence]);

  useEffect(() => {
    nodesSnapshot.current = nodes;
    edgesSnapshot.current = edges;
  }, [edges, nodes]);

  const contentNodes = useMemo(() => {
    const previous = contentNodesCache.current;
    const contentUnchanged = previous.length === nodes.length
      && previous.every((node, index) => (
        node.id === nodes[index].id
        && node.data === nodes[index].data
        && node.selected === nodes[index].selected
      ));
    if (contentUnchanged) return previous;
    contentNodesCache.current = nodes;
    return nodes;
  }, [nodes]);
  const multiNodeSelectionActive = useMemo(
    () => nodes.filter((node) => node.selected).length > 1,
    [nodes],
  );
  const canvasSelectionSyncKey = useRef("");

  useEffect(() => {
    const nodeIds = nodes.filter((node) => node.selected).map((node) => node.id);
    const syncKey = `${activeProjectId ?? ""}:${nodeIds.join(",")}`;
    if (canvasSelectionSyncKey.current === syncKey) return;
    canvasSelectionSyncKey.current = syncKey;
    void invoke("update_canvas_selection", {
      canvasId: activeProjectId,
      nodeIds,
    }).catch(() => undefined);
  }, [activeProjectId, nodes]);

  useEffect(() => {
    if (!multiNodeSelectionActive) return;
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement
      && activeElement.closest(".react-flow__node.selected")
    ) {
      activeElement.blur();
    }
  }, [multiNodeSelectionActive]);

  const protectedGenerationEdgeIds = useMemo(() => {
    const nodeKinds = new Map(contentNodes.map((node) => [node.id, node.data.record.kind]));
    return new Set(edges.filter((edge) => {
      const kind = (edge.data as CanvasEdgeData | undefined)?.record?.kind;
      return kind === "content-derivation"
        || kind === "scene-branch"
        || (
          kind === "output"
          && nodeKinds.get(edge.source) === "video-generation"
          && nodeKinds.get(edge.target) === "generated-video"
        );
    }).map((edge) => edge.id));
  }, [contentNodes, edges]);

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
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Control") setCtrlNodeSelectionActive(true);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Control") setCtrlNodeSelectionActive(false);
    };
    const stopCtrlNodeSelection = () => setCtrlNodeSelectionActive(false);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", stopCtrlNodeSelection);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", stopCtrlNodeSelection);
    };
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
      if (target instanceof Element && target.closest(".react-flow, .generated-video-info-panel")) {
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
    comfyUiServerUrlRef.current = comfyUiServerUrl;
  }, [comfyUiServerUrl]);

  useEffect(() => {
    h3WorkflowPathRef.current = h3WorkflowPath;
  }, [h3WorkflowPath]);

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const summary = await invoke<ComfyQueueSummary>("get_comfyui_queue_summary", {
          serverUrl: comfyUiServerUrl,
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
  }, [comfyUiServerUrl]);

  const defaultH3WorkflowModuleId = workflowModuleDefaults["video-generation:reference-to-video"] ?? "";

  useEffect(() => {
    if (!workflowModulesReady) return;
    let disposed = false;
    const refresh = async () => {
      setH3LoraCatalogLoaded(false);
      try {
        // The picker is intentionally scoped to the complete MinimaxH3 directory,
        // not to a possibly stale per-workflow binding or a single bootstrap item.
        const loras = await invoke<string[]>("get_comfyui_h3_loras", {
          serverUrl: comfyUiServerUrl,
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
      } catch (error) {
        if (!disposed) {
          setH3LoraCatalogLoaded(false);
          if (settingsOpen && activeSettingsSection === "video-defaults") {
            const message = error instanceof Error ? error.message : String(error);
            showGlobalNotice(`读取 MinimaxH3 LoRA 列表失败：${message}`);
          }
        }
      }
    };
    void refresh();
    return () => {
      disposed = true;
    };
  }, [activeSettingsSection, comfyUiServerUrl, settingsOpen, showGlobalNotice, workflowModulesReady]);

  useEffect(() => {
    if (!workflowModulesReady) return;
    let disposed = false;
    setH3DiffusionModelCatalogLoaded(false);
    void invoke<string[]>("get_comfyui_h3_diffusion_models", {
      serverUrl: comfyUiServerUrl,
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
  }, [comfyUiServerUrl, defaultH3WorkflowModuleId, workflowModulesReady]);

  const toggleTheme = () => setTheme((current) => current === "dark" ? "light" : "dark");

  const reportError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error);
    showGlobalNotice(`操作失败：${message}`);
  }, [showGlobalNotice]);

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
      showGlobalNotice(`软件备份已保存到 ${result.path}`);
      await revealItemInDir(result.path);
    } catch (error) {
      setAppBackupMessageKind("error");
      setAppBackupMessage(error instanceof Error ? error.message : String(error));
      reportError(error);
    } finally {
      setAppBackupBusy(false);
    }
  }, [portableFrontendSettings, reportError, showGlobalNotice]);

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
      showGlobalNotice("恢复已准备完成，请关闭并重新打开 SuCanvas");
    } catch (error) {
      setAppBackupMessageKind("error");
      setAppBackupMessage(error instanceof Error ? error.message : String(error));
      reportError(error);
    } finally {
      setAppBackupBusy(false);
    }
  }, [appBackupRestorePath, reportError, showGlobalNotice]);

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
      if (validation.compatible) setNotice("工作流与当前适配规则兼容");
      else showGlobalNotice("工作流兼容性检查未通过");
    } catch (error) {
      setWorkflowModuleValidation(null);
      reportError(error);
    } finally {
      setWorkflowModulesBusy(false);
    }
  }, [reportError, selectedWorkflowModule, showGlobalNotice, workflowModuleBindingsDraft, workflowModulePathDraft, workflowModuleVariantDraft]);

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
      showGlobalNotice(overwrite ? `方案“${saved.name}”已覆盖，并建立恢复点` : `方案“${saved.name}”已创建`);
    } catch (error) {
      reportError(error);
    } finally {
      setWorkflowModulesBusy(false);
    }
  }, [h3DiffusionModelName, h3LoraPreference, h3ModelParameters, refreshWorkflowModules, reportError, selectedWorkflowModule, showGlobalNotice, workflowModuleBindingsDraft, workflowModuleCapabilityDraft, workflowModuleNameDraft, workflowModulePathDraft, workflowModuleRevisionDraft, workflowModuleVariantDraft]);

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
    showGlobalNotice(`“${module.name}”已设为${workflowVariantLabel(module)}默认方案`);
  }, [showGlobalNotice]);

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
          const updated = await invoke<NodeRecord>("update_node", { input: { id, ...nextPatch } });
          if (!pendingPatches.current.has(id)) {
            setNodes((current) => current.map((node) => (
              node.id === id
                ? {
                    ...node,
                    width: updated.width,
                    height: updated.height,
                    style: { ...node.style, width: updated.width, height: updated.height },
                    data: { ...node.data, record: updated },
                  }
                : node
            )));
          }
          setNotice("所有更改已保存");
        } catch (error) {
          reportError(error);
        }
      }, 450);
      saveTimers.current.set(id, timer);
      setNotice("正在保存…");
    },
    [reportError, setNodes],
  );

  const persistPatchImmediately = useCallback(
    async (id: string, patch: NodePatch) => {
      const activeTimer = saveTimers.current.get(id);
      if (activeTimer) window.clearTimeout(activeTimer);
      saveTimers.current.delete(id);
      const pendingPatch = pendingPatches.current.get(id) ?? {};
      pendingPatches.current.delete(id);
      const nextPatch = { ...pendingPatch, ...patch };
      setNotice("正在保存…");
      try {
        const updated = await invoke<NodeRecord>("update_node", { input: { id, ...nextPatch } });
        if (!pendingPatches.current.has(id)) {
          setNodes((current) => current.map((node) => (
            node.id === id
              ? {
                  ...node,
                  width: updated.width,
                  height: updated.height,
                  style: { ...node.style, width: updated.width, height: updated.height },
                  data: { ...node.data, record: updated },
                }
              : node
          )));
        }
        setNotice("所有更改已保存");
      } catch (error) {
        reportError(error);
      }
    },
    [reportError, setNodes],
  );

  const manualSavedPromptContent = (content: JsonObject): JsonObject | null => {
    const saved = content.manualSavedPromptContent;
    return saved && typeof saved === "object" && !Array.isArray(saved)
      ? saved as JsonObject
      : null;
  };

  const changeNode = useCallback(
    (id: string, patch: NodePatch) => {
      const currentRecord = nodesSnapshot.current.find((node) => node.id === id)?.data.record;
      const nextPatch = currentRecord?.kind === "text"
        && isContentIterationContent(currentRecord.content)
        && patch.content
        && !manualSavedPromptContent(currentRecord.content)
        ? {
            ...patch,
            content: {
              ...patch.content,
              manualSavedPromptContent: { ...currentRecord.content },
            },
          }
        : patch;
      setNodes((current) =>
        current.map((node) => {
          if (node.id !== id) return node;
          const record = { ...node.data.record, ...nextPatch };
          return {
            ...node,
            width: nextPatch.width ?? node.width,
            height: nextPatch.height ?? node.height,
            style: {
              ...node.style,
              width: nextPatch.width ?? node.style?.width,
              height: nextPatch.height ?? node.style?.height,
            },
            data: { ...node.data, record },
          };
        }),
      );
      if ("title" in nextPatch) {
        void persistPatchImmediately(id, nextPatch);
      } else {
        persistPatch(id, nextPatch);
      }
    },
    [persistPatch, persistPatchImmediately, setNodes],
  );

  const replaceNodeRecord = useCallback((record: NodeRecord) => {
    setNodes((current) => current.map((node) => (
      node.id === record.id
        ? {
            ...node,
            width: record.width,
            height: record.height,
            position: { x: record.x, y: record.y },
            style: { ...node.style, width: record.width, height: record.height },
            data: { ...node.data, record },
          }
        : node
    )));
  }, [setNodes]);

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
      // Upgrade only nodes that still use the former default width. Any other
      // width is an intentional user resize and must remain untouched.
      const shouldUpgradeLegacyWidth = record.width === LEGACY_VIDEO_GENERATION_NODE_WIDTH;
      const targetWidth = shouldUpgradeLegacyWidth
        ? VIDEO_GENERATION_NODE_WIDTH
        : record.width;
      const shouldRenameStoryboardGenerator = record.content.storyboardReferenceCompiler === true
        && record.title === "分镜联动视频生成";
      const fullContentHeight = videoGenerationAutoHeight(
        mediaKinds,
        currentTextInputCount,
        targetWidth,
        record.content.storyboardReferenceCompiler === true,
      );
      // Media groups do not scroll: let a newly connected reference asset grow
      // the outer node until its complete group is visible. Text rows remain
      // capped by videoGenerationAutoHeight at VIDEO_NODE_MAX_VISIBLE_TEXT_INPUTS.
      let desiredHeight = Math.max(
        VIDEO_NODE_BASE_HEIGHT,
        record.height,
        fullContentHeight,
      );
      if (storedLayoutTextInputCount === null) {
        const currentTextOnlyHeight = videoGenerationAutoHeight(
          [],
          currentTextInputCount,
          targetWidth,
          record.content.storyboardReferenceCompiler === true,
        );
        desiredHeight = Math.min(
          fullContentHeight,
          Math.max(desiredHeight, currentTextOnlyHeight),
        );
      } else if (storedLayoutTextInputCount !== currentTextInputCount) {
        const previousContentHeight = videoGenerationAutoHeight(
          mediaKinds,
          storedLayoutTextInputCount,
          targetWidth,
          record.content.storyboardReferenceCompiler === true,
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
        !shouldUpgradeLegacyWidth
        && !shouldRenameStoryboardGenerator
        && Math.abs(record.height - desiredHeight) < 0.5
        && storedManualHeight !== null
        && Math.abs(storedManualHeight - desiredHeight) < 0.5
        && storedActiveTextId === activeTextInputId
        && storedLayoutTextInputCount === currentTextInputCount
      ) continue;
      changeNode(node.id, {
        ...(shouldRenameStoryboardGenerator ? { title: "智能视频生成" } : {}),
        width: targetWidth,
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
    undoStack.current.push({ kind: "node-delete", batch });
    if (undoStack.current.length > 50) undoStack.current.shift();
  }, []);

  const rememberUndoEntry = useCallback((entry: CanvasUndoEntry) => {
    undoStack.current.push(entry);
    if (undoStack.current.length > 50) undoStack.current.shift();
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

  const saveTextNodeImmediately = useCallback(async (nodeId: string) => {
    const timer = saveTimers.current.get(nodeId);
    if (timer) window.clearTimeout(timer);
    saveTimers.current.delete(nodeId);
    const pendingPatch = pendingPatches.current.get(nodeId) ?? {};
    pendingPatches.current.delete(nodeId);
    const currentRecord = nodesSnapshot.current.find((node) => node.id === nodeId)?.data.record;
    const draftContent = pendingPatch.content ?? currentRecord?.content;
    if (!currentRecord || currentRecord.kind !== "text" || !draftContent) {
      await flushNodePatches([nodeId]);
      setNotice("已手动保存到数据库");
      return;
    }
    if (!isContentIterationContent(currentRecord.content)) {
      const automaticContent = { ...draftContent };
      delete automaticContent.manualSavedPromptContent;
      const updated = await invoke<NodeRecord>("update_node", {
        input: {
          id: nodeId,
          ...pendingPatch,
          content: automaticContent,
        },
      });
      setNodes((current) => current.map((node) => (
        node.id === nodeId
          ? {
              ...node,
              width: updated.width,
              height: updated.height,
              style: { ...node.style, width: updated.width, height: updated.height },
              data: { ...node.data, record: updated },
            }
          : node
      )));
      setNotice("已自动保存到数据库");
      return;
    }
    const confirmedContent = { ...draftContent };
    delete confirmedContent.manualSavedPromptContent;
    try {
      const updated = await invoke<NodeRecord>("update_node", {
        input: {
          id: nodeId,
          ...pendingPatch,
          content: {
            ...draftContent,
            manualSavedPromptContent: confirmedContent,
          },
        },
      });
      setNodes((current) => current.map((node) => (
        node.id === nodeId
          ? {
              ...node,
              width: updated.width,
              height: updated.height,
              style: { ...node.style, width: updated.width, height: updated.height },
              data: { ...node.data, record: updated },
            }
          : node
      )));
      setNotice("已手动保存到数据库");
    } catch (error) {
      reportError(error);
      throw error;
    }
  }, [flushNodePatches, reportError, setNodes]);

  const markGeneratedVideoFullyPlayed = useCallback((nodeId: string) => {
    const node = nodesSnapshot.current.find((candidate) => candidate.id === nodeId);
    if (!node || node.data.record.kind !== "generated-video") return;
    if (node.data.record.content.hasBeenPlayed !== false) return;
    changeNode(nodeId, {
      content: {
        ...node.data.record.content,
        hasBeenPlayed: true,
      },
    });
    void flushNodePatches([nodeId]).catch(reportError);
  }, [changeNode, flushNodePatches, reportError]);

  const deletePromptVersionFromNode = useCallback(async (nodeId: string, versionId: string) => {
    const flowNode = nodesSnapshot.current.find((node) => node.id === nodeId);
    const record = flowNode?.data.record;
    if (!record || !isContentIterationContent(record.content)) {
      setNotice("找不到内容迭代节点");
      return;
    }
    const versions = promptVersionsFromContent(record.content);
    const version = versions.find((candidate) => candidate.id === versionId);
    if (!version) {
      setNotice("要删除的历史版本不存在");
      return;
    }
    const remaining = versions.filter((candidate) => candidate.id !== versionId);
    const activeId = typeof record.content.activePromptVersionId === "string"
      ? record.content.activePromptVersionId
      : "";
    const nextActive = remaining.length
      ? activeId === versionId
        ? remaining[remaining.length - 1]
        : remaining.find((candidate) => candidate.id === activeId) ?? remaining[0]
      : null;
    const nextContent: JsonObject = {
      ...record.content,
      text: nextActive?.text ?? "",
      information: nextActive?.information ?? "",
      promptVersions: remaining,
      activePromptVersionId: nextActive?.id ?? "",
      bestPromptVersionId: record.content.bestPromptVersionId === versionId
        ? ""
        : record.content.bestPromptVersionId,
    };
    try {
      await flushNodePatches([nodeId]);
      const updated = await invoke<NodeRecord>("update_node", {
        input: { id: nodeId, content: nextContent },
      });
      replaceNodeRecord(updated);
      rememberUndoEntry({
        kind: "prompt-version-delete",
        previousNode: structuredClone(record),
      });
      setNotice(`已删除 ${version.label}，按 Ctrl+Z 恢复`);
    } catch (error) {
      reportError(error);
    }
  }, [flushNodePatches, rememberUndoEntry, replaceNodeRecord, reportError]);

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
          serverUrl: comfyUiServerUrlRef.current,
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
    const serverUrl = comfyUiServerUrlDraft
      .trim()
      .replace(/^"|"$/g, "")
      .replace(/\/+$/, "");
    try {
      const parsed = new URL(serverUrl);
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
        throw new Error();
      }
    } catch {
      showGlobalNotice("ComfyUI 服务地址无效，请填写 http:// 或 https:// 开头的完整地址");
      return;
    }
    const outputRoot = normalizePath(comfyOutputRootDraft);
    const inputRoot = normalizePath(comfyInputRootDraft);
    const workflowPath = normalizePath(h3WorkflowPathDraft)
      || DEFAULT_H3_REFERENCE_WORKFLOW_PATH;
    comfyOutputRootRef.current = outputRoot;
    comfyInputRootRef.current = inputRoot;
    comfyUiServerUrlRef.current = serverUrl;
    h3WorkflowPathRef.current = workflowPath;
    setComfyOutputRoot(outputRoot);
    setComfyInputRoot(inputRoot);
    setComfyUiServerUrl(serverUrl);
    setComfyUiServerUrlDraft(serverUrl);
    setH3WorkflowPath(workflowPath);
    if (outputRoot) window.localStorage.setItem("infinite-canvas:comfy-output-root", outputRoot);
    else window.localStorage.removeItem("infinite-canvas:comfy-output-root");
    if (inputRoot) window.localStorage.setItem("infinite-canvas:comfy-input-root", inputRoot);
    else window.localStorage.removeItem("infinite-canvas:comfy-input-root");
    window.localStorage.setItem(COMFYUI_SERVER_URL_STORAGE_KEY, serverUrl);
    window.localStorage.setItem(H3_REFERENCE_WORKFLOW_STORAGE_KEY, workflowPath);
    showGlobalNotice("ComfyUI 设置已保存");
  }, [comfyInputRootDraft, comfyOutputRootDraft, comfyUiServerUrlDraft, h3WorkflowPathDraft, showGlobalNotice]);

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
      showGlobalNotice("一采 Video Steps 必须是 1 到 1000 的整数");
      return;
    }
    if (!Number.isInteger(primaryAudioSteps) || primaryAudioSteps < primaryVideoSteps || primaryAudioSteps > 1000) {
      showGlobalNotice("一采 Audio Steps 必须是 1 到 1000 的整数，且不能小于 Video Steps");
      return;
    }
    if (!Number.isInteger(secondarySchedulerSteps) || secondarySchedulerSteps < 1 || secondarySchedulerSteps > 10000) {
      showGlobalNotice("二采基本调度器 Steps 必须是 1 到 10000 的整数");
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
      showGlobalNotice(`${invalidColorAdjustment[0]}必须是 0.00 到 3.00 之间的数值`);
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
      showGlobalNotice("没有可保存模型参数的视频生成方案");
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
    showGlobalNotice("模型参数已保存");
  }, [h3DiffusionModelName, h3LoraPreference, h3ModelParametersDraft, refreshWorkflowModules, reportError, selectedWorkflowModule, showGlobalNotice, workflowModuleDefaults, workflowModules]);

  const saveVideoGenerationDefaults = useCallback(() => {
    if (!Number.isInteger(videoGenerationDefaultsDraft.generationDuration)
      || videoGenerationDefaultsDraft.generationDuration < 2
      || videoGenerationDefaultsDraft.generationDuration > 15) {
      showGlobalNotice("默认生成时长必须是 2 到 15 秒的整数");
      return;
    }
    if (!Number.isInteger(videoGenerationDefaultsDraft.generationPrimaryVideoSteps)
      || videoGenerationDefaultsDraft.generationPrimaryVideoSteps < 1
      || videoGenerationDefaultsDraft.generationPrimaryVideoSteps > 1000
      || !Number.isInteger(videoGenerationDefaultsDraft.generationSecondarySchedulerSteps)
      || videoGenerationDefaultsDraft.generationSecondarySchedulerSteps < 1
      || videoGenerationDefaultsDraft.generationSecondarySchedulerSteps > 10000) {
      showGlobalNotice("默认 Steps 数值无效");
      return;
    }
    if (videoGenerationDefaultsDraft.seedMode === "fixed" && !videoGenerationDefaultsDraft.generationSeed) {
      showGlobalNotice("固定种子不能为空");
      return;
    }
    setVideoGenerationDefaults(videoGenerationDefaultsDraft);
    window.localStorage.setItem(
      VIDEO_GENERATION_DEFAULTS_STORAGE_KEY,
      JSON.stringify(videoGenerationDefaultsDraft),
    );
    showGlobalNotice("视频生成默认值已保存，新建节点会使用这些参数");
  }, [showGlobalNotice, videoGenerationDefaultsDraft]);

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
      showGlobalNotice("新密码至少需要 4 个字符");
      return;
    }
    if (appLockNewPassword !== appLockConfirmPassword) {
      setAppLockMessageKind("error");
      setAppLockMessage("两次输入的新密码不一致");
      showGlobalNotice("两次输入的新密码不一致");
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
      const message = appLockEnabled ? "应用锁密码已修改" : "应用锁已启用，下次启动时需要输入密码";
      setAppLockMessage(message);
      showGlobalNotice(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAppLockMessageKind("error");
      setAppLockMessage(message);
      showGlobalNotice(`操作失败：${message}`);
    } finally {
      setAppLockBusy(false);
    }
  }, [appLockConfirmPassword, appLockCurrentPassword, appLockEnabled, appLockNewPassword, clearAppLockPasswordFields, showGlobalNotice]);

  const turnOffAppLock = useCallback(async () => {
    setAppLockBusy(true);
    setAppLockMessage("");
    try {
      await invoke("disable_app_lock", { password: appLockCurrentPassword });
      setAppLockEnabled(false);
      clearAppLockPasswordFields();
      setAppLockMessageKind("success");
      setAppLockMessage("应用锁已关闭");
      showGlobalNotice("应用锁已关闭");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAppLockMessageKind("error");
      setAppLockMessage(message);
      showGlobalNotice(`操作失败：${message}`);
    } finally {
      setAppLockBusy(false);
    }
  }, [appLockCurrentPassword, clearAppLockPasswordFields, showGlobalNotice]);

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

  const generationSnapshotForGenerator = useCallback((
    generatorId: string,
    promptNodeId?: string,
    promptOverride?: {
      prompt: string;
      information: string;
      referenceSelection: StoryboardReferenceSelection | null;
      durationSeconds?: number;
    },
  ): GenerationSnapshot | null => {
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
    const orderedTextInputs = orderedNodeRecordsFromContent(
      generator.content,
      "textInputOrder",
      textInputs,
    );
    const activeTextInput = promptNodeId
      ? orderedTextInputs.find((input) => input.id === promptNodeId) ?? null
      : activeTextInputFromContent(generator.content, orderedTextInputs);
    const activePromptContent = activeTextInput
      ? (isContentIterationContent(activeTextInput.content)
        ? manualSavedPromptContent(activeTextInput.content) ?? activeTextInput.content
        : activeTextInput.content)
      : null;
    const activePromptVersion = activePromptContent
      ? activePromptVersionFromContent(activePromptContent)
      : null;
    const prompt = promptOverride?.prompt
      ?? (activePromptContent ? textFromContent(activePromptContent) : "");
    const promptInformation = promptOverride?.information
      ?? activePromptVersion?.information
      ?? (activePromptContent ? informationFromContent(activePromptContent) : "");
    const promptReferenceSelection = promptOverride?.referenceSelection
      ?? activePromptVersion?.referenceSelection
      ?? (activePromptContent ? referenceSelectionFromContent(activePromptContent) : null);
    const referenceCompilerMode = generator.content.storyboardReferenceCompiler === true;
    const promptDurationSeconds = promptOverride?.durationSeconds
      ?? promptDurationSecondsFromVersion(activePromptVersion);
    const referenceSelection = referenceCompilerMode
      ? resolveStoryboardReferenceSelection(prompt, promptReferenceSelection, orderedMedia)
      : null;
    // A compiler error must produce an empty submission list. Never fall back to
    // uploading every connected candidate, because that reintroduces pollution.
    const submittedMedia = referenceCompilerMode
      ? referenceSelection?.selectedMedia ?? []
      : orderedMedia;
    const assetPaths = (kind: string) => submittedMedia
      .filter((record) => record.kind === kind)
      .map((record) => typeof record.content.assetPath === "string" ? record.content.assetPath : "")
      .filter(Boolean);
    const imageAssets = submittedMedia
      .filter((record) => record.kind === "image")
      .map((record, index) => ({
        path: typeof record.content.assetPath === "string" ? record.content.assetPath : "",
        role: frameRoleFromContent(generator.content, record.id, index),
      }))
      .filter((asset) => Boolean(asset.path));
    const primaryVideoSteps = primaryVideoStepsFromContent(
      generator.content,
      moduleParameters.primaryVideoSteps,
    );
    return {
      prompt,
      promptInformation,
      promptNodeId: activeTextInput?.id ?? "",
      promptNodeTitle: activePromptVersion?.title || activeTextInput?.title || "",
      promptNodeIdSource: activeTextInput ? "captured" : "",
      promptVersionId: activePromptVersion?.id ?? "",
      promptVersionLabel: activePromptVersion?.label ?? "",
      durationSeconds: referenceCompilerMode
        ? promptDurationSeconds ?? 0
        : videoDurationFromContent(generator.content),
      aspectRatio: videoAspectRatioFromContent(generator.content),
      primaryResolutionMegapixels: primaryVideoResolutionFromContent(generator.content),
      secondaryResolutionMegapixels: secondaryVideoResolutionFromContent(generator.content),
      primaryVideoSteps,
      primaryAudioSteps: Math.max(primaryVideoSteps, moduleParameters.primaryAudioSteps),
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
      strictPromptTags: strictPromptTagsFromContent(generator.content),
      imagePaths: imageAssets.map((asset) => asset.path),
      imageRoles: mode === "first-last-frame"
        ? imageAssets.map((asset) => asset.role)
        : [],
      audioPaths: assetPaths("audio"),
      videoPaths: assetPaths("video"),
      ...(referenceCompilerMode ? {
        referenceCompilerMode: true,
        referenceSelection: referenceSelection?.selection ?? null,
        referenceSelectionError: referenceSelection?.error ?? "",
        referenceMappings: referenceSelection?.mappings ?? [],
        referenceCandidateCount: orderedMedia.length,
      } : {}),
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
    positionOverride,
  }: {
    source: NodeRecord;
    clientId: string;
    snapshot: GenerationSnapshot;
    secondary: boolean;
    sourceGeneratorId: string;
    edgeSourceId?: string;
    placeBelowSource?: boolean;
    positionOverride?: { x: number; y: number };
  }) => {
    const previewWidth = generatedVideoPreviewWidthForRatio(videoAspectRatioValue(snapshot.aspectRatio));
    const previewHeight = generatedPreviewHeightForAspectRatio(snapshot.aspectRatio);
    const placementRecords = [
      ...nodesSnapshot.current.map(recordAtCurrentFlowPosition),
      ...incomingPlacementReservations.current,
    ];
    const position = positionOverride ?? (placeBelowSource
      ? generatedPreviewPositionBelow(source, placementRecords, previewWidth, previewHeight)
      : generatedPreviewPosition(source, placementRecords, previewWidth, previewHeight));
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

  const removeGenerationPlaceholder = useCallback(async (
    placeholderNodeId: string | undefined,
  ): Promise<boolean> => {
    if (!placeholderNodeId) return false;
    const placeholder = nodesSnapshot.current.find(
      (node) => node.id === placeholderNodeId,
    )?.data.record;
    if (!placeholder || placeholder.content.generationPlaceholder !== true) return false;

    const wasAlreadyCompleted = completedGenerationPlaceholders.current.has(placeholderNodeId);
    completedGenerationPlaceholders.current.add(placeholderNodeId);
    const removeFromCanvas = () => {
      setNodes((current) => current.filter((node) => node.id !== placeholderNodeId));
      setEdges((current) => current.filter(
        (edge) => edge.source !== placeholderNodeId && edge.target !== placeholderNodeId,
      ));
    };
    try {
      await flushNodePatches([placeholderNodeId]);
      await invoke("delete_node", { id: placeholderNodeId });
      removeFromCanvas();
      return true;
    } catch (error) {
      if (String(error).includes("node not found")) {
        removeFromCanvas();
        return true;
      }
      if (!wasAlreadyCompleted) completedGenerationPlaceholders.current.delete(placeholderNodeId);
      throw error;
    }
  }, [flushNodePatches, setEdges, setNodes]);

  const flushVideoGenerationInputs = useCallback(async (targetId: string) => {
    const nodeIds = new Set([targetId]);
    edgesSnapshot.current
      .filter((edge) => edge.target === targetId)
      .forEach((edge) => nodeIds.add(edge.source));
    await flushNodePatches([...nodeIds]);
  }, [flushNodePatches]);

  const executeVideoNode = useCallback(async (
    targetId: string,
    regeneration?: VideoRegenerationRequest,
    options?: VideoExecutionOptions,
  ) => {
    try {
      await flushVideoGenerationInputs(targetId);
    } catch (error) {
      reportError(error);
      setNotice("无法生成：提示词或节点参数保存失败");
      return;
    }
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
      && !options?.allowFixedSeedRepeat
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
    const snapshot = regeneration?.snapshot
      ?? options?.snapshot
      ?? generationSnapshotForGenerator(targetId);
    if (!snapshot?.prompt.trim()) {
      setNotice("无法执行：找不到已保存的提示词与素材参数");
      return;
    }
    const referenceCompilerMode = target.content.storyboardReferenceCompiler === true
      || snapshot.referenceCompilerMode === true;
    if (referenceCompilerMode) {
      if (!Number.isInteger(snapshot.durationSeconds) || snapshot.durationSeconds < 2 || snapshot.durationSeconds > 15) {
        const message = "当前分镜提示词尚未设置时长，请在生成提示词节点中填写 2–15 秒";
        changeNode(targetId, {
          content: { ...target.content, status: "invalid", validationMessage: message },
        });
        setNotice(`无法执行：${message}`);
        return;
      }
      const imageMappingCount = snapshot.referenceMappings?.filter(
        (mapping) => mapping.kind === "image",
      ).length ?? 0;
      const audioMappingCount = snapshot.referenceMappings?.filter(
        (mapping) => mapping.kind === "audio",
      ).length ?? 0;
      const videoMappingCount = snapshot.referenceMappings?.filter(
        (mapping) => mapping.kind === "video",
      ).length ?? 0;
      const referenceError = snapshot.referenceSelectionError
        || (!snapshot.referenceSelection ? "当前提示词缺少内部素材选择数据" : "")
        || (snapshot.imagePaths.length !== imageMappingCount
          ? "内部选择的图片与实际提交路径数量不一致"
          : "")
        || (snapshot.audioPaths.length !== audioMappingCount
          ? "内部选择的音频与实际提交路径数量不一致"
          : "")
        || (snapshot.videoPaths.length !== videoMappingCount
          ? "内部选择的视频与实际提交路径数量不一致"
          : "")
        || (snapshot.imagePaths.length > 9 ? "当前分镜单次最多提交 9 张图片" : "")
        || (snapshot.audioPaths.length > 2 ? "当前分镜单次最多提交 2 个音频" : "")
        || (snapshot.videoPaths.length ? "当前 H3 工作流适配器尚未配置视频参考输入" : "")
        || (!snapshot.imagePaths.length && !snapshot.audioPaths.length
          ? "当前分镜没有可提交的图片或音频参考"
          : "");
      if (referenceError) {
        changeNode(targetId, {
          content: { ...target.content, status: "invalid", validationMessage: referenceError },
        });
        setNotice(`无法执行：${referenceError}`);
        return;
      }
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
    const clientId = options?.clientId ?? crypto.randomUUID();
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
        positionOverride: options?.placeholderPosition,
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
      progressSocket = await openComfyProgressSocket(clientId, comfyUiServerUrlRef.current);
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
          serverUrl: comfyUiServerUrlRef.current,
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
          strictPromptTags: snapshot.strictPromptTags,
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
            comfyServerUrl: comfyUiServerUrlRef.current,
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
          comfyServerUrl: comfyUiServerUrlRef.current,
          lastGenerationSeed: result.seed,
          generatedSeeds,
          generationCount: (typeof latest.content.generationCount === "number"
            ? latest.content.generationCount
            : 0) + 1,
          generationDuration: snapshot.durationSeconds,
          generationPrimaryResolution: primaryVideoResolutionFromContent(latest.content),
          generationSecondaryResolution: secondaryVideoResolutionFromContent(latest.content),
          secondarySamplingEnabled: false,
        },
      });
      setNotice(result.cleanupWarning
        ? `视频生成完成，但输入缓存清理失败：${result.cleanupWarning}`
        : `视频生成完成：已创建 ${result.outputs.length} 个预览节点`);
    } catch (error) {
      const registeredClients = runningComfyClients.current.get(targetId);
      const remainingTaskCount = registeredClients
        ? Math.max(0, registeredClients.size - (registeredClients.has(clientId) ? 1 : 0))
        : 0;
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
  }, [changeNode, completeGenerationPlaceholder, createGenerationPlaceholder, finalizeGenerationPlaceholder, flushVideoGenerationInputs, forgetComfyTask, generatedPreviewHeightForAspectRatio, generationSnapshotForGenerator, h3DiffusionModelCatalogLoaded, h3DiffusionModelOptions, h3LoraCatalogLoaded, h3LoraOptions, registerComfyTask, rememberComfyTask, reportError, setEdges, setNodes, unregisterComfyTask, updateGenerationPlaceholder, workflowModuleDefaults, workflowModules]);

  const executeVideoNodeBatch = useCallback(async (targetId: string) => {
    const targetNode = nodesSnapshot.current.find((node) => node.id === targetId);
    if (!targetNode || targetNode.data.record.kind !== "video-generation") {
      setNotice("无法批量提交：找不到视频生成节点");
      return;
    }
    const target = recordAtCurrentFlowPosition(targetNode);
    if (target.content.status === "cancelling") {
      setNotice("当前任务正在取消，请稍后再批量提交");
      return;
    }
    const recordsById = new Map(
      nodesSnapshot.current.map((node) => [node.id, node.data.record]),
    );
    const connectedTextInputs = edgesSnapshot.current
      .filter((edge) => edge.target === targetId)
      .map((edge) => recordsById.get(edge.source))
      .filter((record): record is NodeRecord => record?.kind === "text");
    const orderedTextInputs = orderedNodeRecordsFromContent(
      target.content,
      "textInputOrder",
      connectedTextInputs,
    );
    if (orderedTextInputs.length < 2) {
      setNotice("批量提交至少需要接入两个文字提示词");
      return;
    }

    const snapshots = orderedTextInputs.map(
      (input) => generationSnapshotForGenerator(targetId, input.id),
    );
    const invalidSnapshotIndex = snapshots.findIndex((snapshot) => !snapshot?.prompt.trim());
    if (invalidSnapshotIndex >= 0) {
      const message = `第 ${invalidSnapshotIndex + 1} 个文字提示词内容为空，无法批量提交`;
      changeNode(targetId, {
        content: { ...target.content, status: "invalid", validationMessage: message },
      });
      setNotice(message);
      return;
    }
    const invalidDurationIndex = snapshots.findIndex((snapshot) => (
      snapshot?.referenceCompilerMode === true
      && (!Number.isInteger(snapshot.durationSeconds) || snapshot.durationSeconds < 2 || snapshot.durationSeconds > 15)
    ));
    if (invalidDurationIndex >= 0) {
      const message = `第 ${invalidDurationIndex + 1} 个分镜尚未设置时长，请在生成提示词节点中填写 2–15 秒`;
      changeNode(targetId, {
        content: { ...target.content, status: "invalid", validationMessage: message },
      });
      setNotice(message);
      return;
    }
    const invalidReferenceIndex = snapshots.findIndex((snapshot) => (
      snapshot?.referenceCompilerMode === true
      && Boolean(snapshot.referenceSelectionError || !snapshot.referenceSelection)
    ));
    if (invalidReferenceIndex >= 0) {
      const invalidSnapshot = snapshots[invalidReferenceIndex];
      const detail = invalidSnapshot?.referenceSelectionError
        || "缺少内部素材选择数据";
      const message = `第 ${invalidReferenceIndex + 1} 个分镜不可执行：${detail}`;
      changeNode(targetId, {
        content: { ...target.content, status: "invalid", validationMessage: message },
      });
      setNotice(message);
      return;
    }
    const validSnapshots = snapshots.filter(
      (snapshot): snapshot is GenerationSnapshot => Boolean(snapshot),
    );
    const firstSnapshot = validSnapshots[0];
    if (!firstSnapshot) {
      setNotice("无法批量提交：没有可用的提示词快照");
      return;
    }

    const firstPreviewWidth = generatedVideoPreviewWidthForRatio(
      videoAspectRatioValue(firstSnapshot.aspectRatio),
    );
    const firstPreviewHeight = generatedPreviewHeightForAspectRatio(firstSnapshot.aspectRatio);
    const placementRecords = [
      ...nodesSnapshot.current.map(recordAtCurrentFlowPosition),
      ...incomingPlacementReservations.current,
    ];
    const firstPosition = generatedPreviewPosition(
      target,
      placementRecords,
      firstPreviewWidth,
      firstPreviewHeight,
    );
    let nextX = firstPosition.x;
    const batchItems = validSnapshots.map((snapshot) => {
      const placeholderPosition = { x: nextX, y: firstPosition.y };
      const previewWidth = generatedVideoPreviewWidthForRatio(
        videoAspectRatioValue(snapshot.aspectRatio),
      );
      nextX += batchGenerationPreviewStep(previewWidth);
      return { clientId: crypto.randomUUID(), snapshot, placeholderPosition };
    });
    changeNode(targetId, {
      content: {
        ...target.content,
        status: "running",
        executionProgress: null,
        validationMessage: `正在批量提交 ${batchItems.length} 个生成任务…`,
      },
    });
    setNotice(`正在按文本顺序批量提交 ${batchItems.length} 个生成任务`);
    const tasks: Promise<void>[] = [];
    for (const [index, item] of batchItems.entries()) {
      let taskSettled = false;
      const task = executeVideoNode(targetId, undefined, {
        clientId: item.clientId,
        snapshot: item.snapshot,
        placeholderPosition: item.placeholderPosition,
        allowFixedSeedRepeat: true,
      });
      tasks.push(task);
      void task.then(
        () => { taskSettled = true; },
        () => { taskSettled = true; },
      );

      let submissionObserved = false;
      for (let attempt = 0; attempt < 240 && !taskSettled; attempt += 1) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
        try {
          const [status] = await invoke<ComfyClientTaskStatus[]>(
            "get_comfyui_client_task_statuses",
            { serverUrl: comfyUiServerUrlRef.current, clientIds: [item.clientId] },
          );
          if (status && status.status !== "missing") {
            submissionObserved = true;
            break;
          }
        } catch {
          // Keep waiting; falling back to completion preserves queue order if status checks fail.
        }
      }
      if (!submissionObserved && !taskSettled) await task;
      if (index + 1 < batchItems.length) {
        setNotice(`已按顺序提交 ${index + 1}/${batchItems.length}，正在准备下一项`);
      }
    }
    setNotice(`已按文本顺序发起 ${batchItems.length} 个生成任务`);
    void Promise.allSettled(tasks);
  }, [changeNode, executeVideoNode, generatedPreviewHeightForAspectRatio, generationSnapshotForGenerator]);

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
    const currentGeneratorSnapshot = generationSnapshotForGenerator(
      sourceGeneratorId,
      snapshot.promptNodeId,
      {
        prompt: snapshot.prompt,
        information: snapshot.promptInformation,
        referenceSelection: snapshot.referenceSelection ?? null,
        durationSeconds: snapshot.durationSeconds,
      },
    );
    const snapshotWithCurrentMedia = currentGeneratorSnapshot
      ? {
          ...snapshot,
          imagePaths: currentGeneratorSnapshot.imagePaths,
          imageRoles: currentGeneratorSnapshot.imageRoles,
          audioPaths: currentGeneratorSnapshot.audioPaths,
          videoPaths: currentGeneratorSnapshot.videoPaths,
          referenceCompilerMode: currentGeneratorSnapshot.referenceCompilerMode,
          referenceSelection: currentGeneratorSnapshot.referenceSelection,
          referenceSelectionError: currentGeneratorSnapshot.referenceSelectionError,
          referenceMappings: currentGeneratorSnapshot.referenceMappings,
          referenceCandidateCount: currentGeneratorSnapshot.referenceCandidateCount,
        }
      : snapshot;

    let seed = seedOverride;
    if (!seed) {
      const excludedSeeds = new Set([
        ...generatedSeedsFromContent(sourceGenerator.content),
        typeof sourcePreview.content.seed === "string" ? sourcePreview.content.seed : "",
      ]);
      seed = randomFixedSeed();
      while (excludedSeeds.has(seed)) seed = randomFixedSeed();
    }
    await executeVideoNode(sourceGeneratorId, {
      sourcePreview,
      snapshot: snapshotWithCurrentMedia,
      seed,
    });
  }, [executeVideoNode, generationSnapshotForGenerator]);

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
    const snapshotPromptOption: VideoRegenerationPromptOption = {
      key: "snapshot",
      label: `${snapshot.promptVersionLabel ? `${snapshot.promptVersionLabel} · ` : ""}${snapshot.promptNodeTitle || "生成时提示词"}（历史快照）`,
      prompt: snapshot.prompt,
      information: snapshot.promptInformation,
      referenceSelection: snapshot.referenceSelection ?? null,
      promptNodeId: snapshot.promptNodeId,
      promptNodeTitle: snapshot.promptNodeTitle,
      promptNodeIdSource: snapshot.promptNodeIdSource,
      promptVersionId: snapshot.promptVersionId,
      promptVersionLabel: snapshot.promptVersionLabel,
    };
    const allTextNodes = nodesSnapshot.current.filter(
      (node) => node.data.record.kind === "text",
    );
    const sourceGeneratorId = typeof preview.content.sourceGeneratorId === "string"
      ? preview.content.sourceGeneratorId
      : "";
    const connectedPromptNodeIds = new Set(
      edgesSnapshot.current
        .filter((edge) => edge.target === sourceGeneratorId)
        .map((edge) => edge.source),
    );
    const connectedTextNodes = allTextNodes.filter((node) => connectedPromptNodeIds.has(node.id));
    const nodeMatchesSnapshot = (node: CanvasFlowNode) => {
      const record = node.data.record;
      const versions = promptVersionsFromContent(record.content);
      if (snapshot.promptVersionId && versions.some((version) => version.id === snapshot.promptVersionId)) {
        return true;
      }
      return versions.some((version) => version.text === snapshot.prompt)
        || textFromContent(record.content) === snapshot.prompt;
    };
    let promptNode = snapshot.promptNodeId
      ? allTextNodes.find((node) => node.id === snapshot.promptNodeId)
      : undefined;
    if (!promptNode) {
      const connectedMatches = connectedTextNodes.filter(nodeMatchesSnapshot);
      promptNode = connectedMatches.length === 1
        ? connectedMatches[0]
        : connectedTextNodes.length === 1
          ? connectedTextNodes[0]
          : undefined;
    }
    if (!promptNode) {
      const globalMatches = allTextNodes.filter(nodeMatchesSnapshot);
      if (globalMatches.length === 1) promptNode = globalMatches[0];
    }

    let promptOptions: VideoRegenerationPromptOption[] = [snapshotPromptOption];
    let selectedPromptKey = snapshotPromptOption.key;
    if (promptNode && isContentIterationContent(promptNode.data.record.content)) {
      const promptRecord = promptNode.data.record;
      const versions = promptVersionsFromContent(promptRecord.content);
      const usedVersion = versions.find((version) => (
        Boolean(snapshot.promptVersionId) && version.id === snapshot.promptVersionId
      )) ?? versions.find((version) => (
        Boolean(snapshot.promptVersionLabel)
        && version.label === snapshot.promptVersionLabel
        && version.text === snapshot.prompt
      )) ?? versions.find((version) => version.text === snapshot.prompt);
      promptOptions = [...versions].reverse().map((version) => {
        const isUsedVersion = version.id === usedVersion?.id;
        return {
          key: `version:${version.id}`,
          label: `${version.label} · ${isUsedVersion
            ? snapshot.promptNodeTitle || version.title || promptRecord.title
            : version.title || promptRecord.title}${isUsedVersion ? "（当前视频）" : ""}`,
          prompt: isUsedVersion ? snapshot.prompt : version.text,
          information: isUsedVersion ? snapshot.promptInformation : version.information,
          referenceSelection: isUsedVersion
            ? snapshot.referenceSelection ?? null
            : version.referenceSelection ?? null,
          promptNodeId: promptRecord.id,
          promptNodeTitle: isUsedVersion
            ? snapshot.promptNodeTitle || version.title || promptRecord.title
            : version.title || promptRecord.title,
          promptNodeIdSource: "captured" as const,
          promptVersionId: version.id,
          promptVersionLabel: version.label,
        };
      });
      if (usedVersion) {
        selectedPromptKey = `version:${usedVersion.id}`;
      } else {
        promptOptions.unshift({
          ...snapshotPromptOption,
          promptNodeId: promptRecord.id,
          promptNodeIdSource: "verified",
        });
      }
    } else if (promptNode) {
      const promptRecord = promptNode.data.record;
      const currentTextOption: VideoRegenerationPromptOption = {
        key: `text:${promptRecord.id}`,
        label: promptRecord.title || "提示词",
        prompt: textFromContent(promptRecord.content),
        information: informationFromContent(promptRecord.content),
        referenceSelection: referenceSelectionFromContent(promptRecord.content),
        promptNodeId: promptRecord.id,
        promptNodeTitle: promptRecord.title,
        promptNodeIdSource: "captured",
        promptVersionId: "",
        promptVersionLabel: "",
      };
      if (currentTextOption.prompt === snapshot.prompt) {
        promptOptions = [{
          ...currentTextOption,
          prompt: snapshot.prompt,
          information: snapshot.promptInformation,
          referenceSelection: snapshot.referenceSelection ?? null,
          label: `${currentTextOption.label}（当前视频）`,
        }];
        selectedPromptKey = currentTextOption.key;
      } else {
        promptOptions.push(currentTextOption);
      }
    }
    setVideoRegenerationInformationOpen(false);
    setVideoRegenerationDraft({
      previewId,
      previewTitle: preview.title || "视频预览",
      originalSnapshot: snapshot,
      promptOptions,
      selectedPromptKey,
      seed,
      durationSeconds: snapshot.durationSeconds,
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
    const selectedPrompt = draft.promptOptions.find((option) => option.key === draft.selectedPromptKey);
    if (!selectedPrompt || !selectedPrompt.prompt.trim()) {
      setNotice("请选择包含正文的提示词版本");
      return;
    }
    if (!Number.isInteger(draft.durationSeconds) || draft.durationSeconds < 2 || draft.durationSeconds > 15) {
      setNotice("时长必须是 2 到 15 秒之间的整数");
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
      prompt: selectedPrompt.prompt,
      promptInformation: selectedPrompt.information,
      promptNodeId: selectedPrompt.promptNodeId,
      promptNodeTitle: selectedPrompt.promptNodeTitle,
      promptNodeIdSource: selectedPrompt.promptNodeIdSource,
      promptVersionId: selectedPrompt.promptVersionId,
      promptVersionLabel: selectedPrompt.promptVersionLabel,
      referenceSelection: selectedPrompt.referenceSelection,
      durationSeconds: draft.durationSeconds,
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
      progressSocket = await openComfyProgressSocket(clientId, comfyUiServerUrlRef.current);
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
          serverUrl: comfyUiServerUrlRef.current,
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
          strictPromptTags: snapshot.strictPromptTags,
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
          comfyServerUrl: comfyUiServerUrlRef.current,
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
        serverUrl: comfyUiServerUrlRef.current,
        clientId,
      });
      forgetComfyTask(clientId);
      unregisterComfyTask(targetId, clientId);
      if (!ownedComfyClients.current.has(clientId)) {
        cancelledComfyClients.current.delete(clientId);
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
      const cancellationWarnings: string[] = [];
      if (cleanupWarning) cancellationWarnings.push(`输入缓存清理失败：${cleanupWarning}`);
      try {
        await removeGenerationPlaceholder(persistedTask?.placeholderNodeId);
      } catch (placeholderError) {
        const placeholderMessage = placeholderError instanceof Error
          ? placeholderError.message
          : String(placeholderError);
        cancellationWarnings.push(`占位框移除失败：${placeholderMessage}`);
        updateGenerationPlaceholder(persistedTask?.placeholderNodeId, {
          status: "cancelled",
          executionProgress: null,
          validationMessage: `已取消 ComfyUI ${taskLabel}`,
        });
      }
      setNotice(cancellationWarnings.length
        ? `${taskLabel}已取消，但${cancellationWarnings.join("；")}`
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
  }, [changeNode, forgetComfyTask, removeGenerationPlaceholder, reportError, unregisterComfyTask, updateGenerationPlaceholder]);

  const disconnectEdge = useCallback(async (
    edgeId: string,
    successMessage = "连线已断开",
  ) => {
    const inputEdge = edgesSnapshot.current.find((edge) => edge.id === edgeId);
    if (!inputEdge) {
      setNotice("该连线已经断开");
      return;
    }
    if (protectedGenerationEdgeIds.has(inputEdge.id)) {
      setNotice("视频生成节点与其输出视频之间的来源连线不可移除");
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
  }, [changeNode, protectedGenerationEdgeIds, reportError, setEdges]);

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
      .filter((edge) => {
        if (copiedVideoIds.has(edge.target)) return true;
        const kind = (edge.data as CanvasEdgeData | undefined)?.record?.kind;
        return copiedIds.has(edge.target)
          && (kind === "content-derivation" || kind === "scene-branch");
      })
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
      sourceCanvasId: copiedNodes[0].canvasId,
      pasteCount: 0,
    };
    setNotice(
      copiedNodes.length === 1
        ? `已复制节点“${copiedNodes[0].title || "未命名节点"}”`
        : `已复制 ${copiedNodes.length} 个节点`,
    );
  }, []);

  const resizeImageNode = useCallback(async (nodeId: string, maxEdge: number) => {
    const sourceNode = nodesSnapshot.current.find((node) => node.id === nodeId);
    const source = sourceNode ? recordAtCurrentFlowPosition(sourceNode) : null;
    if (!source || source.kind !== "image") {
      throw new Error("找不到需要 Resize 的原图片节点");
    }
    const currentProjectId = activeProjectIdRef.current;
    if (!currentProjectId || source.canvasId !== currentProjectId) {
      throw new Error("原图片不在当前项目中");
    }
    const sourcePath = typeof source.content.assetPath === "string"
      ? source.content.assetPath.trim()
      : "";
    if (!sourcePath) throw new Error("原图片文件路径为空");
    const originalName = typeof source.content.originalName === "string"
      ? source.content.originalName
      : source.title;
    const position = {
      x: snapCanvasCoordinate(source.x + source.width + CANVAS_GRID_SIZE * 2),
      y: snapCanvasCoordinate(source.y),
    };

    try {
      const result = await invoke<ResizeImageResult>("resize_image", {
        sourceNodeId: source.id,
        sourcePath,
        originalName,
        canvasId: currentProjectId,
        maxEdge,
        x: position.x,
        y: position.y,
        width: source.width,
        height: source.height,
      });
      const resizedNode = makeFlowNodeRef.current?.(result.node);
      if (!resizedNode) throw new Error("Resize 图片节点尚未初始化");
      setNodes((current) => [...current, resizedNode]);
      setEdges((current) => [...current, toFlowEdge(result.edge)]);
      const resizedWidth = Number(result.node.content.naturalWidth);
      const resizedHeight = Number(result.node.content.naturalHeight);
      setNotice(
        Number.isFinite(resizedWidth) && Number.isFinite(resizedHeight)
          ? `Resize 完成：${resizedWidth} × ${resizedHeight}`
          : "Resize 图片已生成并连接到原图",
      );
    } catch (error) {
      reportError(error);
      throw error;
    }
  }, [reportError, setEdges, setNodes]);

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
        relationPromptVersionLabel: "",
        activeTaskCount: activeComfyTaskCounts[record.id] ?? 0,
        inputCount: 0,
        outputCount: 0,
        contentParents: [],
        mediaInputs: [],
        textInputCount: 0,
        textInputs: [],
        promptNodeTitle: "",
        h3LoraOptions,
        workflowModules,
        workflowModuleDefaults,
        onH3LoraPreferenceChange: rememberH3LoraPreference,
        onChange: changeNode,
        onSaveNode: saveTextNodeImmediately,
        onMarkGeneratedVideoFullyPlayed: markGeneratedVideoFullyPlayed,
        onExecutionCheck: reportExecutionCheck,
        onExecute: executeVideoNode,
        onBatchExecute: executeVideoNodeBatch,
        onSecondarySample: executeSecondarySample,
        onConfigureSecondarySample: configureSecondarySample,
        onRegenerateVideo: regenerateGeneratedVideo,
        onConfigureRegenerateVideo: configureGeneratedVideoRegeneration,
        onLocatePrompt: locateGeneratedVideoPrompt,
        onCancelExecution: cancelVideoExecution,
        onRevealGeneratedVideo: revealGeneratedVideo,
        onRemoveInput: removeInputFromVideoNode,
        onActivateTextInput: activateTextInput,
        onDeletePromptVersion: deletePromptVersionFromNode,
        onResizeImage: resizeImageNode,
        onOpenFolder: (nodeId: string) => openFolderRef.current(nodeId),
        onCopy: copyText,
      },
    }),
    [activeComfyTaskCounts, activateTextInput, cancelVideoExecution, changeNode, configureGeneratedVideoRegeneration, configureSecondarySample, copyText, deleteNode, deletePromptVersionFromNode, executeSecondarySample, executeVideoNode, executeVideoNodeBatch, h3LoraOptions, locateGeneratedVideoPrompt, markGeneratedVideoFullyPlayed, regenerateGeneratedVideo, rememberH3LoraPreference, removeInputFromVideoNode, reportExecutionCheck, resizeImageNode, revealGeneratedVideo, saveTextNodeImmediately, workflowModuleDefaults, workflowModules],
  );
  makeFlowNodeRef.current = makeFlowNode;

  const scheduleContentGraphReconciliation = useCallback((canvasId: string) => {
    const sequence = ++contentGraphSyncSequence.current;
    if (contentGraphSyncTimer.current) {
      window.clearTimeout(contentGraphSyncTimer.current);
    }

    const reconcile = async () => {
      if (sequence !== contentGraphSyncSequence.current || activeProjectIdRef.current !== canvasId) return;
      const hasPendingActiveCanvasPatches = [...pendingPatches.current.keys()].some((nodeId) => (
        nodesSnapshot.current.find((node) => node.id === nodeId)?.data.record.canvasId === canvasId
      ));
      if (hasPendingActiveCanvasPatches) {
        contentGraphSyncTimer.current = window.setTimeout(() => void reconcile(), 220);
        return;
      }

      try {
        const snapshot = await invoke<WorkspaceSnapshot>("inspect_workspace", { canvasId });
        if (
          sequence !== contentGraphSyncSequence.current
          || activeProjectIdRef.current !== canvasId
          || [...pendingPatches.current.keys()].some((nodeId) => (
            nodesSnapshot.current.find((node) => node.id === nodeId)?.data.record.canvasId === canvasId
          ))
        ) return;

        setProjects((current) => current.map((project) => (
          project.canvas.id === canvasId ? snapshot : project
        )));
        setNodes((current) => {
          const selectedNodeIds = new Set(current.filter((node) => node.selected).map((node) => node.id));
          return snapshot.nodes.map((record) => ({
            ...makeFlowNode(record),
            selected: selectedNodeIds.has(record.id),
          }));
        });
        setEdges(snapshot.edges.map(toFlowEdge));
      } catch (error) {
        reportError(error);
      }
    };

    contentGraphSyncTimer.current = window.setTimeout(() => void reconcile(), 260);
  }, [makeFlowNode, reportError, setEdges, setNodes]);

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
          comfyServerUrl: comfyUiServerUrlRef.current,
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
      comfyServerUrl: comfyUiServerUrlRef.current,
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
      void openComfyProgressSocket(task.clientId, comfyUiServerUrlRef.current).then((socket) => {
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
            { serverUrl: comfyUiServerUrlRef.current, clientIds: tasks.map((task) => task.clientId) },
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

  const pasteCopiedNodes = useCallback(async (placeAtViewportCenter = true) => {
    const clipboard = nodeClipboard.current;
    if (!activeProjectId || !clipboard?.nodes.length) return;

    const pasteOffset = CANVAS_GRID_SIZE * 2 * (clipboard.pasteCount + 1);
    const sourceLeft = Math.min(...clipboard.nodes.map((node) => node.x));
    const sourceTop = Math.min(...clipboard.nodes.map((node) => node.y));
    const sourceRight = Math.max(...clipboard.nodes.map((node) => node.x + node.width));
    const sourceBottom = Math.max(...clipboard.nodes.map((node) => node.y + node.height));
    const sourceOffsetPosition = { x: sourceLeft + pasteOffset, y: sourceTop + pasteOffset };
    const placement = placeAtViewportCenter
      ? reserveNodePlacement(
          activeProjectId,
          undefined,
          sourceRight - sourceLeft,
          sourceBottom - sourceTop,
        )
      : null;
    const targetPosition = placement?.position ?? sourceOffsetPosition;
    const placementDelta = {
      x: targetPosition.x - sourceLeft,
      y: targetPosition.y - sourceTop,
    };
    const createdByOriginalId = new Map<string, NodeRecord>();
    const createdNodes: CanvasFlowNode[] = [];
    const versionIdMap = new Map<string, string>();
    clipboard.nodes.forEach((sourceNode) => {
      promptVersionsFromContent(sourceNode.content).forEach((version) => {
        versionIdMap.set(version.id, crypto.randomUUID());
      });
    });
    const preparedContentByOriginalId = new Map<string, JsonObject>();
    clipboard.nodes.forEach((sourceNode) => {
      const sourceContent = sourceNode.kind === "video-generation"
        ? copiedVideoGenerationContent(sourceNode.content)
        : structuredClone(sourceNode.content);
      preparedContentByOriginalId.set(
        sourceNode.id,
        copiedPromptVersionContent(sourceContent, versionIdMap),
      );
    });
    const existingVideoGenerationTitles = new Set(
      nodesSnapshot.current
        .filter((node) => node.data.record.canvasId === activeProjectId && node.data.record.kind === "video-generation")
        .map((node) => node.data.record.title.replace(/\s+/g, "")),
    );
    const copiedNodeTitle = (sourceNode: NodeRecord) => {
      if (sourceNode.kind !== "video-generation") {
        return `${sourceNode.title || "未命名节点"} 副本`;
      }
      let baseTitle = (sourceNode.title || "视频生成").trim();
      while (/副本\s*\d*$/u.test(baseTitle)) {
        baseTitle = baseTitle.replace(/\s*副本\s*\d*$/u, "").trim();
      }
      baseTitle ||= "视频生成";
      let copyNumber = 1;
      let nextTitle = `${baseTitle} 副本${copyNumber}`;
      while (existingVideoGenerationTitles.has(nextTitle.replace(/\s+/g, ""))) {
        copyNumber += 1;
        nextTitle = `${baseTitle} 副本${copyNumber}`;
      }
      existingVideoGenerationTitles.add(nextTitle.replace(/\s+/g, ""));
      return nextTitle;
    };
    try {
      for (const sourceNode of clipboard.nodes) {
        const result = await invoke<CreateNodeResult>("create_node", {
          input: {
            canvasId: activeProjectId,
            kind: sourceNode.kind,
            title: copiedNodeTitle(sourceNode),
            content: preparedContentByOriginalId.get(sourceNode.id) ?? {},
            source: "clipboard",
            x: snapCanvasCoordinate(sourceNode.x + placementDelta.x),
            y: snapCanvasCoordinate(sourceNode.y + placementDelta.y),
            width: sourceNode.width,
            height: sourceNode.height,
          },
        });
        createdByOriginalId.set(sourceNode.id, result.node);
      }

      for (const sourceNode of clipboard.nodes) {
        const createdNode = createdByOriginalId.get(sourceNode.id);
        if (!createdNode) continue;
        const remappedContent = copiedNodeContentForProject(
          preparedContentByOriginalId.get(sourceNode.id) ?? {},
          clipboard.sourceCanvasId,
          activeProjectId,
          new Map([...createdByOriginalId].map(([originalId, node]) => [originalId, node.id])),
          versionIdMap,
        );
        const updatedNode = await invoke<NodeRecord>("update_node", {
          input: { id: createdNode.id, content: remappedContent },
        });
        createdByOriginalId.set(sourceNode.id, updatedNode);
        createdNodes.push({ ...makeFlowNode(updatedNode), selected: true });
      }

      const createdEdges: Edge[] = [];
      let missingLinks = 0;
      for (const copiedEdge of clipboard.videoInputEdges) {
        const pastedTarget = createdByOriginalId.get(copiedEdge.targetId);
        const pastedSource = createdByOriginalId.get(copiedEdge.sourceId);
        const sourceNodeId = pastedSource?.id ?? (
          clipboard.sourceCanvasId === activeProjectId
            && nodesSnapshot.current.some((node) => node.id === copiedEdge.sourceId)
            ? copiedEdge.sourceId
            : ""
        );
        if (!pastedTarget || !sourceNodeId) {
          missingLinks += 1;
          continue;
        }
        try {
          const edgeRecord = await invoke<EdgeRecord>("create_edge", {
            input: {
              canvasId: activeProjectId,
              sourceNodeId,
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

      if (placement) {
        finishNodePlacementReservation(
          placement.reservationId,
          [...createdByOriginalId.values()],
        );
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
      if (placement) finishNodePlacementReservation(placement.reservationId);
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
        void pasteCopiedNodes(false);
      } else if (key === "v" && nodeClipboard.current) {
        event.preventDefault();
        void pasteCopiedNodes();
      }
    };

    window.addEventListener("keydown", handleNodeClipboardShortcut);
    return () => window.removeEventListener("keydown", handleNodeClipboardShortcut);
  }, [copyNodesToClipboard, pasteCopiedNodes]);

  const undoLastCanvasAction = useCallback(async () => {
    const entry = undoStack.current.pop();
    if (!entry) {
      setNotice("没有可撤销的操作");
      return;
    }
    try {
      if (entry.kind === "folder-delete") {
        const restored = await invoke<WorkspaceSnapshot>("undo_delete_folder_tree", {
          input: { deletion: entry.deletion },
        });
        setNodes(restored.nodes.map((record) => makeFlowNode(record)));
        setEdges(restored.edges.map(toFlowEdge));
        setCanvasName(restored.canvas.name);
        setCanvasPath((current) => current.map((canvas, index) => (
          index === current.length - 1 ? restored.canvas : canvas
        )));
        setNotice("已撤销删除目录，目录及全部内容已恢复");
        return;
      }

      if (entry.kind === "folder-cancel") {
        await flushNodePatches(entry.cancellation.source.nodes.map((node) => node.id));
        const restored = await invoke<WorkspaceSnapshot>("undo_cancel_folder", {
          input: { cancellation: entry.cancellation },
        });
        setNodes(restored.nodes.map((record) => makeFlowNode(record)));
        setEdges(restored.edges.map(toFlowEdge));
        setCanvasName(restored.canvas.name);
        setCanvasPath((current) => current.map((canvas, index) => (
          index === current.length - 1 ? restored.canvas : canvas
        )));
        setNotice("已撤销取消目录，目录结构已恢复");
        return;
      }

      if (entry.kind === "folder-merge") {
        await flushNodePatches(entry.merge.sources.flatMap((source) => (
          source.nodes.map((node) => node.id)
        )));
        const restored = await invoke<WorkspaceSnapshot>("undo_folder_merge", {
          input: { merge: entry.merge },
        });
        activeProjectIdRef.current = restored.canvas.id;
        setActiveProjectId(restored.canvas.id);
        setCanvasBackground(validCanvasColor(
          window.localStorage.getItem(`infinite-canvas:canvas-background:${restored.canvas.id}`),
        ));
        setNodes(restored.nodes.map((record) => makeFlowNode(record)));
        setEdges(restored.edges.map(toFlowEdge));
        setCanvasName(restored.canvas.name);
        setProjectNameDraft(restored.canvas.name);
        setEditingProjectName(false);
        setCanvasPath((current) => {
          const restoredIndex = current.findIndex((canvas) => canvas.id === restored.canvas.id);
          return restoredIndex >= 0
            ? [...current.slice(0, restoredIndex), restored.canvas]
            : [restored.canvas];
        });
        setSearch("");
        setRelationAnchorId(null);
        setNotice(`已撤销目录合并，恢复 ${entry.merge.sources.length} 个目录`);
        return;
      }

      if (entry.kind === "folder-group") {
        await flushNodePatches([
          ...entry.grouping.nodes.map((node) => node.id),
          ...entry.grouping.duplicatedInputNodes.map((node) => node.duplicateNodeId),
        ]);
        const restored = await invoke<WorkspaceSnapshot>("undo_folder_grouping", {
          input: { grouping: entry.grouping },
        });
        activeProjectIdRef.current = restored.canvas.id;
        setActiveProjectId(restored.canvas.id);
        setCanvasBackground(validCanvasColor(
          window.localStorage.getItem(`infinite-canvas:canvas-background:${restored.canvas.id}`),
        ));
        setNodes(restored.nodes.map((record) => makeFlowNode(record)));
        setEdges(restored.edges.map(toFlowEdge));
        setCanvasName(restored.canvas.name);
        setProjectNameDraft(restored.canvas.name);
        setEditingProjectName(false);
        setCanvasPath((current) => {
          const restoredIndex = current.findIndex((canvas) => canvas.id === restored.canvas.id);
          return restoredIndex >= 0
            ? [...current.slice(0, restoredIndex), restored.canvas]
            : [restored.canvas];
        });
        setSearch("");
        setRelationAnchorId(null);
        const discardedCopies = entry.grouping.duplicatedInputNodes.length;
        setNotice(
          `已撤销归入目录，恢复 ${entry.grouping.nodes.length} 个原节点${discardedCopies ? `，并移除 ${discardedCopies} 个目录内共享输入副本` : ""}`,
        );
        return;
      }

      if (entry.kind === "prompt-version-delete") {
        await flushNodePatches([entry.previousNode.id]);
        const restoredNode = await invoke<NodeRecord>("update_node", {
          input: {
            id: entry.previousNode.id,
            title: entry.previousNode.title,
            content: entry.previousNode.content,
            status: entry.previousNode.status,
          },
        });
        replaceNodeRecord(restoredNode);
        setNotice("已恢复删除的提示词历史版本");
        return;
      }

      const restored = entry.kind === "prompt-migration"
        ? await invoke<RestoreNodeReplacementResult>("restore_node_replacement", {
            input: {
              previousNode: entry.previousNode,
              deleted: entry.deleted,
            },
          })
        : {
            node: null,
            restored: await invoke<DeletedBatch>("restore_deleted_nodes", { batch: entry.batch }),
          };
      setNodes((current) => {
        const restoredTarget = restored.node;
        const withTarget = restoredTarget
          ? current.map((node) => (
              node.id === restoredTarget.id
                ? {
                    ...node,
                    width: restoredTarget.width,
                    height: restoredTarget.height,
                    position: { x: restoredTarget.x, y: restoredTarget.y },
                    style: {
                      ...node.style,
                      width: restoredTarget.width,
                      height: restoredTarget.height,
                    },
                    data: { ...node.data, record: restoredTarget },
                  }
                : node
            ))
          : current;
        const currentIds = new Set(withTarget.map((node) => node.id));
        return [
          ...withTarget,
          ...restored.restored.nodes
            .filter((record) => !currentIds.has(record.id))
            .map((record) => makeFlowNode(record)),
        ];
      });
      setEdges((current) => {
        const currentIds = new Set(current.map((edge) => edge.id));
        return [
          ...current,
          ...restored.restored.edges
            .filter((record) => !currentIds.has(record.id))
            .map(toFlowEdge),
        ];
      });
      setNotice(entry.kind === "prompt-migration"
        ? "已撤销接入，恢复文本节点及内容迭代节点"
        : `已撤销删除，恢复 ${restored.restored.nodes.length} 个节点`);
    } catch (error) {
      undoStack.current.push(entry);
      reportError(error);
    }
  }, [flushNodePatches, makeFlowNode, replaceNodeRecord, reportError, setEdges, setNodes]);

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
      void undoLastCanvasAction();
    };
    window.addEventListener("keydown", handleUndoShortcut);
    return () => window.removeEventListener("keydown", handleUndoShortcut);
  }, [undoLastCanvasAction]);

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
    async (
      projectId: string,
      ancestors: CanvasRecord[] = [],
      preserveFolderUndo = false,
    ) => {
      try {
        await flushPendingPatches();
        setNotice("正在打开项目…");
        const snapshot = await invoke<WorkspaceSnapshot>("load_workspace", {
          canvasId: projectId,
        });
        const savedBackground = validCanvasColor(
          window.localStorage.getItem(`infinite-canvas:canvas-background:${projectId}`),
        );
        if (preserveFolderUndo) {
          const navigationCanvasIds = new Set([
            ...ancestors.map((canvas) => canvas.id),
            projectId,
          ]);
          undoStack.current = undoStack.current.filter((entry) => {
            if (entry.kind === "folder-group") {
              return navigationCanvasIds.has(entry.grouping.parentCanvasId);
            }
            if (entry.kind === "folder-merge") {
              return navigationCanvasIds.has(entry.merge.parentCanvasId);
            }
            return false;
          });
        } else {
          undoStack.current = [];
        }
        activeProjectIdRef.current = projectId;
        setActiveProjectId(projectId);
        setCanvasBackground(savedBackground);
        setCanvasName(snapshot.canvas.name);
        setCanvasPath([...ancestors, snapshot.canvas]);
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
    [fitView, flushPendingPatches, makeFlowNode, reportError, setEdges, setNodes],
  );

  const openFolder = useCallback((nodeId: string) => {
    const folderNode = nodesSnapshot.current.find((node) => node.id === nodeId)?.data.record;
    const childCanvasId = folderNode && typeof folderNode.content.childCanvasId === "string"
      ? folderNode.content.childCanvasId
      : "";
    if (!folderNode || folderNode.kind !== "folder" || !childCanvasId) {
      setNotice("这个目录没有可打开的子画布");
      return;
    }
    void openProject(childCanvasId, canvasPath, true);
  }, [canvasPath, openProject]);
  openFolderRef.current = openFolder;

  const navigateToCanvasPath = useCallback((index: number) => {
    const target = canvasPath[index];
    if (!target) return;
    void openProject(target.id, canvasPath.slice(0, index), true);
  }, [canvasPath, openProject]);

  const returnToProjects = useCallback(async () => {
    try {
      await flushPendingPatches();
      const snapshots = await invoke<WorkspaceSnapshot[]>("list_projects");
      undoStack.current = [];
      try {
        await invoke<number>("cleanup_resize_images");
      } catch (cleanupError) {
        console.error("Resize 临时文件清理失败", cleanupError);
      }
      setProjects(snapshots);
      activeProjectIdRef.current = null;
      setActiveProjectId(null);
      setCanvasPath([]);
      setRelationAnchorId(null);
      setCanvasBackground(null);
      setNodes([]);
      setEdges([]);
      setDropActive(false);
    } catch (error) {
      reportError(error);
    }
  }, [flushPendingPatches, reportError, setEdges, setNodes]);

  const togglePrivateProjectVisibility = useCallback(() => {
    if (showPrivateProjects) {
      const activeProjectIsPrivate = activeProjectId !== null
        && projects.some((project) => (
          project.canvas.id === activeProjectId && project.canvas.isPrivate
        ));
      setShowPrivateProjects(false);
      if (activeProjectIsPrivate) void returnToProjects();
      return;
    }
    setPrivateProjectVisibilityPassword("");
    setPrivateProjectVisibilityUnlockError("");
    setPrivateProjectVisibilityUnlockOpen(true);
  }, [activeProjectId, projects, returnToProjects, showPrivateProjects]);

  const confirmPrivateProjectVisibility = useCallback(async () => {
    if (!privateProjectVisibilityPassword || privateProjectVisibilityUnlockBusy) return;
    setPrivateProjectVisibilityUnlockBusy(true);
    setPrivateProjectVisibilityUnlockError("");
    try {
      const accepted = await invoke<boolean>("verify_app_lock_password", {
        password: privateProjectVisibilityPassword,
      });
      if (!accepted) {
        setPrivateProjectVisibilityPassword("");
        setPrivateProjectVisibilityUnlockError("密码错误，请重新输入");
        return;
      }
      setShowPrivateProjects(true);
      setPrivateProjectVisibilityUnlockOpen(false);
      setPrivateProjectVisibilityPassword("");
      setNotice("已显示私密项目");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPrivateProjectVisibilityUnlockError(message);
    } finally {
      setPrivateProjectVisibilityUnlockBusy(false);
    }
  }, [privateProjectVisibilityPassword, privateProjectVisibilityUnlockBusy]);

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
      togglePrivateProjectVisibility();
    };

    window.addEventListener("keydown", handlePrivateProjectVisibilityShortcut, true);
    return () => window.removeEventListener("keydown", handlePrivateProjectVisibilityShortcut, true);
  }, [togglePrivateProjectVisibility]);

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
    let unlistenCreated: (() => void) | undefined;
    let unlistenCreatedBatch: (() => void) | undefined;
    let unlistenUpdated: (() => void) | undefined;
    let unlistenEdgeCreated: (() => void) | undefined;
    let unlistenEdgeDeleted: (() => void) | undefined;

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

        unlistenCreated = await listen<NodeRecord>("canvas://node-created", (event) => {
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
        unlistenCreatedBatch = await listen<NodeRecord[]>("canvas://nodes-created", (event) => {
          void (async () => {
            if (!mounted || !event.payload.length) return;
            let records = event.payload;
            const activeCanvasId = activeProjectIdRef.current;
            const activeRecords = records.filter((record) => record.canvasId === activeCanvasId);
            if (activeCanvasId && activeRecords.length) {
              const minX = Math.min(...activeRecords.map((record) => record.x));
              const minY = Math.min(...activeRecords.map((record) => record.y));
              const maxX = Math.max(...activeRecords.map((record) => record.x + record.width));
              const maxY = Math.max(...activeRecords.map((record) => record.y + record.height));
              const batchWidth = Math.max(1, maxX - minX);
              const batchHeight = Math.max(1, maxY - minY);
              const viewportCenter = screenToFlowPosition({
                x: window.innerWidth / 2,
                y: window.innerHeight / 2,
              });
              const incomingIds = new Set(activeRecords.map((record) => record.id));
              const position = nonOverlappingNodePosition(
                {
                  x: viewportCenter.x - batchWidth / 2,
                  y: viewportCenter.y - batchHeight / 2,
                },
                batchWidth,
                batchHeight,
                [
                  ...nodesSnapshot.current
                    .map(recordAtCurrentFlowPosition)
                    .filter((record) => !incomingIds.has(record.id)),
                  ...incomingPlacementReservations.current,
                ],
              );
              const deltaX = position.x - minX;
              const deltaY = position.y - minY;
              const reservationId = `incoming-batch-placement:${crypto.randomUUID()}`;
              const now = new Date().toISOString();
              incomingPlacementReservations.current.push({
                id: reservationId,
                canvasId: activeCanvasId,
                kind: "placement-reservation",
                title: "",
                content: {},
                source: "placement-reservation",
                requestId: reservationId,
                x: position.x,
                y: position.y,
                width: batchWidth,
                height: batchHeight,
                status: "reserved",
                createdAt: now,
                updatedAt: now,
              });
              try {
                const relocated = await Promise.all(activeRecords.map((record) => (
                  invoke<NodeRecord>("update_node", {
                    input: {
                      id: record.id,
                      x: snapCanvasCoordinate(record.x + deltaX),
                      y: snapCanvasCoordinate(record.y + deltaY),
                    },
                  })
                )));
                const relocatedById = new Map(relocated.map((record) => [record.id, record]));
                records = records.map((record) => relocatedById.get(record.id) ?? record);
              } catch (error) {
                reportError(error);
              } finally {
                incomingPlacementReservations.current = incomingPlacementReservations.current
                  .filter((record) => record.id !== reservationId);
              }
            }

            if (!mounted) return;
            const recordsByCanvas = new Map<string, NodeRecord[]>();
            for (const record of records) {
              const grouped = recordsByCanvas.get(record.canvasId) ?? [];
              grouped.push(record);
              recordsByCanvas.set(record.canvasId, grouped);
            }
            setProjects((current) => current.map((project) => {
              const additions = recordsByCanvas.get(project.canvas.id) ?? [];
              if (!additions.length) return project;
              const existingIds = new Set(project.nodes.map((node) => node.id));
              const missing = additions.filter((record) => !existingIds.has(record.id));
              if (!missing.length) return project;
              const updatedAt = missing.reduce(
                (latest, record) => record.updatedAt > latest ? record.updatedAt : latest,
                project.canvas.updatedAt,
              );
              return {
                ...project,
                canvas: { ...project.canvas, updatedAt },
                nodes: [...project.nodes, ...missing],
              };
            }));
            const visibleRecords = records.filter(
              (record) => record.canvasId === activeProjectIdRef.current,
            );
            if (!visibleRecords.length) return;
            setNodes((current) => appendUniqueById(
              current,
              visibleRecords.map((record) => makeFlowNode(record)),
            ));
            setNotice(`已接收 ${visibleRecords.length} 个内容节点`);
          })();
        });
        unlistenUpdated = await listen<NodeRecord>("canvas://node-updated", (event) => {
          if (!mounted) return;
          const record = event.payload;
          setProjects((current) => current.map((project) => {
            if (project.canvas.id !== record.canvasId) return project;
            const nodeExists = project.nodes.some((node) => node.id === record.id);
            return {
              ...project,
              canvas: { ...project.canvas, updatedAt: record.updatedAt },
              nodes: nodeExists
                ? project.nodes.map((node) => node.id === record.id ? record : node)
                : [...project.nodes, record],
            };
          }));
          if (activeProjectIdRef.current !== record.canvasId) return;
          setNodes((current) => {
            const nodeExists = current.some((node) => node.id === record.id);
            return nodeExists
              ? current.map((node) => node.id === record.id
                ? {
                    ...node,
                    width: record.width,
                    height: record.height,
                    position: { x: record.x, y: record.y },
                    style: { ...node.style, width: record.width, height: record.height },
                    data: { ...node.data, record },
                  }
                : node)
              : [...current, makeFlowNode(record)];
          });
          setNotice(`已接收来自 ${record.source} 的提示词新版本`);
        });
        unlistenEdgeCreated = await listen<EdgeRecord>("canvas://edge-created", (event) => {
          if (!mounted) return;
          const record = event.payload;
          setProjects((current) => current.map((project) => {
            if (project.canvas.id !== record.canvasId) return project;
            if (project.edges.some((edge) => edge.id === record.id)) return project;
            return {
              ...project,
              edges: [...project.edges, record],
            };
          }));
          if (activeProjectIdRef.current !== record.canvasId) return;
          setEdges((current) => current.some((edge) => edge.id === record.id)
            ? current
            : [...current, toFlowEdge(record)]);
          scheduleContentGraphReconciliation(record.canvasId);
          setNotice("内容关系已连接");
        });
        unlistenEdgeDeleted = await listen<string>("canvas://edge-deleted", (event) => {
          if (!mounted) return;
          const edgeId = event.payload;
          const deletedEdge = edgesSnapshot.current.find((edge) => edge.id === edgeId);
          const deletedEdgeData = deletedEdge?.data as CanvasEdgeData | undefined;
          const deletedCanvasId = deletedEdgeData?.record?.canvasId;
          setProjects((current) => current.map((project) => ({
            ...project,
            edges: project.edges.filter((edge) => edge.id !== edgeId),
          })));
          setEdges((current) => current.filter((edge) => edge.id !== edgeId));
          if (deletedCanvasId) scheduleContentGraphReconciliation(deletedCanvasId);
          setNotice("内容关系已断开");
        });
      } catch (error) {
        reportError(error);
      }
    };

    void load();
    return () => {
      mounted = false;
      unlistenCreated?.();
      unlistenCreatedBatch?.();
      unlistenUpdated?.();
      unlistenEdgeCreated?.();
      unlistenEdgeDeleted?.();
    };
  }, [makeFlowNode, reportError, scheduleContentGraphReconciliation, screenToFlowPosition, setEdges, setNodes]);

  const addTextNode = useCallback(async (position?: { x: number; y: number }) => {
    if (!activeProjectId) return;
    const placement = reserveNodePlacement(
      activeProjectId,
      position,
      VIDEO_GENERATION_NODE_WIDTH,
      320,
    );
    try {
      const result = await invoke<CreateNodeResult>("create_node", {
        input: {
          canvasId: activeProjectId,
          kind: "text",
          title: "新文本",
          content: { text: "", information: "" },
          source: "manual",
          x: placement.position.x,
          y: placement.position.y,
          width: VIDEO_GENERATION_NODE_WIDTH,
          height: 320,
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
    try {
      const result = await invoke<CreateNodeResult>("create_node", {
        input: {
          canvasId: activeProjectId,
          kind: "text",
          title: "内容迭代",
          content: {
            text: "",
            information: "",
            contentNode: true,
            contentType: "plot",
            promptVersions: [],
            activePromptVersionId: "",
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
      setNotice("内容迭代节点已创建");
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

  const addEmptyFolder = useCallback(async (position?: { x: number; y: number }) => {
    if (!activeProjectId || folderGroupingBusy) return;
    const placement = reserveNodePlacement(activeProjectId, position, 420, 274.25);
    setFolderGroupingBusy(true);
    try {
      const result = await invoke<CreateEmptyFolderResult>("create_empty_folder", {
        input: {
          canvasId: activeProjectId,
          x: placement.position.x,
          y: placement.position.y,
        },
      });
      const folder = result.parent.nodes.find((node) => node.id === result.folderNodeId);
      if (!folder) throw new Error("新建文件夹后未找到目录节点");
      finishNodePlacementReservation(placement.reservationId, [folder]);
      setNodes(result.parent.nodes.map((record) => ({
        ...makeFlowNode(record),
        selected: record.id === result.folderNodeId,
      })));
      setEdges(result.parent.edges.map(toFlowEdge));
      setCanvasName(result.parent.canvas.name);
      setCanvasPath((current) => current.map((canvas, index) => (
        index === current.length - 1 ? result.parent.canvas : canvas
      )));
      setNotice(`已新建文件夹“${folder.title}”`);
      if (!position) window.setTimeout(() => {
        void setCenter(
          folder.x + folder.width / 2,
          folder.y + folder.height / 2,
          { zoom: 1, duration: 350 },
        );
      }, 60);
    } catch (error) {
      finishNodePlacementReservation(placement.reservationId);
      reportError(error);
    } finally {
      setFolderGroupingBusy(false);
    }
  }, [activeProjectId, finishNodePlacementReservation, folderGroupingBusy, makeFlowNode, reportError, reserveNodePlacement, setEdges, setNodes, setCenter]);

  const addVideoNode = useCallback(async (
    position?: { x: number; y: number },
    storyboardReferenceCompiler = false,
  ) => {
    if (!activeProjectId) return;
    const initialHeight = storyboardReferenceCompiler
      ? videoGenerationAutoHeight([], 0, VIDEO_GENERATION_NODE_WIDTH, true)
      : VIDEO_NODE_BASE_HEIGHT;
    const placement = reserveNodePlacement(
      activeProjectId,
      position,
      VIDEO_GENERATION_NODE_WIDTH,
      initialHeight,
    );
    const defaultWorkflowModule = workflowModules.find((module) => (
      !module.deletedAt
      && module.capability === "video-generation"
      && module.variant === "reference-to-video"
      && module.id === workflowModuleDefaults["video-generation:reference-to-video"]
    ));
    const nodeDefaults = storyboardReferenceCompiler
      ? {
          ...videoGenerationDefaults,
          generationMode: "reference-to-video" as VideoGenerationMode,
          workflowModuleId: defaultWorkflowModule?.id ?? "",
          workflowModuleRevision: defaultWorkflowModule?.revision ?? "",
          generationDiffusionModelName: defaultWorkflowModule?.defaults.diffusionModelName
            ?? videoGenerationDefaults.generationDiffusionModelName,
        }
      : videoGenerationDefaults.workflowModuleId
        ? videoGenerationDefaults
        : {
          ...videoGenerationDefaults,
          generationMode: defaultWorkflowModule?.variant as VideoGenerationMode ?? videoGenerationDefaults.generationMode,
          workflowModuleId: defaultWorkflowModule?.id ?? "",
          workflowModuleRevision: defaultWorkflowModule?.revision ?? "",
          generationDiffusionModelName: defaultWorkflowModule?.defaults.diffusionModelName
            ?? videoGenerationDefaults.generationDiffusionModelName,
        };
    try {
      const result = await invoke<CreateNodeResult>("create_node", {
        input: {
          canvasId: activeProjectId,
          kind: "video-generation",
          title: storyboardReferenceCompiler ? "智能视频生成" : "视频生成",
          content: {
            provider: "",
            model: "",
            status: "idle",
            secondarySamplingEnabled: false,
            ...nodeDefaults,
            ...(storyboardReferenceCompiler ? { storyboardReferenceCompiler: true } : {}),
            manualHeight: initialHeight,
            layoutTextInputCount: 0,
          },
          source: "manual",
          x: placement.position.x,
          y: placement.position.y,
          width: VIDEO_GENERATION_NODE_WIDTH,
          height: initialHeight,
        },
      });
      finishNodePlacementReservation(placement.reservationId, [result.node]);
      setNodes((current) => [...current, makeFlowNode(result.node)]);
      setNotice(storyboardReferenceCompiler ? "智能视频生成节点已创建" : "视频生成节点已创建");
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
  }, [activeProjectId, finishNodePlacementReservation, makeFlowNode, reportError, reserveNodePlacement, setCenter, setNodes, videoGenerationDefaults, workflowModuleDefaults, workflowModules]);

  const openCanvasContextMenu = useCallback((event: MouseEvent | ReactMouseEvent) => {
    event.preventDefault();
    const flowPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const menuWidth = uiFontSize === "medium" ? 220 : 190;
    const menuHeight = uiFontSize === "medium" ? 410 : 360;
    setCanvasContextMenu({
      screenX: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      screenY: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
      flowX: snapCanvasCoordinate(flowPosition.x),
      flowY: snapCanvasCoordinate(flowPosition.y),
    });
  }, [screenToFlowPosition, uiFontSize]);

  const openNodeContextMenu = useCallback((event: ReactMouseEvent, node: CanvasFlowNode) => {
    event.preventDefault();
    event.stopPropagation();
    const flowPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const selectedNodeIds = node.selected
      ? nodesSnapshot.current.filter((candidate) => candidate.selected).map((candidate) => candidate.id)
      : [node.id];
    if (!node.selected) {
      setNodes((current) => current.map((candidate) => ({
        ...candidate,
        selected: candidate.id === node.id,
      })));
    }
    const hasDeletableSelectedNode = selectedNodeIds.some((nodeId) => (
      nodesSnapshot.current.find((candidate) => candidate.id === nodeId)?.data.record.kind !== "folder"
    ));
    const menuWidth = uiFontSize === "medium" ? 252 : 224;
    const menuBaseHeight = node.data.record.kind === "video-generation"
      ? 158
      : node.data.record.kind === "image"
        ? 176
        : node.data.record.kind === "folder" && selectedNodeIds.length === 1
          ? 176
          : 104;
    const menuHeight = menuBaseHeight + (hasDeletableSelectedNode ? 52 : 0);
    setCanvasContextMenu({
      screenX: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      screenY: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
      flowX: snapCanvasCoordinate(flowPosition.x),
      flowY: snapCanvasCoordinate(flowPosition.y),
      nodeIds: selectedNodeIds,
      clickedNodeId: node.id,
    });
  }, [screenToFlowPosition, setNodes, uiFontSize]);

  const downstreamNodeIds = useCallback((sourceNodeId: string): string[] => {
    const adjacency = new Map<string, string[]>();
    for (const edge of edgesSnapshot.current) {
      const targets = adjacency.get(edge.source) ?? [];
      targets.push(edge.target);
      adjacency.set(edge.source, targets);
    }
    const collected = new Set<string>();
    const pending = [sourceNodeId];
    while (pending.length) {
      const nodeId = pending.pop()!;
      if (collected.has(nodeId)) continue;
      collected.add(nodeId);
      for (const targetId of adjacency.get(nodeId) ?? []) pending.push(targetId);
    }
    return nodesSnapshot.current
      .filter((node) => collected.has(node.id))
      .map((node) => node.id);
  }, []);

  const groupNodesIntoFolder = useCallback(async (nodeIds: string[]) => {
    if (!activeProjectId || folderGroupingBusy || !nodeIds.length) return;
    if (nodeIds.some((nodeId) => (activeComfyTaskCounts[nodeId] ?? 0) > 0)) {
      setCanvasContextMenu(null);
      setNotice("生成任务运行期间不能移动对应节点，请等待任务结束或先取消任务");
      return;
    }
    const nodeIdSet = new Set(nodeIds);
    const protectedCrossingEdgeCount = edgesSnapshot.current.filter((edge) => (
      protectedGenerationEdgeIds.has(edge.id)
      && nodeIdSet.has(edge.source) !== nodeIdSet.has(edge.target)
    )).length;
    if (protectedCrossingEdgeCount > 0) {
      setCanvasContextMenu(null);
      setNotice("不能跨目录切断视频生成来源连线，请改用“生成链路归入目录”");
      return;
    }
    const crossingEdgeCount = edgesSnapshot.current.filter((edge) => (
      nodeIdSet.has(edge.source) !== nodeIdSet.has(edge.target)
    )).length;
    if (crossingEdgeCount > 0 && !window.confirm(
      `所选范围与目录外还有 ${crossingEdgeCount} 条连线。归入目录后这些跨目录连线会断开，是否继续？`,
    )) {
      setCanvasContextMenu(null);
      return;
    }
    setFolderGroupingBusy(true);
    setCanvasContextMenu(null);
    try {
      await flushPendingPatches();
      const result = await invoke<GroupNodesIntoFolderResult>("group_nodes_into_folder", {
        input: { canvasId: activeProjectId, nodeIds },
      });
      rememberUndoEntry({ kind: "folder-group", grouping: result.undo });
      setNodes(result.parent.nodes.map((record) => ({
        ...makeFlowNode(record),
        selected: record.id === result.folderNodeId,
      })));
      setEdges(result.parent.edges.map(toFlowEdge));
      setCanvasName(result.parent.canvas.name);
      setCanvasPath((current) => current.map((canvas, index) => (
        index === current.length - 1 ? result.parent.canvas : canvas
      )));
      const folderNode = result.parent.nodes.find((node) => node.id === result.folderNodeId);
      const crossingNotice = result.removedCrossingEdgeCount
        ? `，并断开 ${result.removedCrossingEdgeCount} 条跨目录连线`
        : "";
      setNotice(`已将 ${nodeIds.length} 个节点归入“${folderNode?.title ?? "新建目录"}”${crossingNotice}，按 Ctrl+Z 撤销`);
    } catch (error) {
      reportError(error);
    } finally {
      setFolderGroupingBusy(false);
    }
  }, [activeComfyTaskCounts, activeProjectId, folderGroupingBusy, flushPendingPatches, makeFlowNode, protectedGenerationEdgeIds, rememberUndoEntry, reportError, setEdges, setNodes]);

  const groupRelatedNodesIntoFolder = useCallback(async (rootNodeId: string) => {
    if (!activeProjectId || folderGroupingBusy || !rootNodeId) return;
    const downstreamIds = downstreamNodeIds(rootNodeId);
    if (downstreamIds.some((nodeId) => (activeComfyTaskCounts[nodeId] ?? 0) > 0)) {
      setCanvasContextMenu(null);
      setNotice("生成任务运行期间不能移动对应节点，请等待任务结束或先取消任务");
      return;
    }
    setFolderGroupingBusy(true);
    setCanvasContextMenu(null);
    try {
      await flushPendingPatches();
      const result = await invoke<GroupNodesIntoFolderResult>("group_related_nodes_into_folder", {
        input: { canvasId: activeProjectId, rootNodeId },
      });
      rememberUndoEntry({ kind: "folder-group", grouping: result.undo });
      setNodes(result.parent.nodes.map((record) => ({
        ...makeFlowNode(record),
        selected: record.id === result.folderNodeId,
      })));
      setEdges(result.parent.edges.map(toFlowEdge));
      setCanvasName(result.parent.canvas.name);
      setCanvasPath((current) => current.map((canvas, index) => (
        index === current.length - 1 ? result.parent.canvas : canvas
      )));
      const folderNode = result.parent.nodes.find((node) => node.id === result.folderNodeId);
      const copiedNotice = result.copiedInputNodeCount
        ? `，其中 ${result.copiedInputNodeCount} 个共享输入已在目录内创建独立副本`
        : "";
      setNotice(
        `已将生成节点、输入素材和下游节点归入“${folderNode?.title ?? "新建目录"}”${copiedNotice}，按 Ctrl+Z 撤销`,
      );
    } catch (error) {
      reportError(error);
    } finally {
      setFolderGroupingBusy(false);
    }
  }, [activeComfyTaskCounts, activeProjectId, downstreamNodeIds, folderGroupingBusy, flushPendingPatches, makeFlowNode, rememberUndoEntry, reportError, setEdges, setNodes]);

  const mergeFolders = useCallback(async (folderNodeIds: string[]) => {
    if (!activeProjectId || folderGroupingBusy || folderNodeIds.length < 2) return;
    setFolderGroupingBusy(true);
    setCanvasContextMenu(null);
    try {
      await flushPendingPatches();
      const childCanvasIds = folderNodeIds.map((folderNodeId) => {
        const folder = nodesSnapshot.current.find((node) => node.id === folderNodeId)?.data.record;
        return folder && typeof folder.content.childCanvasId === "string"
          ? folder.content.childCanvasId
          : "";
      });
      if (childCanvasIds.some((childCanvasId) => !childCanvasId)) {
        setNotice("所选目录中存在无法打开的子画布");
        return;
      }
      const childSnapshots = await Promise.all(childCanvasIds.map((childCanvasId) => (
        invoke<WorkspaceSnapshot>("inspect_workspace", { canvasId: childCanvasId })
      )));
      if (childSnapshots.some((snapshot) => snapshot.nodes.some(
        (node) => (activeComfyTaskCounts[node.id] ?? 0) > 0,
      ))) {
        setNotice("目录内有正在运行的生成任务，请等待任务结束或先取消任务");
        return;
      }
      const result = await invoke<MergeFoldersResult>("merge_folders", {
        input: { canvasId: activeProjectId, folderNodeIds },
      });
      rememberUndoEntry({ kind: "folder-merge", merge: result.undo });
      setNodes(result.parent.nodes.map((record) => ({
        ...makeFlowNode(record),
        selected: record.id === result.folderNodeId,
      })));
      setEdges(result.parent.edges.map(toFlowEdge));
      setCanvasName(result.parent.canvas.name);
      setCanvasPath((current) => current.map((canvas, index) => (
        index === current.length - 1 ? result.parent.canvas : canvas
      )));
      const folderNode = result.parent.nodes.find((node) => node.id === result.folderNodeId);
      const deduplicatedNotice = result.deduplicatedInputNodeCount
        ? `，共享输入去重 ${result.deduplicatedInputNodeCount} 个`
        : "";
      setNotice(
        `已将 ${result.sourceFolderCount} 个目录中的 ${result.mergedNodeCount} 个节点合并到“${folderNode?.title ?? "新建目录"}”${deduplicatedNotice}，按 Ctrl+Z 撤销`,
      );
    } catch (error) {
      reportError(error);
    } finally {
      setFolderGroupingBusy(false);
    }
  }, [activeComfyTaskCounts, activeProjectId, folderGroupingBusy, flushPendingPatches, makeFlowNode, rememberUndoEntry, reportError, setEdges, setNodes]);

  const loadFolderContentNodes = useCallback(async (
    folderNodeId: string,
    recursive: boolean,
  ): Promise<NodeRecord[]> => {
    const folder = nodesSnapshot.current.find((node) => node.id === folderNodeId)?.data.record;
    const childCanvasId = folder && typeof folder.content.childCanvasId === "string"
      ? folder.content.childCanvasId
      : "";
    if (!childCanvasId) throw new Error("这个目录没有可打开的子画布");
    const pending = [childCanvasId];
    const visited = new Set<string>();
    const collected: NodeRecord[] = [];
    while (pending.length) {
      const canvasId = pending.shift()!;
      if (visited.has(canvasId)) continue;
      visited.add(canvasId);
      const snapshot = await invoke<WorkspaceSnapshot>("inspect_workspace", { canvasId });
      collected.push(...snapshot.nodes);
      if (recursive) {
        for (const node of snapshot.nodes) {
          if (node.kind === "folder" && typeof node.content.childCanvasId === "string") {
            pending.push(node.content.childCanvasId);
          }
        }
      }
    }
    return collected;
  }, []);

  const cancelFolder = useCallback(async (folderNodeId: string) => {
    if (!activeProjectId || folderGroupingBusy) return;
    setFolderGroupingBusy(true);
    setCanvasContextMenu(null);
    try {
      await flushPendingPatches();
      const contentNodes = await loadFolderContentNodes(folderNodeId, false);
      if (contentNodes.some((node) => (activeComfyTaskCounts[node.id] ?? 0) > 0)) {
        setNotice("目录内有正在运行的生成任务，请等待任务结束或先取消任务");
        return;
      }
      const result = await invoke<CancelFolderResult>("cancel_folder", {
        input: { canvasId: activeProjectId, folderNodeId },
      });
      rememberUndoEntry({ kind: "folder-cancel", cancellation: result.undo });
      const movedIds = new Set(result.undo.source.nodes.map((node) => node.id));
      setNodes(result.parent.nodes.map((record) => ({
        ...makeFlowNode(record),
        selected: movedIds.has(record.id),
      })));
      setEdges(result.parent.edges.map(toFlowEdge));
      setCanvasName(result.parent.canvas.name);
      setCanvasPath((current) => current.map((canvas, index) => (
        index === current.length - 1 ? result.parent.canvas : canvas
      )));
      const restoredConnectionNotice = result.undo.restoredSourceEdges.length
        ? `，恢复 ${result.undo.restoredSourceEdges.length} 条视频来源连线`
        : "";
      setNotice(`已取消目录，${result.movedNodeCount} 个节点已移到上一层${restoredConnectionNotice}，按 Ctrl+Z 撤销`);
    } catch (error) {
      reportError(error);
    } finally {
      setFolderGroupingBusy(false);
    }
  }, [activeComfyTaskCounts, activeProjectId, folderGroupingBusy, flushPendingPatches, loadFolderContentNodes, makeFlowNode, rememberUndoEntry, reportError, setEdges, setNodes]);

  const deleteFolderWithContents = useCallback(async (folderNodeId: string) => {
    if (!activeProjectId || folderGroupingBusy) return;
    const folder = nodesSnapshot.current.find((node) => node.id === folderNodeId)?.data.record;
    if (!folder || folder.kind !== "folder") return;
    setCanvasContextMenu(null);
    if (!window.confirm(
      `确定删除目录“${folder.title}”及其中全部内容吗？删除后可按 Ctrl+Z 撤销。`,
    )) return;
    setFolderGroupingBusy(true);
    try {
      await flushPendingPatches();
      const contentNodes = await loadFolderContentNodes(folderNodeId, true);
      if (contentNodes.some((node) => (activeComfyTaskCounts[node.id] ?? 0) > 0)) {
        setNotice("目录或子目录内有正在运行的生成任务，请等待任务结束或先取消任务");
        return;
      }
      const result = await invoke<DeleteFolderResult>("delete_folder_tree", {
        input: { canvasId: activeProjectId, folderNodeId },
      });
      rememberUndoEntry({ kind: "folder-delete", deletion: result.undo });
      setNodes(result.parent.nodes.map((record) => makeFlowNode(record)));
      setEdges(result.parent.edges.map(toFlowEdge));
      setCanvasName(result.parent.canvas.name);
      setCanvasPath((current) => current.map((canvas, index) => (
        index === current.length - 1 ? result.parent.canvas : canvas
      )));
      setNotice(`已删除目录及其中 ${result.deletedContentNodeCount} 个节点，按 Ctrl+Z 撤销`);
    } catch (error) {
      reportError(error);
    } finally {
      setFolderGroupingBusy(false);
    }
  }, [activeComfyTaskCounts, activeProjectId, folderGroupingBusy, flushPendingPatches, loadFolderContentNodes, makeFlowNode, rememberUndoEntry, reportError, setEdges, setNodes]);

  const createNodeFromContextMenu = useCallback((kind: "folder" | "text" | "prompt-version" | "note" | "video-generation" | "storyboard-video-generation") => {
    if (!canvasContextMenu) return;
    const position = { x: canvasContextMenu.flowX, y: canvasContextMenu.flowY };
    setCanvasContextMenu(null);
    if (kind === "folder") void addEmptyFolder(position);
    else if (kind === "text") void addTextNode(position);
    else if (kind === "prompt-version") void addPromptVersionNode(position);
    else if (kind === "note") void addNoteNode(position);
    else void addVideoNode(position, kind === "storyboard-video-generation");
  }, [addEmptyFolder, addNoteNode, addPromptVersionNode, addTextNode, addVideoNode, canvasContextMenu]);

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
        if (event.payload.type === "enter") {
          externalFileDragActive.current = event.payload.paths.some((path) => path.trim());
          setDropActive(externalFileDragActive.current);
          return;
        }
        if (event.payload.type === "over") {
          setDropActive(externalFileDragActive.current);
          return;
        }
        if (event.payload.type === "leave") {
          externalFileDragActive.current = false;
          setDropActive(false);
          return;
        }
        const paths = event.payload.paths.filter((path) => path.trim());
        externalFileDragActive.current = false;
        setDropActive(false);
        if (!paths.length) return;
        const ratio = window.devicePixelRatio || 1;
        void importMedia(paths, {
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
    (
      connection: Connection | Edge,
      validationEdges: Edge[] = edges,
    ): string | null => {
      if (!connection.source || !connection.target || connection.source === connection.target) {
        return "无效的节点连接";
      }
      const source = contentNodes.find((node) => node.id === connection.source)?.data.record;
      const target = contentNodes.find((node) => node.id === connection.target)?.data.record;
      if (!source || !target) return "找不到要连接的节点";
      if (validationEdges.some(
        (edge) => edge.source === connection.source && edge.target === connection.target,
      )) {
        return "这两个节点已经连接";
      }

      const sourceIsContent = source.kind === "text" && isContentIterationContent(source.content);
      const targetIsContent = target.kind === "text" && isContentIterationContent(target.content);
      if (sourceIsContent && targetIsContent) {
        const derivationEdges = validationEdges.filter((edge) => {
          const edgeKind = (edge.data as CanvasEdgeData | undefined)?.record?.kind;
          return edgeKind === "content-derivation" || edgeKind === "scene-branch";
        });
        const visited = new Set<string>();
        const pending = [target.id];
        while (pending.length) {
          const current = pending.pop()!;
          if (current === source.id) return "这条关联会形成内容循环";
          if (visited.has(current)) continue;
          visited.add(current);
          derivationEdges
            .filter((edge) => edge.source === current)
            .forEach((edge) => pending.push(edge.target));
        }
        return null;
      }
      if (targetIsContent) {
        return "内容迭代节点的左侧只能连接另一个内容迭代节点";
      }
      if (sourceIsContent && target.kind !== "video-generation") {
        return "内容迭代节点只能连接下游内容或视频生成节点";
      }
      if (!(["text", "image", "audio", "video"].includes(source.kind) && target.kind === "video-generation")) {
        return "只能连接到视频生成节点";
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
          const imageCount = validationEdges
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
          const imageCount = validationEdges
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
          const imageCount = validationEdges
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
    (connection: Connection | Edge) => {
      const validationError = connectionValidationError(connection);
      if (!validationError) return true;
      if (validationError !== "这两个节点已经连接" || !connection.source || !connection.target) {
        return false;
      }
      const targetNode = contentNodes.find((node) => node.id === connection.target);
      if (targetNode?.data.record.kind !== "video-generation") return false;
      const sourceNode = contentNodes.find((node) => node.id === connection.source);
      if (!sourceNode?.selected) return false;
      return contentNodes.some((node) => (
        node.selected
        && ["text", "image", "audio", "video"].includes(node.data.record.kind)
        && !edges.some((edge) => (
          edge.source === node.id && edge.target === connection.target
        ))
      ));
    },
    [connectionValidationError, contentNodes, edges],
  );

  const connectNodes = useCallback(
    async (connection: Connection) => {
      if (!activeProjectId) return;
      const sourceNode = nodesSnapshot.current.find((node) => node.id === connection.source);
      const targetNode = nodesSnapshot.current.find((node) => node.id === connection.target);
      if (!sourceNode || !targetNode || !connection.target) {
        setNotice("找不到要连接的节点");
        return;
      }
      const sourceIsContent = sourceNode.data.record.kind === "text"
        && isContentIterationContent(sourceNode.data.record.content);
      const targetIsContent = targetNode.data.record.kind === "text"
        && isContentIterationContent(targetNode.data.record.content);
      if (sourceIsContent && targetIsContent) {
        const validationError = connectionValidationError(connection, edgesSnapshot.current);
        if (validationError) {
          setNotice(validationError);
          return;
        }
        try {
          const record = await invoke<EdgeRecord>("create_edge", {
            input: {
              canvasId: activeProjectId,
              sourceNodeId: sourceNode.id,
              targetNodeId: targetNode.id,
              kind: "content-derivation",
              metadata: {
                relation: "content-derivation",
                sourceKind: "content",
                targetKind: "content",
                captureInitialVersionSources: true,
              },
            },
          });
          setEdges((current) => appendUniqueById(current, [toFlowEdge(record)]));
          setNotice(`已建立“${sourceNode.data.record.title}”到“${targetNode.data.record.title}”的内容关联`);
        } catch (error) {
          reportError(error);
        }
        return;
      }
      const inputKinds = new Set(["text", "image", "audio", "video"]);
      const selectedInputNodes = sourceNode.selected && inputKinds.has(sourceNode.data.record.kind)
        ? nodesSnapshot.current.filter((node) => (
            node.selected && inputKinds.has(node.data.record.kind)
          ))
        : [sourceNode];
      const batchIsTextOnly = selectedInputNodes.every(
        (node) => node.data.record.kind === "text",
      );
      const batchUsesHorizontalPromptOrder = selectedInputNodes.length > 1
        && batchIsTextOnly
        && selectedInputNodes.every((node) => (
          isContentIterationContent(node.data.record.content)
        ));
      if (selectedInputNodes.length > 1) {
        selectedInputNodes.sort((left, right) => {
          if (!batchIsTextOnly || batchUsesHorizontalPromptOrder) {
            return left.position.x - right.position.x
              || left.position.y - right.position.y
              || left.id.localeCompare(right.id);
          }
          const leftTitle = left.data.record.title.trim() || "未命名文本";
          const rightTitle = right.data.record.title.trim() || "未命名文本";
          return leftTitle.localeCompare(rightTitle, "zh-CN", {
            numeric: true,
            sensitivity: "base",
          }) || left.id.localeCompare(right.id);
        });
      }
      const batchSources = selectedInputNodes.length > 1 ? selectedInputNodes : [sourceNode];
      const alreadyConnectedSourceIds = new Set(
        edgesSnapshot.current
          .filter((edge) => edge.target === connection.target)
          .map((edge) => edge.source),
      );
      const sourcesToConnect = batchSources.filter(
        (node) => !alreadyConnectedSourceIds.has(node.id),
      );
      if (!sourcesToConnect.length) {
        setNotice("选中的输入素材已经全部连接");
        return;
      }
      const validationEdges = [...edgesSnapshot.current];
      for (const source of sourcesToConnect) {
        const validationConnection: Connection = {
          source: source.id,
          target: connection.target,
          sourceHandle: connection.sourceHandle,
          targetHandle: connection.targetHandle,
        };
        const validationError = connectionValidationError(
          validationConnection,
          validationEdges,
        );
        if (validationError) {
          const sourceTitle = source.data.record.title.trim() || "未命名素材";
          setNotice(
            batchSources.length > 1
              ? `批量连接失败：“${sourceTitle}”${validationError}`
              : validationError,
          );
          return;
        }
        validationEdges.push({
          id: `batch-validation:${source.id}`,
          source: source.id,
          target: connection.target,
        });
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
          const connectedInputRecords = edgesSnapshot.current
            .filter((edge) => edge.target === targetNode.id)
            .map((edge) => nodesSnapshot.current.find((node) => node.id === edge.source)?.data.record)
            .filter((record): record is NodeRecord => Boolean(record));
          const existingTextRecords = connectedInputRecords.filter(
            (record) => record.kind === "text",
          );
          const existingMediaRecords = connectedInputRecords.filter(
            (record) => record.kind === "image" || record.kind === "audio" || record.kind === "video",
          );
          const existingTextOrder = orderedNodeRecordsFromContent(
            targetNode.data.record.content,
            "textInputOrder",
            existingTextRecords,
          ).map((record) => record.id);
          const existingMediaOrder = orderedNodeRecordsFromContent(
            targetNode.data.record.content,
            "mediaInputOrder",
            existingMediaRecords,
          ).map((record) => record.id);
          const createdTextSourceIds = createdSourceIds.filter((sourceId) => (
            nodesSnapshot.current.find((node) => node.id === sourceId)?.data.record.kind === "text"
          ));
          const createdMediaSourceIds = createdSourceIds.filter((sourceId) => (
            ["image", "audio", "video"].includes(
              nodesSnapshot.current.find((node) => node.id === sourceId)?.data.record.kind ?? "",
            )
          ));
          changeNode(targetNode.id, {
            content: {
              ...targetNode.data.record.content,
              textInputOrder: [...existingTextOrder, ...createdTextSourceIds],
              mediaInputOrder: [...existingMediaOrder, ...createdMediaSourceIds],
            },
          });
        }

        if (!createdEdges.length) {
          setNotice(`输入素材连接失败：${failures[0] ?? "没有可连接的节点"}`);
        } else if (batchSources.length > 1) {
          const orderLabel = batchIsTextOnly && !batchUsesHorizontalPromptOrder
            ? "标题升序"
            : "画布从左到右";
          const skippedCount = batchSources.length - sourcesToConnect.length;
          const skippedNotice = skippedCount ? `，跳过 ${skippedCount} 个已连接素材` : "";
          setNotice(
            failures.length
              ? `已按${orderLabel}连接 ${createdEdges.length} 个输入素材，${failures.length} 个失败${skippedNotice}`
              : `已按${orderLabel}批量连接 ${createdEdges.length} 个输入素材${skippedNotice}`,
          );
        } else {
          setNotice("节点已连接");
        }
      } catch (error) {
        reportError(error);
      }
    },
    [activeProjectId, changeNode, connectionValidationError, reportError, setEdges, setNodes],
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
    const deletableEdges = selectedEdges.filter((edge) => !protectedGenerationEdgeIds.has(edge.id));
    const protectedEdgeCount = selectedEdges.length - deletableEdges.length;
    if (!deletableEdges.length) {
      setNotice("视频生成节点与其输出视频之间的来源连线不可移除");
      return;
    }
    try {
      await Promise.all(deletableEdges.map((edge) => invoke("delete_edge", { id: edge.id })));
      const deletedEdgeIds = new Set(deletableEdges.map((edge) => edge.id));
      setEdges((current) => current.filter((edge) => !deletedEdgeIds.has(edge.id)));
      setNotice(protectedEdgeCount > 0
        ? `${deletableEdges.length} 条普通连线已删除；${protectedEdgeCount} 条生成来源连线已保留`
        : `${deletableEdges.length} 条连线已删除`);
    } catch (error) {
      reportError(error);
    }
  }, [deleteCanvasNodes, protectedGenerationEdgeIds, reportError, setEdges]);

  useEffect(() => {
    const handleDeleteShortcut = (event: KeyboardEvent) => {
      if (event.key !== "Delete") return;
      if (document.querySelector(".expanded-editor-backdrop")) return;
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
      void deleteSelectedElements(event.ctrlKey);
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
    const promptNodeIdsByText = new Map<string, Set<string>>();
    const promptNodeIdsByVersionId = new Map<string, Set<string>>();
    contentNodes.forEach((node) => {
      const record = node.data.record;
      if (record.kind !== "text") return;
      const versions = promptVersionsFromContent(record.content);
      const prompts = versions.length
        ? versions.map((version) => version.text)
        : [textFromContent(record.content)];
      prompts.forEach((prompt) => {
        if (!prompt) return;
        const nodeIds = promptNodeIdsByText.get(prompt) ?? new Set<string>();
        nodeIds.add(record.id);
        promptNodeIdsByText.set(prompt, nodeIds);
      });
      versions.forEach((version) => {
        const nodeIds = promptNodeIdsByVersionId.get(version.id) ?? new Set<string>();
        nodeIds.add(record.id);
        promptNodeIdsByVersionId.set(version.id, nodeIds);
      });
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
      const promptVersionId = typeof snapshot.promptVersionId === "string"
        ? snapshot.promptVersionId
        : "";
      const versionMatches = promptVersionId
        ? [...(promptNodeIdsByVersionId.get(promptVersionId) ?? [])]
        : [];
      const textMatches = [...(promptNodeIdsByText.get(prompt) ?? [])];
      const promptNodeId = versionMatches.length === 1
        ? versionMatches[0]
        : textMatches.length === 1
          ? textMatches[0]
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
      if (isContentIterationContent(anchor.content)) {
        return new Set<string>();
      }
      const relatedIds = new Set<string>([anchor.id]);
      const activePromptVersionId = isContentIterationContent(anchor.content)
        ? activePromptVersionFromContent(anchor.content)?.id ?? ""
        : null;
      contentNodes.forEach((node) => {
        const record = node.data.record;
        if (record.kind !== "generated-video") return;
        const snapshot = generationSnapshotFromContent(record.content);
        if (!snapshot) return;
        if (
          snapshot.promptNodeId === anchor.id
          && (
            activePromptVersionId === null
            || (activePromptVersionId !== "" && snapshot.promptVersionId === activePromptVersionId)
          )
        ) {
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
  }, [contentNodes, edges, relationAnchorId]);

  const relationPromptVersionLabels = useMemo(() => {
    const labels = new Map<string, string>();
    if (!relationAnchorId) return labels;
    const recordsById = new Map(contentNodes.map((node) => [node.id, node.data.record]));
    const anchor = recordsById.get(relationAnchorId);
    if (anchor?.kind !== "generated-video") return labels;
    const snapshot = generationSnapshotFromContent(anchor.content);
    if (!snapshot?.promptNodeId) return labels;
    const promptNode = recordsById.get(snapshot.promptNodeId);
    if (promptNode?.kind !== "text" || !isContentIterationContent(promptNode.content)) return labels;
    const versionLabel = snapshot.promptVersionLabel
      || promptVersionsFromContent(promptNode.content).find(
        (version) => version.id === snapshot.promptVersionId,
      )?.label
      || "";
    if (versionLabel) labels.set(promptNode.id, versionLabel);
    return labels;
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
    if (kind === "generated-video") {
      const snapshot = generationSnapshotFromContent(node.data.record.content);
      const sourceGeneratorId = typeof node.data.record.content.sourceGeneratorId === "string"
        ? node.data.record.content.sourceGeneratorId
        : "";
      // A generated video is a historical execution of one concrete prompt.
      // Restore that prompt as the generator's active text input when the video
      // is selected, mirroring the existing prompt-node -> generator behavior.
      if (sourceGeneratorId && snapshot?.promptNodeId) {
        activateTextInput(sourceGeneratorId, snapshot.promptNodeId);
      }
    }
    setRelationAnchorId(
      kind === "generated-video" || (kind === "text" && !isContentIterationContent(node.data.record.content))
        ? node.id
        : null,
    );
  }, [activateTextInput]);

  const interactiveEdges = useMemo(
    () => edges.map((edge) => {
      const protectedRelationshipEdge = protectedGenerationEdgeIds.has(edge.id);
      return {
        ...edge,
        type: "canvasEdge",
        selectable: !protectedRelationshipEdge,
        deletable: !protectedRelationshipEdge,
        focusable: !protectedRelationshipEdge,
        data: {
          ...edge.data,
          onDisconnect: protectedRelationshipEdge
            ? undefined
            : (edgeId: string) => void disconnectEdge(edgeId),
        },
      };
    }),
    [disconnectEdge, edges, protectedGenerationEdgeIds],
  );

  const visibleNodes = useMemo(
    () => {
      const recordsById = new Map(contentNodes.map((node) => [node.id, node.data.record]));
      const inputRecordsByTarget = new Map<string, NodeRecord[]>();
      const contentParentsByTarget = new Map<string, NodeRecord[]>();
      const outputCountBySource = new Map<string, number>();
      edges.forEach((edge) => {
        outputCountBySource.set(edge.source, (outputCountBySource.get(edge.source) ?? 0) + 1);
        const source = recordsById.get(edge.source);
        if (!source) return;
        const edgeKind = (edge.data as CanvasEdgeData | undefined)?.record?.kind;
        if (edgeKind === "content-derivation" || edgeKind === "scene-branch") {
          const parents = contentParentsByTarget.get(edge.target) ?? [];
          parents.push(source);
          contentParentsByTarget.set(edge.target, parents);
        }
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
        const rawContentParents = contentParentsByTarget.get(node.id) ?? EMPTY_NODE_RECORDS;
        const contentParents = previousData && nodeRecordArraysEqual(previousData.contentParents, rawContentParents)
          ? previousData.contentParents
          : rawContentParents;
        const mediaInputs = previousData && nodeRecordArraysEqual(previousData.mediaInputs, orderedMedia)
          ? previousData.mediaInputs
          : orderedMedia;
        const textInputs = previousData && nodeRecordArraysEqual(previousData.textInputs, orderedText)
          ? previousData.textInputs
          : orderedText;
        const matched = matchedIds.has(node.id);
        const relationHighlighted = relationHighlightedIds.has(node.id);
        const relationPromptVersionLabel = relationHighlighted
          ? relationPromptVersionLabels.get(node.id) ?? ""
          : "";
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
          && previousData.relationPromptVersionLabel === relationPromptVersionLabel
          && previousData.activeTaskCount === activeTaskCount
          && previousData.inputCount === inputRecords.length
          && previousData.outputCount === outputCount
          && previousData.contentParents === contentParents
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
              relationPromptVersionLabel,
              activeTaskCount,
              inputCount: inputRecords.length,
              outputCount,
              contentParents,
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
    [activeComfyTaskCounts, contentNodes, edges, h3LoraOptions, matchedIds, nodes, relationHighlightedIds, relationPromptVersionLabels, workflowModuleDefaults, workflowModules],
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

  const restoreMultiSelectionOutline = useCallback(() => {
    const selectedNodeCount = flowStore.getState().nodes.filter((node) => node.selected).length;
    if (selectedNodeCount > 1) {
      flowStore.setState({ nodesSelectionActive: true });
    }
  }, [flowStore]);

  const beginAlignedNodeDrag = useCallback(() => {
    alignedDragPositions.current.clear();
    updateGuideOverlays([], []);
    restoreMultiSelectionOutline();
  }, [restoreMultiSelectionOutline, updateGuideOverlays]);

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
    restoreMultiSelectionOutline();
  }, [persistPatch, restoreMultiSelectionOutline, setNodes, updateGuideOverlays]);

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
      setCanvasPath((current) => current.map((canvas) => (
        canvas.id === updated.id ? updated : canvas
      )));
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

  const setImageAsProjectPreview = useCallback(async (imageNodeId: string) => {
    const rootProject = canvasPath[0];
    if (!rootProject) {
      setCanvasContextMenu(null);
      setNotice("无法定位当前项目");
      return;
    }
    try {
      const updated = await invoke<CanvasRecord>("set_project_preview_image", {
        input: { projectId: rootProject.id, imageNodeId },
      });
      setCanvasPath((current) => current.map((canvas) => (
        canvas.id === updated.id ? updated : canvas
      )));
      setProjects((current) => current.map((project) => (
        project.canvas.id === updated.id
          ? { ...project, canvas: updated }
          : project
      )));
      setCanvasContextMenu(null);
      setNotice("已设为项目预览图");
    } catch (error) {
      setCanvasContextMenu(null);
      reportError(error);
    }
  }, [canvasPath, reportError]);

  const openAppSettings = () => {
    setComfyOutputRootDraft(comfyOutputRoot);
    setComfyInputRootDraft(comfyInputRoot);
    setComfyUiServerUrlDraft(comfyUiServerUrl);
    setH3WorkflowPathDraft(h3WorkflowPath);
    setH3ModelParametersDraft(h3ModelParameters);
    setVideoGenerationDefaultsDraft(videoGenerationDefaults);
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

  const globalNoticeToast = noticeToastVisible && createPortal(
    <div className="global-notice-toast" role="status" aria-live="polite">
      <span>{noticeToastMessage}</span>
    </div>,
    document.body,
  );

  const privateProjectVisibilityUnlockDialog = privateProjectVisibilityUnlockOpen && createPortal(
    <div
      className="project-dialog-backdrop"
      onMouseDown={() => {
        if (privateProjectVisibilityUnlockBusy) return;
        setPrivateProjectVisibilityUnlockOpen(false);
        setPrivateProjectVisibilityPassword("");
        setPrivateProjectVisibilityUnlockError("");
      }}
    >
      <form
        className="project-dialog private-project-visibility-unlock-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="private-project-visibility-unlock-title"
        aria-describedby="private-project-visibility-unlock-description"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void confirmPrivateProjectVisibility();
        }}
      >
        <div className="project-dialog-icon"><LockKeyhole size={22} /></div>
        <div>
          <h2 id="private-project-visibility-unlock-title">验证登录密码</h2>
          <p id="private-project-visibility-unlock-description">输入登录密码后，才会恢复显示私密项目。</p>
        </div>
        <label>
          登录密码
          <input
            type="password"
            value={privateProjectVisibilityPassword}
            onChange={(event) => setPrivateProjectVisibilityPassword(event.currentTarget.value)}
            autoComplete="current-password"
            autoFocus
            disabled={privateProjectVisibilityUnlockBusy}
          />
        </label>
        {privateProjectVisibilityUnlockError && (
          <p className="private-project-visibility-unlock-error" role="alert">
            {privateProjectVisibilityUnlockError}
          </p>
        )}
        <div className="project-dialog-actions">
          <button
            type="button"
            className="dialog-cancel"
            disabled={privateProjectVisibilityUnlockBusy}
            onClick={() => {
              setPrivateProjectVisibilityUnlockOpen(false);
              setPrivateProjectVisibilityPassword("");
              setPrivateProjectVisibilityUnlockError("");
            }}
          >
            取消
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={privateProjectVisibilityUnlockBusy || !privateProjectVisibilityPassword}
          >
            <LockKeyhole size={14} />
            {privateProjectVisibilityUnlockBusy ? "验证中…" : "验证并显示"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );

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
          if (activeSettingsSection === "video-defaults") saveVideoGenerationDefaults();
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
          <button
            type="button"
            className="app-settings-close"
            onClick={() => setSettingsOpen(false)}
            title="关闭设置"
            aria-label="关闭应用设置"
          >
            <X size={18} />
          </button>
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
              className={activeSettingsSection === "video-defaults" ? "is-active" : ""}
              onClick={() => setActiveSettingsSection("video-defaults")}
            >
              <SlidersHorizontal size={16} />
              <span><strong>视频生成参数</strong><small>新节点的生成参数</small></span>
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
                  <p>配置远程 ComfyUI 的服务地址与 Windows 映射路径。</p>
                </div>
                <section className="general-settings-group" aria-labelledby="appearance-settings-title">
                  <div className="general-settings-group-heading">
                    <h4 id="appearance-settings-title">界面</h4>
                    <p>调整应用中的文字与控件显示密度。</p>
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
                </section>
                <section className="general-settings-group comfyui-settings-group" aria-label="ComfyUI 配置">
                  <div className="comfyui-settings-fields">
                    <label>
                      ComfyUI 服务地址
                      <input
                        value={comfyUiServerUrlDraft}
                        onChange={(event) => setComfyUiServerUrlDraft(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.preventDefault();
                            setSettingsOpen(false);
                          }
                        }}
                        placeholder="例如：http://192.168.5.108:8188"
                        spellCheck={false}
                      />
                      <small>
                        ComfyUI 网页与 API 的服务地址。保存后，生成提交、队列、预览和进度连接都会改用此地址。
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
                  </div>
                </section>
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
            {activeSettingsSection === "video-defaults" && (
              <section className="settings-pane video-defaults-settings-pane" aria-labelledby="video-defaults-settings-title">
                <div className="settings-pane-heading">
                  <div>
                    <h3 id="video-defaults-settings-title">视频生成参数</h3>
                    <p>这里的参数会套用到之后新建的视频生成节点；已在画布上的节点不会被改动。</p>
                  </div>
                </div>
                <VideoGenerationDefaultsEditor
                  value={videoGenerationDefaultsDraft}
                  workflowModules={workflowModules}
                  h3LoraOptions={h3LoraOptions}
                  onChange={(patch) => setVideoGenerationDefaultsDraft((current) => ({ ...current, ...patch }))}
                />
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
              onClick={togglePrivateProjectVisibility}
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
        {(activeSettingsSection === "general"
          || activeSettingsSection === "video-defaults"
          || activeSettingsSection === "model") && (
          <div className="project-dialog-actions">
            {activeSettingsSection === "general" && (
              <button type="submit" className="primary-button">
                保存基础设置
              </button>
            )}
            {activeSettingsSection === "video-defaults" && (
              <button type="submit" className="primary-button">
                保存为默认值
              </button>
            )}
            {activeSettingsSection === "model" && (
              <button type="submit" className="primary-button">
                保存模型参数
              </button>
            )}
          </div>
        )}
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
        {privateProjectVisibilityUnlockDialog}
        {globalNoticeToast}
      </main>
    );
  }

  const contextMenuSelectedRecords = (canvasContextMenu?.nodeIds ?? [])
    .map((nodeId) => nodesSnapshot.current.find((node) => node.id === nodeId)?.data.record)
    .filter((record): record is NodeRecord => Boolean(record));
  const contextMenuClickedRecord = canvasContextMenu?.clickedNodeId
    ? nodesSnapshot.current.find((node) => node.id === canvasContextMenu.clickedNodeId)?.data.record
    : undefined;
  const contextMenuImageAssetPath = contextMenuClickedRecord?.kind === "image"
    && typeof contextMenuClickedRecord.content.assetPath === "string"
    && contextMenuClickedRecord.content.assetPath.trim()
      ? contextMenuClickedRecord.content.assetPath
      : null;
  const contextMenuImageIsProjectPreview = Boolean(
    contextMenuImageAssetPath
    && canvasPath[0]?.previewImagePath === contextMenuImageAssetPath,
  );
  const canMergeSelectedFolders = contextMenuSelectedRecords.length >= 2
    && contextMenuSelectedRecords.length === (canvasContextMenu?.nodeIds?.length ?? 0)
    && contextMenuSelectedRecords.every((record) => record.kind === "folder");
  const isSingleFolderContextMenu = contextMenuSelectedRecords.length === 1
    && contextMenuSelectedRecords[0].kind === "folder";
  const contextMenuDeletableNodeIds = contextMenuSelectedRecords
    .filter((record) => record.kind !== "folder")
    .map((record) => record.id);

  return (
    <main
      className={`app-shell${ctrlNodeSelectionActive ? " is-ctrl-node-selection" : ""}${multiNodeSelectionActive ? " has-multi-node-selection" : ""}`}
      style={{
        ...(canvasBackground ? { background: canvasBackground } : {}),
        "--node-handle-screen-scale": nodeHandleScreenScale,
      } as CSSProperties}
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
        onNodeClick={(_, node) => {
          handleNodeRelationClick(node);
          restoreMultiSelectionOutline();
        }}
        onPaneClick={() => {
          setCanvasContextMenu(null);
          setRelationAnchorId(null);
        }}
        onPaneContextMenu={openCanvasContextMenu}
        onNodeContextMenu={openNodeContextMenu}
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

        <Panel
          position="top-left"
          className={`brand-panel${canvasPath.length > 1 ? " is-subcanvas" : ""}`}
        >
          <button
            className="project-back-button"
            onClick={() => {
              if (canvasPath.length > 1) navigateToCanvasPath(canvasPath.length - 2);
              else void returnToProjects();
            }}
            title={canvasPath.length > 1 ? "返回上一级画布" : "返回项目首页"}
          >
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
                <strong className="active-project-title">{canvasName}</strong>
                <Pencil size={12} />
              </button>
            )}
            {canvasPath.length > 1 ? (
              <nav className="canvas-breadcrumbs" aria-label="画布路径">
                {canvasPath.map((canvas, index) => (
                  <span className="canvas-breadcrumb-item" key={canvas.id}>
                    {index > 0 && <i className="canvas-breadcrumb-separator" aria-hidden="true">/</i>}
                    {index === canvasPath.length - 1 ? (
                      <strong className="canvas-breadcrumb-current" title={canvas.name}>{canvas.name}</strong>
                    ) : (
                      <button type="button" onClick={() => navigateToCanvasPath(index)} title={canvas.name}>{canvas.name}</button>
                    )}
                  </span>
                ))}
              </nav>
            ) : <span className="active-project-subtitle">SuCanvas · Project</span>}
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
      {privateProjectVisibilityUnlockDialog}
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
              <h2>选择提示词并重新生成</h2>
              <p>默认使用“{videoRegenerationDraft.previewTitle}”生成时保存的提示词版本与参数。</p>
            </div>
            <div className="video-regeneration-fields">
              <label className="video-regeneration-prompt-field">
                提示词版本
                <div className="video-regeneration-prompt-controls">
                  <SettingsSelect
                    value={videoRegenerationDraft.selectedPromptKey}
                    options={videoRegenerationDraft.promptOptions.map((option) => ({
                      value: option.key,
                      label: option.label,
                    }))}
                    onChange={(selectedPromptKey) => {
                      setVideoRegenerationInformationOpen(false);
                      setVideoRegenerationDraft((current) => current && ({
                        ...current,
                        selectedPromptKey,
                      }));
                    }}
                    ariaLabel="重新生成提示词版本"
                  />
                  <button
                    type="button"
                    className="video-regeneration-information-button"
                    onClick={() => setVideoRegenerationInformationOpen(true)}
                    title="查看当前提示词版本的备注"
                    aria-label="查看当前提示词版本的备注"
                  >
                    <StickyNote size={14} />
                    <span>查看备注</span>
                  </button>
                </div>
              </label>
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
                时长（秒）
                <ModelParameterNumberInput
                  regenerationField="durationSeconds"
                  min={2}
                  max={15}
                  step={1}
                  value={videoRegenerationDraft.durationSeconds}
                  onChange={(value) => setVideoRegenerationDraft((current) => current && ({
                    ...current,
                    durationSeconds: value,
                  }))}
                />
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
              可临时选择关联提示词节点中的其他版本并调整时长；不会切换提示词节点的当前版本。参考图片及首尾帧角色始终读取原视频生成节点当前连接的最新状态；音频、视频、模型、LoRA 文件和画面比例仍使用当前视频的历史快照。Seed 默认保持不变，点击色子才会随机更换。
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
      {videoRegenerationInformationOpen && videoRegenerationDraft && createPortal(
        <div
          className="expanded-editor-backdrop"
          onMouseDown={() => setVideoRegenerationInformationOpen(false)}
        >
          <section
            className="expanded-editor-dialog is-prompt-version is-readonly"
            role="dialog"
            aria-modal="true"
            aria-label="重新生成提示词与备注"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="expanded-editor-header">
              <span className="node-kind-icon"><FileText size={15} /></span>
              <div>
                <strong>{selectedVideoRegenerationPrompt?.label ?? "提示词版本"}</strong>
                <span>当前选择版本 · 只读</span>
              </div>
              <button
                type="button"
                onClick={() => setVideoRegenerationInformationOpen(false)}
                title="关闭"
                aria-label="关闭提示词与备注查看窗口"
              >
                <X size={17} />
              </button>
            </header>
            <div className="expanded-prompt-layout">
              <section className="expanded-prompt-pane is-prompt">
                <header>
                  <strong>提示词</strong>
                  <span>{(selectedVideoRegenerationPrompt?.prompt ?? "").length.toLocaleString()} 字符</span>
                </header>
                <textarea
                  className="expanded-text-editor"
                  value={selectedVideoRegenerationPrompt?.prompt ?? ""}
                  readOnly
                  spellCheck={false}
                  placeholder="未记录提示词"
                  aria-label="当前提示词版本的提示词，只读"
                />
              </section>
              <section className="expanded-prompt-pane is-information">
                <header>
                  <strong>备注</strong>
                  <span>{(selectedVideoRegenerationPrompt?.information ?? "").length.toLocaleString()} 字符</span>
                </header>
                <textarea
                  className="expanded-text-editor"
                  value={selectedVideoRegenerationPrompt?.information ?? ""}
                  readOnly
                  spellCheck={false}
                  placeholder="该提示词版本未填写备注"
                  aria-label="当前提示词版本的备注，只读"
                />
              </section>
            </div>
          </section>
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
          className={`canvas-context-menu ${canvasContextMenu.nodeIds ? "is-node-menu" : ""}`}
          style={{ left: canvasContextMenu.screenX, top: canvasContextMenu.screenY }}
          role="menu"
          aria-label={canvasContextMenu.nodeIds ? "整理节点" : "新建节点"}
          onContextMenu={(event) => event.preventDefault()}
        >
          {canvasContextMenu.nodeIds ? (
            <>
              <span className="canvas-context-menu-title">整理节点</span>
              {contextMenuImageAssetPath && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={contextMenuImageIsProjectPreview}
                  onClick={() => void setImageAsProjectPreview(canvasContextMenu.clickedNodeId ?? "")}
                >
                  {contextMenuImageIsProjectPreview ? <Check size={15} /> : <ImageIcon size={15} />}
                  <span>
                    <strong>{contextMenuImageIsProjectPreview ? "当前项目预览图" : "设为项目预览图"}</strong>
                    <small>显示在项目选择界面的项目卡片上</small>
                  </span>
                </button>
              )}
              {canMergeSelectedFolders ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={folderGroupingBusy}
                  onClick={() => void mergeFolders(canvasContextMenu.nodeIds ?? [])}
                >
                  <FolderKanban size={15} />
                  <span>
                    <strong>合并到新目录</strong>
                    <small>{canvasContextMenu.nodeIds.length} 个目录 · 保留节点与连线</small>
                  </span>
                </button>
              ) : isSingleFolderContextMenu ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={folderGroupingBusy}
                    onClick={() => void cancelFolder(canvasContextMenu.clickedNodeId ?? "")}
                  >
                    <ArrowLeft size={15} />
                    <span>
                      <strong>取消目录</strong>
                      <small>将目录内容移到上一层画布</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="is-danger"
                    disabled={folderGroupingBusy}
                    onClick={() => void deleteFolderWithContents(canvasContextMenu.clickedNodeId ?? "")}
                  >
                    <Trash2 size={15} />
                    <span>
                      <strong>删除目录</strong>
                      <small>同时删除目录中的全部内容</small>
                    </span>
                  </button>
                </>
              ) : nodesSnapshot.current.find((node) => node.id === canvasContextMenu.clickedNodeId)?.data.record.kind === "video-generation" ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={folderGroupingBusy}
                  onClick={() => void groupRelatedNodesIntoFolder(
                    canvasContextMenu.clickedNodeId ?? "",
                  )}
                >
                  <Clapperboard size={15} />
                  <span><strong>将相关联的所有节点归入目录</strong><small>包含输入素材与下游节点 · 共享输入会复制</small></span>
                </button>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  disabled={folderGroupingBusy}
                  onClick={() => void groupNodesIntoFolder(canvasContextMenu.nodeIds ?? [])}
                >
                  <FolderOpen size={15} />
                  <span>
                    <strong>将选中节点归入目录</strong>
                    <small>{canvasContextMenu.nodeIds.length} 个节点 · 自动命名</small>
                  </span>
                </button>
              )}
              {contextMenuDeletableNodeIds.length > 0 && (
                <button
                  type="button"
                  role="menuitem"
                  className="is-danger"
                  onClick={() => {
                    const deleteIds = new Set(contextMenuDeletableNodeIds);
                    const nodesToDelete = nodesSnapshot.current.filter((node) => deleteIds.has(node.id));
                    setCanvasContextMenu(null);
                    void deleteCanvasNodes(nodesToDelete);
                  }}
                >
                  <Trash2 size={15} />
                  <span>
                    <strong>{contextMenuDeletableNodeIds.length === 1 ? "删除节点" : "删除选中节点"}</strong>
                    <small>{contextMenuDeletableNodeIds.length === 1
                      ? "删除此节点，可按 Ctrl+Z 撤销"
                      : `删除 ${contextMenuDeletableNodeIds.length} 个节点，可按 Ctrl+Z 撤销`}</small>
                  </span>
                </button>
              )}
            </>
          ) : (
            <>
              <span className="canvas-context-menu-title">新建</span>
              <button type="button" role="menuitem" onClick={() => createNodeFromContextMenu("video-generation")}>
                <Clapperboard size={15} />
                <span><strong>视频生成节点</strong><small>连接素材并提交生成</small></span>
              </button>
              <button type="button" role="menuitem" onClick={() => createNodeFromContextMenu("storyboard-video-generation")}>
                <Sparkles size={15} />
                <span><strong>智能视频生成</strong><small>按分镜内部选择自动筛选提交素材</small></span>
              </button>
              <button type="button" role="menuitem" onClick={() => createNodeFromContextMenu("prompt-version")}>
                <History size={15} />
                <span><strong>内容迭代节点</strong><small>存储剧情、剧本、分镜或生成提示词</small></span>
              </button>
              <button type="button" role="menuitem" onClick={() => createNodeFromContextMenu("text")}>
                <FileText size={15} />
                <span><strong>文本节点</strong><small>输入提示词或普通文本</small></span>
              </button>
              <button type="button" role="menuitem" onClick={() => createNodeFromContextMenu("note")}>
                <StickyNote size={15} />
                <span><strong>备注节点</strong><small>记录说明和想法</small></span>
              </button>
              <button type="button" role="menuitem" onClick={() => createNodeFromContextMenu("folder")}>
                <FolderPlus size={15} />
                <span><strong>新建文件夹</strong><small>创建一个空白目录</small></span>
              </button>
            </>
          )}
        </div>,
        document.body,
      )}
      {globalNoticeToast}
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
