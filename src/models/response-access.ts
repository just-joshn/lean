import type { Message } from "../protocols.ts";

type Dictionary = Record<string, unknown>;
type DumpOptions = { mode: "json" };

function isDictionary(value: unknown): value is Dictionary {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function attribute(
  value: unknown,
  key: string,
  fallback?: unknown,
): unknown {
  if (typeof value !== "object" || value === null || isDictionary(value)) {
    return fallback;
  }
  return key in value ? Reflect.get(value, key) : fallback;
}

export function dictionaryOrAttribute(value: unknown, key: string): unknown {
  if (isDictionary(value))
    return Object.hasOwn(value, key) ? value[key] : undefined;
  return attribute(value, key);
}

export function chatChoice(response: unknown): unknown {
  const choices = attribute(response, "choices");
  if (!Array.isArray(choices))
    throw new TypeError("Response has no choices attribute");
  return choices[0];
}

export function chatMessage(response: unknown): unknown {
  return dictionaryOrAttribute(chatChoice(response), "message");
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    typeof value === "string" ||
    (typeof value === "object" &&
      value !== null &&
      typeof Reflect.get(value, Symbol.iterator) === "function")
  );
}

export function responseOutput(response: unknown): Iterable<unknown> {
  const output = attribute(response, "output", []);
  if (isDictionary(output)) return Object.keys(output);
  if (!isIterable(output))
    throw new TypeError("Response output is not iterable");
  return output;
}

export function chatDump(value: unknown, options?: DumpOptions): unknown {
  const dump = attribute(value, "model_dump");
  if (typeof dump !== "function")
    throw new TypeError("Object has no model_dump method");
  return options === undefined ? dump.call(value) : dump.call(value, options);
}

export function responsesDump(value: unknown, options?: DumpOptions): unknown {
  return isDictionary(value) ? { ...value } : chatDump(value, options);
}

export function messageFromDump(value: unknown): Message {
  if (!isDictionary(value))
    throw new TypeError("model_dump did not return a dictionary");
  const message: Message = {};
  Object.assign(message, value);
  return message;
}
