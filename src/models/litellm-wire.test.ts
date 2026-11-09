import { beforeEach, describe, expect, test, vi } from "vitest";
import { receiveResponse } from "./received-response.ts";
import { FormatError } from "../exceptions.ts";
import { UnsupportedParamsError } from "./errors.ts";
import { getModel, getModelClass } from "./index.ts";
import { LitellmModel, LitellmModelConfig } from "./litellm-model.ts";
import { GLOBAL_MODEL_STATS } from "./stats.ts";
import { DEFAULT_MULTIMODAL_REGEX } from "./utils/multimodal.ts";

vi.mock("./received-response.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./received-response.ts")>()),
  receiveResponse: vi.fn(),
}));
let requests: Array<{
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}> = [];

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
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({ url: path, headers, body: parsed });
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

const bashTool = {
  name: "bash",
  description: "Execute a bash command",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The bash command to execute",
      },
    },
    required: ["command"],
  },
  type: "custom",
};

describe("litellm wire", () => {
  test("claude history matches the pinned completion request", async () => {
    await mockResponse(() => ({
      body: {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", signature: "sig_1" },
          { type: "text", text: "ok" },
          {
            type: "tool_use",
            id: "toolu_next",
            name: "bash",
            input: { command: "true" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }));
    const model = getModel("anthropic/claude-sonnet-4-5-20250929", {
      model_kwargs: {
        drop_params: true,
        api_key: "fixture",
        api_base: "http://model.test",
        frequency_penalty: 0.5,
        extra_headers: { "X-Test": "yes" },
        extra_body: { metadata: { user_id: "u1" } },
        not_a_real_param: 1,
      },
    });
    const first = await model.query([
      { role: "system", content: "be brief" },
      { role: "user", content: "task" },
    ]);
    expect(requests[0]?.body.drop_params).toBeUndefined();
    expect(requests[0]?.body.frequency_penalty).toBeUndefined();
    expect(requests[0]?.body.max_tokens).toBe(64000);
    expect(requests[0]?.body.not_a_real_param).toBe(1);
    expect(requests[0]?.body.extra_body).toEqual({
      metadata: { user_id: "u1" },
    });
    expect(requests[0]?.headers["x-test"]).toBe("yes");
    expect(requests[0]?.body.system).toEqual([
      { type: "text", text: "be brief" },
    ]);
    expect(requests[0]?.body.tools).toEqual([bashTool]);
    expect(requests[0]?.body.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "task",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
    expect(first.content).toBe("ok");
    expect(first.thinking_blocks).toEqual([
      { type: "thinking", thinking: "hmm", signature: "sig_1" },
    ]);
    expect(first.reasoning_content).toBe("hmm");
    expect(first.extra?.actions).toEqual([
      { command: "true", tool_call_id: "toolu_next" },
    ]);

    await model.query([
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: "run",
        tool_calls: [
          {
            id: "toolu_1",
            type: "function",
            function: { name: "bash", arguments: '{"command":"one"}' },
          },
          {
            id: "toolu_2",
            type: "function",
            function: { name: "bash", arguments: '{"command":"two"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "toolu_1",
        content: "first observation",
      },
      {
        role: "tool",
        tool_call_id: "toolu_2",
        content: "second observation",
      },
    ]);
    expect(requests[1]?.body.drop_params).toBeUndefined();
    expect(requests[1]?.body.max_tokens).toBe(64000);
    expect(requests[1]?.body.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "task" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "run" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "bash",
            input: { command: "one" },
          },
          {
            type: "tool_use",
            id: "toolu_2",
            name: "bash",
            input: { command: "two" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "first observation",
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: [{ type: "text", text: "second observation" }],
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);

    await model.query([{ role: "user", content: "task" }, first]);
    const replay = requests[2]?.body.messages as Array<{
      role?: string;
      content?: unknown;
    }>;
    expect(replay[1]?.content).toEqual([
      { type: "thinking", thinking: "hmm", signature: "sig_1" },
      { type: "text", text: "ok", cache_control: { type: "ephemeral" } },
      {
        type: "tool_use",
        id: "toolu_next",
        name: "bash",
        input: { command: "true" },
      },
    ]);
  });

  test("refuses an unsupported anthropic parameter when drop_params is false", async () => {
    await mockResponse(() => ({ body: {} }));
    const model = new LitellmModel({
      model_name: "anthropic/claude-sonnet-4-5-20250929",
      model_kwargs: {
        api_base: "http://model.test",
        api_key: "fixture",
        drop_params: false,
        frequency_penalty: 0.5,
      },
    });
    await expect(
      model.query([{ role: "user", content: "task" }]),
    ).rejects.toBeInstanceOf(UnsupportedParamsError);
    expect(requests).toHaveLength(0);
  });

  test("merges openai extra_body and does not speak bedrock", async () => {
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
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: '{"command":"echo hi"}',
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      },
    }));
    const model = new LitellmModel({
      model_name: "my-model",
      cost_tracking: "ignore_errors",
      model_kwargs: {
        api_base: "http://model.test/v1",
        api_key: "fixture",
        custom_llm_provider: "openai",
        drop_params: true,
        extra_body: { metadata: { user_id: "u1" } },
      },
    });
    await model.query([{ role: "user", content: "task" }]);
    expect(requests[0]?.url).toBe("/v1/chat/completions");
    expect(requests[0]?.body.model).toBe("my-model");
    expect(requests[0]?.body.metadata).toEqual({ user_id: "u1" });
    expect(requests[0]?.body.drop_params).toBeUndefined();
    expect(requests[0]?.body.extra_body).toBeUndefined();

    const bedrock = new LitellmModel({
      model_name: "bedrock/anthropic.claude-3-haiku-20240307-v1:0",
      model_kwargs: {
        api_base: "http://model.test",
        api_key: "fixture",
        drop_params: true,
      },
    });
    const previousStop = process.env.MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT;
    process.env.MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT = "1";
    try {
      await expect(
        bedrock.query([{ role: "user", content: "task" }]),
      ).rejects.toThrow(/bedrock/);
    } finally {
      if (previousStop === undefined) {
        delete process.env.MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT;
      } else {
        process.env.MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT = previousStop;
      }
    }
    expect(requests).toHaveLength(1);
  });

  test("sends a multimodal tool observation as an anthropic image block", async () => {
    await mockResponse(() => ({
      body: {
        content: [
          {
            type: "tool_use",
            id: "toolu_next",
            name: "bash",
            input: { command: "true" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    }));
    const model = getModel("anthropic/claude-sonnet-4-5-20250929", {
      model_kwargs: {
        api_base: "http://model.test",
        api_key: "fixture",
        drop_params: true,
      },
      set_cache_control: null,
      multimodal_regex: DEFAULT_MULTIMODAL_REGEX,
    });
    const image =
      "see <MSWEA_MULTIMODAL_CONTENT><CONTENT_TYPE>image_url</CONTENT_TYPE>\nhttps://example.com/a.png\n</MSWEA_MULTIMODAL_CONTENT>";
    const observations = await model.format_observation_messages(
      { extra: { actions: [{ command: "true", tool_call_id: "toolu_img" }] } },
      [{ output: image, returncode: 0, exception_info: "" }],
    );
    await model.query([
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "toolu_img",
            type: "function",
            function: { name: "bash", arguments: '{"command":"true"}' },
          },
        ],
      },
      ...observations,
    ]);
    const sent = requests[0]?.body.messages as Array<{ content: unknown }>;
    const last = sent.at(-1)?.content as Array<Record<string, unknown>>;
    const result = last.find((block) => block.type === "tool_result");
    expect(JSON.stringify(result?.content)).not.toContain(
      "MSWEA_MULTIMODAL_CONTENT",
    );
    expect(result?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("see"),
        }),
        {
          type: "image",
          source: { type: "url", url: "https://example.com/a.png" },
        },
      ]),
    );
  });

  test("retries inside one completion when num_retries is set", async () => {
    let calls = 0;
    await mockResponse(() => {
      calls += 1;
      if (calls === 1) return { status: 500, body: { error: "busy" } };
      return {
        body: {
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: '{"command":"true"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        },
      };
    });
    const delays: number[] = [];
    const model = new LitellmModel({
      model_name: "gpt-4o",
      model_kwargs: {
        api_base: "http://model.test/v1",
        num_retries: 1,
      },
    });
    model.sleep = async (milliseconds) => {
      delays.push(milliseconds);
    };
    await model.query([{ role: "user", content: "task" }]);
    expect(calls).toBe(2);
    expect(delays).toEqual([]);
  });

  test("keeps the module-load cost tracking default", () => {
    const previous = process.env.MSWEA_COST_TRACKING;
    process.env.MSWEA_COST_TRACKING =
      new LitellmModelConfig({}).cost_tracking === "default"
        ? "ignore_errors"
        : "default";
    try {
      expect(new LitellmModelConfig({}).cost_tracking).toBe(
        new LitellmModel({ model_name: "gpt-4o" }).config.cost_tracking,
      );
      expect(new LitellmModelConfig({}).cost_tracking).not.toBe(
        process.env.MSWEA_COST_TRACKING,
      );
    } finally {
      if (previous === undefined) delete process.env.MSWEA_COST_TRACKING;
      else process.env.MSWEA_COST_TRACKING = previous;
    }
  });

  test("resolves built-in dotted model class names", () => {
    expect(getModelClass("", "litellm").name).toBe("LitellmModel");
    expect(getModelClass("", "litellm_textbased").name).toBe(
      "LitellmTextbasedModel",
    );
    expect(getModelClass("", "litellm_response").name).toBe(
      "LitellmResponseModel",
    );
    expect(
      getModelClass(
        "",
        "minisweagent.models.litellm_response_model.LitellmResponseModel",
      ).name,
    ).toBe("LitellmResponseModel");
    expect(
      getModelClass("", "minisweagent.models.litellm_model.LitellmModel").name,
    ).toBe("LitellmModel");
    expect(() => getModelClass("", "openrouter")).toThrow(
      /Unknown model class/,
    );
  });
});

describe("malformed response persistence", () => {
  test("stores a repr when response serialization throws", async () => {
    class Boom extends LitellmModel {
      protected override async request(): Promise<unknown> {
        class BrokenResponse {
          choices = [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "no tool" },
            },
          ];
          usage = { prompt_tokens: 10, completion_tokens: 1 };
          model_dump() {
            throw new Error("dump failed");
          }
          toString() {
            return "repr-response";
          }
        }
        return new BrokenResponse();
      }
    }
    const model = new Boom({
      model_name: "gpt-4o",
      cost_tracking: "ignore_errors",
    });
    await expect(model.query([])).rejects.toBeInstanceOf(FormatError);
    try {
      await model.query([]);
    } catch (error) {
      expect(error).toBeInstanceOf(FormatError);
      if (error instanceof FormatError) {
        expect(error.messages[0]?.extra?.response).toBe("repr-response");
      }
    }
  });
});
