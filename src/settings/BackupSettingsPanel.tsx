import {
  DatabaseBackup,
  RotateCcw
} from "lucide-react";
import type {
  RuntimeInfo
} from "../CanvasNode";

type BackupSettingsPanelProps = {
  exportFullAppBackup: () => Promise<void>;
  appBackupBusy: boolean;
  chooseFullAppBackupToRestore: () => Promise<void>;
  runtime: RuntimeInfo | null;
  appBackupMessage: string;
  appBackupMessageKind: "success" | "error";
};

export function BackupSettingsPanel({
  exportFullAppBackup,
  appBackupBusy,
  chooseFullAppBackupToRestore,
  runtime,
  appBackupMessage,
  appBackupMessageKind,
}: BackupSettingsPanelProps) {
  return (
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
  );
}
