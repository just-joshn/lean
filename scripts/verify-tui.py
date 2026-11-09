import errno
import fcntl
import http.server
import json
import os
import pathlib
import pty
import select
import struct
import sys
import tempfile
import termios
import threading
import time

entry = str(pathlib.Path(sys.argv[1]).resolve())
artifacts = pathlib.Path(sys.argv[2])
artifacts.mkdir(parents=True, exist_ok=True)
rows, cols = 32, 100


class Screen:
    def __init__(self):
        self.grid = [[" "] * cols for _ in range(rows)]
        self.row = 0
        self.col = 0
        self.raw = bytearray()
        self.grew = False

    def text(self):
        return "\n".join("".join(line).rstrip() for line in self.grid).rstrip()

    def write(self, data):
        self.raw.extend(data)
        text = data.decode("utf-8", "replace")
        index = 0
        while index < len(text):
            char = text[index]
            if char == "\x1b":
                index += 1
                if index < len(text) and text[index] == "[":
                    index += 1
                    start = index
                    while index < len(text) and not ("@" <= text[index] <= "~"):
                        index += 1
                    if index >= len(text):
                        break
                    final = text[index]
                    body = text[start:index]
                    self.csi(body, final)
                    index += 1
                    continue
                if index < len(text):
                    index += 1
                continue
            if char == "\r":
                self.col = 0
            elif char == "\n":
                self.row = min(rows - 1, self.row + 1)
            elif char == "\b":
                self.col = max(0, self.col - 1)
            elif char >= " ":
                if self.col >= cols:
                    self.col = 0
                    self.row = min(rows - 1, self.row + 1)
                self.grid[self.row][self.col] = char
                self.col += 1
            index += 1

    def csi(self, body, final):
        parts = body.split(";") if body else []

        def number(offset, default):
            if offset >= len(parts) or parts[offset] == "":
                return default
            try:
                return int(parts[offset])
            except ValueError:
                return default

        if final == "H" or final == "f":
            self.row = min(rows - 1, max(0, number(0, 1) - 1))
            self.col = min(cols - 1, max(0, number(1, 1) - 1))
        elif final == "A":
            self.row = max(0, self.row - number(0, 1))
        elif final == "B":
            self.row = min(rows - 1, self.row + number(0, 1))
        elif final == "C":
            self.col = min(cols - 1, self.col + number(0, 1))
        elif final == "D":
            self.col = max(0, self.col - number(0, 1))
        elif final == "G":
            self.col = min(cols - 1, max(0, number(0, 1) - 1))
        elif final == "J":
            mode = number(0, 0)
            if mode == 2:
                self.grid = [[" "] * cols for _ in range(rows)]
            elif mode == 0:
                self.erase(self.row, self.col, rows, cols)
        elif final == "K":
            for column in range(self.col, cols):
                self.grid[self.row][column] = " "

    def erase(self, row, col, end_row, end_col):
        for current in range(row, min(rows, end_row)):
            start = col if current == row else 0
            stop = end_col if current == end_row - 1 else cols
            for column in range(start, stop):
                self.grid[current][column] = " "


def pump(screen, master, proc_pid, timeout):
    ready, _, _ = select.select([master], [], [], timeout)
    if ready:
        try:
            chunk = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                return False
            raise
        if not chunk:
            return False
        screen.write(chunk)
        screen.grew = True
    exited, _ = os.waitpid(proc_pid, os.WNOHANG)
    return not exited


def wait_for(screen, master, proc_pid, needle, deadline):
    while time.monotonic() < deadline:
        if needle in screen.text() or needle.encode() in screen.raw:
            return True
        if not pump(screen, master, proc_pid, 0.1):
            return needle in screen.text() or needle.encode() in screen.raw
    return needle in screen.text() or needle.encode() in screen.raw


def settle(screen, master, proc_pid, pause=0.35):
    quiet = time.monotonic()
    end = time.monotonic() + 5
    while time.monotonic() < end:
        if not pump(screen, master, proc_pid, 0.05):
            return
        if screen.grew:
            quiet = time.monotonic()
            screen.grew = False
        elif time.monotonic() - quiet >= pause:
            return


def send(screen, master, proc_pid, data):
    settle(screen, master, proc_pid)
    os.write(master, data)


def launch(directory, args, env):
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(directory)
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        try:
            os.execvpe("bun", args, env)
        except OSError:
            os._exit(127)
    screen = Screen()
    return pid, master, screen


def finish(pid, master, screen, name):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            screen.write(chunk)
        exited, status = os.waitpid(pid, os.WNOHANG)
        if exited:
            (artifacts / f"{name}.txt").write_text(screen.text())
            (artifacts / f"{name}.raw").write_bytes(screen.raw)
            os.close(master)
            return os.waitstatus_to_exitcode(status)
    os.kill(pid, 15)
    kill_deadline = time.monotonic() + 2
    while time.monotonic() < kill_deadline:
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            screen.write(chunk)
        exited, status = os.waitpid(pid, os.WNOHANG)
        if exited:
            (artifacts / f"{name}.txt").write_text(screen.text())
            (artifacts / f"{name}.raw").write_bytes(screen.raw)
            os.close(master)
            return os.waitstatus_to_exitcode(status)
    os.kill(pid, 9)
    _, status = os.waitpid(pid, 0)
    (artifacts / f"{name}.txt").write_text(screen.text())
    (artifacts / f"{name}.raw").write_bytes(screen.raw)
    os.close(master)
    return os.waitstatus_to_exitcode(status)


def base_env():
    env = dict(os.environ)
    for name in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"):
        env.pop(name, None)
    env["TERM"] = "xterm-256color"
    env["COLUMNS"] = str(cols)
    env["LINES"] = str(rows)
    env["OPENAI_AGENTS_DISABLE_TRACING"] = "1"
    return env


def demo():
    with tempfile.TemporaryDirectory(prefix="lean-tui-demo-") as directory:
        pid, master, screen = launch(
            directory,
            ["bun", "run", entry, "--demo"],
            base_env(),
        )
        deadline = time.monotonic() + 20
        seen = wait_for(screen, master, pid, "enter send", deadline)
        if seen:
            send(screen, master, pid, b"hello")
            seen = wait_for(screen, master, pid, "hello", deadline)
        if seen:
            send(screen, master, pid, b"\r")
            seen = wait_for(screen, master, pid, "Nothing was executed", deadline)
        if seen:
            send(screen, master, pid, b"\x03")
            seen = wait_for(screen, master, pid, "Press Ctrl+C again", deadline)
        if seen:
            send(screen, master, pid, b"\x03")
        code = finish(pid, master, screen, "demo")
        history = pathlib.Path(directory, ".lean", "history.json").exists()
        ok = (
            seen
            and code == 0
            and not history
            and "Lean" in screen.text()
            and "hello" in screen.text()
            and "Nothing was executed" in screen.text()
            and "synthetic" in screen.text()
        )
        return {
            "scenario": "demo",
            "verdict": "VERIFIED" if ok else "NOT VERIFIED",
            "exit_code": code,
            "history_created": history,
            "saw_patterns": seen,
        }


def api():
    with tempfile.TemporaryDirectory(prefix="lean-tui-api-") as directory:
        requests = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append(body)
                command = "printf hi > tui-marker.txt"
                if len(requests) == 1:
                    output = [
                        {
                            "id": "sh_probe",
                            "type": "shell_call",
                            "call_id": "call_probe",
                            "status": "completed",
                            "action": {
                                "commands": [command],
                                "timeout_ms": 120000,
                                "max_output_length": 10000,
                            },
                        }
                    ]
                else:
                    output = [
                        {
                            "id": "msg_probe",
                            "type": "message",
                            "role": "assistant",
                            "status": "completed",
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": "Finished.",
                                    "annotations": [],
                                }
                            ],
                        }
                    ]
                response = {
                    "id": "resp_probe_" + str(len(requests)),
                    "object": "response",
                    "created_at": 1,
                    "model": "gpt-5.4",
                    "status": "completed",
                    "output": output,
                    "usage": {
                        "input_tokens": 10,
                        "output_tokens": 5,
                        "total_tokens": 15,
                        "input_tokens_details": {"cached_tokens": 0},
                        "output_tokens_details": {"reasoning_tokens": 0},
                    },
                }
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()

                def send(event):
                    self.wfile.write(
                        ("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n").encode()
                    )
                    self.wfile.flush()

                try:
                    send(
                        {
                            "type": "response.created",
                            "response": dict(response, status="in_progress", output=[]),
                        }
                    )
                    for index, item in enumerate(output):
                        send(
                            {
                                "type": "response.output_item.added",
                                "output_index": index,
                                "item": item,
                            }
                        )
                        if item["type"] == "message":
                            send(
                                {
                                    "type": "response.output_text.delta",
                                    "item_id": item["id"],
                                    "output_index": index,
                                    "content_index": 0,
                                    "delta": item["content"][0]["text"],
                                }
                            )
                        send(
                            {
                                "type": "response.output_item.done",
                                "output_index": index,
                                "item": item,
                            }
                        )
                    send({"type": "response.completed", "response": response})
                except (BrokenPipeError, ConnectionResetError):
                    pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        env = base_env()
        env["OPENAI_API_KEY"] = "local-test-key"
        env["LEAN_HOME"] = str(pathlib.Path(directory, "auth"))
        env["OPENAI_MODEL"] = "gpt-5.4"
        env["OPENAI_BASE_URL"] = f"http://127.0.0.1:{server.server_port}/v1"
        try:
            pid, master, screen = launch(directory, ["bun", "run", entry], env)
            deadline = time.monotonic() + 25
            seen = wait_for(screen, master, pid, "enter send", deadline)
            if seen:
                send(screen, master, pid, b"run please\r")
                seen = wait_for(screen, master, pid, "Nothing has run", deadline)
            if seen:
                send(screen, master, pid, b"y")
                seen = wait_for(screen, master, pid, "Finished.", deadline)
            if seen:
                send(screen, master, pid, b"\x03")
                if wait_for(screen, master, pid, "Press Ctrl+C again", deadline):
                    send(screen, master, pid, b"\x03")
            code = finish(pid, master, screen, "api")
            marker = pathlib.Path(directory, "tui-marker.txt")
            marker_text = marker.read_text() if marker.exists() else None
            history = pathlib.Path(directory, ".lean", "history.json")
            if history.exists():
                (artifacts / "api-history.json").write_text(history.read_text())
            shown = screen.text()
            ok = (
                seen
                and code == 0
                and marker_text == "hi"
                and "Lean" in shown
                and "run please" in shown
                and "Finished." in shown
                and "exit 0" in shown
            )
            return {
                "scenario": "api",
                "verdict": "VERIFIED" if ok else "NOT VERIFIED",
                "exit_code": code,
                "requests": len(requests),
                "marker": marker_text,
                "saw_patterns": seen,
                "saw_exit_status": "exit 0" in shown,
            }
        finally:
            server.shutdown()
            server.server_close()


def main():
    results = [demo(), api()]
    (artifacts / "results.json").write_text(json.dumps(results, indent=2))
    for result in results:
        print(json.dumps(result), flush=True)
    return 0 if all(result["verdict"] == "VERIFIED" for result in results) else 1


if __name__ == "__main__":
    sys.exit(main())
