import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  applyDiff,
  applyPatchTool,
  shellTool,
  tool,
  type ApplyPatchOperation,
  type ApplyPatchResult,
  type ShellAction,
  type ShellOutputResult,
  type ShellResult,
} from "@openai/agents";
import { z } from "zod";

const COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_OUTPUT_LIMIT = 32_768;
const READ_LINE_LIMIT = 200;
const READ_CHAR_LIMIT = 32_000;

const readParameters = z.object({
  path: z.string().describe("Workspace file to read"),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("First line to return, starting at 1"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Maximum lines to return. Defaults to 200"),
});

export type WorkspaceHost = {
  cwd: string;
  signal: AbortSignal;
};

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function isInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(fromRoot))
  );
}

async function confine(
  rootInput: string,
  inputPath: string,
  mode: "read" | "create" | "edit",
): Promise<string> {
  if (inputPath.includes("\0")) throw new Error("Invalid path.");
  const root = await realpath(rootInput);
  const absolute = resolve(root, inputPath);
  if (!isInside(root, absolute)) {
    throw new Error(`Path is outside the workspace: ${inputPath}`);
  }
  const parts = relative(root, absolute)
    .split(sep)
    .filter((part) => part.length > 0);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    const next = join(current, parts[index] ?? "");
    const last = index === parts.length - 1;
    try {
      const stats = await lstat(next);
      if (stats.isSymbolicLink()) {
        if (last && mode !== "read") {
          throw new Error(
            `Refusing to modify symlink ${inputPath}. Use its target path explicitly.`,
          );
        }
        const target = await realpath(next);
        if (!isInside(root, target)) {
          throw new Error(`Path is outside the workspace: ${inputPath}`);
        }
        current = target;
        continue;
      }
      current = next;
    } catch (error) {
      if (isCode(error, "ENOENT") && mode === "create") {
        return join(next, ...parts.slice(index + 1));
      }
      if (isCode(error, "ENOENT")) {
        throw new Error(`Path does not exist: ${inputPath}`);
      }
      throw error;
    }
  }
  if (mode === "read") {
    const target = await realpath(current);
    if (!isInside(root, target)) {
      throw new Error(`Path is outside the workspace: ${inputPath}`);
    }
    return target;
  }
  return current;
}

function failed(error: unknown): ApplyPatchResult {
  const output = error instanceof Error ? error.message : String(error);
  return { status: "failed", output };
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function writeNew(
  file: string,
  body: string,
  mode?: number,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const handle = await open(file, "wx", mode ?? 0o644);
  try {
    if (mode !== undefined) await handle.chmod(mode);
    await handle.writeFile(body);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(file, { force: true });
    throw error;
  }
  await handle.close();
}

async function replaceFile(
  file: string,
  body: string,
  mode: number,
): Promise<void> {
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  await chmod(temporary, mode);
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function bounded(requested: number | undefined, ceiling: number): number {
  if (
    requested === undefined ||
    !Number.isFinite(requested) ||
    requested <= 0
  ) {
    return ceiling;
  }
  return Math.min(Math.floor(requested), ceiling);
}

// shell.run does not receive the run signal, so the command watches host.signal.
function runCommand(
  command: string,
  host: WorkspaceHost,
  timeoutMs: number,
  outputLimit: number,
): Promise<ShellOutputResult> {
  return new Promise((resolvePromise) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const finish = (result: ShellOutputResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(backup);
      host.signal.removeEventListener("abort", onAbort);
      resolvePromise(result);
    };
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: host.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunks: Buffer[], seen: number, chunk: Buffer) => {
      if (seen >= outputLimit) return seen;
      const slice = chunk.subarray(0, outputLimit - seen);
      chunks.push(slice);
      return seen + slice.length;
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes = collect(stdout, stdoutBytes, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes = collect(stderr, stderrBytes, chunk);
    });
    const captured = () => ({
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    });
    child.once("error", (error) => {
      const output = captured();
      finish({
        ...output,
        stderr: [output.stderr, error.message].filter(Boolean).join("\n"),
        outcome: { type: "exit", exitCode: null },
      });
    });
    child.once("close", (code) => {
      const output = captured();
      if (timedOut || aborted) {
        finish({ ...output, outcome: { type: "timeout" } });
        return;
      }
      finish({
        ...output,
        outcome: { type: "exit", exitCode: code },
      });
    });
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (!isCode(error, "ESRCH")) {
          child.emit(
            "error",
            new Error(`Could not terminate command: ${String(error)}`),
          );
        }
      }
    };
    const onAbort = () => {
      aborted = true;
      killGroup();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    const backup = setTimeout(() => {
      killGroup();
      finish({
        ...captured(),
        stderr: "The command did not exit after it was killed.",
        outcome: { type: "timeout" },
      });
    }, timeoutMs + 1_000);
    if (host.signal.aborted) onAbort();
    else host.signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runShell(
  action: ShellAction,
  host: WorkspaceHost,
): Promise<ShellResult> {
  const timeoutMs = bounded(action.timeoutMs, COMMAND_TIMEOUT_MS);
  const maxOutputLength = bounded(action.maxOutputLength, COMMAND_OUTPUT_LIMIT);
  if (action.commands.length === 0) {
    return {
      output: [
        {
          stdout: "",
          stderr: "No command was provided.",
          outcome: { type: "exit", exitCode: null },
        },
      ],
      maxOutputLength,
    };
  }
  const output: ShellOutputResult[] = [];
  const deadline = Date.now() + timeoutMs;
  for (const command of action.commands) {
    if (host.signal.aborted) {
      output.push({
        stdout: "",
        stderr: "Aborted.",
        outcome: { type: "timeout" },
      });
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      output.push({ stdout: "", stderr: "", outcome: { type: "timeout" } });
      continue;
    }
    output.push(await runCommand(command, host, remaining, maxOutputLength));
  }
  return { output, maxOutputLength };
}

async function readWorkspace(
  input: z.infer<typeof readParameters>,
  host: WorkspaceHost,
): Promise<string> {
  host.signal.throwIfAborted();
  const file = await confine(host.cwd, input.path, "read");
  const offset = input.offset ?? 1;
  const limit = input.limit ?? READ_LINE_LIMIT;
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const onAbort = () => {
    stream.destroy();
  };
  host.signal.addEventListener("abort", onAbort, { once: true });
  const selected: string[] = [];
  let lineNumber = 0;
  let chars = 0;
  let truncated = false;
  try {
    for await (const line of lines) {
      if (line.includes("\0")) return "Binary file.";
      lineNumber += 1;
      if (lineNumber < offset) continue;
      if (selected.length >= limit || chars >= READ_CHAR_LIMIT) {
        truncated = true;
        break;
      }
      const remaining = READ_CHAR_LIMIT - chars;
      selected.push(line.slice(0, remaining));
      chars += Math.min(line.length, remaining) + 1;
      if (line.length > remaining) {
        truncated = true;
        break;
      }
    }
  } finally {
    host.signal.removeEventListener("abort", onAbort);
    lines.close();
    stream.destroy();
  }
  const text = selected.join("\n");
  return truncated ? `${text}\n[truncated]` : text;
}

async function createFile(
  host: WorkspaceHost,
  operation: Extract<ApplyPatchOperation, { type: "create_file" }>,
): Promise<ApplyPatchResult> {
  try {
    host.signal.throwIfAborted();
    const file = await confine(host.cwd, operation.path, "create");
    if (await exists(file)) {
      return { status: "failed", output: "File already exists." };
    }
    const body = applyDiff("", operation.diff, "create");
    await writeNew(file, body);
    return { status: "completed", output: `Created ${operation.path}` };
  } catch (error) {
    return failed(error);
  }
}

async function updateFile(
  host: WorkspaceHost,
  operation: Extract<ApplyPatchOperation, { type: "update_file" }>,
): Promise<ApplyPatchResult> {
  try {
    host.signal.throwIfAborted();
    const source = await confine(host.cwd, operation.path, "edit");
    const mode = (await stat(source)).mode & 0o777;
    const original = await readFile(source, "utf8");
    if (original.includes("\0")) {
      return { status: "failed", output: "Binary file." };
    }
    const next = applyDiff(original, operation.diff, "default");
    if (operation.moveTo === undefined) {
      await replaceFile(source, next, mode);
      return { status: "completed", output: `Updated ${operation.path}` };
    }
    const destination = await confine(host.cwd, operation.moveTo, "create");
    if (destination === source) {
      await replaceFile(source, next, mode);
      return { status: "completed", output: `Updated ${operation.path}` };
    }
    if (await exists(destination)) {
      return { status: "failed", output: "Move target already exists." };
    }
    await writeNew(destination, next, mode);
    try {
      await unlink(source);
    } catch (error) {
      return failed(error);
    }
    return {
      status: "completed",
      output: `Updated ${operation.path} and moved it to ${operation.moveTo}`,
    };
  } catch (error) {
    return failed(error);
  }
}

async function deleteFile(
  host: WorkspaceHost,
  operation: Extract<ApplyPatchOperation, { type: "delete_file" }>,
): Promise<ApplyPatchResult> {
  try {
    host.signal.throwIfAborted();
    const file = await confine(host.cwd, operation.path, "edit");
    await unlink(file);
    return { status: "completed", output: `Deleted ${operation.path}` };
  } catch (error) {
    return failed(error);
  }
}

export function createWorkspaceTools(host: WorkspaceHost) {
  const read = tool({
    name: "read",
    description:
      "Read a UTF-8 text file inside the workspace. Defaults to the first 200 lines.",
    parameters: readParameters,
    needsApproval: false,
    errorFunction: (_context, error) =>
      error instanceof Error ? error.message : String(error),
    execute: (input) => readWorkspace(input, host),
  });
  const shell = shellTool({
    needsApproval: true,
    shell: { run: (action) => runShell(action, host) },
  });
  const editor = {
    createFile: (
      operation: Extract<ApplyPatchOperation, { type: "create_file" }>,
    ) => createFile(host, operation),
    updateFile: (
      operation: Extract<ApplyPatchOperation, { type: "update_file" }>,
    ) => updateFile(host, operation),
    deleteFile: (
      operation: Extract<ApplyPatchOperation, { type: "delete_file" }>,
    ) => deleteFile(host, operation),
  };
  const applyPatch = applyPatchTool({ editor, needsApproval: true });
  return { read, shell, applyPatch };
}
