import errno
import json
import os
from pathlib import Path
import pty
import select
import signal
import socket
import sys
import tempfile
import time
import urllib.parse

entry = str(Path(sys.argv[1]).resolve())
output = Path(sys.argv[2]).resolve()
output.mkdir(parents=True, exist_ok=True)
results = []
for provider, cancel_at in [('openai', 'auth_url'), ('anthropic', 'select'), ('anthropic', 'auth_url')]:
    with tempfile.TemporaryDirectory(prefix='lean-login-cancel-') as temporary:
        root = Path(temporary)
        home = root / 'config'
        guard = root / 'network.ts'
        guard.write_text("globalThis.fetch = async () => { throw new Error('Network forbidden in cancellation probe'); };\n")
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(root)
            env = dict(os.environ, LEAN_HOME=str(home), OPENAI_API_KEY='', OPENAI_AGENTS_DISABLE_TRACING='1')
            try:
                os.execvpe('bun', ['bun', '--no-env-file', 'run', '--preload', str(guard), entry, '--login', provider], env)
            except OSError:
                os._exit(127)
        screen = b''
        cancelled = False
        selected = False
        status = None
        callback_port = None
        try:
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                ready, _, _ = select.select([fd], [], [], 0.05)
                if ready:
                    try:
                        chunk = os.read(fd, 65536)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            break
                        raise
                    if not chunk:
                        break
                    screen += chunk
                if not cancelled and not selected and b'Select Anthropic login method:' in screen:
                    if cancel_at == 'select':
                        os.write(fd, b'\x03')
                        cancelled = True
                    else:
                        os.write(fd, b'1\n')
                    selected = True
                if not cancelled:
                    for line in screen.decode(errors='replace').splitlines():
                        if line.startswith('https://'):
                            auth = urllib.parse.urlparse(line)
                            redirect = urllib.parse.parse_qs(auth.query).get('redirect_uri', [''])[0]
                            callback = urllib.parse.urlparse(redirect)
                            if callback.hostname in ('localhost', '127.0.0.1'):
                                callback_port = callback.port
                            os.write(fd, b'\x03')
                            cancelled = True
                            break
                exited, candidate = os.waitpid(pid, os.WNOHANG)
                if exited:
                    status = candidate
                    break
            if status is None:
                exited, candidate = os.waitpid(pid, os.WNOHANG)
                if not exited:
                    os.kill(pid, signal.SIGKILL)
                    _, candidate = os.waitpid(pid, 0)
                status = candidate
            code = os.waitstatus_to_exitcode(status)
            assert cancelled and code == 130, {'provider': provider, 'cancelled': cancelled, 'exit_code': code}
            assert not (home / (provider + '.json')).exists(), 'cancelled login saved credentials'
            assert not list(home.glob('*.lock')), 'cancelled login left a credential lock'
            if callback_port is not None:
                with socket.socket() as listener:
                    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    listener.bind(('127.0.0.1', callback_port))
            result = {'provider': provider, 'stage': cancel_at, 'exit_code': code, 'callback_port_released': callback_port, 'credentials_absent': True, 'verdict': 'VERIFIED'}
        except Exception as error:
            result = {'provider': provider, 'stage': cancel_at, 'verdict': 'NOT VERIFIED', 'error': str(error)}
        finally:
            if status is None:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(pid, 0)
            os.close(fd)
            (output / (provider + '-' + cancel_at + '.txt')).write_bytes(screen)
        results.append(result)
        print(json.dumps(result), flush=True)
(output / 'results.json').write_text(json.dumps(results, indent=2))
sys.exit(0 if all(result['verdict'] == 'VERIFIED' for result in results) else 1)
