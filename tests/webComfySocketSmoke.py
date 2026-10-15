"""Exercise real HTTP/WebSocket transports in a disposable deployment; no browser automation."""
import argparse
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import secrets
import socket
import struct
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor


def read_exact(connection, size):
    data = b''
    while len(data) < size:
        part = connection.recv(size - len(data))
        if not part:
            raise EOFError('WebSocket transport closed')
        data += part
    return data


def read_frame(connection):
    header = read_exact(connection, 2)
    size = header[1] & 127
    if size == 126:
        size = struct.unpack('!H', read_exact(connection, 2))[0]
    elif size == 127:
        size = struct.unpack('!Q', read_exact(connection, 8))[0]
    mask = read_exact(connection, 4) if header[1] & 128 else None
    data = read_exact(connection, size)
    if mask:
        data = bytes(value ^ mask[i % 4] for i, value in enumerate(data))
    return header[0] & 15, data


def write_frame(connection, opcode, data):
    length = len(data)
    header = bytes([0x80 | opcode])
    header += bytes([length]) if length < 126 else b'\x7e' + struct.pack('!H', length)
    connection.sendall(header + data)


class ComfyStub(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def do_GET(self):
        self.close_connection = True
        mode = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get('scenario', ['healthy'])[0]
        if mode == 'stall-handshake':
            time.sleep(12)
            return
        if mode == 'reject':
            self.send_response(503)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        accept = base64.b64encode(hashlib.sha1(
            (self.headers['Sec-WebSocket-Key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()
        ).digest()).decode()
        self.send_response(101)
        self.send_header('Upgrade', 'websocket')
        self.send_header('Connection', 'Upgrade')
        self.send_header('Sec-WebSocket-Accept', accept)
        self.end_headers()
        write_frame(self.connection, 1, b'{"type":"crystools.monitor","data":{"gpus":[]}}')
        write_frame(self.connection, 2, b'\x00\x00\x00\x01\x00\x00\x00\x02preview-bytes')
        self.connection.settimeout(2)
        try:
            while True:
                try:
                    opcode, data = read_frame(self.connection)
                except socket.timeout:
                    continue
                if opcode == 8:
                    write_frame(self.connection, 8, data)
                    return
                if opcode == 9 and mode != 'silent-upstream':
                    write_frame(self.connection, 10, data)
        except (OSError, EOFError):
            pass


def connect(port, base, cookie, scenario, origin=None):
    connection = socket.create_connection(('127.0.0.1', port), timeout=15)
    key = base64.b64encode(secrets.token_bytes(16)).decode()
    connection.sendall((
        f'GET /api/comfy/ws?clientId=smoke-{scenario}&scenario={scenario} HTTP/1.1\r\n'
        f'Host: 127.0.0.1:{port}\r\nOrigin: {origin or base}\r\nCookie: {cookie}\r\n'
        f'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n'
        'Sec-WebSocket-Version: 13\r\n\r\n'
    ).encode())
    headers = b''
    while not headers.endswith(b'\r\n\r\n'):
        headers += read_exact(connection, 1)
    return connection, int(headers.split(b' ')[1])


def observe(port, base, cookie, mode):
    connection, status = connect(port, base, cookie, mode)
    assert status == 101, status
    connection.settimeout(2)
    started = time.monotonic()
    monitor = preview = False
    heartbeats = 0
    closed = False
    try:
        while time.monotonic() - started < 43:
            try:
                opcode, data = read_frame(connection)
            except socket.timeout:
                continue
            if opcode == 8:
                closed = True
                break
            if opcode == 2:
                assert data == b'\x00\x00\x00\x01\x00\x00\x00\x02preview-bytes'
                preview = True
            if opcode == 1:
                kind = json.loads(data)['type']
                monitor |= kind == 'crystools.monitor'
                heartbeats += kind == 'sucanvas.websocket.heartbeat'
            if mode == 'healthy' and time.monotonic() - started >= 40:
                break
    finally:
        connection.close()
    assert monitor and preview, 'monitor text and binary previews must survive the relay unchanged'
    if mode == 'silent-upstream':
        assert closed, 'an upstream that never answers pings must be disconnected'
    else:
        assert not closed and heartbeats >= 4, 'idle healthy upstream must stay connected using ping/pong'
    return {'scenario': mode, 'closed': closed, 'heartbeats': heartbeats,
            'seconds': round(time.monotonic() - started, 1), 'monitor_and_preview': True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--server', type=Path, default=Path(__file__).resolve().parents[1] / 'src-tauri/target/debug/SuCanvasServer.exe')
    args = parser.parse_args()
    executable = args.server.resolve(strict=True)
    stub = http.server.ThreadingHTTPServer(('127.0.0.1', 0), ComfyStub)
    stub.daemon_threads = True
    threading.Thread(target=stub.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='sucanvas-ws-smoke-') as directory:
            root = Path(directory).resolve()
            assert root.is_relative_to(Path(tempfile.gettempdir()).resolve())
            (root / 'web').mkdir()
            (root / 'web/index.html').write_text('isolated websocket smoke', encoding='utf-8')
            for name in ('input', 'output'):
                (root / name).mkdir()
            with socket.socket() as reservation:
                reservation.bind(('127.0.0.1', 0))
                port = reservation.getsockname()[1]
            base = f'http://127.0.0.1:{port}'
            config = root / 'config.json'
            config.write_text(json.dumps({'listen': f'127.0.0.1:{port}', 'publicUrl': base,
                'dataDirectory': 'data', 'webDirectory': 'web', 'downloadsDirectory': 'downloads',
                'comfyUrl': f'http://127.0.0.1:{stub.server_port}',
                'comfyInputDirectory': str(root / 'input'), 'comfyOutputDirectory': str(root / 'output')}), encoding='utf-8')
            flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
            password = secrets.token_urlsafe(24)
            init = subprocess.run([str(executable), '--config', str(config), '--set-password'],
                input=password + '\n', text=True, capture_output=True, creationflags=flags)
            assert init.returncode == 0, init.stderr
            with (root / 'stderr.log').open('w', encoding='utf-8') as log:
                process = subprocess.Popen([str(executable), '--config', str(config)], cwd=root,
                    stdout=subprocess.DEVNULL, stderr=log, creationflags=flags)
                try:
                    for _ in range(100):
                        assert process.poll() is None, 'diagnostic server stopped during startup'
                        try:
                            urllib.request.urlopen(base, timeout=.2).close()
                            break
                        except OSError:
                            time.sleep(.05)
                    request = urllib.request.Request(base + '/api/auth/login', data=json.dumps({'password': password}).encode(),
                        headers={'Origin': base, 'Content-Type': 'application/json'})
                    with urllib.request.urlopen(request, timeout=5) as response:
                        cookie = response.headers['Set-Cookie'].split(';')[0]
                    for mode, expected in [('reject', 502), ('stall-handshake', 504)]:
                        started = time.monotonic()
                        connection, status = connect(port, base, cookie, mode)
                        connection.close()
                        assert status == expected, (mode, status)
                        print(json.dumps({'scenario': mode, 'status': status, 'premature_upgrade': False,
                            'seconds': round(time.monotonic() - started, 1)}), flush=True)
                    for supplied_cookie, origin, expected in [('', base, 401), (cookie, 'https://untrusted.invalid', 403)]:
                        connection, status = connect(port, base, supplied_cookie, 'healthy', origin)
                        connection.close()
                        assert status == expected, status
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        futures = [pool.submit(observe, port, base, cookie, mode) for mode in ['healthy', 'silent-upstream']]
                        for future in futures:
                            print(json.dumps(future.result()), flush=True)
                finally:
                    process.terminate()
                    process.wait(timeout=10)
            logs = (root / 'stderr.log').read_text(encoding='utf-8')
            assert 'upstream handshake failed' in logs
            assert 'upstream handshake timed out' in logs
            assert 'upstream heartbeat timeout' in logs
            print('PASS: isolated WebSocket handshake, authentication, heartbeat, monitor and preview relay', flush=True)
    finally:
        stub.shutdown()


if __name__ == '__main__':
    main()
