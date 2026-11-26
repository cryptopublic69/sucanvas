import datetime as dt
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import unittest


CLI_PATH = (
    pathlib.Path(__file__).resolve().parent.parent
    / "skills"
    / "sucanvas-h3-video"
    / "scripts"
    / "sucanvas_h3.py"
)


class MockState:
    def __init__(self) -> None:
        self.token = "test-bearer-token-123456"
        self.submit_calls = 0
        self.last_submit: dict = {}
        self.last_upload_filename = ""
        self.last_upload_anchor = ""
        self.poll_counts: dict[str, int] = {}
        self.finish_after_polls = 2
        self.video_bytes = b"\x00\x00\x00\x18ftypmp42cli-test-video"


def make_handler(state: MockState):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args) -> None:
            return

        def _send_json(self, status: int, payload: dict) -> None:
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _check_auth(self) -> bool:
            if self.headers.get("Authorization") != f"Bearer {state.token}":
                self._send_json(401, {"ok": False, "error": "unauthorized"})
                return False
            return True

        def do_GET(self) -> None:
            if not self._check_auth():
                return
            if self.path == "/v1/agent/capabilities":
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "presets": {
                            "local": {
                                "defaultPresetId": "p1",
                                "items": [{"id": "p1", "name": "电影级预设", "isDefault": True}],
                            }
                        },
                    },
                )
            elif self.path.startswith("/v1/agent/canvases/") and "/nodes" in self.path:
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "canvas": {"id": "canvas:1", "name": "Demo"},
                        "nodes": [{"id": "node:text-1", "kind": "text", "title": "S01"}],
                        "edges": [],
                    },
                )
            elif self.path.startswith("/v1/agent/canvases"):
                self._send_json(
                    200,
                    {"ok": True, "canvases": [{"id": "canvas:1", "name": "Demo"}]},
                )
            elif self.path == "/v1/agent/jobs/job%3A1":
                count = state.poll_counts.get("job:1", 0) + 1
                state.poll_counts["job:1"] = count
                status = "succeeded" if count >= state.finish_after_polls else "running"
                outputs = (
                    [{"filename": "成片_01.mp4", "subfolder": "", "fileType": "output"}]
                    if status == "succeeded"
                    else []
                )
                job_payload = {
                    "jobId": "job:1",
                    "canvasId": state.last_submit.get("canvasId", "canvas:1"),
                    "channel": state.last_submit.get("channel", "local"),
                    "presetName": state.last_submit.get("preset") or "即梦 CN · Seedance 2.5",
                    "status": status,
                    "outputs": outputs,
                }
                if state.last_submit.get("channel") in {"jimeng-cn", "dreamina-jp", "libtv", "lovart"}:
                    job_payload["externalProvider"] = state.last_submit.get("channel")
                    job_payload["externalModelId"] = state.last_submit.get("modelId", "seedance_2.5")
                    job_payload["stageMessage"] = "视频生成完成 · 消耗 35 积分" if status == "succeeded" else "排队中…"
                    job_payload["costCredits"] = 35 if status == "succeeded" else None
                self._send_json(200, {"ok": True, "job": job_payload})
            elif self.path == "/v1/agent/jobs/job%3A1/outputs/0":
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Length", str(len(state.video_bytes)))
                self.end_headers()
                self.wfile.write(state.video_bytes)
            else:
                self._send_json(404, {"ok": False, "error": "not found"})

        def do_POST(self) -> None:
            if not self._check_auth():
                return
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            if self.path == "/v1/agent/canvases":
                data = json.loads(body.decode("utf-8"))
                self._send_json(
                    201,
                    {"ok": True, "created": True, "canvas": {"id": "canvas:new", "name": data["name"]}},
                )
            elif self.path == "/v1/agent/assets":
                text = body.decode("utf-8", errors="replace")
                if 'filename="参考图.png"' in text:
                    state.last_upload_filename = "参考图.png"
                marker = 'name="anchorNodeId"\r\n\r\n'
                if marker in text:
                    state.last_upload_anchor = text.split(marker, 1)[1].split("\r\n", 1)[0]
                self._send_json(
                    201,
                    {
                        "ok": True,
                        "assetRef": "sucanvas-input://sucanvas-imports/asset-1.png",
                        "mediaKind": "image",
                        "filename": "参考图.png",
                    },
                )
            elif self.path == "/v1/agent/jobs":
                state.submit_calls += 1
                state.last_submit = json.loads(body.decode("utf-8"))
                self._send_json(
                    202,
                    {
                        "ok": True,
                        "job": {
                            "jobId": "job:1",
                            "requestId": state.last_submit.get("requestId"),
                            "canvasId": state.last_submit.get("canvasId", "canvas:new"),
                            "status": "running",
                        },
                    },
                )
            elif self.path == "/v1/agent/jobs/job%3A1/cancel":
                self._send_json(200, {"ok": True, "job": {"jobId": "job:1", "status": "cancelled"}})
            else:
                self._send_json(404, {"ok": False, "error": "not found"})

    return Handler


def run_cli(args: list[str], env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CLI_PATH), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        check=False,
    )


class TestSucanvasH3Cli(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.state = MockState()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.state))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        port = self.server.server_address[1]
        self.base_url = f"http://127.0.0.1:{port}"
        self.cfg_path = self.root / "cfg" / "config.json"
        self.dl_dir = self.root / "downloads"
        self.env = os.environ.copy()
        self.env["SUCANVAS_CONFIG"] = str(self.cfg_path)
        self.env.pop("SUCANVAS_TOKEN", None)
        self.env.pop("SUCANVAS_BASE_URL", None)

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def test_end_to_end_cli_and_safe_cleanup(self) -> None:
        # 1. Config init + show masks token.
        res = run_cli(
            [
                "config",
                "init",
                "--base-url",
                self.base_url,
                "--token",
                self.state.token,
                "--download-dir",
                str(self.dl_dir),
            ],
            self.env,
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        show = run_cli(["config", "show"], self.env)
        self.assertEqual(show.returncode, 0, show.stderr)
        self.assertNotIn(self.state.token, show.stdout)
        self.assertEqual(json.loads(show.stdout)["tokenMasked"], "test...3456")

        # 2. Capabilities + canvases + upload (UTF-8 Chinese filename).
        cap = run_cli(["capabilities"], self.env)
        self.assertEqual(cap.returncode, 0, cap.stderr)
        self.assertEqual(json.loads(cap.stdout)["presets"]["local"]["items"][0]["name"], "电影级预设")

        ref_file = self.root / "参考图.png"
        ref_file.write_bytes(b"png-bytes")
        up = run_cli(
            [
                "upload",
                "--file",
                str(ref_file),
                "--canvas-id",
                "canvas:1",
                "--create-node",
                "--anchor-node-id",
                "node:text-1",
            ],
            self.env,
        )
        self.assertEqual(up.returncode, 0, up.stderr)
        self.assertEqual(self.state.last_upload_filename, "参考图.png")
        self.assertEqual(self.state.last_upload_anchor, "node:text-1")
        asset_ref = json.loads(up.stdout)["assetRef"]

        # 3. Submit via UTF-8 prompt file & preset.
        prompt_file = self.root / "prompt.txt"
        prompt_file.write_text("夕阳下的海边漫步，中文与 English 混合", encoding="utf-8")
        sub = run_cli(
            [
                "submit",
                "--canvas-id",
                "canvas:1",
                "--prompt-file",
                str(prompt_file),
                "--preset",
                "电影级预设",
                "--image",
                asset_ref,
                "--request-id",
                "req-utf8-1",
            ],
            self.env,
        )
        self.assertEqual(sub.returncode, 0, sub.stderr)
        self.assertEqual(self.state.submit_calls, 1)
        self.assertEqual(self.state.last_submit["preset"], "电影级预设")
        self.assertIn("夕阳下", self.state.last_submit["prompt"])

        # 4. Wait timeout returns exit code 2 and does NOT re-submit.
        self.state.finish_after_polls = 99
        wait_timeout = run_cli(["wait", "--job-id", "job:1", "--timeout", "0.5", "--poll", "0.2"], self.env)
        self.assertEqual(wait_timeout.returncode, 2)
        self.assertEqual(self.state.submit_calls, 1)

        # 5. Wait succeeds and download writes manifest + MP4.
        self.state.finish_after_polls = 1
        wait_ok = run_cli(["wait", "--job-id", "job:1", "--timeout", "5", "--poll", "0.2"], self.env)
        self.assertEqual(wait_ok.returncode, 0, wait_ok.stderr)

        dl = run_cli(["download", "--job-id", "job:1"], self.env)
        self.assertEqual(dl.returncode, 0, dl.stderr)
        dl_data = json.loads(dl.stdout)
        saved_path = pathlib.Path(dl_data["downloaded"][0]["filePath"])
        self.assertTrue(saved_path.is_file())
        self.assertEqual(saved_path.read_bytes(), self.state.video_bytes)

        # 6. Cleanup: dry-run preserves files; outside paths are rejected; policies remove old/excess files.
        outside_file = self.root / "important_outside.mp4"
        outside_file.write_bytes(b"do-not-delete")
        extra_old = self.dl_dir / "old_job" / "old.mp4"
        extra_old.parent.mkdir(parents=True, exist_ok=True)
        extra_old.write_bytes(b"x" * 2048)

        manifest_file = self.dl_dir / "manifest.json"
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        old_time = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=10)).isoformat()
        manifest["entries"].append(
            {
                "jobId": "job:old",
                "filePath": str(extra_old),
                "sizeBytes": 2048,
                "downloadedAt": old_time,
            }
        )
        manifest["entries"].append(
            {
                "jobId": "job:escape",
                "filePath": str(outside_file),
                "sizeBytes": 13,
                "downloadedAt": old_time,
            }
        )
        manifest_file.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")

        dry = run_cli(["cleanup", "--dry-run", "--older-than-days", "5"], self.env)
        self.assertEqual(dry.returncode, 0, dry.stderr)
        dry_data = json.loads(dry.stdout)
        self.assertEqual(dry_data["deletedCount"], 1)
        self.assertEqual(len(dry_data["skipped"]), 1)
        self.assertTrue(extra_old.is_file())
        self.assertTrue(outside_file.is_file())

        real = run_cli(["cleanup", "--older-than-days", "5"], self.env)
        self.assertEqual(real.returncode, 0, real.stderr)
        real_data = json.loads(real.stdout)
        self.assertEqual(real_data["deletedCount"], 1)
        self.assertFalse(extra_old.exists())
        self.assertTrue(outside_file.is_file())
        self.assertTrue(saved_path.is_file())

        keep0 = run_cli(["cleanup", "--keep-latest", "0"], self.env)
        self.assertEqual(keep0.returncode, 0, keep0.stderr)
        self.assertFalse(saved_path.exists())
        self.assertTrue(outside_file.is_file())

    def test_new_canvas_node_mode_cancel_and_quota_cleanup(self) -> None:
        run_cli(
            [
                "config",
                "init",
                "--base-url",
                self.base_url,
                "--token",
                self.state.token,
                "--download-dir",
                str(self.dl_dir),
            ],
            self.env,
        )
        # 1. Submit with --new-canvas
        new_sub = run_cli(
            [
                "submit",
                "--new-canvas",
                "新建画布任务",
                "--prompt",
                "A calm lake at dawn",
                "--preset",
                "电影级预设",
                "--request-id",
                "req-new-canvas-1",
            ],
            self.env,
        )
        self.assertEqual(new_sub.returncode, 0, new_sub.stderr)
        self.assertEqual(self.state.last_submit["createCanvas"]["name"], "新建画布任务")
        self.assertEqual(self.state.last_submit["mode"], "standalone")

        # 2. Submit with --source-node-id (node mode) + prompt version iteration
        node_sub = run_cli(
            [
                "submit",
                "--canvas-id",
                "canvas:1",
                "--source-node-id",
                "node:text-1",
                "--prompt",
                "Updated v2 prompt",
                "--prompt-version-action",
                "append",
                "--preset",
                "电影级预设",
                "--request-id",
                "req-node-1",
            ],
            self.env,
        )
        self.assertEqual(node_sub.returncode, 0, node_sub.stderr)
        self.assertEqual(self.state.last_submit["mode"], "node")
        self.assertEqual(self.state.last_submit["sourceNodeId"], "node:text-1")
        self.assertEqual(self.state.last_submit["prompt"], "Updated v2 prompt")
        self.assertEqual(self.state.last_submit["promptVersionAction"], "append")

        # 3. Cancel job
        cancel = run_cli(["cancel", "--job-id", "job:1"], self.env)
        self.assertEqual(cancel.returncode, 0, cancel.stderr)
        self.assertEqual(json.loads(cancel.stdout)["job"]["status"], "cancelled")

        # 4. Quota cleanup: --max-total-mb and --job-id
        self.dl_dir.mkdir(parents=True, exist_ok=True)
        f1 = self.dl_dir / "j1" / "clip1.mp4"
        f2 = self.dl_dir / "j2" / "clip2.mp4"
        f3 = self.dl_dir / "j3" / "clip3.mp4"
        for f in (f1, f2, f3):
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(b"a" * (1024 * 1024))  # 1 MiB each
        t0 = dt.datetime.now(dt.timezone.utc)
        manifest = {
            "version": 1,
            "entries": [
                {"jobId": "job:a", "filePath": str(f1), "sizeBytes": 1048576, "downloadedAt": (t0 - dt.timedelta(hours=3)).isoformat()},
                {"jobId": "job:b", "filePath": str(f2), "sizeBytes": 1048576, "downloadedAt": (t0 - dt.timedelta(hours=2)).isoformat()},
                {"jobId": "job:c", "filePath": str(f3), "sizeBytes": 1048576, "downloadedAt": (t0 - dt.timedelta(hours=1)).isoformat()},
            ],
        }
        (self.dl_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

        cap_clean = run_cli(["cleanup", "--max-total-mb", "2.1"], self.env)
        self.assertEqual(cap_clean.returncode, 0, cap_clean.stderr)
        self.assertEqual(json.loads(cap_clean.stdout)["deletedCount"], 1)
        self.assertFalse(f1.exists())
        self.assertTrue(f2.exists())
        self.assertTrue(f3.exists())

        by_job = run_cli(["cleanup", "--job-id", "job:b"], self.env)
        self.assertEqual(by_job.returncode, 0, by_job.stderr)
        self.assertEqual(json.loads(by_job.stdout)["deletedCount"], 1)
        self.assertFalse(f2.exists())
        self.assertTrue(f3.exists())

    def test_external_provider_channels_submit_wait_and_download(self) -> None:
        run_cli(
            [
                "config",
                "init",
                "--base-url",
                self.base_url,
                "--token",
                self.state.token,
                "--download-dir",
                str(self.dl_dir),
            ],
            self.env,
        )
        for ch in ("jimeng-cn", "dreamina-jp", "libtv", "lovart"):
            self.state.poll_counts.clear()
            sub = run_cli(
                [
                    "submit",
                    "--canvas-id",
                    "canvas:1",
                    "--source-node-id",
                    "node:text-1",
                    "--channel",
                    ch,
                    "--model",
                    "seedance_2.5",
                    "--resolution",
                    "720p",
                    "--provider-mode",
                    "m2v",
                    "--no-sound",
                    "--duration",
                    "8",
                    "--aspect-ratio",
                    "16:9",
                    "--prompt",
                    "External platform smoke prompt",
                    "--request-id",
                    f"req-ext-{ch}",
                ],
                self.env,
            )
            self.assertEqual(sub.returncode, 0, sub.stderr)
            self.assertEqual(self.state.last_submit["kind"], "external-video")
            self.assertEqual(self.state.last_submit["channel"], ch)
            self.assertEqual(self.state.last_submit["modelId"], "seedance_2.5")
            self.assertEqual(self.state.last_submit["resolution"], "720p")
            self.assertEqual(self.state.last_submit["externalMode"], "m2v")
            self.assertIs(self.state.last_submit["enableSound"], False)
            self.assertNotIn("preset", self.state.last_submit)

        self.state.finish_after_polls = 1
        wait_res = run_cli(["wait", "--job-id", "job:1", "--timeout", "5", "--poll", "0.2"], self.env)
        self.assertEqual(wait_res.returncode, 0, wait_res.stderr)
        wait_data = json.loads(wait_res.stdout)
        self.assertEqual(wait_data["job"]["costCredits"], 35)

        dl = run_cli(["download", "--job-id", "job:1"], self.env)
        self.assertEqual(dl.returncode, 0, dl.stderr)
        dl_path = pathlib.Path(json.loads(dl.stdout)["downloaded"][0]["filePath"])
        self.assertEqual(dl_path.read_bytes(), self.state.video_bytes)


if __name__ == "__main__":
    unittest.main()
