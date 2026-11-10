import type { Message } from "../protocols.ts";
import sourceSchema from "./data/responses-schema.json" with { type: "json" };
import {
  responseJsonText,
  type ReceivedResponse,
} from "./received-response.ts";
import {
  AuthenticationError,
  ContextWindowExceededError,
  NotFoundError,
} from "./errors.ts";
import type { AttemptDependencies } from "./attempt.ts";
import { responsesRequest } from "./responses-request.ts";
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
type DumpOptions = { mode?: string };

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
const responseInteger: Parser = (value) => {
  if (
    typeof value === "string" &&
    !/^[+-]?\d(?:_?\d)*(?:\.0+)?$/u.test(value.trim())
  )
    throw new ValidationFailure();
  return integer(typeof value === "string" ? value.replaceAll("_", "") : value);
};
const trueBooleans = new Set<unknown>([
  true,
  1,
  "true",
  "1",
  "t",
  "y",
  "yes",
  "on",
]);
const falseBooleans = new Set<unknown>([
  false,
  0,
  "false",
  "0",
  "f",
  "n",
  "no",
  "off",
]);
const boolean: Parser = (value) => {
  const normalized = typeof value === "string" ? value.toLowerCase() : value;
  if (trueBooleans.has(normalized)) return true;
  if (falseBooleans.has(normalized)) return false;
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

class ResponseIterator {
  readonly values: Iterator<unknown>;
  readonly parse: Parser;
  constructor(values: Iterator<unknown>, parse: Parser) {
    this.values = values;
    this.parse = parse;
  }
  *[Symbol.iterator](): Generator<unknown> {
    for (let next = this.values.next(); !next.done; next = this.values.next())
      yield this.parse(next.value);
  }
}

function dump(value: unknown, options?: DumpOptions): unknown {
  if (value instanceof ResponseIterator) {
    const entries = (function* () {
      for (const entry of value) yield dump(entry, options);
    })();
    return options?.mode === "json" ? Array.from(entries) : entries;
  }
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
interface Schema {
  record?: boolean;
  iterable?: boolean;
  $ref?: string;
  type?: string;
  const?: unknown;
  enum?: unknown[];
  anyOf?: Schema[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  default?: unknown;
  additionalProperties?: boolean | Schema;
}
const schemas: {
  fields: Record<string, Schema>;
  models: Record<string, Schema>;
} = sourceSchema;

function dictionaryAlternative(schema: Schema): boolean {
  return (
    (schema.type === "object" && !schema.properties) ||
    (schema.type === "array" &&
      schema.items !== undefined &&
      dictionaryAlternative(schema.items))
  );
}

function parseSchema(schema: Schema, value: unknown, exact = false): unknown {
  if (schema.$ref) {
    const name = schema.$ref.split("/").at(-1)!;
    const shape = schemas.models[name]!;
    if (!isDictionary(value)) throw new ValidationFailure();
    const result: Dictionary = {};
    const consumed = new Set<string>();
    for (const [key, field] of Object.entries(shape.properties ?? {})) {
      const alias = key === "async" ? "async_" : key;
      if (Object.hasOwn(value, key)) {
        result[alias] = parseSchema(field, value[key], exact);
        consumed.add(key);
      } else if (Object.hasOwn(field, "default")) result[alias] = field.default;
      else if (shape.required?.includes(key)) throw new ValidationFailure();
    }
    for (const [key, entry] of Object.entries(value)) {
      if (!consumed.has(key) && shape.additionalProperties !== false)
        result[key] = entry;
    }
    return shape.record ? result : new ResponseFields(result);
  }
  if (schema.anyOf) {
    const strict = exact || schema.anyOf.some(dictionaryAlternative);
    for (const alternative of schema.anyOf) {
      try {
        return parseSchema(alternative, value, strict);
      } catch (error) {
        if (!(error instanceof ValidationFailure)) throw error;
      }
    }
    throw new ValidationFailure();
  }
  if (Object.hasOwn(schema, "const")) return literal(schema.const)(value);
  if (schema.enum) return literal(...schema.enum)(value);
  if (schema.iterable) {
    if (!Array.isArray(value)) throw new ValidationFailure();
    return new ResponseIterator(value.values(), (entry) =>
      parseSchema(schema.items ?? {}, entry, exact),
    );
  }
  if (schema.type === "array")
    return list((entry) => parseSchema(schema.items ?? {}, entry, exact))(
      value,
    );
  if (schema.type === "object") {
    dictionary(value);
    const entries = schema.additionalProperties;
    if (isDictionary(value) && typeof entries === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          parseSchema(entries, entry, exact),
        ]),
      );
    }
    return value;
  }
  const parser =
    schema.type === "string"
      ? string
      : schema.type === "integer"
        ? responseInteger
        : schema.type === "number"
          ? number
          : schema.type === "boolean"
            ? boolean
            : schema.type === "null"
              ? literal(null)
              : anything;
  const parsed = parser(value);
  if (exact && !Object.is(parsed, value)) throw new ValidationFailure();
  return parsed;
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
  incomplete_details: {
    parse: (value) => parseSchema(schemas.fields.incomplete_details!, value),
    fallback: null,
  },
  instructions: nullable(string),
  metadata: nullable(dictionary),
  model: nullable(string),
  object: nullable(string),
  output: required((value) => parseSchema(schemas.fields.output!, value)),
  parallel_tool_calls: nullable(boolean),
  temperature: nullable(number),
  tool_choice: {
    parse: (value) => parseSchema(schemas.fields.tool_choice!, value),
    fallback: null,
  },
  tools: {
    parse: (value) => parseSchema(schemas.fields.tools!, value),
    fallback: null,
  },
  top_p: nullable(number),
  max_output_tokens: nullable(responseInteger),
  previous_response_id: nullable(string),
  reasoning: nullable(dictionary),
  status: nullable(string),
  text: {
    parse: (value) => parseSchema(schemas.fields.text!, value),
    fallback: null,
  },
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
    body = JSON.parse(responseJsonText(received.bytes));
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

function responseError(received: ReceivedResponse): Error {
  const detail = received.text;
  const lower = detail.toLowerCase();
  let name =
    received.status === 400
      ? "BadRequestError"
      : received.status === 401
        ? "AuthenticationError"
        : received.status === 404
          ? "NotFoundError"
          : received.status === 429
            ? "RateLimitError"
            : received.status >= 500
              ? "InternalServerError"
              : "APIError";
  if (
    lower.includes("this model's maximum context length is") &&
    !lower.includes("string_above_max_length")
  )
    name = "ContextWindowExceededError";
  const prefix = name === "BadRequestError" ? "" : `${name}: `;
  const message = `litellm.${name}: ${name === "ContextWindowExceededError" ? "litellm.BadRequestError: " : ""}${prefix}OpenAIException - ${detail}`;
  if (name === "AuthenticationError") return new AuthenticationError(message);
  if (name === "ContextWindowExceededError")
    return new ContextWindowExceededError(message);
  if (name === "NotFoundError") return new NotFoundError(message);
  const error = new Error(message);
  error.name = name;
  return error;
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
  const body = responsesRequest({
    model: stripProvider(options.model, "openai"),
    input: options.input,
    tools: options.tools,
    params: split.params,
    dropParams: split.dropParams,
    apiBase: split.apiBase,
  });
  const key = split.apiKey || process.env.OPENAI_API_KEY || "";
  const received = await postResponse(
    joinUrl(split.apiBase || "https://api.openai.com/v1", "/responses"),
    {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...split.extraHeaders,
    },
    {
      ...body,
      ...(split.extraBody ?? {}),
    },
    {
      sdkRetries: 0,
      wrapperAttempts: split.retries,
      timeoutSeconds: split.timeoutSeconds,
      signal: options.signal,
    },
    options.execution,
    responseError,
  );
  return fromReceived(received);
}
