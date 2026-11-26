---
name: sucanvas-h3-video
description: Submit, monitor, download, and clean up MiniMax H3 (local/Colab) and external Seedance 2.0/2.5 (jimeng-cn, dreamina-jp, libtv, lovart) video generation jobs on a remote or local SuCanvas Web server via its Bearer-authenticated /v1/agent/* API. Use when the user wants to generate videos into an existing or newly created SuCanvas canvas (either from a prompt + reference assets or by triggering an existing prompt/generator node), pull completed MP4s locally, or clean up cached local videos.
---

# SuCanvas Video Generation (H3 & External Seedance 2.0/2.5)

Drive MiniMax H3 (`local` / `colab`) and the 4 integrated external Seedance 2.0/2.5 platforms (`jimeng-cn`, `dreamina-jp`, `libtv`, `lovart`) through the bundled zero-dependency CLI (`scripts/sucanvas_h3.py`) so generated videos land directly as playable nodes inside SuCanvas Web canvases and can also be downloaded locally.

Read [references/api-contract.md](references/api-contract.md) for full endpoint and field semantics.

## Configuration

Never hardcode URLs or Bearer tokens inside prompts, scripts, or replies. The CLI resolves configuration in this order:
1. Explicit CLI flags (`--base-url`, `--token`, `--download-dir`, `--insecure`)
2. Environment variables (`SUCANVAS_BASE_URL`, `SUCANVAS_TOKEN`, `SUCANVAS_DOWNLOAD_DIR`, `SUCANVAS_INSECURE`)
3. Local config file (`~/.config/sucanvas-h3/config.json`, or `SUCANVAS_CONFIG`)

Initialize once if not yet configured:

```bash
python3 scripts/sucanvas_h3.py config init --base-url "https://your-sucanvas-host" --token "<bearer-token>"
```

Verify active config (token is masked):

```bash
python3 scripts/sucanvas_h3.py config show
```

## Standard Workflow

### 1. Discover channels, workflows, presets, and external models
Always query capabilities before submitting if the exact preset name, Colab readiness, or external provider status/model IDs are uncertain:

```bash
python3 scripts/sucanvas_h3.py capabilities
```

- For `local` / `colab` (MiniMax H3): do not guess preset names — pass the exact `name` or `id` returned under `presets.local.items` or `presets.colab.<profile>.items`.
- For the 4 external Seedance platforms (`jimeng-cn`, `dreamina-jp`, `libtv`, `lovart`): inspect `externalProviders` (and `channels.<id>`) to verify `ready: true` (`installed` & `loggedIn`), exact `models[].id`, supported `resolutions`, `minDuration`..`maxDuration`, `modes`, media limits (`maxImages`, `maxVideos`, `maxAudios`), and `maxPromptLength` (Seedance 2.0 on Jimeng/Dreamina is capped at 4,000 chars vs 15,000 chars on Seedance 2.5). Do **not** pass `--preset` on external channels; use `--model`, `--resolution`, `--provider-mode`, `--duration`, `--aspect-ratio`, and `--sound` / `--no-sound`. External jobs are auto-confirmed on the server and automatically record `costCredits` on completion.

### 2. Locate the target canvas
- If the user provides a `canvasId` (copied from the `i` icon on a SuCanvas project card or canvas header), use `--canvas-id "<id>"`.
- Otherwise, search existing canvases or create a new one:
  - List: `python3 scripts/sucanvas_h3.py canvases --query "关键词"`
  - Or pass `--new-canvas "新画布名称"` directly to `submit`.

### 3. Choose the entry mode
- **New scene / standalone (`mode=standalone`)**:
  Use when starting a brand-new scene or segment (e.g., Segment 2 after Segment 1). Top-aligns `text`, `video-generation`, and the first video output in a clean horizontal row below any existing scenes.
  Write long or multilingual prompts to a UTF-8 file first (avoid inline shell escaping issues). Upload local reference files first if needed:
  ```bash
  python3 scripts/sucanvas_h3.py upload --file /path/to/ref.png --canvas-id "<canvasId>" --create-node
  python3 scripts/sucanvas_h3.py submit \
    --canvas-id "<canvasId>" \
    --prompt-file /path/to/prompt.txt \
    --preset "<exact-preset-name>" \
    --duration 6 \
    --aspect-ratio 16:9 \
    --image "<assetRef-or-nodeId>" \
    --request-id "stable-unique-id"
  ```
- **Iterate / revise existing scene (`--source-node-id`)**:
  **Default rule when revising the same scene/shot (v2, v3...)**: pass `--source-node-id "<textNodeId-or-generatorNodeId>"` instead of creating a duplicate standalone set.
  - When `--prompt` / `--prompt-file` or `--info` / `--info-file` differs from the active version, the server automatically appends `v2` / `v3` inside that `text` node's prompt iterator (`--prompt-version-action append`, default), switches `activePromptVersionId` to it, reuses the connected `video-generation` node & reference edges, and places the new output video neatly to the right of the latest output video from that generator.
  - Pass `--prompt-version-action none` to run a one-off prompt override without adding a version, or `overwrite` to update the active version in place.
  - Without `--prompt-file`, it directly triggers generation from the active version:
  ```bash
  python3 scripts/sucanvas_h3.py nodes --canvas-id "<canvasId>"
  python3 scripts/sucanvas_h3.py submit \
    --canvas-id "<canvasId>" \
    --source-node-id "<nodeId>" \
    --prompt-file /path/to/prompt_v2.txt \
    --preset "<exact-preset-name>" \
    --request-id "stable-unique-id-v2"
  ```
- **Using an external Seedance platform (`jimeng-cn`, `dreamina-jp`, `libtv`, `lovart`)**:
  Replace `--preset` with `--channel <provider>` and optional `--model`, `--resolution`, `--provider-mode`, `--duration`, `--no-sound`:
  ```bash
  python3 scripts/sucanvas_h3.py submit \
    --canvas-id "<canvasId>" \
    --source-node-id "<nodeId>" \
    --channel jimeng-cn \
    --model seedance_2.5 \
    --resolution 720p \
    --duration 5 \
    --aspect-ratio 16:9 \
    --prompt-file /path/to/prompt.txt \
    --request-id "stable-jimeng-req-1"
  ```

### 4. Wait safely without duplicate submissions
`submit` returns `202 Accepted` immediately with `jobId` and `requestId`. Poll with `wait` or `status`:

```bash
python3 scripts/sucanvas_h3.py wait --job-id "<jobId>" --timeout 900 --poll 5
```

- **Never resubmit `submit` after a `wait` timeout** (exit code `2`). Keep polling `status` / `wait` with the same `jobId`.
- If you must retry an uncertain `submit` network failure, reuse the **exact same `--request-id`** so the server deduplicates it.

### 5. Download completed videos locally
```bash
python3 scripts/sucanvas_h3.py download --job-id "<jobId>"
```

Optionally pass `--auto-cleanup-mb 2048` or `--auto-cleanup-keep 20` (or configure defaults in `config init`) to automatically cap local disk usage after downloading.

### 6. Clean up cached local videos
Downloaded files are tracked in `<downloadDir>/manifest.json`. `cleanup` only deletes manifest-tracked files strictly inside `<downloadDir>` (never files outside or symlinks). Always preview with `--dry-run` when deleting broadly:

```bash
python3 scripts/sucanvas_h3.py cleanup --dry-run --older-than-days 7
python3 scripts/sucanvas_h3.py cleanup --older-than-days 7
python3 scripts/sucanvas_h3.py cleanup --max-total-mb 2048
python3 scripts/sucanvas_h3.py cleanup --keep-latest 10
python3 scripts/sucanvas_h3.py cleanup --job-id "<jobId>"
```

## Safety Rules

- Never print, log, or embed the raw Bearer token in responses or files inside a shared repo.
- Always pass `--prompt-file` and `--info-file` as UTF-8 files for non-ASCII or multi-line text.
- Report the `canvasId`, `jobId`, `presetName`, canvas `outputNodeIds`, and local `filePath` (if downloaded) after completion.
