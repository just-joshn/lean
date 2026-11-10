import { afterEach, describe, expect, test, vi } from "vitest";
import type { Message } from "../protocols.ts";
import { completeChat } from "./transport.ts";
import {
  chatChoice,
  chatDump,
  chatMessage,
  dictionaryOrAttribute,
  messageFromDump,
} from "./response-access.ts";

const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function installFetch(payload: unknown): void {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const parsed: unknown = JSON.parse(String(init?.body ?? "{}"));
      if (!isRecord(parsed)) throw new Error("request body was not an object");
      calls.push({ url: String(input), body: parsed });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const anthropicReply = {
  content: [
    { type: "thinking", thinking: "hmm", signature: "sig_1" },
    { type: "redacted_thinking", data: "hidden" },
    { type: "text", text: "ok" },
    {
      type: "tool_use",
      id: "toolu_next",
      name: "bash",
      input: { command: "true" },
    },
  ],
  stop_reason: "tool_use",
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 4,
    cache_creation_input_tokens: 1,
  },
};

describe("anthropic message wire", () => {
  test("sends system cache blocks and turns a user string into text blocks", async () => {
    installFetch(anthropicReply);
    await completeChat({
      model: "anthropic/claude-sonnet-4-5-20250929",
      messages: [
        {
          role: "system",
          content: "rules",
          cache_control: { type: "ephemeral" },
        },
        { role: "system", content: "" },
        {
          role: "system",
          content: [
            { type: "text", text: "" },
            {
              type: "text",
              text: "more",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
        { role: "user", content: "task" },
      ],
      modelKwargs: { api_key: "fixture", api_base: "http://anthropic.test" },
    });
    expect(calls[0]?.url).toBe("http://anthropic.test/v1/messages");
    expect(calls[0]?.body.system).toEqual([
      { type: "text", text: "rules", cache_control: { type: "ephemeral" } },
      { type: "text", text: "more", cache_control: { type: "ephemeral" } },
    ]);
    expect(calls[0]?.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "task" }] },
    ]);
  });

  test("groups consecutive tool results and keeps the final observation and cache", async () => {
    installFetch(anthropicReply);
    await completeChat({
      model: "claude-sonnet-4-5-20250929",
      messages: [
        { role: "user", content: "task" },
        {
          role: "assistant",
          content: "run",
          tool_calls: [
            {
              id: "toolu_1",
              type: "function",
              function: { name: "bash", arguments: '{"command":"one"}' },
            },
            {
              id: "toolu_2",
              type: "function",
              function: { name: "bash", arguments: '{"command":"two"}' },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "toolu_1",
          content: "first observation",
        },
        {
          role: "tool",
          tool_call_id: "toolu_2",
          content: [{ type: "text", text: "second observation" }],
          cache_control: { type: "ephemeral" },
        },
        {
          role: "function",
          tool_call_id: "toolu_3",
          content: "function observation",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            description: "Execute a bash command",
            parameters: { type: "object" },
          },
        },
      ],
      modelKwargs: { api_key: "fixture", api_base: "http://anthropic.test" },
    });
    expect(calls[0]?.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "task" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "run" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "bash",
            input: { command: "one" },
          },
          {
            type: "tool_use",
            id: "toolu_2",
            name: "bash",
            input: { command: "two" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "first observation",
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: [{ type: "text", text: "second observation" }],
            cache_control: { type: "ephemeral" },
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_3",
            content: "function observation",
          },
        ],
      },
    ]);
  });

  test("replays assistant thinking blocks ahead of cached text and tool calls", async () => {
    installFetch({
      content: [{ type: "text", text: "next" }],
      stop_reason: "end_turn",
    });
    const prepared: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "ok", cache_control: { type: "ephemeral" } },
      ],
      thinking_blocks: [
        { type: "thinking", thinking: "hmm", signature: "sig_1" },
      ],
      tool_calls: [
        {
          id: "toolu_next",
          type: "function",
          function: { name: "bash", arguments: '{"command":"true"}' },
        },
      ],
    };
    await completeChat({
      model: "anthropic/claude-sonnet-4-5-20250929",
      messages: [{ role: "user", content: "task" }, prepared],
      modelKwargs: { api_key: "fixture", api_base: "http://anthropic.test" },
    });
    const messages = calls[0]?.body.messages;
    expect(Array.isArray(messages) ? messages[1] : undefined).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm", signature: "sig_1" },
        { type: "text", text: "ok", cache_control: { type: "ephemeral" } },
        {
          type: "tool_use",
          id: "toolu_next",
          name: "bash",
          input: { command: "true" },
        },
      ],
    });
  });

  test("does not duplicate thinking that is already inside assistant content", async () => {
    installFetch({
      content: [{ type: "text", text: "next" }],
      stop_reason: "end_turn",
    });
    await completeChat({
      model: "anthropic/claude-sonnet-4-5-20250929",
      messages: [
        { role: "user", content: "task" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm", signature: "sig_1" },
            { type: "text", text: "ok" },
          ],
          thinking_blocks: [
            { type: "thinking", thinking: "hmm", signature: "sig_1" },
          ],
        },
      ],
      modelKwargs: { api_key: "fixture", api_base: "http://anthropic.test" },
    });
    const messages = calls[0]?.body.messages;
    expect(Array.isArray(messages) ? messages[1] : undefined).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm", signature: "sig_1" },
        { type: "text", text: "ok" },
      ],
    });
  });

  test("converts image blocks inside a user turn", async () => {
    installFetch({
      content: [{ type: "text", text: "seen" }],
      stop_reason: "end_turn",
    });
    await completeChat({
      model: "anthropic/claude-sonnet-4-5-20250929",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "look",
              cache_control: { type: "ephemeral" },
            },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AAAA" },
              cache_control: { type: "ephemeral", ttl: "1h" },
            },
            {
              type: "image_url",
              image_url: { url: "https://images.example/cat.png" },
            },
          ],
        },
      ],
      modelKwargs: { api_key: "fixture", api_base: "http://anthropic.test" },
    });
    expect(calls[0]?.body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look", cache_control: { type: "ephemeral" } },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAAA" },
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
          {
            type: "image",
            source: { type: "url", url: "https://images.example/cat.png" },
          },
        ],
      },
    ]);
  });

  test("returns assistant text with thinking kept out of content", async () => {
    installFetch(anthropicReply);
    const response = await completeChat({
      model: "anthropic/claude-sonnet-4-5-20250929",
      messages: [{ role: "user", content: "task" }],
      modelKwargs: { api_key: "fixture", api_base: "http://anthropic.test" },
    });
    const message = messageFromDump(chatDump(chatMessage(response)));
    expect(message.content).toBe("ok");
    expect(message?.thinking_blocks).toEqual([
      { type: "thinking", thinking: "hmm", signature: "sig_1" },
      { type: "redacted_thinking", data: "hidden" },
    ]);
    expect(message?.reasoning_content).toBe("hmm");
    const toolCalls = message?.tool_calls;
    expect(toolCalls).toEqual([
      {
        index: 3,
        id: "toolu_next",
        type: "function",
        function: { name: "bash", arguments: expect.any(String) },
      },
    ]);
    const call = Array.isArray(toolCalls) ? toolCalls[0] : undefined;
    if (
      !isRecord(call) ||
      !isRecord(call.function) ||
      typeof call.function.arguments !== "string"
    ) {
      throw new Error("missing serialized tool arguments");
    }
    expect(JSON.parse(call.function.arguments)).toEqual({ command: "true" });
    expect(message?.provider_specific_fields).toEqual({
      citations: null,
      thinking_blocks: message?.thinking_blocks,
    });
    expect(response.usage).toEqual({
      prompt_tokens: 15,
      completion_tokens: 5,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 1,
      total_tokens: 20,
      prompt_tokens_details: {
        audio_tokens: null,
        cache_creation_token_details: null,
        cache_creation_tokens: 1,
        cache_write_tokens: 1,
        cached_tokens: 4,
        image_tokens: null,
        initial_prompt_tokens: null,
        text_tokens: 10,
        video_tokens: null,
      },
      completion_tokens_details: {
        accepted_prediction_tokens: null,
        audio_tokens: null,
        image_tokens: null,
        reasoning_tokens: null,
        rejected_prediction_tokens: null,
        text_tokens: null,
        video_tokens: null,
      },
      inference_geo: null,
      iterations: null,
      service_tier: null,
      speed: null,
    });
    expect(dictionaryOrAttribute(chatChoice(response), "finish_reason")).toBe(
      "tool_calls",
    );
  });

  test("concatenates multiple thinking blocks without a separator", async () => {
    installFetch({
      content: [
        { type: "thinking", thinking: "one" },
        { type: "redacted_thinking", data: "hidden" },
        { type: "thinking", thinking: "two" },
      ],
      stop_reason: "end_turn",
    });
    const response = await completeChat({
      model: "anthropic/claude-sonnet-4-5-20250929",
      messages: [{ role: "user", content: "task" }],
      modelKwargs: { api_key: "fixture", api_base: "http://anthropic.test" },
    });
    const message = messageFromDump(chatDump(chatMessage(response)));
    expect(message.reasoning_content).toBe("onetwo");
    expect(message.content).toBeNull();
  });

  test("returns null content when the reply has thinking and no text", async () => {
    installFetch({
      content: [{ type: "thinking", thinking: "only" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const response = await completeChat({
      model: "anthropic/claude-sonnet-4-5-20250929",
      messages: [{ role: "user", content: "task" }],
      modelKwargs: { api_key: "fixture", api_base: "http://anthropic.test" },
    });
    const message = messageFromDump(chatDump(chatMessage(response)));
    expect(message.content).toBeNull();
    expect(message?.thinking_blocks).toEqual([
      { type: "thinking", thinking: "only" },
    ]);
    expect(message?.reasoning_content).toBe("only");
    expect(message?.tool_calls).toBeNull();
  });

  test.each([
    { model: "anthropic/claude-sonnet-4-5-20250929", dropParams: true },
    { model: "anthropic/claude-sonnet-4-5-20250929", dropParams: false },
    { model: "openai/gpt-4o", dropParams: true },
    { model: "openai/gpt-4o", dropParams: false },
  ])(
    "consumes drop_params=$dropParams for $model",
    async ({ model, dropParams }) => {
      installFetch(
        model.startsWith("anthropic/")
          ? anthropicReply
          : { choices: [{ message: { role: "assistant", content: "ok" } }] },
      );
      await completeChat({
        model,
        messages: [{ role: "user", content: "task" }],
        modelKwargs: {
          api_key: "fixture",
          api_base: "http://provider.test/v1",
          drop_params: dropParams,
          temperature: 0,
        },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.body).not.toHaveProperty("drop_params");
      expect(calls[0]?.body.temperature).toBe(0);
    },
  );

  test("leaves an openai chat body unconverted", async () => {
    installFetch({
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: "hi" },
        },
      ],
    });
    const messages = [{ role: "user", content: "task" }];
    await completeChat({
      model: "openai/gpt-4o",
      messages,
      modelKwargs: { api_key: "fixture", api_base: "http://openai.test/v1" },
    });
    expect(calls[0]?.url).toBe("http://openai.test/v1/chat/completions");
    expect(calls[0]?.body.messages).toEqual(messages);
    expect(calls[0]?.body.model).toBe("gpt-4o");
  });
});
