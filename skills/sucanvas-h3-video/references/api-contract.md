# SuCanvas Web Agent Video API (`/v1/agent/*`)

All endpoints require `Authorization: Bearer <token>` (from SuCanvas Web `data/web-integration-token`). Requests do not require cookies or browser `Origin` headers.

## Endpoints

### 1. Discover capabilities, presets & external providers
`GET /v1/agent/capabilities`

Returns:
- `kinds`: `["h3-video", "external-video"]`
- `channels.local`: `{ configured, inputDirectoryConfigured, outputDirectoryConfigured }`
- `channels.colab`: `{ configured, reachable, available, effectiveProfile, label, diffusionModelName, allowedLoras, samplerOptions, error }`
- `channels.jimeng-cn` / `channels.dreamina-jp` / `channels.libtv` / `channels.lovart`: `{ label, installed, loggedIn, ready, statusText, error, defaultModelId, modelIds }`
- `externalProviders`: full `ProviderStatusSnapshot[]` array including each provider's `models[]` (`id`, `label`, `series`, `resolutions`, `defaultResolution`, `minDuration`, `maxDuration`, `defaultDuration`, `aspectRatios`, `modes`, `supportsAudioToggle`, `maxImages`, `maxVideos`, `maxAudios`, `maxPromptLength`)
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
- `createNode` (`"true"` | `"false"`, default `"false"`). When `"true"`, automatically top-aligns (`y`) the created media node with the target scene row (or to the left of `anchorNodeId`).
- `anchorNodeId` (optional): existing `text` / `video-generation` / reference node ID whose row top edge (`y`) this uploaded reference node should align with.
- Returns `201 Created` with `{ ok, assetRef, mediaKind, filename, node? }`.

### 5. Submit async H3 or external Seedance video job
`POST /v1/agent/jobs`

Key fields:
- `requestId`: stable idempotency ID. Retrying with the same `requestId` returns `200 OK` (`deduplicated: true`) and the original `job` without re-queuing.
- `kind`: `"h3-video"` (default for `local`/`colab`) or `"external-video"` (default when `channel` is one of the 4 external providers).
- Target canvas (exactly one):
  - `canvasId`: existing canvas or folder subcanvas ID (users can copy this from the `i` badge in the UI).
  - `createCanvas`: `{ "name": "...", "shared": false }`.
- Entry mode:
  - `mode: "standalone"` (default when `sourceNodeId` omitted): requires `prompt`; optional `title`, `information`, `createPromptNode` (default `true`), `images` / `audios` / `videos` (each item can be `assetRef`, `nodeId`, or `{ assetRef|nodeId, role }`). Places new prompt & `video-generation` nodes column-aligned below existing ones.
  - `mode: "node"` (inferred when `sourceNodeId` is set): `sourceNodeId` points to an existing `text` or `video-generation` node in `canvasId`.
  - `promptVersionAction` (used in `mode: "node"`, default `"append"`): `"append"` automatically appends `v2`/`v3` in the target `text` node's `promptVersions` and activates it when `prompt`/`information` changes; `"overwrite"` updates the active version in place; `"none"` keeps `promptVersions` unchanged.
- Channel & options:
  - `channel`: `"local"` (default), `"colab"`, `"jimeng-cn"`, `"dreamina-jp"`, `"libtv"`, or `"lovart"`.
  - For H3 (`local` / `colab`): `preset` (exact name or ID from `capabilities`), `durationSeconds` (2..15), `aspectRatio` (`16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `1:1`), `seedMode` (`random`|`fixed`), `seed`, `refImageSize` (`match`|`max`), `workflowModuleId`, `colabSampler`, `secondarySamplingEnabled`.
  - For external platforms (`jimeng-cn` / `dreamina-jp` / `libtv` / `lovart`): `preset` is not required; optional `modelId` (from `externalProviders[].models[].id`), `resolution`, `externalMode` (e.g. `auto`, `t2v`, `first_last_frame`, `m2v`, `text2video`, `singleImage2video`, `frames2video`, `image2video`, `mixed2video`), `enableSound` (`true`/`false`, default `true`), `durationSeconds` (clamped to model bounds, e.g. 4..15 or 4..30), `aspectRatio`. Prompt length & media counts are validated upfront before mutating canvas nodes, and credits/quotes are auto-confirmed on the server.

Returns `202 Accepted` immediately with `{ ok, canvasCreated, deduplicated, job }` (including `promptNodeId`, `promptVersionId`, `promptVersionLabel`, `generatorNodeId`, `placeholderNodeId`; plus `externalJobId`, `externalProvider`, `externalProviderLabel`, `externalModelId`, `externalModelLabel`, `stageMessage`, `costCredits`, `quoteSummary` for external channels). The server creates placeholder canvas nodes immediately, runs ComfyUI or the external provider CLI in the background, and automatically updates the canvas placeholder into playable `generated-video` nodes + SSE events even if the caller disconnects.

### 6. Poll, cancel, and download outputs
- `GET /v1/agent/jobs/{jobId}`: returns `{ ok, job }` (`status`: `queued` | `running` | `succeeded` | `failed` | `cancelled`; external jobs also report live `stageMessage` and `costCredits`). Reconciles orphaned jobs automatically.
- `POST /v1/agent/jobs/{jobId}/cancel`: cancels the ComfyUI prompt or external provider job and marks the canvas placeholder `cancelled`.
- `GET /v1/agent/jobs/{jobId}/outputs/{index}`: streams the generated video file with `Content-Disposition`.
