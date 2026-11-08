import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Agent,
  Runner,
  applyPatchTool,
  protocol,
  shellTool,
  type Model,
  type ModelRequest,
} from "@openai/agents";
import { afterEach, expect, test, vi } from "vitest";
import { createSubscriptions, openCredentialStore } from "./auth.ts";

const homes: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function subscriptionModel(): Promise<{
  model: Model;
  close: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "lean-subscription-tools-"));
  homes.push(directory);
  const store = openCredentialStore(directory);
  await store.modify("openai", async () => ({
    type: "oauth" as const,
    access: "synthetic-openai-access",
    refresh: "synthetic-openai-refresh",
    expires: Date.now() + 3_600_000,
  }));
  await store.close();
  const subscriptions = createSubscriptions({
    home: directory,
    env: { OPENAI_API_KEY: "", LEAN_HOME: directory },
  });
  const model = await subscriptions.resolveModel({
    provider: "openai",
    model: "gpt-5.4",
  });
  if (typeof model === "string")
    throw new Error("Expected a subscription model.");
  return { model, close: () => subscriptions.close() };
}

function request(
  input: ModelRequest["input"],
  tools: ModelRequest["tools"] = [
    {
      type: "function",
      name: "read",
      description: "Read a file.",
      strict: false,
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    { type: "shell", name: "shell" },
    { type: "apply_patch", name: "apply_patch" },
  ],
): ModelRequest {
  return {
    input,
    modelSettings: { temperature: 0.2, store: true },
    tools,
    outputType: "text",
    handoffs: [],
    tracing: false,
  };
}

function sse(output: unknown[]): string {
  const events = [
    { type: "response.created", response: { id: "resp_test" } },
    {
      type: "response.completed",
      response: {
        id: "resp_test",
        output,
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    },
  ];
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

function stubResponses(outputFor: (call: number) => unknown[]): void {
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls += 1;
    return new Response(sse(outputFor(calls)), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
}

function functionCall(
  name: string,
  args: unknown,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `fc_${name}`,
    type: "function_call",
    call_id: `call_${name}`,
    name,
    arguments: JSON.stringify(args),
    ...fields,
  };
}

test("native history is sent as function calls without native item ids", async () => {
  const shell = protocol.ShellCallItem.parse({
    type: "shell_call",
    id: "sh_persisted",
    callId: "call_shell",
    action: { commands: ["printf x"], timeoutMs: 1000 },
    providerData: { note: "kept-meta" },
  });
  const shellResult = protocol.ShellCallResultItem.parse({
    type: "shell_call_output",
    id: "sh_output",
    callId: "call_shell",
    output: [
      { stdout: "x", stderr: "", outcome: { type: "exit", exitCode: 1 } },
    ],
  });
  const patch = protocol.ApplyPatchCallItem.parse({
    type: "apply_patch_call",
    id: "toolu_patch",
    callId: "toolu_call",
    status: "completed",
    operation: { type: "update_file", path: "a.txt", diff: "@@\n-a\n+b\n" },
  });
  const patchResult = protocol.ApplyPatchCallResultItem.parse({
    type: "apply_patch_call_output",
    id: "toolu_patch_out",
    callId: "toolu_call",
    status: "failed",
    output: "nope",
  });
  const read = protocol.FunctionCallItem.parse({
    type: "function_call",
    id: "fc_read",
    callId: "call_read",
    name: "read",
    status: "completed",
    arguments: JSON.stringify({ path: "note.txt" }),
  });
  const reasoning = protocol.ReasoningItem.parse({
    type: "reasoning",
    id: "rs_keep",
    content: [{ type: "input_text", text: "hidden" }],
    providerData: { encrypted_content: "enc_secret" },
  });
  const compaction = protocol.CompactionItem.parse({
    type: "compaction",
    id: "cmp_keep",
    encrypted_content: "enc_compact",
    created_by: "resp_old",
  });
  const user = protocol.UserMessageItem.parse({
    type: "message",
    id: "msg_keep",
    role: "user",
    content: "Next",
  });
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      sse([
        {
          id: "msg_done",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Done." }],
        },
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  });
  const selected = await subscriptionModel();
  const sent = request([
    reasoning,
    compaction,
    shell,
    shellResult,
    patch,
    patchResult,
    read,
    user,
  ]);
  const original = structuredClone(sent);
  await selected.model.getResponse(sent);
  const body = bodies[0];
  if (!isRecord(body) || !Array.isArray(body.input)) {
    throw new Error("Expected a request body.");
  }
  const serialized = JSON.stringify(body.input);
  expect(serialized).not.toContain("sh_persisted");
  expect(serialized).not.toContain("sh_output");
  expect(serialized).not.toContain("toolu_patch");
  expect(serialized).not.toContain('"shell_call"');
  expect(serialized).not.toContain('"apply_patch_call"');
  expect(serialized).toContain("call_shell");
  expect(serialized).toContain("toolu_call");
  expect(serialized).toContain("fc_read");
  expect(serialized).toContain("rs_keep");
  expect(serialized).toContain("enc_secret");
  expect(serialized).toContain("cmp_keep");
  expect(serialized).toContain("enc_compact");
  expect(serialized).toContain("msg_keep");
  expect(serialized).toContain("kept-meta");
  const shellWire = body.input.find(
    (item) =>
      isRecord(item) &&
      item.call_id === "call_shell" &&
      item.type === "function_call",
  );
  const shellOutput = body.input.find(
    (item) =>
      isRecord(item) &&
      item.call_id === "call_shell" &&
      item.type === "function_call_output",
  );
  const patchOutput = body.input.find(
    (item) =>
      isRecord(item) &&
      item.call_id === "toolu_call" &&
      item.type === "function_call_output",
  );
  if (
    !isRecord(shellWire) ||
    !isRecord(shellOutput) ||
    !isRecord(patchOutput)
  ) {
    throw new Error("Expected projected function calls.");
  }
  expect(shellWire.status).toBeUndefined();
  expect(shellWire.id).toBeUndefined();
  expect(JSON.parse(String(shellWire.arguments))).toEqual({
    action: { commands: ["printf x"], timeoutMs: 1000 },
  });
  const shellBody = JSON.parse(String(shellOutput.output));
  expect(shellOutput.status).toBe("completed");
  expect(shellBody.status).toBeUndefined();
  expect(shellBody.output).toEqual([
    { stdout: "x", stderr: "", outcome: { type: "exit", exitCode: 1 } },
  ]);
  expect(JSON.parse(String(patchOutput.output))).toEqual({
    status: "failed",
    output: "nope",
  });
  expect(sent).toEqual(original);
  await selected.close();
});

test("completed calls are restored and unrelated response items stay intact", async () => {
  stubResponses(() => [
    {
      id: "rs_keep",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "hidden" }],
      encrypted_content: "enc_secret",
    },
    {
      id: "cmp_keep",
      type: "compaction",
      encrypted_content: "enc_compact",
    },
    functionCall(
      "shell",
      { action: { commands: ["printf x"], timeoutMs: 5 } },
      { status: "completed", caller: { type: "direct" } },
    ),
    functionCall(
      "apply_patch",
      { operation: { type: "delete_file", path: "a.txt" } },
      { status: "completed" },
    ),
    functionCall("read", { path: "note.txt" }, { status: "completed" }),
  ]);
  const selected = await subscriptionModel();
  const response = await selected.model.getResponse(request("Say hello"));
  expect(response.responseId).toBe("resp_test");
  expect(response.usage.inputTokens).toBe(3);
  expect(response.output).toEqual([
    expect.objectContaining({
      type: "reasoning",
      id: "rs_keep",
      providerData: expect.objectContaining({
        encrypted_content: "enc_secret",
      }),
    }),
    expect.objectContaining({
      type: "compaction",
      id: "cmp_keep",
      encrypted_content: "enc_compact",
    }),
    expect.objectContaining({
      type: "shell_call",
      id: "fc_shell",
      callId: "call_shell",
      status: "completed",
      caller: { type: "direct" },
      action: { commands: ["printf x"], timeoutMs: 5 },
    }),
    expect.objectContaining({
      type: "apply_patch_call",
      id: "fc_apply_patch",
      callId: "call_apply_patch",
      status: "completed",
      operation: { type: "delete_file", path: "a.txt" },
    }),
    expect.objectContaining({
      type: "function_call",
      id: "fc_read",
      callId: "call_read",
      name: "read",
      arguments: JSON.stringify({ path: "note.txt" }),
    }),
  ]);
  const patch = response.output[3];
  if (!patch || patch.type !== "apply_patch_call") {
    throw new Error("Expected a restored patch call.");
  }
  expect(patch.status).toBe("completed");
  await selected.close();
});

test.for(["incomplete", "in_progress"] as const)(
  "a shell call marked %s is rejected before execution",
  async (status) => {
    stubResponses(() => [
      functionCall("shell", { action: { commands: ["printf x"] } }, { status }),
    ]);
    const selected = await subscriptionModel();
    await expect(
      selected.model.getResponse(request("Say hello")),
    ).rejects.toThrow(
      new RegExp(`The shell call is ${status} and cannot be approved`),
    );
    await selected.close();
  },
);

test("an omitted shell status can be approved once and denial does not run it", async () => {
  const runs: string[][] = [];
  stubResponses((call) =>
    call % 2 === 1
      ? [functionCall("shell", { action: { commands: ["printf x"] } })]
      : [
          {
            id: "msg_done",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Finished." }],
          },
        ],
  );
  const selected = await subscriptionModel();
  const agent = new Agent({
    name: "lean",
    instructions: "test",
    model: selected.model,
    tools: [
      shellTool({
        needsApproval: true,
        shell: {
          async run(action) {
            runs.push([...action.commands]);
            return {
              output: [
                {
                  stdout: "x",
                  stderr: "",
                  outcome: { type: "exit", exitCode: 0 },
                },
              ],
            };
          },
        },
      }),
    ],
  });
  const runner = new Runner({
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
  });
  const denied = await runner.run(agent, "Run it.", { maxTurns: 2 });
  expect(denied.interruptions).toHaveLength(1);
  const interruption = denied.interruptions[0];
  if (
    interruption === undefined ||
    interruption.rawItem.type !== "shell_call"
  ) {
    throw new Error("Expected a shell approval.");
  }
  expect(interruption.rawItem.status).toBeUndefined();
  expect(interruption.rawItem.action.commands).toEqual(["printf x"]);
  denied.state.reject(interruption);
  const afterDenial = await runner.run(agent, denied.state, { maxTurns: 2 });
  expect(afterDenial.interruptions).toHaveLength(0);
  expect(runs).toEqual([]);
  const approved = await runner.run(agent, "Run it.", { maxTurns: 2 });
  const next = approved.interruptions[0];
  if (next === undefined) throw new Error("Expected a second approval.");
  approved.state.approve(next);
  await runner.run(agent, approved.state, { maxTurns: 2 });
  expect(runs).toEqual([["printf x"]]);
  await selected.close();
});

test.for([undefined, "incomplete", "in_progress"] as const)(
  "a patch call with status %s is rejected before execution",
  async (status) => {
    const edit = vi.fn(async () => ({ status: "completed" as const }));
    stubResponses(() => [
      functionCall(
        "apply_patch",
        { operation: { type: "create_file", path: "count.txt", diff: "+x" } },
        { status },
      ),
    ]);
    const selected = await subscriptionModel();
    const agent = new Agent({
      name: "lean",
      instructions: "test",
      model: selected.model,
      tools: [
        applyPatchTool({
          needsApproval: true,
          editor: { createFile: edit, updateFile: edit, deleteFile: edit },
        }),
      ],
    });
    const runner = new Runner({ tracingDisabled: true });
    await expect(runner.run(agent, "Edit it.")).rejects.toThrow(
      `The apply_patch call is ${status ?? "missing a status"} and cannot be approved.`,
    );
    expect(edit).not.toHaveBeenCalled();
    await selected.close();
  },
);

test.for([
  ["shell", "{", /Shell arguments do not match the shell tool/],
  [
    "shell",
    JSON.stringify({ commands: ["printf x"] }),
    /Shell arguments do not match the shell tool/,
  ],
  [
    "apply_patch",
    JSON.stringify({ operation: { type: "create_file", path: "a.txt" } }),
    /Patch arguments do not match the apply_patch tool/,
  ],
] as const)(
  "malformed %s arguments are rejected",
  async ([name, args, message]) => {
    stubResponses(() => [
      {
        id: "fc_bad",
        type: "function_call",
        call_id: "call_bad",
        name,
        arguments: args,
        status: "completed",
      },
    ]);
    const selected = await subscriptionModel();
    await expect(
      selected.model.getResponse(request("Say hello")),
    ).rejects.toThrow(message);
    await selected.close();
  },
);
