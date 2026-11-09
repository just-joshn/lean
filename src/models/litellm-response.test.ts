import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FormatError } from "../exceptions.ts";
import { getModel } from "./index.ts";
import { LitellmResponseModel } from "./litellm-response-model.ts";
import { GLOBAL_MODEL_STATS } from "./stats.ts";
import type { Message } from "../protocols.ts";

let server: Server | undefined;
let requests: Array<{ url?: string; body: Record<string, unknown> }> = [];

beforeEach(() => {
  GLOBAL_MODEL_STATS.reset();
  requests = [];
});

afterEach(async () => {
  const current = server;
  server = undefined;
  if (!current) return;
  current.closeAllConnections();
  await new Promise<void>((resolve) => current.close(() => resolve()));
});

async function listen(body: Record<string, unknown>) {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        url: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
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
    const port = await listen({
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
        api_base: `http://127.0.0.1:${port}/v1`,
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
        metadata: { raw: true },
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
      },
      { role: "user", content: "next" },
    ]);
  });

  test("maps incomplete max_output_tokens to length and keeps malformed arguments", async () => {
    const port = await listen({
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
      model_kwargs: { api_base: `http://127.0.0.1:${port}/v1` },
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
