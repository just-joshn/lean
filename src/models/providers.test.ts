import { afterEach, describe, expect, test, vi } from "vitest";
import controls from "./fixtures/providers.json" with { type: "json" };
import { completeChat } from "./transport.ts";
import {
  OpenRouterModel,
  RequestyModel,
  PortkeyModel,
} from "./provider-models.ts";
import { receiveResponse, type ReceivedResponse } from "./received-response.ts";
import { FormatError } from "../exceptions.ts";

vi.mock("./received-response.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./received-response.ts")>()),
  receiveResponse: vi.fn(async () => {
    throw new Error("No network in provider controls");
  }),
}));

function source(name: string) {
  const row = controls.cases.find((row) => row.name === name);
  if (!row) throw new Error(`Missing source control ${name}`);
  return row;
}

function received(body: unknown, status = 200): ReceivedResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    text,
    bytes: new TextEncoder().encode(text),
    statusText: "fixture",
    ok: status === 200,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(receiveResponse).mockReset();
});

describe("Bedrock complete seam against saved source conversion", () => {
  test.each(["text", "tool", "length", "empty", "uncached", "missing total"])(
    "converts %s with full usage",
    async (name) => {
      const row = source(`bedrock ${name}`);
      vi.spyOn(Date, "now").mockReturnValue(1234000);
      const receive = vi.fn(async (_url: string, _init: RequestInit) =>
        received(row.body),
      );
      const result = await completeChat({
        model: "bedrock/anthropic.claude-3-haiku-20240307-v1:0",
        messages: [{ role: "user", content: "task" }],
        modelKwargs: { api_base: "https://fixture.invalid" },
        execution: { receive },
      });
      const dump = result.model_dump();
      expect(dump.id).toMatch(/^chatcmpl-[0-9a-f-]{36}$/u);
      expect(dump.created).toBe(1234);
      expect(receive.mock.calls[0]?.[0]).toBe(row.request!.url);
      expect(receive.mock.calls[0]?.[1].method).toBe("POST");
      expect(receive).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(receive.mock.calls[0]?.[1].body))).toEqual(
        row.request!.body,
      );
      expect({ ...dump, id: "source-id" }).toEqual(row.response);
    },
  );

  test.each([
    { trace: {} },
    { usage: { inputTokens: 1, outputTokens: 1, cacheDetails: [] } },
    { stopReason: "guardrail_intervened" },
    {
      output: {
        message: { role: "assistant", content: [{ reasoningContent: {} }] },
      },
    },
    {
      output: {
        message: {
          role: "assistant",
          content: [{ text: "<thinking>hidden</thinking>text" }],
        },
      },
    },
  ])("keeps unsampled Converse fields as explicit gates %j", async (extra) => {
    const body = { ...source("bedrock text").body, ...extra };
    await expect(
      completeChat({
        model: "bedrock/anthropic.claude-3-haiku-20240307-v1:0",
        messages: [],
        modelKwargs: { api_base: "https://fixture.invalid" },
        execution: { receive: vi.fn(async () => received(body)) },
      }),
    ).rejects.toMatchObject({ name: "ProviderParityGateError" });
  });

  test("AWS endpoint and SigV4 remain a no-send gate", async () => {
    const receive = vi.fn();
    await expect(
      completeChat({
        model: "bedrock/anthropic.claude-3-haiku-20240307-v1:0",
        messages: [],
        execution: { receive },
      }),
    ).rejects.toThrow("AWS endpoint selection and SigV4");
    expect(receive).not.toHaveBeenCalled();
  });
});

for (const [provider, ModelClass] of [
  ["openrouter", OpenRouterModel],
  ["requesty", RequestyModel],
] as const) {
  describe(`${provider} dedicated component against saved source query`, () => {
    test("preserves the request, raw response, query result, and config", async () => {
      const row = source(`${provider} query`);
      vi.stubEnv(`${provider.toUpperCase()}_API_KEY`, "source-fake-key");
      vi.spyOn(Date, "now").mockReturnValue(1234000);
      vi.mocked(receiveResponse).mockResolvedValue(received(row.response));
      const model = new ModelClass({
        model_name: "openai/gpt-4o",
        model_kwargs: { temperature: 0.3, api_key: "body-key" },
      });
      const result = await model.query(row.messages!, { temperature: 0.8 });
      expect(result).toEqual(row.result);
      expect(model.get_template_vars()).toEqual(row.config);
      const [url, init] = vi.mocked(receiveResponse).mock.calls[0]!;
      expect(url).toBe(row.request!.url);
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual(row.request!.headers);
      expect(JSON.parse(String(init.body))).toEqual(row.request!.body);
      expect(vi.mocked(receiveResponse)).toHaveBeenCalledTimes(1);
    });

    test("persists the full raw dictionary and cost on FormatError", async () => {
      const row = source(`${provider} format error`);
      vi.mocked(receiveResponse).mockResolvedValue(received(row.response));
      const model = new ModelClass({ model_name: "openai/gpt-4o" });
      const error = await model
        .query([{ role: "user", content: "task" }])
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(FormatError);
      expect(error).toHaveProperty("messages", row.messages);
    });

    test.each([0, -0.25])(
      "matches the source cost policy for %s",
      async (cost) => {
        const row = source(`${provider} cost ${cost}`);
        const response = structuredClone(source(`${provider} query`).response!);
        response.usage = { cost };
        vi.mocked(receiveResponse).mockResolvedValue(received(response));
        const model = new ModelClass({ model_name: "openai/gpt-4o" });
        if (row.error) {
          await expect(model.query([])).rejects.toMatchObject(row.error);
        } else {
          const result = await model.query([]);
          expect(result.extra?.cost).toBe(row.cost);
        }
      },
    );

    test("matches the missing-cost source error", async () => {
      const row = source(`${provider} missing cost`);
      vi.mocked(receiveResponse).mockResolvedValue(received(row.response));
      const model = new ModelClass({ model_name: "openai/gpt-4o" });
      await expect(model.query([])).rejects.toMatchObject(row.error!);
    });

    test("refuses streaming before sending", async () => {
      const model = new ModelClass({
        model_name: "openai/gpt-4o",
        model_kwargs: { stream: true },
      });
      await expect(model.query([])).rejects.toThrow("streaming");
      expect(receiveResponse).not.toHaveBeenCalled();
    });

    test.each([401, 429, 500])(
      "matches HTTP %s without falling through to LiteLLM",
      async (status) => {
        const row = source(`${provider} status ${status}`);
        vi.stubEnv("MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT", "1");
        vi.mocked(receiveResponse).mockResolvedValue(
          received("provider failure", status),
        );
        const model = new ModelClass({ model_name: "openai/gpt-4o" });
        await expect(model.query([])).rejects.toMatchObject(row.error!);
        expect(receiveResponse).toHaveBeenCalledTimes(1);
      },
    );
  });
}

test("OpenRouter ignore_errors preserves the returned negative cost", async () => {
  const row = source("openrouter ignored cost");
  const response = { ...source("openrouter query").response, ...row.response };
  vi.mocked(receiveResponse).mockResolvedValue(received(response));
  const model = new OpenRouterModel({
    model_name: "openai/gpt-4o",
    cost_tracking: "ignore_errors",
  });
  const result = await model.query([]);
  expect(result.extra?.cost).toBe(row.cost);
});

test("Portkey preserves its source missing-key error", () => {
  vi.stubEnv("PORTKEY_API_KEY", "");
  const expected = source("portkey missing key").error!;
  let thrown: unknown;
  try {
    new PortkeyModel({ model_name: "gpt-4o" });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).toMatchObject({
    name: expected.name,
    message: expected.message,
  });
});
