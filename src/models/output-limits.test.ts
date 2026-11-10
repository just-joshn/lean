import { afterEach, describe, expect, test, vi } from "vitest";
import { completeChat } from "./transport.ts";
import { lookupModelInfo, registerModel } from "./utils/cost.ts";

const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function installFetch(): void {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const parsed: unknown = JSON.parse(String(init?.body ?? "{}"));
      if (!isRecord(parsed)) throw new Error("request body was not an object");
      calls.push({ url: String(input), body: parsed });
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function anthropicMax(
  model: string,
  modelKwargs: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  installFetch();
  await completeChat({
    model,
    messages: [{ role: "user", content: "task" }],
    modelKwargs: {
      api_key: "fixture",
      api_base: "http://anthropic.test",
      ...modelKwargs,
    },
  });
  const body = calls[0]?.body;
  if (!body) throw new Error("completeChat made no request");
  return body;
}

describe("anthropic output limits", () => {
  test("uses the catalog output limit for claude-sonnet-4-5-20250929", async () => {
    const body = await anthropicMax("anthropic/claude-sonnet-4-5-20250929", {
      drop_params: true,
      temperature: 0,
    });
    expect(body.max_tokens).toBe(64000);
    expect(body.model).toBe("claude-sonnet-4-5-20250929");
    expect(body).not.toHaveProperty("drop_params");
    expect(body.temperature).toBe(0);
  });

  test("uses the same catalog limit for the unprefixed sonnet 4.5 alias", async () => {
    const body = await anthropicMax("claude-sonnet-4-5");
    expect(body.max_tokens).toBe(64000);
  });

  test("uses a different catalog limit for claude-sonnet-5", async () => {
    const body = await anthropicMax("claude-sonnet-5");
    expect(body.max_tokens).toBe(128000);
  });

  test("falls back to 4096 when the anthropic model is not in the catalog", async () => {
    const body = await anthropicMax("anthropic/claude-not-a-model");
    expect(body.max_tokens).toBe(4096);
  });

  test("does not inject an output limit into an openai chat request", async () => {
    installFetch();
    await completeChat({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "task" }],
      modelKwargs: { api_key: "fixture", api_base: "http://openai.test" },
    });
    expect(calls[0]?.body).not.toHaveProperty("max_tokens");
    expect(calls[0]?.body).not.toHaveProperty("max_completion_tokens");
  });

  test.for([
    {
      label: "max_completion_tokens",
      kwargs: { max_completion_tokens: 77 },
      expected: 77,
    },
    {
      label: "later max_completion_tokens",
      kwargs: { max_tokens: 10, max_completion_tokens: 20 },
      expected: 20,
    },
    {
      label: "max_completion_tokens regardless of insertion order",
      kwargs: { max_completion_tokens: 20, max_tokens: 10 },
      expected: 20,
    },
    { label: "null", kwargs: { max_tokens: null }, expected: 64000 },
    {
      label: "null alias",
      kwargs: { max_completion_tokens: null },
      expected: 64000,
    },
    { label: "boolean true", kwargs: { max_tokens: true }, expected: true },
    { label: "boolean false", kwargs: { max_tokens: false }, expected: false },
    { label: "integer zero", kwargs: { max_tokens: 0 }, expected: 0 },
    { label: "negative integer", kwargs: { max_tokens: -3 }, expected: -3 },
    { label: "float 1.6", kwargs: { max_tokens: 1.6 }, expected: 2 },
    { label: "float 0.4", kwargs: { max_tokens: 0.4 }, expected: 1 },
    { label: "float 1.5", kwargs: { max_tokens: 1.5 }, expected: 2 },
    { label: "float 2.5", kwargs: { max_tokens: 2.5 }, expected: 2 },
    { label: "float -1.2", kwargs: { max_tokens: -1.2 }, expected: 1 },
  ])("sends $label as max_tokens $expected", async ({ kwargs, expected }) => {
    const body = await anthropicMax("claude-sonnet-4-5-20250929", kwargs);
    expect(body.max_tokens).toBe(expected);
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  test.for([
    { label: "numeric string", kwargs: { max_tokens: "100" } },
    {
      label: "bad max_completion_tokens",
      kwargs: { max_completion_tokens: "nope" },
    },
    {
      label: "invalid max_tokens ahead of a valid alias",
      kwargs: { max_tokens: "nope", max_completion_tokens: 20 },
    },
    { label: "NaN", kwargs: { max_tokens: Number.NaN } },
    { label: "infinity", kwargs: { max_tokens: Number.POSITIVE_INFINITY } },
  ])("rejects $label before the request", async ({ kwargs }) => {
    installFetch();
    await expect(
      completeChat({
        model: "claude-sonnet-4-5-20250929",
        messages: [{ role: "user", content: "task" }],
        modelKwargs: {
          api_key: "fixture",
          api_base: "http://anthropic.test",
          ...kwargs,
        },
      }),
    ).rejects.toMatchObject({ name: "APIConnectionError" });
    expect(calls).toHaveLength(0);
  });
});

test.for([
  { raw: "8192", expected: 8192 },
  { raw: "0", expected: 0 },
  { raw: "-2", expected: -2 },
  { raw: " 2_048 ", expected: 2048 },
  { raw: "bad", expected: 4096 },
  { raw: "12.5", expected: 4096 },
  { raw: "", expected: 4096 },
])("captures fallback $raw at import", async ({ raw, expected }) => {
  vi.stubEnv("DEFAULT_ANTHROPIC_CHAT_MAX_TOKENS", raw);
  vi.resetModules();
  const transport = await import("./transport.ts");
  vi.stubEnv("DEFAULT_ANTHROPIC_CHAT_MAX_TOKENS", "999");
  installFetch();
  await transport.completeChat({
    model: "anthropic/claude-not-a-model",
    messages: [{ role: "user", content: "task" }],
    modelKwargs: { api_key: "fixture", api_base: "http://anthropic.test" },
  });
  expect(calls[0]?.body.max_tokens).toBe(expected);
});

describe("registerModel merge", () => {
  test("shallow-merges nested metadata without converting its contents", () => {
    registerModel({
      "local/nested": { metadata: { keep: 1, replace: { old: 1 } } },
    });
    registerModel({
      "local/nested": {
        metadata: { replace: { next: 2 }, literal: null, numeric: "20" },
      },
    });
    expect(lookupModelInfo("local/nested")?.metadata).toEqual({
      keep: 1,
      replace: { next: 2 },
      literal: null,
      numeric: "20",
    });
  });
  test("keeps catalog metadata when a partial override changes the output limit", async () => {
    const model = "claude-sonnet-4-5-20250929";
    const original = lookupModelInfo(model);
    registerModel({ [model]: { max_output_tokens: 1234 } });
    try {
      const info = lookupModelInfo(model);
      expect(info?.max_output_tokens).toBe(1234);
      expect(info?.max_input_tokens).toBe(200000);
      expect(info?.input_cost_per_token).toBe(0.000003);
      expect(info?.mode).toBe("chat");
      expect(info?.litellm_provider).toBe("anthropic");
      const body = await anthropicMax(`anthropic/${model}`);
      expect(body.max_tokens).toBe(1234);
    } finally {
      if (original) registerModel({ [model]: original });
    }
  });

  test("writes a prefixed catalog override onto the catalog key", async () => {
    const model = "claude-sonnet-4-5-20250929";
    const original = lookupModelInfo(model);
    registerModel({ [`anthropic/${model}`]: { max_output_tokens: 111 } });
    try {
      expect(lookupModelInfo(model)?.max_output_tokens).toBe(111);
      expect(lookupModelInfo(model)?.max_input_tokens).toBe(200000);
      expect(lookupModelInfo(`anthropic/${model}`)?.max_output_tokens).toBe(
        111,
      );
      expect(lookupModelInfo("claude-sonnet-4-5")?.max_output_tokens).toBe(
        64000,
      );
      const body = await anthropicMax(`anthropic/${model}`);
      expect(body.max_tokens).toBe(111);
    } finally {
      if (original) registerModel({ [model]: original });
    }
  });

  test("keeps an unknown prefixed registration on that key", () => {
    registerModel({
      "anthropic/claude-custom-output-limit": {
        max_tokens: 50,
        litellm_provider: "anthropic",
        mode: "chat",
      },
    });
    expect(
      lookupModelInfo("anthropic/claude-custom-output-limit")?.max_tokens,
    ).toBe(50);
    expect(lookupModelInfo("claude-custom-output-limit")).toBeUndefined();
  });

  test("merges a later registration and ignores null", async () => {
    registerModel({
      "claude-output-limit-keep": {
        max_tokens: 50,
        mode: "chat",
        litellm_provider: "anthropic",
      },
    });
    registerModel({
      "claude-output-limit-keep": { max_output_tokens: 40 },
    });
    const merged = lookupModelInfo("claude-output-limit-keep");
    expect(merged?.max_output_tokens).toBe(40);
    expect(merged?.max_tokens).toBe(50);
    expect(merged?.mode).toBe("chat");
    expect(merged?.litellm_provider).toBe("anthropic");

    registerModel({
      "claude-output-limit-keep": { max_output_tokens: null },
    });
    const kept = lookupModelInfo("claude-output-limit-keep");
    expect(kept?.max_output_tokens).toBe(40);
    expect(kept?.max_tokens).toBe(50);
    expect(kept?.mode).toBe("chat");
    const body = await anthropicMax("claude-output-limit-keep");
    expect(body.max_tokens).toBe(40);
  });

  test("omits a null output limit on a new model and uses max_tokens", async () => {
    registerModel({
      "claude-output-limit-null": {
        max_output_tokens: null,
        max_tokens: 80,
        litellm_provider: "anthropic",
        mode: "chat",
      },
    });
    const info = lookupModelInfo("claude-output-limit-null");
    expect(info).not.toHaveProperty("max_output_tokens");
    expect(info?.max_tokens).toBe(80);
    const body = await anthropicMax("claude-output-limit-null");
    expect(body.max_tokens).toBe(80);
  });

  test("prefers a present max_output_tokens of zero over max_tokens", async () => {
    registerModel({
      "claude-output-limit-zero": {
        max_output_tokens: 0,
        max_tokens: 80,
        litellm_provider: "anthropic",
        mode: "chat",
      },
    });
    const body = await anthropicMax("claude-output-limit-zero");
    expect(body.max_tokens).toBe(0);
  });

  test("uses max_tokens when max_output_tokens is absent", async () => {
    registerModel({
      "claude-output-limit-only": {
        max_tokens: 333,
        litellm_provider: "anthropic",
        mode: "chat",
      },
    });
    const body = await anthropicMax("claude-output-limit-only");
    expect(body.max_tokens).toBe(333);
  });

  test("prefers max_output_tokens when both catalog fields are present", async () => {
    registerModel({
      "claude-output-limit-both": {
        max_output_tokens: 222,
        max_tokens: 999,
        litellm_provider: "anthropic",
        mode: "chat",
      },
    });
    const body = await anthropicMax("claude-output-limit-both");
    expect(body.max_tokens).toBe(222);
  });

  test("converts numeric strings and keeps a non-numeric string", async () => {
    registerModel({
      "claude-output-limit-str": {
        max_output_tokens: "2222",
        litellm_provider: "anthropic",
        mode: "chat",
      },
    });
    expect(lookupModelInfo("claude-output-limit-str")?.max_output_tokens).toBe(
      2222,
    );
    const numeric = await anthropicMax("claude-output-limit-str");
    expect(numeric.max_tokens).toBe(2222);

    registerModel({
      "claude-output-limit-sci": {
        max_output_tokens: "3e-07",
        litellm_provider: "anthropic",
        mode: "chat",
      },
    });
    expect(lookupModelInfo("claude-output-limit-sci")?.max_output_tokens).toBe(
      3e-7,
    );

    registerModel({
      "claude-output-limit-hex": {
        max_output_tokens: "0x10",
        litellm_provider: "anthropic",
        mode: "chat",
      },
    });
    expect(lookupModelInfo("claude-output-limit-hex")?.max_output_tokens).toBe(
      "0x10",
    );

    registerModel({
      "claude-output-limit-badstr": {
        max_output_tokens: "nope",
        max_tokens: 9,
        litellm_provider: "anthropic",
        mode: "chat",
      },
    });
    expect(
      lookupModelInfo("claude-output-limit-badstr")?.max_output_tokens,
    ).toBe("nope");
    const raw = await anthropicMax("claude-output-limit-badstr");
    expect(raw.max_tokens).toBe("nope");
  });
});
