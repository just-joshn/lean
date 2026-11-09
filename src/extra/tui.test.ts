import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@openai/agents";
import { createTestRenderer } from "@rezi-ui/core";
import { ONE_DARK_PRO, themeDefinition } from "./tui-theme.ts";
import { actionTone } from "./tui-view.ts";
import { afterEach, expect, test, vi } from "vitest";
import { openSession, type OpenedSession } from "../session.ts";
import { main } from "./tui-main.ts";
import { replayItems } from "./tui-replay.ts";
import {
  createTuiController,
  demoDriver,
  type HistoryPort,
  type TuiController,
  type TurnDriver,
} from "./tui.ts";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
});

async function directory() {
  const cwd = await mkdtemp(join(tmpdir(), "lean-tui-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

function screen(controller: TuiController, cols = 80, rows = 24): string {
  controller.resize(cols);
  return frame(controller, cols, rows).toText();
}

function frame(controller: TuiController, cols = 80, rows = 24) {
  return createTestRenderer().render(controller.render(), {
    focusedId: "prompt",
    viewport: { cols, rows },
    theme: themeDefinition(controller.state.theme, false),
  });
}

function modelFixture(label: string): Model {
  return {
    async getResponse() {
      throw new Error(label);
    },
    getStreamedResponse() {
      throw new Error(label);
    },
  };
}

async function controllerFor(options: {
  driver?: TurnDriver;
  cwd?: string;
  model?: string | Model;
  modelLabel?: string;
  history?: HistoryPort | null;
  demo?: boolean;
  redact?: (error: unknown) => string;
  resolveModel?: (name: string) => Promise<string | Model>;
  sessionLabel?: string;
  noColor?: boolean;
}) {
  const controller = await createTuiController({
    driver:
      options.driver ??
      (async (input) => {
        input.onText("ok");
      }),
    cwd: options.cwd ?? "/workspace",
    model: options.model ?? "gpt-test",
    modelLabel: options.modelLabel ?? "gpt-test",
    providerLabel: options.demo ? "demo" : "default",
    sessionLabel: options.sessionLabel ?? "session.json",
    demo: options.demo === true,
    history: options.history,
    redact: options.redact,
    resolveModel: options.resolveModel,
    noColor: options.noColor,
  });
  cleanup.push(() => controller.shutdown());
  return controller;
}

test("renders the header and prompt at a normal width", async () => {
  const controller = await controllerFor({
    cwd: "/workspace/lean",
    modelLabel: "gpt-test",
  });
  const text = screen(controller, 80, 24);
  expect(text).toContain("Lean");
  expect(text).toContain("gpt-test");
  expect(text).toContain("/workspace/lean");
  expect(text).toContain("·");
  expect(text).toContain(">");
  expect(text).not.toContain("┌");
});

test("renders the header and prompt at a narrow width", async () => {
  const cwd = "/Users/someone/projects/very-long-workspace-name";
  const controller = await controllerFor({ cwd });
  const text = screen(controller, 40, 24);
  expect(text).toContain("Lean");
  expect(text).toContain(">");
  expect(text).not.toContain(cwd);
  expect(text.split("\n").every((line) => line.length <= 40)).toBe(true);
});

test("completes slash commands from the registry", async () => {
  const controller = await controllerFor({});
  controller.editDraft("/he");
  const menu = screen(controller);
  expect(menu).toContain("/help");
  expect(menu).not.toContain("/theme");
  expect(controller.key("tab")).toBe(true);
  expect(controller.state.draft.text).toBe("/help ");
  await controller.submit();
  const help = screen(controller);
  expect(help).toContain("/help");
  expect(help).toContain("Saved history stays on disk");
  expect(
    controller.state.transcript
      .map((entry) =>
        entry.kind === "action" ? entry.action.summary : entry.text,
      )
      .join("\n"),
  ).toContain("/clear");
});

test("shows a scrollable proposal and approves it without calling it executed", async () => {
  const commands = [
    "echo START-MARKER",
    ...Array.from({ length: 40 }, (_, index) => `echo mid-${index}`),
    "echo END-MARKER",
  ];
  const detail = JSON.stringify({
    tool: "shell",
    action: { commands, timeout_ms: 1000 },
  });
  let approved: boolean | undefined;
  const controller = await controllerFor({
    driver: async (input) => {
      approved = await input.approve(detail);
      input.onText(approved ? "continued" : "stopped");
    },
  });
  controller.editDraft("please tool");
  const pending = controller.submit();
  await expect.poll(() => controller.state.phase.kind).toBe("approval");
  const top = screen(controller);
  expect(top).toContain("Proposed call. Nothing has run.");
  expect(top).toContain("START-MARKER");
  expect(top).toContain("Allow");
  expect(top).toContain("Deny");
  expect(top).not.toContain("END-MARKER");
  expect(top.toLowerCase()).not.toContain("executed");
  for (
    let attempt = 0;
    attempt < 20 && !screen(controller).includes("END-MARKER");
    attempt += 1
  ) {
    controller.key("pagedown");
  }
  expect(screen(controller)).toContain("END-MARKER");
  controller.allow();
  await pending;
  expect(approved).toBe(true);
  expect(screen(controller)).toContain("Allowed. The turn is still running.");
  expect(screen(controller)).toContain("continued");
});

test("denies a proposal and still saves the completed turn", async () => {
  const saves: string[] = [];
  let items: unknown[] = [{ role: "user", content: "keep" }];
  const history: HistoryPort = {
    getItems: async () => items,
    restore: async () => {
      throw new Error("restore should not run after a denial");
    },
    save: async () => {
      saves.push("save");
    },
    close: async () => {},
  };
  const controller = await controllerFor({
    history,
    driver: async (input) => {
      const allowed = await input.approve(
        '{"tool":"shell","action":{"commands":["echo no"]}}',
      );
      const answer = allowed ? "ran" : "denied-result";
      items = [
        ...items,
        { role: "user", content: input.text },
        { role: "assistant", content: answer },
      ];
      input.onText(answer);
    },
  });
  controller.editDraft("please tool");
  const pending = controller.submit();
  await expect.poll(() => controller.state.phase.kind).toBe("approval");
  expect(screen(controller)).toContain("echo no");
  expect(screen(controller)).toContain("Nothing has run.");
  expect(controller.key("n")).toBe(true);
  await pending;
  expect(saves).toEqual(["save"]);
  expect(screen(controller)).toContain("denied-result");
  expect(screen(controller)).not.toContain("ran");
  expect(screen(controller)).not.toContain("restore should not run");
});

test("enter and esc deny an empty approval prompt", async () => {
  const answers: boolean[] = [];
  const controller = await controllerFor({
    driver: async (input) => {
      answers.push(await input.approve('{"tool":"shell"}'));
      if (answers.length === 1)
        answers.push(await input.approve('{"tool":"apply_patch"}'));
      input.onText("done");
    },
  });
  controller.editDraft("tool");
  const pending = controller.submit();
  await expect.poll(() => controller.state.phase.kind).toBe("approval");
  controller.key("enter");
  await expect.poll(() => controller.state.phase.kind).toBe("approval");
  controller.key("escape");
  await pending;
  expect(answers).toEqual([false, false]);
});

test("restores a cancelled turn and saves the next one", async () => {
  const cwd = await directory();
  const file = join(cwd, "session.json");
  const opened = await openSession({ file, cwd });
  cleanup.push(() => opened.close());
  await opened.session.addItems([{ role: "user", content: "keep apricot" }]);
  await opened.save();
  let mode: "cancel" | "ok" = "cancel";
  const controller = await createTuiController({
    cwd,
    model: "gpt-test",
    modelLabel: "gpt-test",
    providerLabel: "default",
    sessionLabel: "session.json",
    demo: false,
    history: sessionPort(opened),
    driver: async (input) => {
      await opened.session.addItems([{ role: "user", content: input.text }]);
      if (mode === "cancel") {
        await opened.session.addItems([
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "partial-secret" }],
          },
        ]);
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve();
          else
            input.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
        input.signal.throwIfAborted();
      }
      input.onText("saved-ok");
      await opened.session.addItems([
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "saved-ok" }],
        },
      ]);
    },
  });
  cleanup.push(() => controller.shutdown());
  controller.editDraft("bad turn");
  const cancelled = controller.submit();
  await expect.poll(() => controller.state.phase.kind).toBe("running");
  controller.key("ctrl+c");
  await cancelled;
  expect(screen(controller)).toContain(
    "Cancelled. Completed tool side effects are not undone.",
  );
  expect(await readFile(file, "utf8")).toContain("keep apricot");
  expect(await readFile(file, "utf8")).not.toContain("partial-secret");
  expect(await readFile(file, "utf8")).not.toContain("bad turn");
  mode = "ok";
  controller.editDraft("next turn");
  await controller.submit();
  const saved = await readFile(file, "utf8");
  expect(saved).toContain("keep apricot");
  expect(saved).toContain("next turn");
  expect(saved).toContain("saved-ok");
  expect(saved).not.toContain("partial-secret");
  expect(saved).not.toContain("bad turn");
});

test("refuses later turns when restore fails", async () => {
  let calls = 0;
  let saves = 0;
  const controller = await controllerFor({
    history: {
      getItems: async () => [],
      restore: async () => {
        throw new Error("disk full");
      },
      save: async () => {
        saves += 1;
      },
      close: async () => {},
    },
    driver: async () => {
      calls += 1;
      throw new Error("boom");
    },
  });
  controller.editDraft("hello");
  await controller.submit();
  expect(controller.state.blocked).toBe(true);
  expect(saves).toBe(0);
  controller.editDraft("again");
  await controller.submit();
  expect(calls).toBe(1);
  expect(screen(controller)).toContain("Turns are refused");
});

test("redacts secrets from turn errors", async () => {
  const controller = await controllerFor({
    redact: (error) =>
      (error instanceof Error ? error.message : String(error))
        .split("sk-live-secret")
        .join("[redacted]"),
    driver: async () => {
      throw new Error("request failed sk-live-secret");
    },
  });
  controller.editDraft("hello");
  await controller.submit();
  const text = screen(controller);
  expect(text).toContain("[redacted]");
  expect(text).not.toContain("sk-live-secret");
});

test("replays user and assistant text without reasoning", async () => {
  const controller = await controllerFor({
    history: {
      getItems: async () => [
        { role: "user", content: "keep the note" },
        {
          type: "reasoning",
          content: [{ type: "reasoning_text", text: "secret-thought" }],
          signature: "sig-secret",
        },
        {
          type: "shell_call",
          callId: "call_orphan",
          action: { commands: ["rm -rf /"] },
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "visible answer" }],
          signature: "sig-secret",
        },
      ],
      restore: async () => {},
      save: async () => {},
      close: async () => {},
    },
  });
  const text = screen(controller, 100, 32);
  expect(text).toContain("keep the note");
  expect(text).toContain("visible answer");
  expect(text).toContain("rm -rf");
  expect(text).toContain("no result");
  expect(text).not.toContain("secret-thought");
  expect(text).not.toContain("sig-secret");
  expect(text).not.toContain("executed");
});

test("resolves the next model object before a later turn", async () => {
  const first = modelFixture("first");
  const second = modelFixture("second");
  const seen: unknown[] = [];
  const controller = await controllerFor({
    model: first,
    modelLabel: "gpt-a",
    resolveModel: async (name) => {
      if (name === "bad") throw new Error('Unknown model "bad".');
      return second;
    },
    driver: async (input) => {
      seen.push(input.model);
      input.onText("ok");
    },
  });
  controller.editDraft("/model bad");
  await controller.submit();
  expect(screen(controller)).toContain('Unknown model "bad".');
  controller.editDraft("hello");
  await controller.submit();
  expect(seen).toEqual([first]);
  controller.editDraft("/model gpt-b");
  await controller.submit();
  expect(controller.state.modelLabel).toBe("gpt-b");
  controller.editDraft("again");
  await controller.submit();
  expect(seen).toEqual([first, second]);
});

test("demo turns do not save history", async () => {
  let saves = 0;
  const controller = await controllerFor({
    demo: true,
    model: "demo",
    modelLabel: "demo",
    sessionLabel: "demo (not saved)",
    history: {
      getItems: async () => {
        throw new Error("demo read history");
      },
      restore: async () => {
        throw new Error("demo restored history");
      },
      save: async () => {
        saves += 1;
      },
      close: async () => {},
    },
    driver: demoDriver(),
  });
  controller.editDraft("please tool");
  const pending = controller.submit();
  await expect.poll(() => controller.state.phase.kind).toBe("approval");
  expect(screen(controller)).toContain("echo demo-only");
  expect(screen(controller)).toContain("Nothing has run.");
  controller.key("y");
  await pending;
  expect(screen(controller)).toContain("Demo recorded yes. No command ran.");
  expect(screen(controller)).toContain("synthetic");
  expect(screen(controller)).not.toContain("exit 0");
  expect(saves).toBe(0);
  expect(controller.state.sessionLabel).toBe("demo (not saved)");
  expect(screen(controller)).not.toContain("demo read history");
});

test("keeps multiline arrow keys for the editor and recalls single-line history", async () => {
  const controller = await controllerFor({});
  controller.editDraft("alpha");
  await controller.submit();
  controller.editDraft("");
  expect(controller.key("up")).toBe(true);
  expect(controller.state.draft.text).toBe("alpha");
  controller.editDraft("one\ntwo");
  expect(controller.key("up")).toBe(false);
  expect(controller.state.draft.text).toBe("one\ntwo");
  controller.editDraft("ab\\");
  expect(controller.key("enter")).toBe(true);
  expect(controller.state.draft.text).toBe("ab\n");
  expect(controller.state.phase.kind).toBe("idle");
});

test("does not submit over an open turn", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = await controllerFor({
    driver: async (input) => {
      await gate;
      input.onText("done");
    },
  });
  controller.editDraft("first");
  const pending = controller.submit();
  await expect.poll(() => controller.state.phase.kind).toBe("running");
  controller.editDraft("second");
  await controller.submit();
  expect(controller.state.draft.text).toBe("second");
  expect(screen(controller)).toContain("Wait until the current turn finishes.");
  release();
  await pending;
});

test("clear hides the screen and leaves saved items untouched", async () => {
  const cwd = await directory();
  const file = join(cwd, "session.json");
  const opened = await openSession({ file, cwd });
  cleanup.push(() => opened.close());
  await opened.session.addItems([{ role: "user", content: "keep apricot" }]);
  await opened.save();
  const before = await readFile(file, "utf8");
  const controller = await createTuiController({
    cwd,
    model: "gpt-test",
    modelLabel: "gpt-test",
    providerLabel: "default",
    sessionLabel: "session.json",
    demo: false,
    history: sessionPort(opened),
    driver: async () => {
      throw new Error("clear does not call the model");
    },
  });
  cleanup.push(() => controller.shutdown());
  expect(screen(controller)).toContain("keep apricot");
  controller.editDraft("/clear");
  await controller.submit();
  expect(screen(controller)).toContain("Saved history was not deleted.");
  expect(screen(controller)).not.toContain("keep apricot");
  expect(await readFile(file, "utf8")).toBe(before);
  expect(await opened.session.getItems()).toEqual([
    { role: "user", content: "keep apricot" },
  ]);
});

test("typing q is consumed only when the prompt is not focused", async () => {
  const controller = await controllerFor({});
  expect(controller.consumes("q", "prompt")).toBe(false);
  expect(controller.key("q", "allow")).toBe(true);
  expect(controller.state.draft.text).toBe("");
});

test("ctrl+c clears the draft and a second press exits", async () => {
  const controller = await controllerFor({});
  controller.editDraft("draft");
  expect(controller.key("ctrl+c")).toBe(true);
  expect(controller.state.draft.text).toBe("");
  expect(controller.state.exitArmed).toBe(true);
  expect(screen(controller)).toContain("Press Ctrl+C again to exit.");
  controller.editDraft("x");
  expect(controller.state.exitArmed).toBe(false);
  controller.editDraft("");
  controller.key("ctrl+c");
  controller.key("ctrl+c");
  await controller.done;
});

test("rejects invalid flags and a missing terminal before raw mode", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  try {
    expect(await main(["--help"])).toBe(0);
    expect(stdout.join("")).toContain("Usage: bun run tui");
    expect(stdout.join("")).toContain("--demo");
    expect(await main(["--not-a-flag"])).toBe(1);
    expect(stderr.join("")).toContain("--not-a-flag");
    expect(await main(["--provider", "nope"])).toBe(1);
    expect(stderr.join("")).toContain("Unknown provider");
    expect(await main(["--demo", "--trace"])).toBe(1);
    expect(stderr.join("")).toContain("--demo does not use");
    expect(await main(["hello"])).toBe(1);
    expect(await main([])).toBe(1);
    expect(stderr.join("")).toContain("The TUI needs a terminal.");
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
});

test("shows unicode draft text", async () => {
  const controller = await controllerFor({});
  controller.editDraft("héllo 你好");
  expect(controller.state.draft.text).toBe("héllo 你好");
  const text = screen(controller);
  expect(text).toContain("héllo");
  expect(text).toContain("你");
});

test("pairs saved calls and results by call id", () => {
  const replayed = replayItems([
    {
      type: "shell_call",
      callId: "call_b",
      action: { commands: ["echo beta"] },
      providerData: { secret: "hidden-provider" },
    },
    {
      type: "shell_call",
      callId: "call_a",
      action: { commands: ["echo alpha"] },
    },
    {
      type: "shell_call_output",
      callId: "call_a",
      output: [
        { stdout: "ALPHA", stderr: "", outcome: { type: "exit", exitCode: 0 } },
      ],
    },
    {
      type: "shell_call_output",
      callId: "call_b",
      output: [
        { stdout: "BETA", stderr: "", outcome: { type: "exit", exitCode: 2 } },
      ],
    },
    {
      type: "function_call",
      callId: "call_read",
      name: "read",
      arguments: '{"path":"note.txt"}',
    },
    {
      type: "function_call_result",
      callId: "call_read",
      name: "read",
      status: "completed",
      output: { type: "text", text: "apricot" },
    },
    {
      type: "apply_patch_call",
      callId: "call_patch",
      status: "completed",
      operation: {
        type: "update_file",
        path: "a.txt",
        diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
      },
    },
    {
      type: "apply_patch_call_output",
      callId: "call_patch",
      status: "failed",
      output: "nope",
    },
    {
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "hidden-thought" }],
      signature: "sig-secret",
    },
  ]);
  const actions = replayed.flatMap((entry) =>
    entry.kind === "action" ? [entry.action] : [],
  );
  expect(actions.map((action) => [action.summary, action.status])).toEqual([
    ["bash  echo beta", "exit 2"],
    ["bash  echo alpha", "exit 0"],
    ['read  {"path":"note.txt"}', "completed"],
    ["patch  a.txt", "failed"],
  ]);
  expect(actions[0]?.output).toBe("BETA");
  expect(actions[1]?.output).toBe("ALPHA");
  expect(actions[2]?.output).toBe("apricot");
  expect(actions[2]?.sourcePath).toBe("note.txt");
  expect(actions[0]?.sourcePath).toBeNull();
  expect(actions[3]?.output).toContain("+new");
  expect(actions[3]?.output).toContain("nope");
  expect(actions[0]?.raw).toContain("BETA");
  expect(actions[0]?.raw).not.toContain("ALPHA");
  expect(actions[0]?.raw).not.toContain("hidden-provider");
  expect(JSON.stringify(replayed)).not.toContain("hidden-thought");
  expect(JSON.stringify(replayed)).not.toContain("sig-secret");
});

test("inspects the matching saved result after a successful turn", async () => {
  let items: unknown[] = [{ role: "user", content: "keep" }];
  const controller = await controllerFor({
    history: {
      getItems: async () => items,
      restore: async (next) => {
        items = [...next];
      },
      save: async () => {},
      close: async () => {},
    },
    driver: async (input) => {
      items = [
        ...items,
        { role: "user", content: input.text },
        {
          type: "shell_call",
          callId: "call_b",
          action: { commands: ["echo beta"] },
        },
        {
          type: "shell_call",
          callId: "call_a",
          action: { commands: ["echo alpha"] },
        },
        {
          type: "shell_call_output",
          callId: "call_a",
          output: [
            {
              stdout: "ALPHA",
              stderr: "",
              outcome: { type: "exit", exitCode: 0 },
            },
          ],
        },
        {
          type: "shell_call_output",
          callId: "call_b",
          output: [
            {
              stdout: "BETA",
              stderr: "",
              outcome: { type: "exit", exitCode: 2 },
            },
          ],
        },
        { role: "assistant", content: "streamed-answer" },
      ];
      input.onText("streamed-answer");
    },
  });
  controller.editDraft("please");
  await controller.submit();
  const rows = screen(controller, 100, 32);
  expect(rows).toContain("streamed-answer");
  expect(rows).toContain("echo beta");
  expect(rows).toContain("exit 2");
  expect(rows).toContain("echo alpha");
  expect(rows).toContain("exit 0");
  expect(rows).not.toContain("ALPHA");
  expect(controller.key("ctrl+o")).toBe(true);
  expect(screen(controller, 100, 32)).toContain("ALPHA");
  expect(screen(controller, 100, 32)).not.toContain("BETA");
  expect(controller.key("left")).toBe(true);
  expect(screen(controller, 100, 32)).toContain("BETA");
  expect(screen(controller, 100, 32)).not.toContain("ALPHA");
  expect(controller.key("tab")).toBe(true);
  const raw = screen(controller, 100, 32);
  expect(raw).toContain("call_b");
  expect(raw).toContain("Raw result");
  expect(controller.key("escape")).toBe(true);
  expect(screen(controller, 100, 32)).not.toContain("BETA");
});

test("colors only unified diff lines", async () => {
  const controller = await controllerFor({
    history: {
      getItems: async () => [
        {
          type: "apply_patch_call",
          callId: "call_patch",
          status: "completed",
          operation: {
            type: "update_file",
            path: "a.txt",
            diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
          },
        },
        {
          type: "apply_patch_call_output",
          callId: "call_patch",
          status: "completed",
          output: "Updated a.txt",
        },
        {
          type: "shell_call",
          callId: "call_plain",
          action: { commands: ["printf plus"] },
        },
        {
          type: "shell_call_output",
          callId: "call_plain",
          output: [
            {
              stdout: "pad\n+not-a-diff\nhello",
              stderr: "",
              outcome: { type: "exit", exitCode: 0 },
            },
          ],
        },
      ],
      restore: async () => {},
      save: async () => {},
      close: async () => {},
    },
  });
  controller.resize(100);
  expect(controller.key("ctrl+o")).toBe(true);
  expect(controller.key("left")).toBe(true);
  const diff = frame(controller, 100, 32);
  const added = diff.ops.find(
    (op) => op.kind === "drawText" && op.text.includes("+new"),
  );
  const removed = diff.ops.find(
    (op) => op.kind === "drawText" && op.text.includes("-old"),
  );
  if (added?.kind !== "drawText" || removed?.kind !== "drawText") {
    throw new Error("diff lines were not drawn");
  }
  expect(added.style?.fg).toBe(0x98c379);
  expect(removed.style?.fg).toBe(0xe06c75);
  expect(controller.key("right")).toBe(true);
  const plain = frame(controller, 100, 32);
  const plus = plain.ops.find(
    (op) => op.kind === "drawText" && op.text.includes("+not-a-diff"),
  );
  const hello = plain.ops.find(
    (op) => op.kind === "drawText" && op.text.includes("hello"),
  );
  if (plus?.kind !== "drawText" || hello?.kind !== "drawText") {
    throw new Error("plain output was not drawn");
  }
  expect(plus.style?.fg).toBe(hello.style?.fg);
  expect(plus.style?.bold).toBe(hello.style?.bold);
});

test("ctrl+c during approval denies the call and still allows the next save", async () => {
  const cwd = await directory();
  const file = join(cwd, "session.json");
  const opened = await openSession({ file, cwd });
  cleanup.push(() => opened.close());
  await opened.session.addItems([{ role: "user", content: "keep apricot" }]);
  await opened.save();
  let mode: "cancel" | "ok" = "cancel";
  let answer: boolean | undefined;
  const controller = await createTuiController({
    cwd,
    model: "gpt-test",
    modelLabel: "gpt-test",
    providerLabel: "default",
    sessionLabel: "session.json",
    demo: false,
    history: sessionPort(opened),
    driver: async (input) => {
      if (mode === "cancel") {
        answer = await input.approve('{"tool":"shell"}');
        const error = new Error("cancelled");
        error.name = "AbortError";
        throw error;
      }
      input.onText("saved-ok");
      await opened.session.addItems([
        { role: "user", content: input.text },
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "saved-ok" }],
        },
      ]);
    },
  });
  cleanup.push(() => controller.shutdown());
  controller.editDraft("bad turn");
  const cancelled = controller.submit();
  await expect.poll(() => controller.state.phase.kind).toBe("approval");
  controller.key("ctrl+c");
  await cancelled;
  expect(answer).toBe(false);
  expect(screen(controller, 100, 32)).toContain(
    "Cancelled. Completed tool side effects are not undone.",
  );
  expect(await readFile(file, "utf8")).toContain("keep apricot");
  expect(await readFile(file, "utf8")).not.toContain("bad turn");
  mode = "ok";
  controller.editDraft("next turn");
  await controller.submit();
  const saved = await readFile(file, "utf8");
  expect(saved).toContain("keep apricot");
  expect(saved).toContain("next turn");
  expect(saved).toContain("saved-ok");
  expect(saved).not.toContain("bad turn");
});

test("paints One Dark Pro across chrome, code, and theme changes", async () => {
  const controller = await controllerFor({
    history: {
      getItems: async () => [
        {
          type: "function_call",
          callId: "call_read",
          name: "read",
          arguments: '{"path":"main.ts"}',
        },
        {
          type: "function_call_result",
          callId: "call_read",
          name: "read",
          status: "completed",
          output: { type: "text", text: "const count = 1;" },
        },
      ],
      restore: async () => {},
      save: async () => {},
      close: async () => {},
    },
  });
  expect(controller.state.theme).toBe(ONE_DARK_PRO);
  const painted = frame(controller, 100, 32);
  expect(cell(painted, "Lean")).toMatchObject({ fg: 0xabb2bf, bg: 0x282c34 });
  expect(cell(painted, "*")?.fg).toBe(0x61afef);
  controller.editDraft("/h");
  const menu = frame(controller, 100, 32);
  expect(cell(menu, "> /help")?.bg).toBe(0x2c313a);
  expect(cell(menu, "> /help")?.fg).toBe(0xd7dae0);
  controller.editDraft("");
  expect(controller.key("ctrl+o")).toBe(true);
  const output = frame(controller, 100, 32);
  expect(cell(output, "const")?.fg).toBe(0xc678dd);
  expect(cell(output, "Output")).toMatchObject({ fg: 0xdcdcdc, bg: 0x282c34 });
  expect(JSON.stringify(controller.state.transcript)).not.toContain("#C678DD");
  controller.editDraft("/theme nord");
  await controller.submit();
  expect(controller.state.theme).toBe("nord");
  const nord = createTestRenderer().render(controller.render(), {
    focusedId: "prompt",
    viewport: { cols: 100, rows: 32 },
    theme: themeDefinition("nord", false),
  });
  expect(cell(nord, "const")?.fg).not.toBe(0xc678dd);
  expect(cell(nord, "Lean")?.bg).not.toBe(0x282c34);
});

test("keeps NO_COLOR monochrome when the theme changes", async () => {
  const controller = await controllerFor({
    noColor: true,
    history: {
      getItems: async () => [
        { role: "assistant", content: "const count = 1;" },
      ],
      restore: async () => {},
      save: async () => {},
      close: async () => {},
    },
  });
  const quiet = createTestRenderer().render(controller.render(), {
    focusedId: "prompt",
    viewport: { cols: 80, rows: 24 },
    theme: themeDefinition(controller.state.theme, true),
  });
  expect(cell(quiet, "const")?.fg).toBe(0xabb2bf);
  expect(cell(quiet, "Lean")?.fg).toBe(0xabb2bf);
  controller.editDraft("/theme nord");
  await controller.submit();
  const switched = createTestRenderer().render(controller.render(), {
    focusedId: "prompt",
    viewport: { cols: 80, rows: 24 },
    theme: themeDefinition(controller.state.theme, true),
  });
  expect(controller.state.theme).toBe("nord");
  expect(cell(switched, "const")?.fg).toBe(cell(switched, "Lean")?.fg);
  expect(cell(switched, "const")?.fg).not.toBe(0xc678dd);
});

test("colors approval, cancellation, and the synthetic demo sample", async () => {
  const demo = await controllerFor({ demo: true, driver: demoDriver() });
  const sample = frame(demo, 80, 40);
  expect(sample.toText()).toContain("Synthetic sample. Nothing was executed.");
  expect(sample.toText()).toContain("synthetic-fixture");
  expect(cell(sample, "const")).toMatchObject({ fg: 0xc678dd, bold: false });
  expect(cell(sample, "ready")).toMatchObject({ fg: 0xe5c07b });

  let approved = true;
  const controller = await controllerFor({
    driver: async (input) => {
      approved = await input.approve('{"tool":"shell"}');
      if (!approved) {
        const error = new Error("cancelled");
        error.name = "AbortError";
        throw error;
      }
    },
  });
  controller.editDraft("please tool");
  const pending = controller.submit();
  await expect.poll(() => controller.state.phase.kind).toBe("approval");
  const proposal = frame(controller, 80, 24);
  expect(cell(proposal, "Allow")).toMatchObject({ fg: 0x8cc265, bg: 0x30333d });
  expect(cell(proposal, "Deny")).toMatchObject({ fg: 0xc24038, bg: 0x30333d });
  expect(cell(proposal, "{")?.fg).toBe(0xabb2bf);
  expect(cell(proposal, '"tool"')?.fg).toBe(0xe06c75);
  controller.key("ctrl+c");
  await pending;
  const cancelled = frame(controller, 100, 32);
  expect(
    cell(cancelled, "Cancelled. Completed tool side effects are not undone.")
      ?.fg,
  ).toBe(0xd19a66);
});

test("colors all outcomes of a recorded multi-command shell call", () => {
  expect(actionTone("exit 0, exit 2")).toBe("error");
  expect(actionTone("exit 2, timeout")).toBe("error");
  expect(actionTone("exit 0, timeout")).toBe("warning");
  expect(actionTone("timeout, unrecognized outcome")).toBe("warning");
  expect(actionTone("exit 0, unrecognized outcome")).toBe("muted");
  expect(actionTone("exit 0, exit")).toBe("muted");
  expect(actionTone("exit 0, exit 0")).toBe("success");
  expect(actionTone("unrecognized outcome")).toBe("muted");
  expect(actionTone("exit")).toBe("muted");
  expect(actionTone("no result")).toBe("muted");
  expect(actionTone("completed")).toBe("success");
  expect(actionTone("exit 0")).toBe("success");
  expect(actionTone("failed")).toBe("error");
  expect(actionTone("error")).toBe("error");
  expect(actionTone("timeout")).toBe("warning");
  expect(actionTone("exit 2")).toBe("error");
});

function cell(
  rendered: ReturnType<ReturnType<typeof createTestRenderer>["render"]>,
  label: string,
) {
  const op = rendered.ops.find(
    (item) => item.kind === "drawText" && item.text.includes(label),
  );
  return op?.kind === "drawText" ? op.style : undefined;
}

function sessionPort(opened: OpenedSession): HistoryPort {
  return {
    getItems: () => opened.session.getItems(),
    restore: async (items) => {
      await opened.session.clearSession();
      if (items.length > 0) {
        await opened.session.addItems(
          items as Parameters<typeof opened.session.addItems>[0],
        );
      }
    },
    save: () => opened.save(),
    close: () => opened.close(),
  };
}
