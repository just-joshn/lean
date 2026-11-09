import { createTestRenderer } from "@rezi-ui/core";
import { afterEach, expect, test } from "vitest";
import { wrapLines } from "./tui-view.ts";
import { createTuiController, type HistoryPort } from "./tui.ts";
import { themeDefinition } from "./tui-theme.ts";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function history(items: unknown[] = []): HistoryPort {
  return {
    getItems: async () => items,
    restore: async (snapshot) => {
      items.splice(0, items.length, ...snapshot);
    },
    save: async () => {},
    close: async () => {},
  };
}

async function conversation() {
  const items: unknown[] = [];
  const controller = await createTuiController({
    cwd: "/workspace",
    model: "test",
    modelLabel: "test",
    providerLabel: "default",
    sessionLabel: "test.json",
    demo: false,
    history: history(items),
    driver: async (input) => {
      items.push(
        { role: "user", content: input.text },
        {
          type: "shell_call",
          callId: `call_${input.text}`,
          action: { commands: [`echo ${input.text}`] },
        },
        {
          type: "shell_call_output",
          callId: `call_${input.text}`,
          output: [
            {
              stdout: input.text,
              stderr: "",
              outcome: { type: "exit", exitCode: 0 },
            },
          ],
        },
        { role: "assistant", content: `Answer ${input.text}` },
      );
      input.onText(`Answer ${input.text}`);
    },
  });
  cleanup.push(() => controller.shutdown());
  return { controller, items };
}

test("keeps completed actions before the assistant's final answer", async () => {
  const { controller } = await conversation();
  controller.editDraft("first");
  await controller.submit();
  const entries = controller.state.transcript.filter(
    (entry) => entry.kind !== "notice",
  );
  expect(entries.map((entry) => entry.kind)).toEqual([
    "user",
    "action",
    "assistant",
  ]);
  expect(entries.at(-1)).toEqual({
    kind: "assistant",
    text: "Answer first",
  });
});

test("does not bring cleared actions back after the next turn", async () => {
  const { controller, items } = await conversation();
  controller.editDraft("first");
  await controller.submit();
  const saved = structuredClone(items);
  controller.editDraft("/clear");
  await controller.submit();
  expect(items).toEqual(saved);
  controller.editDraft("second");
  await controller.submit();
  const actions = controller.state.transcript.flatMap((entry) =>
    entry.kind === "action" ? [entry.action.callId] : [],
  );
  expect(actions).toEqual(["call_second"]);
  expect(items).toContainEqual({ role: "user", content: "first" });
});

test("keeps emoji graphemes together when wrapping terminal cells", () => {
  expect(wrapLines("ab👩🏽‍💻cd", 4)).toEqual(["ab👩🏽‍💻", "cd"]);
});

test("makes every line of a long response reachable by paging", async () => {
  const text = Array.from(
    { length: 80 },
    (_, index) => `LONG-LINE-${String(index + 1).padStart(2, "0")}`,
  ).join("\n");
  const controller = await createTuiController({
    cwd: "/workspace",
    model: "test",
    modelLabel: "test",
    providerLabel: "default",
    sessionLabel: "test.json",
    demo: false,
    history: history([
      { role: "user", content: "Long answer" },
      { role: "assistant", content: text },
    ]),
    driver: async () => {},
  });
  cleanup.push(() => controller.shutdown());
  const renderer = createTestRenderer();
  controller.resize(40);
  const seen = new Set<string>();
  for (const key of [
    ...Array<string>(20).fill("pageup"),
    ...Array<string>(20).fill("pagedown"),
  ]) {
    controller.key(key);
    const frame = renderer.render(controller.render(), {
      focusedId: "prompt",
      viewport: { cols: 40, rows: 24 },
      theme: themeDefinition(controller.state.theme, false),
    });
    for (const match of frame.toText().matchAll(/LONG-LINE-\d{2}/g)) {
      seen.add(match[0]);
    }
  }
  expect([...seen].sort()).toEqual(text.split("\n"));
});
