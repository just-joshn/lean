function decodeError(text: string, reason: string, position: number): never {
  const before = Array.from(text.slice(0, position));
  const line = before.filter((character) => character === "\n").length + 1;
  const lastNewline = before.lastIndexOf("\n");
  throw new SyntaxError(
    `${reason}: line ${line} column ${before.length - lastNewline} (char ${before.length})`,
  );
}

function syntaxError(text: string): never {
  let position = 0;
  const whitespace = () => {
    while (/[\t\n\r ]/u.test(text[position] ?? "x")) position++;
  };
  const fail = (reason: string, at = position): never =>
    decodeError(text, reason, at);
  const string = () => {
    const start = position++;
    while (position < text.length) {
      const character = text[position++]!;
      if (character === '"') return;
      if (character.charCodeAt(0) < 32)
        fail("Invalid control character at", position - 1);
      if (character !== "\\") continue;
      const escape = text[position++];
      if (escape === undefined) break;
      if (escape === "u") {
        if (!/^[\da-f]{4}$/iu.test(text.slice(position, position + 4)))
          fail("Invalid \\uXXXX escape", position - 1);
        position += 4;
      } else if (!'"\\/bfnrt'.includes(escape))
        fail("Invalid \\escape", position - 2);
    }
    fail("Unterminated string starting at", start);
  };
  const value = (): void => {
    whitespace();
    const character = text[position];
    if (character === '"') return string();
    if (character === "{" || character === "[") {
      const object = character === "{";
      const end = object ? "}" : "]";
      position++;
      whitespace();
      if (text[position] === end) {
        position++;
        return;
      }
      for (;;) {
        if (object) {
          if (text[position] !== '"')
            fail("Expecting property name enclosed in double quotes");
          string();
          whitespace();
          if (text[position] !== ":") fail("Expecting ':' delimiter");
          position++;
        }
        value();
        whitespace();
        if (text[position] === end) {
          position++;
          return;
        }
        if (text[position] !== ",") fail("Expecting ',' delimiter");
        const comma = position++;
        whitespace();
        if (text[position] === end)
          fail(
            `Illegal trailing comma before end of ${object ? "object" : "array"}`,
            comma,
          );
      }
    }
    const token =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(
        text.slice(position),
      );
    if (!token) fail("Expecting value");
    position += token![0].length;
  };
  if (text.startsWith("\ufeff"))
    fail("Unexpected UTF-8 BOM (decode using utf-8-sig)", 0);
  value();
  whitespace();
  return fail("Extra data");
}

export function responseArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    const name =
      value === null
        ? "NoneType"
        : typeof value === "boolean"
          ? "bool"
          : typeof value === "number"
            ? Number.isInteger(value)
              ? "int"
              : "float"
            : Array.isArray(value)
              ? "list"
              : "dict";
    throw new TypeError(
      `the JSON object must be str, bytes or bytearray, not ${name}`,
    );
  }
  try {
    return JSON.parse(value);
  } catch {
    return syntaxError(value);
  }
}
