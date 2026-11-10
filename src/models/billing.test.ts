import { beforeEach, describe, expect, test, vi } from "vitest";
import { FormatError, RuntimeError } from "../exceptions.ts";
import { receiveResponse } from "./received-response.ts";
import { completeChat } from "./transport.ts";
import { completeResponses } from "./responses.ts";
import { LitellmModel } from "./litellm-model.ts";
import { LitellmResponseModel } from "./litellm-response-model.ts";
import { GLOBAL_MODEL_STATS } from "./stats.ts";
import { completionCost, registerModel } from "./utils/cost.ts";

vi.mock("./received-response.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./received-response.ts")>()),
  receiveResponse: vi.fn(),
}));

beforeEach(() => {
  GLOBAL_MODEL_STATS.reset();
  vi.mocked(receiveResponse).mockReset();
});

function fixture(body: unknown) {
  const text = JSON.stringify(body);
  vi.mocked(receiveResponse).mockResolvedValue({
    text,
    bytes: new TextEncoder().encode(text),
    status: 200,
    statusText: "fixture",
    ok: true,
  });
}

const call = {
  type: "function_call",
  name: "bash",
  call_id: "call_1",
  arguments: '{"command":"true"}',
};
function responses(usage: unknown, extra = {}) {
  return {
    id: "resp_1",
    created_at: 1,
    object: "response",
    model: "gpt-4o",
    output: [call],
    usage,
    ...extra,
  };
}
function chat(usage: unknown, extra = {}) {
  return {
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
              function: { name: "bash", arguments: call.arguments },
            },
          ],
        },
      },
    ],
    usage,
    ...extra,
  };
}

const modelKwargs = { api_base: "http://fixture.invalid/v1", num_retries: 0 };

describe("connected billing", () => {
  test.each([false, true])(
    "Responses cache is a subset through complete and query, priority=%s",
    async (priority) => {
      const usage = {
        input_tokens: 1000,
        output_tokens: 100,
        total_tokens: 1100,
        input_tokens_details: { cached_tokens: 400, text_tokens: 1000 },
        output_tokens_details: { reasoning_tokens: 40, text_tokens: 100 },
      };
      fixture(responses(usage, priority ? { service_tier: "priority" } : {}));
      const result = await completeResponses({
        model: "openai/gpt-4o",
        input: [],
        modelKwargs,
      });
      expect(result.model_dump().usage).toMatchObject(usage);
      const expected = priority ? 0.0051 : 0.003;
      expect(completionCost(result, "openai/gpt-4o")).toBeCloseTo(expected, 12);
      const message = await new LitellmResponseModel({
        model_name: "openai/gpt-4o",
        model_kwargs: modelKwargs,
      }).query([]);
      expect(message.extra?.cost).toBeCloseTo(expected, 12);
      expect(GLOBAL_MODEL_STATS.cost).toBeCloseTo(expected, 12);
      expect(GLOBAL_MODEL_STATS.n_calls).toBe(1);
    },
  );

  test("explicit input text details use the source remainder and overlap rules", async () => {
    fixture(
      responses({
        input_tokens: 1000,
        output_tokens: 100,
        total_tokens: 1100,
        input_tokens_details: { cached_tokens: 400, text_tokens: 500 },
        output_tokens_details: { reasoning_tokens: 40, text_tokens: 100 },
      }),
    );
    const message = await new LitellmResponseModel({
      model_name: "gpt-4o",
      model_kwargs: modelKwargs,
    }).query([]);
    expect(message.extra?.cost).toBe(0.00275);
    expect(GLOBAL_MODEL_STATS.cost).toBe(0.00275);
  });

  test("chat priority prices and unrounded source fractions reach stats", async () => {
    fixture(
      chat(
        { prompt_tokens: 1000, completion_tokens: 100 },
        { service_tier: "priority" },
      ),
    );
    const result = await completeChat({
      model: "openai/gpt-4o",
      messages: [],
      modelKwargs,
    });
    expect(completionCost(result, "openai/gpt-4o")).toBe(0.00595);
    const model = new LitellmModel({
      model_name: "openai/gpt-4o",
      model_kwargs: modelKwargs,
    });
    expect((await model.query([])).extra?.cost).toBe(0.00595);
    fixture(chat({ prompt_tokens: 1, completion_tokens: 1 }));
    expect((await model.query([])).extra?.cost).toBe(0.0000125);
    expect(GLOBAL_MODEL_STATS.cost).toBe(0.00595 + 0.0000125);
    expect(GLOBAL_MODEL_STATS.n_calls).toBe(2);
  });

  test.each([false, true])(
    "Anthropic cache duration conversion reaches complete and query, split=%s",
    async (split) => {
      fixture({
        model: "claude-sonnet-4-5-20250929",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "bash",
            input: { command: "true" },
          },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 50,
          output_tokens: 10,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 0,
          ...(split
            ? {
                cache_creation: {
                  ephemeral_5m_input_tokens: 10,
                  ephemeral_1h_input_tokens: 20,
                },
              }
            : {}),
        },
      });
      const model = "anthropic/claude-sonnet-4-5-20250929";
      const result = await completeChat({ model, messages: [], modelKwargs });
      expect(result.usage).toMatchObject({
        prompt_tokens: 80,
        completion_tokens: 10,
        total_tokens: 90,
        prompt_tokens_details: {
          cached_tokens: 0,
          cache_creation_tokens: 30,
          text_tokens: 50,
        },
      });
      if (split)
        expect(result.usage).toMatchObject({
          prompt_tokens_details: {
            cache_creation_token_details: {
              ephemeral_5m_input_tokens: 10,
              ephemeral_1h_input_tokens: 20,
            },
          },
        });
      const expected = split ? 0.00045750000000000006 : 0.00041250000000000005;
      expect(completionCost(result, model)).toBe(expected);
      const message = await new LitellmModel({
        model_name: model,
        model_kwargs: modelKwargs,
      }).query([]);
      expect(message.extra?.cost).toBe(expected);
      expect(GLOBAL_MODEL_STATS.cost).toBe(expected);
    },
  );

  test("provider reasoning rate is selected on the real compatible complete path", async () => {
    fixture(
      chat({
        prompt_tokens: 100,
        completion_tokens: 50,
        completion_tokens_details: { reasoning_tokens: 40 },
      }),
    );
    const model = "dashscope/qwen-plus-2025-04-28";
    const result = await completeChat({ model, messages: [], modelKwargs });
    expect(completionCost(result, model)).toBe(0.00021199999999999998);
    expect(
      (
        await new LitellmModel({
          model_name: model,
          model_kwargs: modelKwargs,
        }).query([])
      ).extra?.cost,
    ).toBe(0.00021199999999999998);
  });

  test.each([
    undefined,
    {},
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  ])(
    "unknown or zero usage preserves error and ignore modes, %j",
    async (usage) => {
      fixture(responses(usage));
      const config = { model_name: "openai/gpt-4o", model_kwargs: modelKwargs };
      await expect(
        new LitellmResponseModel(config).query([]),
      ).rejects.toBeInstanceOf(RuntimeError);
      expect(GLOBAL_MODEL_STATS.n_calls).toBe(0);
      expect(
        (
          await new LitellmResponseModel({
            ...config,
            cost_tracking: "ignore_errors",
          }).query([])
        ).extra?.cost,
      ).toBe(0);
      expect(GLOBAL_MODEL_STATS.n_calls).toBe(1);
    },
  );

  test("missing prices fail before stats and can be explicitly ignored", async () => {
    fixture(chat({ prompt_tokens: 1, completion_tokens: 1 }));
    const config = {
      model_name: "openai/no-price-billing-fixture",
      model_kwargs: modelKwargs,
    };
    await expect(new LitellmModel(config).query([])).rejects.toThrow(
      /not in the cost map/,
    );
    expect(GLOBAL_MODEL_STATS.n_calls).toBe(0);
    expect(
      (
        await new LitellmModel({
          ...config,
          cost_tracking: "ignore_errors",
        }).query([])
      ).extra?.cost,
    ).toBe(0);
    expect(GLOBAL_MODEL_STATS.n_calls).toBe(1);
  });

  test("format errors retain billed cost and increment stats only once", async () => {
    fixture(
      responses(
        {
          input_tokens: 1000,
          output_tokens: 100,
          total_tokens: 1100,
          input_tokens_details: { cached_tokens: 400 },
        },
        { output: [] },
      ),
    );
    try {
      await new LitellmResponseModel({
        model_name: "gpt-4o",
        model_kwargs: modelKwargs,
      }).query([]);
      throw new Error("Expected FormatError");
    } catch (error) {
      expect(error).toBeInstanceOf(FormatError);
      if (!(error instanceof FormatError)) throw error;
      expect(error.messages[0]?.extra?.cost).toBe(0.003);
    }
    expect(GLOBAL_MODEL_STATS.cost).toBe(0.003);
    expect(GLOBAL_MODEL_STATS.n_calls).toBe(1);
  });

  test.each([
    [200000, 0.60015],
    [200001, 1.200231],
  ])(
    "long context threshold prices the whole query at %s tokens",
    async (prompt, expected) => {
      fixture(chat({ prompt_tokens: prompt, completion_tokens: 10 }));
      const model = "anthropic.claude-sonnet-4-20250514-v1:0";
      expect(
        (
          await new LitellmModel({
            model_name: model,
            model_kwargs: { ...modelKwargs, custom_llm_provider: "openai" },
          }).query([])
        ).extra?.cost,
      ).toBeCloseTo(expected, 12);
    },
  );

  test.each([
    ["gpt-4o", "openai/unknown-billing-alias"],
    ["unknown-billing-alias", "gpt-4o"],
  ])(
    "uses source response-model preference and request fallback, %s",
    async (served, requested) => {
      fixture(
        chat({ prompt_tokens: 1, completion_tokens: 1 }, { model: served }),
      );
      expect(
        (
          await new LitellmModel({
            model_name: requested,
            model_kwargs: modelKwargs,
          }).query([])
        ).extra?.cost,
      ).toBe(0.0000125);
    },
  );

  test("Anthropic iteration usage sums cache and reported thinking tokens", async () => {
    fixture({
      model: "claude-sonnet-4-5-20250929",
      content: [
        {
          type: "tool_use",
          id: "call",
          name: "bash",
          input: { command: "true" },
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        iterations: [
          {
            input_tokens: 50,
            output_tokens: 10,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 30,
            cache_creation: {
              ephemeral_5m_input_tokens: 10,
              ephemeral_1h_input_tokens: 20,
            },
            output_tokens_details: { thinking_tokens: 4 },
          },
          {
            input_tokens: 5,
            output_tokens: 2,
            cache_creation_input_tokens: 3,
            output_tokens_details: { thinking_tokens: 1 },
          },
        ],
      },
    });
    const model = "anthropic/claude-sonnet-4-5-20250929";
    const result = await completeChat({ model, messages: [], modelKwargs });
    expect(result.usage).toMatchObject({
      prompt_tokens: 128,
      completion_tokens: 12,
      total_tokens: 140,
      prompt_tokens_details: {
        text_tokens: 55,
        cached_tokens: 40,
        cache_creation_tokens: 33,
        cache_creation_token_details: {
          ephemeral_5m_input_tokens: 13,
          ephemeral_1h_input_tokens: 20,
        },
      },
      completion_tokens_details: { reasoning_tokens: 5, text_tokens: 7 },
    });
    expect(
      (
        await new LitellmModel({
          model_name: model,
          model_kwargs: modelKwargs,
        }).query([])
      ).extra?.cost,
    ).toBe(0.0005257500000000001);
  });

  test.each([
    [199999, 0.25002375000000004],
    [200000, 0.50005],
  ])(
    "xAI uses its inclusive context threshold at %s tokens without claiming its transport",
    async (prompt, expected) => {
      fixture(chat({ prompt_tokens: prompt, completion_tokens: 10 }));
      expect(
        (
          await new LitellmModel({
            model_name: "xai/grok-4.20-multi-agent-beta-0309",
            model_kwargs: { ...modelKwargs, custom_llm_provider: "openai" },
          }).query([])
        ).extra?.cost,
      ).toBe(expected);
    },
  );

  test("an unpriced matching tier abandons tiered pricing", () => {
    registerModel({
      "parity-tier-gap": {
        litellm_provider: "openai",
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
        tiered_pricing: [
          { range: [0, 100], output_cost_per_token: 9 },
          {
            range: [100, 1000],
            input_cost_per_token: 0.00001,
            output_cost_per_token: 0.00002,
          },
        ],
      },
    });
    expect(
      completionCost(
        { usage: { prompt_tokens: 50, completion_tokens: 10 } },
        "parity-tier-gap",
      ),
    ).toBe(7e-5);
  });

  test("Dashscope ignores explicit text tokens and bills completion minus reasoning", () => {
    expect(
      completionCost(
        {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 100,
            completion_tokens_details: {
              reasoning_tokens: 40,
              text_tokens: 10,
            },
          },
        },
        "dashscope/deepseek-v4-flash",
      ),
    ).toBe(5.9999999999999995e-5);
  });

  test("registered Dashscope rates bill reasoning apart from output and ignore text tokens", () => {
    registerModel({
      "billing-dashscope-split": {
        litellm_provider: "dashscope",
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000002,
        output_cost_per_reasoning_token: 0.000007,
      },
    });
    expect(
      completionCost(
        {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 100,
            completion_tokens_details: {
              reasoning_tokens: 40,
              text_tokens: 10,
            },
          },
        },
        "billing-dashscope-split",
      ),
    ).toBe(0.0007);
  });

  test("xAI adds unnormalized reasoning into completion and clears detail billing", () => {
    expect(
      completionCost(
        {
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 10,
            completion_tokens_details: { reasoning_tokens: 3 },
          },
        },
        "xai/grok-4.3",
      ),
    ).toBe(3.2500000000000004e-5);
    expect(
      completionCost(
        {
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            completion_tokens_details: { reasoning_tokens: 3 },
          },
        },
        "xai/grok-4.3",
      ),
    ).toBe(0.000025);
  });

  test("registered xAI rates keep raw and normalized usage on the output rate", () => {
    registerModel({
      "billing-xai-split": {
        litellm_provider: "xai",
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0.000011,
        output_cost_per_reasoning_token: 0.000099,
      },
    });
    const details = { reasoning_tokens: 3 };
    expect(
      completionCost(
        {
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 10,
            completion_tokens_details: details,
          },
        },
        "billing-xai-split",
      ),
    ).toBe(0.000138);
    expect(
      completionCost(
        {
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            completion_tokens_details: details,
          },
        },
        "billing-xai-split",
      ),
    ).toBe(0.000105);
  });

  test("tier tables keep the selected cache and reasoning rates including explicit zero", async () => {
    registerModel({
      "billing-tier-table": {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
        tiered_pricing: [
          { range: [0, 32000], input_cost_per_token: 0.000001 },
          {
            range: [32000, 128000],
            input_cost_per_token: 0.000004,
            output_cost_per_token: 0.000008,
            cache_read_input_token_cost: 0,
            cache_creation_input_token_cost: 0.000005,
            cache_creation_input_token_cost_above_1hr: 0,
            output_cost_per_reasoning_token: 0.00001,
          },
        ],
      },
    });
    fixture(
      chat({
        prompt_tokens: 40000,
        completion_tokens: 50,
        prompt_tokens_details: {
          cached_tokens: 1000,
          cache_creation_tokens: 30,
          cache_creation_token_details: {
            ephemeral_5m_input_tokens: 10,
            ephemeral_1h_input_tokens: 20,
          },
        },
        completion_tokens_details: { reasoning_tokens: 40 },
      }),
    );
    expect(
      (
        await new LitellmModel({
          model_name: "billing-tier-table",
          model_kwargs: modelKwargs,
        }).query([])
      ).extra?.cost,
    ).toBeCloseTo(0.15641, 12);
  });

  test.each([
    {
      input_tokens: 1000,
      output_tokens: 100,
      total_tokens: 1100,
      input_tokens_details: { audio_tokens: 10 },
    },
    { input_tokens: 1000, output_tokens: 100, total_tokens: 1100, cost: 0.5 },
    42,
    { input_tokens: "unknown", output_tokens: 100, total_tokens: 1100 },
  ])(
    "unimplemented usage schedules stay errors or explicitly ignored, %j",
    async (usage) => {
      fixture(responses(usage));
      const config = { model_name: "gpt-4o", model_kwargs: modelKwargs };
      await expect(new LitellmResponseModel(config).query([])).rejects.toThrow(
        /parity gate/i,
      );
      expect(GLOBAL_MODEL_STATS.n_calls).toBe(0);
      expect(
        (
          await new LitellmResponseModel({
            ...config,
            cost_tracking: "ignore_errors",
          }).query([])
        ).extra?.cost,
      ).toBe(0);
    },
  );

  test.each([{ litellm_provider: "fireworks_ai" }, { off_peak_pricing: {} }])(
    "unproven provider and time schedules are explicit gates, %j",
    async (schedule) => {
      const model = `billing-gated-${schedule.litellm_provider ?? "off-peak"}`;
      registerModel({
        [model]: {
          input_cost_per_token: 0.000001,
          output_cost_per_token: 0.000002,
          ...schedule,
        },
      });
      fixture(chat({ prompt_tokens: 10, completion_tokens: 1 }));
      await expect(
        new LitellmModel({
          model_name: model,
          model_kwargs: modelKwargs,
        }).query([]),
      ).rejects.toThrow(/parity gate/i);
      expect(GLOBAL_MODEL_STATS.n_calls).toBe(0);
    },
  );

  test("registered missing cache prices fall back and explicit zero stays zero", async () => {
    registerModel({
      "billing-cache-default": {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000008,
      },
      "billing-cache-zero": {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000008,
        cache_read_input_token_cost: 0,
      },
    });
    fixture(
      chat({
        prompt_tokens: 10,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 10 },
      }),
    );
    expect(
      (
        await new LitellmModel({
          model_name: "billing-cache-default",
          model_kwargs: modelKwargs,
        }).query([])
      ).extra?.cost,
    ).toBe(0.000019999999999999998);
    const zeroResponse = await completeChat({
      model: "billing-cache-zero",
      messages: [],
      modelKwargs,
    });
    expect(completionCost(zeroResponse, "billing-cache-zero")).toBe(0);
    await expect(
      new LitellmModel({
        model_name: "billing-cache-zero",
        model_kwargs: modelKwargs,
      }).query([]),
    ).rejects.toThrow(/Cost must be > 0/);
  });
});
