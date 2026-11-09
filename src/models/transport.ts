import type { Message } from "../protocols.ts";
import {
  AuthenticationError,
  ContextWindowExceededError,
  NotFoundError,
  PermissionDeniedError,
  UnsupportedParamsError,
} from "./errors.ts";

export interface ChatResponse {
  choices: Array<{
    finish_reason: string | null;
    message: Message & { tool_calls?: unknown };
  }>;
  usage?: Record<string, unknown>;
  model_dump: () => Record<string, unknown>;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseOf(body: Record<string, unknown>): ChatResponse {
  return Object.assign({}, body, {
    model_dump: () => structuredClone(body),
  }) as ChatResponse;
}

function statusError(status: number, detail: string): Error {
  const text = detail.toLowerCase();
  if (status === 401) return new AuthenticationError(detail);
  if (status === 403) return new PermissionDeniedError(detail);
  if (status === 404) return new NotFoundError(detail);
  if (
    status === 400 &&
    /context|maximum context|context window|prompt is too long/.test(text)
  ) {
    return new ContextWindowExceededError(detail);
  }
  if (
    status === 400 &&
    /unsupported|unknown parameter|unexpected keyword/.test(text)
  ) {
    return new UnsupportedParamsError(detail);
  }
  return new Error(detail);
}

function stripProvider(model: string, provider: string): string {
  const prefix = `${provider}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/u, "")}/${path.replace(/^\//u, "")}`;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  let parsed: unknown = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: text };
    }
  }
  if (!response.ok) {
    const detail = isRecord(parsed)
      ? JSON.stringify(parsed.error ?? parsed)
      : text;
    throw statusError(response.status, detail || response.statusText);
  }
  if (!isRecord(parsed))
    throw new Error("Model response was not a JSON object.");
  return parsed;
}

function imageBlock(block: Record<string, unknown>): Record<string, unknown> {
  const image = block.image_url;
  const url =
    typeof image === "string"
      ? image
      : isRecord(image)
        ? String(image.url ?? "")
        : "";
  const cache =
    "cache_control" in block ? { cache_control: block.cache_control } : {};
  if (url.startsWith("https://")) {
    return { type: "image", source: { type: "url", url }, ...cache };
  }
  const match = /^data:([^;,]+);base64,([\s\S]*)$/u.exec(url);
  if (!match) return block;
  return {
    type: "image",
    source: { type: "base64", media_type: match[1], data: match[2] },
    ...cache,
  };
}

function contentBlocks(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!isRecord(block)) return [];
    if (block.type === "image_url") return [imageBlock(block)];
    if (block.type === "text") {
      const text: Record<string, unknown> = { type: "text", text: block.text };
      if (block.cache_control) text.cache_control = block.cache_control;
      return [text];
    }
    return [block];
  });
}

function toolResult(message: Message): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: "tool_result",
    tool_use_id: message.tool_call_id,
    content:
      typeof message.content === "string"
        ? message.content
        : contentBlocks(message.content),
  };
  if (message.cache_control) result.cache_control = message.cache_control;
  return result;
}

function toolUse(call: unknown): Record<string, unknown> | undefined {
  if (!isRecord(call) || !isRecord(call.function)) return undefined;
  let input: unknown = {};
  try {
    input = JSON.parse(String(call.function.arguments ?? "{}"));
  } catch {
    input = {};
  }
  return {
    type: "tool_use",
    id: call.id,
    name: call.function.name,
    input,
  };
}

function thinkingBlocks(message: Message): unknown[] {
  return Array.isArray(message.thinking_blocks) ? message.thinking_blocks : [];
}

function assistantBlocks(message: Message): unknown[] {
  const content = message.content;
  const listed = Array.isArray(content);
  const inlineThinking =
    listed &&
    content.some(
      (block) =>
        isRecord(block) &&
        (block.type === "thinking" || block.type === "redacted_thinking"),
    );
  const blocks: unknown[] = [];
  if (!inlineThinking) blocks.push(...thinkingBlocks(message));
  if (typeof content === "string" && content) {
    const text: Record<string, unknown> = { type: "text", text: content };
    if (message.cache_control) text.cache_control = message.cache_control;
    blocks.push(text);
  } else if (listed) {
    blocks.push(...contentBlocks(content));
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const block = toolUse(call);
      if (block) blocks.push(block);
    }
  }
  return blocks;
}

function anthropicMessages(messages: Message[]): {
  system?: unknown[];
  messages: unknown[];
} {
  const system: unknown[] = [];
  const converted: unknown[] = [];
  let index = 0;
  for (const message of messages) {
    if (message.role !== "system") continue;
    if (typeof message.content === "string") {
      if (!message.content) continue;
      const block: Record<string, unknown> = {
        type: "text",
        text: message.content,
      };
      if (message.cache_control) block.cache_control = message.cache_control;
      system.push(block);
    } else {
      for (const block of contentBlocks(message.content)) {
        if (isRecord(block) && block.type === "text" && !block.text) continue;
        system.push(block);
      }
    }
  }
  while (index < messages.length) {
    const message = messages[index];
    if (!message || message.role === "system") {
      index += 1;
      continue;
    }
    if (
      message.role === "user" ||
      message.role === "tool" ||
      message.role === "function"
    ) {
      const content: unknown[] = [];
      while (index < messages.length) {
        const current = messages[index];
        if (
          !current ||
          !["user", "tool", "function"].includes(String(current.role))
        )
          break;
        if (current.role === "tool" || current.role === "function")
          content.push(toolResult(current));
        else content.push(...contentBlocks(current.content));
        index += 1;
      }
      if (content.length > 0) converted.push({ role: "user", content });
      continue;
    }
    if (message.role === "assistant") {
      const content: unknown[] = [];
      while (index < messages.length && messages[index]?.role === "assistant") {
        const current = messages[index];
        if (current) content.push(...assistantBlocks(current));
        index += 1;
      }
      converted.push({ role: "assistant", content });
      continue;
    }
    converted.push({ role: message.role, content: message.content });
    index += 1;
  }
  return {
    system: system.length > 0 ? system : undefined,
    messages: converted,
  };
}

function fromAnthropic(body: Record<string, unknown>): ChatResponse {
  const blocks = Array.isArray(body.content) ? body.content : [];
  const toolCalls = blocks.flatMap((block, index) => {
    if (!isRecord(block) || block.type !== "tool_use") return [];
    return [
      {
        index,
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      },
    ];
  });
  const thinking = blocks.filter(
    (block) =>
      isRecord(block) &&
      (block.type === "thinking" || block.type === "redacted_thinking"),
  );
  const text = blocks
    .filter((block) => isRecord(block) && block.type === "text")
    .map((block) => (isRecord(block) ? String(block.text ?? "") : ""))
    .join("");
  const reasoning = thinking
    .map((block) =>
      isRecord(block) && block.type === "thinking"
        ? String(block.thinking ?? "")
        : "",
    )
    .filter((item) => item)
    .join("");
  const usage = isRecord(body.usage) ? body.usage : {};
  const input = Number(usage.input_tokens ?? 0);
  const read = Number(usage.cache_read_input_tokens ?? 0);
  const created = Number(usage.cache_creation_input_tokens ?? 0);
  const output = Number(usage.output_tokens ?? 0);
  const stop = body.stop_reason;
  const finish =
    stop === "tool_use"
      ? "tool_calls"
      : stop === "max_tokens"
        ? "length"
        : stop === "end_turn"
          ? "stop"
          : String(stop ?? "stop");
  return responseOf({
    choices: [
      {
        finish_reason: finish,
        message: {
          role: "assistant",
          content: text || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : null,
          function_call: null,
          provider_specific_fields: {
            citations: null,
            thinking_blocks: thinking.length > 0 ? thinking : null,
          },
          ...(thinking.length > 0
            ? { thinking_blocks: thinking, reasoning_content: reasoning }
            : {}),
        },
      },
    ],
    usage: {
      prompt_tokens: input + read + created,
      completion_tokens: output,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: created,
    },
  });
}

function usesAnthropic(model: string): boolean {
  const name = model.toLowerCase();
  return name.startsWith("anthropic/") || name.startsWith("claude");
}

export async function completeChat(options: {
  model: string;
  messages: Message[];
  tools?: unknown[];
  modelKwargs?: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<ChatResponse> {
  const kwargs = { ...(options.modelKwargs ?? {}) };
  const apiKey =
    typeof kwargs.api_key === "string" ? kwargs.api_key : undefined;
  const apiBase =
    typeof kwargs.api_base === "string" ? kwargs.api_base : undefined;
  delete kwargs.api_key;
  delete kwargs.api_base;
  delete kwargs.custom_llm_provider;
  delete kwargs.drop_params;
  if (usesAnthropic(options.model)) {
    const key = apiKey || process.env.ANTHROPIC_API_KEY || "";
    const converted = anthropicMessages(options.messages);
    const tools = (options.tools ?? []).flatMap((tool) => {
      if (!isRecord(tool) || !isRecord(tool.function)) return [];
      return [
        {
          name: tool.function.name,
          description: tool.function.description,
          input_schema: tool.function.parameters,
        },
      ];
    });
    const body = await postJson(
      joinUrl(apiBase || "https://api.anthropic.com", "/v1/messages"),
      {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      {
        model: stripProvider(options.model, "anthropic"),
        max_tokens: 4096,
        system: converted.system,
        messages: converted.messages,
        tools,
        ...kwargs,
      },
      options.signal,
    );
    return fromAnthropic(body);
  }
  const key = apiKey || process.env.OPENAI_API_KEY || "";
  const base = apiBase || "https://api.openai.com/v1";
  const body = await postJson(
    joinUrl(base, "/chat/completions"),
    {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    {
      model: stripProvider(options.model, "openai"),
      messages: options.messages,
      ...(options.tools ? { tools: options.tools } : {}),
      ...kwargs,
    },
    options.signal,
  );
  return responseOf(body);
}
