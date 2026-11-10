import { Environment, Interpreter, parse, tokenize } from "@huggingface/jinja";

export class UndefinedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UndefinedError";
  }
}

const PRIVATE_HOOKS = [
  "evaluateBlock",
  "evaluateIf",
  "evaluateBinaryExpression",
  "evaluateUnaryExpression",
  "evaluateTernaryExpression",
  "evaluateFor",
  "applyFilter",
] as const;

interface AstNode {
  type: string;
  value?: unknown;
  body?: AstNode[];
  alternate?: AstNode[];
  test?: AstNode;
  operand?: AstNode;
  filter?: AstNode;
  callee?: AstNode;
  object?: AstNode;
  property?: AstNode;
  computed?: boolean;
  left?: AstNode;
  right?: AstNode;
  operator?: { value: string };
  argument?: AstNode;
  args?: AstNode[];
  iterable?: AstNode;
  condition?: AstNode;
  trueExpr?: AstNode;
  falseExpr?: AstNode;
  key?: AstNode;
}

type RuntimeValue = ReturnType<Interpreter["evaluate"]> & {
  undefinedName?: string;
  objType?: string;
  accessName?: string | number;
};

const SILENT_NULL = new Set(["Set", "Macro", "Comment", "Break", "Continue"]);

function isAst(value: unknown): value is AstNode {
  if (typeof value !== "object" || value === null || !("type" in value))
    return false;
  return typeof value.type === "string";
}

function isRuntime(value: unknown): value is RuntimeValue {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    "toString" in value &&
    typeof value.toString === "function" &&
    "__bool__" in value &&
    typeof value.__bool__ === "function"
  );
}

function asRuntime(value: unknown): RuntimeValue {
  if (!isRuntime(value))
    throw new Error("interpreter returned a non-runtime value");
  return value;
}

function callLibrary(
  name: (typeof PRIVATE_HOOKS)[number] | "evaluate",
  receiver: unknown,
  args: readonly unknown[],
): unknown {
  const value: unknown = Reflect.get(Interpreter.prototype, name);
  if (typeof value !== "function")
    throw new Error(`@huggingface/jinja is missing hook ${name}`);
  return Reflect.apply(value, receiver, [...args]);
}

function undefinedMessage(value: RuntimeValue): string {
  if (value.objType === undefined)
    return `'${value.undefinedName ?? "undefined"}' is undefined`;
  if (typeof value.accessName === "number")
    return `${value.objType} object has no element ${value.accessName}`;
  return `'${value.objType} object' has no attribute '${value.accessName}'`;
}

function undefinedError(value: RuntimeValue): UndefinedError {
  return new UndefinedError(undefinedMessage(value));
}

function readBoolean(value: RuntimeValue): boolean {
  if (typeof value.value !== "boolean")
    throw new Error(`${value.type} value is not a boolean`);
  return value.value;
}

function readString(value: RuntimeValue): string {
  if (typeof value.value !== "string")
    throw new Error(`${value.type} value is not a string`);
  return value.value;
}

function readNumber(value: RuntimeValue): number {
  if (typeof value.value !== "number")
    throw new Error(`${value.type} value is not a number`);
  return value.value;
}

function readItems(value: RuntimeValue): RuntimeValue[] {
  if (!Array.isArray(value.value))
    throw new Error(`${value.type} has no item list`);
  return value.value.map((item) => {
    if (!isRuntime(item))
      throw new Error(`${value.type} item is not a runtime value`);
    return item;
  });
}

function readEntries(value: RuntimeValue): Array<[string, RuntimeValue]> {
  if (!(value.value instanceof Map))
    throw new Error(`${value.type} has no mapping`);
  const entries: Array<[string, RuntimeValue]> = [];
  for (const [key, item] of value.value) {
    if (typeof key !== "string" || !isRuntime(item)) {
      throw new Error(
        `${value.type} entry is not a string key and runtime value`,
      );
    }
    entries.push([key, item]);
  }
  return entries;
}

function isPrintable(code: number): boolean {
  if (code === 0x20) return true;
  return !/\p{C}|\p{Z}/u.test(String.fromCodePoint(code));
}

function quotePython(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) throw new Error("empty code point");
    if (char === "\\" || char === quote) out += `\\${char}`;
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f)
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (isPrintable(code)) out += char;
    else if (code < 0x100) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += `\\U${code.toString(16).padStart(8, "0")}`;
  }
  return out + quote;
}

function pythonRepr(value: RuntimeValue): string {
  switch (value.type) {
    case "StringValue":
      return quotePython(readString(value));
    case "BooleanValue":
      return readBoolean(value) ? "True" : "False";
    case "NullValue":
      return "None";
    case "UndefinedValue":
      return "Undefined";
    case "IntegerValue":
    case "FloatValue":
      return value.toString();
    case "ArrayValue":
      return `[${readItems(value).map(pythonRepr).join(", ")}]`;
    case "TupleValue": {
      const items = readItems(value).map(pythonRepr);
      if (items.length === 1) return `(${items[0]},)`;
      return `(${items.join(", ")})`;
    }
    case "ObjectValue":
      return `{${readEntries(value)
        .map(([key, item]) => `${quotePython(key)}: ${pythonRepr(item)}`)
        .join(", ")}}`;
    default:
      throw new Error(`no Python repr for ${value.type}`);
  }
}

function pythonStr(value: RuntimeValue): string {
  switch (value.type) {
    case "StringValue":
      return readString(value);
    case "BooleanValue":
      return readBoolean(value) ? "True" : "False";
    case "NullValue":
      return "None";
    case "UndefinedValue":
      throw undefinedError(value);
    case "ArrayValue":
    case "TupleValue":
    case "ObjectValue":
      return pythonRepr(value);
    case "IntegerValue":
    case "FloatValue":
      return value.toString();
    default:
      throw new Error(`no Python str for ${value.type}`);
  }
}

function range(start: number, stop?: number, step = 1): number[] {
  if (stop === undefined) {
    stop = start;
    start = 0;
  }
  if (step === 0) throw new Error("range() step must not be zero");
  const result: number[] = [];
  if (step > 0) {
    for (let i = start; i < stop; i += step) result.push(i);
  } else {
    for (let i = start; i > stop; i += step) result.push(i);
  }
  return result;
}

function installGlobals(env: Environment): void {
  env.set("false", false);
  env.set("true", true);
  env.set("none", null);
  env.set("True", true);
  env.set("False", false);
  env.set("None", null);
  env.set("range", range);
}

class StrictEnvironment extends Environment {
  override lookupVariable(name: string): RuntimeValue {
    const value = asRuntime(super.lookupVariable(name));
    if (
      value.type === "UndefinedValue" &&
      value.undefinedName === undefined &&
      value.objType === undefined
    ) {
      value.undefinedName = name;
    }
    return value;
  }
}

function strictBool(value: RuntimeValue): boolean {
  if (value.type === "UndefinedValue") throw undefinedError(value);
  const inner = value.__bool__();
  if (!isRuntime(inner) || typeof inner.value !== "boolean") {
    throw new Error("truth test did not return a boolean");
  }
  return inner.value;
}

function valuesEqual(left: RuntimeValue, right: RuntimeValue): boolean {
  const numeric =
    left.type === "IntegerValue" ||
    left.type === "FloatValue" ||
    left.type === "BooleanValue";
  const rightNumeric =
    right.type === "IntegerValue" ||
    right.type === "FloatValue" ||
    right.type === "BooleanValue";
  if (numeric && rightNumeric) {
    const number = (value: RuntimeValue) =>
      value.type === "BooleanValue"
        ? readBoolean(value)
          ? 1
          : 0
        : readNumber(value);
    return number(left) === number(right);
  }
  if (left.type !== right.type) return false;
  if (left.type === "StringValue" || left.type === "NullValue")
    return left.value === right.value;
  return Object.is(left.value, right.value);
}

function encodeString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) throw new Error("empty code point");
    if (char === '"') out += '\\"';
    else if (char === "\\") out += "\\\\";
    else if (char === "\b") out += "\\b";
    else if (char === "\f") out += "\\f";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20 || code >= 0x7f) {
      if (code > 0xffff) {
        const shifted = code - 0x10000;
        const high = 0xd800 + (shifted >> 10);
        const low = 0xdc00 + (shifted & 0x3ff);
        out += `\\u${high.toString(16).padStart(4, "0")}\\u${low.toString(16).padStart(4, "0")}`;
      } else {
        out += `\\u${code.toString(16).padStart(4, "0")}`;
      }
    } else out += char;
  }
  return `${out}"`;
}

function htmlsafe(json: string): string {
  return json
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("'", "\\u0027");
}

function dumpValue(
  value: unknown,
  indent: number | null,
  level: number,
): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number")
    return Object.is(value, -0) ? "-0" : String(value);
  if (typeof value === "string") return encodeString(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (indent === null)
      return `[${value.map((item) => dumpValue(item, null, 0)).join(", ")}]`;
    const child = `\n${" ".repeat(indent * (level + 1))}`;
    const close = `\n${" ".repeat(indent * level)}`;
    return `[${child}${value.map((item) => dumpValue(item, indent, level + 1)).join(`,${child}`)}${close}]`;
  }
  if (typeof value !== "object" || value === null)
    throw new Error("cannot tojson this value");
  const entries = new Map(Object.entries(value));
  const keys = [...entries.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (keys.length === 0) return "{}";
  const parts = keys.map(
    (key) =>
      `${encodeString(key)}: ${dumpValue(entries.get(key), indent, level + 1)}`,
  );
  if (indent === null) return `{${parts.join(", ")}}`;
  const child = `\n${" ".repeat(indent * (level + 1))}`;
  const close = `\n${" ".repeat(indent * level)}`;
  return `{${child}${parts.join(`,${child}`)}${close}}`;
}

function unwrap(value: RuntimeValue): unknown {
  if (value.type === "UndefinedValue") {
    throw new TypeError(
      "Object of type StrictUndefined is not JSON serializable",
    );
  }
  if (value.type === "NullValue") return null;
  if (
    value.type === "BooleanValue" ||
    value.type === "IntegerValue" ||
    value.type === "FloatValue" ||
    value.type === "StringValue"
  ) {
    return value.value;
  }
  if (value.type === "ArrayValue")
    return readItems(value).map((item) => unwrap(item));
  if (value.type === "ObjectValue") {
    const record: Record<string, unknown> = {};
    for (const [key, item] of readEntries(value)) record[key] = unwrap(item);
    return record;
  }
  throw new Error(`Cannot tojson ${value.type}`);
}

class StrictInterpreter extends Interpreter {
  readonly memo = new Map<AstNode, RuntimeValue>();

  constructor(env: Environment) {
    super(env);
    Reflect.set(
      this,
      "evaluateBlock",
      (statements: AstNode[], environment: Environment) =>
        this.renderBlock(statements, environment),
    );
    Reflect.set(this, "evaluateIf", (node: AstNode, environment: Environment) =>
      this.renderIf(node, environment),
    );
    Reflect.set(
      this,
      "evaluateBinaryExpression",
      (node: AstNode, environment: Environment) =>
        this.renderBinary(node, environment),
    );
    Reflect.set(
      this,
      "evaluateUnaryExpression",
      (node: AstNode, environment: Environment) =>
        this.renderUnary(node, environment),
    );
    Reflect.set(
      this,
      "evaluateTernaryExpression",
      (node: AstNode, environment: Environment) =>
        this.renderTernary(node, environment),
    );
    Reflect.set(
      this,
      "evaluateFor",
      (node: AstNode, environment: Environment) =>
        this.renderFor(node, environment),
    );
    Reflect.set(
      this,
      "applyFilter",
      (operand: RuntimeValue, filterNode: AstNode, environment: Environment) =>
        this.renderFilter(operand, filterNode, environment),
    );
  }

  override evaluate(
    statement: AstNode | undefined,
    environment: Environment,
  ): RuntimeValue {
    if (statement) {
      const cached = this.memo.get(statement);
      if (cached) return cached;
    }
    if (statement?.type === "MemberExpression")
      return this.renderMember(statement, environment);
    if (statement?.type === "CallExpression")
      return this.renderCall(statement, environment);
    return asRuntime(super.evaluate(statement, environment));
  }

  private renderCall(node: AstNode, environment: Environment): RuntimeValue {
    const calleeNode = node.callee;
    if (!calleeNode) throw new Error("call has no callee");
    const callee = this.evaluate(calleeNode, environment);
    if (callee.type === "UndefinedValue") throw undefinedError(callee);
    this.memo.set(calleeNode, callee);
    try {
      return asRuntime(super.evaluate(node, environment));
    } finally {
      this.memo.delete(calleeNode);
    }
  }

  private literal(node: AstNode): RuntimeValue {
    return asRuntime(callLibrary("evaluate", this, [node, this.global]));
  }

  private stringValue(value: string): RuntimeValue {
    return this.literal({ type: "StringLiteral", value });
  }

  private booleanValue(value: boolean): RuntimeValue {
    return this.literal({
      type: "IntegerLiteral",
      value: value ? 1 : 0,
    }).__bool__();
  }

  private arrayValue(items: RuntimeValue[]): RuntimeValue {
    const empty = this.literal({ type: "ArrayLiteral", value: [] });
    const constructed: unknown = Reflect.construct(empty.constructor, [items]);
    return asRuntime(constructed);
  }

  private renderBlock(
    statements: AstNode[],
    environment: Environment,
  ): RuntimeValue {
    let result = "";
    for (const statement of statements) {
      const value = this.evaluate(statement, environment);
      if (value.type === "UndefinedValue") throw undefinedError(value);
      if (value.type === "NullValue") {
        if (!SILENT_NULL.has(statement.type)) result += "None";
        continue;
      }
      result += pythonStr(value);
    }
    return this.stringValue(result);
  }

  private renderIf(node: AstNode, environment: Environment): RuntimeValue {
    if (!node.test) throw new Error("if has no test");
    const branch = strictBool(this.evaluate(node.test, environment))
      ? node.body
      : node.alternate;
    return this.renderBlock(branch ?? [], environment);
  }

  private renderTernary(node: AstNode, environment: Environment): RuntimeValue {
    if (!node.condition) throw new Error("ternary has no condition");
    const branch = strictBool(this.evaluate(node.condition, environment))
      ? node.trueExpr
      : node.falseExpr;
    return this.evaluate(branch, environment);
  }

  private renderUnary(node: AstNode, environment: Environment): RuntimeValue {
    if (!node.argument) throw new Error("unary has no argument");
    const argument = this.evaluate(node.argument, environment);
    if (argument.type === "UndefinedValue") throw undefinedError(argument);
    if (node.operator?.value === "not")
      return this.booleanValue(!strictBool(argument));
    this.memo.set(node.argument, argument);
    try {
      return asRuntime(
        callLibrary("evaluateUnaryExpression", this, [node, environment]),
      );
    } finally {
      this.memo.delete(node.argument);
    }
  }

  private renderBinary(node: AstNode, environment: Environment): RuntimeValue {
    const op = node.operator?.value;
    if (op === "and" || op === "or") {
      const left = this.evaluate(node.left, environment);
      const truth = strictBool(left);
      if (op === "and")
        return truth ? this.evaluate(node.right, environment) : left;
      return truth ? left : this.evaluate(node.right, environment);
    }
    const left = this.evaluate(node.left, environment);
    const right = this.evaluate(node.right, environment);
    if (left.type === "UndefinedValue") throw undefinedError(left);
    if (right.type === "UndefinedValue") throw undefinedError(right);
    if (op === "==" || op === "!=") {
      return this.booleanValue(
        op === "==" ? valuesEqual(left, right) : !valuesEqual(left, right),
      );
    }
    if (node.left) this.memo.set(node.left, left);
    if (node.right) this.memo.set(node.right, right);
    try {
      return asRuntime(
        callLibrary("evaluateBinaryExpression", this, [node, environment]),
      );
    } finally {
      if (node.left) this.memo.delete(node.left);
      if (node.right) this.memo.delete(node.right);
    }
  }

  private renderMember(node: AstNode, environment: Environment): RuntimeValue {
    const object = this.evaluate(node.object, environment);
    if (object.type === "UndefinedValue") throw undefinedError(object);
    if (!node.object) throw new Error("member has no object");
    this.memo.set(node.object, object);
    try {
      const result = asRuntime(super.evaluate(node, environment));
      if (result.type === "UndefinedValue" && result.objType === undefined) {
        const accessName = this.accessName(node, environment);
        if (accessName !== undefined) {
          result.objType =
            object.type === "ArrayValue"
              ? "list"
              : object.type === "StringValue"
                ? "str"
                : "dict";
          result.accessName = accessName;
        }
      }
      return result;
    } finally {
      this.memo.delete(node.object);
    }
  }

  private accessName(
    node: AstNode,
    environment: Environment,
  ): string | number | undefined {
    const property = node.property;
    if (!property || property.type === "SliceExpression") return undefined;
    if (
      !node.computed &&
      property.type === "Identifier" &&
      typeof property.value === "string"
    ) {
      return property.value;
    }
    if (
      property.type === "IntegerLiteral" &&
      typeof property.value === "number"
    )
      return property.value;
    if (property.type === "StringLiteral" && typeof property.value === "string")
      return property.value;
    if (!node.computed) return undefined;
    const evaluated = this.evaluate(property, environment);
    if (
      (evaluated.type === "IntegerValue" || evaluated.type === "StringValue") &&
      (typeof evaluated.value === "number" ||
        typeof evaluated.value === "string")
    ) {
      return evaluated.value;
    }
    return undefined;
  }

  private renderFor(node: AstNode, environment: Environment): RuntimeValue {
    if (node.iterable?.type !== "SelectExpression") {
      const iterable = this.evaluate(node.iterable, environment);
      if (iterable.type === "UndefinedValue") throw undefinedError(iterable);
      if (iterable.type === "StringValue") {
        const chars = Array.from(readString(iterable)).map((char) =>
          this.stringValue(char),
        );
        if (!node.iterable) throw new Error("for has no iterable");
        this.memo.set(node.iterable, this.arrayValue(chars));
        try {
          return asRuntime(
            callLibrary("evaluateFor", this, [node, environment]),
          );
        } finally {
          this.memo.delete(node.iterable);
        }
      }
    }
    return asRuntime(callLibrary("evaluateFor", this, [node, environment]));
  }

  private renderFilter(
    operand: RuntimeValue,
    filterNode: AstNode,
    environment: Environment,
  ): RuntimeValue {
    const name =
      filterNode.type === "Identifier" && typeof filterNode.value === "string"
        ? filterNode.value
        : filterNode.callee?.value;
    const filterName = typeof name === "string" ? name : undefined;
    if (filterName === "tojson")
      return this.tojson(operand, filterNode, environment);
    if (filterName === "default" && filterNode.type === "Identifier") {
      return operand.type === "UndefinedValue" ? this.stringValue("") : operand;
    }
    if (operand.type === "UndefinedValue" && filterName !== "default")
      throw undefinedError(operand);
    return asRuntime(
      callLibrary("applyFilter", this, [operand, filterNode, environment]),
    );
  }

  private tojson(
    operand: RuntimeValue,
    filterNode: AstNode,
    environment: Environment,
  ): RuntimeValue {
    if (operand.type === "UndefinedValue") {
      throw new TypeError(
        "Object of type StrictUndefined is not JSON serializable",
      );
    }
    let indent: number | null = null;
    if (filterNode.type === "CallExpression") {
      let selected: AstNode | undefined;
      for (const arg of filterNode.args ?? []) {
        if (
          arg.type === "KeywordArgumentExpression" &&
          isAst(arg.value) &&
          arg.key?.value === "indent"
        ) {
          selected = arg.value;
        } else if (arg.type !== "KeywordArgumentExpression" && !selected) {
          selected = arg;
        }
      }
      if (selected) {
        const value = this.evaluate(selected, environment);
        if (value.type !== "NullValue") {
          if (typeof value.value !== "number")
            throw new Error("tojson indent is not a number");
          indent = value.value;
        }
      }
    }
    return this.stringValue(htmlsafe(dumpValue(unwrap(operand), indent, 0)));
  }
}

export function renderStrict(
  template: string,
  variables: Record<string, unknown>,
): string {
  const env = new StrictEnvironment();
  installGlobals(env);
  for (const [key, value] of Object.entries(variables)) env.set(key, value);
  const result = asRuntime(
    new StrictInterpreter(env).run(parse(tokenize(template, {}))),
  );
  if (typeof result.value !== "string") {
    throw new UndefinedError("Template did not render to text.");
  }
  return result.value;
}
