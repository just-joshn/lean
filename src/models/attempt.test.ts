import { afterEach, describe, expect, test, vi } from "vitest";
import { completeChat } from "./transport.ts";
import { completeResponses } from "./responses.ts";
import { receiveResponse, type ReceivedResponse } from "./received-response.ts";
import { getModelClass } from "./index.ts";
import { LitellmModel } from "./litellm-model.ts";
import {
  OpenRouterModel,
  PortkeyModel,
  RequestyModel,
} from "./provider-models.ts";
import { BASH_TOOL } from "./utils/actions-toolcall.ts";

vi.mock("./received-response.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./received-response.ts")>()),
  receiveResponse: vi.fn(async () => {
    throw new Error("No network in attempt controls");
  }),
}));

afterEach(() => vi.unstubAllEnvs());

function received(
  status: number,
  body: unknown = {},
  headers?: Record<string, string>,
): ReceivedResponse {
  const text = JSON.stringify(body);
  return {
    status,
    text,
    bytes: new TextEncoder().encode(text),
    statusText: "fixture",
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
  };
}

function seededRandom(seed = 1): () => number {
  return () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

function harness() {
  return {
    receive:
      vi.fn<(_url: string, _init: RequestInit) => Promise<ReceivedResponse>>(),
    sleep: vi.fn(async (_ms: number) => {}),
    random: seededRandom(),
    now: () => 0,
  };
}
const messages = [{ role: "user", content: "task" }];
const success = received(200, { choices: [] });

describe("complete-call attempt policy", () => {
  test("OpenAI 500 then success uses the SDK jitter band", async () => {
    const execution = harness();
    execution.receive
      .mockResolvedValueOnce(received(500))
      .mockResolvedValue(success);
    await completeChat({
      model: "openai/gpt-4o",
      messages,
      modelKwargs: { num_retries: 1 },
      execution,
    });
    expect(execution.receive).toHaveBeenCalledTimes(2);
    expect(execution.sleep).toHaveBeenCalledTimes(1);
    const delay = execution.sleep.mock.calls[0]?.[0];
    expect(delay).toBeGreaterThanOrEqual(375);
    expect(delay).toBeLessThanOrEqual(500);
    expect(delay).toBeCloseTo(470.4430593410507);
  });

  test.each([
    [{}, 3],
    [{ max_retries: 1 }, 2],
    [{ num_retries: 0, max_retries: 8 }, 1],
  ] as const)(
    "OpenAI SDK budget %j does not invent wrapper attempts",
    async (modelKwargs, calls) => {
      const execution = harness();
      execution.receive.mockResolvedValue(received(500));
      await expect(
        completeChat({
          model: "openai/gpt-4o",
          messages,
          modelKwargs,
          execution,
        }),
      ).rejects.toMatchObject({ statusCode: 500 });
      expect(execution.receive).toHaveBeenCalledTimes(calls);
      expect(execution.sleep).toHaveBeenCalledTimes(calls - 1);
    },
  );

  test("router metadata leaves retries to the router", async () => {
    const execution = harness();
    execution.receive.mockResolvedValue(received(500));
    const modelKwargs = {
      num_retries: 2,
      max_retries: 8,
      metadata: { model_group: "fixture" },
    };
    await expect(
      completeChat({
        model: "openai/gpt-4o",
        messages,
        modelKwargs,
        execution,
      }),
    ).rejects.toMatchObject({ statusCode: 500 });
    expect(execution.receive).toHaveBeenCalledTimes(1);
    execution.receive.mockClear();
    await expect(
      completeResponses({
        model: "openai/gpt-4o",
        input: messages,
        modelKwargs,
        execution,
      }),
    ).rejects.toMatchObject({ statusCode: 500 });
    expect(execution.receive).toHaveBeenCalledTimes(1);
    expect(execution.sleep).not.toHaveBeenCalled();
  });

  test("persistent timeout exhausts SDK attempts then one reset wrapper call", async () => {
    const execution = harness();
    const signals: Array<AbortSignal | null | undefined> = [];
    execution.receive.mockImplementation(async (_url, init) => {
      signals.push(init.signal);
      throw new DOMException("Request timed out", "TimeoutError");
    });
    await expect(
      completeChat({
        model: "openai/gpt-4o",
        messages,
        modelKwargs: { num_retries: 1, max_retries: 8, timeout: 0.3 },
        execution,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(execution.receive).toHaveBeenCalledTimes(3);
    expect(execution.sleep).toHaveBeenCalledTimes(1);
    expect(new Set(signals).size).toBe(3);
    expect(signals.every((signal) => signal && !signal.aborted)).toBe(true);
    for (const [, init] of execution.receive.mock.calls) {
      expect(JSON.parse(String(init.body))).not.toHaveProperty("num_retries");
      expect(JSON.parse(String(init.body))).not.toHaveProperty("max_retries");
    }
  });

  test("an expired attempt timeout retries with a fresh timeout signal", async () => {
    const execution = harness();
    execution.receive
      .mockImplementationOnce(async (_url, init) => {
        const signal = init.signal;
        if (!signal) throw new Error("missing timeout");
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw signal.reason;
      })
      .mockImplementation(async (_url, init) => {
        expect(init.signal?.aborted).toBe(false);
        return success;
      });
    await completeChat({
      model: "openai/gpt-4o",
      messages,
      modelKwargs: { timeout: 0.001, num_retries: 1 },
      execution,
    });
    expect(execution.receive).toHaveBeenCalledTimes(2);
  });

  test("user cancellation is terminal rather than a retryable timeout", async () => {
    const execution = harness();
    const controller = new AbortController();
    const reason = new DOMException("user cancelled", "AbortError");
    execution.receive.mockImplementation(async () => {
      controller.abort(reason);
      throw reason;
    });
    await expect(
      completeChat({
        model: "openai/gpt-4o",
        messages,
        signal: controller.signal,
        modelKwargs: { timeout: 0.3, num_retries: 1 },
        execution,
      }),
    ).rejects.toBe(reason);
    expect(execution.receive).toHaveBeenCalledTimes(1);
    expect(execution.sleep).not.toHaveBeenCalled();
  });

  test.each([0, 1, 2])(
    "Anthropic num_retries %i is wrapper-only",
    async (num_retries) => {
      const execution = harness();
      execution.receive.mockResolvedValue(received(500));
      await expect(
        completeChat({
          model: "anthropic/claude-3-haiku-20240307",
          messages,
          modelKwargs: { num_retries, max_retries: 9 },
          execution,
        }),
      ).rejects.toMatchObject({ statusCode: 500 });
      expect(execution.receive).toHaveBeenCalledTimes(1 + num_retries);
      expect(execution.sleep).not.toHaveBeenCalled();
    },
  );

  test.each([0, 1, 2])(
    "Responses num_retries %i has no chat SDK loop",
    async (num_retries) => {
      const execution = harness();
      execution.receive.mockResolvedValue(received(500));
      await expect(
        completeResponses({
          model: "openai/gpt-4o",
          input: messages,
          modelKwargs: { num_retries, max_retries: 9 },
          execution,
        }),
      ).rejects.toMatchObject({ statusCode: 500 });
      expect(execution.receive).toHaveBeenCalledTimes(1 + num_retries);
      expect(execution.sleep).not.toHaveBeenCalled();
    },
  );

  test.each([false, true])(
    "Responses 422 with drop_params %s does not acquire chat's parameter rewrite",
    async (drop_params) => {
      const execution = harness();
      execution.receive.mockResolvedValue(
        received(422, {
          error: {
            message: "Extra inputs are not permitted",
            param: "temperature",
          },
        }),
      );
      await expect(
        completeResponses({
          model: "openai/gpt-4o",
          input: messages,
          modelKwargs: { num_retries: 2, temperature: 0.4, drop_params },
          execution,
        }),
      ).rejects.toMatchObject({ statusCode: 422 });
      expect(execution.receive).toHaveBeenCalledTimes(3);
      for (const [, init] of execution.receive.mock.calls)
        expect(JSON.parse(String(init.body)).temperature).toBe(0.4);
      expect(execution.sleep).not.toHaveBeenCalled();
    },
  );

  test.each([
    [429, {}, 2, true],
    [500, { "x-should-retry": "false" }, 1, false],
    [400, { "x-should-retry": "true" }, 2, true],
    [500, { "retry-after-ms": "2000" }, 2, true],
    [500, { "retry-after": "121" }, 1, false],
    [500, { "retry-after": "2026-11-10T00:00:30Z" }, 2, true],
  ] as const)(
    "SDK status/header policy %i %j",
    async (status, headers, calls, waits) => {
      const execution = harness();
      const isoRetry =
        "retry-after" in headers &&
        headers["retry-after"] === "2026-11-10T00:00:30Z";
      if (isoRetry) execution.now = () => Date.parse("2026-11-10T00:00:00Z");
      execution.receive
        .mockResolvedValueOnce(received(status, {}, headers))
        .mockResolvedValue(success);
      const result = completeChat({
        model: "openai/gpt-4o",
        messages,
        modelKwargs: { max_retries: 1 },
        execution,
      });
      if (calls === 1)
        await expect(result).rejects.toMatchObject({ statusCode: status });
      else await result;
      expect(execution.receive).toHaveBeenCalledTimes(calls);
      expect(execution.sleep).toHaveBeenCalledTimes(waits ? 1 : 0);
      if ("retry-after-ms" in headers)
        expect(execution.sleep).toHaveBeenCalledWith(2000);
      if (isoRetry) {
        expect(execution.sleep.mock.calls[0]?.[0]).toBeCloseTo(
          470.4430593410507,
        );
      }
    },
  );

  test("an IMF Retry-After delays the retry and a far IMF date does not", async () => {
    const now = Date.parse("2026-11-10T00:00:00Z");
    const soon = harness();
    soon.now = () => now;
    soon.receive
      .mockResolvedValueOnce(
        received(500, {}, { "retry-after": "Tue, 10 Nov 2026 00:00:30 GMT" }),
      )
      .mockResolvedValue(success);
    await completeChat({
      model: "openai/gpt-4o",
      messages,
      modelKwargs: { max_retries: 1 },
      execution: soon,
    });
    expect(soon.receive).toHaveBeenCalledTimes(2);
    expect(soon.sleep).toHaveBeenCalledWith(30000);

    const later = harness();
    later.now = () => now;
    later.receive.mockResolvedValue(
      received(500, {}, { "retry-after": "Tue, 10 Nov 2026 00:03:00 GMT" }),
    );
    await expect(
      completeChat({
        model: "openai/gpt-4o",
        messages,
        modelKwargs: { max_retries: 1 },
        execution: later,
      }),
    ).rejects.toMatchObject({ statusCode: 500 });
    expect(later.receive).toHaveBeenCalledTimes(1);
    expect(later.sleep).not.toHaveBeenCalled();
  });
});

describe("complete-call routing", () => {
  test("streaming remains an explicit gate on both complete seams", async () => {
    const execution = harness();
    await expect(
      completeChat({
        model: "openai/gpt-4o",
        messages,
        modelKwargs: { stream: true },
        execution,
      }),
    ).rejects.toThrow("streaming");
    await expect(
      completeResponses({
        model: "openai/gpt-4o",
        input: messages,
        modelKwargs: { extra_body: { stream: true } },
        execution,
      }),
    ).rejects.toThrow("streaming");
    expect(execution.receive).not.toHaveBeenCalled();
  });

  test("fallback dispatch remains ahead of the provider handler", async () => {
    const execution = harness();
    await expect(
      completeChat({
        model: "anthropic/claude",
        messages,
        modelKwargs: { fallbacks: [] },
        execution,
      }),
    ).rejects.toThrow("fallback and model-list dispatch");
    expect(execution.receive).not.toHaveBeenCalled();
  });

  test.each([
    "azure_ai",
    "deepseek",
    "fireworks_ai",
    "together_ai",
    "xai",
    "groq",
    "hosted_vllm",
    "edenai",
    "ragflow",
    "cometapi",
  ])("%s keeps its earlier provider-specific branch", async (provider) => {
    const execution = harness();
    await expect(
      completeChat({ model: `${provider}/model`, messages, execution }),
    ).rejects.toThrow(`Open provider parity gate for ${provider}`);
    expect(execution.receive).not.toHaveBeenCalled();
  });

  test("compatible provider executes the chat seam with its model prefix stripped", async () => {
    const execution = harness();
    execution.receive.mockResolvedValue(success);
    await completeChat({
      model: "deepinfra/model",
      messages,
      modelKwargs: { api_base: "https://fixture.invalid/v1", num_retries: 0 },
      execution,
    });
    const request = execution.receive.mock.calls[0];
    expect(request?.[0]).toBe("https://fixture.invalid/v1/chat/completions");
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      model: "model",
      messages,
    });
  });

  test("text completion condition wins before the compatible bucket", async () => {
    const execution = harness();
    await expect(
      completeChat({
        model: "together_ai/model",
        messages,
        modelKwargs: { text_completion: true },
        execution,
      }),
    ).rejects.toThrow("Open provider parity gate for openai-text");
    expect(execution.receive).not.toHaveBeenCalled();
  });

  test("explicit provider selection wins over the model prefix", async () => {
    const execution = harness();
    execution.receive.mockResolvedValue(received(200, { content: [] }));
    await completeChat({
      model: "openai/gpt-4o",
      messages,
      modelKwargs: { custom_llm_provider: "anthropic" },
      execution,
    });
    expect(execution.receive.mock.calls[0]?.[0]).toBe(
      "https://api.anthropic.com/v1/messages",
    );
  });

  test("Bedrock Converse builds the captured source body and reaches transport", async () => {
    const execution = harness();
    execution.receive.mockResolvedValue(received(200, {}));
    await expect(
      completeChat({
        model: "bedrock/anthropic.claude-3-haiku-20240307-v1:0",
        messages: [
          {
            role: "user",
            content: "task",
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: [BASH_TOOL],
        modelKwargs: { api_base: "https://fixture.invalid", num_retries: 0 },
        execution,
      }),
    ).rejects.toThrow("Converse output message shape");
    expect(execution.receive).toHaveBeenCalledTimes(1);
    const [url, init] = execution.receive.mock.calls[0]!;
    expect(url).toBe(
      "https://fixture.invalid/model/anthropic.claude-3-haiku-20240307-v1%3A0/converse",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      messages: [
        {
          role: "user",
          content: [{ text: "task" }, { cachePoint: { type: "default" } }],
        },
      ],
      inferenceConfig: {},
      toolConfig: {
        tools: [
          {
            toolSpec: {
              inputSchema: { json: BASH_TOOL.function.parameters },
              name: "bash",
              description: "Execute a bash command",
            },
          },
        ],
      },
    });
  });

  test.each([
    ["openrouter", OpenRouterModel],
    ["portkey", PortkeyModel],
    ["requesty", RequestyModel],
  ] as const)(
    "%s selects a separate model component",
    (shortcut, ModelClass) => {
      vi.stubEnv("PORTKEY_API_KEY", "source-fake-key");
      expect(getModelClass("openai/gpt-4o", shortcut)).toBe(ModelClass);
      expect(getModelClass("openai/gpt-4o", ModelClass.typeName)).toBe(
        ModelClass,
      );
      expect(ModelClass).not.toBe(LitellmModel);
      expect(getModelClass(`${shortcut}/model`)).toBe(LitellmModel);
    },
  );

  test.each([PortkeyModel])(
    "unproved dedicated component %s cannot fall through to the LiteLLM transport",
    async (ModelClass) => {
      vi.stubEnv("PORTKEY_API_KEY", "source-fake-key");
      const model = new ModelClass({
        model_name: "openai/gpt-4o",
        litellm_model_registry: null,
      });
      model.sleep = vi.fn(async () => {});
      vi.mocked(receiveResponse).mockClear();
      await expect(model.query(messages)).rejects.toMatchObject({
        name: "ProviderParityGateError",
      });
      expect(receiveResponse).not.toHaveBeenCalled();
      expect(model.sleep).not.toHaveBeenCalled();
    },
  );
});
