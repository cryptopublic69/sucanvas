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
import uuid
from concurrent.futures import ThreadPoolExecutor

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / 'release-web/SuCanvas-Web'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM6sAAAAASUVORK5CYII=')
CLIENT_ID = 'smoke-client'
VIDEO_CLIENT_ID = 'smoke-video-client'

class ComfyStub(http.server.BaseHTTPRequestHandler):
    view_queries = []
    video_payload = None
    generation_submissions = 0
    def do_POST(self):
        if self.path != '/prompt': self.send_error(404); return
        json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        type(self).generation_submissions += 1
        time.sleep(2)  # The browser request must finish before this response.
        payload = json.dumps({'prompt_id': 'async-prompt'}).encode()
        self.send_response(200); self.send_header('Content-Length', str(len(payload)))
        self.end_headers(); self.wfile.write(payload)
    def log_message(self, *_): pass
    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == '/view':
            self.view_queries.append(urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query))
            payload = self.video_payload if self.view_queries[-1].get('filename') == ['poster-fixture.mp4'] else PNG
        elif path == '/queue': payload = json.dumps({'queue_running': [], 'queue_pending': []}).encode()
        elif path == '/history/async-prompt': payload = json.dumps({'async-prompt': {
            'status': {'status_str': 'success'},
            'outputs': {'42': {'images': [{'filename': 'async-generated.png', 'subfolder': '', 'type': 'output'}]}}
        }}).encode()
        elif path == '/history': payload = json.dumps({'smoke-prompt': {
            'prompt': [1, 'smoke-prompt', {'sampler': {'inputs': {'seed': 42}}}, {'client_id': CLIENT_ID}],
            'status': {'status_str': 'success'},
            'outputs': {'42': {'images': [{'filename': 'generated.png', 'subfolder': '', 'type': 'output'}]}}
        }, 'smoke-video-prompt': {
            'prompt': [2, 'smoke-video-prompt', {'sampler': {'inputs': {'seed': 43}}}, {'client_id': VIDEO_CLIENT_ID}],
            'status': {'status_str': 'success'},
            'outputs': {'43': {'videos': [{'filename': 'generated.mp4', 'subfolder': 'H3', 'type': 'output'}]}}
        }}).encode()
        else: self.send_error(404); return
        self.send_response(200)
        self.send_header('Content-Type', ('video/mp4' if payload == self.video_payload else 'image/png') if path == '/view' else 'application/json')
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
        if isinstance(value, str) and value.startswith('sucanvas-input://sucanvas-imports/'):
            return desktop_data+'\\assets\\'+value[len('sucanvas-input://sucanvas-imports/'):].replace('/', '\\')
        if isinstance(value, str) and value.startswith('sucanvas-output://'):
            return r'D:\Desktop\ComfyUI\output'+'\\'+value[len('sucanvas-output://'):].replace('/', '\\')
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
                if entry.filename in {'data/web-auth.json', 'data/web-settings.json', 'data/web-integration-token', 'data/storage-migration-map.json', 'data/infinite-canvas.sqlite3-wal', 'data/infinite-canvas.sqlite3-shm'}: continue
                if entry.filename == 'data/infinite-canvas.sqlite3':
                    target.write(database_file, entry.filename)
                elif entry.filename == 'data/app-lock.json':
                    # A desktop backup may contain a different application lock.
                    target.writestr(entry, desktop_lock)
                elif entry.filename == 'backup-manifest.json':
                    manifest = json.loads(source.read(entry))
                    manifest['sourceDataDir'] = desktop_data
                    target.writestr(entry, json.dumps(manifest))
                elif entry.filename.startswith('data/comfy-input/sucanvas-imports/'):
                    target.writestr('data/assets/'+entry.filename[len('data/comfy-input/sucanvas-imports/'):], source.read(entry))
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
        comfy_output = source / 'comfy-output'
        (comfy_output / 'H3').mkdir(parents=True)
        config['comfyOutputDirectory'] = str(comfy_output)
        comfy_input = source / 'comfy-input'
        comfy_input.mkdir()
        config['comfyInputDirectory'] = str(comfy_input)
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
            # A delayed ComfyUI submission must not hold the public HTTP request.
            image_workflow = source / 'data/uploads/async-image-workflow.json'
            image_workflow.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / 'workflows/Krea2文生图_可选放大.json', image_workflow)
            image_module = invoke('save_workflow_module', {'input': {
                'name': 'Async image smoke', 'capability': 'image-generation', 'variant': 'image-generation',
                'sourceWorkflowPath': str(image_workflow),
            }})
            workflows = invoke('list_workflow_modules', {'includeDeleted': False})
            (comfy_output / 'async-generated.png').write_bytes(PNG)
            task_id = str(uuid.uuid4())
            task_path = '/api/generation-tasks/' + task_id
            async_request = {'webTaskId': task_id, 'args': {'input': {
                'serverUrl': 'http://ignored.invalid', 'workflowModuleId': image_module['id'],
                'clientId': 'async-generation-client', 'prompt': 'test', 'seedMode': 'fixed',
                'seed': '42', 'width': 512, 'height': 512,
            }}}
            started = time.monotonic()
            status, body, _ = request('/api/invoke/submit_comfyui_image_workflow', async_request)
            assert status == 202 and json.loads(body)['taskId'] == task_id, (status, body)
            assert time.monotonic() - started < 1.5, 'Starting a Web task must not wait for generation'
            assert request(task_path, anonymous=True)[0] == 401
            assert json.loads(request(task_path)[1]) == {'pending': True}
            # Repeating the same start after a lost response cannot submit again.
            assert request('/api/invoke/submit_comfyui_image_workflow', async_request)[0] == 200
            for _ in range(100):
                status, body, headers = request(task_path)
                result = json.loads(body)
                if 'result' in result: break
                assert result == {'pending': True}, result
                time.sleep(.1)
            else: raise AssertionError('Background generation did not complete')
            assert result['result']['promptId'] == 'async-prompt'
            assert result['result']['outputs'][0]['assetPath'] == 'sucanvas-output://async-generated.png'
            assert headers['Cache-Control'] == 'no-store'
            assert json.loads(request(task_path)[1]) == result, 'Results must survive a lost poll response'
            assert ComfyStub.generation_submissions == 1
            assert workflows
            text = invoke('create_node', {'input': {'canvasId': project, 'kind': 'text', 'title': 'Test', 'content': {'text': 'portable'}, 'source': 'user'}})['node']
            assert text['content']['text'] == 'portable'
            boundary = secrets.token_hex(12)
            upload = (f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n'.encode()+PNG+f'\r\n--{boundary}--\r\n'.encode())
            req = urllib.request.Request(base+'/api/upload', data=upload, headers={'Origin': base, 'Content-Type': f'multipart/form-data; boundary={boundary}'})
            with opener.open(req, timeout=10) as result: resource = json.load(result)['paths'][0]
            image = invoke('import_media', {'path': resource, 'canvasId': project, 'x': 20, 'y': 30})['node']
            asset = image['content']['assetPath']
            assert asset.startswith('sucanvas-input://sucanvas-imports/')
            assert (comfy_input / 'sucanvas-imports' / asset.rsplit('/', 1)[-1]).is_file()
            assert not (source / 'data/assets').exists()
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
            # Migrated projects store relative media URLs. Exercise the real
            # server poster command with an MP4, rather than only stub bytes.
            ffmpeg = PACKAGE / 'tools/ffmpeg.exe'
            assert ffmpeg.is_file(), 'Preview regression checks require the packaged FFmpeg.'
            fixture = area / 'poster-fixture.mp4'
            generated = subprocess.run([str(ffmpeg), '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=0.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', str(fixture)], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            assert generated.returncode == 0, generated.stderr
            ComfyStub.video_payload = fixture.read_bytes()
            (comfy_output / 'H3/poster-fixture.mp4').write_bytes(ComfyStub.video_payload)
            tools = source / 'tools'
            tools.mkdir()
            bundled_ffmpeg = tools / 'ffmpeg.exe'
            try: os.link(ffmpeg, bundled_ffmpeg)
            except OSError: shutil.copy2(ffmpeg, bundled_ffmpeg)
            try:
                relative_video = '/api/comfy/view?filename=poster-fixture.mp4&type=output'
                local_video = '/api/resource?resource=' + urllib.parse.quote('sucanvas-output://H3/poster-fixture.mp4', safe='')
                for poster_source in [relative_video, base + relative_video, local_video]:
                    poster_status, poster_body, _ = request('/api/invoke/capture_video_poster', {'args': {'source': poster_source}})
                    assert poster_status == 200, (poster_source, poster_status, poster_body)
                    poster = bytes(json.loads(poster_body)['result'])
                    assert poster.startswith(b'\xff\xd8\xff'), poster_source
                mapped_source = '/api/comfy/view?filename=poster-fixture.mp4&subfolder=H3&type=output'
                binary_path = '/api/video-poster?source=' + urllib.parse.quote(mapped_source, safe='')
                views_before = len(ComfyStub.view_queries)
                binary_status, binary_poster, binary_headers = request(binary_path)
                assert binary_status == 200 and binary_poster.startswith(b'\xff\xd8\xff')
                assert binary_headers['Content-Type'] == 'image/jpeg'
                assert binary_headers['Cache-Control'] == 'no-store'
                assert len(ComfyStub.view_queries) == views_before, 'Mapped originals must bypass HTTP video reads.'
                with ThreadPoolExecutor(max_workers=12) as pool:
                    parallel_posters = list(pool.map(lambda _: request(binary_path), range(12)))
                assert all(status == 200 and data.startswith(b'\xff\xd8\xff') for status, data, _headers in parallel_posters)
                assert len(ComfyStub.view_queries) == views_before
                # A legacy URL may name an existing but different original.
                # The fast path must honor the migration map and refresh it.
                map_path = source / 'data/storage-migration-map.json'
                original_map = map_path.read_bytes() if map_path.exists() else None
                legacy_file = comfy_output / 'H3/legacy-poster.mp4'
                legacy_file.write_bytes(b'not the migrated video')
                legacy_source = '/api/comfy/view?filename=legacy-poster.mp4&subfolder=H3&type=output'
                legacy_path = '/api/video-poster?source=' + urllib.parse.quote(legacy_source, safe='')
                try:
                    mapping = json.loads(original_map) if original_map else {}
                    mapping[legacy_source] = mapped_source
                    map_path.write_text(json.dumps(mapping), encoding='utf-8')
                    assert request(legacy_path)[1] == binary_poster
                    mapping[legacy_source] = legacy_source
                    map_path.write_text(json.dumps(mapping), encoding='utf-8')
                    assert request(legacy_path)[0] == 400
                finally:
                    if original_map is None: map_path.unlink()
                    else: map_path.write_bytes(original_map)
                    legacy_file.unlink()
                assert request(binary_path, anonymous=True)[0] == 401
                forbidden = '/api/video-poster?source=' + urllib.parse.quote(r'C:\Windows\win.ini', safe='')
                assert request(forbidden)[0] == 400
                traversal = '/api/video-poster?source=' + urllib.parse.quote('/api/comfy/view?filename=poster-fixture.mp4&subfolder=../outside&type=output', safe='')
                assert request(traversal)[0] == 400
            finally:
                assert bundled_ffmpeg.resolve().is_relative_to(area)
                bundled_ffmpeg.unlink()
                tools.rmdir()
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
            assert '/api/comfy/view?' in output['url'] and output['assetPath'] == 'sucanvas-output://generated.png'
            assert request(output['url'].removeprefix(base))[1] == PNG
            (comfy_output / 'generated.png').write_bytes(PNG)
            # Videos stay in ComfyUI output and are served through the proxy.
            original_video = comfy_output / 'H3/generated.mp4'
            original_video.write_bytes(PNG)
            view_count = len(ComfyStub.view_queries)
            video_results = invoke('get_comfyui_client_task_statuses', {'serverUrl': 'http://ignored.invalid', 'clientIds': [VIDEO_CLIENT_ID]})
            video_output = video_results[0]['outputs'][0]
            assert '/api/comfy/view?' in video_output['url'] and video_output['assetPath'] == 'sucanvas-output://H3/generated.mp4'
            assert len(ComfyStub.view_queries) == view_count, 'Recovering video results must not download a second copy'
            assert not list((source / 'data/assets').glob('generated-*.mp4'))
            assert request(video_output['url'].removeprefix(base))[1] == PNG
            status, body, _ = request('/api/comfy-config', {'comfyUrl': config['comfyUrl'], 'comfyInputDirectory': 'comfy-input', 'comfyOutputDirectory': 'comfy-output'}, method='PUT')
            assert status == 200, body
            connection = json.loads(request('/api/comfy-config')[1])
            settings = json.loads(request('/api/settings')[1])
            assert os.path.samefile(connection['comfyInputDirectory'], comfy_input)
            assert os.path.samefile(settings['infinite-canvas:comfy-output-root'], comfy_output)
            video = invoke('create_node', {'input': {'canvasId': project, 'kind': 'generated-video', 'title': 'Original video', 'content': {'videoUrl': video_output['url'], 'filename': video_output['filename'], 'subfolder': video_output['subfolder']}, 'source': 'comfyui'}})['node']
            deleted = invoke('delete_nodes_undoable', {'input': {'ids': [video['id']]}})
            assert original_video.is_file(), 'Node-only deletion must retain the ComfyUI original'
            invoke('restore_deleted_nodes', {'batch': deleted})
            assert any(node['id'] == video['id'] for node in invoke('load_workspace', {'canvasId': project})['nodes'])
            invoke('delete_nodes_undoable', {'input': {'ids': [video['id']]}})
            assert invoke('delete_video_files', {'paths': [str(original_video)]}) == 1
            assert not original_video.exists()
            # Existing Web copies and desktop imports migrate to ComfyUI directories.
            saved_video_resource = 'sucanvas://assets/generated-existing.mp4'
            (source / 'data/assets').mkdir()
            (source / 'data/assets/generated-existing.mp4').write_bytes(PNG)
            saved_video_url = '/api/resource?resource=' + urllib.parse.quote(saved_video_resource, safe='')
            saved_video_content = {'assetPath': saved_video_resource, 'videoUrl': saved_video_url, 'filename': 'previous-video.mp4', 'subfolder': 'old'}
            saved_video = invoke('create_node', {'input': {'canvasId': project, 'kind': 'generated-video', 'title': 'Existing saved video', 'content': saved_video_content, 'source': 'comfyui'}})['node']
            assert request(saved_video_url)[1] == PNG
            (source / 'data/assets/asset-previous.png').write_bytes(PNG)
            legacy_import = invoke('create_node', {'input': {'canvasId': project, 'kind': 'image', 'title': 'Migrated import', 'content': {'assetPath': 'sucanvas://assets/asset-previous.png', 'originalName': 'previous.png'}, 'source': 'manual'}})['node']
            (source / 'data/assets/generated-same.png').write_bytes(PNG)
            same_image = invoke('create_node', {'input': {'canvasId': project, 'kind': 'generated-image', 'title': 'Existing output', 'content': {'assetPath': 'sucanvas://assets/generated-same.png', 'imageUrl': '/api/resource?resource=sucanvas%3A%2F%2Fassets%2Fgenerated-same.png', 'filename': 'generated.png'}, 'source': 'comfyui'}})['node']
            (comfy_output / 'conflict.mp4').write_bytes(b'different original')
            (source / 'data/assets/generated-conflict.mp4').write_bytes(PNG)
            conflict_video = invoke('create_node', {'input': {'canvasId': project, 'kind': 'generated-video', 'content': {'assetPath': 'sucanvas://assets/generated-conflict.mp4', 'videoUrl': '/api/resource?resource=sucanvas%3A%2F%2Fassets%2Fgenerated-conflict.mp4', 'filename': 'conflict.mp4'}, 'source': 'comfyui'}})['node']
            missing_video = invoke('create_node', {'input': {'canvasId': project, 'kind': 'generated-video', 'content': {'filename': 'missing-original.mp4', 'videoUrl': '/api/comfy/view?filename=missing-original.mp4'}, 'source': 'comfyui'}})['node']
            old_task_setting = json.dumps({'assetPath': 'sucanvas://assets/asset-previous.png', 'sourceVideoUrl': saved_video_url})
            assert request('/api/settings', {'infinite-canvas:smoke': 'retained', 'infinite-canvas:migration-task': old_task_setting}, method='PUT')[0] == 200
            status, body, _ = request('/api/comfy-config', {'comfyUrl': config['comfyUrl'], 'comfyInputDirectory': '', 'comfyOutputDirectory': ''}, method='PUT')
            assert status == 200 and json.loads(body)['storageMigration']['pending']
            assert request(saved_video_url)[1] == PNG
            status, body, _ = request('/api/comfy-config', {'comfyUrl': config['comfyUrl'], 'comfyInputDirectory': 'comfy-input', 'comfyOutputDirectory': 'comfy-output'}, method='PUT')
            assert status == 400 and 'missing-original.mp4' in body.decode()
            before_retry = {node['id']: node for node in invoke('load_workspace', {'canvasId': project})['nodes']}
            assert before_retry[saved_video['id']]['content']['assetPath'] == saved_video_resource
            assert (source / 'data/assets/generated-existing.mp4').read_bytes() == PNG
            invoke('delete_node', {'id': missing_video['id']})
            status, body, _ = request('/api/comfy-config', {'comfyUrl': config['comfyUrl'], 'comfyInputDirectory': 'comfy-input', 'comfyOutputDirectory': 'comfy-output'}, method='PUT')
            assert status == 200, body
            report = json.loads(body)['storageMigration']
            assert report['migrated'] and list((source / 'backup').glob('storage-migration-*/before-migration.sucanvas-backup'))
            assert not (source / 'data/assets').exists()
            migrated = invoke('load_workspace', {'canvasId': project})
            migrated_nodes = {node['id']: node for node in migrated['nodes']}
            saved_video_content = migrated_nodes[saved_video['id']]['content']
            saved_video_url = saved_video_content['videoUrl']
            assert saved_video_content['assetPath'] == 'sucanvas-output://sucanvas-migrated/generated-existing.mp4', saved_video_content
            assert (comfy_output / 'sucanvas-migrated/generated-existing.mp4').read_bytes() == PNG
            assert migrated_nodes[same_image['id']]['content']['assetPath'] == 'sucanvas-output://generated.png'
            assert migrated_nodes[conflict_video['id']]['content']['assetPath'] == 'sucanvas-output://sucanvas-migrated/generated-conflict.mp4'
            assert (comfy_output / 'conflict.mp4').read_bytes() == b'different original'
            assert not (comfy_output / 'sucanvas-migrated/generated-same.png').exists()
            assert migrated_nodes[legacy_import['id']]['content']['assetPath'] == 'sucanvas-input://sucanvas-imports/asset-previous.png'
            assert (comfy_input / 'sucanvas-imports/asset-previous.png').read_bytes() == PNG
            assert request(saved_video_url)[1] == PNG
            assert request('/api/resource?resource=' + urllib.parse.quote(saved_video_resource, safe=''))[1] == PNG
            task_setting = json.loads(json.loads(request('/api/settings')[1])['infinite-canvas:migration-task'])
            assert task_setting['assetPath'] == 'sucanvas-input://sucanvas-imports/asset-previous.png'
            # Old clients cannot reintroduce the inactive asset reference.
            updated = invoke('update_node', {'input': {'id': legacy_import['id'], 'content': {'assetPath': 'sucanvas://assets/asset-previous.png'}}})
            assert updated['content']['assetPath'] == 'sucanvas-input://sucanvas-imports/asset-previous.png'
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
            comfy_input, comfy_output = moved / 'comfy-input', moved / 'comfy-output'
            config['comfyInputDirectory'], config['comfyOutputDirectory'] = str(comfy_input), str(comfy_output)
            (moved / 'config.json').write_text(json.dumps(config), encoding='utf-8')
            restore = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(moved/'scripts/Restore-Web.ps1'), '-BackupDirectory', str(moved/'backup/script-backup')], capture_output=True, text=True)
            assert restore.returncode == 0, restore.stderr
            base = config['publicUrl']
            moved_process = start(moved)
            assert request('/api/auth/session')[0] == 401
            assert request('/api/auth/login', {'password': password})[0] == 200
            restored = invoke('load_workspace', {'canvasId': project})
            assert any(node['id'] == image['id'] and node['content']['assetPath'] == asset for node in restored['nodes'])
            restored_video = next(node for node in restored['nodes'] if node['id'] == saved_video['id'])
            for key in ['assetPath', 'videoUrl', 'filename', 'subfolder', 'fileType']:
                assert restored_video['content'][key] == saved_video_content[key]
            assert request(saved_video_url)[1] == PNG
            assert restored['canvas']['previewImagePath'] == asset
            assert request(url)[1] == PNG
            assert request(output['url'].removeprefix(output['url'].split('/api/comfy')[0]))[1] == PNG
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
            with zipfile.ZipFile(__import__('io').BytesIO(backup_bytes)) as archive_contents:
                assert any(name.startswith('data/comfy-input/sucanvas-imports/') for name in archive_contents.namelist())
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
            input_file_to_restore = comfy_input / 'sucanvas-imports' / asset.rsplit('/', 1)[-1]
            assert input_file_to_restore.resolve().is_relative_to(area)
            input_file_to_restore.unlink()
            moved_process = start(moved)
            assert input_file_to_restore.read_bytes() == PNG
            assert request('/api/auth/login', {'password': password})[0] == 200
            # Read settings before any canvas restore call or browser writeback.
            imported_settings = json.loads(request('/api/settings')[1])
            assert imported_settings['infinite-canvas:theme'] == 'light'
            assert imported_settings['infinite-canvas:restore-test-presets'] == large_setting
            assert imported_settings['infinite-canvas:comfy-server-url'] == base+'/api/comfy'
            assert os.path.samefile(imported_settings['infinite-canvas:comfy-input-root'], comfy_input)
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
            print('PASS: auth, CSRF, CRUD, input imports, output-only generation, mapped deletion, backed-up legacy migration, missing-output repair, identical-output reuse, stale-client aliases, original downloads, file boundaries, SSE, workflows, input backup/restore, repeated restart and relocation')
        finally:
            stop(source_process); stop(moved_process)
            comfy.shutdown(); comfy.server_close()

if __name__ == '__main__': main()
