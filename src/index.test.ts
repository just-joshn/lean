import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  DefaultAgent,
  DockerEnvironment,
  InteractiveAgent,
  KeyboardInterrupt,
  LitellmModel,
  LitellmTextbasedModel,
  LocalEnvironment,
} from "./index.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function runCli(
  args: string[],
  env: Record<string, string>,
  input = "",
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["src/index.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe("lean executable", () => {
  test("importing the public components does not start a run", () => {
    expect(DefaultAgent).toBeTypeOf("function");
    expect(InteractiveAgent).toBeTypeOf("function");
    expect(LitellmModel).toBeTypeOf("function");
    expect(LitellmTextbasedModel).toBeTypeOf("function");
    expect(LocalEnvironment).toBeTypeOf("function");
    expect(DockerEnvironment).toBeTypeOf("function");
    expect(new KeyboardInterrupt().name).toBe("KeyboardInterrupt");
  });

  test("confirms a command by default and saves a submitted trajectory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lean-cli-"));
    directories.push(directory);
    const output = join(directory, "run.traj.json");
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: "done",
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments:
                          '{"command":"echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"}',
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 5 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    try {
      const result = await runCli(
        [
          "-m",
          "gpt-4o",
          "-t",
          "finish",
          "-o",
          output,
          "-c",
          "mini.yaml",
          "-c",
          `model.model_kwargs.api_base=http://127.0.0.1:${address.port}/v1`,
        ],
        {
          MSWEA_CONFIGURED: "1",
          MSWEA_GLOBAL_CONFIG_DIR: directory,
          MSWEA_SILENT_STARTUP: "1",
        },
        "\n\n",
      );
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      const saved = JSON.parse(await readFile(output, "utf8")) as {
        info: { exit_status: string };
      };
      expect(saved.info.exit_status).toBe("Submitted");
      expect(result.stdout).toContain("Execute 1 action(s)?");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
