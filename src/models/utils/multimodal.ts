import type { Message } from "../../protocols.ts";

export const DEFAULT_MULTIMODAL_REGEX =
  "(?s)<MSWEA_MULTIMODAL_CONTENT><CONTENT_TYPE>(.+?)</CONTENT_TYPE>(.+?)</MSWEA_MULTIMODAL_CONTENT>";

function expandString(
  content: string,
  pattern: string,
): Array<Record<string, unknown>> {
  const matches = [...content.matchAll(new RegExp(pattern, "gs"))];
  if (matches.length === 0) return [{ type: "text", text: content }];
  const result: Array<Record<string, unknown>> = [];
  let last = 0;
  for (const match of matches) {
    const start = match.index ?? 0;
    const textBefore = content.slice(last, start);
    if (textBefore) result.push({ type: "text", text: textBefore });
    const contentType = (match[1] ?? "").trim();
    const extracted = (match[2] ?? "").trim();
    if (contentType === "image_url") {
      result.push({ type: "image_url", image_url: { url: extracted } });
    }
    last = start + match[0].length;
  }
  const textAfter = content.slice(last);
  if (textAfter) result.push({ type: "text", text: textAfter });
  return result;
}

export function expandMultimodalContent<T>(content: T, pattern: string): T {
  if (!pattern) return content;
  return expandValue(structuredClone(content), pattern) as T;
}

function expandValue(content: unknown, pattern: string): unknown {
  if (typeof content === "string") return expandString(content, pattern);
  if (Array.isArray(content))
    return content.map((item) => expandValue(item, pattern));
  if (typeof content === "object" && content !== null) {
    const record = content as Record<string, unknown>;
    if (!("content" in record)) return record;
    record.content = expandValue(record.content, pattern);
    return record;
  }
  return String(content);
}

export function expandMessage(message: Message, pattern: string): Message {
  return expandMultimodalContent(message, pattern);
}
