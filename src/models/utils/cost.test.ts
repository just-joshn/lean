import { describe, expect, test } from "vitest";
import { completionCost, registerModel } from "./cost.ts";

describe("completionCost", () => {
  test("prices a built-in model from the litellm catalog", () => {
    const response = {
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 1500,
      },
    };
    expect(completionCost(response, "gpt-4o")).toBeCloseTo(0.0075);
    expect(completionCost(response, "openai/gpt-4o")).toBeCloseTo(0.0075);
  });

  test("prices cached prompt tokens at the cache read rate", () => {
    const response = {
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 100,
        prompt_tokens_details: { cached_tokens: 400 },
      },
    };
    expect(completionCost(response, "gpt-4o")).toBeCloseTo(0.003);
  });

  test("prices normalized anthropic cache tokens", () => {
    const response = {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
      },
    };
    expect(
      completionCost(response, "anthropic/claude-sonnet-4-5-20250929"),
    ).toBeCloseTo(0.0009495);
  });

  test("adds raw anthropic input tokens to cache tokens before pricing", () => {
    const response = {
      usage: {
        input_tokens: 50,
        output_tokens: 50,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
      },
    };
    expect(
      completionCost(response, "anthropic/claude-sonnet-4-5-20250929"),
    ).toBeCloseTo(0.0009495);
  });

  test("uses a custom registry and defaults omitted cache prices to the input price", () => {
    registerModel({
      "local/my-model": {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000008,
      },
      "local/priced": {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000008,
        cache_read_input_token_cost: 0.0000001,
      },
    });
    const cached = {
      usage: {
        prompt_tokens: 10,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 10 },
      },
    };
    expect(completionCost(cached, "local/my-model")).toBeCloseTo(0.00002);
    expect(completionCost(cached, "local/priced")).toBeCloseTo(0.000001);
  });

  test("returns zero when usage is missing and throws when the model is unknown", () => {
    expect(completionCost({ model: "gpt-4o" }, "gpt-4o")).toBe(0);
    expect(() =>
      completionCost(
        { usage: { prompt_tokens: 1, completion_tokens: 1 } },
        "no-such-model-xyz",
      ),
    ).toThrow(/no-such-model-xyz/);
  });
});
