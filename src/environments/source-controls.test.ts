import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import controls from "./source-controls.json" with { type: "json" };
import { DockerEnvironment } from "./docker.ts";
import { LocalEnvironment } from "./local.ts";

const subprocess = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:child_process", () => subprocess);

beforeEach(() => {
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw new Error("unexpected signal");
  });
  subprocess.spawn.mockReset().mockImplementation(() => {
    throw new Error("unexpected subprocess");
  });
  subprocess.spawnSync
    .mockReset()
    .mockImplementation((_executable, _args, _options) => ({
      stdout: Buffer.from("cid-owned\n"),
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
    }));
});
afterEach(() => vi.restoreAllMocks());

function streamValue(value: unknown) {
  if (Buffer.isBuffer(value))
    return { type: "bytes", value: null, raw: [...value] };
  if (value === null) return { type: "null", value: null, raw: null };
  if (value === undefined) return { type: "undefined", value: null, raw: null };
  return { type: "str", value, raw: null };
}

function properties(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null)
    throw new Error("expected error object");
  return Object.fromEntries(Object.entries(value));
}

describe("saved source startup controls", () => {
  const startup = controls.rows.filter((row) => "input" in row);
  test.each(startup)("$id", (row) => {
    if (!row.input) throw new Error("missing startup input");
    const { input, source } = row;
    subprocess.spawnSync.mockImplementation((_executable, _args, _options) => ({
      stdout: Buffer.from(input.stdout),
      stderr: Buffer.from(input.stderr),
      status: input.status,
      signal: input.signal,
      error: input.error
        ? Object.assign(new Error("native timeout"), { code: input.error })
        : undefined,
    }));
    let environment: DockerEnvironment | undefined;
    let failure: unknown;
    try {
      environment = new DockerEnvironment({
        image: input.image,
        executable: "/owned/docker",
        cwd: "/workspace",
        pull_timeout: input.timeout,
      });
    } catch (error) {
      failure = error;
    }
    const call = subprocess.spawnSync.mock.calls[0];
    expect(call).toBeDefined();
    const args: string[] = [call?.[0], ...call?.[1]];
    expect(args).toEqual([
      "/owned/docker",
      "run",
      "-d",
      "--name",
      expect.stringMatching(/^minisweagent-[0-9a-f]{8}$/),
      "-w",
      "/workspace",
      "--rm",
      input.image,
      "sleep",
      "2h",
    ]);
    expect(call?.[2]).toStrictEqual({ timeout: input.timeout * 1000 });
    if (source.kind === "constructed") {
      expect(failure).toBeUndefined();
      expect(environment?.container_id).toBe(source.container_id);
      return;
    }
    expect(environment).toBeUndefined();
    expect(failure).toBeInstanceOf(Error);
    const expected = source.error;
    if (!expected) throw new Error("missing saved source error");
    let message = expected.message;
    if (expected.cmd) {
      message = message
        .replace(expected.cmd[0] ?? "", args[0] ?? "")
        .replace(expected.cmd[4] ?? "", args[4] ?? "");
    }
    expect(failure).toMatchObject({ name: expected.type, message });
    const actual = properties(failure);
    if (expected.type === "UnicodeDecodeError") {
      expect(actual).toMatchObject({
        encoding: expected.encoding,
        start: expected.start,
        end: expected.end,
        reason: expected.reason,
      });
      expect(actual.object).toEqual(Buffer.from(expected.object ?? []));
    } else {
      expect(actual.cmd).toEqual(args);
      for (const key of ["output", "stdout", "stderr"] as const) {
        expect(streamValue(actual[key])).toStrictEqual(expected[key]);
      }
      expect(actual.stdout).toBe(actual.output);
      if (expected.type === "TimeoutExpired")
        expect(actual.timeout).toBe(expected.timeout);
      else expect(actual.returncode).toBe(expected.returncode);
    }
    expect(subprocess.spawn).not.toHaveBeenCalled();
  });
});

function fakeAction(bytes: Buffer, code: number | null, signal: string | null) {
  const collector = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
  });
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    pid: undefined,
  });
  subprocess.spawn.mockReturnValueOnce(collector).mockReturnValueOnce(child);
  queueMicrotask(() => {
    collector.stdout.emit("data", bytes);
    child.emit("exit", code, signal);
    queueMicrotask(() => collector.emit("close", 0));
  });
}

describe("public action results against saved source", () => {
  const ids = [
    "local-sigterm",
    "local-sigkill",
    "local-exit7",
    "local-newlines-success",
    "local-replace",
    "docker-sigterm",
    "docker-sigkill",
    "docker-exit7",
    "docker-newlines-success",
    "docker-replace",
  ];
  test.each(controls.rows.filter((row) => ids.includes(row.id)))(
    "$id",
    async (row) => {
      const env = row.id.startsWith("local")
        ? new LocalEnvironment()
        : new DockerEnvironment({ image: "img", executable: "/owned/docker" });
      const bytes = row.id.includes("newlines")
        ? Buffer.from("OUT\na\rb\r\npartial")
        : row.id.includes("replace")
          ? Buffer.concat([
              Buffer.from([255]),
              Buffer.from(row.id.startsWith("local") ? "é\n" : "é"),
            ])
          : Buffer.alloc(0);
      const signal = row.id.endsWith("sigterm")
        ? "SIGTERM"
        : row.id.endsWith("sigkill")
          ? "SIGKILL"
          : null;
      fakeAction(bytes, signal ? null : row.source.returncode, signal);
      const result = await env.execute({ command: "not executed" });
      expect(result).toEqual({
        output: String.fromCodePoint(...row.source.output_codes),
        returncode: row.source.returncode,
        exception_info: "",
      });
    },
  );

  test("cleanup repeats for an id and skips a null id", () => {
    subprocess.spawn.mockImplementation(() => ({ unref: vi.fn() }));
    const env = new DockerEnvironment({
      image: "img",
      executable: "/owned/docker",
    });
    env.cleanup();
    env.cleanup();
    expect(subprocess.spawn.mock.calls).toEqual(
      [0, 1].map(() => [
        "/bin/sh",
        [
          "-c",
          "(timeout 60 /owned/docker stop cid-owned || /owned/docker rm -f cid-owned) >/dev/null 2>&1 &",
        ],
        { detached: true, stdio: "ignore" },
      ]),
    );
    env.container_id = null;
    env.cleanup();
    expect(subprocess.spawn).toHaveBeenCalledTimes(2);
  });
});
