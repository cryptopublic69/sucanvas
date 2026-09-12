import { convertFileSrc } from "@tauri-apps/api/core";
import {
  FolderKanban,
  LockKeyhole,
  Moon,
  Plus,
  Settings2,
  Sparkles,
  Sun,
  Trash2
} from "lucide-react";
import {
  useMemo
} from "react";
import suCanvasLogo from "../../src-tauri/icons/128x128@2x.png";
import type {
  CanvasRecord,
  WorkspaceSnapshot
} from "../CanvasNode";

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

type ProjectHomeProps = {
  comfyQueueIndicator: React.ReactNode;
  projectColumns: number;
  setProjectColumns: React.Dispatch<React.SetStateAction<number>>;
  openAppSettings: () => void;
  toggleTheme: () => void;
  theme: "dark" | "light";
  visibleProjects: WorkspaceSnapshot[];
  showPrivateProjects: boolean;
  privateProjectCount: number;
  setCreateProjectOpen: React.Dispatch<React.SetStateAction<boolean>>;
  projectHomeReady: boolean;
  openProject: (projectId: string, ancestors?: CanvasRecord[], preserveFolderUndo?: boolean) => Promise<void>;
  setProjectToDelete: React.Dispatch<React.SetStateAction<WorkspaceSnapshot | null>>;
  createProjectOpen: boolean;
  createProject: () => Promise<void>;
  newProjectName: string;
  setNewProjectName: React.Dispatch<React.SetStateAction<string>>;
  projectToDelete: WorkspaceSnapshot | null;
  deletingProjectId: string | null;
  deleteProject: () => Promise<void>;
  appSettingsDialog: React.ReactNode;
  privateProjectVisibilityUnlockDialog: React.ReactNode;
  globalNoticeToast: React.ReactNode;
};

export function ProjectHome({
  comfyQueueIndicator,
  projectColumns,
  setProjectColumns,
  openAppSettings,
  toggleTheme,
  theme,
  visibleProjects,
  showPrivateProjects,
  privateProjectCount,
  setCreateProjectOpen,
  projectHomeReady,
  openProject,
  setProjectToDelete,
  createProjectOpen,
  createProject,
  newProjectName,
  setNewProjectName,
  projectToDelete,
  deletingProjectId,
  deleteProject,
  appSettingsDialog,
  privateProjectVisibilityUnlockDialog,
  globalNoticeToast,
}: ProjectHomeProps) {
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
