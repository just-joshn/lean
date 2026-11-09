import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { FileHistory } from "./prompt/history.ts";
import { Utf8Decoder } from "./prompt/parser.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const directories: string[] = [];

const program = `import { readInteractive } from ${JSON.stringify(join(root, "src/agents/prompt.ts"))};
const count = Number(process.env.COUNT ?? "1");
for (let n = 0; n < count; n += 1) {
  try {
    const value = await readInteractive("single");
    console.log("RECORD=" + JSON.stringify({ points: Array.from(value, (char) => char.codePointAt(0)) }));
  } catch (error) {
    console.log("RECORD=" + JSON.stringify({ error: error.name }));
  }
}
`;

type Packet = { points: number[] } | { error: string };

type ReadCase = {
  name: string;
  input: Buffer;
  count: number;
  records: Packet[];
  plus?: string[];
  reload?: Packet[];
};

const cases: ReadCase[] = [
  {
    name: "backspace deletes an emoji",
    input: Buffer.from("\u{1f600}\u007f\r"),
    count: 1,
    records: [{ points: [] }],
  },
  {
    name: "backspace after left deletes the emoji and leaves a",
    input: Buffer.from("\u{1f600}a\u001b[D\u007f\r"),
    count: 1,
    records: [{ points: [0x61] }],
  },
  {
    name: "backspace between x and an emoji deletes x",
    input: Buffer.from("x\u{1f600}\u001b[D\u007f\r"),
    count: 1,
    records: [{ points: [0x1f600] }],
  },
  {
    name: "backspace deletes a combining mark and leaves the base",
    input: Buffer.from("e\u0301\u007f\r"),
    count: 1,
    records: [{ points: [0x65] }],
  },
  {
    name: "backspace deletes one code point of a zwj sequence",
    input: Buffer.from("\u{1f468}\u200d\u{1f469}\u007f\r"),
    count: 1,
    records: [{ points: [0x1f468, 0x200d] }],
  },
  {
    name: "carriage return and line feed accept as two enters",
    input: Buffer.from("kept\r\n"),
    count: 2,
    records: [{ points: [0x6b, 0x65, 0x70, 0x74] }, { points: [] }],
  },
  {
    name: "a bracketed paste keeps an internal newline",
    input: Buffer.from("\u001b[200~ab\r\ncd\u001b[201~\r"),
    count: 1,
    records: [{ points: [0x61, 0x62, 0x0a, 0x63, 0x64] }],
  },
  {
    name: "an invalid byte stays accepted and reloads as a question mark",
    input: Buffer.from([0xff, 0x0d]),
    count: 1,
    records: [{ points: [0xdcff] }],
    plus: ["3f"],
    reload: [{ points: [0x3f] }],
  },
  {
    name: "a bad continuation stays accepted and reloads as question marks",
    input: Buffer.from([0xe0, 0x80, 0x0d]),
    count: 1,
    records: [{ points: [0xdce0, 0xdc80] }],
    plus: ["3f3f"],
    reload: [{ points: [0x3f, 0x3f] }],
  },
  {
    name: "a supplementary character reloads as the same character",
    input: Buffer.from("\u{1f600}\r"),
    count: 1,
    records: [{ points: [0x1f600] }],
    plus: ["f09f9880"],
    reload: [{ points: [0x1f600] }],
  },
  {
    name: "a repeated line is stored once",
    input: Buffer.from("same\rsame\r"),
    count: 2,
    records: [
      { points: [0x73, 0x61, 0x6d, 0x65] },
      { points: [0x73, 0x61, 0x6d, 0x65] },
    ],
    plus: ["73616d65"],
  },
  {
    name: "empty input at eof is an error and not an accepted empty line",
    input: Buffer.alloc(0),
    count: 1,
    records: [{ error: "EOFError" }],
  },
];

async function ownedHome(): Promise<{
  home: string;
  config: string;
  bin: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "lean-unicode-"));
  directories.push(home);
  const config = join(home, "config");
  const bin = join(home, "bin");
  await mkdir(join(home, "home"), { recursive: true });
  await mkdir(config, { recursive: true });
  await mkdir(join(home, "tmp"), { recursive: true });
  await mkdir(join(home, "cache"), { recursive: true });
  await mkdir(bin, { recursive: true });
  return { home, config, bin };
}

function packets(output: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith("RECORD=")) continue;
    const value: unknown = JSON.parse(line.slice(7));
    rows.push(value);
  }
  return rows;
}

async function readPackets(
  input: Buffer,
  count: number,
  place: { home: string; config: string; bin: string },
): Promise<unknown[]> {
  const script = join(place.home, "tmp", "read.mts");
  await writeFile(script, program);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: {
        PATH: place.bin,
        HOME: join(place.home, "home"),
        TMPDIR: join(place.home, "tmp"),
        XDG_CONFIG_HOME: place.config,
        XDG_CACHE_HOME: join(place.home, "cache"),
        MSWEA_GLOBAL_CONFIG_DIR: place.config,
        MSWEA_CONFIGURED: "true",
        MSWEA_SILENT_STARTUP: "1",
        PYTHON_DOTENV_DISABLED: "1",
        TERM: "dumb",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        COUNT: String(count),
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
      if (code !== 0) {
        reject(new Error(error || output || `runner exited ${code}`));
        return;
      }
      resolve(packets(output));
    });
    child.stdin.end(input);
  });
}

function plusPayloads(raw: Buffer): string[] {
  const payloads: string[] = [];
  let rest = raw;
  while (rest.length) {
    const newline = rest.indexOf(0x0a);
    const line = newline === -1 ? rest : rest.subarray(0, newline);
    rest = newline === -1 ? Buffer.alloc(0) : rest.subarray(newline + 1);
    if (line[0] === 0x2b) payloads.push(line.subarray(1).toString("hex"));
  }
  return payloads;
}

test("a split four-byte sequence stays one code point and a bad continuation stays two surrogates", () => {
  const decoder = new Utf8Decoder();
  expect(decoder.decode(Uint8Array.from([0xf0, 0x9f]))).toBe("");
  expect(
    Array.from(decoder.decode(Uint8Array.from([0x98, 0x80])), (char) =>
      char.codePointAt(0),
    ),
  ).toEqual([0x1f600]);
  const broken = new Utf8Decoder();
  expect(
    Array.from(broken.decode(Uint8Array.from([0xe0, 0x80])), (char) =>
      char.codePointAt(0),
    ),
  ).toEqual([0xdce0, 0xdc80]);
});

test("file history keeps the accepted text and writes replaced bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lean-history-bytes-"));
  directories.push(directory);
  const path = join(directory, "interactive_history.txt");
  const accepted = `${String.fromCodePoint(0xdcff)}\n\u{1f600}`;
  const history = new FileHistory(path);
  history.append(accepted);
  history.append(accepted);
  history.append("older");
  expect(history.newestFirst()).toEqual(["older", accepted]);
  const raw = await readFile(path);
  expect(raw.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
  expect(plusPayloads(raw)).toEqual(["3f", "f09f9880", "6f6c646572"]);
  expect(new FileHistory(path).newestFirst()).toEqual([
    "older",
    `?\n${String.fromCodePoint(0x1f600)}`,
  ]);
});

test.for(cases)(
  "$name",
  { timeout: 15000 },
  async ({ input, count, records, plus, reload }) => {
    const place = await ownedHome();
    expect(await readPackets(input, count, place)).toEqual(records);
    if (plus) {
      expect(
        plusPayloads(
          await readFile(join(place.config, "interactive_history.txt")),
        ),
      ).toEqual(plus);
    }
    if (reload) {
      expect(await readPackets(Buffer.from("\u001b[A\r"), 1, place)).toEqual(
        reload,
      );
    }
  },
);

test.afterAll(async () => {
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});
