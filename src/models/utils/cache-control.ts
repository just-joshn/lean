import type { Message } from "../../protocols.ts";

function contentText(entry: Message): string | null {
  if (entry.content === null || entry.content === undefined) return null;
  if (typeof entry.content === "string") return entry.content;
  if (!Array.isArray(entry.content) || entry.content.length !== 1) {
    throw new Error("Expected single message in content");
  }
  const first = entry.content[0];
  if (typeof first !== "object" || first === null) return null;
  return typeof (first as { text?: unknown }).text === "string"
    ? (first as { text: string }).text
    : null;
}

function clearCacheControl(entry: Message): void {
  if (Array.isArray(entry.content)) {
    if (entry.content.length !== 1)
      throw new Error("Expected single message in content");
    const first = entry.content[0];
    if (typeof first === "object" && first !== null) {
      delete (first as { cache_control?: unknown }).cache_control;
    }
  }
  delete entry.cache_control;
}

function setEntryCacheControl(entry: Message): void {
  if (entry.content === null || entry.content === undefined) {
    entry.cache_control = { type: "ephemeral" };
    return;
  }
  if (!Array.isArray(entry.content)) {
    entry.content = [
      {
        type: "text",
        text: contentText(entry),
        cache_control: { type: "ephemeral" },
      },
    ];
  } else {
    const first = entry.content[0];
    if (typeof first === "object" && first !== null) {
      (first as { cache_control?: unknown }).cache_control = {
        type: "ephemeral",
      };
    }
  }
  if (entry.role === "tool" && Array.isArray(entry.content)) {
    const first = entry.content[0];
    if (typeof first === "object" && first !== null) {
      delete (first as { cache_control?: unknown }).cache_control;
    }
    entry.cache_control = { type: "ephemeral" };
  }
}

export function setCacheControl(
  messages: Message[],
  mode: "default_end" | null = "default_end",
): Message[] {
  if (mode === null) return messages;
  if (mode !== "default_end") throw new Error(`Invalid mode: ${mode}`);
  const copy = structuredClone(messages);
  const reversed: Message[] = [];
  for (const [index, entry] of copy.reverse().entries()) {
    clearCacheControl(entry);
    if (index === 0) setEntryCacheControl(entry);
    reversed.push(entry);
  }
  return reversed.reverse();
}
