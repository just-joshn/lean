import { beforeEach, describe, expect, test, vi } from "vitest";
import { FormatError } from "../exceptions.ts";
import type { Action } from "../protocols.ts";
import { LitellmModel } from "./litellm-model.ts";
import { LitellmResponseModel } from "./litellm-response-model.ts";
import { LitellmTextbasedModel } from "./litellm-textbased-model.ts";
import { GLOBAL_MODEL_STATS } from "./stats.ts";
import { ResponseResult } from "./response-result.ts";

const call = {
  type: "function_call",
  call_id: "owned",
  name: "bash",
  arguments: '{"command":"pwd"}',
};

class FixtureResponses extends LitellmResponseModel {
  response: unknown;
  requests = 0;
  constructor(response: unknown) {
    super({ model_name: "gpt-4o" });
    this.response = response;
  }
  protected override async request(): Promise<unknown> {
    this.requests += 1;
    return this.response;
  }
  protected override costOf(_response: unknown): number {
    return 0.25;
  }
}

async function formatError(model: LitellmModel): Promise<FormatError> {
  try {
    await model.query([]);
  } catch (error) {
    expect(error).toBeInstanceOf(FormatError);
    if (error instanceof FormatError) return error;
    throw error;
  }
  throw new Error("Expected FormatError");
}

const nullDictionary: Record<string, unknown> = Object.create(null);
Object.assign(nullDictionary, { output: [call], owned: "null prototype" });

beforeEach(() => GLOBAL_MODEL_STATS.reset());

describe("model hooks", () => {
  test.for([
    { owned: "without output" },
    { output: [call], owned: "with a valid command" },
    nullDictionary,
  ])(
    "keeps a dictionary diagnostic without parsing its output",
    async (response) => {
      const model = new FixtureResponses(response);
      const error = await formatError(model);
      expect(error.messages[0]?.extra?.response).toEqual(response);
      expect(error.messages[0]?.extra?.response).not.toBe(response);
      expect(error.messages[0]?.extra?.cost).toBe(0.25);
      expect(JSON.stringify(error.messages[0]?.content)).toContain(
        "No tool calls",
      );
      expect(GLOBAL_MODEL_STATS.cost).toBe(0.25);
      expect(GLOBAL_MODEL_STATS.n_calls).toBe(1);
      expect(model.requests).toBe(1);
    },
  );

  test("treats a dictionary model_dump function as data", async () => {
    const dump = vi.fn(() => ({ lost: true }));
    const response = { output: [call], model_dump: dump, owned: true };
    const error = await formatError(new FixtureResponses(response));
    expect(error.messages[0]?.extra?.response).toEqual(response);
    expect(dump).not.toHaveBeenCalled();
  });

  test("accepts an untagged provider object and uses its default dump mode", async () => {
    class ProviderResponse {
      output = [call];
      modes: unknown[] = [];
      model_dump(options?: unknown) {
        this.modes.push(options);
        return {
          object: "response",
          output: this.output,
          owned: { kept: true },
        };
      }
    }
    const response = new ProviderResponse();
    const message = await new FixtureResponses(response).query([]);
    expect(message.extra?.actions).toEqual([
      { command: "pwd", tool_call_id: "owned" },
    ]);
    expect(message.output).toEqual([call]);
    expect(message.owned).toEqual({ kept: true });
    expect(response.modes).toEqual([undefined]);
  });

  test("queries an internal Responses result with default cost accounting", async () => {
    const body = {
      object: "response",
      model: "gpt-4o",
      service_tier: "default",
      output: [{ ...call, extra: { kept: true } }],
      usage: { input_tokens: 1000, output_tokens: 100 },
    };
    class BuiltinResult extends LitellmResponseModel {
      protected override async request(): Promise<unknown> {
        return new ResponseResult(body);
      }
    }
    const result = new ResponseResult(body);
    expect(result.model).toBe("gpt-4o");
    expect(result.service_tier).toBe("default");
    expect(result.model_dump()).toEqual(body);
    const message = await new BuiltinResult({ model_name: "gpt-4o" }).query([]);
    expect(message.output).toEqual(body.output);
    expect(message.extra?.actions).toEqual([
      { command: "pwd", tool_call_id: "owned" },
    ]);
    expect(message.extra?.cost).toBeCloseTo(0.0035);
    expect(GLOBAL_MODEL_STATS.cost).toBeCloseTo(0.0035);
  });

  test("retains real calculator cost when a dictionary reaches the default Responses parser", async () => {
    const response = { output: [call], usage: chatBody.usage };
    class PricedDictionary extends LitellmResponseModel {
      protected override async request(): Promise<Record<string, unknown>> {
        return response;
      }
    }
    const error = await formatError(
      new PricedDictionary({ model_name: "gpt-4o" }),
    );
    expect(error.messages[0]?.extra?.response).toEqual(response);
    expect(error.messages[0]?.extra?.cost).toBeCloseTo(0.0035);
    expect(GLOBAL_MODEL_STATS.n_calls).toBe(1);
  });

  test("lets an overridden parser accept a dictionary without invoking its dump key", async () => {
    const dump = vi.fn();
    const response = {
      output: [call],
      model_dump: dump,
      owned: true,
      extra: { replaced: true },
    };
    class CustomParser extends FixtureResponses {
      protected override parseActions(value: unknown): Action[] {
        expect(value).toBe(response);
        expect(GLOBAL_MODEL_STATS.n_calls).toBe(1);
        expect(GLOBAL_MODEL_STATS.cost).toBe(0.25);
        return [{ command: "custom" }];
      }
    }
    const message = await new CustomParser(response).query([]);
    expect(message).toMatchObject({
      output: [call],
      owned: true,
      model_dump: dump,
    });
    expect(message.extra).toMatchObject({
      actions: [{ command: "custom" }],
      cost: 0.25,
    });
    expect(message.extra?.replaced).toBeUndefined();
    expect(dump).not.toHaveBeenCalled();
  });

  test("keeps a numeric JSON-mode diagnostic", async () => {
    class NumericDump {
      output = [];
      modes: unknown[] = [];
      model_dump(options?: unknown): number {
        this.modes.push(options);
        return 17;
      }
    }
    const response = new NumericDump();
    const error = await formatError(new FixtureResponses(response));
    expect(error.messages[0]?.extra?.response).toBe(17);
    expect(error.messages[0]?.extra?.cost).toBe(0.25);
    expect(response.modes).toEqual([{ mode: "json" }]);
  });

  test("does not describe a numeric successful dump as a Message", async () => {
    class NumericDump {
      output = [call];
      model_dump(): number {
        return 17;
      }
    }
    await expect(
      new FixtureResponses(new NumericDump()).query([]),
    ).rejects.toBeInstanceOf(TypeError);
    expect(GLOBAL_MODEL_STATS.cost).toBe(0.25);
  });

  test("preserves the original FormatError and cost when diagnostic serialization throws", async () => {
    const original = new FormatError({ role: "user", content: "original" });
    class ThrowingDump {
      model_dump(options?: unknown) {
        expect(options).toEqual({ mode: "json" });
        throw new Error("dump failed");
      }
      toString() {
        return "repr-response";
      }
    }
    class BrokenParser extends FixtureResponses {
      protected override parseActions(_response: unknown): Action[] {
        throw original;
      }
    }
    const model = new BrokenParser(new ThrowingDump());
    await expect(model.query([])).rejects.toBe(original);
    expect(original.messages[0]?.extra).toMatchObject({
      cost: 0.25,
      response: "repr-response",
    });
    expect(model.requests).toBe(1);
    expect(GLOBAL_MODEL_STATS.n_calls).toBe(1);
  });

  test.for(["function_call", { tool: call }])(
    "iterates non-list output instead of treating it as tool records",
    async (output) => {
      class NonList {
        output = output;
        model_dump() {
          return { output: this.output };
        }
      }
      const error = await formatError(new FixtureResponses(new NonList()));
      expect(JSON.stringify(error.messages[0]?.content)).toContain(
        "No tool calls",
      );
      expect(error.messages[0]?.extra?.response).toEqual({ output });
    },
  );

  test.for([null, 17])(
    "rejects non-iterable output without converting it to an empty list",
    async (output) => {
      class NonIterable {
        output = output;
      }
      const model = new FixtureResponses(new NonIterable());
      await expect(model.query([])).rejects.toBeInstanceOf(TypeError);
      expect(model.requests).toBe(1);
      expect(GLOBAL_MODEL_STATS.cost).toBe(0.25);
    },
  );

  test("accepts iterable attribute output", async () => {
    class IterableResponse {
      output = new Set([call]);
      model_dump() {
        return { output: [call] };
      }
    }
    const message = await new FixtureResponses(new IterableResponse()).query(
      [],
    );
    expect(message.extra?.actions).toEqual([
      { command: "pwd", tool_call_id: "owned" },
    ]);
  });

  test("does not hide a throwing output getter", async () => {
    const original = new Error("getter failed");
    class GetterResponse {
      get output(): unknown {
        throw original;
      }
    }
    await expect(
      new FixtureResponses(new GetterResponse()).query([]),
    ).rejects.toBe(original);
  });

  test.for([false, true])(
    "reads finish details from dictionary and attribute objects",
    async (attributeDetails) => {
      class Details {
        reason = "max_output_tokens";
      }
      class IncompleteResponse {
        status = "incomplete";
        incomplete_details = attributeDetails
          ? new Details()
          : { reason: "max_output_tokens" };
        output = [];
        model_dump() {
          return {};
        }
      }
      const model = new FixtureResponses(new IncompleteResponse());
      model.config.format_error_template = "{{ finish_reason }}: {{ error }}";
      const error = await formatError(model);
      expect(JSON.stringify(error.messages[0]?.content)).toContain(
        "length: No tool calls",
      );
    },
  );
});

const chatBody = {
  choices: [
    {
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "```mswea_bash_command\npwd\n```",
        tool_calls: [
          {
            id: "chat",
            function: { name: "bash", arguments: '{"command":"pwd"}' },
          },
        ],
        owned: true,
      },
    },
  ],
  usage: { prompt_tokens: 1000, completion_tokens: 100 },
};

class FixtureChat extends LitellmModel {
  response: unknown = new ResponseResult(chatBody);
  protected override async request(): Promise<unknown> {
    return this.response;
  }
}
class FixtureText extends LitellmTextbasedModel {
  response: unknown = new ResponseResult(chatBody);
  protected override async request(): Promise<unknown> {
    return this.response;
  }
}

class DictionaryChat extends LitellmModel {
  protected override async request(): Promise<Record<string, unknown>> {
    return chatBody;
  }
  protected override costOf(_response: unknown): number {
    return 0;
  }
}
class DictionaryText extends LitellmTextbasedModel {
  protected override async request(): Promise<Record<string, unknown>> {
    return chatBody;
  }
  protected override costOf(_response: unknown): number {
    return 0;
  }
}
class DictionaryResponses extends LitellmResponseModel {
  protected override async request(): Promise<Record<string, unknown>> {
    return { output: [call] };
  }
  protected override costOf(_response: unknown): number {
    return 0;
  }
}

describe("chat and textbased hooks", () => {
  test.for([FixtureChat, FixtureText])(
    "queries the real hierarchy with internal result attributes",
    async (Model) => {
      const message = await new Model({ model_name: "gpt-4o" }).query([]);
      expect(message.role).toBe("assistant");
      expect(message.owned).toBe(true);
      expect(message.extra?.actions).toMatchObject([{ command: "pwd" }]);
      expect(message.extra?.response).toEqual(chatBody);
      expect(message.extra?.cost).toBeCloseTo(0.0035);
      expect(GLOBAL_MODEL_STATS.n_calls).toBe(1);
    },
  );

  test.for([DictionaryChat, DictionaryText])(
    "does not give chat a dictionary choices fallback",
    async (Model) => {
      await expect(
        new Model({ model_name: "gpt-4o" }).query([]),
      ).rejects.toBeInstanceOf(TypeError);
      expect(GLOBAL_MODEL_STATS.n_calls).toBe(1);
    },
  );

  test("compiles and queries a plain-dictionary Responses override", async () => {
    const error = await formatError(
      new DictionaryResponses({ model_name: "gpt-4o" }),
    );
    expect(error.messages[0]?.extra?.response).toEqual({ output: [call] });
    expect(error.messages[0]?.extra?.cost).toBe(0);
  });

  test.for([false, true])(
    "reads dictionary and attribute usage with the existing calculator",
    async (attributeUsage) => {
      class Details {
        cached_tokens = 400;
      }
      class Usage {
        prompt_tokens = 1000;
        completion_tokens = 100;
        prompt_tokens_details = new Details();
      }
      class ProviderChat extends ResponseResult {
        usage = attributeUsage
          ? new Usage()
          : {
              prompt_tokens: 1000,
              completion_tokens: 100,
              prompt_tokens_details: { cached_tokens: 400 },
            };
      }
      const model = new FixtureChat({ model_name: "gpt-4o" });
      model.response = new ProviderChat(chatBody);
      const message = await model.query([]);
      expect(message.extra?.cost).toBeCloseTo(0.003);
      expect(GLOBAL_MODEL_STATS.cost).toBeCloseTo(0.003);
    },
  );

  test("uses default-mode response and message dumps for an untagged chat provider", async () => {
    const modes: unknown[] = [];
    class ProviderMessage {
      tool_calls = chatBody.choices[0].message.tool_calls;
      model_dump(options?: unknown) {
        modes.push(options);
        return { role: "assistant", content: "dumped message", owned: true };
      }
    }
    class ProviderChat {
      choices = [
        { finish_reason: "tool_calls", message: new ProviderMessage() },
      ];
      usage = chatBody.usage;
      model_dump(options?: unknown) {
        modes.push(options);
        return { owned: "dumped response" };
      }
    }
    const model = new FixtureChat({ model_name: "gpt-4o" });
    model.response = new ProviderChat();
    const message = await model.query([]);
    expect(message.content).toBe("dumped message");
    expect(message.extra?.response).toEqual({ owned: "dumped response" });
    expect(modes).toEqual([undefined, undefined]);
  });

  test("uses JSON mode on a chat parser diagnostic", async () => {
    class NumericChat {
      choices = [{ message: { tool_calls: [] } }];
      usage = chatBody.usage;
      model_dump(options?: unknown): number {
        expect(options).toEqual({ mode: "json" });
        return 17;
      }
    }
    const model = new FixtureChat({ model_name: "gpt-4o" });
    model.response = new NumericChat();
    const error = await formatError(model);
    expect(error.messages[0]?.extra?.response).toBe(17);
    expect(error.messages[0]?.extra?.cost).toBeCloseTo(0.0035);
  });

  test("does not use a dictionary message dump key as a chat method", async () => {
    const dump = vi.fn(() => ({ role: "assistant" }));
    class ProviderChat {
      choices = [
        { message: { ...chatBody.choices[0].message, model_dump: dump } },
      ];
      usage = chatBody.usage;
      model_dump() {
        return {};
      }
    }
    const model = new FixtureChat({ model_name: "gpt-4o" });
    model.response = new ProviderChat();
    await expect(model.query([])).rejects.toBeInstanceOf(TypeError);
    expect(dump).not.toHaveBeenCalled();
  });

  test.for([false, true])(
    "keeps the numeric-role Message debt open at one copy boundary",
    async (customProvider) => {
      const numericMessage = { ...chatBody.choices[0].message, role: 17 };
      class ProviderMessage {
        tool_calls = numericMessage.tool_calls;
        model_dump() {
          return numericMessage;
        }
      }
      class ProviderChat {
        choices = [{ message: new ProviderMessage() }];
        usage = chatBody.usage;
        model_dump() {
          return {};
        }
      }
      const model = new FixtureChat({ model_name: "gpt-4o" });
      model.response = customProvider
        ? new ProviderChat()
        : new ResponseResult({
            ...chatBody,
            choices: [{ message: numericMessage }],
          });
      const message = await model.query([]);
      expect(Reflect.get(message, "role")).toBe(17);
      expect(message.extra?.actions).toEqual([
        { command: "pwd", tool_call_id: "chat" },
      ]);
    },
  );
});
