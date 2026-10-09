# 本机前后端开发，验收后部署到 108

只在 `windows-web` 源码工作目录维护 Web 开发环境。浏览器连接本机 Vite 和本机 Rust 后端；正式服务器继续运行已部署版本。日常修改不需要构建发布包或复制文件到服务器。

## 启动和停止

开发机器需要 Node.js（Vite 7 支持的版本）、Rust、Visual Studio C++ Build Tools 和 FFmpeg。在 Web 源码目录首次执行 `npm ci`，然后启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/web/Start-WebDev.ps1 -DeploymentDirectory Y:\SuCanvas-Web
```

`-DeploymentDirectory` 仅在初始化本机环境时读取服务器的 ComfyUI 地址和登录密码哈希；服务器文件不会被修改，本机前端也不会连接远端 Web API。本机开发登录密码初始与服务器一致。开发数据是全新的独立目录；若需要现有项目及预设，通过网页导入系统备份，并停止、重启本机开发服务完成恢复。

脚本启动后台开发进程，首次 Rust 编译可能需要几分钟。`.web-dev/dev-status.json` 的 `state` 为 `ready` 后，打开 `http://127.0.0.1:1422` 人工测试。编译和服务日志保存在 `.web-dev/dev-*.out.log`、`.web-dev/dev-*.err.log`。需要前台日志时加 `-Foreground`，通过 Ctrl+C 停止。

后台服务的停止方式：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/web/Stop-WebDev.ps1
```

第一次初始化后不需要再指定服务器目录，直接运行 `Start-WebDev.ps1` 即可。若没有现有部署，可用 `-CredentialsFile` 指定已有的 `app-lock.json`（兼容旧 `web-auth.json`），用 `-FfmpegPath` 指定 FFmpeg。默认优先使用已有发布目录中的 FFmpeg，其次查找 PATH。

Web 只使用一套应用锁密码。本机已有应用锁时保留它；旧开发环境只有 Web 登录密码时自动沿用并迁移。页面使用原应用锁解锁界面，密码同时保护后端接口；设置中可改密码，不能关闭 Web 访问保护。迁移前保存密码配置备份，人工确认升级后的解锁与改密码行为。

## 保存源码后的效果

| 改动 | 生效方式 |
| --- | --- |
| React、TypeScript、CSS | 保存后由 Vite 热更新，部分模块改动会刷新页面 |
| Rust 源码、Cargo.toml、Cargo.lock、build.rs | 自动检测，编译成功后重启本机 Rust 后端 |
| Rust 编译错误 | 查看错误日志；上一版后端继续运行，修改保存后再编译 |
| 工作流 JSON | 开发后端通过目录链接直接读取源码中的工作流 |
| 网页“基础设置”的 ComfyUI 地址和映射目录 | 点击保存后写入本机 config.json，新请求立即生效 |
| 本机 config.json、开发启动脚本 | 停止并重新启动开发服务 |
| 正式发布 | 人工验收通过后再构建发布版本、备份并更新 108 |

Rust 后端没有前端式热替换；编译和重启由脚本完成。重启会清除当前网页登录会话，需要时重新登录；正在等待的生成任务也会中断，请完成生成后再修改后端。ComfyUI 自身的队列继续运行。

## 数据和端口

前端默认 `127.0.0.1:1422`，后端默认 `127.0.0.1:18742`，均只监听本机。桌面版开发端口仍为 1420。浏览器的 API、素材、SSE 和 ComfyUI WebSocket 请求统一经 Vite 转发给本机后端，ComfyUI 连接由本机后端发起。

本机配置位于 `.web-dev/runtime/config.json`，测试数据库、素材、设置和密码哈希位于 `.web-dev/runtime/data`。这些文件和日志均被 Git 忽略，不进入发布包。不要将本机配置的数据目录指向桌面版或服务器正在使用的数据目录。首次初始化不复制服务器的盘符目录；需要兼容旧素材路径时，在网页基础设置中填写本机后端可访问的共享路径。

后台运行的 EXE 是编译结果的独立副本，Cargo 编译时不会因 Windows 的运行文件锁而要求提前停止后端。新 EXE 启动失败时尝试恢复上一版，并在状态文件与日志中报告失败。

界面交互、可见热更新、真实 ComfyUI 生成及备份导入均由人工测试确认，不使用 computer use 自动测试。

## 更新 108

开发期间保留 `windows-web` 分支，与 `main` 分开。人工验收后再生成正式发布文件：先备份 108 的现有版本与数据，停止其服务，替换 EXE 和网页文件，保留远端 config、data 和登录密码，重新启动并人工复核。部署需要 108 上的命令执行方式（例如 SSH），或在 108 本机运行停止/启动脚本；共享目录本身只提供文件访问。

源码开发环境留在本机，108 无需安装 Node.js 或 Rust。
