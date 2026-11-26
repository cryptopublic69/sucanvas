#!/usr/bin/env python3
"""Zero-dependency cross-platform CLI for SuCanvas Web (/v1/agent/*)."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import mimetypes
import os
import pathlib
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any


DEFAULT_CONFIG_PATH = pathlib.Path.home() / ".config" / "sucanvas" / "config.json"
LEGACY_CONFIG_PATH = pathlib.Path.home() / ".config" / "sucanvas-h3" / "config.json"
DEFAULT_DOWNLOAD_DIR = pathlib.Path.home() / ".cache" / "sucanvas" / "downloads"
MANIFEST_FILENAME = "manifest.json"


class CliError(Exception):
    def __init__(self, message: str, code: int = 1, payload: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.payload = payload


def _utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _parse_iso(ts: str) -> dt.datetime:
    cleaned = ts.strip()
    if cleaned.endswith("Z"):
        cleaned = cleaned[:-1] + "+00:00"
    parsed = dt.datetime.fromisoformat(cleaned)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed


def _config_path(override: str | None = None) -> pathlib.Path:
    env_path = os.environ.get("SUCANVAS_CONFIG", "").strip()
    if override:
        return pathlib.Path(override).expanduser()
    if env_path:
        return pathlib.Path(env_path).expanduser()
    return DEFAULT_CONFIG_PATH


def _load_config_file(path: pathlib.Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception as exc:
        raise CliError(f"Failed to read config file {path}: {exc}") from exc


def _save_json_atomic(path: pathlib.Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _mask_token(token: str) -> str:
    t = token.strip()
    if not t:
        return ""
    if len(t) <= 8:
        return "*" * len(t)
    return f"{t[:4]}...{t[-4:]}"


def _resolve_runtime_settings(args: argparse.Namespace) -> dict[str, Any]:
    override = getattr(args, "config", None)
    env_path = os.environ.get("SUCANVAS_CONFIG", "").strip()
    cfg_path = _config_path(override)
    if not override and not env_path and not cfg_path.is_file() and LEGACY_CONFIG_PATH.is_file():
        file_cfg = _load_config_file(LEGACY_CONFIG_PATH)
    else:
        file_cfg = _load_config_file(cfg_path)

    base_url = (
        getattr(args, "base_url", None)
        or os.environ.get("SUCANVAS_BASE_URL", "")
        or str(file_cfg.get("baseUrl", ""))
    ).strip().rstrip("/")
    token = (
        getattr(args, "token", None)
        or os.environ.get("SUCANVAS_TOKEN", "")
        or str(file_cfg.get("token", ""))
    ).strip()
    download_dir_raw = (
        getattr(args, "download_dir", None)
        or os.environ.get("SUCANVAS_DOWNLOAD_DIR", "")
        or str(file_cfg.get("downloadDir", ""))
    ).strip()
    download_dir = (
        pathlib.Path(download_dir_raw).expanduser() if download_dir_raw else DEFAULT_DOWNLOAD_DIR
    )
    env_insecure = os.environ.get("SUCANVAS_INSECURE", "").strip().lower() in {"1", "true", "yes"}
    insecure = bool(getattr(args, "insecure", False) or env_insecure or file_cfg.get("insecure", False))

    return {
        "configPath": str(cfg_path),
        "baseUrl": base_url,
        "token": token,
        "downloadDir": download_dir,
        "insecure": insecure,
        "autoCleanupMaxMb": file_cfg.get("autoCleanupMaxMb"),
        "autoCleanupKeepLatest": file_cfg.get("autoCleanupKeepLatest"),
    }


def _require_connection(settings: dict[str, Any]) -> None:
    if not settings["baseUrl"]:
        raise CliError("Missing SuCanvas baseUrl. Run `config init` or set SUCANVAS_BASE_URL.")
    if not settings["token"]:
        raise CliError("Missing Bearer token. Run `config init` or set SUCANVAS_TOKEN.")


def _ssl_context(insecure: bool) -> ssl.SSLContext | None:
    if not insecure:
        return None
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _http_request(
    settings: dict[str, Any],
    method: str,
    path: str,
    *,
    json_body: dict[str, Any] | None = None,
    raw_body: bytes | None = None,
    extra_headers: dict[str, str] | None = None,
    timeout: float = 60.0,
) -> tuple[int, dict[str, str], bytes]:
    _require_connection(settings)
    url = f"{settings['baseUrl']}{path}"
    headers: dict[str, str] = {
        "Authorization": f"Bearer {settings['token']}",
        "Accept": "application/json",
    }
    data: bytes | None = raw_body
    if json_body is not None:
        data = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    if extra_headers:
        headers.update(extra_headers)

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    ctx = _ssl_context(settings["insecure"])
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            return resp.status, resp_headers, resp.read()
    except urllib.error.HTTPError as err:
        body = err.read()
        detail = body.decode("utf-8", errors="replace")
        try:
            parsed = json.loads(detail)
            msg = parsed.get("error") or detail
        except Exception:
            msg = detail
        raise CliError(f"HTTP {err.code}: {msg}", code=1) from err
    except urllib.error.URLError as err:
        raise CliError(f"Network error contacting {url}: {err.reason}") from err


def _http_json(
    settings: dict[str, Any],
    method: str,
    path: str,
    *,
    json_body: dict[str, Any] | None = None,
    timeout: float = 60.0,
) -> dict[str, Any]:
    _, _, body = _http_request(settings, method, path, json_body=json_body, timeout=timeout)
    try:
        parsed = json.loads(body.decode("utf-8"))
        return parsed if isinstance(parsed, dict) else {"data": parsed}
    except Exception as exc:
        raise CliError(f"Invalid JSON response from {path}: {exc}") from exc


def _stream_download(
    settings: dict[str, Any],
    path: str,
    dest_path: pathlib.Path,
    timeout: float = 600.0,
) -> tuple[int, dict[str, str]]:
    _require_connection(settings)
    url = f"{settings['baseUrl']}{path}"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {settings['token']}"},
        method="GET",
    )
    ctx = _ssl_context(settings["insecure"])
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = dest_path.with_name(f".{dest_path.name}.{uuid.uuid4().hex}.part")
    total = 0
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            with tmp_path.open("wb") as handle:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    handle.write(chunk)
                    total += len(chunk)
        os.replace(tmp_path, dest_path)
        return total, resp_headers
    except urllib.error.HTTPError as err:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        detail = err.read().decode("utf-8", errors="replace")
        raise CliError(f"HTTP {err.code}: {detail}") from err
    except Exception as exc:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        raise CliError(f"Download failed for {url}: {exc}") from exc


def _build_multipart_body(
    fields: list[tuple[str, str]],
    file_field: tuple[str, pathlib.Path],
) -> tuple[bytes, str]:
    boundary = f"----SuCanvasBoundary{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for key, val in fields:
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode("utf-8"))
        chunks.append(val.encode("utf-8"))
        chunks.append(b"\r\n")

    field_name, file_path = file_field
    safe_filename = file_path.name.replace('"', "_")
    mime, _ = mimetypes.guess_type(str(file_path))
    content_type = mime or "application/octet-stream"
    chunks.append(f"--{boundary}\r\n".encode("utf-8"))
    chunks.append(
        (
            f'Content-Disposition: form-data; name="{field_name}"; '
            f'filename="{safe_filename}"\r\n'
        ).encode("utf-8")
    )
    chunks.append(f"Content-Type: {content_type}\r\n\r\n".encode("utf-8"))
    chunks.append(file_path.read_bytes())
    chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def _read_utf8_file(path_str: str) -> str:
    p = pathlib.Path(path_str).expanduser()
    if not p.is_file():
        raise CliError(f"File not found: {p}")
    return p.read_text(encoding="utf-8")


def _parse_image_spec(spec: str) -> dict[str, Any]:
    raw = spec.strip()
    if not raw:
        raise CliError("Image reference cannot be empty.")
    role = None
    for candidate in (":first", ":last"):
        if raw.endswith(candidate):
            role = candidate[1:]
            raw = raw[: -len(candidate)]
            break
    if not raw.startswith("node:"):
        raise CliError(
            f"Invalid --image reference {spec!r}: must be a canvas node ID starting with 'node:' "
            "(optionally with :first or :last). Run `upload --file <path> --canvas-id <canvasId> "
            "--create-node` first and pass the returned node.id instead of a raw assetRef."
        )
    obj: dict[str, Any] = {"nodeId": raw}
    if role:
        obj["role"] = role
    return obj


def _parse_media_spec(spec: str, kind: str = "media") -> dict[str, Any]:
    raw = spec.strip()
    if not raw:
        raise CliError(f"{kind.capitalize()} reference cannot be empty.")
    if not raw.startswith("node:"):
        raise CliError(
            f"Invalid --{kind} reference {spec!r}: must be a canvas node ID starting with 'node:'. "
            "Run `upload --file <path> --canvas-id <canvasId> --create-node` first and pass the "
            "returned node.id instead of a raw assetRef."
        )
    return {"nodeId": raw}


def _manifest_path(download_dir: pathlib.Path) -> pathlib.Path:
    return download_dir / MANIFEST_FILENAME


def _load_manifest(download_dir: pathlib.Path) -> dict[str, Any]:
    path = _manifest_path(download_dir)
    if not path.is_file():
        return {"version": 1, "entries": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("entries"), list):
            return data
    except Exception:
        pass
    return {"version": 1, "entries": []}


def _is_within_dir(target: pathlib.Path, root: pathlib.Path) -> bool:
    try:
        resolved_root = root.resolve(strict=False)
        # Reject symlink targets escaping the download root.
        if target.is_symlink():
            return False
        resolved_target = target.resolve(strict=False)
        resolved_target.relative_to(resolved_root)
        return resolved_target != resolved_root
    except Exception:
        return False


def _sanitize_local_filename(name: str, fallback: str) -> str:
    cleaned = "".join("_" if (ord(c) < 32 or c in '<>:"/\\|?*') else c for c in name).strip(" .")
    return cleaned or fallback


def _run_cleanup(
    download_dir: pathlib.Path,
    *,
    dry_run: bool = False,
    older_than_days: float | None = None,
    keep_latest: int | None = None,
    max_total_mb: float | None = None,
    job_id: str | None = None,
    delete_all: bool = False,
    prune_missing: bool = False,
) -> dict[str, Any]:
    download_dir.mkdir(parents=True, exist_ok=True)
    manifest = _load_manifest(download_dir)
    entries: list[dict[str, Any]] = [
        entry for entry in manifest.get("entries", []) if isinstance(entry, dict)
    ]

    now = dt.datetime.now(dt.timezone.utc)
    # Refresh file sizes and filter missing entries if requested.
    existing_entries: list[dict[str, Any]] = []
    pruned_missing = 0
    for entry in entries:
        fp = pathlib.Path(str(entry.get("filePath", "")))
        if fp.is_file() and _is_within_dir(fp, download_dir):
            entry["sizeBytes"] = fp.stat().st_size
            existing_entries.append(entry)
        elif prune_missing:
            pruned_missing += 1
        else:
            existing_entries.append(entry)

    # Sort oldest -> newest by downloadedAt.
    def sort_key(entry: dict[str, Any]) -> dt.datetime:
        try:
            return _parse_iso(str(entry.get("downloadedAt", "")))
        except Exception:
            return dt.datetime.fromtimestamp(0, tz=dt.timezone.utc)

    ordered = sorted(existing_entries, key=sort_key)
    to_delete_ids: set[int] = set()

    if delete_all:
        to_delete_ids = set(range(len(ordered)))
    else:
        if job_id:
            for idx, entry in enumerate(ordered):
                if entry.get("jobId") == job_id:
                    to_delete_ids.add(idx)

        if older_than_days is not None:
            cutoff = now - dt.timedelta(days=older_than_days)
            for idx, entry in enumerate(ordered):
                if sort_key(entry) <= cutoff:
                    to_delete_ids.add(idx)

        if keep_latest is not None:
            keep = max(0, keep_latest)
            survivors = [idx for idx in range(len(ordered)) if idx not in to_delete_ids]
            if len(survivors) > keep:
                for idx in survivors[: len(survivors) - keep]:
                    to_delete_ids.add(idx)

        if max_total_mb is not None:
            limit_bytes = int(max(0.0, max_total_mb) * 1024 * 1024)
            survivors = [idx for idx in range(len(ordered)) if idx not in to_delete_ids]
            total_bytes = sum(int(ordered[idx].get("sizeBytes", 0)) for idx in survivors)
            for idx in survivors:
                if total_bytes <= limit_bytes:
                    break
                to_delete_ids.add(idx)
                total_bytes -= int(ordered[idx].get("sizeBytes", 0))

    deleted_files: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    kept_entries: list[dict[str, Any]] = []
    freed_bytes = 0

    for idx, entry in enumerate(ordered):
        if idx not in to_delete_ids:
            kept_entries.append(entry)
            continue
        raw_path = str(entry.get("filePath", ""))
        fp = pathlib.Path(raw_path)
        if not _is_within_dir(fp, download_dir):
            skipped.append({"filePath": raw_path, "reason": "outside downloadDir or symlink"})
            kept_entries.append(entry)
            continue
        size = fp.stat().st_size if fp.is_file() else int(entry.get("sizeBytes", 0))
        if not dry_run:
            if fp.is_file():
                fp.unlink()
                parent = fp.parent
                if parent != download_dir and _is_within_dir(parent, download_dir):
                    try:
                        parent.rmdir()
                    except OSError:
                        pass
        else:
            kept_entries.append(entry)
        freed_bytes += size
        deleted_files.append(
            {
                "jobId": entry.get("jobId"),
                "filePath": raw_path,
                "sizeBytes": size,
            }
        )

    if not dry_run and (deleted_files or pruned_missing):
        _save_json_atomic(_manifest_path(download_dir), {"version": 1, "entries": kept_entries})

    remaining_entries = kept_entries if not dry_run else [
        entry for idx, entry in enumerate(ordered) if idx not in to_delete_ids
    ]
    remaining_bytes = sum(int(entry.get("sizeBytes", 0)) for entry in remaining_entries)
    return {
        "ok": True,
        "dryRun": dry_run,
        "downloadDir": str(download_dir),
        "deletedCount": len(deleted_files),
        "prunedMissingCount": pruned_missing,
        "freedBytes": freed_bytes,
        "freedMb": round(freed_bytes / (1024 * 1024), 3),
        "remainingCount": len(remaining_entries),
        "remainingBytes": remaining_bytes,
        "remainingMb": round(remaining_bytes / (1024 * 1024), 3),
        "deletedFiles": deleted_files,
        "skipped": skipped,
    }


def cmd_config_init(args: argparse.Namespace, settings: dict[str, Any]) -> dict[str, Any]:
    cfg_path = pathlib.Path(settings["configPath"])
    existing = _load_config_file(cfg_path)
    if args.base_url:
        existing["baseUrl"] = args.base_url.strip().rstrip("/")
    if args.token:
        existing["token"] = args.token.strip()
    if args.download_dir:
        existing["downloadDir"] = str(pathlib.Path(args.download_dir).expanduser())
    if args.insecure is not None:
        existing["insecure"] = bool(args.insecure)
    if args.auto_cleanup_max_mb is not None:
        existing["autoCleanupMaxMb"] = args.auto_cleanup_max_mb
    if args.auto_cleanup_keep_latest is not None:
        existing["autoCleanupKeepLatest"] = args.auto_cleanup_keep_latest
    _save_json_atomic(cfg_path, existing)
    return {
        "ok": True,
        "configPath": str(cfg_path),
        "baseUrl": existing.get("baseUrl", ""),
        "tokenMasked": _mask_token(str(existing.get("token", ""))),
        "downloadDir": existing.get("downloadDir", str(DEFAULT_DOWNLOAD_DIR)),
        "insecure": bool(existing.get("insecure", False)),
        "autoCleanupMaxMb": existing.get("autoCleanupMaxMb"),
        "autoCleanupKeepLatest": existing.get("autoCleanupKeepLatest"),
    }


def cmd_config_show(_args: argparse.Namespace, settings: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": True,
        "configPath": settings["configPath"],
        "baseUrl": settings["baseUrl"],
        "tokenConfigured": bool(settings["token"]),
        "tokenMasked": _mask_token(settings["token"]),
        "downloadDir": str(settings["downloadDir"]),
        "insecure": settings["insecure"],
        "autoCleanupMaxMb": settings["autoCleanupMaxMb"],
        "autoCleanupKeepLatest": settings["autoCleanupKeepLatest"],
    }


def cmd_capabilities(_args: argparse.Namespace, settings: dict[str, Any]) -> dict[str, Any]:
    return _http_json(settings, "GET", "/v1/agent/capabilities")


def cmd_canvases(args: argparse.Namespace, settings: dict[str, Any]) -> dict[str, Any]:
    params: dict[str, str] = {}
    if args.query:
        params["query"] = args.query
    if args.include_folders:
        params["includeFolders"] = "true"
    qs = f"?{urllib.parse.urlencode(params)}" if params else ""
    return _http_json(settings, "GET", f"/v1/agent/canvases{qs}")


def cmd_create_canvas(args: argparse.Namespace, settings: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "name": args.name,
        "shared": bool(args.shared),
        "requestId": args.request_id or f"cli-canvas:{uuid.uuid4()}",
    }
    return _http_json(settings, "POST", "/v1/agent/canvases", json_body=payload)


def cmd_nodes(args: argparse.Namespace, settings: dict[str, Any]) -> dict[str, Any]:
    qs = f"?{urllib.parse.urlencode({'kind': args.kind})}" if args.kind else ""
    cid = urllib.parse.quote(args.canvas_id, safe="")
    return _http_json(settings, "GET", f"/v1/agent/canvases/{cid}/nodes{qs}")


def cmd_upload(args: argparse.Namespace, settings: dict[str, Any]) -> dict[str, Any]:
    file_path = pathlib.Path(args.file).expanduser()
    if not file_path.is_file():
        raise CliError(f"Upload file not found: {file_path}")
    fields: list[tuple[str, str]] = []
    if args.canvas_id:
        fields.append(("canvasId", args.canvas_id))
    if args.create_node:
        if not args.canvas_id:
            raise CliError("--create-node requires --canvas-id")
        fields.append(("createNode", "true"))
    if args.anchor_node_id:
        fields.append(("anchorNodeId", args.anchor_node_id))
    if args.x is not None:
        fields.append(("x", str(args.x)))
    if args.y is not None:
        fields.append(("y", str(args.y)))
    body, content_type = _build_multipart_body(fields, ("file", file_path))
    _, _, resp_bytes = _http_request(
        settings,
        "POST",
        "/v1/agent/assets",
        raw_body=body,
        extra_headers={"Content-Type": content_type},
        timeout=300.0,
    )
    return json.loads(resp_bytes.decode("utf-8"))


EXTERNAL_CHANNELS = ("jimeng-cn", "dreamina-jp", "libtv", "lovart")
ALL_CHANNELS = ("local", "colab", *EXTERNAL_CHANNELS)


def cmd_submit(args: argparse.Namespace, settings: dict[str, Any]) -> dict[str, Any]:
    if bool(args.canvas_id) == bool(args.new_canvas):
        raise CliError("Specify exactly one of --canvas-id or --new-canvas.")

    is_external = args.channel in EXTERNAL_CHANNELS
    payload: dict[str, Any] = {
        "requestId": args.request_id or f"cli-job:{uuid.uuid4()}",
        "kind": "external-video" if is_external else "h3-video",
        "channel": args.channel,
    }
    if args.canvas_id:
        payload["canvasId"] = args.canvas_id
    else:
        payload["createCanvas"] = {
            "name": args.new_canvas,
            "shared": bool(args.new_canvas_shared),
        }

    if args.source_node_id:
        payload["mode"] = "node"
        payload["sourceNodeId"] = args.source_node_id
    else:
        payload["mode"] = "standalone"

    if args.prompt_file:
        payload["prompt"] = _read_utf8_file(args.prompt_file)
    elif args.prompt:
        payload["prompt"] = args.prompt

    if args.info_file:
        payload["information"] = _read_utf8_file(args.info_file)
    elif args.info:
        payload["information"] = args.info

    if args.title:
        payload["title"] = args.title
    if args.prompt_version_action:
        payload["promptVersionAction"] = args.prompt_version_action
    if args.no_prompt_node:
        payload["createPromptNode"] = False
    if args.preset:
        payload["preset"] = args.preset
    if args.workflow_module_id:
        payload["workflowModuleId"] = args.workflow_module_id
    if args.duration is not None:
        payload["durationSeconds"] = args.duration
    if args.aspect_ratio:
        payload["aspectRatio"] = args.aspect_ratio
    if args.seed_mode:
        payload["seedMode"] = args.seed_mode
    if args.seed:
        payload["seed"] = args.seed
    if args.ref_image_size:
        payload["refImageSize"] = args.ref_image_size
    if args.colab_sampler:
        payload["colabSampler"] = args.colab_sampler
    if args.secondary_sampling:
        payload["secondarySamplingEnabled"] = True
    if args.model:
        payload["modelId"] = args.model
    if args.resolution:
        payload["resolution"] = args.resolution
    if args.provider_mode:
        payload["externalMode"] = args.provider_mode
    if args.sound is not None:
        payload["enableSound"] = bool(args.sound)
    if args.image:
        payload["images"] = [_parse_image_spec(item) for item in args.image]
    if args.audio:
        payload["audios"] = [_parse_media_spec(item, "audio") for item in args.audio]
    if args.video:
        payload["videos"] = [_parse_media_spec(item, "video") for item in args.video]

    return _http_json(settings, "POST", "/v1/agent/jobs", json_body=payload)


def cmd_status(args: argparse.Namespace, settings: dict[str, Any]) -> dict[str, Any]:
    jid = urllib.parse.quote(args.job_id, safe="")
    return _http_json(settings, "GET", f"/v1/agent/jobs/{jid}")


def cmd_wait(args: argparse.Namespace, settings: dict[str, Any]) -> dict[str, Any]:
    jid = urllib.parse.quote(args.job_id, safe="")
    deadline = time.monotonic() + max(1.0, float(args.timeout))
    poll = max(0.2, float(args.poll))
    last: dict[str, Any] = {}
    while True:
        last = _http_json(settings, "GET", f"/v1/agent/jobs/{jid}")
        job = last.get("job", {}) if isinstance(last.get("job"), dict) else {}
        status = job.get("status")
        if status in {"succeeded", "failed", "cancelled"}:
            return last
        if time.monotonic() >= deadline:
            raise CliError(
                f"Timed out waiting for {args.job_id}; do NOT resubmit, poll with `status` or `wait`.",
                code=2,
                payload={"ok": False, "timedOut": True, "job": job},
            )
        time.sleep(poll)


def cmd_download(args: argparse.Namespace, settings: dict[str, Any]) -> dict[str, Any]:
    jid = urllib.parse.quote(args.job_id, safe="")
    info = _http_json(settings, "GET", f"/v1/agent/jobs/{jid}")
    job = info.get("job", {}) if isinstance(info.get("job"), dict) else {}
    if job.get("status") != "succeeded":
        raise CliError(f"Job {args.job_id} is not succeeded (current status: {job.get('status')}).")
    outputs = job.get("outputs") or []
    if not outputs:
        raise CliError(f"Job {args.job_id} has no downloadable outputs.")

    download_dir = pathlib.Path(args.out_dir).expanduser() if args.out_dir else settings["downloadDir"]
    download_dir.mkdir(parents=True, exist_ok=True)
    manifest = _load_manifest(download_dir)
    entries: list[dict[str, Any]] = [
        e for e in manifest.get("entries", []) if isinstance(e, dict)
    ]

    if str(args.index).lower() == "all":
        indices = list(range(len(outputs)))
    else:
        idx = int(args.index)
        if idx < 0 or idx >= len(outputs):
            raise CliError(f"Output index {idx} out of range (0..{len(outputs) - 1}).")
        indices = [idx]

    safe_job_dir = _sanitize_local_filename(args.job_id.replace(":", "_"), "job")
    downloaded: list[dict[str, Any]] = []
    for idx in indices:
        out_meta = outputs[idx]
        raw_name = str(out_meta.get("filename") or f"output_{idx}.mp4")
        safe_name = _sanitize_local_filename(raw_name, f"output_{idx}.mp4")
        dest_path = download_dir / safe_job_dir / f"{idx}_{safe_name}"
        size_bytes, _ = _stream_download(
            settings,
            f"/v1/agent/jobs/{jid}/outputs/{idx}",
            dest_path,
        )
        record = {
            "jobId": job.get("jobId", args.job_id),
            "canvasId": job.get("canvasId"),
            "presetName": job.get("presetName"),
            "outputIndex": idx,
            "filePath": str(dest_path),
            "filename": safe_name,
            "sizeBytes": size_bytes,
            "downloadedAt": _utc_now_iso(),
        }
        entries = [
            e
            for e in entries
            if str(e.get("filePath", "")) != str(dest_path)
        ]
        entries.append(record)
        downloaded.append(record)

    _save_json_atomic(_manifest_path(download_dir), {"version": 1, "entries": entries})

    cleanup_result = None
    max_mb = (
        args.auto_cleanup_mb
        if args.auto_cleanup_mb is not None
        else settings.get("autoCleanupMaxMb")
    )
    keep_latest = (
        args.auto_cleanup_keep
        if args.auto_cleanup_keep is not None
        else settings.get("autoCleanupKeepLatest")
    )
    if max_mb is not None or keep_latest is not None:
        cleanup_result = _run_cleanup(
            download_dir,
            dry_run=False,
            keep_latest=keep_latest,
            max_total_mb=max_mb,
            prune_missing=True,
        )

    return {
        "ok": True,
        "jobId": job.get("jobId", args.job_id),
        "downloadDir": str(download_dir),
        "downloaded": downloaded,
        "cleanup": cleanup_result,
    }


def cmd_cancel(args: argparse.Namespace, settings: dict[str, Any]) -> dict[str, Any]:
    jid = urllib.parse.quote(args.job_id, safe="")
    return _http_json(settings, "POST", f"/v1/agent/jobs/{jid}/cancel", json_body={})


def cmd_cleanup(args: argparse.Namespace, settings: dict[str, Any]) -> dict[str, Any]:
    download_dir = pathlib.Path(args.out_dir).expanduser() if args.out_dir else settings["downloadDir"]
    if (
        not args.all
        and args.job_id is None
        and args.older_than_days is None
        and args.keep_latest is None
        and args.max_total_mb is None
        and not args.prune_missing
    ):
        raise CliError(
            "Specify at least one cleanup policy: --older-than-days, --keep-latest, "
            "--max-total-mb, --job-id, --all, or --prune-missing."
        )
    return _run_cleanup(
        download_dir,
        dry_run=bool(args.dry_run),
        older_than_days=args.older_than_days,
        keep_latest=args.keep_latest,
        max_total_mb=args.max_total_mb,
        job_id=args.job_id,
        delete_all=bool(args.all),
        prune_missing=bool(args.prune_missing),
    )


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--config", help="Path to config.json override")
    common.add_argument("--base-url", help="SuCanvas Web base URL (e.g. https://canvas.example.com)")
    common.add_argument("--token", help="Bearer token from web-integration-token")
    common.add_argument("--download-dir", help="Local video cache directory override")
    common.add_argument("--insecure", action="store_true", help="Skip TLS certificate verification")

    parser = argparse.ArgumentParser(
        prog="sucanvas.py",
        description="Cross-agent CLI for SuCanvas Web (/v1/agent/*): canvases, assets, H3/external video & future image workflows.",
        parents=[common],
    )
    sub = parser.add_subparsers(dest="command", required=True)

    cfg = sub.add_parser("config", help="Manage local CLI config", parents=[common])
    cfg_sub = cfg.add_subparsers(dest="config_action", required=True)
    cfg_init = cfg_sub.add_parser("init", help="Save CLI configuration", parents=[common])
    cfg_init.add_argument("--auto-cleanup-max-mb", type=float, help="Default local cache size cap (MB)")
    cfg_init.add_argument("--auto-cleanup-keep-latest", type=int, help="Default latest videos to keep")
    cfg_init.set_defaults(func=cmd_config_init)
    cfg_show = cfg_sub.add_parser("show", help="Show active config (token masked)", parents=[common])
    cfg_show.set_defaults(func=cmd_config_show)

    p_cap = sub.add_parser("capabilities", help="Discover channels, workflows, and presets", parents=[common])
    p_cap.set_defaults(func=cmd_capabilities)

    p_canvases = sub.add_parser("canvases", help="List canvases", parents=[common])
    p_canvases.add_argument("--query", help="Filter by canvas name or id")
    p_canvases.add_argument("--include-folders", action="store_true", help="Include folder subcanvases")
    p_canvases.set_defaults(func=cmd_canvases)

    p_create_canvas = sub.add_parser("create-canvas", help="Create a new canvas", parents=[common])
    p_create_canvas.add_argument("--name", required=True, help="Canvas name")
    p_create_canvas.add_argument("--shared", action="store_true", help="Mark canvas shared")
    p_create_canvas.add_argument("--request-id", help="Idempotent request ID")
    p_create_canvas.set_defaults(func=cmd_create_canvas)

    p_nodes = sub.add_parser("nodes", help="Inspect nodes in a canvas", parents=[common])
    p_nodes.add_argument("--canvas-id", required=True, help="Target canvas ID")
    p_nodes.add_argument("--kind", help="Optional node kind filter (text, video-generation, image, ...)")
    p_nodes.set_defaults(func=cmd_nodes)

    p_upload = sub.add_parser("upload", help="Upload reference image/audio/video asset", parents=[common])
    p_upload.add_argument("--file", required=True, help="Local asset file path")
    p_upload.add_argument("--canvas-id", help="Canvas ID (required when --create-node)")
    p_upload.add_argument("--create-node", action="store_true", help="Also create a canvas node")
    p_upload.add_argument(
        "--anchor-node-id",
        help="Optional existing text or video-generation node ID to top-align this media node beside",
    )
    p_upload.add_argument("--x", type=float, help="Optional node X coordinate")
    p_upload.add_argument("--y", type=float, help="Optional node Y coordinate")
    p_upload.set_defaults(func=cmd_upload)

    p_submit = sub.add_parser("submit", help="Submit async generation job", parents=[common])
    p_submit.add_argument("--canvas-id", help="Existing target canvas ID")
    p_submit.add_argument("--new-canvas", help="Create a new canvas with this name before submitting")
    p_submit.add_argument("--new-canvas-shared", action="store_true", help="Make the newly created canvas shared")
    p_submit.add_argument("--source-node-id", help="Existing text or video-generation node ID (mode=node)")
    p_submit.add_argument("--prompt-file", help="Path to UTF-8 text file containing the prompt")
    p_submit.add_argument("--prompt", help="Inline prompt text (prefer --prompt-file for long/UTF-8 prompts)")
    p_submit.add_argument("--info-file", help="Path to UTF-8 Chinese information/explanation file")
    p_submit.add_argument("--info", help="Inline information text")
    p_submit.add_argument("--title", help="Optional prompt node title")
    p_submit.add_argument(
        "--prompt-version-action",
        choices=["append", "overwrite", "none"],
        help="When iterating via --source-node-id with new prompt/info: append (default, adds v2/v3), overwrite, or none",
    )
    p_submit.add_argument("--no-prompt-node", action="store_true", help="Do not create a prompt node in standalone mode")
    p_submit.add_argument("--preset", help="Preset name or ID for local/colab H3 (discover via `capabilities`)")
    p_submit.add_argument(
        "--channel",
        default="local",
        choices=list(ALL_CHANNELS),
        help="Execution channel: local, colab, jimeng-cn, dreamina-jp, libtv, or lovart",
    )
    p_submit.add_argument("--workflow-module-id", help="Explicit local workflow module ID")
    p_submit.add_argument(
        "--model",
        help="External platform model ID/label (e.g. seedance_2.5, seedance_2.0_vip, Seedance 2.5, generate_video_seedance_v2_5)",
    )
    p_submit.add_argument(
        "--resolution",
        help="External platform resolution (e.g. 480p, 720p, 1080p, 4k, auto)",
    )
    p_submit.add_argument(
        "--provider-mode",
        help="External platform generation mode (e.g. auto, t2v, first_last_frame, m2v, text2video, image2video, mixed2video)",
    )
    sound_group = p_submit.add_mutually_exclusive_group()
    sound_group.add_argument(
        "--sound",
        dest="sound",
        action="store_true",
        default=None,
        help="Enable native audio output on supported external platforms (default on)",
    )
    sound_group.add_argument(
        "--no-sound",
        dest="sound",
        action="store_false",
        help="Mute native audio output on supported external platforms (e.g. libtv)",
    )
    p_submit.add_argument("--duration", type=float, help="Duration seconds (2..15 for H3, model-specific up to 30s for Seedance 2.5)")
    p_submit.add_argument("--aspect-ratio", help="Aspect ratio (16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 1:1)")
    p_submit.add_argument("--seed-mode", choices=["random", "fixed"], help="Seed mode")
    p_submit.add_argument("--seed", help="Fixed seed value")
    p_submit.add_argument("--ref-image-size", choices=["match", "max"], help="Reference image sizing mode")
    p_submit.add_argument("--colab-sampler", help="Colab sampler override")
    p_submit.add_argument("--secondary-sampling", action="store_true", help="Enable 2-pass sampling (local only)")
    p_submit.add_argument(
        "--image",
        action="append",
        help="Canvas image node ID starting with 'node:' (optionally :first or :last); upload with --create-node first",
    )
    p_submit.add_argument(
        "--audio",
        action="append",
        help="Canvas audio node ID starting with 'node:'; upload with --create-node first",
    )
    p_submit.add_argument(
        "--video",
        action="append",
        help="Canvas video node ID starting with 'node:'; upload with --create-node first",
    )
    p_submit.add_argument("--request-id", help="Stable idempotency request ID")
    p_submit.set_defaults(func=cmd_submit)

    p_status = sub.add_parser("status", help="Check job status", parents=[common])
    p_status.add_argument("--job-id", required=True, help="Job ID")
    p_status.set_defaults(func=cmd_status)

    p_wait = sub.add_parser("wait", help="Poll until job reaches terminal state", parents=[common])
    p_wait.add_argument("--job-id", required=True, help="Job ID")
    p_wait.add_argument("--timeout", type=float, default=900.0, help="Wait timeout seconds")
    p_wait.add_argument("--poll", type=float, default=5.0, help="Poll interval seconds")
    p_wait.set_defaults(func=cmd_wait)

    p_download = sub.add_parser("download", help="Download generated output video(s) locally", parents=[common])
    p_download.add_argument("--job-id", required=True, help="Succeeded job ID")
    p_download.add_argument("--index", default="0", help="Output index (0, 1, ...) or 'all'")
    p_download.add_argument("--out-dir", help="Local download cache directory override")
    p_download.add_argument("--auto-cleanup-mb", type=float, help="Enforce cache size limit after download")
    p_download.add_argument("--auto-cleanup-keep", type=int, help="Keep at most N latest cached videos after download")
    p_download.set_defaults(func=cmd_download)

    p_cancel = sub.add_parser("cancel", help="Cancel a running or queued job", parents=[common])
    p_cancel.add_argument("--job-id", required=True, help="Job ID")
    p_cancel.set_defaults(func=cmd_cancel)

    p_cleanup = sub.add_parser("cleanup", help="Safely clean locally cached downloaded videos", parents=[common])
    p_cleanup.add_argument("--out-dir", help="Local download cache directory override")
    p_cleanup.add_argument("--dry-run", action="store_true", help="Preview deletions without removing files")
    p_cleanup.add_argument("--older-than-days", type=float, help="Delete videos older than N days")
    p_cleanup.add_argument("--keep-latest", type=int, help="Keep only the newest N videos")
    p_cleanup.add_argument("--max-total-mb", type=float, help="Delete oldest videos until total size <= MB")
    p_cleanup.add_argument("--job-id", help="Delete cached videos for a specific jobId")
    p_cleanup.add_argument("--all", action="store_true", help="Delete all manifest-tracked cached videos")
    p_cleanup.add_argument("--prune-missing", action="store_true", help="Remove stale manifest entries whose files are gone")
    p_cleanup.set_defaults(func=cmd_cleanup)

    return parser


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

    parser = build_parser()
    args = parser.parse_args(argv)
    settings = _resolve_runtime_settings(args)
    try:
        result = args.func(args, settings)
        sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        return 0
    except CliError as exc:
        if exc.payload is not None:
            sys.stdout.write(json.dumps(exc.payload, ensure_ascii=False, indent=2) + "\n")
        sys.stderr.write(f"Error: {exc}\n")
        return exc.code


if __name__ == "__main__":
    raise SystemExit(main())
