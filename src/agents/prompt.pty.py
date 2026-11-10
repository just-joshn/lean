import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

spec = json.loads(sys.stdin.read())
columns = int(spec.get("cols") or 80)
rows = int(spec.get("rows") or 24)
master, slave = pty.openpty()
fcntl_mod = __import__("fcntl")
fcntl_mod.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
before = termios.tcgetattr(slave)
env = os.environ.copy()
env.update(spec.get("env") or {})
env["TERM"] = "xterm-256color"
process = subprocess.Popen(
    spec["argv"],
    stdin=slave,
    stdout=slave,
    stderr=slave,
    cwd=spec["cwd"],
    env=env,
    close_fds=True,
)
os.close(slave)
output = bytearray()
killed = False


def wait_for(token: bytes, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while token not in output and time.monotonic() < deadline:
        pull(0.05)
    if token not in output:
        raise SystemExit("prompt was not ready\n" + output.decode("utf-8", "surrogateescape"))


def pull(timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        ready, _, _ = select.select([master], [], [], min(0.05, remaining))
        if not ready:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            return
        if not chunk:
            return
        output.extend(chunk)


readiness = spec["readiness"]
if readiness["kind"] == "cpr":
    wait_for(b"\x1b[6n", float(spec.get("timeout") or 5))
    os.write(master, b"\x1b[1;1R")
elif readiness["kind"] == "marker":
    wait_for(readiness["text"].encode("utf-8"), float(spec.get("timeout") or 5))
else:
    raise SystemExit(f"unknown readiness {readiness['kind']}")
for step in spec.get("steps") or []:
    kind = step[0]
    if kind == "sleep":
        pull(float(step[1]))
    elif kind == "write":
        os.write(master, step[1].encode("utf-8"))
        pull(0)
    elif kind == "bytes":
        os.write(master, bytes(step[1]))
        pull(0)
    elif kind == "signal":
        os.kill(process.pid, getattr(signal, step[1]))
        pull(0.05)
    else:
        raise SystemExit(f"unknown step {kind}")

deadline = time.monotonic() + float(spec.get("timeout") or 5)
while process.poll() is None and time.monotonic() < deadline:
    pull(0.05)
if process.poll() is None:
    killed = True
    process.terminate()
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=1)
pull(0.05)
try:
    after = termios.tcgetattr(master)
    restored = before == after
except termios.error:
    restored = False
os.close(master)
json.dump(
    {
        "code": process.returncode,
        "killed": killed,
        "restored": restored,
        "output": output.decode("utf-8", "surrogateescape"),
    },
    sys.stdout,
)
