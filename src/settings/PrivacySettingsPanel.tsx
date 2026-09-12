import {
  Eye,
  EyeOff,
  FolderKanban,
  LockKeyhole,
  Search,
  X
} from "lucide-react";
import type {
  WorkspaceSnapshot
} from "../CanvasNode";

type PrivacySettingsPanelProps = {
  showPrivateProjects: boolean;
  togglePrivateProjectVisibility: () => void;
  privateProjectSearch: string;
  setPrivateProjectSearch: React.Dispatch<React.SetStateAction<string>>;
  filteredPrivateProjects: WorkspaceSnapshot[];
  projects: WorkspaceSnapshot[];
  privateProjectBusyId: string | null;
  changeProjectPrivacy: (projectId: string, isPrivate: boolean) => Promise<void>;
};

export function PrivacySettingsPanel({
  showPrivateProjects,
  togglePrivateProjectVisibility,
  privateProjectSearch,
  setPrivateProjectSearch,
  filteredPrivateProjects,
  projects,
  privateProjectBusyId,
  changeProjectPrivacy,
}: PrivacySettingsPanelProps) {
  return (
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
  );
}
