"""HTTP and relocation checks in disposable directories. No browser automation."""
from pathlib import Path
import base64
import argparse
import contextlib
import http.cookiejar
import http.server
import json
import os
import re
import secrets
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / 'release-web/SuCanvas-Web'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM6sAAAAASUVORK5CYII=')
CLIENT_ID = 'smoke-client'

class ComfyStub(http.server.BaseHTTPRequestHandler):
    view_queries = []
    def log_message(self, *_): pass
    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == '/view':
            self.view_queries.append(urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query))
            payload = PNG
        elif path == '/queue': payload = json.dumps({'queue_running': [], 'queue_pending': []}).encode()
        elif path == '/history': payload = json.dumps({'smoke-prompt': {
            'prompt': [1, 'smoke-prompt', {'sampler': {'inputs': {'seed': 42}}}, {'client_id': CLIENT_ID}],
            'status': {'status_str': 'success'},
            'outputs': {'42': {'images': [{'filename': 'generated.png', 'subfolder': '', 'type': 'output'}]}}
        }}).encode()
        else: self.send_error(404); return
        self.send_response(200)
        self.send_header('Content-Type', 'image/png' if path == '/view' else 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers(); self.wfile.write(payload)

def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); return sock.getsockname()[1]

def start(directory):
    process = subprocess.Popen([str(directory / 'SuCanvasServer.exe'), '--config', str(directory / 'config.json')],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    for _ in range(100):
        if process.poll() is not None:
            raise AssertionError(process.stderr.read().decode('utf-8', 'replace'))
        try:
            urllib.request.urlopen(json.loads((directory / 'config.json').read_text())['publicUrl'], timeout=.2).close()
            return process
        except (OSError, urllib.error.URLError): time.sleep(.05)
    process.terminate(); process.wait(); raise AssertionError('Server startup timed out')

def stop(process):
    if process and process.poll() is None: process.terminate(); process.wait(timeout=10)

def desktop_backup_fixture(original, destination, database_file, desktop_lock):
    """Match desktop backups: absolute asset paths and no Web-specific files."""
    desktop_data = r'D:\Desktop\SuCanvasData\data'
    def absolute_assets(value):
        if isinstance(value, str) and value.startswith('sucanvas://assets/'):
            return desktop_data+'\\'+value[len('sucanvas://'):].replace('/', '\\')
        if isinstance(value, dict): return {key: absolute_assets(item) for key, item in value.items()}
        if isinstance(value, list): return [absolute_assets(item) for item in value]
        return value
    with zipfile.ZipFile(original) as source:
        database_file.write_bytes(source.read('data/infinite-canvas.sqlite3'))
        with contextlib.closing(sqlite3.connect(database_file)) as database:
            for node_id, content in database.execute('SELECT id, content_json FROM nodes').fetchall():
                database.execute('UPDATE nodes SET content_json=? WHERE id=?', [json.dumps(absolute_assets(json.loads(content))), node_id])
            for project_id, path in database.execute('SELECT id, preview_image_path FROM canvases WHERE preview_image_path IS NOT NULL').fetchall():
                database.execute('UPDATE canvases SET preview_image_path=? WHERE id=?', [absolute_assets(path), project_id])
            database.commit()
        with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as target:
            for entry in source.infolist():
                if entry.filename in {'data/web-auth.json', 'data/web-settings.json', 'data/web-integration-token', 'data/infinite-canvas.sqlite3-wal', 'data/infinite-canvas.sqlite3-shm'}: continue
                if entry.filename == 'data/infinite-canvas.sqlite3':
                    target.write(database_file, entry.filename)
                elif entry.filename == 'data/app-lock.json':
                    # A desktop backup may contain a different application lock.
                    target.writestr(entry, desktop_lock)
                elif entry.filename == 'backup-manifest.json':
                    manifest = json.loads(source.read(entry))
                    manifest['sourceDataDir'] = desktop_data
                    target.writestr(entry, json.dumps(manifest))
                else: target.writestr(entry, source.read(entry))

def main():
    global PACKAGE
    parser = argparse.ArgumentParser()
    parser.add_argument('--package', type=Path, default=PACKAGE)
    PACKAGE = parser.parse_args().package.resolve()
    assert (PACKAGE / 'SuCanvasServer.exe').is_file(), 'Build the portable package first'
    test_area = ROOT / '.web-dev'
    test_area.mkdir(exist_ok=True)
    comfy = http.server.ThreadingHTTPServer(('127.0.0.1', 0), ComfyStub)
    threading.Thread(target=comfy.serve_forever, daemon=True).start()
    source_process = moved_process = None
    with tempfile.TemporaryDirectory(prefix='http-relocation-', dir=test_area) as temporary:
        area = Path(temporary).resolve()
        assert area.is_relative_to(test_area.resolve())
        source, moved = area / 'source deployment', area / 'moved deployment'
        # Every copied/moved/deleted test directory stays in the verified test area.
        for path in [source, moved, area / 'backup']:
            assert path.resolve().is_relative_to(area)
        source.mkdir()
        shutil.copy2(PACKAGE / 'SuCanvasServer.exe', source)
        shutil.copytree(PACKAGE / 'web', source / 'web')
        shutil.copytree(PACKAGE / 'scripts', source / 'scripts')
        shutil.copytree(PACKAGE / 'workflows', source / 'workflows')
        config = json.loads((PACKAGE / 'config.json').read_text(encoding='utf-8-sig'))
        config['listen'] = f'127.0.0.1:{port()}'
        config['publicUrl'] = f'http://{config["listen"]}'
        lan_origin = 'https://192.168.5.108:18741'
        config['allowedOrigins'] = [lan_origin]
        config['comfyUrl'] = f'http://127.0.0.1:{comfy.server_port}'
        (source / 'config.json').write_text(json.dumps(config), encoding='utf-8')
        password = secrets.token_urlsafe(24)
        init = subprocess.run([str(source / 'SuCanvasServer.exe'), '--config', str(source / 'config.json'), '--set-password'], input=password+'\n', text=True, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        assert init.returncode == 0, init.stderr
        initial_lock = (source / 'data/app-lock.json').read_bytes()
        base = config['publicUrl']
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        def request(path, data=None, *, method=None, origin=None, anonymous=False, headers=None, client=None):
            body = json.dumps(data).encode() if data is not None else None
            values = {'Origin': origin or base}
            if body is not None: values['Content-Type'] = 'application/json'
            values.update(headers or {})
            req = urllib.request.Request(base+path, data=body, method=method, headers=values)
            client = client or (urllib.request.build_opener() if anonymous else opener)
            try:
                response = client.open(req, timeout=15)
                with response: return response.status, response.read(), response.headers
            except urllib.error.HTTPError as error: return error.code, error.read(), error.headers
        def invoke(command, args=None):
            status, body, _ = request('/api/invoke/'+command, {'args': args or {}})
            assert status == 200, (command, status, body)
            return json.loads(body)['result']
        try:
            source_process = start(source)
            html = request('/', anonymous=True)[1].decode()
            favicon = re.search(r'<link\s+rel="icon"[^>]+href="([^"]+)"', html).group(1)
            assert request(favicon, anonymous=True)[1] == (ROOT / 'src-tauri/icons/icon.ico').read_bytes()
            assert (source / 'data/app-lock.json').is_file()
            assert not (source / 'data/web-auth.json').exists()
            assert request('/api/settings', anonymous=True)[0] == 401
            assert request('/api/invoke/load_workspace', {'args': {}}, anonymous=True)[0] == 401
            assert request('/api/invoke/get_app_lock_status', {'args': {}}, anonymous=True)[0] == 401
            assert request('/api/events', anonymous=True)[0] == 401
            assert request('/v1/health', anonymous=True)[0] == 401
            assert request('/api/auth/login', {'password': password}, origin='https://untrusted.invalid')[0] == 403
            assert request('/api/auth/login', {'password': password}, origin='https://192.168.5.108:18742')[0] == 403
            assert request('/api/auth/login', {'password': password}, origin='null')[0] == 403
            assert request('/api/auth/login', {}, origin=lan_origin)[0] == 422
            assert request('/api/auth/login', {}, headers={'Origin': ''})[0] == 403
            assert request('/api/comfy/ws', origin='https://untrusted.invalid', headers={'Upgrade': 'websocket'})[0] == 403
            assert request('/api/auth/login', {'password': 'wrong-password'})[0] == 401
            assert request('/api/auth/login', {'password': password})[0] == 200
            assert json.loads(request('/api/auth/session')[1])['publicUrl'] == base
            assert request('/api/invoke/load_workspace', {'args': {}}, origin=lan_origin)[0] == 200
            assert all(cookie.has_nonstandard_attr('HttpOnly') for cookie in jar)
            assert invoke('get_app_lock_status')['enabled'] is True
            assert request('/api/invoke/disable_app_lock', {'args': {'password': password}})[0] == 400
            second = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            status, body, _ = request('/api/auth/login', {'password': password}, origin=lan_origin, client=second)
            assert status == 200 and json.loads(body)['publicUrl'] == base
            second_events = second.open(urllib.request.Request(base+'/api/events'), timeout=10)
            assert json.loads(second_events.readline().decode().removeprefix('data:').strip())['event'] == 'web://ready'
            assert request('/api/invoke/set_app_lock_password', {'args': {'input': {'currentPassword': 'wrong-password', 'newPassword': 'next-password'}}})[0] == 400
            assert request('/api/auth/session', client=second)[0] == 200
            old_password, password = password, secrets.token_urlsafe(24)
            invoke('set_app_lock_password', {'input': {'currentPassword': old_password, 'newPassword': password}})
            assert request('/v1/nodes', {'kind': 'text', 'title': 'Revoked SSE check', 'content': {'text': 'private'}, 'source': 'codex'})[0] == 201
            # The revoked stream must close without delivering this private event.
            assert second_events.read() == b'\n'
            second_events.close()
            assert request('/api/auth/session')[0] == 200
            assert request('/api/auth/session', client=second)[0] == 401
            assert request('/api/settings', client=second)[0] == 401
            assert request('/api/auth/login', {'password': old_password}, client=second)[0] == 401
            assert request('/api/auth/login', {'password': password}, client=second)[0] == 200
            project = invoke('create_project', {'input': {'name': 'Web migration smoke'}})['canvas']['id']
            invoke('load_workspace', {'canvasId': project})
            workflows = invoke('list_workflow_modules', {'includeDeleted': False})
            assert workflows
            text = invoke('create_node', {'input': {'canvasId': project, 'kind': 'text', 'title': 'Test', 'content': {'text': 'portable'}, 'source': 'user'}})['node']
            assert text['content']['text'] == 'portable'
            boundary = secrets.token_hex(12)
            upload = (f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n'.encode()+PNG+f'\r\n--{boundary}--\r\n'.encode())
            req = urllib.request.Request(base+'/api/upload', data=upload, headers={'Origin': base, 'Content-Type': f'multipart/form-data; boundary={boundary}'})
            with opener.open(req, timeout=10) as result: resource = json.load(result)['paths'][0]
            image = invoke('import_media', {'path': resource, 'canvasId': project, 'x': 20, 'y': 30})['node']
            asset = image['content']['assetPath']
            assert asset.startswith('sucanvas://assets/')
            assert image['content']['originalName'] == 'test.png'
            invoke('set_project_preview_image', {'input': {'projectId': project, 'imageNodeId': image['id']}})
            url = '/api/resource?resource='+urllib.parse.quote(asset, safe='')
            assert request(url)[1] == PNG
            assert request(url, anonymous=True)[0] == 401
            # Uploaded source downloads stream the retained bytes directly;
            # browser downloads do not need a server export directory.
            status, downloaded, download_headers = request(url+'&download=true&filename=test.png')
            assert status == 200 and downloaded == PNG
            assert download_headers['Content-Disposition'] == 'attachment; filename="test.png"; filename*=UTF-8\'\'test.png', download_headers['Content-Disposition']
            original_name = '原始图片.png'
            renamed_headers = request(url+'&download=true&filename='+urllib.parse.quote(original_name))[2]
            assert "filename*=UTF-8''"+urllib.parse.quote(original_name) in renamed_headers['Content-Disposition']
            proxy_download = '/api/comfy/view?filename=source.png&type=output&download=true&downloadName='+urllib.parse.quote(original_name)
            status, downloaded, proxy_headers = request(proxy_download)
            assert status == 200 and downloaded == PNG
            assert "filename*=UTF-8''"+urllib.parse.quote(original_name) in proxy_headers['Content-Disposition']
            assert ComfyStub.view_queries[-1] == {'filename': ['source.png'], 'type': ['output']}
            assert request(proxy_download, anonymous=True)[0] == 401
            assert request(url+'&download=true', anonymous=True)[0] == 401
            assert not any((source / 'downloads').iterdir())
            status, data, _ = request(url, headers={'Range': 'bytes=0-7'})
            assert status == 206 and data == PNG[:8]
            assert request('/api/resource?resource=sucanvas%3A%2F%2Fweb-auth.json')[0] == 404
            assert request('/api/resource?resource=sucanvas%3A%2F%2Fapp-lock.json')[0] == 404
            assert request('/api/resource?resource=sucanvas%3A%2F%2Fassets%2F..%2Fweb-auth.json')[0] == 400
            assert request('/api/invoke/import_media', {'args': {'path': r'C:\Windows\win.ini', 'canvasId': project, 'x': 0, 'y': 0}})[0] == 400
            assert request('/api/settings', {'infinite-canvas:smoke': 'retained', 'unrelated': 'ignored'}, method='PUT')[0] == 200
            assert 'unrelated' not in json.loads(request('/api/settings')[1])
            token = (source / 'data/web-integration-token').read_text()
            assert request('/v1/health', anonymous=True, headers={'Authorization': 'Bearer '+token})[0] == 200
            event = opener.open(urllib.request.Request(base+'/api/events'), timeout=5)
            assert json.loads(event.readline().decode().removeprefix('data:').strip())['event'] == 'web://ready'
            assert request('/v1/nodes', {'kind': 'text', 'title': 'External API', 'content': {'text': 'event'}, 'source': 'codex'})[0] == 201
            while True:
                line = event.readline().decode()
                if line.startswith('data:'):
                    assert json.loads(line[5:])['event'] == 'canvas://node-created'; break
            event.close()
            recovered = invoke('get_comfyui_client_task_statuses', {'serverUrl': 'http://ignored.invalid', 'clientIds': [CLIENT_ID], 'imageClientIds': [CLIENT_ID]})
            output = recovered[0]['outputs'][0]
            assert output['url'].startswith('/api/resource?') and output['assetPath'].startswith('sucanvas://assets/generated-')
            assert request(output['url'])[1] == PNG
            with contextlib.closing(sqlite3.connect(source / 'data/infinite-canvas.sqlite3')) as database:
                content = database.execute('SELECT content_json FROM nodes WHERE id=?', [image['id']]).fetchone()[0]
                assert json.loads(content)['assetPath'] == asset
                assert str(source) not in content
                assert database.execute('SELECT preview_image_path FROM canvases WHERE id=?', [project]).fetchone()[0] == asset
            stop(source_process)
            backup = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(source/'scripts/Backup-Web.ps1'), '-Destination', str(source/'backup/script-backup')], capture_output=True, text=True)
            assert backup.returncode == 0, backup.stderr
            shutil.copytree(source, moved)
            config['listen'] = f'127.0.0.1:{port()}'
            config['publicUrl'] = f'http://{config["listen"]}'
            (moved / 'config.json').write_text(json.dumps(config), encoding='utf-8')
            restore = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(moved/'scripts/Restore-Web.ps1'), '-BackupDirectory', str(moved/'backup/script-backup')], capture_output=True, text=True)
            assert restore.returncode == 0, restore.stderr
            base = config['publicUrl']
            moved_process = start(moved)
            assert request('/api/auth/session')[0] == 401
            assert request('/api/auth/login', {'password': password})[0] == 200
            restored = invoke('load_workspace', {'canvasId': project})
            assert any(node['id'] == image['id'] and node['content']['assetPath'] == asset for node in restored['nodes'])
            assert restored['canvas']['previewImagePath'] == asset
            assert request(url)[1] == PNG
            assert request(output['url'])[1] == PNG
            assert json.loads(request('/api/settings')[1])['infinite-canvas:smoke'] == 'retained'
            moved_workflows = invoke('list_workflow_modules', {'includeDeleted': False})
            assert {module['id'] for module in workflows} == {module['id'] for module in moved_workflows}
            assert all(module['workflowPath'].startswith('sucanvas://workflow-modules/') for module in moved_workflows)
            large_setting = json.dumps({'label': '桌面迁移预设', 'payload': '设置' * 40_000}, ensure_ascii=False)
            exported_settings = {'infinite-canvas:theme': 'light', 'infinite-canvas:restore-test-presets': large_setting, 'infinite-canvas:comfy-server-url': 'http://old-server.invalid', 'infinite-canvas:comfy-input-root': 'Z:/old/input'}
            backup_name = 'SuCanvas-软件备份.sucanvas-backup'
            archive = invoke('export_app_backup', {'destinationPath': 'sucanvas-export://smoke/'+backup_name, 'frontendSettings': exported_settings})
            assert archive['path'].startswith('sucanvas-export://')
            status, backup_bytes, backup_headers = request('/api/resource?resource='+urllib.parse.quote(archive['path'], safe='')+'&download=true')
            assert status == 200 and backup_bytes.startswith(b'PK')
            disposition = backup_headers['Content-Disposition']
            assert 'filename="SuCanvas-____.sucanvas-backup"' in disposition
            assert "filename*=UTF-8''"+urllib.parse.quote(backup_name, safe='') in disposition
            # Import the downloaded bytes through the same upload flow used on
            # another Web server, with the filename supplied by the response.
            boundary = 'backup-smoke-boundary'
            backup_upload = (f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{backup_name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode()+backup_bytes+f'\r\n--{boundary}--\r\n'.encode())
            req = urllib.request.Request(base+'/api/upload', data=backup_upload, headers={'Origin': base, 'Content-Type': f'multipart/form-data; boundary={boundary}'})
            with opener.open(req) as response: uploaded_backup = json.load(response)['paths'][0]
            assert uploaded_backup.endswith(backup_name)
            invoke('stage_app_backup_restore', {'bundlePath': uploaded_backup})
            stop(moved_process)
            moved_process = start(moved)
            assert request('/api/auth/login', {'password': password})[0] == 200
            # Read settings before any canvas restore call or browser writeback.
            imported_settings = json.loads(request('/api/settings')[1])
            assert imported_settings['infinite-canvas:theme'] == 'light'
            assert imported_settings['infinite-canvas:restore-test-presets'] == large_setting
            assert imported_settings['infinite-canvas:comfy-server-url'] == base+'/api/comfy'
            assert imported_settings['infinite-canvas:comfy-input-root'] == ''
            assert invoke('take_restored_frontend_settings') is None
            assert not (moved / 'data/restored-frontend-settings.json').exists()
            assert json.loads((moved / 'data/web-settings.json').read_text(encoding='utf-8'))['infinite-canvas:restore-test-presets'] == large_setting
            # Re-login and restart without a pagehide/settings PUT must retain it.
            stop(moved_process)
            moved_process = start(moved)
            assert request('/api/auth/login', {'password': password})[0] == 200
            assert json.loads(request('/api/settings')[1])['infinite-canvas:restore-test-presets'] == large_setting
            desktop_archive = moved / 'downloads/smoke/desktop.sucanvas-backup'
            desktop_backup_fixture(moved / 'downloads/smoke' / backup_name, desktop_archive, area / 'desktop.sqlite3', initial_lock)
            invoke('stage_app_backup_restore', {'bundlePath': 'sucanvas-export://smoke/desktop.sucanvas-backup'})
            stop(moved_process)
            moved_process = start(moved)
            assert request('/api/auth/login', {'password': password})[0] == 200
            assert json.loads(request('/api/settings')[1])['infinite-canvas:restore-test-presets'] == large_setting
            restored = invoke('load_workspace', {'canvasId': project})
            assert any(node['id'] == image['id'] and node['content']['assetPath'] == asset for node in restored['nodes'])
            assert request(url)[1] == PNG
            assert restored['canvas']['previewImagePath'] == asset
            assert request(url)[1] == PNG
            assert request('/api/auth/logout', {}, method='POST')[0] == 200
            assert request(url)[0] == 401
            print('PASS: unified application lock, anonymous API rejection, live password change, old session revocation, CSRF, CRUD, upload, original Chinese download names, ComfyUI proxy download names, application favicon, media ranges, file boundaries, SSE, external API, ComfyUI output retention, workflows, Web/desktop backup settings before canvas load, repeated restart and relocation')
        finally:
            stop(source_process); stop(moved_process)
            comfy.shutdown(); comfy.server_close()

if __name__ == '__main__': main()
