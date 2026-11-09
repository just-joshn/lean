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

function anthropicMessages(messages: Message[]): {
  system?: string;
  messages: unknown[];
} {
  const system: string[] = [];
  const converted: unknown[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      if (typeof message.content === "string") system.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      converted.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id,
            content: typeof message.content === "string" ? message.content : "",
          },
        ],
      });
      continue;
    }
    if (message.role === "assistant") {
      const blocks: unknown[] = [];
      if (Array.isArray(message.content)) blocks.push(...message.content);
      else if (typeof message.content === "string" && message.content) {
        blocks.push({ type: "text", text: message.content });
      }
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (!isRecord(call) || !isRecord(call.function)) continue;
          let input: unknown = {};
          try {
            input = JSON.parse(String(call.function.arguments ?? "{}"));
          } catch {
            input = {};
          }
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.function.name,
            input,
          });
        }
      }
      converted.push({ role: "assistant", content: blocks });
      continue;
    }
    converted.push({ role: "user", content: message.content });
  }
  return {
    system: system.length > 0 ? system.join("\n\n") : undefined,
    messages: converted,
  };
}

function fromAnthropic(body: Record<string, unknown>): ChatResponse {
  const blocks = Array.isArray(body.content) ? body.content : [];
  const toolCalls = blocks.flatMap((block) => {
    if (!isRecord(block) || block.type !== "tool_use") return [];
    return [
      {
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      },
    ];
  });
  const kept = blocks.filter(
    (block) => isRecord(block) && block.type !== "tool_use",
  );
  const text = kept
    .filter((block) => isRecord(block) && block.type === "text")
    .map((block) => (isRecord(block) ? String(block.text ?? "") : ""))
    .join("");
  const hasThinking = kept.some(
    (block) =>
      isRecord(block) &&
      (block.type === "thinking" || block.type === "redacted_thinking"),
  );
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
          content: hasThinking ? kept : text || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : null,
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
