import { ValueError } from "./errors.ts";

export class PosixPath {
  readonly text: string;
  readonly parts: string[];

  constructor(text: string) {
    const root =
      text.startsWith("//") && !text.startsWith("///")
        ? "//"
        : text.startsWith("/")
          ? "/"
          : "";
    const parts = text.split("/").filter((part) => part !== "" && part !== ".");
    this.parts = root ? [root, ...parts] : parts;
    this.text = root + parts.join("/") || ".";
  }

  toString(): string {
    return this.text;
  }
  toJSON(): string {
    return this.text;
  }
}

export interface ValidationDetail {
  type: string;
  loc: Array<string | number>;
  msg: string;
  input: unknown;
  ctx?: Record<string, unknown>;
}

function inputType(value: unknown): string {
  if (value === null) return "NoneType";
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number")
    return Number.isInteger(value) ? "int" : "float";
  if (Array.isArray(value)) return "list";
  if (value instanceof Uint8Array) return "bytes";
  return "dict";
}

function repr(value: unknown): string {
  if (typeof value === "string")
    return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", "\\n")}'`;
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value instanceof Uint8Array) {
    const body = Buffer.from(value)
      .toString("latin1")
      .replaceAll("\\", "\\\\")
      .replaceAll("'", "\\'")
      .replace(
        /[^\x20-\x7e]/g,
        (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
      );
    return `b'${body}'`;
  }
  if (Array.isArray(value)) return `[${value.map(repr).join(", ")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, entry]) => `${repr(key)}: ${repr(entry)}`)
      .join(", ")}}`;
  return String(value);
}

export class ValidationError extends Error {
  readonly details: ValidationDetail[];
  constructor(model: string, details: ValidationDetail[]) {
    const header = `${details.length} validation error${details.length === 1 ? "" : "s"} for ${model}`;
    super(
      [
        header,
        ...details.map(
          (detail) =>
            `${detail.loc.join(".")}\n  ${detail.msg} [type=${detail.type}, input_value=${repr(detail.input)}, input_type=${inputType(detail.input)}]\n    For further information visit https://errors.pydantic.dev/2.14/v/${detail.type}`,
        ),
      ].join("\n"),
    );
    this.name = "ValidationError";
    this.details = details;
  }
}

class FieldFailure extends Error {
  readonly details: ValidationDetail[];
  constructor(details: ValidationDetail[]) {
    super();
    this.details = details;
  }
}

function fail(
  type: string,
  msg: string,
  input: unknown,
  ctx?: Record<string, unknown>,
): never {
  throw new FieldFailure([
    { type, loc: [], msg, input, ...(ctx ? { ctx } : {}) },
  ]);
}

export interface Field {
  parse(value: unknown): unknown;
  default?: unknown;
}

export const stringField = (fallback?: string): Field => ({
  ...(fallback === undefined ? {} : { default: fallback }),
  parse(value) {
    if (typeof value === "string") return value;
    if (value instanceof Uint8Array) {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(value);
      } catch {
        return fail(
          "string_unicode",
          "Input should be a valid string, unable to parse raw data as a unicode string",
          value,
        );
      }
    }
    return fail("string_type", "Input should be a valid string", value);
  },
});

export const intField = (fallback: number): Field => ({
  default: fallback,
  parse(value) {
    if (typeof value === "boolean") return Number(value);
    if (typeof value === "number") {
      if (Number.isInteger(value)) return value;
      return fail(
        "int_from_float",
        "Input should be a valid integer, got a number with a fractional part",
        value,
      );
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (/^[+-]?\d(?:_?\d)*(?:\.0+)?$/.test(trimmed)) {
        const normalized = trimmed.replaceAll("_", "");
        const parsed = Number(normalized);
        const digits = normalized.replace(/^\+/, "").replace(/\.0+$/, "");
        if (!Number.isSafeInteger(parsed) || BigInt(parsed) !== BigInt(digits))
          return fail(
            "int_parsing",
            "Input should be a valid integer, unable to parse string as an integer",
            value,
          );
        return parsed;
      }
      return fail(
        "int_parsing",
        "Input should be a valid integer, unable to parse string as an integer",
        value,
      );
    }
    return fail("int_type", "Input should be a valid integer", value);
  },
});

export const floatField = (fallback: number): Field => ({
  default: fallback,
  parse(value) {
    if (typeof value === "boolean") return Number(value);
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const text = value.trim();
      if (/^[+-]?nan$/i.test(text)) return NaN;
      if (/^[+-]?inf(?:inity)?$/i.test(text))
        return text.startsWith("-") ? -Infinity : Infinity;
      if (
        /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:e[+-]?\d(?:_?\d)*)?$/i.test(
          text,
        )
      )
        return Number(text.replaceAll("_", ""));
      return fail(
        "float_parsing",
        "Input should be a valid number, unable to parse string as a number",
        value,
      );
    }
    return fail("float_type", "Input should be a valid number", value);
  },
});

export const boolField = (fallback: boolean): Field => ({
  default: fallback,
  parse(value) {
    if (typeof value === "boolean") return value;
    if (value === 0 || value === 1) return Boolean(value);
    if (typeof value === "string") {
      const text = value.toLowerCase();
      if (["1", "on", "t", "true", "y", "yes"].includes(text)) return true;
      if (["0", "off", "f", "false", "n", "no"].includes(text)) return false;
    }
    return fail(
      "bool_parsing",
      "Input should be a valid boolean, unable to interpret input",
      value,
    );
  },
});

export const literalField = (
  allowed: string[],
  fallback: unknown,
  nullable = false,
): Field => ({
  default: fallback,
  parse(value) {
    if (nullable && value === null) return null;
    if (typeof value === "string" && allowed.includes(value)) return value;
    const expected = allowed.map((item) => `'${item}'`).join(" or ");
    return fail("literal_error", `Input should be ${expected}`, value, {
      expected,
    });
  },
});

export const dictField = (strings = false): Field => ({
  default: {},
  parse(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return fail("dict_type", "Input should be a valid dictionary", value);
    const copy = { ...value };
    if (strings) {
      const errors: ValidationDetail[] = [];
      for (const [key, entry] of Object.entries(copy)) {
        try {
          stringField().parse(entry);
        } catch (error) {
          if (!(error instanceof FieldFailure)) throw error;
          errors.push(
            ...error.details.map((detail) => ({
              ...detail,
              loc: [key, ...detail.loc],
            })),
          );
        }
      }
      if (errors.length) throw new FieldFailure(errors);
    }
    return copy;
  },
});

export const listField = (fallback: string[]): Field => ({
  default: fallback,
  parse(value) {
    if (!Array.isArray(value))
      return fail("list_type", "Input should be a valid list", value);
    const errors: ValidationDetail[] = [];
    const result = value.map((entry, index) => {
      try {
        return stringField().parse(entry);
      } catch (error) {
        if (!(error instanceof FieldFailure)) throw error;
        errors.push(
          ...error.details.map((detail) => ({
            ...detail,
            loc: [index, ...detail.loc],
          })),
        );
      }
    });
    if (errors.length) throw new FieldFailure(errors);
    return result;
  },
});

export const pathField = (
  preserveString = false,
  fallback: unknown = null,
): Field => ({
  default: fallback,
  parse(value) {
    if (value === null || value instanceof PosixPath) return value;
    if (typeof value === "string")
      return preserveString ? value : new PosixPath(value);
    return fail(
      "path_type",
      "Input is not a valid path for <class 'pathlib.Path'>",
      value,
    );
  },
});

function fieldsFor(ctor: Function): Map<string, Field> {
  const chain: Array<typeof ConfigModel> = [];
  for (
    let current = ctor;
    current !== Function.prototype;
    current = Object.getPrototypeOf(current)
  )
    chain.unshift(current as typeof ConfigModel);
  const fields = new Map<string, Field>();
  for (const current of chain)
    if (Object.hasOwn(current, "fields"))
      for (const [key, field] of Object.entries(current.fields))
        fields.set(key, field);
  return fields;
}

export class ConfigModel {
  static fields: Record<string, Field> = {};

  constructor(data: Record<string, unknown> = {}) {
    const errors: ValidationDetail[] = [];
    for (const [key, field] of fieldsFor(new.target)) {
      const present = Object.hasOwn(data, key);
      if (!present && !Object.hasOwn(field, "default")) {
        errors.push({
          type: "missing",
          loc: [key],
          msg: "Field required",
          input: data,
        });
        continue;
      }
      try {
        Reflect.set(
          this,
          key,
          present ? field.parse(data[key]) : structuredClone(field.default),
        );
      } catch (error) {
        if (!(error instanceof FieldFailure)) throw error;
        errors.push(
          ...error.details.map((detail) => ({
            ...detail,
            loc: [key, ...detail.loc],
          })),
        );
      }
    }
    if (errors.length) throw new ValidationError(new.target.name, errors);
  }

  model_dump(mode = "python"): Record<string, unknown> {
    return Object.fromEntries(
      [...fieldsFor(this.constructor)].map(([key]) => {
        const value: unknown = Reflect.get(this, key);
        return [
          key,
          mode === "json" && value instanceof PosixPath ? value.text : value,
        ];
      }),
    );
  }
}

export function pythonInt(text: string): number {
  const raw = text.trim();
  if (!/^[+-]?\d+(?:_\d+)*$/.test(raw))
    throw new ValueError(`invalid literal for int() with base 10: '${text}'`);
  const digits = raw.replaceAll("_", "").replace(/^\+/, "");
  const parsed = Number(digits);
  if (!Number.isFinite(parsed) || BigInt(parsed) !== BigInt(digits))
    throw new ValueError(`invalid literal for int() with base 10: '${text}'`);
  return parsed;
}

export function pythonFloat(text: string): number {
  const raw = text.trim();
  if (/^[+-]?(?:nan|inf(?:inity)?)$/i.test(raw))
    throw new ValueError(`Invalid cost limit: ${raw}`);
  if (
    !/^[+-]?(?:(?:\d+(?:_\d+)*)(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?$/.test(
      raw,
    )
  )
    throw new ValueError(`could not convert string to float: '${text}'`);
  return Number(raw.replaceAll("_", ""));
}

export type ConfigFactory<T> =
  | (new (data: Record<string, unknown>) => T)
  | ((data: Record<string, unknown>) => T);

export function constructConfig<T>(
  data: Record<string, unknown>,
  explicit: ConfigFactory<T> | undefined,
  fallback: ConfigFactory<T>,
  owner: string,
): T {
  if (explicit !== undefined && Object.hasOwn(data, "config_class"))
    throw new TypeError(
      `${owner}.__init__() got multiple values for keyword argument 'config_class'`,
    );
  const selected = Object.hasOwn(data, "config_class")
    ? data.config_class
    : (explicit ?? fallback);
  if (typeof selected !== "function")
    throw new TypeError(`'${inputType(selected)}' object is not callable`);
  const copy = { ...data };
  delete copy.config_class;
  return selected.prototype
    ? Reflect.construct(selected, [copy])
    : selected(copy);
}
