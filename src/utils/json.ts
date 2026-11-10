export function pythonJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) return "null";
  return json.replace(/[^\u0000-\u007F]/gu, (char) => {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0xffff) return `\\u${code.toString(16).padStart(4, "0")}`;
    const shifted = code - 0x10000;
    const high = 0xd800 + (shifted >> 10);
    const low = 0xdc00 + (shifted & 0x3ff);
    return `\\u${high.toString(16).padStart(4, "0")}\\u${low.toString(16).padStart(4, "0")}`;
  });
}
