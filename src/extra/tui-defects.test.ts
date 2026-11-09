import { createTestRenderer, ensureVisible } from "@rezi-ui/core";
import type { TestRenderResult } from "@rezi-ui/core";
import { afterEach, expect, test } from "vitest";
import { themeDefinition, type ThemeName } from "./tui-theme.ts";
import {
  createTuiController,
  type HistoryPort,
  type TuiController,
  type TurnDriver,
} from "./tui.ts";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
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

function memoryHistory(
  items: readonly unknown[] = [],
  restore: HistoryPort["restore"] = async () => {},
): HistoryPort {
  return {
    getItems: async () => items,
    restore,
    save: async () => {},
    close: async () => {},
  };
}

async function open(options: {
  driver?: TurnDriver;
  items?: readonly unknown[];
  history?: HistoryPort | null;
  theme?: ThemeName;
}) {
  const controller = await createTuiController({
    cwd: "/workspace",
    model: "gpt-test",
    modelLabel: "gpt-test",
    providerLabel: "default",
    sessionLabel: "session.json",
    demo: false,
    theme: options.theme,
    history:
      options.history === undefined
        ? memoryHistory(options.items ?? [])
        : options.history,
    driver: options.driver ?? (async () => {}),
  });
  cleanup.push(() => controller.shutdown());
  return controller;
}

function render(
  controller: TuiController,
  cols: number,
  rows: number,
): TestRenderResult {
  controller.resize(cols, rows);
  return createTestRenderer().render(controller.render(), {
    focusedId: "prompt",
    viewport: { cols, rows },
    theme: themeDefinition(controller.state.theme, false),
  });
}

function assistantText(controller: TuiController): string {
  const parts: string[] = [];
  for (const entry of controller.state.transcript) {
    if (entry.kind === "assistant") parts.push(entry.text);
  }
  return parts.join("\n");
}

function drawn(frame: TestRenderResult, text: string) {
  const op = frame.ops.find(
    (item) => item.kind === "drawText" && item.text === text,
  );
  return op?.kind === "drawText" ? op : undefined;
}

function listBox(frame: TestRenderResult, id: string) {
  return (
    frame.findById(id) ??
    frame.nodes.find(
      (node) => typeof node.id === "string" && node.id.startsWith(`${id}:`),
    ) ??
    null
  );
}

function expectPrompt(frame: TestRenderResult, rows: number) {
  const prompt = frame.findById("prompt");
  expect(prompt).not.toBeNull();
  if (!prompt) return;
  expect(prompt.rect.h).toBeGreaterThan(0);
  expect(prompt.rect.y).toBeGreaterThanOrEqual(0);
  expect(prompt.rect.y + prompt.rect.h).toBeLessThanOrEqual(rows);
}

type Scroll = { id: string; top: number };

function visibleStart(
  frame: TestRenderResult,
  id: string,
  scroll: Scroll,
): { height: number; start: number } {
  const node = listBox(frame, id);
  expect(node?.id).toBe(id);
  if (!node) return { height: 0, start: 0 };
  const height = node.rect.h;
  expect(height).toBeGreaterThan(0);
  const ensure = node.props.ensureVisibleIndex;
  expect(typeof ensure).toBe("number");
  if (node.id !== scroll.id) {
    scroll.top = 0;
    scroll.id = node.id ?? id;
  }
  if (typeof ensure === "number" && height > 0) {
    scroll.top = ensureVisible(scroll.top, height, ensure, 1);
  }
  return { height, start: scroll.top };
}

function markersIn(start: number, height: number, rows: readonly string[]) {
  const found: string[] = [];
  for (
    let index = start;
    index < start + height && index < rows.length;
    index += 1
  ) {
    const row = rows[index];
    if (row) found.push(row);
  }
  return found;
}

async function waitForAbort(signal: AbortSignal) {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

test("keeps a typed follow-up and its textarea when a turn is cancelled", async () => {
  const controller = await open({
    history: null,
    driver: async (input) => {
      input.onText("partial");
      await waitForAbort(input.signal);
      input.signal.throwIfAborted();
    },
  });
  controller.editDraft("sent text");
  const pending = controller.submit();
  await expect.poll(() => controller.state.phase.kind).toBe("running");
  const key = controller.state.draft.key;
  controller.editDraft("kept follow up", 4);
  controller.key("ctrl+c");
  await pending;
  expect(controller.state.draft).toEqual({ text: "kept follow up", key });
  expect(render(controller, 80, 24).findById("prompt")?.props.key).toBe(
    `p${key}`,
  );
});

test("keeps a typed follow-up when the driver throws", async () => {
  let failTurn = () => {};
  const gate = new Promise<void>((resolve) => {
    failTurn = resolve;
  });
  const controller = await open({
    history: null,
    driver: async () => {
      await gate;
      throw new Error("boom");
    },
  });
  controller.editDraft("sent text");
  const pending = controller.submit();
  try {
    await expect.poll(() => controller.state.phase.kind).toBe("running");
    const key = controller.state.draft.key;
    controller.editDraft("kept follow up", 2);
    failTurn();
    await pending;
    expect(controller.state.draft).toEqual({ text: "kept follow up", key });
  } finally {
    failTurn();
  }
});

test("restores the submitted request when the live draft is empty", async () => {
  const controller = await open({
    history: null,
    driver: async (input) => {
      await waitForAbort(input.signal);
      input.signal.throwIfAborted();
    },
  });
  controller.editDraft("sent text");
  const pending = controller.submit();
  await expect.poll(() => controller.state.phase.kind).toBe("running");
  const cleared = controller.state.draft.key;
  controller.key("ctrl+c");
  await pending;
  expect(controller.state.draft).toEqual({
    text: "sent text",
    key: cleared + 1,
  });
});

test("separates shell stdout and stderr without doubling an existing newline", async () => {
  const controller = await open({
    items: [
      {
        type: "shell_call",
        callId: "shell",
        action: { commands: ["a", "b"] },
      },
      {
        type: "shell_call_output",
        callId: "shell",
        output: [
          { stdout: "A", stderr: "err1" },
          { stdout: "B", stderr: "err2" },
        ],
      },
      {
        type: "shell_call",
        callId: "ended",
        action: { commands: ["c", "d"] },
      },
      {
        type: "shell_call_output",
        callId: "ended",
        output: [
          { stdout: "A\n", stderr: "err1\n" },
          { stdout: "B\n", stderr: "err2\n" },
        ],
      },
    ],
  });
  const actions = controller.state.transcript.flatMap((entry) =>
    entry.kind === "action" ? [entry.action] : [],
  );
  const joined = actions.find((action) => action.callId === "shell");
  const ended = actions.find((action) => action.callId === "ended");
  expect(joined?.output).toBe("A\nstderr:\nerr1\nB\nstderr:\nerr2");
  expect(ended?.output).toBe("A\nstderr:\nerr1\nB\nstderr:\nerr2\n");
  expect(ended?.output).not.toContain("\n\n");
  expect(joined?.raw).toContain('"stdout": "A"');
  expect(joined?.raw).toContain('"stderr": "err1"');
  expect(controller.key("ctrl+o")).toBe(true);
  expect(render(controller, 80, 24).toText()).toContain("stderr:");
});

test("keeps an unfinished escape inside its own shell field", async () => {
  const controller = await open({
    items: [
      {
        type: "shell_call",
        callId: "shell",
        action: { commands: ["a"] },
      },
      {
        type: "shell_call_output",
        callId: "shell",
        output: [{ stdout: "\u001b]0;title", stderr: "visible-err" }],
      },
    ],
  });
  const action = controller.state.transcript.find(
    (entry) => entry.kind === "action",
  );
  if (action?.kind !== "action") throw new Error("missing shell");
  expect(action.action.output).toContain("visible-err");
  expect(action.action.output).not.toContain("title");
  expect(action.action.raw).toContain("title");
  expect(action.action.raw).toContain("visible-err");
});

test("shows a patch diagnostic that is only a substring of the diff", async () => {
  const diff = "--- a/file\n+++ b/file\n@@\n-apply failed\n+goodbye\n";
  const controller = await open({
    items: [
      {
        type: "apply_patch_call",
        callId: "patch",
        operation: { type: "update_file", path: "file", diff },
      },
      {
        type: "apply_patch_call_output",
        callId: "patch",
        status: "failed",
        output: "apply failed",
      },
      {
        type: "apply_patch_call",
        callId: "same",
        operation: {
          type: "update_file",
          path: "same",
          diff: "same-bytes\n",
        },
      },
      {
        type: "apply_patch_call_output",
        callId: "same",
        output: "same-bytes\n",
      },
    ],
  });
  const actions = controller.state.transcript.flatMap((entry) =>
    entry.kind === "action" ? [entry.action] : [],
  );
  const patch = actions.find((action) => action.callId === "patch");
  const same = actions.find((action) => action.callId === "same");
  expect(patch?.output.split("apply failed")).toHaveLength(3);
  expect(same?.output).toBe("same-bytes\n");
  expect(patch?.raw).toContain("apply failed");
});

test("paints a read file as source and a bare @@ patch as a diff", async () => {
  const controller = await open({
    theme: "nord",
    items: [
      {
        type: "function_call",
        callId: "read",
        name: "read",
        arguments: JSON.stringify({ path: "main.ts" }),
      },
      {
        type: "function_call_result",
        callId: "read",
        output: "const value = 1;\n@@\n+keep\n-drop\n",
      },
      {
        type: "apply_patch_call",
        callId: "patch",
        operation: {
          type: "update_file",
          path: "demo.txt",
          diff: "@@\n-hello\n+goodbye\n",
        },
      },
      {
        type: "apply_patch_call_output",
        callId: "patch",
        output: "updated",
      },
    ],
  });
  expect(controller.key("ctrl+o")).toBe(true);
  const patch = render(controller, 80, 24);
  const added = drawn(patch, "+goodbye");
  const removed = drawn(patch, "-hello");
  expect(added?.style?.fg).toBeDefined();
  expect(removed?.style?.fg).toBeDefined();
  expect(added?.style?.fg).not.toBe(removed?.style?.fg);
  expect(controller.key("left")).toBe(true);
  const source = render(controller, 80, 24);
  const keyword = drawn(source, "const value = 1;");
  const plus = drawn(source, "+keep");
  const minus = drawn(source, "-drop");
  expect(keyword?.style?.fg).toBe(plus?.style?.fg);
  expect(keyword?.style?.fg).toBe(minus?.style?.fg);
});

test("tokenizes a diff-like TypeScript read with the TypeScript grammar", async () => {
  const controller = await open({
    items: [
      {
        type: "function_call",
        callId: "read",
        name: "read",
        arguments: JSON.stringify({ path: "main.ts" }),
      },
      {
        type: "function_call_result",
        callId: "read",
        output: "const value = 1;\n@@\n+keep\n-drop\n",
      },
    ],
  });
  expect(controller.key("ctrl+o")).toBe(true);
  await expect
    .poll(() => drawn(render(controller, 100, 32), "const")?.style?.fg, {
      timeout: 4000,
    })
    .toBe(0xc678dd);
  expect(drawn(render(controller, 100, 32), "+keep")?.style?.fg).not.toBe(
    0x98c379,
  );
});

test("colors +++ and --- as headers only when the path delimiter is present", async () => {
  const controller = await open({
    theme: "nord",
    items: [
      {
        type: "apply_patch_call",
        callId: "patch",
        operation: {
          type: "update_file",
          path: "demo.txt",
          diff: [
            "--- path",
            "+++ path",
            "@@",
            "-old",
            "+new",
            "+++i;",
            "---i;",
            "+++",
            "---",
          ].join("\n"),
        },
      },
      {
        type: "apply_patch_call_output",
        callId: "patch",
        output: "updated",
      },
    ],
  });
  expect(controller.key("ctrl+o")).toBe(true);
  const frame = render(controller, 80, 24);
  const meta = drawn(frame, "+++ path")?.style?.fg;
  const added = drawn(frame, "+new")?.style?.fg;
  const removed = drawn(frame, "-old")?.style?.fg;
  expect(meta).toBe(drawn(frame, "--- path")?.style?.fg);
  expect(meta).toBe(drawn(frame, "@@")?.style?.fg);
  expect(drawn(frame, "+++i;")?.style?.fg).toBe(added);
  expect(drawn(frame, "---i;")?.style?.fg).toBe(removed);
  expect(drawn(frame, "+++")?.style?.fg).toBe(added);
  expect(drawn(frame, "---")?.style?.fg).toBe(removed);
  expect(added).not.toBe(meta);
});

test("reaches every transcript row in a short pane and keeps the prompt visible", async () => {
  const lines = Array.from(
    { length: 40 },
    (_, index) => `ROW${String(index).padStart(2, "0")}`,
  );
  const visual = ["*", ...lines];
  for (const [cols, rows, draft] of [
    [80, 14, "/"],
    [80, 9, ""],
    [80, 9, "/"],
  ] as const) {
    const controller = await open({
      items: [{ role: "assistant", content: lines.join("\n") }],
    });
    if (draft) controller.editDraft(draft);
    const seen = new Set<string>();
    const scroll: Scroll = { id: "", top: 0 };
    const frames = [
      render(controller, cols, rows),
      ...Array.from({ length: 80 }, () => {
        controller.key("pageup");
        return render(controller, cols, rows);
      }),
      ...Array.from({ length: 80 }, () => {
        controller.key("pagedown");
        return render(controller, cols, rows);
      }),
    ];
    for (const frame of frames) {
      expectPrompt(frame, rows);
      const view = visibleStart(frame, "transcript", scroll);
      for (const row of markersIn(view.start, view.height, visual)) {
        if (row.startsWith("ROW")) seen.add(row);
      }
    }
    expect([...seen].sort()).toEqual(lines);
  }
});

test("pages a tall transcript by the visible list height", async () => {
  const lines = Array.from(
    { length: 80 },
    (_, index) => `LONG-LINE-${String(index + 1).padStart(2, "0")}`,
  );
  const visual = ["*", ...lines];
  for (const [cols, rows] of [
    [40, 24],
    [100, 32],
  ] as const) {
    const controller = await open({
      items: [{ role: "assistant", content: lines.join("\n") }],
    });
    const scroll: Scroll = { id: "", top: 0 };
    const first = render(controller, cols, rows);
    expectPrompt(first, rows);
    const before = visibleStart(first, "transcript", scroll);
    expect(before.height).toBeGreaterThan(5);
    controller.key("pageup");
    const after = visibleStart(
      render(controller, cols, rows),
      "transcript",
      scroll,
    );
    expect(before.start - after.start).toBe(before.height);
    const seen = new Set<string>(
      markersIn(after.start, after.height, visual).filter((row) =>
        row.startsWith("LONG-LINE-"),
      ),
    );
    for (let step = 0; step < 20; step += 1) {
      controller.key("pageup");
      const up = visibleStart(
        render(controller, cols, rows),
        "transcript",
        scroll,
      );
      for (const row of markersIn(up.start, up.height, visual)) {
        if (row.startsWith("LONG-LINE-")) seen.add(row);
      }
    }
    for (let step = 0; step < 20; step += 1) {
      controller.key("pagedown");
      const down = visibleStart(
        render(controller, cols, rows),
        "transcript",
        scroll,
      );
      for (const row of markersIn(down.start, down.height, visual)) {
        if (row.startsWith("LONG-LINE-")) seen.add(row);
      }
    }
    expect([...seen].sort()).toEqual(lines);
  }
});

test("reaches every inspector and proposal row when the pane is short", async () => {
  const inspectorLines = Array.from(
    { length: 30 },
    (_, index) => `INS${String(index).padStart(2, "0")}`,
  );
  const inspector = await open({
    items: [
      {
        type: "shell_call",
        callId: "shell",
        action: { commands: ["echo"] },
      },
      {
        type: "shell_call_output",
        callId: "shell",
        output: [{ stdout: inspectorLines.join("\n"), stderr: "" }],
      },
    ],
  });
  expect(inspector.key("ctrl+o")).toBe(true);
  const seenInspector = new Set<string>();
  const inspectorScroll: Scroll = { id: "", top: 0 };
  for (let step = 0; step < 40; step += 1) {
    const frame = render(inspector, 80, 9);
    expectPrompt(frame, 9);
    const view = visibleStart(frame, "inspector-body", inspectorScroll);
    for (const row of markersIn(view.start, view.height, inspectorLines)) {
      seenInspector.add(row);
    }
    inspector.key("pagedown");
  }
  expect([...seenInspector].sort()).toEqual(inspectorLines);

  const proposalLines = Array.from(
    { length: 30 },
    (_, index) => `PROP${String(index).padStart(2, "0")}`,
  );
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const proposal = await open({
    history: null,
    driver: async (input) => {
      await input.approve(proposalLines.join("\n"));
      await gate;
    },
  });
  proposal.editDraft("please tool");
  const pending = proposal.submit();
  await expect.poll(() => proposal.state.phase.kind).toBe("approval");
  const seenProposal = new Set<string>();
  const proposalScroll: Scroll = { id: "", top: 0 };
  for (let step = 0; step < 40; step += 1) {
    const frame = render(proposal, 80, 9);
    expectPrompt(frame, 9);
    const view = visibleStart(frame, "proposal", proposalScroll);
    for (const row of markersIn(view.start, view.height, proposalLines)) {
      seenProposal.add(row);
    }
    proposal.key("pagedown");
  }
  expect([...seenProposal].sort()).toEqual(proposalLines);
  release();
  proposal.key("escape");
  await pending;
});

test("keeps every payload character visible at nine columns", async () => {
  const controller = await open({
    items: [{ role: "assistant", content: "123456789END" }],
  });
  const frame = render(controller, 9, 24);
  expect(frame.toText()).toContain("END");
  expect(
    frame
      .toText()
      .split("\n")
      .every((line) => line.length <= 9),
  ).toBe(true);
});

function cuts(raw: string): number[] {
  const points = new Set<number>([1, raw.length - 1]);
  for (let index = 0; index < raw.length; index += 1) {
    const byte = raw[index];
    if (byte === "\u001b" || byte === "[" || byte === "]" || byte === "m") {
      points.add(index + 1);
    }
    if (
      byte === ";" ||
      byte === "\u0007" ||
      byte === "\r" ||
      byte === "\n" ||
      byte === "\t"
    ) {
      points.add(index);
      points.add(index + 1);
    }
  }
  return [...points]
    .filter((cut) => cut > 0 && cut < raw.length)
    .sort((a, b) => a - b);
}

test("shows the same readable text for a whole control and a control split across deltas", async () => {
  const cases = [
    ["\u001b[31mred", "red"],
    ["\u001b]8;;http://example.test\u0007link\u001b]8;;\u0007", "link"],
    ["\u001b]0;title\u0007done", "done"],
    ["0%\r100%\n", "100%\n"],
    ["\tgoal", "\tgoal"],
    ["hello\rX", "Xello"],
    ["a\r\nb", "a\nb"],
    ["你b\rX", "X b"],
    ["你好\rA", "A 好"],
    ["\uD83D\uDC4Db\rX", "X b"],
    ["ab你cd\rXYZ", "XYZ cd"],
    ["hello\tworld\rX", "Xello\tworld"],
  ] as const;
  for (const [raw, expected] of cases) {
    const replayed = await open({
      items: [{ role: "assistant", content: raw }],
    });
    expect(assistantText(replayed)).toBe(expected);
    expect(assistantText(replayed)).not.toContain("\u001b");
    if (raw === "\tgoal") {
      expect(render(replayed, 40, 24).toText()).toContain("        goal");
    }
    let turn = 0;
    const parts = cuts(raw);
    const streamed = await open({
      history: null,
      driver: async (input) => {
        const cut = parts[turn] ?? 1;
        turn += 1;
        input.onText(raw.slice(0, cut));
        input.onText(raw.slice(cut));
      },
    });
    for (const cut of parts) {
      streamed.editDraft(`go ${cut}`);
      await streamed.submit();
      let latest = "";
      for (const entry of streamed.state.transcript) {
        if (entry.kind === "assistant") latest = entry.text;
      }
      expect(latest).toBe(expected);
    }
  }
});

test("does not finish a cancelled turn's escape on the next turn", async () => {
  let turn = 0;
  const controller = await open({
    history: null,
    driver: async (input) => {
      turn += 1;
      if (turn === 1) {
        input.onText("\u001b[31");
        await waitForAbort(input.signal);
        input.signal.throwIfAborted();
      }
      input.onText("mred");
    },
  });
  controller.editDraft("first");
  const cancelled = controller.submit();
  await expect.poll(() => controller.state.phase.kind).toBe("running");
  controller.key("ctrl+c");
  await cancelled;
  controller.editDraft("second");
  await controller.submit();
  expect(assistantText(controller)).toBe("mred");
  expect(assistantText(controller)).not.toContain("31");
});

test("names approval keys only while the draft is empty", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const answers: boolean[] = [];
  const controller = await open({
    history: null,
    driver: async (input) => {
      answers.push(await input.approve('{"tool":"shell"}'));
      await gate;
    },
  });
  controller.editDraft("please tool");
  const pending = controller.submit();
  try {
    await expect.poll(() => controller.state.phase.kind).toBe("approval");
    expect(render(controller, 80, 24).toText()).toContain(
      "y allow · n, enter, or esc deny",
    );
    controller.editDraft("note");
    const hinted = render(controller, 80, 24).toText();
    expect(hinted).not.toContain("y allow");
    expect(hinted).not.toContain("n, enter");
    expect(hinted).toContain("esc deny");
    expect(controller.key("y")).toBe(false);
    expect(controller.state.phase.kind).toBe("approval");
    controller.editDraft("");
    expect(controller.key("y")).toBe(true);
    release();
    await pending;
    expect(answers).toEqual([true]);
  } finally {
    release();
    if (controller.state.phase.kind === "approval") controller.key("escape");
  }
});

test("allows a local exit after a failed restore and still blocks a later turn", async () => {
  let calls = 0;
  const blocked = await open({
    history: memoryHistory([], async () => {
      throw new Error("disk full");
    }),
    driver: async () => {
      calls += 1;
      throw new Error("boom");
    },
  });
  blocked.editDraft("hello");
  await blocked.submit();
  expect(blocked.state.blocked).toBe(true);
  blocked.editDraft("again");
  await blocked.submit();
  expect(calls).toBe(1);
  expect(render(blocked, 80, 24).toText()).toContain("Turns are refused");

  const exitNow = await open({
    history: memoryHistory([], async () => {
      throw new Error("disk full");
    }),
    driver: async () => {
      throw new Error("boom");
    },
  });
  exitNow.editDraft("hello");
  await exitNow.submit();
  exitNow.editDraft("/exit now");
  const exited = Promise.race([
    exitNow.done.then(() => "exited" as const),
    new Promise<"stayed">((resolve) => {
      setTimeout(() => resolve("stayed"), 100);
    }),
  ]);
  await exitNow.submit();
  expect(await exited).toBe("exited");

  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = await open({
    history: null,
    driver: async (input) => {
      await waitForAbort(input.signal);
      await gate;
      input.signal.throwIfAborted();
    },
  });
  running.editDraft("hello");
  const pending = running.submit();
  await expect.poll(() => running.state.phase.kind).toBe("running");
  running.editDraft("/exit");
  await running.submit();
  expect(running.state.phase.kind).toBe("running");
  release();
  running.key("ctrl+c");
  await pending;
});

test("keeps rows reachable after a resize", async () => {
  const lines = Array.from(
    { length: 40 },
    (_, index) => `ROW${String(index).padStart(2, "0")}`,
  );
  const visual = ["*", ...lines];
  const controller = await open({
    items: [{ role: "assistant", content: lines.join("\n") }],
  });
  const scroll: Scroll = { id: "", top: 0 };
  const seen = new Set<string>();
  const first = render(controller, 40, 24);
  expectPrompt(first, 24);
  const firstView = visibleStart(first, "transcript", scroll);
  for (const row of markersIn(firstView.start, firstView.height, visual)) {
    if (row.startsWith("ROW")) seen.add(row);
  }
  controller.key("pageup");
  controller.editDraft("/");
  for (let step = 0; step < 50; step += 1) {
    const frame = render(controller, 80, 14);
    expectPrompt(frame, 14);
    const view = visibleStart(frame, "transcript", scroll);
    for (const row of markersIn(view.start, view.height, visual)) {
      if (row.startsWith("ROW")) seen.add(row);
    }
    controller.key("pageup");
  }
  expect([...seen].sort()).toEqual(lines);
});

test("keeps a makefile tab so @ stays keyword purple and the indent is eight spaces", async () => {
  const source = "all:\n\t@echo hello\n";
  const controller = await open({
    items: [
      {
        type: "function_call",
        callId: "read",
        name: "read",
        arguments: JSON.stringify({ path: "Makefile" }),
      },
      {
        type: "function_call_result",
        callId: "read",
        output: source,
      },
    ],
  });
  const action = controller.state.transcript.find(
    (entry) => entry.kind === "action",
  );
  if (action?.kind !== "action") throw new Error("missing read");
  expect(action.action.output).toContain("\t@echo hello");
  expect(action.action.raw).toContain("@echo hello");
  expect(controller.key("ctrl+o")).toBe(true);
  await expect
    .poll(() => drawn(render(controller, 80, 24), "@")?.style?.fg, {
      timeout: 4000,
    })
    .toBe(0xc678dd);
  expect(render(controller, 80, 24).toText()).toContain("        @echo hello");
});

test("ignores a callback retained from an earlier successful turn", async () => {
  let retained: ((delta: string) => void) | null = null;
  let turn = 0;
  const controller = await open({
    history: null,
    driver: async (input) => {
      turn += 1;
      if (turn === 1) {
        retained = input.onText;
        input.onText("SECRET");
        return;
      }
      input.onText("visible");
      retained?.("STALE");
    },
  });
  controller.editDraft("first");
  await controller.submit();
  controller.editDraft("second");
  await controller.submit();
  expect(assistantText(controller)).toBe("SECRET\nvisible");
});

test("ignores a callback retained from a cancelled turn", async () => {
  let retained: ((delta: string) => void) | null = null;
  let during = "";
  let turn = 0;
  const controller = await open({
    history: null,
    driver: async (input) => {
      turn += 1;
      if (turn === 1) {
        retained = input.onText;
        input.onText("SECRET");
        input.signal.addEventListener("abort", () => {
          input.onText("LEAK");
          during = assistantText(controller);
        });
        await waitForAbort(input.signal);
        input.signal.throwIfAborted();
      }
      input.onText("visible");
      retained?.("STALE");
    },
  });
  controller.editDraft("first");
  const cancelled = controller.submit();
  await expect.poll(() => controller.state.phase.kind).toBe("running");
  controller.key("ctrl+c");
  await cancelled;
  expect(during).toBe("SECRET");
  controller.editDraft("second");
  await controller.submit();
  expect(assistantText(controller)).toBe("visible");
});
