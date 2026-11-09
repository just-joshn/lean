import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DockerEnvironment } from "./docker.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DockerEnvironment", () => {
  test("starts one container and execs each action with the configured interpreter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lean-docker-"));
    directories.push(directory);
    const record = join(directory, "record.txt");
    const executable = join(directory, "docker");
    await writeFile(
      executable,
      `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(record)}
printf '\\n' >> ${JSON.stringify(record)}
if [ "$1" = "run" ]; then
  echo cid-test
  exit 0
fi
if [ "$1" = "exec" ]; then
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      -e) shift; export "$1"; shift ;;
      -w) shift; shift ;;
      -*) shift ;;
      *) break ;;
    esac
  done
  shift
  last=""
  for arg in "$@"; do last=$arg; done
  eval "$last"
  exit $?
fi
exit 0
`,
      { mode: 0o755 },
    );
    const env = new DockerEnvironment({
      image: "python:3.11",
      executable,
      env: { FROM_CONFIG: "inside" },
      forward_env: ["FROM_HOST"],
      cwd: "/work",
    });
    expect(env.container_id).toBe("cid-test");
    const previous = process.env.FROM_HOST;
    process.env.FROM_HOST = "host-value";
    try {
      const result = await env.execute({
        command: 'printf \'%s %s\' "$FROM_HOST" "$FROM_CONFIG"',
      });
      expect(result.returncode).toBe(0);
      expect(result.output).toBe("host-value inside");
    } finally {
      if (previous === undefined) delete process.env.FROM_HOST;
      else process.env.FROM_HOST = previous;
    }
    env.cleanup();
    let recorded = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      recorded = await readFile(record, "utf8");
      if (recorded.includes("stop")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(recorded).toContain("run");
    expect(recorded).toContain("python:3.11");
    expect(recorded).toContain("--rm");
    expect(recorded).toContain("exec");
    expect(recorded).toContain("-w");
    expect(recorded).toContain("/work");
    expect(recorded).toContain("cid-test");
    expect(recorded).toContain("bash");
    expect(recorded).toContain("-lc");
    expect(recorded).toContain("stop");
  });
});
