import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Environment, Interpreter, parse, tokenize } from "@huggingface/jinja";
import { describe, expect, test } from "vitest";
import { UndefinedError, renderStrict } from "./render.ts";

interface OracleCase {
  id: string;
  source: string;
  context: Record<string, unknown>;
  status: "ok" | "err";
  output?: string;
  name?: string;
  message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOracleCase(value: unknown): value is OracleCase {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== "string" ||
    typeof value.source !== "string" ||
    !isRecord(value.context)
  ) {
    return false;
  }
  if (value.status !== "ok" && value.status !== "err") return false;
  if (value.output !== undefined && typeof value.output !== "string")
    return false;
  if (value.name !== undefined && typeof value.name !== "string") return false;
  if (value.message !== undefined && typeof value.message !== "string")
    return false;
  return true;
}

function readOracle(): OracleCase[] {
  const path = fileURLToPath(
    new URL("./render-strict-oracle.json", import.meta.url),
  );
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.cases) ||
    !parsed.cases.every(isOracleCase)
  ) {
    throw new Error("render-strict-oracle.json is not an oracle case list");
  }
  return parsed.cases;
}

function renderOutcome(
  source: string,
  context: Record<string, unknown>,
):
  | { status: "ok"; output: string }
  | { status: "err"; name: string; message: string; error: unknown } {
  try {
    return { status: "ok", output: renderStrict(source, context) };
  } catch (error) {
    return {
      status: "err",
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      error,
    };
  }
}

const prototypeHooks = [
  "evaluate",
  "evaluateIdentifier",
  "evaluateMemberExpression",
  "evaluateUnaryExpression",
  "evaluateBinaryExpression",
  "evaluateTernaryExpression",
  "evaluateIf",
  "evaluateBlock",
  "evaluateFor",
  "applyFilter",
] as const;

const prototypeMethods = prototypeHooks.map((name) =>
  Reflect.get(Interpreter.prototype, name),
);
const prototypeNames = Object.getOwnPropertyNames(Interpreter.prototype);

function renderWithLibrary(
  source: string,
  variables: Record<string, unknown>,
): string {
  const env = new Environment();
  for (const [key, value] of Object.entries(variables)) env.set(key, value);
  const result = new Interpreter(env).run(parse(tokenize(source, {})));
  if (typeof result.value !== "string") {
    throw new Error("library render did not return text");
  }
  return result.value;
}

describe("renderStrict Jinja2 oracle", () => {
  test.for(readOracle())("$id", (row) => {
    const actual = renderOutcome(row.source, row.context);
    if (row.status === "ok") {
      expect(actual).toEqual({ status: "ok", output: row.output });
      return;
    }
    expect(actual).toMatchObject({
      status: "err",
      name: row.name,
      message: row.message,
    });
    if (actual.status !== "err") return;
    if (row.name === "UndefinedError") {
      expect(actual.error).toBeInstanceOf(UndefinedError);
    } else {
      expect(actual.error).not.toBeInstanceOf(UndefinedError);
    }
  });
});

describe("renderStrict leaves the jinja library alone", () => {
  test("does not replace Interpreter.prototype methods", () => {
    renderStrict("{{ name }}", { name: "ok" });
    renderStrict("{{ items }}", { items: [{ b: 1, a: "x" }] });
    expect(Object.getOwnPropertyNames(Interpreter.prototype)).toEqual(
      prototypeNames,
    );
    for (const [index, name] of prototypeHooks.entries()) {
      expect(Reflect.get(Interpreter.prototype, name)).toBe(
        prototypeMethods[index],
      );
    }
  });

  test("an ordinary interpreter still uses library missing-name and dict text", () => {
    renderStrict("{{ obj }}", { obj: { b: 1, a: "x" } });
    expect(renderWithLibrary("{{ missing }}", {})).toBe("");
    expect(renderWithLibrary("{{ obj }}", { obj: { b: 1, a: "x" } })).toBe(
      '{"b": 1, "a": "x"}',
    );
  });
});
