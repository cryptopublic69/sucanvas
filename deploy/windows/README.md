# SuCanvas Web：Windows 便携部署

Web 开发分支为 `windows-web`。Cargo 默认构建 Web 服务（`server` feature），不启动 Tauri/WebView；桌面版已冻结，需单独使用 `--no-default-features --features desktop` 构建，`npm run tauri dev`/`npm run tauri build` 会自动传入这两个参数。部署包不需要 Node、Rust 或 Docker。需要 Windows 10/11 或相应的 Windows Server x64 系统，以及可连接的 ComfyUI（使用生成功能时）。

Web 更新长期记录在 [UPDATELOG.md](../../UPDATELOG.md)，按日期和 `windows-web` 标记维护，记录迁移要求、验证结果与人工验收情况。

## 在开发机器打包

在 Web 工作目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/web/Build-Web.ps1
```

脚本生成 `release-web/SuCanvas-Web`，包含 `SuCanvasServer.exe`、编译好的网页、FFmpeg、默认工作流包及运维脚本。FFmpeg 从开发机器复制，也可以使用 `-FfmpegPath` 指定。分发 FFmpeg 时应保留所使用发行版的许可证及对应源码获取说明。

每次发布生成唯一的 `assets/<版本>/` 目录，由 Vite 同时处理入口、模块导入和预加载引用；重复打包同一提交也不会复用上次的资源地址。`build-info.json` 记录源码提交与资源版本，`web-assets.json` 记录本次网页和全部资源的哈希，用于检查错误缓存、漏传文件和错误上游。无需手动给单个脚本加 URL 参数。

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

日常开发无需反复打包：在本机 Web 源码目录使用 `scripts/web/Start-WebDev.ps1 -DeploymentDirectory <远端共享部署目录>`，前后端都在本机运行，前端保存后热更新，Rust 保存后自动编译重启。远端目录仅用于初始读取 ComfyUI 地址和登录密码哈希；本机测试数据独立保存。人工验收后再更新正式服务器。详细启动和停止方式见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 首次启动和人工测试

在部署包目录运行以下命令。密码通过隐藏输入传给程序，Argon2 密码哈希保存在 data/app-lock.json。首次启动时，服务用这个哈希创建 `admin` 账号（密码相同），之后 Web 登录使用用户名 + 密码，`Set-Password.ps1` 不再改变已有账号的密码。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Set-Password.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Start-Web.ps1
```

浏览器访问 `http://127.0.0.1:18740`。默认只监听本机，方便开发阶段人工测试。后台日志位于 `logs`；需要直接查看启动错误时，可运行 `Start-Web.ps1 -Foreground`。

人工确认：登录和退出；新建项目、文本节点、连线、保存后刷新；拖入图片/音频/视频及播放；工作流 JSON/ZIP 导入导出；图片和视频下载；任务进度与取消；关闭网页后重新登录恢复任务；迁移后素材、封面、工作流及设置仍可用。真实 ComfyUI 生成及页面交互不由 computer use 自动测试。

## 公网配置

修改 `config.json` 的 `publicUrl` 为实际 HTTPS 域名，例如 `https://canvas.example.com`。在同一台服务器的 HTTPS 反向代理中，将该域名转发到 `http://127.0.0.1:18740`。保持原始浏览器 Origin，允许 WebSocket Upgrade，并关闭 `/api/events` 的响应缓冲；生成提交可能持续较长时间，应设置相应代理超时。公网只开放代理的 HTTPS 端口。

`publicUrl` 必须是域名根地址，不支持部署到子路径。除本机回环开发地址外，服务会拒绝 HTTP 公网配置。登录 Cookie 为 HttpOnly、SameSite=Strict，HTTPS 配置下同时设置 Secure；所有画布 API、上传及媒体访问均需要登录。

同时使用公网和局域网时，保留 `publicUrl` 为公网入口，并在 `allowedOrigins` 中明确列出额外的 HTTPS 入口，例如 `["https://192.168.5.108:18741"]`。协议、主机和端口必须匹配浏览器地址；不支持通配符、HTTP 或子路径。反向代理也必须提供对应的 HTTPS 站点。修改后需通过服务开关重启后端。登录、素材链接和任务通知使用当前浏览器入口，两个入口分别保持登录会话。

| 配置 | 含义 |
| --- | --- |
| `listen` | HTTP 后端监听地址，默认 `127.0.0.1:18740` |
| `publicUrl` | 浏览器实际访问的地址，公网必须 HTTPS |
| `allowedOrigins` | 可选的额外 HTTPS 入口列表，默认空；publicUrl 自动允许 |
| `dataDirectory` | 数据目录，默认相对于配置文件的 `data` |
| `webDirectory` | 编译后的网页目录，默认 `web` |
| `downloadsDirectory` | 导出暂存目录，默认 `downloads`，应放在 data 外面 |
| `comfyUrl` | 后端连接的 ComfyUI 地址；浏览器统一通过本服务转发 |
| `comfyInputDirectory` | ComfyUI 输入根目录；导入素材存入其 `sucanvas-imports` 子目录，任务临时输入独立清理 |
| `comfyOutputDirectory` | ComfyUI 输出根目录；生成图片和视频直接引用此目录中的文件，永久删除也定位此处 |
| `maxUploadBytes` | 每次上传的大小上限，默认 1 GiB |

所有相对目录以 `config.json` 所在目录为基准，不依赖启动命令的当前目录。ComfyUI 地址和映射目录可在网页“基础设置”编辑，点击“保存基础设置”后写入服务器 `config.json`，新请求立即生效，无需重启。每次保存保留一份 `config.before-comfy-*.json` 原配置。已提交任务保留原连接配置；建议任务结束后再切换 ComfyUI 地址。页面显示实际 ComfyUI 地址，浏览器请求仍统一通过画布服务器转发。

映射目录必须是运行 Web 后端的机器可以访问的现有目录。Web 与 ComfyUI 在同一台服务器时，填写服务器本机盘符对应的 `input` 和 `output` 根目录，不使用浏览器电脑的映射盘符。没有输入映射时不能导入素材；没有输出映射时生成结果仍可通过 ComfyUI 代理预览和下载，但不能通过文件路径引用或永久删除原件。通过网络共享访问目录时，运行服务的 Windows 用户需要相应权限。手动编辑 `config.json` 的其他配置仍需重启服务。

`data` 只保存项目数据库、设置、工作流、上传暂存和预览缓存，不再创建或使用 `data/assets` 作为素材库。导入的图片、音频、视频保存到 ComfyUI `input/sucanvas-imports`；成功导入后删除上传暂存文件。生成图片和视频仅关联 ComfyUI `output` 中的文件，不再自动复制媒体。项目中的输入、输出资源引用与配置的映射目录关联，可更换部署路径而不依赖浏览器电脑盘符。网页关闭后已提交的后端任务继续执行；重新打开时，已有画布占位节点及任务记录用于恢复结果。程序关闭或服务器重启会终止本服务的等待任务，ComfyUI 自身仍按其队列运行；重新打开画布后按 ComfyUI 历史记录恢复。

视频删除保留“取消／仅删除节点／同时删除文件”：仅删除节点保留文件并支持撤销；同时删除文件删除 ComfyUI 中的对应文件，无法撤销。未配置输出映射时，生成视频的永久删除会提示先配置目录。

旧项目迁移：首次填写并保存输入、输出映射时，自动创建 `backup/storage-migration-*/before-migration.sucanvas-backup`，校验素材字节后在数据库事务中更新节点、封面及历史快照引用。旧生成副本与原件内容相同时直接复用原件；原件缺失或同名文件内容不同时，将旧副本保存在 `output/sucanvas-migrated`，保留项目原来的画面且不覆盖其他生成结果。旧导入素材迁入 `input/sucanvas-imports`。完成后原素材目录归档到备份区，不再作为活动存储。无法找到原件且没有旧副本可修复时，迁移报错并保留项目原引用，可修正映射后重试。启动或恢复备份时也会检查待迁移的旧素材。

软件备份包含数据库与导入的 input 素材，恢复时重新写入配置的输入目录。生成 output 文件保持外部原件引用，与单机版一致；迁移前的完整旧数据备份另外保留。人工验收包括旧项目预览、导入素材、生成图片与视频只产生一份、三种删除选择，以及输入素材的软件备份恢复。

Web 版预览下方的媒体按钮为“下载视频／下载图片”，与右键下载使用同一路径。已保存素材从画布服务器下载；从桌面备份导入的旧生成结果通过 ComfyUI 代理下载，不要求输出映射目录。浏览器按其下载设置选择保存位置，Web 版不会打开服务器的 Windows 资源管理器。

浏览器设置会同步到 `data/web-settings.json`，包含预设和任务恢复记录；当前版本按个人单用户设计，同一时间建议使用一个编辑窗口，多个窗口的设置修改采用最后保存的版本。

Web 使用用户名 + 密码登录，账号由管理员创建；登录后由服务器建立访问会话，项目、上传、素材下载、生成接口和事件连接均检查会话和画布归属。刷新网页时有效会话继续使用；退出登录、会话过期或服务器重启后需重新登录。外部工具的 `/v1` API 使用独立 Bearer 令牌授权，令牌视为管理员；登录用户只有管理员可以调用 `/v1`。

升级时优先使用已有 `data/app-lock.json` 的应用锁密码；没有应用锁配置时，自动沿用旧 Web 登录密码，将 `web-auth.json` 迁移并归档为 `web-auth.before-app-lock-*.json`。旧密码不会同时作为第二套密码继续使用。应用锁配置损坏或没有任何密码配置时，服务拒绝启动，可停止服务后运行 `Set-Password.ps1` 重设。

每个用户在用户菜单中修改自己的密码，使用与桌面版相同的 4–128 字符规则；修改后此账号的其他会话立即失效。Web 不提供应用锁开关，接口也拒绝应用锁命令；桌面版仍使用本机应用锁。

忘记 admin 密码时，先停止服务，再运行 `Reset-AdminPassword.ps1`（隐藏输入新密码）。它把 `admin` 账号的密码改为新密码、重新启用账号且不要求下次改密；服务运行中时程序会拒绝执行。没有 HTTP 入口。

## 停止、备份和迁移

后台脚本启动的实例使用 `Stop-Web.ps1` 停止：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Stop-Web.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Backup-Web.ps1
```

脚本不会自动停止其他实例；备份前需要停止当前部署。备份包括 config 和整个 data（数据库 WAL、素材、工作流、设置和密码哈希）。迁移时，将完整部署目录复制到新服务器；相对目录配置下无需改盘符。调整域名、端口和 ComfyUI 配置后启动即可。`downloads` 仅是导出暂存文件，项目数据不依赖它。

脚本数据备份、更新前完整备份和脚本恢复前的旧数据都统一保存在部署目录的 `backup` 下；108 对应 `F:\SuCanvas-Web\backup`。目录不存在时自动创建。可用 `-Destination` 指定该目录内的子目录，不能指定其他位置。

恢复到一个已有的部署包：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Restore-Web.ps1 -BackupDirectory .\backup\data-20261009-120000-example
```

恢复保留目标服务器的 config，旧数据会移动到 `backup/data-before-restore-*`，再复制备份数据。不要删除旧目录，直到人工确认恢复正确。忘记 admin 密码时先停止服务，再运行 `Reset-AdminPassword.ps1`。账号、密码和画布归属保存在数据库里，两种恢复都会把它们一起带回备份时的状态；脚本整目录恢复还会带回备份中的 app-lock.json，网页完整软件备份恢复则保留当前服务器的 app-lock.json。恢复 012 用户系统之前的备份时，启动会重新迁移：用当前 app-lock.json 的密码重建 admin，全部画布归 admin 私有。

网页中的完整软件备份也可以使用；恢复后需要由管理员重启服务。当前服务器应用锁密码不会被导入的桌面备份覆盖。首次从桌面版迁移时，请通过备份导出/导入，避免直接共用或覆盖正在运行的桌面数据库。

软件备份中的 SQLite 文件由 `VACUUM INTO` 生成，是包含当时已提交数据的完整快照。新备份不再收集原数据库的 WAL、SHM 和 rollback journal；导入旧备份时也会跳过这些临时文件，避免它们覆盖快照中的不同页面布局。旧备份通常无需重新导出；真正损坏的快照仍会被完整性校验拒绝。这个规则只适用于软件导出的 `.sucanvas-backup`，不能用于手动复制正在运行的原数据库。

恢复时按整个 data 根目录迁移引用路径，包括素材、临时缩放输入、上传文件和工作流模块。备份校验成功后，数据仍处于等待重启状态；重启后端并刷新、重新登录网页，项目才会加载。备份数据目录外的文件引用不会被自动改为允许访问的路径。

重启恢复时，服务器会先把备份中的界面设置和预设写入 `data/web-settings.json`，保存成功后才接受网页请求。网页登录后直接读取恢复后的设置，不依赖浏览器刷新或退出时的异步保存。如果旧版本已恢复过备份但设置未保留，更新后需要重新导入原备份并重启服务。此次恢复会替换现有项目和数据，导入前请先备份。

`data/api.json` 为外部工具提供 `/v1` API 地址和独立 Bearer 令牌。此令牌与登录密码、数据库和备份都属于私有文件；不要把 data 目录配置为静态网站目录，也不要上传到 Git。

## 开机自启

按当前 Windows 用户登录时启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Install-Autostart.ps1
```

无用户登录也在系统启动时运行，可在管理员 PowerShell 中执行 `Install-Autostart.ps1 -AtBoot`。该模式使用 SYSTEM；需要确认其目录权限和 ComfyUI 网络共享访问权限。计划任务直接运行 EXE，停止它请使用任务计划程序，而不是 Stop-Web.ps1。迁移目录后应先删除旧任务（`Install-Autostart.ps1 -Remove`），再在新目录重新注册。

## 更新

108 的日常更新使用服务器本地入口 `F:\SuCanvas-Web-Update\Update-OnServer.bat`。开发机只上传更新包到同目录的 `package` 文件夹；上传完成后，通过现有开关停止服务，再在 108 本机双击该入口。备份、SHA-256 校验和替换全部在服务器本地磁盘执行，拒绝从 UNC 路径或映射网络盘运行。完成后通过原开关启动服务，并刷新网页人工验收。日志写入更新目录的 `logs`，结果写入 `deployment-result.json`。

每次上传用完整的新包替换 `package`，不要混入旧包文件。包内有 `SuCanvasServer.exe` 时更新服务程序和前端；仅有 `web`、`web-assets.json`、`build-info.json` 和用于校验的 `config.json` 时只更新前端。完整备份仍保存在正式部署的 `backup/before-update-*`；更新包的配置不会覆盖现有配置，脚本不会自动启停服务。

先停止当前部署。替换 EXE、web 和发布自带的 workflows；保留 config、data、现有 tools 和用户备份。需要升级 FFmpeg 时再单独更换 tools。程序复用现有 SQLite 初始化/迁移逻辑，启动时检查数据库完整性。更新前保留整份备份；迁移和新版页面仍需要人工验收。

可使用新发布包中的脚本更新已有部署：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File E:\NewPackage\scripts\Update-WebFiles.ps1 -PackageDirectory E:\NewPackage -DeploymentDirectory F:\SuCanvas-Web -PublicUrl https://sucanvas.geeksbar.com:8888
```

脚本不负责服务启停。先由独立开关程序停止后端；脚本检查 EXE 与服务锁、把整个部署备份到 `backup/before-update-*`，校验备份后替换程序、工作流和脚本，最后发布网页入口并检查结果。配置、数据、HTTPS 代理、启停程序和现有 FFmpeg 保留；发现错误时恢复旧发布文件。使用相对 dataDirectory 和默认 webDirectory=web，迁移时不复制正在运行的数据库。

## 新服务器部署检查

新服务器复制完整发布包并初始化密码；迁移已有数据时先停服复制整个 data，或使用备份恢复。每台服务器按实际环境确认 `publicUrl`、`allowedOrigins`、监听地址、ComfyUI 地址和目录映射，不把旧服务器域名、IP 或盘符作为新服务器默认值。浏览器入口必须匹配 `publicUrl` 或 `allowedOrigins` 中的一个地址，包括 HTTPS 和非默认端口；使用域名根路径。

如果 Nginx 直接转发到同机后端，可使用下面的 location；TLS 证书和外部监听端口由 Nginx 的 server 配置提供。保留浏览器 Origin，不改写为内部 IP。

```nginx
location / {
    proxy_pass http://127.0.0.1:18740;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    client_max_body_size 1g;
}
```

如果 Nginx 转发到另一台机器上的 Caddy HTTPS 端口，Caddy 站点必须同时匹配浏览器域名和需要保留的内部 IP；Caddy 的监听端口使用内部 HTTPS 端口，不是外部端口映射值。例如 108 的站点地址为 `https://192.168.5.108:18741, https://sucanvas.geeksbar.com:18741`，应用 publicUrl 为 `https://sucanvas.geeksbar.com:8888`。新服务器要替换内部 IP、绑定地址、存储路径和域名。若已有 Nginx 静态资源缓存规则，不能缓存空响应和错误响应；发布后检查实际资源内容。

部署配置后先运行静态检查，由自己的开关程序启动后端和代理，再运行外网检查：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Test-WebDeployment.ps1 -PublicUrl https://sucanvas.geeksbar.com:8888
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Test-WebDeployment.ps1 -PublicUrl https://sucanvas.geeksbar.com:8888 -CheckHttp
```

检查会比对应用访问地址、Caddy 域名匹配、网页和全部资源文件；外网检查逐个核对哈希和 JS/CSS 类型，拒绝“HTTP 200 但内容为空”、旧缓存和错误上游，并确认未登录会话返回 401。检查通过后仍由人工确认解锁、项目、上传、备份、下载与真实生成。
