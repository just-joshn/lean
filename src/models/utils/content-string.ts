import type { Message } from "../../protocols.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatToolCall(args: unknown): string {
  try {
    const parsed = typeof args === "string" ? JSON.parse(args) : args;
    if (isRecord(parsed) && "command" in parsed)
      return `\`\`\`\n${String(parsed.command)}\n\`\`\``;
  } catch {
    return `\`\`\`\n${String(args)}\n\`\`\``;
  }
  return `\`\`\`\n${String(args)}\n\`\`\``;
}

function formatObservation(content: string): string {
  try {
    const data: unknown = JSON.parse(content);
    if (isRecord(data) && "returncode" in data) {
      return Object.entries(data)
        .flatMap(([key, value]) => [`<${key}>`, String(value)])
        .join("\n");
    }
  } catch {
    return content;
  }
  return content;
}

export function getContentString(message: Message): string {
  const texts: string[] = [];
  const content = message.content;
  if (typeof content === "string") texts.push(formatObservation(content));
  else if (Array.isArray(content)) {
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === "tool_use")
        texts.push(formatToolCall(JSON.stringify(item.input ?? {})));
      else if (
        item.type === "tool_result" &&
        typeof item.content === "string"
      ) {
        texts.push(formatObservation(item.content));
      } else if (typeof item.text === "string" && item.text)
        texts.push(item.text);
    }
  }
  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      if (!isRecord(call) || !isRecord(call.function)) continue;
      texts.push(formatToolCall(call.function.arguments ?? "{}"));
    }
  }
  const output = message.output;
  if (typeof output === "string") texts.push(formatObservation(output));
  else if (Array.isArray(output)) {
    for (const item of output) {
      if (!isRecord(item)) continue;
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (isRecord(part) && typeof part.text === "string" && part.text)
            texts.push(part.text);
        }
      } else if (item.type === "function_call")
        texts.push(formatToolCall(item.arguments ?? "{}"));
    }
  }
  return texts.filter((text) => text).join("\n\n");
}
