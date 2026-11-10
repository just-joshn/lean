import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { LocalEnvironment } from "../environments/local.ts";
import { Submitted } from "../exceptions.ts";
import { LitellmModel } from "../models/litellm-model.ts";
import { OpenRouterModel } from "../models/provider-models.ts";
import * as responseTransport from "../models/received-response.ts";
import { DEFAULT_MULTIMODAL_REGEX } from "../models/utils/multimodal.ts";
import type { Message } from "../protocols.ts";
import { createTuiSession } from "./tui-agent.ts";
import { replayItems } from "./tui-replay.ts";
import { createTuiController, type TurnInput } from "./tui.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "lean-tui-agent-"));
  directories.push(cwd);
  const output = join(cwd, "run.traj.json");
  const environment = new LocalEnvironment({ cwd });
  const execute = vi
    .spyOn(environment, "execute")
    .mockImplementation(async (action) => {
      if (action.command === "submit")
        throw new Submitted({
          role: "exit",
          content: "done",
          extra: { exit_status: "Submitted", submission: "done" },
        });
      return { output: "apricot", returncode: 2, exception_info: "" };
    });
  const model = new LitellmModel({ model_name: "test" });
  const query = vi.spyOn(model, "query");
  const session = createTuiSession({
    environment,
    output,
    agentConfig: { system_template: "system", instance_template: "{{task}}" },
  });
  const input: TurnInput = {
    text: "first task",
    model,
    signal: new AbortController().signal,
    onText: vi.fn(),
    approve: vi.fn(async () => true),
  };
  return { cwd, output, execute, query, session, input };
}

function answer(command: string, id: string): Message {
  return {
    role: "assistant",
    content: `Running ${command}.`,
    extra: { actions: [{ command, tool_call_id: id }] },
  };
}

test("runs the new loop, asks for each bash action, inspects results, and saves a native trajectory", async () => {
  const { output, execute, query, session, input } = await fixture();
  query
    .mockResolvedValueOnce(answer("echo apricot", "a"))
    .mockResolvedValueOnce(answer("submit", "b"));
  await session.driver(input);
  await session.history.save();
  expect(input.approve).toHaveBeenNthCalledWith(
    1,
    JSON.stringify({ tool: "bash", command: "echo apricot" }),
  );
  expect(execute.mock.calls.map(([action]) => action.command)).toEqual([
    "echo apricot",
    "submit",
  ]);
  const entries = replayItems(await session.history.getItems());
  const action = entries.find((entry) => entry.kind === "action");
  expect(action).toMatchObject({
    kind: "action",
    action: {
      summary: "bash  echo apricot",
      status: "exit 2",
      output: "apricot",
    },
  });
  if (action?.kind !== "action") throw new Error("missing action");
  expect(action.action.raw).toContain('"returncode": 2');
  expect(input.onText).toHaveBeenCalledWith("Running echo apricot.\n");
  const saved = JSON.parse(await readFile(output, "utf8"));
  expect(saved).toMatchObject({
    trajectory_format: "mini-swe-agent-1.1",
    info: { exit_status: "Submitted", submission: "done" },
  });
  expect(saved.messages).toContainEqual(
    expect.objectContaining({
      role: "tool",
      tool_call_id: "a",
      extra: expect.objectContaining({ raw_output: "apricot" }),
    }),
  );
});

test("runs a dedicated provider through native TUI observations and saves its identity and billing", async () => {
  const { output, execute, session, input } = await fixture();
  const image = "https://example.invalid/image.png";
  execute.mockResolvedValueOnce({
    output: `before\n<MSWEA_MULTIMODAL_CONTENT><CONTENT_TYPE>image_url</CONTENT_TYPE>\n${image}\n</MSWEA_MULTIMODAL_CONTENT>\nafter`,
    returncode: 0,
    exception_info: "",
  });
  const receive = vi.spyOn(responseTransport, "receiveResponse");
  for (const [id, command] of [
    ["a", "echo image"],
    ["b", "submit"],
  ]) {
    const text = JSON.stringify({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: `Running ${command}.`,
            tool_calls: [
              {
                id,
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({ command }),
                },
              },
            ],
          },
        },
      ],
      usage: { cost: 0.01 },
    });
    receive.mockResolvedValueOnce({
      status: 200,
      text,
      bytes: new TextEncoder().encode(text),
      statusText: "fixture",
      ok: true,
    });
  }
  const model = new OpenRouterModel({
    model_name: "openai/gpt-4o",
    multimodal_regex: DEFAULT_MULTIMODAL_REGEX,
  });
  await session.driver({ ...input, model });
  await session.history.save();
  expect(receive).toHaveBeenCalledTimes(2);
  const request = JSON.parse(String(receive.mock.calls[1]?.[1].body));
  expect(request.messages).toContainEqual(
    expect.objectContaining({
      role: "tool",
      tool_call_id: "a",
      content: expect.arrayContaining([
        { type: "image_url", image_url: { url: image } },
        { type: "text", text: expect.stringContaining("before") },
        { type: "text", text: expect.stringContaining("after") },
      ]),
    }),
  );
  expect(input.onText).toHaveBeenCalledWith(
    "Running echo image.\n\n```\necho image\n```\n",
  );
  expect(input.approve).toHaveBeenCalledTimes(2);
  const saved = JSON.parse(await readFile(output, "utf8"));
  expect(saved.info).toMatchObject({
    exit_status: "Submitted",
    submission: "done",
    config: { model_type: OpenRouterModel.typeName },
    model_stats: { api_calls: 2, instance_cost: 0.02 },
  });
  expect(replayItems(await session.history.getItems())).toContainEqual(
    expect.objectContaining({
      kind: "action",
      action: expect.objectContaining({ status: "exit 0" }),
    }),
  );
});

test("keeps native results inspectable and the task outcome visible through the controller", async () => {
  const { cwd, output, query, session, input } = await fixture();
  query
    .mockResolvedValueOnce(answer("echo apricot", "a"))
    .mockResolvedValueOnce(answer("submit", "b"));
  const controller = await createTuiController({
    cwd,
    model: input.model,
    modelLabel: "test",
    providerLabel: "API key",
    sessionLabel: "memory only",
    demo: false,
    noColor: true,
    ...session,
  });
  try {
    controller.editDraft("first task");
    const turn = controller.submit();
    await expect.poll(() => controller.state.phase.kind).toBe("approval");
    controller.allow();
    await expect
      .poll(() =>
        controller.state.phase.kind === "approval"
          ? controller.state.phase.detail
          : "",
      )
      .toContain("submit");
    controller.allow();
    await turn;
    const actions = controller.state.transcript.flatMap((entry) =>
      entry.kind === "action" ? [entry.action] : [],
    );
    expect(actions[0]).toMatchObject({ output: "apricot", status: "exit 2" });
    expect(controller.state.transcript).toContainEqual({
      kind: "assistant",
      text: "Task ended (Submitted).\ndone",
    });
    controller.key("ctrl+o");
    controller.key("left");
    expect(controller.state.inspector).toMatchObject({
      open: true,
      callId: actions[0]?.callId,
    });
    const before = await readFile(output, "utf8");
    controller.editDraft("/clear");
    await controller.submit();
    expect(await readFile(output, "utf8")).toBe(before);
    expect(replayItems(await session.history.getItems())).toContainEqual({
      kind: "user",
      text: "first task",
    });
  } finally {
    await controller.shutdown();
  }
});

test("denies a command without executing it and returns the denial to the model", async () => {
  const { execute, query, session, input } = await fixture();
  query
    .mockResolvedValueOnce(answer("denied", "a"))
    .mockResolvedValueOnce(answer("submit", "b"));
  await session.driver({
    ...input,
    approve: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
  });
  expect(execute.mock.calls.map(([action]) => action.command)).toEqual([
    "submit",
  ]);
  expect(query.mock.calls[1]?.[0]).toContainEqual(
    expect.objectContaining({
      role: "tool",
      extra: expect.objectContaining({
        exception_info: "The user denied this command. It was not executed.",
      }),
    }),
  );
});

test("keeps screen history but starts fresh model context for the next task", async () => {
  const { query, session, input } = await fixture();
  query.mockResolvedValue(answer("submit", "same-id"));
  await session.driver(input);
  await session.history.save();
  await session.driver({ ...input, text: "second task" });
  await session.history.save();
  expect(
    query.mock.calls[1]?.[0].filter((message) => message.role === "user"),
  ).toEqual([{ role: "user", content: "second task" }]);
  expect(
    replayItems(await session.history.getItems()).filter(
      (entry) => entry.kind === "user",
    ),
  ).toEqual([
    { kind: "user", text: "first task" },
    { kind: "user", text: "second task" },
  ]);
});

test("waits for an in-flight query to settle on cancellation and never executes its actions or overwrites the trajectory", async () => {
  const { output, execute, query, session, input } = await fixture();
  await writeFile(output, "previous trajectory");
  let release!: (message: Message) => void;
  query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const abort = new AbortController();
  const turn = session.driver({ ...input, signal: abort.signal });
  await vi.waitFor(() => expect(query).toHaveBeenCalled());
  abort.abort();
  release(answer("must not run", "a"));
  await expect(turn).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
  expect(await session.history.getItems()).toEqual([]);
  expect(await readFile(output, "utf8")).toBe("previous trajectory");
});
