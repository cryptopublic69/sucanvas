"""Exercise deployment scripts against disposable files and a local HTTP stub."""
from pathlib import Path
import argparse
import contextlib
import http.server
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--package', type=Path, required=True)
    package = parser.parse_args().package.resolve()
    with tempfile.TemporaryDirectory(prefix='deployment-smoke-', dir=ROOT / '.web-dev') as temporary:
        area = Path(temporary)
        deployment = area / 'deployment'
        deployment.mkdir()
        for folder in ['web', 'scripts']:
            shutil.copytree(package / folder, deployment / folder)
        shutil.copy2(package / 'web-assets.json', deployment / 'web-assets.json')
        (deployment / 'SuCanvasServer.exe').write_bytes(b'old deployment executable')
        (deployment / 'data').mkdir()
        database = deployment / 'data/infinite-canvas.sqlite3'
        with contextlib.closing(sqlite3.connect(database)) as connection:
            connection.execute('create table test(value text)')
            connection.execute("insert into test values ('retained')")
            connection.commit()
        original_database = database.read_bytes()
        (deployment / 'tools').mkdir()
        (deployment / 'tools/user-ffmpeg-setting.txt').write_text('retained')
        (deployment / 'Start-LAN.bat').write_text('user service switch')
        manifest = json.loads((deployment / 'web-assets.json').read_text(encoding='utf-8-sig'))
        script_path = next(asset['path'] for asset in manifest['assets'] if asset['path'].endswith('.js'))
        class Handler(http.server.SimpleHTTPRequestHandler):
            bad_asset = False
            def __init__(self, *args, **kwargs): super().__init__(*args, directory=str(deployment / 'web'), **kwargs)
            def log_message(self, *_): pass
            def do_GET(self):
                if self.path == '/api/auth/session': self.send_response(401); self.end_headers(); return
                if self.bad_asset and self.path == script_path: self.send_response(200); self.send_header('Content-Length', '0'); self.end_headers(); return
                super().do_GET()
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        origin = f'http://127.0.0.1:{server.server_port}'
        config = json.loads((package / 'config.json').read_text(encoding='utf-8-sig'))
        config['publicUrl'] = origin
        (deployment / 'config.json').write_text(json.dumps(config), encoding='utf-8')
        original_config = (deployment / 'config.json').read_bytes()
        shell_environment = os.environ.copy()
        # Windows PowerShell must load its own modules, not inherited PowerShell 7 modules.
        shell_environment['PSModulePath'] = str(Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/Modules')
        def run(script, *args, succeeds=True):
            script_root = deployment if script in ['Backup-Web.ps1', 'Restore-Web.ps1'] else package
            result = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(script_root / 'scripts' / script), *map(str, args)], capture_output=True, text=True, encoding='utf-8', errors='replace', env=shell_environment)
            assert (result.returncode == 0) is succeeds, result.stdout + result.stderr
            return result.stdout + result.stderr
        try:
            run('Test-WebDeployment.ps1', '-DeploymentDirectory', deployment, '-PublicUrl', origin, '-CheckHttp')
            Handler.bad_asset = True
            assert 'Empty or failed response' in run('Test-WebDeployment.ps1', '-DeploymentDirectory', deployment, '-CheckHttp', succeeds=False)
            Handler.bad_asset = False
            assert 'does not match' in run('Test-WebDeployment.ps1', '-DeploymentDirectory', deployment, '-PublicUrl', 'https://wrong.invalid', succeeds=False)
            proxy = deployment / 'proxy'
            proxy.mkdir()
            caddy = ROOT / '.web-dev/caddy.exe'
            if caddy.exists():
                shutil.copy2(caddy, proxy / 'caddy.exe')
                (proxy / 'Caddyfile').write_text('http://wrong.invalid:8099 {\n respond "mock"\n}\n')
                assert 'host matcher' in run('Test-WebDeployment.ps1', '-DeploymentDirectory', deployment, succeeds=False)
                (proxy / 'Caddyfile').write_text('http://127.0.0.1:8099 {\n respond "mock"\n}\n')
                run('Test-WebDeployment.ps1', '-DeploymentDirectory', deployment)
                (proxy / 'Caddyfile').write_text(':8099 {\n respond "mock"\n}\n')
                run('Test-WebDeployment.ps1', '-DeploymentDirectory', deployment)
                (proxy / 'Caddyfile').unlink()
            (deployment / 'backup/older').mkdir(parents=True)
            (deployment / 'backup/older/retained.txt').write_text('older backup')
            (deployment / 'web/index.html').write_text('old release')
            (deployment / 'web/assets/old-version').mkdir()
            (deployment / 'web/assets/old-version/retained.js').write_text('// old tab resource')
            if caddy.exists():
                (proxy / 'Caddyfile').write_text('http://wrong.invalid:8099 {\n respond "mock"\n}\n')
                assert 'previous published files restored' in run('Update-WebFiles.ps1', '-PackageDirectory', package, '-DeploymentDirectory', deployment, '-PublicUrl', origin, succeeds=False)
                assert (deployment / 'SuCanvasServer.exe').read_bytes() == b'old deployment executable'
                assert (deployment / 'web/index.html').read_text() == 'old release'
                assert database.read_bytes() == original_database
                (proxy / 'Caddyfile').unlink()
            run('Update-WebFiles.ps1', '-PackageDirectory', package, '-DeploymentDirectory', deployment, '-PublicUrl', origin)
            before_update = next((deployment / 'backup').glob('before-update-*'))
            assert not (before_update / 'backup').exists()
            assert (before_update / 'web/index.html').read_text() == 'old release'
            assert (before_update / 'data/infinite-canvas.sqlite3').read_bytes() == original_database
            assert (deployment / 'config.json').read_bytes() == original_config
            assert database.read_bytes() == original_database
            assert (deployment / 'Start-LAN.bat').read_text() == 'user service switch'
            assert (deployment / 'tools/user-ffmpeg-setting.txt').read_text() == 'retained'
            assert (deployment / 'web/assets/old-version/retained.js').read_text() == '// old tab resource'
            run('Test-WebDeployment.ps1', '-DeploymentDirectory', deployment, '-CheckHttp')
            outside = area / 'outside-backup'
            run('Backup-Web.ps1', '-Destination', outside, succeeds=False)
            assert not outside.exists()
            run('Backup-Web.ps1')
            data_backup = next((deployment / 'backup').glob('data-*'))
            with contextlib.closing(sqlite3.connect(database)) as connection:
                connection.execute("update test set value='changed'")
                connection.commit()
            changed_database = database.read_bytes()
            run('Restore-Web.ps1', '-BackupDirectory', data_backup)
            assert database.read_bytes() == original_database
            before_restore = next((deployment / 'backup').glob('data-before-restore-*'))
            assert (before_restore / 'infinite-canvas.sqlite3').read_bytes() == changed_database
            assert not list(deployment.glob('data.before-restore-*'))
            print('PASS: HTTP assets, empty-200 rejection, publicUrl mismatch, Caddy host checks and failed-update rollback when available, update backup/hash checks, retained config/data/service switch/tools/old assets, internal backup and restore directories')
        finally:
            server.shutdown()
            server.server_close()

if __name__ == '__main__': main()
