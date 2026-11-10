import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { EOFError } from "../../exceptions.ts";
import { PromptEditor } from "./editor.ts";
import {
  formatImplicitContext,
  implicitContext,
  replacement,
  takeAsyncDiagnostics,
} from "./context.ts";
import { readInteractive, readSetup } from "./feed.ts";
import { PromptFrame } from "./frame.ts";

const savedPath = fileURLToPath(
  new URL("./read-lifecycle-cases.jsonl", import.meta.url),
);

type SavedError = {
  readonly identity: string;
  readonly cause: null;
};

type SavedRow = {
  readonly flags: {
    readonly body: boolean;
    readonly done: boolean;
    readonly reset: boolean;
    readonly detach: boolean;
    readonly raw: boolean;
  };
  readonly winner: string;
  readonly value: string | null;
  readonly chain: readonly SavedError[];
  readonly label: string;
};

const WARNING =
  "WARNING: your terminal doesn't support cursor position requests (CPR).\r\n";

const rows: SavedRow[] = readFileSync(savedPath, "utf8")
  .trimEnd()
  .split("\n")
  .map((line) => {
    const row = JSON.parse(line) as Omit<SavedRow, "label">;
    const label = [
      row.flags.body,
      row.flags.done,
      row.flags.reset,
      row.flags.detach,
      row.flags.raw,
    ]
      .map((flag) => (flag ? "1" : "0"))
      .join("");
    return { ...row, label };
  });

type Listener = (chunk: Buffer) => void;

class FakeInput {
  isTTY = true;
  isRaw = false;
  readableEnded = false;
  private data = new Set<Listener>();
  private end = new Set<() => void>();
  events: string[] = [];
  timeline: string[] = [];
  detachFault = false;
  rawFault = false;
  armed = false;

  on(event: string, listener: Listener | (() => void)): this {
    if (event === "data") this.data.add(listener as Listener);
    if (event === "end") this.end.add(listener as () => void);
    return this;
  }

  off(event: string, listener: Listener | (() => void)): this {
    if (event === "data") {
      this.events.push("detach-exit");
      this.timeline.push("detach-exit");
      if (this.armed && this.detachFault) throw this.sentinel("detach");
      this.data.delete(listener as Listener);
    }
    if (event === "end") this.end.delete(listener as () => void);
    return this;
  }

  setRawMode(on: boolean): this {
    if (!on) {
      this.events.push("raw-exit");
      this.timeline.push("raw-exit");
      if (this.armed && this.rawFault) throw this.sentinel("raw");
    }
    this.isRaw = on;
    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }

  emitData(chunk: Buffer): void {
    for (const listener of [...this.data]) listener(chunk);
  }

  emitEnd(): void {
    for (const listener of [...this.end]) listener();
  }

  private sentinels = new Map<string, Error>();

  sentinel(label: string): Error {
    const existing = this.sentinels.get(label);
    if (existing) return existing;
    const error = new Error(label);
    this.sentinels.set(label, error);
    return error;
  }
}

class FakeOutput {
  columns = 80;
  rows = 24;
  isTTY = true;
  chunks: string[] = [];
  events: string[] = [];
  timeline: string[] = [];
  armed = false;
  doneFault = false;
  resetFault = false;
  openFault: Error | undefined;
  warningFault: Error | undefined;
  private doneThrown = false;
  private doneSeen = false;
  pasteOffs = 0;
  private resize = new Set<() => void>();

  on(event: string, listener: () => void): this {
    if (event === "resize") this.resize.add(listener);
    return this;
  }

  off(event: string, listener: () => void): this {
    if (event === "resize") this.resize.delete(listener);
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    if (this.openFault && chunk.includes("\x1b[?2004h")) throw this.openFault;
    if (this.warningFault && chunk === WARNING) throw this.warningFault;
    if (!this.armed) return true;
    const resetByte =
      chunk === "\x1b[?2004l" ||
      chunk === "\x1b[0 q" ||
      chunk === "\x1b[?12l\x1b[?25h";
    if (!resetByte && !this.doneSeen) {
      this.doneSeen = true;
      this.events.push("done-paint");
      this.timeline.push("done-paint");
      if (this.doneFault && !this.doneThrown) {
        this.doneThrown = true;
        throw this.sentinel("done");
      }
    }
    if (chunk === "\x1b[?2004l") {
      this.pasteOffs += 1;
      if (this.resetFault) throw this.sentinel(`reset-${this.pasteOffs}`);
    }
    return true;
  }

  private sentinels = new Map<string, Error>();

  sentinel(label: string): Error {
    const existing = this.sentinels.get(label);
    if (existing) return existing;
    const error = new Error(label);
    this.sentinels.set(label, error);
    return error;
  }
}

let installed:
  | {
      input: FakeInput;
      output: FakeOutput;
      stdin: PropertyDescriptor;
      stdout: PropertyDescriptor;
    }
  | undefined;

function install(
  inputTty = true,
  outputTty = true,
): {
  input: FakeInput;
  output: FakeOutput;
} {
  const input = new FakeInput();
  const output = new FakeOutput();
  input.isTTY = inputTty;
  output.isTTY = outputTty;
  installed = {
    input,
    output,
    stdin: Object.getOwnPropertyDescriptor(process, "stdin")!,
    stdout: Object.getOwnPropertyDescriptor(process, "stdout")!,
  };
  Object.defineProperty(process, "stdin", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: input,
  });
  Object.defineProperty(process, "stdout", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: output,
  });
  return { input, output };
}

function restore(): void {
  if (!installed) return;
  Object.defineProperty(process, "stdin", installed.stdin);
  Object.defineProperty(process, "stdout", installed.stdout);
  installed = undefined;
}

afterEach(() => {
  restore();
  takeAsyncDiagnostics();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function stubReader(cpr: boolean): void {
  vi.stubEnv("TERM", "xterm");
  vi.stubEnv("PROMPT_TOOLKIT_NO_CPR", cpr ? "" : "1");
  vi.stubEnv("PROMPT_TOOLKIT_COLOR_DEPTH", "DEPTH_8_BIT");
  vi.stubEnv("NO_COLOR", "");
}

async function started(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function described(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

test("frozen errors keep identity without cause, self-links, or cycles", () => {
  const same = Object.freeze(new Error("same"));
  const first = replacement(same, undefined);
  expect(replacement(same, first)).toBe(first);
  expect(implicitContext(same)).toEqual([same]);
  expect(Object.isFrozen(same)).toBe(true);
  expect(Object.getOwnPropertySymbols(same)).toEqual([]);
  expect(same.cause).toBeUndefined();

  const early = Object.freeze(new Error("early"));
  const mid = Object.freeze(new Error("mid"));
  const late = Object.freeze(new Error("late"));
  replacement(late, replacement(mid, replacement(early, undefined)));
  expect(implicitContext(late)).toEqual([late, mid, early]);
  expect(formatImplicitContext(late).indexOf("Error: early")).toBeLessThan(
    formatImplicitContext(late).indexOf("Error: late"),
  );

  const tail = Object.freeze(new Error("tail"));
  replacement(mid, replacement(tail, undefined));
  expect(implicitContext(mid)).toEqual([mid, early, tail]);

  const left = new Error("left");
  const right = new Error("right");
  replacement(right, replacement(left, undefined));
  replacement(left, replacement(right, undefined));
  const chain = implicitContext(left);
  expect(new Set(chain).size).toBe(chain.length);
  expect(chain).toEqual([left, right]);
  expect(replacement("boom", undefined).error).toBe("boom");
});

test.for(rows)(
  "saved $label keeps the recorded winner and context",
  async (row) => {
    stubReader(false);
    const { input, output } = install();
    output.doneFault = row.flags.done;
    output.resetFault = row.flags.reset;
    input.detachFault = row.flags.detach;
    input.rawFault = row.flags.raw;
    const editorErrors: unknown[] = [];
    const push = PromptEditor.prototype.push;
    vi.spyOn(PromptEditor.prototype, "push").mockImplementation(function (
      this: PromptEditor,
      key: Parameters<typeof push>[0],
    ) {
      const outcome = push.call(this, key);
      if (outcome.kind === "error") editorErrors.push(outcome.error);
      return outcome;
    });
    const initial = row.flags.body ? "" : (row.value ?? "");
    const settled = readSetup(initial);
    await started();
    expect(output.chunks.length).toBeGreaterThan(0);
    const timeline: string[] = [];
    output.timeline = timeline;
    input.timeline = timeline;
    output.armed = true;
    input.armed = true;
    input.emitData(row.flags.body ? Buffer.from([0x04]) : Buffer.from("\r"));
    vi.restoreAllMocks();

    const resetCount = row.chain.filter((error) =>
      error.identity.startsWith("reset-"),
    ).length;
    if (row.winner === "value") {
      await expect(settled).resolves.toBe(row.value);
      expect(row.chain).toEqual([]);
    } else {
      const rejection = await settled.then(
        () => {
          throw new Error("expected the saved winner");
        },
        (error: unknown) => error,
      );
      expect(rejection).not.toBeInstanceOf(AggregateError);
      const actual = implicitContext(rejection as object);
      expect(actual).toHaveLength(row.chain.length);
      expect(rejection).toBe(actual[0]);
      row.chain.forEach((expected, index) => {
        const item = actual[index];
        expect(item).not.toBeInstanceOf(AggregateError);
        if (item instanceof Error) expect(item.cause).toBeUndefined();
        if (expected.identity === "body") {
          expect(item).toBeInstanceOf(EOFError);
          expect(item).toBe(editorErrors[0]);
        } else {
          const sentinel =
            expected.identity.startsWith("reset-") ||
            expected.identity === "done"
              ? output.sentinel(expected.identity)
              : input.sentinel(expected.identity);
          expect(item).toBe(sentinel);
        }
        expect(Object.getOwnPropertySymbols(item as object)).toEqual([]);
      });
      expect(row.winner).toBe(row.chain[0]?.identity);
      if (actual.length > 1) {
        const formatted = formatImplicitContext(rejection as object);
        expect(formatted).toContain(
          "During handling of the above exception, another exception occurred:",
        );
        expect(
          formatted.indexOf(described(actual[actual.length - 1])),
        ).toBeLessThan(formatted.lastIndexOf(described(actual[0])));
      }
    }

    expect(timeline.indexOf("done-paint")).toBeGreaterThanOrEqual(0);
    expect(timeline.indexOf("done-paint")).toBeLessThan(
      timeline.indexOf("detach-exit"),
    );
    expect(timeline.indexOf("detach-exit")).toBeLessThan(
      timeline.indexOf("raw-exit"),
    );
    expect(input.events.filter((event) => event === "detach-exit")).toEqual([
      "detach-exit",
    ]);
    expect(input.events.filter((event) => event === "raw-exit")).toEqual([
      "raw-exit",
    ]);
    expect(output.pasteOffs).toBe(resetCount === 0 ? 1 : resetCount);
  },
);

test("the edited reader asks for CPR rather than a readiness marker", async () => {
  vi.useFakeTimers();
  stubReader(true);
  const { input, output } = install();
  const settled = readSetup("kept");
  await started();
  expect(output.chunks).toContain("\x1b[6n");
  expect(output.chunks.join("")).not.toContain("READY");
  input.emitData(Buffer.from("\x1b[1;1R"));
  input.emitData(Buffer.from("\r"));
  await expect(settled).resolves.toBe("kept");
  expect(vi.getTimerCount()).toBe(0);
});

test("a failure of the background wait replaces earlier cleanup errors", async () => {
  stubReader(false);
  const { input, output } = install();
  const wait = new Error("background-wait");
  const cancel = PromptFrame.prototype.cancelCprBackgroundAndWait;
  vi.spyOn(
    PromptFrame.prototype,
    "cancelCprBackgroundAndWait",
  ).mockImplementation(async function (this: PromptFrame) {
    await cancel.call(this);
    input.timeline.push("background-wait");
    throw wait;
  });
  const settled = readSetup("kept");
  await started();
  output.armed = true;
  output.doneFault = true;
  input.armed = true;
  input.detachFault = true;
  input.rawFault = true;
  input.emitData(Buffer.from("\r"));
  await expect(settled).rejects.toBe(wait);
  expect(implicitContext(wait)).toEqual([
    wait,
    input.sentinel("raw"),
    input.sentinel("detach"),
    output.sentinel("done"),
  ]);
  expect(input.timeline).toEqual([
    "detach-exit",
    "raw-exit",
    "background-wait",
  ]);
  expect(takeAsyncDiagnostics()).toEqual([]);
});

test("an open-paint failure skips the done redraw and both resets", async () => {
  stubReader(false);
  const { input, output } = install();
  const open = new Error("open");
  output.openFault = open;
  const settled = readSetup("");
  await expect(settled).rejects.toBe(open);
  expect(output.pasteOffs).toBe(0);
  expect(output.events).not.toContain("done-paint");
  expect(input.events.indexOf("detach-exit")).toBeLessThan(
    input.events.indexOf("raw-exit"),
  );
  expect(implicitContext(open)).toEqual([open]);
});

test("the binding timer is cleared on the captured read while the CPR timer outlives reset", async () => {
  vi.useFakeTimers();
  stubReader(true);
  const { input, output } = install();
  const settled = readSetup("");
  await vi.advanceTimersByTimeAsync(0);
  input.emitData(Buffer.from("\x1b[1;1R"));
  input.emitData(Buffer.from("\x1b"));
  await vi.advanceTimersByTimeAsync(500);
  let atPaste = -1;
  const write = output.write.bind(output);
  output.write = (chunk: string) => {
    if (chunk === "\x1b[?2004l") atPaste = vi.getTimerCount();
    return write(chunk);
  };
  let atDetach = -1;
  let atRaw = -1;
  const off = input.off.bind(input);
  input.off = (event: string, listener: Listener | (() => void)) => {
    const result = off(event, listener);
    if (event === "data") atDetach = vi.getTimerCount();
    return result;
  };
  const setRawMode = input.setRawMode.bind(input);
  input.setRawMode = (on: boolean) => {
    const result = setRawMode(on);
    if (!on) atRaw = vi.getTimerCount();
    return result;
  };
  input.emitEnd();
  expect(atPaste).toBeGreaterThanOrEqual(2);
  await expect(settled).rejects.toBeInstanceOf(EOFError);
  expect(atDetach).toBe(atPaste - 1);
  expect(atRaw).toBe(atDetach);
  expect(atRaw).toBeGreaterThan(0);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(vi.getTimerCount()).toBe(0);
});

test("a CPR report after reset keeps support for the next read", async () => {
  vi.useFakeTimers();
  stubReader(true);
  const { input, output } = install();
  const first = readInteractive("single");
  await vi.advanceTimersByTimeAsync(0);
  input.emitData(Buffer.from("\r"));
  await vi.advanceTimersByTimeAsync(0);
  input.emitData(Buffer.from("\x1b[2;1R"));
  await vi.advanceTimersByTimeAsync(2000);
  expect(output.chunks.filter((chunk) => chunk === WARNING)).toEqual([]);
  await first;
  const asks = output.chunks.filter((chunk) => chunk === "\x1b[6n").length;
  const second = readInteractive("single");
  await vi.advanceTimersByTimeAsync(0);
  expect(output.chunks.filter((chunk) => chunk === "\x1b[6n")).toHaveLength(
    asks + 1,
  );
  await vi.advanceTimersByTimeAsync(2000);
  expect(output.chunks.filter((chunk) => chunk === WARNING)).toEqual([]);
  input.emitData(Buffer.from("\r"));
  await vi.advanceTimersByTimeAsync(1000);
  await second;
});

test("a CPR timeout after the read stops writes only the warning", async () => {
  vi.useFakeTimers();
  stubReader(true);
  const { input, output } = install();
  const settled = readSetup("kept");
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(1500);
  input.emitData(Buffer.from("\r"));
  await vi.advanceTimersByTimeAsync(500);
  const warningAt = output.chunks.indexOf(WARNING);
  expect(warningAt).toBeGreaterThanOrEqual(0);
  expect(output.chunks.filter((chunk) => chunk === WARNING)).toHaveLength(1);
  expect(input.events.filter((event) => event === "raw-exit")).toEqual([]);
  await vi.advanceTimersByTimeAsync(1000);
  await expect(settled).resolves.toBe("kept");
  expect(input.events.filter((event) => event === "raw-exit")).toEqual([
    "raw-exit",
  ]);
  expect(input.events.indexOf("raw-exit")).toBeGreaterThan(-1);
  expect(output.chunks.indexOf(WARNING)).toBe(warningAt);
  expect(output.chunks.filter((chunk) => chunk === "\x1b[6n")).toHaveLength(1);
  expect(takeAsyncDiagnostics()).toEqual([]);
});

test("a CPR timeout while the read is open erases, writes, resets, and redraws", async () => {
  vi.useFakeTimers();
  stubReader(true);
  const { input, output } = install();
  const settled = readSetup("kept");
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(2000);
  const warningAt = output.chunks.indexOf(WARNING);
  expect(warningAt).toBeGreaterThan(0);
  const eraseAt = output.chunks.findIndex(
    (chunk, index) =>
      index < warningAt &&
      chunk.includes("\x1b[J\x1b[0m\x1b[?7h") &&
      !chunk.includes("\x1b[?2004h"),
  );
  expect(eraseAt).toBeGreaterThanOrEqual(0);
  expect(input.events.indexOf("raw-exit")).toBeGreaterThanOrEqual(0);
  expect(
    input.events.filter((event) => event === "raw-exit").length,
  ).toBeGreaterThanOrEqual(1);
  const rawOff = input.events.indexOf("raw-exit");
  expect(
    output.chunks
      .slice(0, warningAt)
      .some((chunk) => chunk.includes("\x1b[?2004l")),
  ).toBe(true);
  expect(input.isRaw).toBe(true);
  expect(output.chunks.filter((chunk) => chunk === "\x1b[6n")).toHaveLength(1);
  expect(
    output.chunks
      .slice(warningAt + 1)
      .some((chunk) => chunk.includes("\x1b[?2004h")),
  ).toBe(true);
  expect(rawOff).toBeGreaterThanOrEqual(0);
  expect(input.events[rawOff]).toBe("raw-exit");
  input.emitData(Buffer.from("\r"));
  await vi.advanceTimersByTimeAsync(0);
  await expect(settled).resolves.toBe("kept");
});

test("a warning write failure stays off the prompt result", async () => {
  vi.useFakeTimers();
  stubReader(true);
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => {
    unhandled.push(error);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const { input, output } = install();
    const warning = new Error("warning");
    output.warningFault = warning;
    const settled = readSetup("kept");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.resolve();
    const diagnostics = takeAsyncDiagnostics();
    expect(diagnostics.map((item) => item.failure.error)).toContain(warning);
    expect(input.isRaw).toBe(true);
    input.emitData(Buffer.from("\r"));
    await vi.advanceTimersByTimeAsync(0);
    await expect(settled).resolves.toBe("kept");
    expect(unhandled).toEqual([]);
    expect(implicitContext(warning)).toEqual([warning]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test.todo(
  "a second overlapping warning needs a reachable public-reader source control",
);

test.for(["wait", "erase"] as const)(
  "a warning prelude $0 failure leaves close waiting on the published gate",
  async (step) => {
    vi.resetModules();
    const { PromptFrame: IsolatedFrame } = await import("./frame.ts");
    const { readSetup: isolatedRead } = await import("./feed.ts");
    const { takeAsyncDiagnostics: diagnostics } = await import("./context.ts");
    vi.useFakeTimers();
    stubReader(true);
    const { input, output } = install();
    const before = process.listeners("SIGINT");
    const prelude = new Error(`warning-${step}`);
    const wait = vi.spyOn(IsolatedFrame.prototype, "waitForCprResponses");
    const erase = vi.spyOn(IsolatedFrame.prototype, "erase");
    if (step === "wait") wait.mockRejectedValueOnce(prelude);
    else
      erase.mockImplementationOnce(() => {
        throw prelude;
      });
    let completed = false;
    const settled = isolatedRead("kept");
    void settled.then(
      () => {
        completed = true;
      },
      () => {
        completed = true;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(2000);
      expect(
        diagnostics().map((item) => [item.kind, item.failure.error]),
      ).toEqual([["cpr-warning", prelude]]);
      expect(output.chunks).not.toContain(WARNING);
      input.emitData(Buffer.from("\r"));
      await vi.advanceTimersByTimeAsync(5000);
      expect(completed).toBe(false);
      expect(input.events).toEqual([]);
      expect(input.isRaw).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      for (const listener of process.listeners("SIGINT")) {
        if (!before.includes(listener)) process.off("SIGINT", listener);
      }
    }
  },
);
