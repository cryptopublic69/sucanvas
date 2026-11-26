# SuCanvas Web Agent H3 Video API (`/v1/agent/*`)

All endpoints require `Authorization: Bearer <token>` (from SuCanvas Web `data/web-integration-token`). Requests do not require cookies or browser `Origin` headers.

## Endpoints

### 1. Discover capabilities & presets
`GET /v1/agent/capabilities`

Returns:
- `channels.local`: `{ configured, inputDirectoryConfigured, outputDirectoryConfigured }`
- `channels.colab`: `{ configured, reachable, available, effectiveProfile, label, diffusionModelName, allowedLoras, samplerOptions, error }`
- `workflows`: active `video-generation` modules (`id`, `name`, `variant`, `revision`, `isDefault`, `defaultDiffusionModelName`)
- `presets.local`: `{ defaultPresetId, items: [{ id, name, isDefault, summary }] }`
- `presets.colab.dasiwa` / `presets.colab.cobijada`: `{ defaultPresetId, items: [...] }`

### 2. List & create canvases
- `GET /v1/agent/canvases?query=<keyword>&includeFolders=true|false`
- `POST /v1/agent/canvases`
  - Body: `{ "name": "Canvas Name", "shared": false, "requestId": "stable-id" }`
  - Returns `201 Created` (or `200 OK` on idempotent retry) with `{ ok, created, canvas }`.

### 3. Inspect canvas nodes
`GET /v1/agent/canvases/{canvasId}/nodes?kind=<optional-kind>`

Returns `{ ok, canvas, nodes, edges }`:
- `text` nodes include `contentType`, active `text`, `information`, `activeVersionId`, `activeVersionLabel`, `versionCount`, `generationOptions`, `referenceSelection`.
- `video-generation` nodes include `workflowModuleId`, `generationMode`, `generationChannel`, `aspectRatio`, `durationSeconds`, `incomingNodeIds`.
- Media nodes (`image`, `audio`, `video`, `generated-video`) include `originalName`, `assetPath`, `videoUrl`.

### 4. Upload reference assets
`POST /v1/agent/assets` (`multipart/form-data`)
- `file` (required): image (`png/jpg/jpeg/webp/gif/bmp/avif`), audio (`mp3/wav/flac/m4a/aac/ogg`), or video (`mp4/mov/webm/mkv/avi`).
- `canvasId` (required if `createNode=true`).
- `createNode` (`"true"` | `"false"`, default `"false"`).
- Returns `201 Created` with `{ ok, assetRef, mediaKind, filename, node? }`.

### 5. Submit async H3 video job
`POST /v1/agent/jobs`

Key fields:
- `requestId`: stable idempotency ID. Retrying with the same `requestId` returns `200 OK` (`deduplicated: true`) and the original `job` without re-queuing ComfyUI.
- Target canvas (exactly one):
  - `canvasId`: existing canvas or folder subcanvas ID (users can copy this from the `i` badge in the UI).
  - `createCanvas`: `{ "name": "...", "shared": false }`.
- Entry mode:
  - `mode: "standalone"` (default when `sourceNodeId` omitted): requires `prompt`; optional `title`, `information`, `createPromptNode` (default `true`), `images` / `audios` / `videos` (each item can be `assetRef`, `nodeId`, or `{ assetRef|nodeId, role }`). Places new prompt & `video-generation` nodes column-aligned below existing ones.
  - `mode: "node"` (inferred when `sourceNodeId` is set): `sourceNodeId` points to an existing `text` or `video-generation` node in `canvasId`.
  - `promptVersionAction` (used in `mode: "node"`, default `"append"`): `"append"` automatically appends `v2`/`v3` in the target `text` node's `promptVersions` and activates it when `prompt`/`information` changes; `"overwrite"` updates the active version in place; `"none"` keeps `promptVersions` unchanged.
- Preset & options:
  - `preset`: exact preset name or ID from `/v1/agent/capabilities`. Unknown names return `400` listing available presets.
  - `channel`: `"local"` (default) or `"colab"`.
  - `durationSeconds` (2..15), `aspectRatio` (`16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `1:1`), `seedMode` (`random`|`fixed`), `seed`, `refImageSize` (`match`|`max`), `workflowModuleId`, `colabSampler`, `secondarySamplingEnabled`.

Returns `202 Accepted` immediately with `{ ok, canvasCreated, deduplicated, job }` (including `promptNodeId`, `promptVersionId`, `promptVersionLabel`, `generatorNodeId`, `placeholderNodeId`). The server creates placeholder canvas nodes immediately, runs ComfyUI in the background, and automatically updates the canvas placeholder into playable `generated-video` nodes + SSE events even if the caller disconnects.

### 6. Poll, cancel, and download outputs
- `GET /v1/agent/jobs/{jobId}`: returns `{ ok, job }` (`status`: `queued` | `running` | `succeeded` | `failed` | `cancelled`). Reconciles orphaned jobs automatically if the server restarted mid-run.
- `POST /v1/agent/jobs/{jobId}/cancel`: cancels the ComfyUI prompt and marks the canvas placeholder `cancelled`.
- `GET /v1/agent/jobs/{jobId}/outputs/{index}`: streams the generated video file with `Content-Disposition`.
