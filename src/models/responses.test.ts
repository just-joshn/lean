import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FormatError } from "../exceptions.ts";
import { LitellmResponseModel } from "./litellm-response-model.ts";
import {
  receiveResponse,
  ResponseReadError,
  type ReceivedResponse,
} from "./received-response.ts";
import { completeResponses } from "./responses.ts";
import { GLOBAL_MODEL_STATS } from "./stats.ts";

vi.mock("./received-response.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./received-response.ts")>()),
  receiveResponse: vi.fn(),
}));

interface Fixture {
  name: string;
  body: Record<string, unknown>;
  dump: Record<string, unknown>;
}
const fixtures: { cases: Fixture[] } = JSON.parse(
  readFileSync(
    new URL("./fixtures/responses-return.json", import.meta.url),
    "utf8",
  ),
);
const receive = vi.mocked(receiveResponse);

function received(text: string, status = 200): ReceivedResponse {
  const bytes = new TextEncoder().encode(text);
  return {
    bytes,
    text: new TextDecoder().decode(bytes),
    status,
    statusText: "fixture",
    ok: status >= 200 && status < 300,
  };
}
function respond(body: unknown) {
  receive.mockResolvedValue(received(JSON.stringify(body)));
}
function complete() {
  return completeResponses({ model: "openai/gpt-4o", input: [] });
}
class UnbilledResponseModel extends LitellmResponseModel {
  protected override costOf(): number {
    return 0;
  }
}
function model() {
  return new UnbilledResponseModel({ model_name: "openai/gpt-4o" });
}
const command = {
  type: "function_call",
  call_id: "command",
  name: "bash",
  arguments: '{"command":"pwd"}',
  extra: { provider: true },
  metadata: { retained: true },
};
const base = {
  id: "owned-response",
  created_at: 1,
  object: "response",
  model: "gpt-4o",
  output: [command],
};

beforeEach(() => {
  receive.mockReset();
  GLOBAL_MODEL_STATS.reset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Responses received return", () => {
  test.each(fixtures.cases)(
    "matches the source dump for $name",
    async ({ name, body, dump }) => {
      if (name === "null created_at") {
        vi.useFakeTimers();
        vi.setSystemTime(1794217118000);
      }
      respond(body);
      const response = await complete();
      const live = structuredClone(response.output);
      expect(response.model_dump()).toEqual(dump);
      expect(response.model_dump({ mode: "json" })).toEqual(dump);
      expect(response.output).toEqual(live);
      expect(response.model_dump()).toEqual(dump);
      expect(receive).toHaveBeenCalledTimes(1);
    },
  );

  test("parses the received text exactly once", async () => {
    const text =
      JSON.stringify({ ...base, provider_label: "雪" }, null, 2) + "\n";
    receive.mockResolvedValue(received(text));
    const parse = vi.spyOn(JSON, "parse");
    const response = await complete();
    expect(response.model_dump().provider_label).toBe("雪");
    expect(parse).toHaveBeenCalledExactlyOnceWith(text);
  });

  test("keeps omitted usage and all nullable defaults in query diagnostics", async () => {
    const fixture = fixtures.cases.find(
      (entry) => entry.name === "omitted usage typed dump",
    );
    if (!fixture) throw new Error("missing source fixture");
    respond(fixture.body);
    const response = await complete();
    const dump = vi.spyOn(response, "model_dump");
    class CompletedModel extends UnbilledResponseModel {
      protected override async request() {
        return response;
      }
    }
    try {
      await new CompletedModel({ model_name: "gpt-4o" }).query([]);
      throw new Error("expected FormatError");
    } catch (error) {
      expect(error).toBeInstanceOf(FormatError);
      if (!(error instanceof FormatError)) throw error;
      expect(error.messages[0]?.extra?.response).toEqual(fixture.dump);
      expect(error.messages[0]?.extra?.cost).toBe(0);
      expect(dump).toHaveBeenCalledExactlyOnceWith({ mode: "json" });
    }
  });

  test("uses default dumps for success and prepares a second received turn", async () => {
    respond({
      ...base,
      provider_field: { retained: true },
      metadata: { retained: true },
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    });
    const response = await complete();
    const dump = vi.spyOn(response, "model_dump");
    class FirstCompletedModel extends UnbilledResponseModel {
      protected override async request() {
        return response;
      }
    }
    const first = await new FirstCompletedModel({ model_name: "gpt-4o" }).query(
      [],
    );
    expect(dump).toHaveBeenCalledExactlyOnceWith();
    expect(first.provider_field).toEqual({ retained: true });
    expect(first.usage).toEqual({
      input_tokens: 10,
      input_tokens_details: null,
      output_tokens: 2,
      output_tokens_details: null,
      total_tokens: 12,
      cost: null,
    });
    expect(first.output).toEqual([
      {
        ...command,
        id: null,
        async_: null,
        caller: null,
        namespace: null,
        status: null,
      },
    ]);
    expect(first.extra?.actions).toEqual([
      { command: "pwd", tool_call_id: "command" },
    ]);
    await model().query([
      first,
      { role: "user", content: "next", extra: { removed: true } },
    ]);
    const init = receive.mock.calls.at(-1)?.[1];
    const body = JSON.parse(String(init?.body));
    const { extra: _extra, ...replay } = (
      first.output as Record<string, unknown>[]
    )[0]!;
    expect(body.input).toEqual([replay, { role: "user", content: "next" }]);
    expect(first.output).toEqual([{ ...replay, extra: command.extra }]);
    expect(body.model).toBe("gpt-4o");
  });

  test.each([
    "function and reasoning",
    "tool search validated",
    "tool search constructed",
  ])(
    "replays source-filtered output for %s without changing returned extra",
    async (name) => {
      const fixture = fixtures.cases.find((entry) => entry.name === name);
      if (
        !fixture ||
        !Array.isArray(fixture.body.output) ||
        !Array.isArray(fixture.dump.output)
      )
        throw new Error("missing source output fixture");
      const sourceOutput = fixture.body.output.filter(
        (item) => item.type !== "function_call",
      );
      const expectedOutput = fixture.dump.output.filter(
        (item) => item.type !== "function_call",
      );
      respond({ ...fixture.body, output: [...sourceOutput, command] });
      const first = await model().query([]);
      expect((first.output as unknown[]).slice(0, -1)).toEqual(expectedOutput);
      const returned = structuredClone(first.output);
      await model().query([first]);
      const sent = JSON.parse(String(receive.mock.calls.at(-1)?.[1].body));
      expect(sent.input).toEqual(
        (first.output as Record<string, unknown>[]).map(
          ({ extra: _extra, ...item }) => item,
        ),
      );
      expect(first.output).toEqual(returned);
    },
  );

  test("keeps construction raw through query and replay when id or usage total is missing", async () => {
    for (const missing of ["id", "total_tokens"]) {
      const body: Record<string, unknown> = {
        ...base,
        usage: { input_tokens: 10, output_tokens: 2 },
      };
      if (missing === "id") {
        delete body.id;
        body.usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
      }
      respond(body);
      const first = await model().query([]);
      expect(first.output).toEqual([command]);
      expect(first.usage).toEqual(body.usage);
      if (missing === "id") expect(first).not.toHaveProperty("id");
      await model().query([first]);
      const sent = JSON.parse(String(receive.mock.calls.at(-1)?.[1].body));
      const { extra: _extra, ...replay } = command;
      expect(sent.input).toEqual([replay]);
    }
  });

  test.each(["bad-output", 17, null, { provider: true }])(
    "keeps constructed non-array output %j live and dumped",
    async (output) => {
      respond({ ...base, output });
      const response = await complete();
      expect(response.output).toEqual(output);
      expect(response.model_dump().output).toEqual(output);
      if (output === 17 || output === null) {
        await expect(model().query([])).rejects.toThrow(
          "Response output is not iterable",
        );
      } else {
        await expect(model().query([])).rejects.toBeInstanceOf(FormatError);
      }
      expect(response.output).toEqual(output);
    },
  );

  test("invalid optional nested fields remain dictionaries in a valid response", async () => {
    const invalid = [
      { ...command, status: "not-a-status" },
      { type: "toString", provider: true },
      {
        type: "message",
        id: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: 17, annotations: [] }],
      },
      { type: "reasoning", id: "reason", summary: 17 },
      {
        type: "tool_search_call",
        id: "search",
        arguments: {},
        execution: "somewhere",
        status: "completed",
      },
    ];
    respond({ ...base, output: [command, ...invalid] });
    const response = await complete();
    expect(response.model_dump().output).toEqual([
      {
        ...command,
        id: null,
        async_: null,
        caller: null,
        namespace: null,
        status: null,
      },
      ...invalid,
    ]);
    expect(response.output).toBeInstanceOf(Array);
    expect((response.output as unknown[])[1]).toEqual(invalid[0]);
  });

  test("keeps omitted usage null on a successful query", async () => {
    respond(base);
    const first = await model().query([]);
    expect(first.usage).toBeNull();
    expect(first.instructions).toBeNull();
    expect(first.extra?.actions).toEqual([
      { command: "pwd", tool_call_id: "command" },
    ]);
  });

  test("does not retry a body-read failure under the existing transport policy", async () => {
    const cause = new Error("body read failed");
    receive.mockRejectedValue(new ResponseReadError(cause));
    await expect(
      completeResponses({
        model: "openai/gpt-4o",
        input: [],
        modelKwargs: { num_retries: 1 },
      }),
    ).rejects.toBe(cause);
    expect(receive).toHaveBeenCalledTimes(1);
  });

  test("retains raw text on HTTP errors without changing their mapped class", async () => {
    const text = '{\n  "error": {"message": "clé invalide"}\n}\n';
    receive.mockResolvedValue(received(text, 401));
    await expect(complete()).rejects.toMatchObject({
      name: "AuthenticationError",
      message: text,
      rawText: text,
      statusCode: 401,
    });
    expect(receive).toHaveBeenCalledTimes(1);
  });

  test("adds nullable detail defaults to present usage and retains detail extras", async () => {
    respond({
      ...base,
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
        input_tokens_details: { cached_tokens: 4, provider: true },
        output_tokens_details: { reasoning_tokens: 1, provider: true },
      },
    });
    const first = await model().query([]);
    expect(first.usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
      cost: null,
      input_tokens_details: {
        cached_tokens: 4,
        audio_tokens: null,
        cached_tokens_details: null,
        image_tokens: null,
        text_tokens: null,
        video_tokens: null,
        provider: true,
      },
      output_tokens_details: {
        reasoning_tokens: 1,
        audio_tokens: null,
        text_tokens: null,
        provider: true,
      },
    });
  });

  test.each([
    '{\n  "id": "owned", "output": [], "label": "\\u00e9"\n}\n',
    '{\n  "id": "réponse", "output": [], "label": "雪"\n}\n',
    "invalid é JSON\n",
    '["not a dictionary", "雪"]\n',
  ])(
    "retains raw received text and status on pre-validation error %j",
    async (text) => {
      receive.mockResolvedValue(received(text, 201));
      await expect(complete()).rejects.toMatchObject({
        name: "OpenAIError",
        message: text,
        rawText: text,
        statusCode: 201,
      });
      expect(receive).toHaveBeenCalledTimes(1);
    },
  );
});
