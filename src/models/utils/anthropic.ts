import type { Message } from "../../protocols.ts";

function isThinkingBlock(block: unknown): boolean {
  if (typeof block !== "object" || block === null) return false;
  const type = (block as { type?: unknown }).type;
  return type === "thinking" || type === "redacted_thinking";
}

export function reorderAnthropicThinkingBlocks(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content))
      return message;
    const thinking = message.content.filter((block) => isThinkingBlock(block));
    if (thinking.length === 0) return message;
    const other = message.content.filter((block) => !isThinkingBlock(block));
    return {
      ...message,
      content:
        other.length > 0
          ? [...thinking, ...other]
          : [...thinking, { type: "text", text: "" }],
    };
  });
}
