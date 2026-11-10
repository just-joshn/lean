import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { Submitted } from "../exceptions.ts";
import { LocalEnvironment } from "./local.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("LocalEnvironment", () => {
  test("runs a fresh shell and keeps a nonzero exit as an observation", async () => {
    const env = new LocalEnvironment();
    const result = await env.execute({ command: "echo hello" });
    expect(result.returncode).toBe(0);
    expect(result.output).toContain("hello");
    const failed = await env.execute({ command: "exit 1" });
    expect(failed.returncode).toBe(1);
    expect(failed.exception_info).toBe("");
  });

  test("merges stderr into stdout in write order and overrides env and cwd per call", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lean-env-"));
    directories.push(directory);
    const env = new LocalEnvironment({
      cwd: "/",
      env: { FROM_CONFIG: "config" },
    });
    const result = await env.execute(
      { command: 'echo OUT; echo ERR >&2; echo "$FROM_CONFIG"; pwd' },
      directory,
    );
    expect(result.output).toBe(
      `OUT\nERR\nconfig\n${realpathSync(directory)}\n`,
    );
  });

  test("returns partial output and kills descendant processes on timeout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lean-timeout-"));
    directories.push(directory);
    const pidFile = join(directory, "child.pid");
    const script = join(directory, "child.mjs");
    await writeFile(
      script,
      `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
`,
    );
    const env = new LocalEnvironment({ timeout: 1 });
    const result = await env.execute({
      command: `echo partial; exec node ${JSON.stringify(script)} ${JSON.stringify(pidFile)}`,
    });
    expect(result.returncode).toBe(-1);
    expect(result.output).toContain("partial");
    expect(result.exception_info).toContain("timed out");
    expect(result.extra?.exception_type).toBe("TimeoutExpired");
    const pid = Number(await readFile(pidFile, "utf8"));
    let exited = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        process.kill(pid, 0);
      } catch {
        exited = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(exited).toBe(true);
  });

  test("submits only a zero exit whose first stripped line is the sentinel", async () => {
    const env = new LocalEnvironment();
    await expect(
      env.execute({
        command:
          "printf 'COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT\\nbody line\\n'",
      }),
    ).rejects.toMatchObject({
      messages: [
        { extra: { exit_status: "Submitted", submission: "body line\n" } },
      ],
    });
    const nonzero = await env.execute({
      command:
        "printf 'COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT\\nbody\\n'; exit 2",
    });
    expect(nonzero.returncode).toBe(2);
    expect(nonzero).not.toBeInstanceOf(Submitted);
  });
});
