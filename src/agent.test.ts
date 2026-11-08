import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunContext } from "@openai/agents";
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelError,
} from "@openai/agents/testing";
import { afterEach, expect, test } from "vitest";
import { createAgent, runTurn } from "./agent.ts";
import { openSession } from "./session.ts";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function directory() {
  const cwd = await mkdtemp(join(tmpdir(), "lean-agent-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function turn(options: {
  cwd: string;
  input: string;
  model: ScriptedModel;
  approve?: (detail: string) => boolean | Promise<boolean>;
  signal?: AbortSignal;
  trace?: boolean;
}) {
  const opened = await openSession({
    file: join(options.cwd, "session.json"),
    cwd: options.cwd,
  });
  cleanup.push(() => opened.close());
  const text: string[] = [];
  const details: string[] = [];
  try {
    await runTurn({
      cwd: options.cwd,
      input: options.input,
      session: opened.session,
      signal: options.signal ?? new AbortController().signal,
      model: options.model,
      trace: options.trace,
      onText: (delta) => text.push(delta),
      approve: async (detail) => {
        details.push(detail);
        return options.approve ? options.approve(detail) : false;
      },
    });
    await opened.save();
    return { text: text.join(""), details, session: opened };
  } catch (error) {
    await opened.close();
    throw error;
  }
}

test("workspace AGENTS.md is the untrimmed instruction text", async () => {
  const cwd = await directory();
  const instructions = "# Workspace instructions\nUse λ exactly.  \n\n";
  await writeFile(join(cwd, "AGENTS.md"), instructions);
  const agent = await createAgent({
    cwd,
    signal: new AbortController().signal,
    model: new ScriptedModel(),
  });
  expect(await agent.getSystemPrompt(new RunContext())).toBe(instructions);
  expect(agent.modelSettings.parallelToolCalls).toBe(false);
  expect(agent.handoffs).toEqual([]);
});

test("a missing AGENTS.md still runs", async () => {
  const cwd = await directory();
  const model = new ScriptedModel();
  model.enqueue([assistantMessage("ready")]);
  const result = await turn({ cwd, input: "hi", model });
  expect(result.text).toBe("ready");
  await result.session.close();
});

test("explicit model wins over OPENAI_MODEL, which wins over the SDK default", async () => {
  const cwd = await directory();
  const previous = process.env.OPENAI_MODEL;
  const previousDefault = process.env.OPENAI_DEFAULT_MODEL;
  const signal = new AbortController().signal;
  try {
    process.env.OPENAI_MODEL = "Env-Model";
    delete process.env.OPENAI_DEFAULT_MODEL;
    expect((await createAgent({ cwd, signal })).model).toBe("Env-Model");
    expect(
      (await createAgent({ cwd, signal, model: "explicit-model" })).model,
    ).toBe("explicit-model");
    delete process.env.OPENAI_MODEL;
    process.env.OPENAI_DEFAULT_MODEL = "Default-From-SDK";
    expect((await createAgent({ cwd, signal })).model).toBe("default-from-sdk");
  } finally {
    if (previous === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = previous;
    if (previousDefault === undefined) delete process.env.OPENAI_DEFAULT_MODEL;
    else process.env.OPENAI_DEFAULT_MODEL = previousDefault;
  }
});

test("read needs no approval and its text is sent back once", async () => {
  const cwd = await directory();
  await writeFile(join(cwd, "note.txt"), "A real file contains apricot.\n");
  const model = new ScriptedModel();
  model.enqueue([
    functionCall("read", { path: "note.txt" }, { callId: "call_read" }),
  ]);
  model.enqueue([assistantMessage("saw it")]);
  const result = await turn({ cwd, input: "Read note.txt", model });
  expect(result.details).toEqual([]);
  expect(result.text).toBe("saw it");
  expect(JSON.stringify(model.calls[1]?.request.input)).toContain(
    "A real file contains apricot.",
  );
  expect(model.calls[0]?.request.modelSettings.parallelToolCalls).toBe(false);
  await result.session.close();
});

test("shell approval changes a file once and denial leaves it untouched", async () => {
  const cwd = await directory();
  const command = "printf ready >> marker.txt";
  const call = {
    type: "shell_call" as const,
    callId: "call_shell",
    status: "completed" as const,
    action: { commands: [command] },
  };
  const denied = new ScriptedModel();
  denied.enqueue([call]);
  denied.enqueue([assistantMessage("denied")]);
  const denial = await turn({
    cwd,
    input: "run",
    model: denied,
    approve: () => false,
  });
  expect(denial.text).toBe("denied");
  expect(denial.details[0]).toContain(command);
  expect(denial.details[0]?.includes("\u001b")).toBe(false);
  await expect(readFile(join(cwd, "marker.txt"))).rejects.toThrow();
  await denial.session.close();

  const approved = new ScriptedModel();
  approved.enqueue([call]);
  approved.enqueue([assistantMessage("done")]);
  const approval = await turn({
    cwd,
    input: "run",
    model: approved,
    approve: () => true,
  });
  expect(await readFile(join(cwd, "marker.txt"), "utf8")).toBe("ready");
  await approval.session.close();
});

test("approval text escapes terminal controls and shows the move target", async () => {
  const cwd = await directory();
  await writeFile(join(cwd, "note.txt"), "hello");
  const model = new ScriptedModel();
  model.enqueue([
    {
      type: "apply_patch_call" as const,
      callId: "call_patch",
      status: "completed" as const,
      operation: {
        type: "update_file" as const,
        path: "note.txt",
        diff: "@@\n-hello\n+goodbye\u001b[31m\n",
        moveTo: "renamed.txt",
      },
    },
  ]);
  model.enqueue([assistantMessage("stopped")]);
  const result = await turn({
    cwd,
    input: "edit",
    model,
    approve: () => false,
  });
  const detail = JSON.parse(result.details[0] ?? "{}") as {
    operation?: { moveTo?: string; diff?: string };
  };
  expect(detail.operation?.moveTo).toBe("renamed.txt");
  expect(detail.operation?.diff).toContain("goodbye");
  expect(result.details[0]?.includes("\u001b")).toBe(false);
  expect(await readFile(join(cwd, "note.txt"), "utf8")).toBe("hello");
  await expect(readFile(join(cwd, "renamed.txt"))).rejects.toThrow();
  await result.session.close();
});

test("an approved patch writes the file once", async () => {
  const cwd = await directory();
  const model = new ScriptedModel();
  model.enqueue([
    {
      type: "apply_patch_call" as const,
      callId: "call_create",
      status: "completed" as const,
      operation: {
        type: "create_file" as const,
        path: "made.txt",
        diff: "+created\n",
      },
    },
  ]);
  model.enqueue([assistantMessage("wrote")]);
  const result = await turn({
    cwd,
    input: "create",
    model,
    approve: () => true,
  });
  expect(await readFile(join(cwd, "made.txt"), "utf8")).toBe("created");
  expect(result.text).toBe("wrote");
  await result.session.close();
});

test("a saved session continues and the earlier user text appears once", async () => {
  const cwd = await directory();
  const file = join(cwd, "history.json");
  const firstModel = new ScriptedModel();
  firstModel.enqueue([assistantMessage("Remembered.")]);
  const first = await openSession({ file, cwd });
  await runTurn({
    cwd,
    input: "Remember the word apricot.",
    session: first.session,
    signal: new AbortController().signal,
    model: firstModel,
    onText: () => undefined,
    approve: () => false,
  });
  await first.save();
  await first.close();

  const second = await openSession({ file, cwd });
  const model = new ScriptedModel();
  model.enqueue([assistantMessage("Apricot.")]);
  await runTurn({
    cwd,
    input: "What word?",
    session: second.session,
    signal: new AbortController().signal,
    model,
    onText: () => undefined,
    approve: () => false,
  });
  const input = JSON.stringify(model.calls[0]?.request.input);
  expect(input.match(/Remember the word apricot\./g)).toHaveLength(1);
  expect(input).toContain("Remembered.");
  expect(input).toContain("What word?");
  await second.close();
});

test("a failed turn does not replace the saved history", async () => {
  const cwd = await directory();
  const file = join(cwd, "history.json");
  const model = new ScriptedModel();
  model.enqueue(modelError(new Error("boom")));
  const opened = await openSession({ file, cwd });
  await expect(
    runTurn({
      cwd,
      input: "hello",
      session: opened.session,
      signal: new AbortController().signal,
      model,
      onText: () => undefined,
      approve: () => false,
    }),
  ).rejects.toThrow(/boom/);
  await opened.close();
  await expect(readFile(file)).rejects.toThrow();
});

test("abort settles and kills a descendant of the shell", async () => {
  const cwd = await directory();
  const controller = new AbortController();
  const model = new ScriptedModel();
  model.enqueue([
    {
      type: "shell_call" as const,
      callId: "call_abort",
      status: "completed" as const,
      action: {
        commands: ["sleep 30 & echo $! > child.pid; wait"],
        timeoutMs: 20_000,
      },
    },
  ]);
  const pending = turn({
    cwd,
    input: "sleep",
    model,
    signal: controller.signal,
    approve: () => true,
  }).then(
    () => "resolved",
    () => "rejected",
  );
  const started = Date.now();
  let pid = 0;
  while (Date.now() - started < 2_000) {
    try {
      pid = Number((await readFile(join(cwd, "child.pid"), "utf8")).trim());
      if (pid > 0) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(pid).toBeGreaterThan(0);
  controller.abort();
  expect(await pending).toBe("rejected");
  await new Promise((resolve) => setTimeout(resolve, 50));
  let living = true;
  try {
    process.kill(pid, 0);
  } catch {
    living = false;
  }
  expect(living).toBe(false);
}, 10_000);

test.for([
  { trace: false, expected: false },
  { trace: true, expected: "enabled_without_data" },
])("model tracing protects content %j", async ({ trace, expected }) => {
  const cwd = await directory();
  const model = new ScriptedModel();
  model.enqueue([assistantMessage("ready")]);
  const result = await turn({ cwd, input: "private prompt", model, trace });
  expect(model.calls[0]?.request.tracing).toBe(expected);
  await result.session.close();
});

test("the model is not called after 25 turns", async () => {
  const cwd = await directory();
  await writeFile(join(cwd, "note.txt"), "x");
  const model = new ScriptedModel();
  for (let index = 0; index < 30; index += 1) {
    model.enqueue([
      functionCall("read", { path: "note.txt" }, { callId: `call_${index}` }),
    ]);
  }
  await expect(turn({ cwd, input: "loop", model })).rejects.toThrow(
    /Max turns \(25\) exceeded/,
  );
  expect(model.calls.length).toBeLessThanOrEqual(25);
  expect(model.calls.length).toBeGreaterThan(0);
});
