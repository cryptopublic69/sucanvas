import {
  Plus,
  Search,
  Trash2,
  Upload
} from "lucide-react";
import type {
  WorkflowCapability,
  WorkflowModuleRecord,
  WorkflowModuleValidation,
  WorkflowVariant
} from "../CanvasNode";
import {
  DEFAULT_H3_FIRST_LAST_WORKFLOW_PATH,
  DEFAULT_H3_IMAGE_TO_VIDEO_WORKFLOW_PATH,
  DEFAULT_H3_LAST_FRAME_TO_VIDEO_WORKFLOW_PATH,
  DEFAULT_H3_REFERENCE_WORKFLOW_PATH,
  SettingsSelect,
  WORKFLOW_CAPABILITIES,
  WORKFLOW_PACKAGE_ENGINE,
  WORKFLOW_VIDEO_VARIANTS,
  workflowModuleFamilyKey,
  workflowVariantLabel
} from "../CanvasNode";

type WorkflowSettingsPanelProps = {
  showDeletedWorkflowModules: boolean;
  setShowDeletedWorkflowModules: React.Dispatch<React.SetStateAction<boolean>>;
  workflowModuleSearch: string;
  setWorkflowModuleSearch: React.Dispatch<React.SetStateAction<string>>;
  setWorkflowModuleSortDirection: React.Dispatch<React.SetStateAction<"asc" | "desc">>;
  workflowModuleSortDirection: "asc" | "desc";
  workflowModules: WorkflowModuleRecord[];
  selectedWorkflowModuleId: string;
  setSelectedWorkflowModuleId: React.Dispatch<React.SetStateAction<string>>;
  workflowModuleVisibleIds: string[];
  setWorkflowModuleNameDraft: React.Dispatch<React.SetStateAction<string>>;
  setWorkflowModuleRevisionDraft: React.Dispatch<React.SetStateAction<string>>;
  setWorkflowModuleCapabilityDraft: React.Dispatch<React.SetStateAction<WorkflowCapability>>;
  setWorkflowModuleVariantDraft: React.Dispatch<React.SetStateAction<WorkflowVariant>>;
  setWorkflowModulePathDraft: React.Dispatch<React.SetStateAction<string>>;
  h3WorkflowPathDraft: string;
  setWorkflowModuleValidation: React.Dispatch<React.SetStateAction<WorkflowModuleValidation | null>>;
  setWorkflowModuleBindingsDraft: React.Dispatch<React.SetStateAction<string>>;
  importWorkflowModuleBundle: () => Promise<void>;
  workflowModulesBusy: boolean;
  selectedWorkflowModule: WorkflowModuleRecord | null;
  setWorkflowModuleFrontendVisibility: (module: WorkflowModuleRecord, visible: boolean) => void;
  setWorkflowModuleDeletionMode: React.Dispatch<React.SetStateAction<"trash" | "purge" | null>>;
  workflowModuleNameDraft: string;
  workflowModuleRevisionDraft: string;
  workflowModuleCapabilityDraft: WorkflowCapability;
  workflowModuleVariantDraft: WorkflowVariant;
  workflowModulePathDraft: string;
  workflowModuleBindingsDraft: string;
  workflowModuleValidation: WorkflowModuleValidation | null;
  workflowModuleUsageCount: (moduleId: string) => number;
  workflowModuleReplacementId: string;
  setWorkflowModuleReplacementId: React.Dispatch<React.SetStateAction<string>>;
  validateWorkflowModuleDraft: () => Promise<void>;
  saveWorkflowModuleDraft: (overwrite: boolean) => Promise<void>;
  exportSelectedWorkflowModule: () => Promise<void>;
  requestWorkflowModuleRestore: () => Promise<void>;
  restoreSelectedWorkflowModuleBackup: () => Promise<void>;
  restoreSelectedWorkflowModule: () => Promise<void>;
  workflowModulesReady: boolean;
};

export function WorkflowSettingsPanel({
  showDeletedWorkflowModules,
  setShowDeletedWorkflowModules,
  workflowModuleSearch,
  setWorkflowModuleSearch,
  setWorkflowModuleSortDirection,
  workflowModuleSortDirection,
  workflowModules,
  selectedWorkflowModuleId,
  setSelectedWorkflowModuleId,
  workflowModuleVisibleIds,
  setWorkflowModuleNameDraft,
  setWorkflowModuleRevisionDraft,
  setWorkflowModuleCapabilityDraft,
  setWorkflowModuleVariantDraft,
  setWorkflowModulePathDraft,
  h3WorkflowPathDraft,
  setWorkflowModuleValidation,
  setWorkflowModuleBindingsDraft,
  importWorkflowModuleBundle,
  workflowModulesBusy,
  selectedWorkflowModule,
  setWorkflowModuleFrontendVisibility,
  setWorkflowModuleDeletionMode,
  workflowModuleNameDraft,
  workflowModuleRevisionDraft,
  workflowModuleCapabilityDraft,
  workflowModuleVariantDraft,
  workflowModulePathDraft,
  workflowModuleBindingsDraft,
  workflowModuleValidation,
  workflowModuleUsageCount,
  workflowModuleReplacementId,
  setWorkflowModuleReplacementId,
  validateWorkflowModuleDraft,
  saveWorkflowModuleDraft,
  exportSelectedWorkflowModule,
  requestWorkflowModuleRestore,
  restoreSelectedWorkflowModuleBackup,
  restoreSelectedWorkflowModule,
  workflowModulesReady,
}: WorkflowSettingsPanelProps) {
  return (
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
          <div className="workflow-module-list-tools">
            <label className="workflow-module-search">
              <Search size={13} aria-hidden="true" />
              <input
                type="search"
                value={workflowModuleSearch}
                onChange={(event) => setWorkflowModuleSearch(event.currentTarget.value)}
                placeholder="搜索工作流名称"
                aria-label="搜索工作流名称"
              />
            </label>
            <button
              type="button"
              className="workflow-module-sort"
              onClick={() => setWorkflowModuleSortDirection((current) => (
                current === "asc" ? "desc" : "asc"
              ))}
              title={workflowModuleSortDirection === "asc" ? "当前按名称升序，点击改为降序" : "当前按名称降序，点击改为升序"}
            >
              名称 {workflowModuleSortDirection === "asc" ? "A–Z" : "Z–A"}
            </button>
          </div>
          {WORKFLOW_CAPABILITIES.map((capability) => {
            const search = workflowModuleSearch.trim().toLocaleLowerCase();
            const modules = workflowModules
              .filter((module) => (
                module.capability === capability.value
                && (showDeletedWorkflowModules || !module.deletedAt)
                && (!search || module.name.toLocaleLowerCase().includes(search))
              ))
              .sort((left, right) => {
                const comparison = left.name.localeCompare(right.name, "zh-CN", {
                  numeric: true,
                  sensitivity: "base",
                }) || left.revision.localeCompare(right.revision, "zh-CN", {
                  numeric: true,
                  sensitivity: "base",
                });
                return workflowModuleSortDirection === "asc" ? comparison : -comparison;
              });
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
                      {workflowModuleVisibleIds.includes(module.id) ? " · 前端显示" : ""}
                      {module.deletedAt ? " · 回收站" : ""}
                    </small>
                  </button>
                ))}
                {!modules.length && <p>{workflowModuleSearch.trim() ? "无匹配方案" : "尚无方案"}</p>}
              </section>
            );
          })}
          <button
            type="button"
            className="workflow-module-new"
            onClick={() => {
              setSelectedWorkflowModuleId("");
              setWorkflowModuleNameDraft("新工作流方案");
              setWorkflowModuleRevisionDraft("V2");
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
                <label className="workflow-module-frontend-toggle">
                  <input
                    type="checkbox"
                    checked={workflowModuleVisibleIds.includes(selectedWorkflowModule.id)}
                    onChange={(event) => setWorkflowModuleFrontendVisibility(
                      selectedWorkflowModule,
                      event.currentTarget.checked,
                    )}
                  />
                  <span>显示在前端</span>
                </label>
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
                  label: capability.label,
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
                    && workflowModuleFamilyKey(module) === workflowModuleFamilyKey(selectedWorkflowModule)
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
  );
}
