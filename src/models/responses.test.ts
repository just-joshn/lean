import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FormatError, KeyboardInterrupt } from "../exceptions.ts";
import {
  AuthenticationError,
  ContextWindowExceededError,
  NotFoundError,
} from "./errors.ts";
import { LitellmResponseModel } from "./litellm-response-model.ts";
import {
  receiveResponse,
  decodeResponseText,
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
  json_dump?: Record<string, unknown>;
  live_types?: string[] | null;
  live_fields?: Record<string, string>;
}
const fixtures: { cases: Fixture[] } = JSON.parse(
  readFileSync(
    new URL("./fixtures/responses-return.json", import.meta.url),
    "utf8",
  ),
);
const serialization: {
  defaults: Record<string, unknown>;
  cases: Fixture[];
  iterators: {
    mode: string | null;
    body: Record<string, unknown>;
    first: Record<string, unknown>;
    after: Record<string, unknown>;
  }[];
} = JSON.parse(
  readFileSync(
    new URL("./fixtures/responses-serialization.json", import.meta.url),
    "utf8",
  ),
);
const errors: {
  mapping: {
    status: number;
    text: string;
    name: string;
    message: string;
    query_message?: string;
  }[];
  decoding: {
    name: string;
    bytes: number[];
    headers: Record<string, string>;
    text: string;
    dump?: Record<string, unknown>;
    error?: { name: string; message: string };
  }[];
  arguments: { arguments: unknown; actions?: unknown[]; error?: string }[];
  interrupt: { name: string; message: string };
} = JSON.parse(
  readFileSync(
    new URL("./fixtures/responses-errors.json", import.meta.url),
    "utf8",
  ),
);
const requestFixtures: {
  cases: { name: string; body?: { input: unknown[] } }[];
} = JSON.parse(
  readFileSync(
    new URL("./fixtures/responses-request.json", import.meta.url),
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
  test.each(serialization.cases)(
    "matches remaining source serialization for $name",
    async ({ body, dump, json_dump, live_types, live_fields }) => {
      respond(body);
      const response = await complete();
      if (live_types && Array.isArray(response.output)) {
        const savedOutput = Array.isArray(dump.output) ? dump.output : [];
        response.output.forEach((item: unknown, index: number) => {
          const type = live_types[index];
          const saved = savedOutput[index];
          if (type === "dict") {
            expect(Object.getPrototypeOf(item)).toBe(Object.prototype);
            expect(item).toMatchObject(saved);
          } else if (type === "str") {
            expect(item).toBe(saved);
          } else {
            expect(typeof Reflect.get(item as object, "model_dump")).toBe(
              "function",
            );
            if (saved && typeof saved === "object" && !Array.isArray(saved)) {
              for (const [key, entry] of Object.entries(saved))
                expect(Reflect.get(item as object, key)).toEqual(entry);
            }
          }
        });
      }
      for (const [field, type] of Object.entries(live_fields ?? {})) {
        const value = response[field];
        const saved = dump[field];
        if (type === "NoneType") expect(value).toBeNull();
        else if (type === "dict") {
          expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
          expect(value).toEqual(saved);
        } else if (type === "str" || type === "int") {
          expect(value).toEqual(saved);
        } else {
          expect(typeof Reflect.get(value as object, "model_dump")).toBe(
            "function",
          );
          if (saved && typeof saved === "object" && !Array.isArray(saved)) {
            for (const [key, entry] of Object.entries(saved))
              expect(Reflect.get(value as object, key)).toEqual(entry);
          }
        }
      }
      for (const mode of [undefined, "python", "json", "other"] as const) {
        expect(
          response.model_dump(mode === undefined ? undefined : { mode }),
        ).toEqual({
          ...serialization.defaults,
          ...(mode === "json" && json_dump ? json_dump : dump),
        });
      }
      expect(receive).toHaveBeenCalledTimes(1);
    },
  );
  test.each(serialization.iterators)(
    "matches source consumption for dump mode $mode",
    async (fixture) => {
      respond(fixture.body);
      const response = await complete();
      const first = response.model_dump(
        fixture.mode === null ? undefined : { mode: fixture.mode },
      );
      const choice = first.tool_choice as Record<string, unknown>;
      expect(Array.isArray(choice.tools)).toBe(fixture.mode === "json");
      choice.tools = Array.from(choice.tools as Iterable<unknown>);
      expect(first).toEqual(fixture.first);
      expect(response.model_dump({ mode: "json" })).toEqual(fixture.after);
    },
  );

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
      const request = requestFixtures.cases.find(
        (entry) => entry.name === `return replay ${name}`,
      );
      if (!request?.body) throw new Error("missing source request fixture");
      expect(sent.input).toEqual(request.body.input);
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

  test.each(errors.decoding)(
    "matches source raw decoding for $name",
    async (fixture) => {
      const bytes = Uint8Array.from(fixture.bytes);
      const headers = new Headers(fixture.headers);
      const text = decodeResponseText(bytes, headers);
      expect(text).toBe(fixture.text);
      receive.mockResolvedValue({
        bytes,
        headers,
        text,
        status: 200,
        statusText: "fixture",
        ok: true,
      });
      if (fixture.error)
        await expect(complete()).rejects.toMatchObject(fixture.error);
      else expect((await complete()).model_dump()).toEqual(fixture.dump);
      expect(receive).toHaveBeenCalledTimes(1);
    },
  );

  test.each(errors.mapping.filter((fixture) => fixture.status !== 200))(
    "maps the source OpenAI $status error $text",
    async (fixture) => {
      receive.mockResolvedValue(received(fixture.text, fixture.status));
      const failure = await complete().catch((error: unknown) => error);
      expect(failure).toMatchObject({
        name: fixture.name,
        message: fixture.message,
        rawText: fixture.text,
        statusCode: fixture.status,
      });
      const classes = {
        AuthenticationError,
        NotFoundError,
        ContextWindowExceededError,
      } as const;
      if (fixture.name in classes)
        expect(failure).toBeInstanceOf(
          classes[fixture.name as keyof typeof classes],
        );
      if (fixture.query_message) {
        class DirectRequestModel extends UnbilledResponseModel {
          run() {
            return this.request([], {});
          }
        }
        const listeners = process.listenerCount("SIGINT");
        await expect(
          new DirectRequestModel({ model_name: "openai/gpt-4o" }).run(),
        ).rejects.toMatchObject({ message: fixture.query_message });
        expect(process.listenerCount("SIGINT")).toBe(listeners);
      }
    },
  );

  test.each(errors.arguments)(
    "matches the source action parsing for $arguments",
    async (fixture) => {
      respond({
        ...base,
        output: [{ ...command, call_id: "call", arguments: fixture.arguments }],
      });
      const subject = new UnbilledResponseModel({
        model_name: "openai/gpt-4o",
        format_error_template: "{{ error }}",
      });
      if (fixture.error) {
        try {
          await subject.query([]);
          throw new Error("expected FormatError");
        } catch (error) {
          expect(error).toBeInstanceOf(FormatError);
          if (!(error instanceof FormatError)) throw error;
          expect(error.messages[0]?.content).toEqual([
            { type: "input_text", text: fixture.error },
          ]);
          expect(error.messages[0]?.extra?.response).toEqual(
            (await complete()).model_dump({ mode: "json" }),
          );
        }
      } else
        expect((await subject.query([])).extra?.actions).toEqual(
          fixture.actions,
        );
    },
  );

  test("maps SIGINT to the source interrupt and removes its listener", async () => {
    const listeners = process.listenerCount("SIGINT");
    receive.mockImplementationOnce(async (_url, init) => {
      const signal = init.signal;
      if (!signal) throw new Error("missing abort signal");
      const listener = process.listeners("SIGINT").at(-1);
      if (!listener) throw new Error("missing SIGINT listener");
      listener("SIGINT");
      expect(signal.aborted).toBe(true);
      signal.throwIfAborted();
      throw new Error("unreachable");
    });
    const failure = await model()
      .query([])
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KeyboardInterrupt);
    expect(failure).toMatchObject({
      name: errors.interrupt.name,
      message: errors.interrupt.message,
    });
    expect(process.listenerCount("SIGINT")).toBe(listeners);
    expect(receive).toHaveBeenCalledTimes(1);
  });

  test("removes its SIGINT listener without interrupting a successful request", async () => {
    const listeners = process.listenerCount("SIGINT");
    respond(base);
    await model().query([]);
    expect(process.listenerCount("SIGINT")).toBe(listeners);
  });

  test("retains raw text on HTTP errors with the source OpenAI mapping", async () => {
    const text = '{\n  "error": {"message": "clé invalide"}\n}\n';
    receive.mockResolvedValue(received(text, 401));
    await expect(complete()).rejects.toMatchObject({
      name: "AuthenticationError",
      message: `litellm.AuthenticationError: AuthenticationError: OpenAIException - ${text}`,
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
