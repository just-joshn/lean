import errno
import http.server
import json
import os
import pathlib
import pty
import select
import signal
import sys
import tempfile
import threading
import time

entry = str(pathlib.Path(sys.argv[1]).resolve())
artifacts = pathlib.Path(sys.argv[2])
artifacts.mkdir(parents=True, exist_ok=True)
results = []


def probe(scenario):
    with tempfile.TemporaryDirectory(prefix="lean-pty-") as directory:
        root = pathlib.Path(directory)
        requests = []
        stop = threading.Event()
        if scenario == "shell-cancel":
            command = 'printf "%s" $$ > shell.pid; sleep 60 & child=$!; printf "%s" "$child" > child.pid; wait'
        else:
            command = "printf x >> count.txt"

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append(body)
                first = len(requests) == 1
                if first and scenario == "patch":
                    output = [{"id": "patch_probe", "type": "apply_patch_call", "call_id": "call_patch_probe", "status": "completed", "operation": {"type": "create_file", "path": "count.txt", "diff": "+x"}}]
                elif first and scenario not in ("model-cancel", "repl-eof", "repl-turn"):
                    output = [{"id": "sh_probe", "type": "shell_call", "call_id": "call_probe", "status": "completed", "action": {"commands": [command], "timeout_ms": 120000, "max_output_length": 10000}}]
                else:
                    output = [{"id": "msg_probe", "type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "Finished.", "annotations": []}]}]
                response = {"id": "resp_probe_" + str(len(requests)), "object": "response", "created_at": 1, "model": "gpt-5.4", "status": "completed", "output": output, "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15, "input_tokens_details": {"cached_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 0}}}
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()

                def send(event):
                    self.wfile.write(("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n").encode())
                    self.wfile.flush()

                try:
                    send({"type": "response.created", "response": dict(response, status="in_progress", output=[])})
                    if scenario == "model-cancel":
                        stop.wait(15)
                        return
                    for index, item in enumerate(output):
                        send({"type": "response.output_item.added", "output_index": index, "item": item})
                        if item["type"] == "message":
                            send({"type": "response.output_text.delta", "item_id": item["id"], "output_index": index, "content_index": 0, "delta": item["content"][0]["text"]})
                        send({"type": "response.output_item.done", "output_index": index, "item": item})
                    send({"type": "response.completed", "response": response})
                except (BrokenPipeError, ConnectionResetError):
                    pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(directory)
            env = dict(os.environ, OPENAI_API_KEY="local-test-key", OPENAI_MODEL="gpt-5.4", OPENAI_BASE_URL=f"http://127.0.0.1:{server.server_port}/v1", OPENAI_AGENTS_DISABLE_TRACING="1")
            args = ["bun", "run", entry]
            if scenario == "piped-approve":
                read_fd, write_fd = os.pipe()
                os.write(write_fd, b"Run the requested task.\n")
                os.close(write_fd)
                os.dup2(read_fd, 0)
                os.close(read_fd)
            elif not scenario.startswith("repl"):
                args.append("Run the requested task.")
            try:
                os.execvpe("bun", args, env)
            except OSError:
                os._exit(127)
        screen = b""
        approved = False
        interrupted = False
        existed_before = None
        status = None
        sent_prompt = False
        sent_eof = False
        deadline = time.monotonic() + 20
        try:
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
                lower = screen.lower()
                if scenario.startswith("repl"):
                    if scenario in ("repl-turn", "repl-approve") and not sent_prompt and b"> " in screen:
                        os.write(fd, b"Say hello.\n")
                        sent_prompt = True
                    eof_ready = scenario == "repl-eof" and b"> " in screen or scenario in ("repl-turn", "repl-approve") and b"Finished." in screen and screen.count(b"> ") >= 2
                    if eof_ready and not sent_eof:
                        os.write(fd, b"\x04")
                        sent_eof = True
                if not approved and scenario != "model-cancel" and (b"[y/n]" in lower or b"(y/n)" in lower or b"approve?" in lower):
                    existed_before = (root / "count.txt").exists()
                    if scenario == "approval-cancel":
                        os.write(fd, b"\x03")
                        interrupted = True
                    else:
                        os.write(fd, b"n\n" if scenario == "deny" else b"y\n")
                    approved = True
                if scenario == "model-cancel" and requests and not interrupted:
                    os.write(fd, b"\x03")
                    interrupted = True
                if scenario == "shell-cancel" and (root / "child.pid").exists() and not interrupted:
                    os.write(fd, b"\x03")
                    interrupted = True
                exited, candidate = os.waitpid(pid, os.WNOHANG)
                if exited:
                    status = candidate
                    break
            if status is None:
                exited, candidate = os.waitpid(pid, os.WNOHANG)
                if exited:
                    status = candidate
                else:
                    os.kill(pid, signal.SIGKILL)
                    _, status = os.waitpid(pid, 0)
            code = os.waitstatus_to_exitcode(status)
            count = (root / "count.txt").read_text() if (root / "count.txt").exists() else None
            child_alive = False
            if scenario == "shell-cancel" and (root / "child.pid").exists():
                child_pid = int((root / "child.pid").read_text())
                try:
                    os.kill(child_pid, 0)
                    child_alive = True
                except ProcessLookupError:
                    pass
            result = {"scenario": scenario, "exit_code": code, "requests": len(requests), "approval_prompt_seen": approved, "file_existed_before_approval": existed_before, "file_contents": count, "interrupted": interrupted, "child_alive_after_exit": child_alive}
            if scenario.startswith("repl"):
                assert sent_eof and code == 0, result
                assert len(requests) == (2 if scenario == "repl-approve" else 1 if scenario == "repl-turn" else 0), result
                if scenario == "repl-approve":
                    assert approved and existed_before is False and count == "x", result
            elif scenario in ("approve", "deny", "patch", "piped-approve"):
                assert code == 0, result
                assert approved and existed_before is False, result
                assert count == ("x" if scenario in ("approve", "patch", "piped-approve") else None), result
                assert len(requests) == 2, result
            else:
                assert interrupted and code == 130, result
                if scenario == "shell-cancel":
                    assert not child_alive, result
                if scenario == "approval-cancel":
                    assert result["file_contents"] is None and result["file_existed_before_approval"] is False, result
            result["verdict"] = "VERIFIED"
            return result
        finally:
            stop.set()
            server.shutdown()
            server.server_close()
            os.close(fd)
            (artifacts / (scenario + ".txt")).write_bytes(screen)
            (artifacts / (scenario + "-requests.json")).write_text(json.dumps(requests, indent=2))


for scenario in ["approve", "deny", "patch", "model-cancel", "shell-cancel", "approval-cancel", "repl-eof", "repl-turn", "repl-approve", "piped-approve"]:
    try:
        result = probe(scenario)
    except Exception as error:
        result = {"scenario": scenario, "verdict": "NOT VERIFIED", "error": str(error)}
    results.append(result)
    print(json.dumps(result), flush=True)
(artifacts / "results.json").write_text(json.dumps(results, indent=2))
sys.exit(0 if all(result["verdict"] == "VERIFIED" for result in results) else 1)
