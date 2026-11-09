import type { Message } from "../protocols.ts";
import { ResponseResult } from "./response-result.ts";
import { bedrockConverseBody } from "./bedrock.ts";
import type { ReceivedResponse } from "./received-response.ts";
import {
  attemptResponse,
  type AttemptDependencies,
  type AttemptPolicy,
} from "./attempt.ts";
import {
  chatHandler,
  isProviderPrefix,
  ProviderParityGateError,
} from "./route.ts";
import { lookupModelInfo } from "./utils/cost.ts";
import {
  AuthenticationError,
  ContextWindowExceededError,
  NotFoundError,
  PermissionDeniedError,
  UnsupportedParamsError,
} from "./errors.ts";

const CLIENT_KEYS = new Set([
  "api_key",
  "api_base",
  "base_url",
  "api_version",
  "custom_llm_provider",
  "drop_params",
  "additional_drop_params",
  "allowed_openai_params",
  "timeout",
  "num_retries",
  "max_retries",
  "extra_headers",
  "text_completion",
]);

const OPENAI_PARAMS = new Set([
  "functions",
  "function_call",
  "temperature",
  "top_p",
  "n",
  "stream",
  "stream_options",
  "stop",
  "max_tokens",
  "max_completion_tokens",
  "modalities",
  "prediction",
  "audio",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "user",
  "response_format",
  "seed",
  "tools",
  "tool_choice",
  "logprobs",
  "top_logprobs",
  "parallel_tool_calls",
  "reasoning_effort",
  "verbosity",
  "thinking",
  "web_search_options",
  "safety_identifier",
  "store",
  "prompt_cache_key",
]);

const ANTHROPIC_PARAMS = new Set([
  "stream",
  "stop",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "tools",
  "tool_choice",
  "extra_headers",
  "parallel_tool_calls",
  "response_format",
  "user",
  "web_search_options",
  "speed",
  "context_management",
  "cache_control",
  "thinking",
  "reasoning_effort",
  "service_tier",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseOf(body: Record<string, unknown>): ResponseResult {
  return new ResponseResult(body);
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

export function stripProvider(model: string, provider: string): string {
  const prefix = `${provider}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/u, "")}/${path.replace(/^\//u, "")}`;
}

function providerOf(model: string, explicit: unknown): string {
  if (typeof explicit === "string" && explicit) return explicit;
  const slash = model.indexOf("/");
  if (slash > 0) {
    const prefix = model.slice(0, slash);
    if (isProviderPrefix(prefix)) {
      return prefix;
    }
  }
  const info = lookupModelInfo(model);
  if (typeof info?.litellm_provider === "string" && info.litellm_provider) {
    return info.litellm_provider;
  }
  if (info) return "openai";
  throw new ProviderParityGateError(
    model,
    "provider inference outside explicit prefixes and the model catalog",
  );
}

function headerMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") headers[key] = entry;
  }
  return headers;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

interface SplitKwargs {
  apiKey?: string;
  apiBase?: string;
  provider: string;
  dropParams: boolean;
  timeoutSeconds?: number;
  retries: number;
  sdkRetries: number;
  extraHeaders: Record<string, string>;
  extraBody?: Record<string, unknown>;
  params: Record<string, unknown>;
}

export function splitKwargs(
  model: string,
  modelKwargs: Record<string, unknown>,
): SplitKwargs {
  const params: Record<string, unknown> = {};
  const drop = new Set(
    Array.isArray(modelKwargs.additional_drop_params)
      ? modelKwargs.additional_drop_params.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  );
  const allowed = new Set(
    Array.isArray(modelKwargs.allowed_openai_params)
      ? modelKwargs.allowed_openai_params.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  );
  for (const [key, value] of Object.entries(modelKwargs)) {
    if (drop.has(key) || key === "extra_body") continue;
    if (!CLIENT_KEYS.has(key)) params[key] = value;
  }
  const provider = providerOf(model, modelKwargs.custom_llm_provider);
  const dropParams = modelKwargs.drop_params === true;
  if (provider === "anthropic") {
    const unsupported = Object.keys(params).filter(
      (key) =>
        OPENAI_PARAMS.has(key) &&
        !ANTHROPIC_PARAMS.has(key) &&
        !allowed.has(key),
    );
    if (unsupported.length > 0 && !dropParams) {
      throw new UnsupportedParamsError(
        `anthropic does not support parameters: ${JSON.stringify(unsupported)}, for model=${stripProvider(model, "anthropic")}. To drop these, set \`litellm.drop_params=True\` or for proxy:\n\n\`litellm_settings:\n drop_params: true\`\n. \n If you want to use these params dynamically send allowed_openai_params=${JSON.stringify(unsupported)} in your request.`,
      );
    }
    if (dropParams) {
      for (const key of unsupported) delete params[key];
    }
  }
  const router =
    isRecord(modelKwargs.metadata) &&
    Object.hasOwn(modelKwargs.metadata, "model_group");
  const retries = router
    ? 0
    : Math.max(0, Math.trunc(finiteNumber(modelKwargs.num_retries) ?? 0));
  return {
    apiKey:
      typeof modelKwargs.api_key === "string" ? modelKwargs.api_key : undefined,
    apiBase:
      typeof modelKwargs.api_base === "string"
        ? modelKwargs.api_base
        : typeof modelKwargs.base_url === "string"
          ? modelKwargs.base_url
          : undefined,
    provider,
    dropParams,
    timeoutSeconds: finiteNumber(modelKwargs.timeout),
    retries,
    sdkRetries: router
      ? 0
      : Math.max(
          0,
          Math.trunc(
            finiteNumber(modelKwargs.num_retries ?? modelKwargs.max_retries) ??
              2,
          ),
        ),
    extraHeaders: headerMap(modelKwargs.extra_headers),
    extraBody: isRecord(modelKwargs.extra_body)
      ? modelKwargs.extra_body
      : undefined,
    params,
  };
}

export function requireProvider(provider: string, allowed: string[]): void {
  if (!allowed.includes(provider)) {
    throw new ProviderParityGateError(
      provider,
      "API-specific request and response controls have not been established",
    );
  }
}

export async function postResponse(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  policy: AttemptPolicy,
  execution?: AttemptDependencies,
): Promise<ReceivedResponse> {
  const response = await attemptResponse(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    policy,
    execution,
  );
  if (response.ok) return response;
  const error = statusError(
    response.status,
    response.text || response.statusText,
  );
  Object.assign(error, { rawText: response.text, statusCode: response.status });
  throw error;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  policy: AttemptPolicy,
  execution?: AttemptDependencies,
): Promise<Record<string, unknown>> {
  const received = await postResponse(url, headers, body, policy, execution);
  let parsed: unknown = {};
  if (received.text) {
    try {
      parsed = JSON.parse(received.text);
    } catch {
      parsed = { error: received.text };
    }
  }
  if (!isRecord(parsed)) {
    throw new Error("Model response was not a JSON object.");
  }
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

function anthropicTools(tools: unknown[]): unknown[] {
  return tools.flatMap((tool) => {
    if (!isRecord(tool) || !isRecord(tool.function)) return [];
    const mapped: Record<string, unknown> = {
      name: tool.function.name,
      input_schema: tool.function.parameters,
      type: "custom",
    };
    if (tool.function.description !== undefined) {
      mapped.description = tool.function.description;
    }
    return [mapped];
  });
}

const ANTHROPIC_DEFAULT_MAX_TOKENS =
  pythonInt(process.env.DEFAULT_ANTHROPIC_CHAT_MAX_TOKENS ?? "") ?? 4096;

class APIConnectionError extends Error {
  constructor(cause: unknown) {
    super(
      `litellm.APIConnectionError: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "APIConnectionError";
  }
}

function pythonInt(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^[+-]?\d(?:_?\d)*$/.test(trimmed)) return undefined;
  return Number(trimmed.replaceAll("_", ""));
}

function roundHalfEven(value: number): number {
  const negative = value < 0;
  const absolute = Math.abs(value);
  const floor = Math.floor(absolute);
  const fraction = absolute - floor;
  let rounded = floor;
  if (fraction > 0.5) rounded = floor + 1;
  else if (fraction === 0.5) rounded = floor % 2 === 0 ? floor : floor + 1;
  return negative ? -rounded : rounded;
}

function outputLimitValue(value: unknown): unknown {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      const error = new Error(
        Number.isNaN(value)
          ? "cannot convert float NaN to integer"
          : "cannot convert float infinity to integer",
      );
      error.name = Number.isNaN(value) ? "ValueError" : "OverflowError";
      throw error;
    }
    return Math.max(1, roundHalfEven(value));
  }
  const kind = typeof value === "string" ? "str" : typeof value;
  throw new TypeError(`type ${kind} doesn't define __round__ method`);
}

function requestedOutputLimit(params: Record<string, unknown>): unknown {
  let chosen: unknown;
  let seen = false;
  for (const key of ["max_tokens", "max_completion_tokens"] as const) {
    if (!(key in params) || params[key] == null) continue;
    try {
      chosen = outputLimitValue(params[key]);
    } catch (cause) {
      throw new APIConnectionError(cause);
    }
    seen = true;
  }
  return seen ? chosen : undefined;
}

function listedOutputLimit(model: string): unknown {
  const info = lookupModelInfo(model);
  if (!info) return undefined;
  if ("max_output_tokens" in info) {
    return info.max_output_tokens == null ? undefined : info.max_output_tokens;
  }
  if ("max_tokens" in info) {
    return info.max_tokens == null ? undefined : info.max_tokens;
  }
  return undefined;
}

function anthropicMaxTokens(
  model: string,
  params: Record<string, unknown>,
): unknown {
  const requested = requestedOutputLimit(params);
  if (requested !== undefined) return requested;
  const listed = listedOutputLimit(model);
  return listed === undefined ? ANTHROPIC_DEFAULT_MAX_TOKENS : listed;
}

function anthropicBody(
  model: string,
  messages: Message[],
  tools: unknown[] | undefined,
  split: SplitKwargs,
): Record<string, unknown> {
  const converted = anthropicMessages(messages);
  const params = { ...split.params };
  const body: Record<string, unknown> = {
    model: stripProvider(model, "anthropic"),
    messages: converted.messages,
    max_tokens: anthropicMaxTokens(model, params),
  };
  if (converted.system) body.system = converted.system;
  if (tools && tools.length > 0) body.tools = anthropicTools(tools);
  delete params.max_tokens;
  delete params.max_completion_tokens;
  delete params.tools;
  if (params.stop !== undefined) {
    body.stop_sequences = params.stop;
    delete params.stop;
  }
  if (typeof params.user === "string" && !params.user.includes("@")) {
    body.metadata = { user_id: params.user };
    delete params.user;
  }
  if (split.extraBody) body.extra_body = split.extraBody;
  return { ...body, ...params };
}

function openaiBody(
  model: string,
  messages: Message[],
  tools: unknown[] | undefined,
  split: SplitKwargs,
): Record<string, unknown> {
  const params = { ...split.params };
  delete params.tools;
  const body: Record<string, unknown> = {
    model: stripProvider(model, split.provider),
    messages,
    ...(tools ? { tools } : {}),
    ...params,
    ...(split.extraBody ?? {}),
  };
  delete body.extra_body;
  return body;
}

function fromAnthropic(body: Record<string, unknown>): ResponseResult {
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
  const message: Record<string, unknown> = {
    role: "assistant",
    content: text || null,
    tool_calls: toolCalls.length > 0 ? toolCalls : null,
    function_call: null,
    provider_specific_fields: {
      citations: null,
      thinking_blocks: thinking.length > 0 ? thinking : null,
    },
  };
  if (thinking.length > 0) {
    message.thinking_blocks = thinking;
    message.reasoning_content = reasoning;
  }
  return responseOf({
    choices: [{ finish_reason: finish, message }],
    usage: {
      prompt_tokens: input + read + created,
      completion_tokens: output,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: created,
    },
  });
}

export async function completeChat(options: {
  model: string;
  messages: Message[];
  tools?: unknown[];
  modelKwargs?: Record<string, unknown>;
  signal?: AbortSignal;
  execution?: AttemptDependencies;
}): Promise<ResponseResult> {
  const kwargs = options.modelKwargs ?? {};
  if (kwargs.fallbacks != null || kwargs.model_list != null) {
    throw new ProviderParityGateError(
      "completion",
      "fallback and model-list dispatch before provider routing",
    );
  }
  const split = splitKwargs(options.model, kwargs);
  if (split.params.stream || split.extraBody?.stream) {
    throw new ProviderParityGateError(split.provider, "streaming");
  }
  const wrapperPolicy: AttemptPolicy = {
    sdkRetries: 0,
    wrapperAttempts: split.retries,
    timeoutSeconds: split.timeoutSeconds,
    signal: options.signal,
  };
  const openai = async (): Promise<ResponseResult> => {
    const key =
      split.apiKey ||
      (split.provider === "openai" ? process.env.OPENAI_API_KEY : "") ||
      "";
    return responseOf(
      await postJson(
        joinUrl(
          split.apiBase || "https://api.openai.com/v1",
          "/chat/completions",
        ),
        {
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          ...split.extraHeaders,
        },
        openaiBody(options.model, options.messages, options.tools, split),
        { ...wrapperPolicy, sdkRetries: split.sdkRetries },
        options.execution,
      ),
    );
  };
  const handler = chatHandler(
    split.provider,
    options.model,
    kwargs.text_completion === true,
    {
      openai,
      compatible: async () => {
        if (!split.apiBase)
          throw new ProviderParityGateError(
            split.provider,
            "default endpoint, credentials, and provider-specific conversion",
          );
        return openai();
      },
      anthropic: async () => {
        const key = split.apiKey || process.env.ANTHROPIC_API_KEY || "";
        return fromAnthropic(
          await postJson(
            joinUrl(
              split.apiBase || "https://api.anthropic.com",
              "/v1/messages",
            ),
            {
              "content-type": "application/json",
              "x-api-key": key,
              "anthropic-version": "2023-06-01",
              ...split.extraHeaders,
            },
            anthropicBody(
              options.model,
              options.messages,
              options.tools,
              split,
            ),
            wrapperPolicy,
            options.execution,
          ),
        );
      },
      bedrock: async () => {
        if (!split.apiBase)
          throw new ProviderParityGateError(
            "bedrock",
            "AWS endpoint selection and SigV4 signing",
          );
        if (split.extraBody)
          throw new ProviderParityGateError(
            "bedrock",
            "Converse extra_body mapping",
          );
        await postResponse(
          joinUrl(
            split.apiBase,
            `/model/${encodeURIComponent(stripProvider(options.model, "bedrock"))}/converse`,
          ),
          { "content-type": "application/json", ...split.extraHeaders },
          bedrockConverseBody(options.messages, options.tools, split.params),
          wrapperPolicy,
          options.execution,
        );
        throw new ProviderParityGateError(
          "bedrock",
          "Bedrock response conversion and usage remain unproven",
        );
      },
      unproven: (provider) => async () => {
        throw new ProviderParityGateError(
          provider,
          "source-reachable handler body, credentials, and response conversion remain unproven",
        );
      },
    },
  );
  return handler();
}
