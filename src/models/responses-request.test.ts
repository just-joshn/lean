import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Message } from "../protocols.ts";
import { UnsupportedParamsError } from "./errors.ts";
import { ProviderParityGateError } from "./route.ts";
import { completeResponses } from "./responses.ts";
import { completeChat } from "./transport.ts";
import { receiveResponse } from "./received-response.ts";

vi.mock("./received-response.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./received-response.ts")>()),
  receiveResponse: vi.fn(),
}));

interface SourceError {
  name: string;
  message: string;
}
interface RequestCase {
  name: string;
  options: {
    model: string;
    input: Message[];
    tools?: unknown[];
    modelKwargs: Record<string, unknown>;
  };
  body?: Record<string, unknown>;
  error?: SourceError;
}
const source: {
  cases: RequestCase[];
  frequency: {
    provider: string;
    model: string;
    drop: boolean;
    params?: Record<string, unknown>;
    error?: SourceError;
  }[];
  gates: string[];
} = JSON.parse(
  readFileSync(
    new URL("./fixtures/responses-request.json", import.meta.url),
    "utf8",
  ),
);
const receive = vi.mocked(receiveResponse);
let bodies: Record<string, unknown>[];

beforeEach(() => {
  bodies = [];
  receive.mockReset();
  receive.mockImplementation(async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)));
    const text = '{"id":"fixture","created_at":1,"output":[]}';
    return {
      bytes: new TextEncoder().encode(text),
      text,
      status: 200,
      statusText: "fixture",
      ok: true,
    };
  });
});

function nativeError(error: SourceError) {
  return {
    name: error.name,
    message: error.message.replace(/^litellm\.UnsupportedParamsError: /u, ""),
  };
}

describe("source-proven Responses requests", () => {
  test.each(source.cases)("$name", async (fixture) => {
    const options = structuredClone(fixture.options);
    if (fixture.error) {
      const completion = completeResponses(options);
      await expect(completion).rejects.toMatchObject(
        nativeError(fixture.error),
      );
      await expect(completion).rejects.toBeInstanceOf(UnsupportedParamsError);
      expect(receive).not.toHaveBeenCalled();
      expect(bodies).toEqual([]);
    } else {
      await completeResponses(options);
      expect(receive).toHaveBeenCalledTimes(1);
      expect(bodies).toEqual([fixture.body]);
    }
    expect(options).toEqual(fixture.options);
  });

  test.each(source.frequency)(
    "$provider frequency_penalty drop=$drop",
    async (fixture) => {
      const complete = () =>
        completeChat({
          model: `${fixture.provider}/${fixture.model}`,
          messages: [{ role: "user", content: "task" }],
          modelKwargs: {
            frequency_penalty: 0.5,
            drop_params: fixture.drop,
          },
        });
      if (fixture.error) {
        await expect(complete()).rejects.toMatchObject(
          nativeError(fixture.error),
        );
        expect(receive).not.toHaveBeenCalled();
      } else {
        await complete();
        expect(receive).toHaveBeenCalledTimes(1);
        expect(bodies[0]).toMatchObject({ model: fixture.model });
        const body = bodies[0];
        expect(body?.frequency_penalty).toEqual(
          fixture.params?.frequency_penalty,
        );
        expect(Object.hasOwn(body ?? {}, "frequency_penalty")).toBe(
          Object.hasOwn(fixture.params ?? {}, "frequency_penalty"),
        );
      }
    },
  );

  test.each([
    { allOf: [{ $ref: "#/$defs/object" }] },
    { anyOf: [{ allOf: [{ type: "object" }] }] },
  ])("keeps unproven schema branches gated for %j", async (parameters) => {
    await expect(
      completeResponses({
        model: "openai/gpt-4o",
        input: [],
        tools: [{ type: "function", name: "f", parameters }],
      }),
    ).rejects.toBeInstanceOf(ProviderParityGateError);
    expect(receive).not.toHaveBeenCalled();
  });

  test("boolean temperature uses Python equality and spelling", async () => {
    await completeResponses({
      model: "openai/gpt-5",
      input: [],
      modelKwargs: { temperature: true },
    });
    expect(receive).toHaveBeenCalledTimes(1);
    expect(bodies[0]?.temperature).toBe(true);

    const rejected = completeResponses({
      model: "openai/gpt-5",
      input: [],
      modelKwargs: { temperature: false },
    });
    await expect(rejected).rejects.toBeInstanceOf(UnsupportedParamsError);
    await expect(rejected).rejects.toThrow(/temperature=False/u);
    await expect(rejected).rejects.not.toThrow(/temperature=false/u);
    expect(receive).toHaveBeenCalledTimes(1);
  });

  test("a schemeless api_base is a non-OpenAI host instead of an invalid URL", async () => {
    await completeResponses({
      model: "openai/gpt-5.6",
      input: [
        {
          role: "user",
          content: "task",
          cache_control: { type: "ephemeral" },
        },
      ],
      modelKwargs: { api_base: "proxy.test/v1", num_retries: 8 },
    });
    expect(receive).toHaveBeenCalledTimes(1);
    const [url, init] = receive.mock.calls[0] ?? [];
    expect(url).toBe("proxy.test/v1/responses");
    expect(init?.method).toBe("POST");
    expect(bodies[0]?.model).toBe("gpt-5.6");
    expect(bodies[0]?.input).toEqual([{ role: "user", content: "task" }]);
    expect(JSON.stringify(bodies[0]?.input)).not.toContain("cache_control");
  });

  for (const gate of source.gates) test.todo(gate);
});
