import type { Message } from "../protocols.ts";
import { ProviderParityGateError } from "./route.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function bedrockConverseBody(
  messages: Message[],
  tools: unknown[] | undefined,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const inferenceConfig: Record<string, unknown> = {};
  const names: Record<string, string> = {
    max_tokens: "maxTokens",
    max_completion_tokens: "maxTokens",
    temperature: "temperature",
    top_p: "topP",
    stop: "stopSequences",
  };
  for (const [key, value] of Object.entries(params)) {
    const name = names[key];
    if (!name)
      throw new ProviderParityGateError("bedrock", `Converse parameter ${key}`);
    inferenceConfig[name] =
      key === "stop" && typeof value === "string" ? [value] : value;
  }
  const converted = messages.map((message) => {
    if (
      typeof message.content !== "string" ||
      !["system", "user", "assistant"].includes(String(message.role)) ||
      message.tool_calls
    ) {
      throw new ProviderParityGateError(
        "bedrock",
        "Converse non-text messages and tool replay",
      );
    }
    const content: unknown[] = [{ text: message.content }];
    if (message.cache_control) {
      if (
        !record(message.cache_control) ||
        message.cache_control.type !== "ephemeral" ||
        message.cache_control.ttl !== undefined
      ) {
        throw new ProviderParityGateError(
          "bedrock",
          "Converse cache control outside the captured ephemeral case",
        );
      }
      content.push({ cachePoint: { type: "default" } });
    }
    return { role: message.role, content };
  });
  const body: Record<string, unknown> = {
    messages: converted.filter((message) => message.role !== "system"),
    inferenceConfig,
  };
  const system = converted
    .filter((message) => message.role === "system")
    .flatMap((message) => message.content);
  if (system.length) body.system = system;
  if (tools?.length) {
    body.toolConfig = {
      tools: tools.map((tool) => {
        if (
          !record(tool) ||
          tool.type !== "function" ||
          !record(tool.function)
        ) {
          throw new ProviderParityGateError(
            "bedrock",
            "Converse non-function tools",
          );
        }
        return {
          toolSpec: {
            inputSchema: { json: tool.function.parameters },
            name: tool.function.name,
            ...(tool.function.description !== undefined
              ? { description: tool.function.description }
              : {}),
          },
        };
      }),
    };
  }
  return body;
}
