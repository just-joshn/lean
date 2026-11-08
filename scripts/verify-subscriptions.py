import argparse
import errno
import json
import os
import pty
import re
import select
import signal
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("entry")
parser.add_argument("output")
parser.add_argument("--tool", choices=["shell", "apply_patch"], default="shell")
args = parser.parse_args()
entry = str(Path(args.entry).resolve())
output = Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=True)
temporary = tempfile.TemporaryDirectory(prefix="lean-oauth-probe-")
root = Path(temporary.name)
home = root / "config"
home.mkdir(mode=0o700)
requests = {"openai": [], "anthropic": []}
grants = {"openai": [], "anthropic": []}
failures = []


def access(provider):
    prefix = "sk-ant-oat-synthetic-" if provider == "anthropic" else "synthetic-"
    return prefix + provider + "-access-" + str(len(grants[provider]))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *unused):
        pass

    def do_POST(self):
        if self.headers.get("Transfer-Encoding") == "chunked":
            chunks = []
            while True:
                size = int(self.rfile.readline().strip(), 16)
                if not size:
                    self.rfile.readline()
                    break
                chunks.append(self.rfile.read(size))
                self.rfile.read(2)
            raw = b"".join(chunks)
        else:
            raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        provider = "anthropic" if "anthropic" in self.path else "openai"
        if self.path.endswith("/token"):
            body = json.loads(raw) if self.headers.get("Content-Type", "").startswith("application/json") else {k: v[0] for k, v in urllib.parse.parse_qs(raw.decode()).items()}
            grants[provider].append(body)
            data = {
                "access_token": access(provider),
                "refresh_token": "synthetic-" + provider + "-refresh-" + str(len(grants[provider])),
                "expires_in": 3600,
                "scope": "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
                "id_token": "synthetic-id-token",
            }
            encoded = json.dumps(data).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
            return
        body = json.loads(raw)
        requests[provider].append(body)
        if self.headers.get("Authorization") != "Bearer " + access(provider):
            failures.append(provider + " did not use the current OAuth bearer token")
        unsupported = next((tool.get("type") for tool in body.get("tools", []) if tool.get("type") != "function"), None)
        native_history = next((item.get("type") for item in body.get("input", []) if item.get("type") in {"shell_call", "shell_call_output", "apply_patch_call", "apply_patch_call_output"}), None)
        if provider == "openai" and (unsupported or native_history):
            detail = "Unsupported tool type: " + unsupported if unsupported else "Unsupported input type: " + native_history
            encoded = json.dumps({"detail": detail}, separators=(",", ":")).encode()
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        first = len(requests[provider]) == 1
        action = {"commands": ["printf x >> count.txt"], "timeoutMs": 1000, "maxOutputLength": 1000}
        operation = {"type": "create_file", "path": "count.txt", "diff": "+x"}
        if provider == "openai":
            tool = next((t for t in body.get("tools", []) if t.get("name") == args.tool), {})
            arguments = {"operation": operation} if args.tool == "apply_patch" else ({"action": action} if "action" in tool.get("parameters", {}).get("properties", {}) else action)
            item = {"id": "tool_fixture", "type": "function_call", "call_id": "call_fixture", "name": args.tool, "arguments": json.dumps(arguments), "status": "completed"}
            if not first:
                item = {"id": "msg_fixture", "type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "Finished.", "annotations": []}]}
            response = {"id": "resp_fixture_" + str(len(requests[provider])), "object": "response", "created_at": 1, "model": body.get("model", "gpt-5.4"), "status": "completed", "output": [item], "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15, "input_tokens_details": {"cached_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 0}}}
            self.send_event({"type": "response.created", "response": {**response, "status": "in_progress", "output": []}})
            added = {**item, "arguments": ""} if item["type"] == "function_call" else item
            self.send_event({"type": "response.output_item.added", "output_index": 0, "item": added})
            if item["type"] == "function_call":
                self.send_event({"type": "response.function_call_arguments.delta", "item_id": item["id"], "output_index": 0, "delta": item["arguments"]})
            if item["type"] == "message":
                self.send_event({"type": "response.output_text.delta", "item_id": item["id"], "output_index": 0, "content_index": 0, "delta": "Finished."})
            self.send_event({"type": "response.output_item.done", "output_index": 0, "item": item})
            self.send_event({"type": "response.completed", "response": response})
        else:
            self.send_event({"type": "message_start", "message": {"id": "msg_fixture", "type": "message", "role": "assistant", "model": body["model"], "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 0}}})
            if first:
                self.send_event({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}})
                self.send_event({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "Use the approved tool."}})
                self.send_event({"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "synthetic-thinking-signature"}})
                self.send_event({"type": "content_block_stop", "index": 0})
                tool = next(t for t in body["tools"] if t["name"] == args.tool)
                arguments = {"operation": operation} if args.tool == "apply_patch" else ({"action": action} if "action" in tool.get("input_schema", {}).get("properties", {}) else action)
                self.send_event({"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "toolu_fixture", "name": args.tool, "input": {}}})
                self.send_event({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": json.dumps(arguments)}})
                self.send_event({"type": "content_block_stop", "index": 1})
            else:
                self.send_event({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
                self.send_event({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Finished."}})
                self.send_event({"type": "content_block_stop", "index": 0})
            self.send_event({"type": "message_delta", "delta": {"stop_reason": "tool_use" if first else "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 5}})
            self.send_event({"type": "message_stop"})
        self.close_connection = True

    def send_event(self, event):
        self.wfile.write(("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n").encode())
        self.wfile.flush()


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = "http://127.0.0.1:" + str(server.server_port)
hook = root / "network.ts"
hook.write_text("""
const actualFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  let route;
  if (url.host === 'auth.openai.com' && url.pathname.endsWith('/token')) route = '/openai/token';
  else if (url.host === 'platform.claude.com' && url.pathname.endsWith('/token')) route = '/anthropic/token';
  else if (url.host === 'api.openai.com') route = '/openai/responses';
  else if (url.host === 'api.anthropic.com') route = '/anthropic/messages';
  else if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return actualFetch(request);
  else throw new Error('Unexpected network host in isolated OAuth fixture');
  return actualFetch(new Request(%s + route, request));
};
""" % json.dumps(base))


def run_cli(label, provider, argv, login=False, approve=False):
    workspace = root / (provider + "-workspace")
    workspace.mkdir(exist_ok=True)
    (workspace / "AGENTS.md").write_text("# Fixture instructions\nKeep the exact word apricot.\n")
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(workspace)
        env = {**os.environ, "LEAN_HOME": str(home), "OPENAI_API_KEY": "", "ANTHROPIC_API_KEY": "", "ANTHROPIC_OAUTH_TOKEN": "", "OPENAI_AGENTS_DISABLE_TRACING": "1", "TERM": "xterm-256color"}
        try:
            os.execvpe("bun", ["bun", "--no-env-file", "run", "--preload", str(hook), entry, *argv], env)
        except OSError:
            os._exit(127)
    screen = b""
    callback_sent = False
    choice_sent = False
    approval_sent = False
    before_approval = None
    status = None
    deadline = time.monotonic() + 20
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b""
                screen += chunk
            if login and provider == "anthropic" and not choice_sent and b"browser" in screen.lower() and b"copy" in screen.lower():
                os.write(master, b"1\n")
                choice_sent = True
            if login and not callback_sent:
                match = re.search(rb"https://(?:auth\.openai\.com|claude\.ai)/[^\s\x1b]+", screen)
                if match:
                    url = match.group().decode().rstrip("\r")
                    params = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
                    callback = params["redirect_uri"][0]
                    query = {"state": params["state"][0], "code": "synthetic-authorization-code"}
                    if provider == "openai":
                        query["client_id"] = "synthetic-issued-client"
                    with urllib.request.urlopen(callback + "?" + urllib.parse.urlencode(query), timeout=3) as response:
                        assert response.status == 200
                    callback_sent = True
            if approve and not approval_sent and b"Approve? [y/N]" in screen:
                before_approval = (workspace / "count.txt").exists()
                os.write(master, b"y\n")
                approval_sent = True
            finished, status = os.waitpid(pid, os.WNOHANG)
            if finished:
                break
            status = None
        assert status is not None, label + " timed out"
        code = os.waitstatus_to_exitcode(status)
        cleaned = re.sub(r"https://(?:auth\.openai\.com|claude\.ai)/[^\s\x1b]+", "[authorization URL omitted]", screen.decode(errors="replace"))
        (output / (label + ".txt")).write_text(cleaned)
        assert code == 0, label + " failed: " + cleaned
        if login:
            assert callback_sent, label + " did not expose the provider authorization URL"
        if approve:
            assert approval_sent and before_approval is False, label + " approval gate failed"
            assert (workspace / "count.txt").read_text() == "x", label + " did not execute exactly once"
        assert "synthetic-openai-access" not in cleaned and "sk-ant-oat-synthetic" not in cleaned
        assert "synthetic-openai-refresh" not in cleaned and "synthetic-anthropic-refresh" not in cleaned
        return workspace
    finally:
        if status is None:
            os.killpg(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        os.close(master)


def credentials():
    found = []
    for path in home.rglob("*.json"):
        data = json.loads(path.read_text())
        if isinstance(data, dict) and data.get("type") == "oauth":
            found.append((path, data))
    return found


results = []
try:
    for provider in ["openai", "anthropic"]:
        run_cli(provider + "-login", provider, ["--login", provider], login=True)
        saved = [(p, c) for p, c in credentials() if provider in c["access"]]
        assert len(saved) == 1, provider + " credential missing or duplicated"
        path, data = saved[0]
        assert path.stat().st_mode & 0o777 == 0o600, "credential file is not private"
        if provider == "openai":
            assert data["clientId"] == "synthetic-issued-client"
            assert "chatgpt.tokens.use.direct" in data["scopes"]
        data["expires"] = 0
        path.write_text(json.dumps(data))
        workspace = run_cli(provider + "-approved-task", provider, ["--provider", provider, "--model", "gpt-5.4" if provider == "openai" else "claude-sonnet-5-5", "First fixture task."], approve=True)
        assert [g["grant_type"] for g in grants[provider]] == ["authorization_code", "refresh_token"]
        assert any(c["access"] == access(provider) for _, c in credentials())
        run_cli(provider + "-resume", provider, ["--provider", provider, "--model", "gpt-5.4" if provider == "openai" else "claude-sonnet-5-5", "Continue fixture task."])
        assert len(requests[provider]) == 3, provider + " had unexpected model calls"
        body = json.dumps(requests[provider][2])
        assert body.count("First fixture task.") == 1
        assert body.count("apricot") == 1
        assert "call_fixture" in body if provider == "openai" else "toolu_fixture" in body
        if provider == "anthropic":
            assert "synthetic-thinking-signature" in body, "thinking signature lost after reload"
        history = (workspace / ".lean/history.json").read_text()
        assert args.tool + "_call_output" in history
        assert access(provider) not in history
        results.append({"provider": provider, "tool": args.tool, "login_callback": True, "private_persistence": True, "refresh": True, "approved_once": True, "resumed_once": True, "verdict": "VERIFIED"})
    run_cli("openai-logout", "openai", ["--logout", "openai"])
    assert all("openai" not in c["access"] for _, c in credentials())
    assert any("anthropic" in c["access"] for _, c in credentials())
    run_cli("anthropic-logout", "anthropic", ["--logout", "anthropic"])
    assert credentials() == []
    assert not list(home.rglob("*.lock"))
    results.append({"logout_isolated": True, "locks_released": True, "verdict": "VERIFIED"})
    assert failures == [], failures
finally:
    server.shutdown()
    server.server_close()
    (output / "results.json").write_text(json.dumps({"results": results, "request_auth_errors": failures}, indent=2) + "\n")
    temporary.cleanup()
print(json.dumps(results, indent=2))
