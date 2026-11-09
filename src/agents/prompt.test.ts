import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const ptyScript = join(root, "src/agents/prompt.pty.py");
const directories: string[] = [];

const program = `import { readBuiltinLimit, readInteractive, readSetup } from "./src/agents/prompt.ts";
const plan = JSON.parse(process.env.PROMPT_PLAN ?? "[]");
const records = [];
for (const step of plan) {
  try {
    const value = step.op === "setup"
      ? await readSetup(step.text ?? "")
      : step.op === "limit"
        ? await readBuiltinLimit()
        : await readInteractive(step.lines ?? "single");
    records.push({ value });
  } catch (error) {
    records.push({ error: error.name });
  }
}
console.log("RECORD " + JSON.stringify(records));
`;

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function session(): Promise<{ home: string; config: string }> {
  const home = await mkdtemp(join(tmpdir(), "lean-prompt-"));
  directories.push(home);
  const config = join(home, "config");
  await mkdir(config, { recursive: true });
  return { home, config };
}

function recordsOf(output: string): { value?: string; error?: string }[] {
  const line = output.match(/RECORD (\[.*\])/);
  if (!line?.[1]) throw new Error(output);
  return JSON.parse(line[1]) as {
    value?: string;
    error?: string;
  }[];
}

function runPipe(
  runtime: string,
  plan: { op: string; lines?: string; text?: string }[],
  input: Buffer,
  config: string,
  home: string,
): Promise<{ code: number | null; output: string; error: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime, ["-e", program], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        MSWEA_GLOBAL_CONFIG_DIR: config,
        PROMPT_PLAN: JSON.stringify(plan),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let error = "";
    const timer = setTimeout(() => {
      child.kill();
    }, 4000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      error += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, error });
    });
    child.stdin.end(input);
  });
}

type PtyStep =
  | ["sleep", number]
  | ["write", string]
  | ["bytes", number[]]
  | ["signal", string];

function runPty(
  runtime: string,
  plan: { op: string; lines?: string; text?: string }[],
  steps: PtyStep[],
  config: string,
  home: string,
  options: { cols?: number; timeout?: number } = {},
): Promise<{
  code: number | null;
  killed: boolean;
  restored: boolean;
  output: string;
}> {
  const spec = {
    argv: [runtime, "-e", program],
    cwd: root,
    cols: options.cols ?? 80,
    timeout: options.timeout ?? 4,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      MSWEA_GLOBAL_CONFIG_DIR: config,
      PROMPT_PLAN: JSON.stringify(plan),
    },
    steps,
  };
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [ptyScript], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let error = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      error += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(error || output || `pty helper exited ${code}`));
        return;
      }
      resolve(
        JSON.parse(output) as {
          code: number | null;
          killed: boolean;
          restored: boolean;
          output: string;
        },
      );
    });
    child.stdin.end(JSON.stringify(spec));
  });
}

test.for(["node", "bun"])(
  "pipe lines, delimiters, and eof match on %s",
  { timeout: 20000 },
  async (runtime) => {
    const cases: [
      Buffer,
      { op: string; lines?: string }[],
      { value?: string; error?: string }[],
    ][] = [
      [
        Buffer.from("kept\r\n"),
        [{ op: "interactive" }, { op: "interactive" }, { op: "interactive" }],
        [{ value: "kept" }, { value: "" }, { error: "EOFError" }],
      ],
      [Buffer.from("kept\r"), [{ op: "interactive" }], [{ value: "kept" }]],
      [Buffer.from(" "), [{ op: "interactive" }], [{ error: "EOFError" }]],
      [Buffer.alloc(0), [{ op: "interactive" }], [{ error: "EOFError" }]],
      [Buffer.from(" \n"), [{ op: "interactive" }], [{ value: " " }]],
      [
        Buffer.from("a\nb\n"),
        [{ op: "interactive" }, { op: "interactive" }],
        [{ value: "a" }, { value: "b" }],
      ],
      [Buffer.from("abc"), [{ op: "interactive" }], [{ error: "EOFError" }]],
      [
        Buffer.from("abc\u0001\u0004\r"),
        [{ op: "interactive" }],
        [{ value: "bc" }],
      ],
      [
        Buffer.from("\u0003stop\n"),
        [{ op: "interactive" }, { op: "interactive" }],
        [{ error: "KeyboardInterrupt" }, { value: "stop" }],
      ],
      [
        Buffer.from("\u001b[200~a\r\nb\u001b[201~\r"),
        [{ op: "interactive" }],
        [{ value: "a\nb" }],
      ],
      [Buffer.from("3\r\n"), [{ op: "limit" }], [{ value: "3\r" }]],
      [Buffer.from("3"), [{ op: "limit" }], [{ value: "3" }]],
      [Buffer.alloc(0), [{ op: "limit" }], [{ error: "EOFError" }]],
    ];
    for (const [input, plan, expected] of cases) {
      const { home, config } = await session();
      const result = await runPipe(runtime, plan, input, config, home);
      expect(result.error, result.error).toBe("");
      expect(result.code, result.output).toBe(0);
      expect(recordsOf(result.output)).toEqual(expected);
    }
  },
);

test("a terminal prompt restores the tty and exits without being killed", async () => {
  const { home, config } = await session();
  const result = await runPty(
    "node",
    [{ op: "interactive" }],
    [["write", "hello\r"]],
    config,
    home,
  );
  expect(result.killed).toBe(false);
  expect(result.code).toBe(0);
  expect(result.restored).toBe(true);
  expect(recordsOf(result.output)).toEqual([{ value: "hello" }]);
  expect(result.output).toContain("hello");
}, 15000);

test("multiline enter does not submit and the escape clocks accept then expire", async () => {
  const together = await session();
  const coalesced = await runPty(
    "node",
    [{ op: "interactive", lines: "multiline" }],
    [["write", "hello\u001b\r"]],
    together.config,
    together.home,
  );
  expect(coalesced.killed).toBe(false);
  expect(recordsOf(coalesced.output)).toEqual([{ value: "hello" }]);

  const early = await session();
  const accepted = await runPty(
    "node",
    [{ op: "interactive", lines: "multiline" }],
    [
      ["write", "hello"],
      ["sleep", 0.2],
      ["write", "\u001b"],
      ["sleep", 1.2],
      ["write", "\r"],
    ],
    early.config,
    early.home,
    { timeout: 5 },
  );
  expect(accepted.killed).toBe(false);
  expect(recordsOf(accepted.output)).toEqual([{ value: "hello" }]);

  const late = await session();
  const open = await runPty(
    "node",
    [{ op: "interactive", lines: "multiline" }],
    [
      ["write", "hello"],
      ["sleep", 0.1],
      ["write", "\u001b"],
      ["sleep", 1.7],
      ["write", "\r"],
      ["sleep", 0.3],
      ["write", "\u001b\r"],
    ],
    late.config,
    late.home,
    { timeout: 6 },
  );
  expect(open.killed).toBe(false);
  expect(recordsOf(open.output)).toEqual([{ value: "hello\n" }]);
}, 20000);

test("typeahead up runs before history load and a later up recalls", async () => {
  const immediate = await session();
  const ahead = await runPty(
    "node",
    [{ op: "interactive" }, { op: "interactive" }],
    [["write", "kept\r\u001b[A\r"]],
    immediate.config,
    immediate.home,
  );
  expect(ahead.killed).toBe(false);
  expect(recordsOf(ahead.output)).toEqual([{ value: "kept" }, { value: "" }]);

  const delayed = await session();
  const recalled = await runPty(
    "node",
    [{ op: "interactive" }, { op: "interactive" }],
    [
      ["write", "kept\r"],
      ["sleep", 0.2],
      ["write", "\u001b[A\r"],
    ],
    delayed.config,
    delayed.home,
  );
  expect(recalled.killed).toBe(false);
  expect(recordsOf(recalled.output)).toEqual([
    { value: "kept" },
    { value: "kept" },
  ]);
}, 15000);

test("search, arrows, and ctrl-d behave on a terminal", async () => {
  const { home, config } = await session();
  await writeFile(
    join(config, "interactive_history.txt"),
    "\n# 2020-01-01 00:00:00.000000\n+one\n\n# 2020-01-02 00:00:00.000000\n+two\n\n# 2020-01-03 00:00:00.000000\n+other\n",
  );
  const hit = await runPty(
    "node",
    [{ op: "interactive" }],
    [["write", "\u0012o\r\r"]],
    config,
    home,
  );
  expect(recordsOf(hit.output)).toEqual([{ value: "other" }]);
  const miss = await runPty(
    "node",
    [{ op: "interactive" }],
    [["write", "draft\u0012zz\r\r"]],
    config,
    home,
  );
  expect(recordsOf(miss.output)).toEqual([{ value: "draft" }]);
  const column = await runPty(
    "node",
    [{ op: "interactive" }],
    [["bytes", [0x61, 0x62, 0x63, 0x01, 0x04, 0x0d]]],
    config,
    home,
  );
  expect(recordsOf(column.output)).toEqual([{ value: "bc" }]);
  const arrow = await session();
  await writeFile(
    join(arrow.config, "interactive_history.txt"),
    "\n# 2020-01-02 00:00:00.000000\n+newer\n",
  );
  const split = await runPty(
    "node",
    [{ op: "interactive" }],
    [
      ["bytes", [0x1b]],
      ["sleep", 0.05],
      ["bytes", [0x5b, 0x41, 0x0d]],
    ],
    arrow.config,
    arrow.home,
  );
  expect(recordsOf(split.output)).toEqual([{ value: "newer" }]);
}, 15000);

test("setup edits a default without writing interactive history", async () => {
  const { home, config } = await session();
  const result = await runPty(
    "node",
    [{ op: "setup", text: "claude" }],
    [["write", "\u001b[Dx\r"]],
    config,
    home,
  );
  expect(result.killed).toBe(false);
  expect(recordsOf(result.output)).toEqual([{ value: "claudxe" }]);
  await expect(
    readFile(join(config, "interactive_history.txt"), "utf8"),
  ).rejects.toThrow();
}, 15000);

test("builtin tty reads one cooked delimiter and an external interrupt is keyboard interrupt", async () => {
  const limits = await session();
  const cooked = await runPty(
    "node",
    [{ op: "limit" }, { op: "limit" }],
    [["write", "\r\n"]],
    limits.config,
    limits.home,
  );
  expect(cooked.killed).toBe(false);
  expect(recordsOf(cooked.output)).toEqual([{ value: "" }, { value: "" }]);

  const interrupted = await session();
  const result = await runPty(
    "node",
    [{ op: "interactive", lines: "multiline" }],
    [
      ["sleep", 0.2],
      ["signal", "SIGINT"],
    ],
    interrupted.config,
    interrupted.home,
  );
  expect(result.killed).toBe(false);
  expect(result.code).toBe(0);
  expect(recordsOf(result.output)).toEqual([{ error: "KeyboardInterrupt" }]);
}, 15000);

test("wide characters and a split utf-8 character survive the terminal", async () => {
  const wide = await session();
  const wrapped = await runPty(
    "node",
    [{ op: "interactive" }],
    [["write", "你好XY\r"]],
    wide.config,
    wide.home,
    { cols: 6 },
  );
  expect(recordsOf(wrapped.output)).toEqual([{ value: "你好XY" }]);
  expect(wrapped.output).toContain("\r\n");

  const utf = await session();
  const character = await runPty(
    "node",
    [{ op: "interactive" }],
    [
      ["bytes", [0xc3]],
      ["sleep", 0.05],
      ["bytes", [0xa9, 0xff, 0x0d]],
    ],
    utf.config,
    utf.home,
  );
  const value = recordsOf(character.output)[0]?.value ?? "";
  expect(Array.from(value).map((char) => char.codePointAt(0))).toEqual([
    0xe9, 0xdcff,
  ]);
}, 15000);
