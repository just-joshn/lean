import { randomUUID } from "node:crypto";
import type { Message } from "../protocols.ts";
import { pythonJson } from "../utils/json.ts";
import { ResponseResult } from "./response-result.ts";
import { ProviderParityGateError } from "./route.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function bedrockConverseBody(
  messages: Message[],
  tools: unknown[] | undefined,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const inferenceConfig: Record<string, unknown> = {};
  const names: Record<string, string> = {
    max_tokens: "maxTokens",
    max_completion_tokens: "maxTokens",
    temperature: "temperature",
    top_p: "topP",
    stop: "stopSequences",
  };
  for (const [key, value] of Object.entries(params)) {
    const name = names[key];
    if (!name)
      throw new ProviderParityGateError("bedrock", `Converse parameter ${key}`);
    inferenceConfig[name] =
      key === "stop" && typeof value === "string" ? [value] : value;
  }
  const converted = messages.map((message) => {
    if (
      typeof message.content !== "string" ||
      !["system", "user", "assistant"].includes(String(message.role)) ||
      message.tool_calls
    ) {
      throw new ProviderParityGateError(
        "bedrock",
        "Converse non-text messages and tool replay",
      );
    }
    const content: unknown[] = [{ text: message.content }];
    if (message.cache_control) {
      if (
        !record(message.cache_control) ||
        message.cache_control.type !== "ephemeral" ||
        message.cache_control.ttl !== undefined
      ) {
        throw new ProviderParityGateError(
          "bedrock",
          "Converse cache control outside the captured ephemeral case",
        );
      }
      content.push({ cachePoint: { type: "default" } });
    }
    return { role: message.role, content };
  });
  const leadingSystem: typeof converted = [];
  const rest = [...converted];
  while (rest[0]?.role === "system") {
    const leading = rest.shift();
    if (leading) leadingSystem.push(leading);
  }
  const note =
    "Operator note (not from the user): the following was originally a mid-conversation system-role reminder.";
  const messagesOut: typeof converted = [];
  for (const message of rest) {
    const next =
      message.role === "system"
        ? {
            role: "user",
            content: [{ text: note }, ...message.content],
          }
        : message;
    const previous = messagesOut.at(-1);
    if (next.role === "user" && previous?.role === "user") {
      previous.content.push(...next.content);
    } else {
      messagesOut.push(next);
    }
  }
  const body: Record<string, unknown> = {
    messages: messagesOut,
    inferenceConfig,
  };
  const system = leadingSystem.flatMap((message) => message.content);
  if (system.length) body.system = system;
  if (tools?.length) {
    body.toolConfig = {
      tools: tools.map((tool) => {
        if (
          !record(tool) ||
          tool.type !== "function" ||
          !record(tool.function)
        ) {
          throw new ProviderParityGateError(
            "bedrock",
            "Converse non-function tools",
          );
        }
        return {
          toolSpec: {
            inputSchema: { json: tool.function.parameters },
            name: tool.function.name,
            ...(tool.function.description !== undefined
              ? { description: tool.function.description }
              : {}),
          },
        };
      }),
    };
  }
  return body;
}

class PythonNumber {
  readonly token: string;
  constructor(token: string) {
    this.token = token;
  }
}

function pythonNumberToken(token: string): string {
  if (!/[.eE]/u.test(token)) return token;
  const value = Number(token);
  if (!Number.isFinite(value)) return token;
  if (Object.is(value, -0)) return "-0.0";
  if (Number.isInteger(value) && Math.abs(value) < 1e16) return `${value}.0`;
  return JSON.stringify(value).replace(
    /e([+-]?)(\d+)$/u,
    (_, sign: string, digits: string) =>
      `e${sign === "-" ? "-" : "+"}${digits.padStart(2, "0")}`,
  );
}

function numberSource(context: unknown): string | undefined {
  if (!record(context)) return undefined;
  const source = context.source;
  return typeof source === "string" && source.length > 0 ? source : undefined;
}

function withPythonNumbers(text: string): unknown {
  return JSON.parse(text, function (_key, value) {
    if (typeof value !== "number") return value;
    // The published reviver type stops at (key, value). The runtime still passes source context.
    const token = numberSource(arguments[2]);
    if (!token) throw new Error("Unreadable tool input");
    return new PythonNumber(token);
  });
}

function messageContent(value: unknown): unknown[] {
  const output = record(value) ? value.output : undefined;
  const message = record(output) ? output.message : undefined;
  const content = record(message) ? message.content : undefined;
  if (!Array.isArray(content)) throw new Error("Unreadable tool input");
  return content;
}

function sourcedToolInput(content: unknown[], index: number): unknown {
  const block = content[index];
  const tool = record(block) ? block.toolUse : undefined;
  if (!record(tool) || !Object.hasOwn(tool, "input"))
    throw new Error("Unreadable tool input");
  return tool.input;
}

function toolArguments(value: unknown): string {
  if (value instanceof PythonNumber) return pythonNumberToken(value.token);
  if (Array.isArray(value)) return `[${value.map(toolArguments).join(", ")}]`;
  if (record(value)) {
    return `{${Object.entries(value)
      .map(([key, entry]) => `${pythonJson(key)}: ${toolArguments(entry)}`)
      .join(", ")}}`;
  }
  return pythonJson(value);
}

export function bedrockConverseResponse(
  body: Record<string, unknown>,
  model: string,
  sourceText?: string,
): ResponseResult {
  const gate = (detail: string): never => {
    throw new ProviderParityGateError("bedrock", detail);
  };
  if (
    Object.keys(body).some(
      (key) => !["output", "stopReason", "usage", "metrics"].includes(key),
    )
  ) {
    gate("Converse response fields outside the captured text and tool cases");
  }
  const output = record(body.output) ? body.output : {};
  const message = record(output.message) ? output.message : {};
  const content = message.content;
  if (message.role !== "assistant" || !Array.isArray(content))
    return gate("Converse output message shape");
  let text = "";
  const tools: unknown[] = [];
  const sourced = sourceText
    ? messageContent(withPythonNumbers(sourceText))
    : undefined;
  for (const [index, block] of content.entries()) {
    if (!record(block)) return gate("Converse content block shape");
    if (typeof block.text === "string" && Object.keys(block).length === 1) {
      if (/^<(?:think|thinking|budget:thinking)>/u.test(block.text))
        gate("Converse inline reasoning");
      text += block.text;
    } else if (record(block.toolUse) && Object.keys(block).length === 1) {
      const tool = block.toolUse;
      if (
        typeof tool.toolUseId !== "string" ||
        typeof tool.name !== "string" ||
        !record(tool.input)
      )
        gate("Converse tool use shape");
      tools.push({
        index,
        function: {
          arguments: toolArguments(
            sourced ? sourcedToolInput(sourced, index) : tool.input,
          ),
          name: tool.name,
        },
        id: tool.toolUseId,
        type: "function",
      });
    } else {
      gate("Converse reasoning, citations, and other unsampled content");
    }
  }
  const stops: Record<string, string> = {
    end_turn: "stop",
    stop_sequence: "stop",
    max_tokens: "length",
    tool_use: "tool_calls",
  };
  const finish =
    typeof body.stopReason === "string" ? stops[body.stopReason] : undefined;
  if (!finish) gate("Converse unsampled stop reason");
  const usage = record(body.usage) ? body.usage : {};
  if (
    Object.keys(usage).some(
      (key) =>
        ![
          "inputTokens",
          "outputTokens",
          "totalTokens",
          "cacheReadInputTokens",
          "cacheWriteInputTokens",
        ].includes(key),
    )
  )
    gate("Converse unsampled usage fields and cache TTL splits");
  const count = (key: string, fallback?: number): number => {
    const value = usage[key] ?? fallback;
    if (typeof value !== "number" || !Number.isInteger(value))
      return gate(`Converse ${key} count`);
    return value;
  };
  const input = count("inputTokens");
  const completion = count("outputTokens");
  const cached = count("cacheReadInputTokens", 0);
  const creation = count("cacheWriteInputTokens", 0);
  const prompt = input + cached + creation;
  return new ResponseResult({
    id: `chatcmpl-${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    model,
    object: "chat.completion",
    choices: [
      {
        finish_reason: finish,
        index: 0,
        message: {
          content: text,
          role: "assistant",
          tool_calls: tools.length ? tools : null,
          function_call: null,
        },
      },
    ],
    usage: {
      completion_tokens: completion,
      prompt_tokens: prompt,
      total_tokens: count("totalTokens", prompt + completion),
      completion_tokens_details: {
        reasoning_tokens: 0,
        text_tokens: completion,
      },
      prompt_tokens_details: {
        audio_tokens: null,
        cache_write_tokens: creation,
        cached_tokens: cached,
        image_tokens: null,
        text_tokens: input,
        video_tokens: null,
        initial_prompt_tokens: null,
        cache_creation_tokens: creation,
      },
      cache_creation_input_tokens: creation,
      cache_read_input_tokens: cached,
    },
  });
}
