# Web 开发版验证记录

日期：2026-10-09。分支：`windows-web`。基于桌面版提交 `49881e5`，在独立 Git worktree 中实现；原 `D:\Data\CodexProjects\InfiniteCanvas` 的 main、已有未提交修改及文件保持原样。

## 已完成

- Web 与桌面前端分别构建成功；Web 发布包使用独立 Rust server feature 和静态 C runtime。
- JavaScript 回归测试：68 项通过。Rust server 单元测试：115 项通过。
- 桌面 Rust 单元测试：113 项通过。本机测试 EXE 最初因缺少 Common Controls v6 manifest 返回 `0xc0000139`；只给工作目录中的测试 EXE 注入该 manifest 后运行成功，未修改现有桌面安装。
- HTTP 测试 `python tests/webServerSmoke.py` 通过：登录、会话、Origin 校验、节点操作、上传、媒体分段读取、私有文件隔离、SSE、外部 Bearer API、模拟 ComfyUI 历史结果保留。
- 同一台 Windows 开发机上，把部署复制到另一个含空格的目录并改端口，通过打包脚本备份/恢复后，素材、封面、设置和内置工作流仍可读取。
- 完整 `.sucanvas-backup` 导出、暂存恢复、服务重启后恢复通过；登录密码保持有效，旧 ComfyUI 连接设置由当前服务器配置覆盖。
- PowerShell 脚本语法检查、Rust 格式检查及 Git diff 空白检查通过。EXE 依赖检查只包含 Windows 系统 DLL，不依赖 WebView/Tauri/独立 VC runtime。

## 待人工确认

没有使用 computer use 或浏览器自动化。尚未在另一台实际 Windows Server 上运行，也没有配置真实公网域名、HTTPS 代理或真实 ComfyUI 做生成验收。

按 README 的人工测试清单确认登录、画布编辑与刷新、媒体拖入和播放、工作流导入导出、生成进度、取消及恢复，再进行公网部署。HTTPS 代理需要转发 WebSocket、关闭 SSE 缓冲并允许长请求。

当前按个人单用户设计，建议同时使用一个编辑窗口。程序源代码已完成此轮实现，界面与目标服务器验收仍待反馈。
