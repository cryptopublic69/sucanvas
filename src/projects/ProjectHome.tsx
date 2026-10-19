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
  useEffect,
  useMemo,
  useState
} from "react";
import suCanvasLogo from "../../src-tauri/icons/128x128@2x.png";
import type {
  CanvasRecord,
  WorkspaceSnapshot
} from "../CanvasNode";
import {
  assignableUsers,
  canCopyProject,
  canDeleteProject,
  groupProjects,
  othersPrivateDeleteWarning,
  ownerLabel,
  projectSection,
  type AccessUser,
  type AssignableUser
} from "../account/access";

// Web accounts: the home page groups canvases by owner; admins manage owner
// and sharing in "画布设置"; shared canvases can be copied.
export type ProjectHomeAccess = {
  user: AccessUser;
  newProjectShared: boolean;
  setNewProjectShared: (shared: boolean) => void;
  saveCanvasSettings: (project: WorkspaceSnapshot, settings: { ownerUserId: string; shared: boolean }) => Promise<boolean>;
  sharingBusyId: string | null;
  copySharedProject: (project: WorkspaceSnapshot) => Promise<void>;
  copyingProjectId: string | null;
};

function CanvasSettingsDialog({ project, access, onClose }: { project: WorkspaceSnapshot; access: ProjectHomeAccess; onClose: () => void }) {
  const [users, setUsers] = useState<AssignableUser[] | null>(null);
  const [ownerUserId, setOwnerUserId] = useState(project.canvas.ownerUserId ?? "");
  const [shared, setShared] = useState(Boolean(project.canvas.isShared));
  const [loadError, setLoadError] = useState("");
  const busy = access.sharingBusyId === project.canvas.id;
  useEffect(() => {
    let cancelled = false;
    assignableUsers()
      .then((list) => { if (!cancelled) setUsers(list); })
      .catch((error) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, []);
  const owners = users ?? [];
  // A current owner that is disabled or unknown stays visible until changed.
  const currentMissing = Boolean(project.canvas.ownerUserId) && users !== null
    && !owners.some((user) => user.id === project.canvas.ownerUserId);
  const changed = ownerUserId !== (project.canvas.ownerUserId ?? "") || shared !== Boolean(project.canvas.isShared);
  return (
    <div className="project-dialog-backdrop" onMouseDown={() => { if (!busy) onClose(); }}>
      <form
        className="project-dialog canvas-settings-dialog"
        aria-label={`画布设置：${project.canvas.name}`}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void access.saveCanvasSettings(project, { ownerUserId, shared }).then((saved) => { if (saved) onClose(); });
        }}
      >
        <div className="project-dialog-icon"><Settings2 size={22} /></div>
        <div>
          <h2>画布设置</h2>
          <p>“{project.canvas.name}”及其中的全部目录一起生效。</p>
        </div>
        <label>
          归属用户
          <select value={ownerUserId} onChange={(event) => setOwnerUserId(event.currentTarget.value)} disabled={busy || users === null} aria-label="归属用户">
            {!project.canvas.ownerUserId && <option value="">（无主画布）</option>}
            {currentMissing && <option value={project.canvas.ownerUserId ?? ""}>{ownerLabel(project.canvas) || "当前归属"}（已停用）</option>}
            {owners.map((user) => (
              <option key={user.id} value={user.id}>{user.displayName ? `${user.displayName}（${user.username}）` : user.username}{user.role === "admin" ? " · 管理员" : ""}</option>
            ))}
          </select>
        </label>
        <fieldset className="project-visibility-choice">
          <legend>谁能看到</legend>
          {([[false, "私有", "只有归属用户和管理员可见"], [true, "共享", "所有成员都能看到和编辑"]] as const).map(([value, label, hint]) => (
            <label key={label} className={shared === value ? "is-active" : ""}>
              <input type="radio" name="canvas-settings-visibility" checked={shared === value} onChange={() => setShared(value)} disabled={busy} />
              <strong>{label}</strong>
              <small>{hint}</small>
            </label>
          ))}
        </fieldset>
        {loadError && <p className="canvas-settings-error" role="alert">读取用户列表失败：{loadError}</p>}
        <div className="project-dialog-actions">
          <button type="button" className="dialog-cancel" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" className="primary-button" disabled={busy || !changed || !ownerUserId && Boolean(project.canvas.ownerUserId)}>
            {busy ? "正在保存…" : "保存"}
          </button>
        </div>
      </form>
    </div>
  );
}

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
  access?: ProjectHomeAccess;
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
  access,
}: ProjectHomeProps) {
  const groups = useMemo(
    () => (access ? groupProjects(visibleProjects, access.user) : null),
    [access, visibleProjects],
  );
  const [settingsProject, setSettingsProject] = useState<WorkspaceSnapshot | null>(null);
  const deleteWarning = access && projectToDelete ? othersPrivateDeleteWarning(projectToDelete.canvas, access.user) : null;
  const gridStyle = { gridTemplateColumns: `repeat(${projectColumns}, minmax(0, 1fr))` };
  const newProjectCard = (
    <button
      className="new-project-card"
      onClick={() => setCreateProjectOpen(true)}
      disabled={!projectHomeReady}
    >
      <span className="new-project-icon"><Plus size={26} /></span>
      <strong>新建项目</strong>
      <span>创建一张新的无限画布</span>
    </button>
  );
  const deleteButton = (project: WorkspaceSnapshot) => (
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
  );
  const renderCard = (project: WorkspaceSnapshot) => {
    const section = access ? projectSection(project.canvas, access.user) : null;
    const admin = access?.user.role === "admin";
    const deletable = !access || canDeleteProject(project.canvas, access.user);
    return (
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
              {!access && project.canvas.isPrivate && (
                <span className="project-private-badge" title="私密项目">
                  <LockKeyhole size={10} /> 私密
                </span>
              )}
              {section === "shared" && <span className="project-access-badge is-shared" title="所有成员可编辑">共享</span>}
              {section === "others" && (
                <span className="project-access-badge is-readonly" title="其他用户的私有画布，开启编辑模式后才能修改">
                  只读{ownerLabel(project.canvas) ? ` · ${ownerLabel(project.canvas)}` : ""}
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
          {access ? (
            <div className="project-card-actions">
              {canCopyProject(project.canvas, access.user) && (
                <button
                  type="button"
                  className="project-share-toggle project-copy-button"
                  disabled={access.copyingProjectId === project.canvas.id}
                  aria-label={`复制到我的画布：${project.canvas.name}`}
                  title="复制一份到“我的画布”（私有）；图片和视频引用同一文件"
                  onClick={(event) => {
                    event.stopPropagation();
                    void access.copySharedProject(project);
                  }}
                >
                  {access.copyingProjectId === project.canvas.id ? "复制中…" : "复制"}
                </button>
              )}
              {admin && (
                <button
                  type="button"
                  className="project-share-toggle project-settings-button"
                  disabled={access.sharingBusyId === project.canvas.id}
                  aria-label={`画布设置：${project.canvas.name}`}
                  title="归属用户、私有/共享"
                  onClick={(event) => {
                    event.stopPropagation();
                    setSettingsProject(project);
                  }}
                >
                  <Settings2 size={12} /> 设置
                </button>
              )}
              {deletable && deleteButton(project)}
            </div>
          ) : deleteButton(project)}
        </div>
      </article>
    );
  };
  const section = (title: string, hint: string, projects: WorkspaceSnapshot[], first?: React.ReactNode) => (
    <section className="project-owner-section" aria-label={title}>
      <h2>{title}<small>{projects.length} 个 · {hint}</small></h2>
      {projects.length || first ? (
        <div className="project-grid" style={gridStyle}>
          {first}
          {projects.map(renderCard)}
        </div>
      ) : <p className="project-section-empty">暂无</p>}
    </section>
  );
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

        {groups ? (
          <>
            {section("我的画布", "只有你和管理员可见", groups.mine, newProjectCard)}
            {section("共享画布", "所有成员都能编辑", groups.shared)}
            {access?.user.role === "admin" && (
              <section className="project-owner-section" aria-label="其他用户">
                <h2>其他用户<small>私有画布，进入后只读，开启编辑模式才能修改；可在此直接删除或改设置</small></h2>
                {groups.others.length ? groups.others.map((owner) => (
                  <div className="project-owner-group" key={owner.key || "ownerless"}>
                    <h3>{owner.label}<small>{owner.projects.length} 个</small></h3>
                    <div className="project-grid" style={gridStyle}>{owner.projects.map(renderCard)}</div>
                  </div>
                )) : <p className="project-section-empty">暂无</p>}
              </section>
            )}
          </>
        ) : (
          <div className="project-grid" style={gridStyle}>
            {newProjectCard}
            {visibleProjects.map(renderCard)}
          </div>
        )}
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
            {access && (
              <fieldset className="project-visibility-choice">
                <legend>谁能看到</legend>
                {([[false, "私有", "只有你和管理员可见"], [true, "共享", "所有成员都能看到和编辑"]] as const).map(([shared, label, hint]) => (
                  <label key={label} className={access.newProjectShared === shared ? "is-active" : ""}>
                    <input
                      type="radio"
                      name="project-visibility"
                      checked={access.newProjectShared === shared}
                      onChange={() => access.setNewProjectShared(shared)}
                    />
                    <strong>{label}</strong>
                    <small>{hint}</small>
                  </label>
                ))}
              </fieldset>
            )}
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
              {deleteWarning && <p className="project-delete-owner-warning">{deleteWarning}</p>}
              <p id="delete-project-description">
                “{projectToDelete.canvas.name}”中的所有节点和连线都会被永久删除，此操作无法撤销。
                {deleteWarning ? "图片和视频文件不会被删除。" : ""}
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
      {access && settingsProject && (
        <CanvasSettingsDialog project={settingsProject} access={access} onClose={() => setSettingsProject(null)} />
      )}
      {appSettingsDialog}
      {privateProjectVisibilityUnlockDialog}
      {globalNoticeToast}
    </main>
  );
}
