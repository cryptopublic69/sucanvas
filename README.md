# InfiniteCanvas

基于 Tauri 2、React Flow 与 SQLite 的本地无限画布。首版支持文本节点、节点连线、自动保存，以及通过本地 API 接收 Codex/Reasonix 生成的内容。

数据模型从一开始就是通用的 `nodes + edges`，文本提示词只是第一个节点类型，后续可以继续加入图片、视频、生成任务和产物节点。

## 开发运行与实时预览

直接双击项目根目录的 `dev.cmd`，或在终端运行：

```powershell
.\dev.cmd
```

启动器会自动定位 Cargo、检查 Node/npm、在缺少 `node_modules` 时安装依赖，并启动 Tauri 2 + Vite 热更新。React/CSS 修改会立即刷新，Rust 修改会触发增量重编译；再次运行时会识别已经启动的本项目，避免重复实例。

只检查开发环境和端口状态：

```powershell
.\dev.cmd --check
```

启动日志保存在 `%LOCALAPPDATA%\InfiniteCanvas\dev-launcher.log`。

启动后会在 `%LOCALAPPDATA%\InfiniteCanvas\api.json` 写入当前 API 地址与临时访问令牌。应用关闭再启动后端口和令牌会更新。

## 本地 API

- 健康检查：`GET /v1/health`
- 创建节点：`POST /v1/nodes`
- 鉴权：`Authorization: Bearer <api.json 中的 token>`

示例请求体：

```json
{
  "kind": "text",
  "title": "新提示词",
  "content": { "text": "由 Codex 或 Reasonix 生成的内容" },
  "source": "codex",
  "requestId": "可选的幂等请求 ID"
}
```
