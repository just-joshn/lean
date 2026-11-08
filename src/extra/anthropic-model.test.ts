import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protocol, type ModelRequest } from "@openai/agents";
import { afterEach, expect, test, vi } from "vitest";
import { runTurn } from "../agent.ts";
import { openSession } from "../session.ts";
import { createSubscriptions, openCredentialStore } from "./auth.ts";

const directories: string[] = [];
const access = "sk-ant-oat-synthetic-access";
const refresh = "synthetic-anthropic-refresh";
const signature = "synthetic-thinking-signature";

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function directory(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "lean-anthropic-"));
  directories.push(created);
  return created;
}

function events(items: readonly [string, unknown][]): string {
  return `${items.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join("\n")}\n`;
}

function messageStart(id: string): [string, unknown] {
  return [
    "message_start",
    {
      type: "message_start",
      message: {
        id,
        model: "claude-sonnet-5-5",
        usage: {
          input_tokens: 11,
          output_tokens: 1,
          cache_read_input_tokens: 7,
        },
      },
    },
  ];
}

function textResponse(id: string, text: string): string {
  return events([
    messageStart(id),
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 4 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ]);
}

function toolResponse(id: string, name: string, input: unknown): string {
  return events([
    messageStart(id),
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Use the approved tool." },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_shell", name, input: {} },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(input),
        },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 9 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ]);
}

async function savedModel(home: string) {
  const store = openCredentialStore(home);
  await store.modify("anthropic", async () => ({
    type: "oauth" as const,
    access,
    refresh,
    expires: 1_800_000_000_000,
    clientId: "synthetic-client",
  }));
  await store.close();
  const subscriptions = createSubscriptions({
    home,
    env: { OPENAI_API_KEY: "", LEAN_HOME: home },
  });
  const model = await subscriptions.resolveModel({ provider: "anthropic" });
  if (typeof model === "string")
    throw new Error("Expected the Anthropic subscription model.");
  return { model, close: () => subscriptions.close() };
}

function request(input: ModelRequest["input"]): ModelRequest {
  return {
    input,
    modelSettings: {},
    tools: [
      { type: "shell", name: "shell" },
      { type: "apply_patch", name: "apply_patch" },
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
        strict: false,
      },
    ],
    outputType: "text",
    handoffs: [],
    tracing: false,
  };
}

test("Anthropic projects text, signed thinking, and native tool calls", async () => {
  const home = await directory();
  const bodies: unknown[] = [];
  const scripts = [
    toolResponse("msg_shell", "shell", {
      commands: ["printf x"],
      timeoutMs: 1000,
    }),
    toolResponse("msg_patch", "apply_patch", {
      operation: { type: "create_file", path: "note.txt", diff: "+hello\n" },
    }),
    toolResponse("msg_read", "read", { path: "note.txt" }),
    textResponse("msg_done", "Done."),
  ];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    expect(String(url)).toContain("/v1/messages");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${access}`,
    );
    bodies.push(JSON.parse(String(init?.body)));
    const script = scripts.shift();
    if (script === undefined) throw new Error("Unexpected request.");
    return new Response(script, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
  const selected = await savedModel(home);
  const streamed: string[] = [];
  let shellOutput: { type?: string }[] = [];
  for await (const event of selected.model.getStreamedResponse(
    request("Count"),
  )) {
    if (event.type === "output_text_delta") streamed.push(event.delta);
    if (event.type === "response_done") shellOutput = event.response.output;
  }
  expect(shellOutput.map((item) => item.type)).toEqual([
    "reasoning",
    "shell_call",
  ]);
  expect(JSON.stringify(shellOutput)).toContain(signature);
  expect(streamed.join("")).not.toContain("Use the approved tool.");
  const patch = await selected.model.getResponse(request("Write"));
  expect(patch.output.some((item) => item.type === "apply_patch_call")).toBe(
    true,
  );
  const read = await selected.model.getResponse(request("Read"));
  expect(read.output.some((item) => item.type === "function_call")).toBe(true);
  expect(read.output.some((item) => item.type === "shell_call")).toBe(false);
  const done = await selected.model.getResponse(request("Finish"));
  expect(done.usage.inputTokens).toBe(18);
  expect(done.usage.inputTokensDetails).toContainEqual({ cached_tokens: 7 });
  const first = JSON.stringify(bodies[0]);
  expect(first).toContain('"name":"shell"');
  expect(first).toContain('"name":"apply_patch"');
  expect(first).toContain("commands");
  expect(first).toContain("operation");
  await selected.close();
});

test("Anthropic replays signed history and keeps read as a function call", async () => {
  const home = await directory();
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(textResponse("msg_replay", "Done."), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
  const reasoning = protocol.ReasoningItem.parse({
    type: "reasoning",
    id: "rs_1",
    content: [],
    rawContent: [{ type: "reasoning_text", text: "" }],
    providerData: { leanAnthropic: { signature, effort: "high" } },
  });
  const call = protocol.FunctionCallItem.parse({
    type: "function_call",
    callId: "toolu_read",
    name: "read",
    status: "completed",
    arguments: JSON.stringify({ path: "note.txt" }),
  });
  const result = protocol.FunctionCallResultItem.parse({
    type: "function_call_result",
    callId: "toolu_read",
    name: "read",
    status: "completed",
    output: "hello",
  });
  const selected = await savedModel(home);
  await selected.model.getResponse(
    request([
      { role: "user", content: "Read the note" },
      reasoning,
      call,
      result,
      { role: "user", content: "Thanks" },
    ]),
  );
  const body = JSON.stringify(bodies[0]);
  expect(body).toContain(signature);
  expect(body).toContain("toolu_read");
  expect(body).toContain("Read the note");
  expect(body.match(/Read the note/g)).toHaveLength(1);
  await selected.close();
});

test("a shell represented as a function call is rejected before the provider is called", async () => {
  const home = await directory();
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls += 1;
    return new Response(textResponse("msg_unused", "Done."), { status: 200 });
  });
  const call = protocol.FunctionCallItem.parse({
    type: "function_call",
    callId: "call_bad",
    name: "shell",
    status: "completed",
    arguments: "{}",
  });
  const selected = await savedModel(home);
  await expect(selected.model.getResponse(request([call]))).rejects.toThrow(
    /shell/,
  );
  expect(calls).toBe(0);
  await selected.close();
});

test("an unknown Anthropic model and a provider error stay free of token text", async () => {
  const home = await directory();
  const subscriptions = createSubscriptions({
    home,
    env: { OPENAI_API_KEY: "" },
  });
  await expect(
    subscriptions.resolveModel({
      provider: "anthropic",
      model: "missing-model",
    }),
  ).rejects.toThrow(/missing-model/);
  const store = openCredentialStore(home);
  await store.modify("anthropic", async () => ({
    type: "oauth" as const,
    access,
    refresh,
    expires: 1_800_000_000_000,
  }));
  await store.close();
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ error: { message: access } }), {
        status: 400,
      }),
  );
  const model = await subscriptions.resolveModel({
    provider: "anthropic",
    model: "claude-sonnet-5-5",
  });
  if (typeof model === "string") throw new Error("Expected a model.");
  await expect(model.getResponse(request("Hello"))).rejects.toThrow(
    /redacted|400/,
  );
  try {
    await model.getResponse(request("Hello"));
  } catch (error) {
    expect(subscriptions.redact(error)).not.toContain(access);
  }
  await subscriptions.close();
});

test("an approved patch is applied once", async () => {
  const cwd = await directory();
  const home = await directory();
  const store = openCredentialStore(home);
  await store.modify("anthropic", async () => ({
    type: "oauth" as const,
    access,
    refresh,
    expires: 1_800_000_000_000,
  }));
  await store.close();
  const subscriptions = createSubscriptions({
    home,
    env: { OPENAI_API_KEY: "" },
  });
  const model = await subscriptions.resolveModel({ provider: "anthropic" });
  if (typeof model === "string") throw new Error("Expected a model.");
  const scripts = [
    toolResponse("msg_patch", "apply_patch", {
      operation: { type: "create_file", path: "note.txt", diff: "+hello\n" },
    }),
    textResponse("msg_done", "Done."),
  ];
  vi.stubGlobal("fetch", async () => {
    const script = scripts.shift();
    if (script === undefined) throw new Error("Unexpected request.");
    return new Response(script, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
  const opened = await openSession({
    file: join(cwd, ".lean/history.json"),
    cwd,
  });
  let approvals = 0;
  await runTurn({
    cwd,
    input: "Write",
    model,
    session: opened.session,
    signal: new AbortController().signal,
    onText: () => undefined,
    approve: async (detail) => {
      approvals += 1;
      expect(detail).toContain("note.txt");
      return true;
    },
  });
  await opened.close();
  expect(approvals).toBe(1);
  expect(await readFile(join(cwd, "note.txt"), "utf8")).toBe("hello");
  await subscriptions.close();
});

test("an approved shell runs once and its signature survives a restarted session", async () => {
  const cwd = await directory();
  const home = await directory();
  const store = openCredentialStore(home);
  await store.modify("anthropic", async () => ({
    type: "oauth" as const,
    access,
    refresh,
    expires: 1_800_000_000_000,
  }));
  await store.close();
  const subscriptions = createSubscriptions({
    home,
    env: { OPENAI_API_KEY: "", LEAN_HOME: home },
  });
  const model = await subscriptions.resolveModel({});
  if (typeof model === "string") throw new Error("Expected a model.");
  const bodies: unknown[] = [];
  const scripts = [
    toolResponse("msg_shell", "shell", {
      commands: ["printf x >> count.txt"],
      timeoutMs: 1000,
    }),
    textResponse("msg_done", "Done."),
    textResponse("msg_resume", "Still done."),
  ];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const script = scripts.shift();
    if (script === undefined) throw new Error("Unexpected request.");
    return new Response(script, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
  const opened = await openSession({
    file: join(cwd, ".lean/history.json"),
    cwd,
  });
  const visible: string[] = [];
  const signal = new AbortController().signal;
  await runTurn({
    cwd,
    input: "Count",
    model,
    session: opened.session,
    signal,
    approve: async () => true,
    onText: (delta) => visible.push(delta),
  });
  await opened.save();
  await opened.close();
  expect(await readFile(join(cwd, "count.txt"), "utf8")).toBe("x");
  expect(visible.join("")).not.toContain("Use the approved tool.");
  const resumed = await openSession({
    file: join(cwd, ".lean/history.json"),
    cwd,
  });
  await runTurn({
    cwd,
    input: "Continue",
    model,
    session: resumed.session,
    signal,
    approve: async () => true,
    onText: () => undefined,
  });
  await resumed.close();
  const replay = JSON.stringify(bodies.at(-1));
  expect(replay).toContain(signature);
  expect(replay).toContain("Count");
  expect(replay.match(/Count/g)).toHaveLength(1);
  await subscriptions.close();
});
