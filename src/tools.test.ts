import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RunContext } from "@openai/agents";
import { afterEach, expect, test } from "vitest";
import { createWorkspaceTools } from "./tools.ts";

const execFileAsync = promisify(execFile);
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function directory() {
  const cwd = await mkdtemp(join(tmpdir(), "lean-tools-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

function host(cwd: string, signal = new AbortController().signal) {
  return createWorkspaceTools({ cwd, signal });
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

async function waitForPid(file: string) {
  const started = Date.now();
  while (Date.now() - started < 2_000) {
    try {
      const pid = Number((await readFile(file, "utf8")).trim());
      if (pid > 0) return pid;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("child pid was not written");
}

test("shell preserves stdout, stderr, and a nonzero exit", async () => {
  const cwd = await directory();
  const { shell } = host(cwd);
  const result = await shell.shell.run({
    commands: ["echo out; echo err >&2; exit 3"],
  });
  expect(result.output[0]).toEqual({
    stdout: "out\n",
    stderr: "err\n",
    outcome: { type: "exit", exitCode: 3 },
  });
});

test("shell uses sh -c and honors a lower output limit", async () => {
  const cwd = await directory();
  const { shell } = host(cwd);
  const limited = await shell.shell.run({
    commands: ["printf 1234567890"],
    maxOutputLength: 4,
  });
  expect(limited.output[0]?.stdout.length).toBeLessThanOrEqual(4);
  expect(limited.maxOutputLength).toBe(4);
});

test("shell timeout kills the command and its descendants", async () => {
  const cwd = await directory();
  const { shell } = host(cwd);
  const result = await shell.shell.run({
    commands: ["sleep 30 & echo $! > child.pid; wait"],
    timeoutMs: 800,
  });
  expect(result.output[0]?.outcome).toEqual({ type: "timeout" });
  const pid = Number((await readFile(join(cwd, "child.pid"), "utf8")).trim());
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(alive(pid)).toBe(false);
});

test("abort kills the command group and the shell call settles", async () => {
  const cwd = await directory();
  const controller = new AbortController();
  const { shell } = host(cwd, controller.signal);
  const pending = shell.shell.run({
    commands: ["sleep 30 & echo $! > child.pid; wait"],
    timeoutMs: 20_000,
  });
  const pid = await waitForPid(join(cwd, "child.pid"));
  controller.abort();
  const result = await pending;
  expect(result.output[0]?.outcome).toEqual({ type: "timeout" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(alive(pid)).toBe(false);
});

test("read returns a bounded page and refuses paths outside the workspace", async () => {
  const cwd = await directory();
  const outside = await directory();
  await writeFile(join(cwd, "note.txt"), "one\ntwo\nthree\n");
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(outside, join(cwd, "escape"));
  const { read } = host(cwd);
  const context = new RunContext();
  expect(await read.invoke(context, JSON.stringify({ path: "note.txt" }))).toBe(
    "one\ntwo\nthree",
  );
  expect(
    await read.invoke(
      context,
      JSON.stringify({ path: "note.txt", offset: 2, limit: 1 }),
    ),
  ).toBe("two\n[truncated]");
  expect(
    await read.invoke(
      context,
      JSON.stringify({ path: "note.txt", offset: 3, limit: 1 }),
    ),
  ).toBe("three");
  const lines = Array.from({ length: 250 }, (_, index) => `line ${index + 1}`);
  await writeFile(join(cwd, "long.txt"), lines.join("\n"));
  const page = String(
    await read.invoke(context, JSON.stringify({ path: "long.txt" })),
  );
  expect(
    page.split("\n").filter((line) => line.startsWith("line")),
  ).toHaveLength(200);
  expect(page).toContain("[truncated]");
  await expect(
    read.invoke(context, JSON.stringify({ path: "../secret.txt" })),
  ).resolves.toMatch(/outside/i);
  await expect(
    read.invoke(context, JSON.stringify({ path: "escape/secret.txt" })),
  ).resolves.toMatch(/outside/i);
  expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("secret");
});

test("patch creates, updates, deletes, and moves without clobbering on failure", async () => {
  const cwd = await directory();
  const outside = await directory();
  await symlink(outside, join(cwd, "escape"));
  const { applyPatch } = host(cwd);
  const created = await applyPatch.editor.createFile({
    type: "create_file",
    path: "note.txt",
    diff: "+hello\n",
  });
  expect(created?.status).toBe("completed");
  expect(await readFile(join(cwd, "note.txt"), "utf8")).toBe("hello");
  const overwrite = await applyPatch.editor.createFile({
    type: "create_file",
    path: "note.txt",
    diff: "+replaced\n",
  });
  expect(overwrite?.status).toBe("failed");
  expect(await readFile(join(cwd, "note.txt"), "utf8")).toBe("hello");

  const updated = await applyPatch.editor.updateFile({
    type: "update_file",
    path: "note.txt",
    diff: "@@\n-hello\n+goodbye\n",
  });
  expect(updated?.status).toBe("completed");
  expect(await readFile(join(cwd, "note.txt"), "utf8")).toBe("goodbye");

  const wrong = await applyPatch.editor.updateFile({
    type: "update_file",
    path: "note.txt",
    diff: "@@\n-missing\n+nope\n",
  });
  expect(wrong?.status).toBe("failed");
  expect(await readFile(join(cwd, "note.txt"), "utf8")).toBe("goodbye");

  const escaped = await applyPatch.editor.updateFile({
    type: "update_file",
    path: "note.txt",
    diff: "@@\n-goodbye\n+moved\n",
    moveTo: "escape/moved.txt",
  });
  expect(escaped?.status).toBe("failed");
  expect(await readFile(join(cwd, "note.txt"), "utf8")).toBe("goodbye");
  await expect(readFile(join(outside, "moved.txt"), "utf8")).rejects.toThrow();

  const moved = await applyPatch.editor.updateFile({
    type: "update_file",
    path: "note.txt",
    diff: "@@\n-goodbye\n+moved\n",
    moveTo: "other.txt",
  });
  expect(moved?.status).toBe("completed");
  await expect(readFile(join(cwd, "note.txt"), "utf8")).rejects.toThrow();
  expect(await readFile(join(cwd, "other.txt"), "utf8")).toBe("moved");

  await mkdir(join(cwd, "nested"));
  await writeFile(join(cwd, "nested", "gone.txt"), "x");
  const deleted = await applyPatch.editor.deleteFile({
    type: "delete_file",
    path: "nested/gone.txt",
  });
  expect(deleted?.status).toBe("completed");
  await expect(
    readFile(join(cwd, "nested", "gone.txt"), "utf8"),
  ).rejects.toThrow();
  const missing = await applyPatch.editor.deleteFile({
    type: "delete_file",
    path: "nested/gone.txt",
  });
  expect(missing?.status).toBe("failed");
});

test.for([
  { mode: 0o600, moveTo: undefined },
  { mode: 0o755, moveTo: undefined },
  { mode: 0o600, moveTo: "moved.sh" },
  { mode: 0o755, moveTo: "moved.sh" },
])("patch updates preserve permissions %j", async ({ mode, moveTo }) => {
  const cwd = await directory();
  const file = join(cwd, "script.sh");
  await writeFile(file, "before");
  await chmod(file, mode);
  const { applyPatch } = host(cwd);
  const result = await applyPatch.editor.updateFile({
    type: "update_file",
    path: "script.sh",
    diff: "@@\n-before\n+after\n",
    moveTo,
  });
  const destination = join(cwd, moveTo ?? "script.sh");
  expect(result?.status).toBe("completed");
  expect(await readFile(destination, "utf8")).toBe("after");
  expect((await stat(destination)).mode & 0o777).toBe(mode);
});

test("a single long line cannot bypass the read output limit", async () => {
  const cwd = await directory();
  await writeFile(join(cwd, "long.txt"), "x".repeat(100_000));
  const { read } = host(cwd);
  const result = String(
    await read.invoke(new RunContext(), JSON.stringify({ path: "long.txt" })),
  );
  expect(result.length).toBeLessThanOrEqual(32_012);
  expect(result).toContain("[truncated]");
});

test("patch mutations reject final symlinks without removing their targets", async () => {
  const cwd = await directory();
  await writeFile(join(cwd, "target.txt"), "keep");
  await symlink("target.txt", join(cwd, "link.txt"));
  const { applyPatch } = host(cwd);
  const deleted = await applyPatch.editor.deleteFile({
    type: "delete_file",
    path: "link.txt",
  });
  expect(deleted?.status).toBe("failed");
  expect(await readFile(join(cwd, "target.txt"), "utf8")).toBe("keep");
  expect(await readFile(join(cwd, "link.txt"), "utf8")).toBe("keep");
  const moved = await applyPatch.editor.updateFile({
    type: "update_file",
    path: "link.txt",
    diff: "@@\n-keep\n+changed\n",
    moveTo: "moved.txt",
  });
  expect(moved?.status).toBe("failed");
  expect(await readFile(join(cwd, "target.txt"), "utf8")).toBe("keep");
  await expect(readFile(join(cwd, "moved.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("patch creation makes missing workspace directories", async () => {
  const cwd = await directory();
  const { applyPatch } = host(cwd);
  const created = await applyPatch.editor.createFile({
    type: "create_file",
    path: "src/utils/note.txt",
    diff: "+created\n",
  });
  expect(created?.status).toBe("completed");
  expect(await readFile(join(cwd, "src/utils/note.txt"), "utf8")).toBe(
    "created",
  );
});

test("shell commands run in the workspace", async () => {
  const cwd = await directory();
  const { shell } = host(cwd);
  await execFileAsync("/bin/sh", ["-c", "pwd > where.txt"], { cwd });
  const result = await shell.shell.run({ commands: ["pwd"] });
  expect(result.output[0]?.stdout.trim()).toBe(
    (await readFile(join(cwd, "where.txt"), "utf8")).trim(),
  );
});
