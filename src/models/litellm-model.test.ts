import { receiveResponse } from "./received-response.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { FormatError } from "../exceptions.ts";
import { AuthenticationError } from "./errors.ts";
import { LitellmModel } from "./litellm-model.ts";
import { LitellmTextbasedModel } from "./litellm-textbased-model.ts";
import { getModel } from "./index.ts";
import { GLOBAL_MODEL_STATS } from "./stats.ts";

vi.mock("./received-response.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./received-response.ts")>()),
  receiveResponse: vi.fn(),
}));
let requests: Array<{ url?: string; body: Record<string, unknown> }> = [];

beforeEach(() => {
  GLOBAL_MODEL_STATS.reset();
  requests = [];
  vi.mocked(receiveResponse).mockReset();
});

async function mockResponse(
  handler: (
    body: Record<string, unknown>,
    url: string | undefined,
  ) => { status?: number; body: unknown },
) {
  vi.mocked(receiveResponse).mockImplementation(async (url, init) => {
    const path = new URL(url).pathname;
    const parsed = JSON.parse(String(init.body));
    requests.push({ url: path, body: parsed });
    const result = handler(parsed, path);
    const bytes = new TextEncoder().encode(JSON.stringify(result.body));
    const status = result.status ?? 200;
    return {
      bytes,
      text: new TextDecoder().decode(bytes),
      status,
      statusText: "fixture",
      ok: status >= 200 && status < 300,
    };
  });
}

describe("LitellmModel", () => {
  test("sends one bash tool and keeps the provider response on the assistant message", async () => {
    await mockResponse(() => ({
      body: {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "looking",
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: '{"command":"echo one","extra":1}',
                  },
                },
                {
                  id: "call-2",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: '{"command":"echo two"}',
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      },
    }));
    const model = new LitellmModel({
      model_name: "openai/gpt-4o",
      model_kwargs: { api_base: "http://model.test/v1", temperature: 0 },
    });
    const message = await model.query([
      { role: "user", content: "go", extra: { secret: true } },
    ]);
    expect(requests[0]?.body.model).toBe("gpt-4o");
    expect(requests[0]?.body.temperature).toBe(0);
    expect(requests[0]?.body.messages).toEqual([
      { role: "user", content: "go" },
    ]);
    const tools = requests[0]?.body.tools as Array<{
      function: { name: string };
    }>;
    expect(tools.map((tool) => tool.function.name)).toEqual(["bash"]);
    expect(message.tool_calls).toHaveLength(2);
    expect(message.extra?.actions).toEqual([
      { command: "echo one", tool_call_id: "call-1" },
      { command: "echo two", tool_call_id: "call-2" },
    ]);
    expect(message.extra?.cost).toBeCloseTo(0.0075);
    expect(message.extra?.response).toMatchObject({
      choices: [{ finish_reason: "tool_calls" }],
    });
    expect(GLOBAL_MODEL_STATS.cost).toBeCloseTo(0.0075);
    expect(GLOBAL_MODEL_STATS.n_calls).toBe(1);
  });

  test("bills a malformed tool call and does not retry an authentication error", async () => {
    let calls = 0;
    await mockResponse(() => {
      calls += 1;
      if (calls === 1) {
        return {
          body: {
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    { id: "bad", function: { name: "other", arguments: "{}" } },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 1000, completion_tokens: 0 },
          },
        };
      }
      return { status: 401, body: { error: { message: "bad key" } } };
    });
    const model = new LitellmModel({
      model_name: "gpt-4o",
      model_kwargs: {
        api_base: "http://model.test/v1",
        api_key: "test-key",
      },
    });
    try {
      await model.query([]);
      throw new Error("expected a format error");
    } catch (error) {
      expect(error).toBeInstanceOf(FormatError);
      if (error instanceof FormatError) {
        expect(error.messages[0]?.extra?.cost).toBeCloseTo(0.0025);
        expect(error.messages[0]?.extra?.response).toMatchObject({
          choices: [{ message: { tool_calls: [{ id: "bad" }] } }],
        });
      }
    }
    await expect(model.query([])).rejects.toBeInstanceOf(AuthenticationError);
    expect(calls).toBe(2);
    await expect(model.query([])).rejects.toThrow(/mini-extra config set/);
    expect(calls).toBe(3);
  });

  test("keeps the outer four-second retry floor when SDK retries are disabled", async () => {
    let calls = 0;
    await mockResponse(() => {
      calls += 1;
      if (calls < 3) return { status: 500, body: { error: "busy" } };
      return {
        body: {
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "```mswea_bash_command\necho hi\n```",
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        },
      };
    });
    const delays: number[] = [];
    const model = new LitellmTextbasedModel({
      model_name: "gpt-4o",
      model_kwargs: { api_base: "http://model.test/v1", num_retries: 0 },
    });
    model.sleep = async (milliseconds) => {
      delays.push(milliseconds);
    };
    const message = await model.query([{ role: "user", content: "go" }]);
    expect(delays).toEqual([4000, 4000]);
    expect(calls).toBe(3);
    expect(requests.every((request) => request.body.tools === undefined)).toBe(
      true,
    );
    expect(message.extra?.actions).toEqual([{ command: "echo hi" }]);
    const observations = model.format_observation_messages(message, [
      { output: "hi\n", returncode: 0, exception_info: "" },
    ]);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.role).toBe("user");
  });

  test("places cache control on the last message for claude and prices the returned cache tokens", async () => {
    await mockResponse((body) => ({
      body: {
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "ok" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "bash",
            input: { command: "pwd" },
          },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 50,
          output_tokens: 50,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 10,
        },
      },
    }));
    const model = getModel("anthropic/claude-sonnet-4-5-20250929", {
      model_kwargs: { api_base: "http://model.test" },
      cost_tracking: "default",
    });
    const message = await model.query([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "noted" },
      { role: "user", content: "now" },
    ]);
    expect(requests[0]?.url).toBe("/v1/messages");
    const sent = requests[0]?.body.messages as Array<{ content: unknown }>;
    expect(sent[0]?.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(sent[1]?.content).toEqual([{ type: "text", text: "noted" }]);
    const last = sent.at(-1)?.content as Array<{
      cache_control?: { type: string };
      text?: string;
    }>;
    expect(last[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(last[0]?.text).toBe("now");
    expect(requests[0]?.body.tools).toEqual([
      expect.objectContaining({
        name: "bash",
        input_schema: expect.objectContaining({ type: "object" }),
      }),
    ]);
    expect(message.extra?.actions).toEqual([
      { command: "pwd", tool_call_id: "toolu_1" },
    ]);
    expect(message.extra?.cost).toBeCloseTo(0.0009495);
    expect(message.content).toBe("ok");
    expect(message.thinking_blocks).toEqual([
      { type: "thinking", thinking: "hmm" },
    ]);
    expect(message.reasoning_content).toBe("hmm");
  });

  test("uses a custom registry file and ignores a zero cost when asked", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lean-cost-"));
    const registry = join(directory, "models.json");
    await writeFile(
      registry,
      JSON.stringify({
        "local/free": { input_cost_per_token: 0, output_cost_per_token: 0 },
      }),
    );
    await mockResponse(() => ({
      body: {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "c",
                  function: { name: "bash", arguments: '{"command":"true"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    }));
    const model = new LitellmModel({
      model_name: "local/free",
      litellm_model_registry: registry,
      cost_tracking: "ignore_errors",
      model_kwargs: { api_base: "http://model.test/v1" },
    });
    const message = await model.query([]);
    expect(message.extra?.cost).toBe(0);
    await rm(directory, { recursive: true, force: true });
  });
});
