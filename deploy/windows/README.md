# SuCanvas Web：Windows 便携部署

Web 开发分支为 `codex/windows-web`。现有桌面入口仍使用默认 `desktop` 构建；Web 服务使用独立 `server` 构建，不启动 Tauri/WebView。部署包不需要 Node、Rust 或 Docker。需要 Windows 10/11 或相应的 Windows Server x64 系统，以及可连接的 ComfyUI（使用生成功能时）。

## 在开发机器打包

在 Web 工作目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/web/Build-Web.ps1
```

脚本生成 `release-web/SuCanvas-Web`，包含 `SuCanvasServer.exe`、编译好的网页、FFmpeg、默认工作流包及运维脚本。FFmpeg 从开发机器复制，也可以使用 `-FfmpegPath` 指定。分发 FFmpeg 时应保留所使用发行版的许可证及对应源码获取说明。

```text
SuCanvas-Web/
  SuCanvasServer.exe
  config.json
  web/
  tools/ffmpeg.exe
  workflows/
  scripts/
  data/                # 首次初始化后创建
  downloads/           # 导出文件
  logs/                # 后台启动日志
```

不要将部署包放进现有桌面版的安装目录，也不要将 `dataDirectory` 指向桌面版的运行数据。

## 首次启动和人工测试

在部署包目录运行以下命令。密码通过隐藏输入传给程序，配置中保存 Argon2 密码哈希。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Set-Password.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Start-Web.ps1
```

浏览器访问 `http://127.0.0.1:18740`。默认只监听本机，方便开发阶段人工测试。后台日志位于 `logs`；需要直接查看启动错误时，可运行 `Start-Web.ps1 -Foreground`。

人工确认：登录和退出；新建项目、文本节点、连线、保存后刷新；拖入图片/音频/视频及播放；工作流 JSON/ZIP 导入导出；图片和视频下载；任务进度与取消；关闭网页后重新登录恢复任务；迁移后素材、封面、工作流及设置仍可用。真实 ComfyUI 生成及页面交互不由 computer use 自动测试。

## 公网配置

修改 `config.json` 的 `publicUrl` 为实际 HTTPS 域名，例如 `https://canvas.example.com`。在同一台服务器的 HTTPS 反向代理中，将该域名转发到 `http://127.0.0.1:18740`。保持原始浏览器 Origin，允许 WebSocket Upgrade，并关闭 `/api/events` 的响应缓冲；生成提交可能持续较长时间，应设置相应代理超时。公网只开放代理的 HTTPS 端口。

`publicUrl` 必须是域名根地址，不支持部署到子路径。除本机回环开发地址外，服务会拒绝 HTTP 公网配置。登录 Cookie 为 HttpOnly、SameSite=Strict，HTTPS 配置下同时设置 Secure；所有画布 API、上传及媒体访问均需要登录。

| 配置 | 含义 |
| --- | --- |
| `listen` | HTTP 后端监听地址，默认 `127.0.0.1:18740` |
| `publicUrl` | 浏览器实际访问的地址，公网必须 HTTPS |
| `dataDirectory` | 数据目录，默认相对于配置文件的 `data` |
| `webDirectory` | 编译后的网页目录，默认 `web` |
| `downloadsDirectory` | 导出暂存目录，默认 `downloads`，应放在 data 外面 |
| `comfyUrl` | 后端连接的 ComfyUI 地址；浏览器统一通过本服务转发 |
| `comfyInputDirectory` | 可选的 ComfyUI 输入目录，用于任务结束清理；必须由该服务器访问 |
| `comfyOutputDirectory` | 可选的原 ComfyUI 输出目录，用于旧素材兼容 |
| `maxUploadBytes` | 每次上传和单个生成文件保存上限，默认 1 GiB |

所有相对目录以 `config.json` 所在目录为基准，不依赖启动命令的当前目录。ComfyUI 地址和映射目录由服务器配置管理，网页中的对应输入只读。启动前配置的目录必须存在。通过网络共享访问目录时，运行服务的 Windows 用户需要相应权限。

项目和素材存入 SQLite 与 data 目录。素材引用以 `sucanvas://` 资源标识保存；已完成生成文件会流式复制到本服务的素材目录，避免旧项目依赖原 ComfyUI 的输出盘符。网页关闭后已提交的后端任务继续执行；重新打开时，已有画布占位节点及任务记录用于恢复结果。程序关闭或服务器重启会终止本服务的等待任务，ComfyUI 自身仍按其队列运行；重新打开画布后按 ComfyUI 历史记录恢复。

浏览器设置会同步到 `data/web-settings.json`，包含预设和任务恢复记录；当前版本按个人单用户设计，同一时间建议使用一个编辑窗口，多个窗口的设置修改采用最后保存的版本。服务器登录独立于桌面“应用锁”。

## 停止、备份和迁移

后台脚本启动的实例使用 `Stop-Web.ps1` 停止：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Stop-Web.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Backup-Web.ps1 -Destination E:\Backups\SuCanvas-20261009
```

脚本不会自动停止其他实例；备份前需要停止当前部署。备份包括 config 和整个 data（数据库 WAL、素材、工作流、设置和密码哈希）。迁移时，将完整部署目录复制到新服务器；相对目录配置下无需改盘符。调整域名、端口和 ComfyUI 配置后启动即可。`downloads` 仅是导出暂存文件，项目数据不依赖它。

恢复到一个已有的部署包：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Restore-Web.ps1 -BackupDirectory E:\Backups\SuCanvas-20261009
```

恢复保留目标服务器的 config，旧数据会移动到带时间戳的 `data.before-restore-*`，再复制备份数据。不要删除旧目录，直到人工确认恢复正确。修改登录密码需要先停止服务，再运行 `Set-Password.ps1`。

网页中的完整软件备份也可以使用；恢复后需要由管理员重启服务。当前服务器登录密码不会被导入的桌面备份覆盖。首次从桌面版迁移时，请通过备份导出/导入，避免直接共用或覆盖正在运行的桌面数据库。

`data/api.json` 为外部工具提供 `/v1` API 地址和独立 Bearer 令牌。此令牌与登录密码、数据库和备份都属于私有文件；不要把 data 目录配置为静态网站目录，也不要上传到 Git。

## 开机自启

按当前 Windows 用户登录时启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Install-Autostart.ps1
```

无用户登录也在系统启动时运行，可在管理员 PowerShell 中执行 `Install-Autostart.ps1 -AtBoot`。该模式使用 SYSTEM；需要确认其目录权限和 ComfyUI 网络共享访问权限。计划任务直接运行 EXE，停止它请使用任务计划程序，而不是 Stop-Web.ps1。迁移目录后应先删除旧任务（`Install-Autostart.ps1 -Remove`），再在新目录重新注册。

## 更新

先停止当前部署。替换 EXE、web、tools 和发布自带的 workflows；保留 config、data 和用户备份。程序复用现有 SQLite 初始化/迁移逻辑，启动时检查数据库完整性。更新前保留整份备份；迁移和新版页面仍需要人工验收。
