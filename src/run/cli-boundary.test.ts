import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const seen = vi.hoisted(() => ({
  modelName: undefined as unknown,
  costLimit: undefined as unknown,
  task: undefined as unknown,
  prompted: 0,
  setup: [] as string[],
}));

vi.mock("../models/index.ts", () => ({
  getModel: (_name: unknown, config: { model_name?: unknown }) => {
    seen.modelName = config.model_name;
    return {
      config: {},
      query: () => ({ role: "assistant", extra: { actions: [] } }),
      format_message: (message: unknown) => message,
      format_observation_messages: () => [],
      get_template_vars: () => ({}),
      serialize: () => ({}),
    };
  },
}));

vi.mock("../environments/index.ts", () => ({
  getEnvironment: () => ({
    config: {},
    execute: () => ({ output: "", returncode: 0, exception_info: "" }),
    get_template_vars: () => ({}),
    serialize: () => ({}),
  }),
}));

vi.mock("../agents/index.ts", () => ({
  getAgent: (
    _model: unknown,
    _env: unknown,
    config: { cost_limit?: unknown },
  ) => {
    seen.costLimit = config.cost_limit;
    return {
      run: async (task: string) => {
        seen.task = task;
        return {};
      },
    };
  },
}));

vi.mock("../agents/prompt.ts", () => ({
  readInteractive: async () => {
    seen.prompted += 1;
    return "from-prompt";
  },
  readSetup: async () => seen.setup.shift() ?? "",
}));

import { main } from "./mini.ts";

const directories: string[] = [];

beforeEach(() => {
  seen.modelName = undefined;
  seen.costLimit = undefined;
  seen.task = undefined;
  seen.prompted = 0;
  seen.setup = [];
  vi.stubEnv("MSWEA_CONFIGURED", "1");
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(async () => {
  delete (process.stdin as { isTTY?: boolean }).isTTY;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function directory(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "lean-cli-"));
  directories.push(created);
  vi.stubEnv("MSWEA_GLOBAL_CONFIG_DIR", created);
  return created;
}

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value,
  });
}

test("loads MSWEA_MINI_CONFIG_PATH when -c is omitted", async () => {
  const root = await directory();
  const config = join(root, "picked.yaml");
  await writeFile(
    config,
    `run:
  task: from-file
model:
  model_name: from-env-config
`,
  );
  vi.stubEnv("MSWEA_MINI_CONFIG_PATH", config);
  expect(await main([])).toBe(0);
  expect(seen.modelName).toBe("from-env-config");
  expect(seen.task).toBe("from-file");
  expect(seen.prompted).toBe(0);
});

test("uses a configured empty task instead of prompting", async () => {
  const root = await directory();
  const config = join(root, "empty.yaml");
  await writeFile(
    config,
    `run:
  task: ""
model:
  model_name: m
`,
  );
  expect(await main(["-c", config])).toBe(0);
  expect(seen.task).toBe("");
  expect(seen.prompted).toBe(0);
});

test("prompts only when the task is unset", async () => {
  const root = await directory();
  const config = join(root, "missing.yaml");
  await writeFile(
    config,
    `model:
  model_name: m
`,
  );
  expect(await main(["-c", config])).toBe(0);
  expect(seen.task).toBe("from-prompt");
  expect(seen.prompted).toBe(1);
});

test("prints help before first-time setup", async () => {
  const root = await directory();
  vi.stubEnv("MSWEA_CONFIGURED", "");
  setTty(true);
  seen.setup = ["anthropic/claude", "GEMINI_API_KEY", "secret"];
  expect(await main(["--help"])).toBe(0);
  expect(seen.setup).toEqual(["anthropic/claude", "GEMINI_API_KEY", "secret"]);
  expect(String(vi.mocked(process.stdout.write).mock.calls[0]?.[0])).toContain(
    "Usage:",
  );
  await expect(readFile(join(root, ".env"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("persists setup with the requested key name and configured flag", async () => {
  const root = await directory();
  const config = join(root, "run.yaml");
  await writeFile(
    config,
    `run:
  task: go
model:
  model_name: m
`,
  );
  vi.stubEnv("MSWEA_CONFIGURED", "");
  setTty(true);
  seen.setup = ["anthropic/claude", "GEMINI_API_KEY", "secret"];
  expect(await main(["-c", config])).toBe(0);
  const saved = await readFile(join(root, ".env"), "utf8");
  expect(saved).toContain("MSWEA_MODEL_NAME=anthropic/claude");
  expect(saved).toContain("GEMINI_API_KEY=secret");
  expect(saved).toContain("MSWEA_CONFIGURED=true");
  expect(saved).not.toContain("OPENAI_API_KEY");
  expect(process.env.MSWEA_CONFIGURED).toBe("true");
});

test("rejects a non-finite or non-Python cost limit", async () => {
  await directory();
  expect(await main(["-t", "task", "-l", "nope"])).toBe(1);
  expect(process.stderr.write).toHaveBeenCalledWith(
    "could not convert string to float: 'nope'\n",
  );
  expect(seen.task).toBeUndefined();

  vi.mocked(process.stderr.write).mockClear();
  expect(await main(["-t", "task", "-l", "nan"])).toBe(1);
  expect(process.stderr.write).toHaveBeenCalledWith(
    "Invalid cost limit: nan\n",
  );
  expect(await main(["-t", "task", "-l", "0x10"])).toBe(1);
  expect(await main(["-t", "task", "-l", "10_000"])).toBe(0);
  expect(seen.costLimit).toBe(10000);
});
