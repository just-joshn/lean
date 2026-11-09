import { createTestRenderer } from "@rezi-ui/core";
import { afterEach, expect, test } from "vitest";
import {
  createTuiController,
  demoDriver,
  type HistoryPort,
  type TuiController,
  type TurnDriver,
} from "./tui.ts";
import { ONE_DARK_PRO, themeDefinition } from "./tui-theme.ts";
import { actionTone } from "./tui-view.ts";

const controllers: TuiController[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.shutdown();
});

async function controllerFor(options: {
  driver?: TurnDriver;
  history?: HistoryPort | null;
  demo?: boolean;
  noColor?: boolean;
}) {
  const controller = await createTuiController({
    driver:
      options.driver ??
      (async (input) => {
        input.onText("ok");
      }),
    cwd: "/workspace",
    model: "gpt-test",
    modelLabel: "gpt-test",
    providerLabel: options.demo ? "demo" : "default",
    sessionLabel: "session.json",
    demo: options.demo === true,
    history: options.history,
    noColor: options.noColor,
  });
  controllers.push(controller);
  return controller;
}

async function demo() {
  const controller = await createTuiController({
    driver: demoDriver(),
    cwd: "/workspace",
    model: "demo",
    modelLabel: "demo",
    providerLabel: "demo",
    sessionLabel: "synthetic",
    demo: true,
  });
  controllers.push(controller);
  return controller;
}

function frame(controller: TuiController, cols = 100, rows = 32) {
  return createTestRenderer().render(controller.render(), {
    theme: themeDefinition(controller.state.theme, false),
    focusedId: "prompt",
    viewport: { cols, rows },
  });
}

function cell(
  rendered: ReturnType<ReturnType<typeof createTestRenderer>["render"]>,
  label: string,
) {
  const op = rendered.ops.find(
    (item) => item.kind === "drawText" && item.text.includes(label),
  );
  return op?.kind === "drawText" ? op.style : undefined;
}

test("uses the terminal foreground for ordinary recorded output", async () => {
  const controller = await demo();
  controller.key("ctrl+o");
  controller.key("left");
  const output = frame(controller).ops.find(
    (op) => op.kind === "drawText" && op.text === "synthetic-fixture",
  );
  expect(output?.kind).toBe("drawText");
  if (output?.kind !== "drawText") throw new Error("Output was not drawn");
  expect(output.style?.fg).toBe(0xabb2bf);
  expect(output.style?.dim).toBe(false);
});

test("uses the status-bar foreground for header and footer metadata", async () => {
  const rendered = frame(await demo());
  for (const needle of ["/workspace · demo", "enter send"]) {
    const label = rendered.ops.find(
      (op) => op.kind === "drawText" && op.text.includes(needle),
    );
    expect(label?.kind).toBe("drawText");
    if (label?.kind !== "drawText") throw new Error(`${needle} was not drawn`);
    expect(label.style?.fg).toBe(0x9da5b4);
    expect(label.style?.dim).toBe(false);
  }
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
