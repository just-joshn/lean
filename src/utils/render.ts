import { Environment, Interpreter, parse, tokenize } from "@huggingface/jinja";

export class UndefinedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UndefinedError";
  }
}

interface RuntimeValue {
  type: string;
  value?: unknown;
  toString(): string;
  __bool__?: () => { value: boolean };
}

const undefinedNames = new WeakMap<object, string>();
let patched = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRuntime(value: unknown): value is RuntimeValue {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    typeof value.toString === "function"
  );
}

function isUndefined(value: unknown): value is RuntimeValue {
  return isRuntime(value) && value.type === "UndefinedValue";
}

function undefinedMessage(value: object): string {
  const name = undefinedNames.get(value);
  return name === undefined
    ? "'undefined' is undefined"
    : `'${name}' is undefined`;
}

function truthy(value: RuntimeValue): boolean {
  if (typeof value.__bool__ === "function") return value.__bool__().value;
  return Boolean(value.value);
}

function propertyLabel(expr: unknown): string {
  if (!isRecord(expr) || !isRecord(expr.property)) return "unknown";
  return typeof expr.property.value === "string"
    ? expr.property.value
    : "unknown";
}

function filterName(filterNode: unknown): string {
  if (!isRecord(filterNode)) return "";
  if (filterNode.type === "Identifier" && typeof filterNode.value === "string")
    return filterNode.value;
  if (filterNode.type === "CallExpression" && isRecord(filterNode.callee)) {
    return typeof filterNode.callee.value === "string"
      ? filterNode.callee.value
      : "";
  }
  return "";
}

function runtimeToPlain(value: unknown): unknown {
  if (!isRuntime(value)) return value;
  switch (value.type) {
    case "NullValue":
    case "UndefinedValue":
      return null;
    case "BooleanValue":
    case "IntegerValue":
    case "FloatValue":
    case "StringValue":
      return value.value;
    case "ArrayValue":
    case "TupleValue":
      return Array.isArray(value.value)
        ? value.value.map((item) => runtimeToPlain(item))
        : [];
    case "ObjectValue":
      if (value.value instanceof Map) {
        const object: Record<string, unknown> = {};
        for (const [key, item] of value.value)
          object[String(key)] = runtimeToPlain(item);
        return object;
      }
      return {};
    default:
      return value.value ?? null;
  }
}

function htmlsafeJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    return JSON.stringify(value)
      .replace(/[^\u0000-\u007F]/gu, (char) => {
        const code = char.codePointAt(0) ?? 0;
        return `\\u${code.toString(16).padStart(4, "0")}`;
      })
      .replaceAll("<", "\\u003c")
      .replaceAll(">", "\\u003e")
      .replaceAll("&", "\\u0026")
      .replaceAll("'", "\\u0027");
  }
  if (typeof value === "number" || typeof value === "boolean")
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => htmlsafeJson(item)).join(", ")}]`;
  if (isRecord(value)) {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${htmlsafeJson(key)}: ${htmlsafeJson(value[key])}`)
      .join(", ");
    return `{${body}}`;
  }
  return "null";
}

function pythonTojson(value: unknown): string {
  return htmlsafeJson(runtimeToPlain(value));
}

function renderedText(value: RuntimeValue): string {
  if (value.type === "NullValue") return "None";
  if (value.type === "BooleanValue") return value.value ? "True" : "False";
  return value.toString();
}

function patchInterpreter(): void {
  if (patched) return;
  patched = true;
  const proto: object = Interpreter.prototype;
  const originalIdentifier = Reflect.get(proto, "evaluateIdentifier");
  const originalMember = Reflect.get(proto, "evaluateMemberExpression");
  const originalUnary = Reflect.get(proto, "evaluateUnaryExpression");
  const originalApply = Reflect.get(proto, "applyFilter");
  if (
    typeof originalIdentifier !== "function" ||
    typeof originalMember !== "function" ||
    typeof originalUnary !== "function" ||
    typeof originalApply !== "function"
  ) {
    throw new Error(
      "Jinja interpreter is missing methods required for strict rendering.",
    );
  }

  Reflect.set(
    proto,
    "evaluateIdentifier",
    function (this: object, node: unknown, environment: unknown) {
      const value: unknown = Reflect.apply(originalIdentifier, this, [
        node,
        environment,
      ]);
      if (
        isUndefined(value) &&
        isRecord(node) &&
        typeof node.value === "string"
      ) {
        undefinedNames.set(value, node.value);
      }
      return value;
    },
  );

  Reflect.set(
    proto,
    "evaluateMemberExpression",
    function (this: object, expr: unknown, environment: unknown) {
      const evaluate = Reflect.get(this, "evaluate");
      if (typeof evaluate !== "function" || !isRecord(expr)) {
        return Reflect.apply(originalMember, this, [expr, environment]);
      }
      const object: unknown = Reflect.apply(evaluate, this, [
        expr.object,
        environment,
      ]);
      if (isUndefined(object))
        throw new UndefinedError(undefinedMessage(object));
      const value: unknown = Reflect.apply(originalMember, this, [
        expr,
        environment,
      ]);
      if (isUndefined(value)) {
        throw new UndefinedError(
          `'dict object' has no attribute '${propertyLabel(expr)}'`,
        );
      }
      return value;
    },
  );

  Reflect.set(
    proto,
    "evaluateIf",
    function (this: object, node: unknown, environment: unknown) {
      const evaluate = Reflect.get(this, "evaluate");
      const evaluateBlock = Reflect.get(this, "evaluateBlock");
      if (
        typeof evaluate !== "function" ||
        typeof evaluateBlock !== "function" ||
        !isRecord(node)
      ) {
        throw new UndefinedError("Cannot evaluate conditional.");
      }
      const test: unknown = Reflect.apply(evaluate, this, [
        node.test,
        environment,
      ]);
      if (isUndefined(test)) throw new UndefinedError(undefinedMessage(test));
      if (!isRuntime(test))
        throw new UndefinedError("'undefined' is undefined");
      const branch = truthy(test) ? node.body : node.alternate;
      return Reflect.apply(evaluateBlock, this, [
        Array.isArray(branch) ? branch : [],
        environment,
      ]);
    },
  );

  Reflect.set(
    proto,
    "evaluateUnaryExpression",
    function (this: object, node: unknown, environment: unknown) {
      if (
        !isRecord(node) ||
        !isRecord(node.operator) ||
        node.operator.value !== "not"
      ) {
        return Reflect.apply(originalUnary, this, [node, environment]);
      }
      const evaluate = Reflect.get(this, "evaluate");
      if (typeof evaluate !== "function")
        return Reflect.apply(originalUnary, this, [node, environment]);
      const argument: unknown = Reflect.apply(evaluate, this, [
        node.argument,
        environment,
      ]);
      if (isUndefined(argument))
        throw new UndefinedError(undefinedMessage(argument));
      if (!isRuntime(argument))
        throw new UndefinedError("'undefined' is undefined");
      return Reflect.apply(evaluate, this, [
        { type: "Identifier", value: truthy(argument) ? "false" : "true" },
        environment,
      ]);
    },
  );

  Reflect.set(
    proto,
    "evaluateBlock",
    function (this: object, statements: unknown, environment: unknown) {
      const evaluate = Reflect.get(this, "evaluate");
      if (typeof evaluate !== "function" || !Array.isArray(statements)) {
        throw new UndefinedError("Cannot evaluate template block.");
      }
      const silent = new Set(["Set", "Macro", "Comment"]);
      let result = "";
      for (const statement of statements) {
        const value: unknown = Reflect.apply(evaluate, this, [
          statement,
          environment,
        ]);
        if (isUndefined(value))
          throw new UndefinedError(undefinedMessage(value));
        if (!isRuntime(value)) continue;
        if (
          value.type === "NullValue" &&
          isRecord(statement) &&
          silent.has(String(statement.type))
        ) {
          continue;
        }
        result += renderedText(value);
      }
      return Reflect.apply(evaluate, this, [
        { type: "StringLiteral", value: result },
        environment,
      ]);
    },
  );

  Reflect.set(
    proto,
    "applyFilter",
    function (
      this: object,
      operand: unknown,
      filterNode: unknown,
      environment: unknown,
    ) {
      if (filterName(filterNode) !== "tojson") {
        return Reflect.apply(originalApply, this, [
          operand,
          filterNode,
          environment,
        ]);
      }
      const evaluate = Reflect.get(this, "evaluate");
      if (typeof evaluate !== "function") {
        return Reflect.apply(originalApply, this, [
          operand,
          filterNode,
          environment,
        ]);
      }
      return Reflect.apply(evaluate, this, [
        { type: "StringLiteral", value: pythonTojson(operand) },
        environment,
      ]);
    },
  );
}

export function renderStrict(
  template: string,
  variables: Record<string, unknown>,
): string {
  patchInterpreter();
  const tokens = tokenize(template, {
    lstrip_blocks: false,
    trim_blocks: false,
  });
  const program = parse(tokens);
  const env = new Environment();
  env.set("true", true);
  env.set("false", false);
  env.set("none", null);
  for (const [key, value] of Object.entries(variables)) env.set(key, value);
  const interpreter = new Interpreter(env);
  const result = interpreter.run(program);
  if (!isRuntime(result) || typeof result.value !== "string") {
    throw new UndefinedError("Template did not render to text.");
  }
  return result.value;
}
