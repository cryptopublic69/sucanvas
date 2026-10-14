"""Run the real local updater against disposable files, without starting a service or UI."""
from pathlib import Path
import hashlib
import json
import msvcrt
import os
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def write_json(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")


def package_at(path, version, full=False):
    asset = path / "web/assets" / version / "entry.js"
    asset.parent.mkdir(parents=True)
    asset.write_text(f"// {version}", encoding="utf-8")
    index = path / "web/index.html"
    index.write_text(f'<script src="/assets/{version}/entry.js"></script>', encoding="utf-8")
    describe = lambda file: {"sha256": hashlib.sha256(file.read_bytes()).hexdigest().upper(), "bytes": file.stat().st_size}
    write_json(path / "web-assets.json", {"assetVersion": version, "index": describe(index),
        "assets": [{"path": f"/assets/{version}/entry.js", **describe(asset)}]})
    write_json(path / "build-info.json", {"assetVersion": version})
    write_json(path / "config.json", {"publicUrl": "https://example.invalid", "webDirectory": "web", "dataDirectory": "data"})
    if full:
        (path / "SuCanvasServer.exe").write_bytes(b"new server")
        for directory in ["scripts", "workflows"]:
            (path / directory).mkdir()
            (path / directory / "new.txt").write_bytes(b"new release file")


def snapshot(path):
    return {str(file.relative_to(path)): file.read_bytes() for file in path.rglob("*")
        if file.is_file() and "backup" not in file.relative_to(path).parts and file.name != "server.lock"}


def main():
    env = os.environ.copy()
    windows_root = env.get("SystemRoot") or env.get("SYSTEMROOT") or r"C:\Windows"
    env["PSModulePath"] = str(Path(windows_root) / "System32/WindowsPowerShell/v1.0/Modules")
    (ROOT / ".web-dev").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="local-updater-smoke-", dir=ROOT / ".web-dev") as temporary:
        area = Path(temporary)
        runner = area / "runner"
        (runner / "scripts").mkdir(parents=True)
        shutil.copy2(ROOT / "scripts/web/Update-OnServer.ps1", runner)
        for name in ["Update-WebFiles.ps1", "Test-WebDeployment.ps1"]:
            shutil.copy2(ROOT / "scripts/web" / name, runner / "scripts")

        def fixture(name):
            deployment = area / name
            package_at(deployment, "old")
            (deployment / "SuCanvasServer.exe").write_bytes(b"old server")
            (deployment / "server.lock").write_bytes(b"0")
            for directory in ["data", "tools", "scripts", "workflows", "proxy", "logs"]:
                (deployment / directory).mkdir()
                (deployment / directory / "user-owned.txt").write_bytes(b"retained")
            (deployment / "Start-LAN.bat").write_bytes(b"original service switch")
            return deployment

        def run(deployment, package, succeeds=True):
            process = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                str(runner / "Update-OnServer.ps1"), "-PackageDirectory", str(package),
                "-DeploymentDirectory", str(deployment)], capture_output=True, env=env)
            output = (process.stdout + process.stderr).decode("utf-8", errors="replace")
            assert (process.returncode == 0) == succeeds, output
            return output

        frontend = area / "frontend-package"
        package_at(frontend, "frontend")
        deployment = fixture("frontend-deployment")
        before = snapshot(deployment)
        run(deployment, frontend)
        assert json.loads((deployment / "build-info.json").read_text(encoding="utf-8-sig"))["assetVersion"] == "frontend"
        published = {"build-info.json", "web-assets.json", "web\\index.html"}
        for relative, value in before.items():
            if relative not in published:
                assert (deployment / relative).read_bytes() == value, relative
        backup = next((deployment / "backup").glob("before-update-*"))
        for relative, value in before.items():
            assert (backup / relative).read_bytes() == value, f"Backup mismatch: {relative}"
        assert (deployment / "web/assets/old/entry.js").is_file()
        assert json.loads((runner / "deployment-result.json").read_text(encoding="utf-8-sig"))["ServerRestarted"] is False
        print("PASS: frontend update, complete backup and retained state")

        full = area / "full-package"
        package_at(full, "full", full=True)
        deployment = fixture("full-deployment")
        run(deployment, full)
        assert (deployment / "SuCanvasServer.exe").read_bytes() == b"new server"
        assert (deployment / "data/user-owned.txt").read_bytes() == b"retained"
        assert (deployment / "Start-LAN.bat").read_bytes() == b"original service switch"
        print("PASS: full release updates server and keeps data and service switch")

        deployment = fixture("locked-deployment")
        before = snapshot(deployment)
        with (deployment / "server.lock").open("r+b") as lock:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            try:
                run(deployment, frontend, succeeds=False)
            finally:
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
        assert snapshot(deployment) == before
        assert not (deployment / "backup").exists()
        print("PASS: running-service lock prevents any backup or replacement")

        corrupt = area / "corrupt-package"
        package_at(corrupt, "corrupt")
        (corrupt / "web/assets/corrupt/entry.js").write_bytes(b"wrong bytes")
        deployment = fixture("corrupt-deployment")
        before = snapshot(deployment)
        run(deployment, corrupt, succeeds=False)
        assert snapshot(deployment) == before
        assert not (deployment / "backup").exists()
        print("PASS: corrupted upload is rejected before backup or publication")

        # Force a validation error after publication to exercise real rollback.
        validator = runner / "scripts/Test-WebDeployment.ps1"
        validator.rename(validator.with_name("Test-WebDeployment.Real.ps1"))
        validator.write_text("param([string]$DeploymentDirectory,[string]$PublicUrl)\n"
            "& (Join-Path $PSScriptRoot 'Test-WebDeployment.Real.ps1') @PSBoundParameters\n"
            "if ($DeploymentDirectory.EndsWith('rollback-deployment')) { throw 'Injected validation failure' }\n", encoding="utf-8")
        deployment = fixture("rollback-deployment")
        before = snapshot(deployment)
        run(deployment, full, succeeds=False)
        for relative, value in before.items():
            assert (deployment / relative).read_bytes() == value, f"Rollback mismatch: {relative}"
        assert not (deployment / "workflows/new.txt").exists()
        assert not (deployment / "scripts/new.txt").exists()
        assert json.loads((runner / "deployment-result.json").read_text(encoding="utf-8-sig"))["Succeeded"] is False
        print("PASS: post-publication failure restores previous files and preserves data")

        output = run(r"\\108\f\SuCanvas-Web", frontend, succeeds=False)
        assert "local F: drive" in output
        print("PASS: launching against a network share is rejected")


if __name__ == "__main__":
    main()
