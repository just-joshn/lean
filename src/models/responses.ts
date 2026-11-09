import type { Message } from "../protocols.ts";
import type { ReceivedResponse } from "./received-response.ts";
import type { AttemptDependencies } from "./attempt.ts";
import { ProviderParityGateError } from "./route.ts";
import {
  joinUrl,
  postResponse,
  requireProvider,
  splitKwargs,
  stripProvider,
} from "./transport.ts";

type Dictionary = Record<string, unknown>;
type Parser = (value: unknown) => unknown;
type Fields = Record<string, { parse: Parser; fallback?: unknown }>;
type DumpOptions = { mode?: "json" };

class ValidationFailure extends Error {}

class OpenAIError extends Error {
  readonly rawText: string;
  readonly statusCode: number;

  constructor(received: ReceivedResponse) {
    super(received.text);
    this.name = "OpenAIError";
    this.rawText = received.text;
    this.statusCode = received.status;
  }
}

function isDictionary(value: unknown): value is Dictionary {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checked(check: (value: unknown) => boolean): Parser {
  return (value) => {
    if (!check(value)) throw new ValidationFailure();
    return value;
  };
}

const string = checked((value) => typeof value === "string");
const dictionary = checked(isDictionary);
const anything: Parser = (value) => value;
const number: Parser = (value) => {
  const converted =
    typeof value === "boolean" ||
    (typeof value === "string" && value.trim() !== "")
      ? Number(value)
      : value;
  if (typeof converted !== "number" || !Number.isFinite(converted)) {
    throw new ValidationFailure();
  }
  return converted;
};
const integer: Parser = (value) => {
  const converted = number(value);
  if (typeof converted !== "number" || !Number.isInteger(converted)) {
    throw new ValidationFailure();
  }
  return converted;
};
const boolean: Parser = (value) => {
  if (value === true || value === 1 || value === "true" || value === "1")
    return true;
  if (value === false || value === 0 || value === "false" || value === "0")
    return false;
  throw new ValidationFailure();
};
const literal = (...values: unknown[]): Parser =>
  checked((value) => values.includes(value));
const list =
  (parse: Parser): Parser =>
  (value) => {
    if (!Array.isArray(value)) throw new ValidationFailure();
    return value.map(parse);
  };
const required = (parse: Parser) => ({ parse });
const nullable = (parse: Parser) => ({
  parse: (value: unknown) => (value === null ? null : parse(value)),
  fallback: null,
});

function defaults(fields: Fields, body: Dictionary): Dictionary {
  const result: Dictionary = {};
  for (const [key, field] of Object.entries(fields)) {
    if (Object.hasOwn(body, key)) result[key] = body[key];
    else if (Object.hasOwn(field, "fallback")) result[key] = field.fallback;
  }
  return { ...result, ...body };
}

function validate(fields: Fields, body: unknown): Dictionary {
  if (!isDictionary(body)) throw new ValidationFailure();
  const result = defaults(fields, body);
  for (const [key, field] of Object.entries(fields)) {
    if (!Object.hasOwn(result, key)) throw new ValidationFailure();
    result[key] = field.parse(result[key]);
  }
  return result;
}

class ResponseFields {
  [key: string]: unknown;
  #fields: Dictionary;

  constructor(fields: Dictionary) {
    this.#fields = fields;
    for (const [key, value] of Object.entries(fields)) {
      if (key !== "model_dump") Reflect.set(this, key, value);
    }
  }

  model_dump(options?: DumpOptions): Dictionary {
    return Object.fromEntries(
      Object.entries(this.#fields).map(([key, value]) => [
        key,
        dump(value, options),
      ]),
    );
  }
}

function dump(value: unknown, options?: DumpOptions): unknown {
  if (value instanceof ResponseFields) return value.model_dump(options);
  if (Array.isArray(value)) return value.map((entry) => dump(entry, options));
  if (isDictionary(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, dump(entry, options)]),
    );
  }
  return value;
}

const model =
  (fields: Fields): Parser =>
  (value) =>
    new ResponseFields(validate(fields, value));
const status = literal("in_progress", "completed", "incomplete");
const caller = model({ type: required(literal("direct")) });
const programCaller = model({
  type: required(literal("program")),
  caller_id: required(string),
});
const functionFields: Fields = {
  arguments: required(string),
  call_id: required(string),
  name: required(string),
  type: required(literal("function_call")),
  id: nullable(string),
  async_: nullable(boolean),
  caller: nullable((value) => {
    if (isDictionary(value) && value.type === "program")
      return programCaller(value);
    return caller(value);
  }),
  namespace: nullable(string),
  status: nullable(status),
};
const outputTextFields: Fields = {
  annotations: required(list(dictionary)),
  text: required(string),
  type: required(literal("output_text")),
  logprobs: nullable(list(dictionary)),
};
const messageFields: Fields = {
  id: required(string),
  content: required(
    list((value) => {
      if (isDictionary(value) && value.type === "refusal") {
        return model({
          type: required(literal("refusal")),
          refusal: required(string),
        })(value);
      }
      return model(outputTextFields)(value);
    }),
  ),
  role: required(literal("assistant")),
  status: required(status),
  type: required(literal("message")),
  phase: nullable(literal("commentary", "final_answer")),
};
const reasoningFields: Fields = {
  id: required(string),
  summary: required(
    list(
      model({
        text: required(string),
        type: required(literal("summary_text")),
      }),
    ),
  ),
  type: required(literal("reasoning")),
  content: nullable(
    list(
      model({
        text: required(string),
        type: required(literal("reasoning_text")),
      }),
    ),
  ),
  encrypted_content: nullable(string),
  status: nullable(status),
};
const toolSearchFields: Fields = {
  id: required(string),
  call_id: nullable(string),
  execution: required(literal("server", "client")),
  status: required(status),
  created_by: nullable(string),
};
const outputModels: Record<string, Fields> = {
  function_call: functionFields,
  message: messageFields,
  reasoning: reasoningFields,
  tool_search_call: {
    ...toolSearchFields,
    arguments: required(anything),
    type: required(literal("tool_search_call")),
  },
  tool_search_output: {
    ...toolSearchFields,
    tools: required(list(dictionary)),
    type: required(literal("tool_search_output")),
  },
};

function outputItem(value: unknown): unknown {
  if (!isDictionary(value)) throw new ValidationFailure();
  const fields =
    typeof value.type === "string" && Object.hasOwn(outputModels, value.type)
      ? outputModels[value.type]
      : undefined;
  if (!fields) return value;
  try {
    const input =
      value.type === "function_call" && Object.hasOwn(value, "async")
        ? { ...value, async_: value.async }
        : value;
    const validated = validate(fields, input);
    if (input !== value) delete validated.async;
    return new ResponseFields(validated);
  } catch (error) {
    if (!(error instanceof ValidationFailure)) throw error;
    return value;
  }
}

const inputDetails: Fields = {
  audio_tokens: nullable(integer),
  cached_tokens: { parse: integer, fallback: 0 },
  cached_tokens_details: nullable(dictionary),
  image_tokens: nullable(integer),
  text_tokens: nullable(integer),
  video_tokens: nullable(integer),
};
const outputDetails: Fields = {
  audio_tokens: nullable(integer),
  reasoning_tokens: nullable(integer),
  text_tokens: nullable(integer),
};
const usageFields: Fields = {
  input_tokens: required(integer),
  input_tokens_details: nullable(model(inputDetails)),
  output_tokens: required(integer),
  output_tokens_details: nullable(model(outputDetails)),
  total_tokens: required(integer),
  cost: nullable((value) => {
    if (isDictionary(value))
      return value.total_cost == null ? null : number(value.total_cost);
    return number(value);
  }),
};
const responseFields: Fields = {
  id: required(string),
  created_at: required(integer),
  error: nullable(dictionary),
  incomplete_details: nullable(dictionary),
  instructions: nullable(string),
  metadata: nullable(dictionary),
  model: nullable(string),
  object: nullable(string),
  output: required(list(outputItem)),
  parallel_tool_calls: nullable(boolean),
  temperature: nullable(number),
  tool_choice: nullable((value) =>
    typeof value === "string" ? string(value) : dictionary(value),
  ),
  tools: nullable(list(dictionary)),
  top_p: nullable(number),
  max_output_tokens: nullable(integer),
  previous_response_id: nullable(string),
  reasoning: nullable(dictionary),
  status: nullable(string),
  text: nullable(dictionary),
  truncation: nullable(literal("auto", "disabled")),
  usage: nullable(model(usageFields)),
  user: nullable(string),
  store: nullable(boolean),
};
const nullDropped: Record<string, readonly string[]> = {
  reasoning: ["status", "content", "encrypted_content"],
  tool_search_call: ["created_by"],
  tool_search_output: ["created_by"],
};

class ResponsesResult extends ResponseFields {
  override model_dump(options?: DumpOptions): Dictionary {
    const result = super.model_dump(options);
    if (Array.isArray(result.output)) {
      result.output = result.output.map((item: unknown) => {
        if (!isDictionary(item) || typeof item.type !== "string") return item;
        const keys = Object.hasOwn(nullDropped, item.type)
          ? nullDropped[item.type]
          : [];
        for (const key of keys ?? []) {
          if (item[key] === null) delete item[key];
        }
        return item;
      });
    }
    return result;
  }
}

function fromReceived(received: ReceivedResponse): ResponsesResult {
  let body: unknown;
  try {
    body = JSON.parse(received.text);
    if (!isDictionary(body) || !Object.hasOwn(body, "created_at")) {
      throw new Error("Missing created_at");
    }
    const created = body.created_at;
    const numeric =
      typeof created === "number" ||
      typeof created === "boolean" ||
      (typeof created === "string" && created.trim() !== "")
        ? Number(created)
        : NaN;
    body.created_at = Number.isFinite(numeric)
      ? Math.trunc(numeric)
      : Math.trunc(Date.now() / 1000);
  } catch {
    throw new OpenAIError(received);
  }
  try {
    return new ResponsesResult(validate(responseFields, body));
  } catch (error) {
    if (!(error instanceof ValidationFailure)) throw error;
    return new ResponsesResult(defaults(responseFields, body));
  }
}

export async function completeResponses(options: {
  model: string;
  input: Message[];
  tools?: unknown[];
  modelKwargs?: Record<string, unknown>;
  signal?: AbortSignal;
  execution?: AttemptDependencies;
}): Promise<ResponsesResult> {
  const split = splitKwargs(options.model, options.modelKwargs ?? {});
  requireProvider(split.provider, ["openai"]);
  if (split.params.stream || split.extraBody?.stream) {
    throw new ProviderParityGateError(split.provider, "Responses streaming");
  }
  const params = { ...split.params };
  delete params.tools;
  const key = split.apiKey || process.env.OPENAI_API_KEY || "";
  const received = await postResponse(
    joinUrl(split.apiBase || "https://api.openai.com/v1", "/responses"),
    {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...split.extraHeaders,
    },
    {
      model: stripProvider(options.model, "openai"),
      input: options.input,
      ...(options.tools ? { tools: options.tools } : {}),
      ...params,
      ...(split.extraBody ?? {}),
    },
    {
      sdkRetries: 0,
      wrapperAttempts: split.retries,
      timeoutSeconds: split.timeoutSeconds,
      signal: options.signal,
    },
    options.execution,
  );
  return fromReceived(received);
}
