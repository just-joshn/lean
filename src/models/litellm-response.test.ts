import { beforeEach, describe, expect, test, vi } from "vitest";
import { receiveResponse } from "./received-response.ts";
import { FormatError } from "../exceptions.ts";
import { getModel } from "./index.ts";
import { LitellmResponseModel } from "./litellm-response-model.ts";
import { GLOBAL_MODEL_STATS } from "./stats.ts";
import type { Message } from "../protocols.ts";

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

async function mockResponse(body: Record<string, unknown>) {
  vi.mocked(receiveResponse).mockImplementation(async (url, init) => {
    requests.push({
      url: new URL(url).pathname,
      body: JSON.parse(String(init.body)),
    });
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    return {
      bytes,
      text: new TextDecoder().decode(bytes),
      status: 200,
      statusText: "OK",
      ok: true,
    };
  });
}

const functionCall = {
  type: "function_call",
  call_id: "call_1",
  name: "bash",
  arguments: '{"command":"echo hi"}',
  extra: { hidden: true },
  metadata: { raw: true },
};

describe("LitellmResponseModel", () => {
  test("sends the flat bash tool and replays output without extra", async () => {
    await mockResponse({
      id: "resp_1",
      object: "response",
      created_at: 1,
      status: "completed",
      output: [functionCall],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
    const model = getModel("openai/gpt-4o", {
      model_class: "litellm_response",
      model_kwargs: {
        api_base: "http://model.test/v1",
        api_key: "fixture",
        drop_params: true,
      },
    });
    const first = await model.query([{ role: "user", content: "task" }]);
    expect(requests[0]?.url).toBe("/v1/responses");
    expect(requests[0]?.body.drop_params).toBeUndefined();
    expect(requests[0]?.body.tools).toEqual([
      {
        type: "function",
        name: "bash",
        description: "Execute a bash command",
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The bash command to execute",
            },
          },
          required: ["command"],
        },
      },
    ]);
    expect(first.object).toBe("response");
    expect(first.extra?.actions).toEqual([
      { command: "echo hi", tool_call_id: "call_1" },
    ]);
    expect(first.extra?.cost).toBeCloseTo(0.000075);
    expect(GLOBAL_MODEL_STATS.cost).toBeCloseTo(0.000075);
    expect(first.output).toEqual([
      {
        type: "function_call",
        call_id: "call_1",
        name: "bash",
        arguments: '{"command":"echo hi"}',
        extra: { hidden: true },
        metadata: { raw: true },
        id: null,
        async_: null,
        caller: null,
        namespace: null,
        status: null,
      },
    ]);

    await model.query([
      first,
      { role: "user", content: "next", extra: { skip: 1 } },
    ]);
    expect(requests[1]?.body.input).toEqual([
      {
        type: "function_call",
        call_id: "call_1",
        name: "bash",
        arguments: '{"command":"echo hi"}',
        metadata: { raw: true },
        id: null,
        async_: null,
        caller: null,
        namespace: null,
        status: null,
      },
      { role: "user", content: "next" },
    ]);
  });

  test("maps incomplete max_output_tokens to length and keeps malformed arguments", async () => {
    await mockResponse({
      id: "resp_bad",
      created_at: 1,
      object: "response",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        {
          type: "function_call",
          call_id: "call_bad",
          name: "bash",
          arguments: "{",
        },
      ],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    });
    const model = new LitellmResponseModel({
      model_name: "gpt-4o",
      model_kwargs: { api_base: "http://model.test/v1" },
      format_error_template: "{{ finish_reason }}: {{ error }}",
      cost_tracking: "ignore_errors",
    });
    await expect(model.query([])).rejects.toBeInstanceOf(FormatError);
    try {
      await model.query([]);
    } catch (error) {
      expect(error).toBeInstanceOf(FormatError);
      if (!(error instanceof FormatError)) return;
      const content = error.messages[0]?.content as Array<{ text?: string }>;
      expect(content[0]?.text).toContain("length");
      expect(content[0]?.text).toContain("Error parsing tool call arguments");
      const persisted = error.messages[0]?.extra?.response as Message;
      const output = persisted.output as Array<{ arguments?: string }>;
      expect(output[0]?.arguments).toBe("{");
      expect(error.messages[0]?.extra?.cost).toBeCloseTo(0.0000175);
    }
  });

  test("pads missing outputs and keeps a human command as a user message", () => {
    const model = new LitellmResponseModel({ model_name: "gpt-4o" });
    const messages = model.format_observation_messages(
      {
        extra: {
          actions: [
            { command: "one", tool_call_id: "call_1" },
            { command: "two" },
          ],
        },
      },
      [{ output: "ran", returncode: 0, exception_info: "" }],
    );
    expect(messages[0]?.type).toBe("function_call_output");
    expect(messages[0]?.call_id).toBe("call_1");
    expect(messages[0]?.output).toContain("ran");
    expect(messages[1]?.role).toBe("user");
    expect(JSON.stringify(messages[1]?.content)).toContain(
      "action was not executed",
    );
  });
});
