import {
  protocol,
  Usage,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from "@openai/agents";
import type {
  AssistantMessage,
  JsonObject,
  JsonValue,
  Message,
  Models,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { z } from "zod";

const replayKey = "leanAnthropic";

const replaySchema = z.object({
  signature: z.string().min(1).optional(),
  redacted: z.boolean().optional(),
  effort: z.string().min(1).optional(),
});

type Replay = z.infer<typeof replaySchema>;
type NativeKind = "shell" | "patch" | "function";

type OpenCall = {
  id: string;
  name: string;
  kind: NativeKind;
};

type Turn = {
  blocks: AssistantMessage["content"];
  calls: OpenCall[];
  pending: Map<string, OpenCall>;
  results: Map<string, ToolResultMessage>;
  effort?: string;
};

function fail(index: number, kind: string, reason: string): never {
  throw new Error(`Cannot replay history item ${index} (${kind}). ${reason}`);
}

function itemKind(item: protocol.ModelItem): string {
  if (
    "role" in item &&
    (item.role === "user" ||
      item.role === "assistant" ||
      item.role === "system")
  ) {
    return item.role;
  }
  if ("type" in item && typeof item.type === "string") return item.type;
  return "unknown";
}

function readReplay(providerData: unknown): Replay | undefined {
  if (typeof providerData !== "object" || providerData === null)
    return undefined;
  const parsed = replaySchema.safeParse(Reflect.get(providerData, replayKey));
  return parsed.success ? parsed.data : undefined;
}

function replayData(input: Replay): Record<string, unknown> | undefined {
  const replay: Replay = {};
  if (input.signature !== undefined) replay.signature = input.signature;
  if (input.redacted === true) replay.redacted = true;
  if (input.effort !== undefined) replay.effort = input.effort;
  return Object.keys(replay).length === 0 ? undefined : { [replayKey]: replay };
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Tool arguments must be JSON.");
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => jsonValue(entry));
  if (typeof value === "object") return jsonObject(value);
  throw new Error("Tool arguments must be JSON.");
}

function jsonObject(value: object): JsonObject {
  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = jsonValue(entry);
  }
  return result;
}

function schemaParameters(schema: object): JsonObject {
  return jsonObject(
    Object.fromEntries(
      Object.entries(schema).filter(([key]) => key !== "$schema"),
    ),
  );
}

function shellParameters(): JsonObject {
  return schemaParameters(protocol.ShellAction.toJSONSchema());
}

function patchParameters(): JsonObject {
  return {
    type: "object",
    properties: {
      operation: schemaParameters(protocol.ApplyPatchOperation.toJSONSchema()),
    },
    required: ["operation"],
    additionalProperties: false,
  };
}

function toolsFor(tools: readonly ModelRequest["tools"][number][]): {
  declared: Tool[];
  shell?: string;
  patch?: string;
} {
  const declared: Tool[] = [];
  let shell: string | undefined;
  let patch: string | undefined;
  for (const tool of tools) {
    if (tool.type === "function") {
      declared.push({
        name: tool.name,
        description: tool.description,
        parameters: jsonObject(tool.parameters),
      });
      continue;
    }
    if (tool.type === "shell") {
      shell = tool.name;
      declared.push({
        name: tool.name,
        description: "Run shell commands in the workspace.",
        parameters: shellParameters(),
      });
      continue;
    }
    if (tool.type === "apply_patch") {
      patch = tool.name;
      declared.push({
        name: tool.name,
        description: "Create, update, or delete a workspace file.",
        parameters: patchParameters(),
      });
      continue;
    }
    throw new Error(`Cannot send a ${tool.type} tool to Anthropic.`);
  }
  return { declared, shell, patch };
}

function operationRecord(operation: protocol.ApplyPatchOperation): JsonObject {
  switch (operation.type) {
    case "create_file":
      return {
        type: operation.type,
        path: operation.path,
        diff: operation.diff,
      };
    case "update_file":
      return {
        type: operation.type,
        path: operation.path,
        diff: operation.diff,
        ...(operation.moveTo === undefined ? {} : { moveTo: operation.moveTo }),
      };
    case "delete_file":
      return { type: operation.type, path: operation.path };
    default: {
      const unreachable: never = operation;
      throw new Error(
        `Unsupported patch operation ${JSON.stringify(unreachable)}.`,
      );
    }
  }
}

function shellArguments(action: protocol.ShellAction): JsonObject {
  return {
    commands: [...action.commands],
    ...(action.timeoutMs === undefined ? {} : { timeoutMs: action.timeoutMs }),
    ...(action.maxOutputLength === undefined
      ? {}
      : { maxOutputLength: action.maxOutputLength }),
  };
}

function userText(index: number, item: protocol.ModelItem): string {
  const parsed = protocol.UserMessageItem.safeParse(item);
  if (!parsed.success) fail(index, "user", "The user message is not valid.");
  const content = parsed.data.content;
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type !== "input_text") {
        fail(index, "user", `Unsupported user content ${part.type}.`);
      }
      return part.text;
    })
    .join("");
}

function assistantText(
  index: number,
  item: protocol.ModelItem,
): {
  texts: string[];
  effort?: string;
} {
  const parsed = protocol.AssistantMessageItem.safeParse(item);
  if (!parsed.success)
    fail(index, "assistant", "The assistant message is not valid.");
  const texts: string[] = [];
  for (const part of parsed.data.content) {
    if (part.type !== "output_text") {
      fail(index, "assistant", `Unsupported assistant content ${part.type}.`);
    }
    if (part.text.length > 0) texts.push(part.text);
  }
  return { texts, effort: readReplay(parsed.data.providerData)?.effort };
}

function thinkingFrom(
  index: number,
  item: protocol.ModelItem,
): {
  block: Extract<AssistantMessage["content"][number], { type: "thinking" }>;
  effort?: string;
} {
  const parsed = protocol.ReasoningItem.safeParse(item);
  if (!parsed.success)
    fail(index, "reasoning", "The reasoning item is not valid.");
  const replay = readReplay(parsed.data.providerData);
  if (!replay?.signature) {
    fail(index, "reasoning", "Missing Anthropic thinking signature.");
  }
  const thinking = (parsed.data.rawContent ?? parsed.data.content)
    .map((part) => part.text)
    .join("");
  return {
    effort: replay.effort,
    block: {
      type: "thinking",
      thinking: replay.redacted === true ? "" : thinking,
      thinkingSignature: replay.signature,
      ...(replay.redacted === true ? { redacted: true } : {}),
    },
  };
}

function callFrom(
  index: number,
  item: protocol.ModelItem,
  names: { shell?: string; patch?: string },
): { call: OpenCall; arguments: JsonObject } {
  const kind = itemKind(item);
  if (kind === "shell_call") {
    const parsed = protocol.ShellCallItem.safeParse(item);
    if (!parsed.success || names.shell === undefined) {
      fail(index, kind, "The shell call does not match the shell tool.");
    }
    return {
      call: { id: parsed.data.callId, name: names.shell, kind: "shell" },
      arguments: shellArguments(parsed.data.action),
    };
  }
  if (kind === "apply_patch_call") {
    const parsed = protocol.ApplyPatchCallItem.safeParse(item);
    if (!parsed.success || names.patch === undefined) {
      fail(index, kind, "The patch call does not match the apply_patch tool.");
    }
    return {
      call: { id: parsed.data.callId, name: names.patch, kind: "patch" },
      arguments: { operation: operationRecord(parsed.data.operation) },
    };
  }
  const parsed = protocol.FunctionCallItem.safeParse(item);
  if (!parsed.success) fail(index, kind, "The function call is not valid.");
  if (parsed.data.name === names.shell || parsed.data.name === names.patch) {
    fail(
      index,
      kind,
      `A function named ${parsed.data.name} is not a native tool call.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(parsed.data.arguments);
  } catch (error) {
    fail(
      index,
      kind,
      error instanceof Error ? error.message : "Invalid arguments.",
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(index, kind, "Function arguments must be a JSON object.");
  }
  return {
    call: { id: parsed.data.callId, name: parsed.data.name, kind: "function" },
    arguments: jsonObject(value),
  };
}

function resultText(
  index: number,
  output: protocol.FunctionCallResultItem["output"],
): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((part) => {
        if (part.type !== "input_text") {
          fail(
            index,
            "function_call_result",
            "Only text output can be replayed.",
          );
        }
        return part.text;
      })
      .join("");
  }
  if (output.type !== "text") {
    fail(index, "function_call_result", "Only text output can be replayed.");
  }
  return output.text;
}

function shellResult(output: protocol.ShellCallResultItem["output"]): {
  text: string;
  isError: boolean;
} {
  const text = output
    .map((entry, index) => {
      const outcome =
        entry.outcome.type === "timeout"
          ? "timeout"
          : `exit ${entry.outcome.exitCode}`;
      return [`command ${index + 1}`, entry.stdout, entry.stderr, outcome]
        .filter((part) => part.length > 0)
        .join("\n");
    })
    .join("\n");
  const isError = output.some(
    (entry) =>
      entry.outcome.type === "timeout" ||
      (entry.outcome.type === "exit" && entry.outcome.exitCode !== 0),
  );
  return { text, isError };
}

function resultFrom(
  index: number,
  item: protocol.ModelItem,
  call: OpenCall,
): ToolResultMessage {
  const kind = itemKind(item);
  if (kind === "shell_call_output") {
    const parsed = protocol.ShellCallResultItem.safeParse(item);
    if (!parsed.success) fail(index, kind, "The shell output is not valid.");
    const rendered = shellResult(parsed.data.output);
    return {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: rendered.text }],
      isError: rendered.isError,
      timestamp: 0,
    };
  }
  if (kind === "apply_patch_call_output") {
    const parsed = protocol.ApplyPatchCallResultItem.safeParse(item);
    if (!parsed.success) fail(index, kind, "The patch output is not valid.");
    return {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [
        { type: "text", text: parsed.data.output ?? parsed.data.status },
      ],
      isError: parsed.data.status === "failed",
      timestamp: 0,
    };
  }
  const parsed = protocol.FunctionCallResultItem.safeParse(item);
  if (!parsed.success) fail(index, kind, "The function output is not valid.");
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: resultText(index, parsed.data.output) }],
    isError: false,
    timestamp: 0,
  };
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function flush(turn: Turn, modelId: string, messages: Message[]): void {
  if (turn.calls.length !== turn.results.size) {
    throw new Error("A tool call has no output.");
  }
  if (turn.blocks.length === 0) return;
  const message: AssistantMessage = {
    role: "assistant",
    content: turn.blocks,
    api: "anthropic-messages",
    provider: "anthropic",
    model: modelId,
    usage: emptyUsage(),
    stopReason: turn.calls.length > 0 ? "toolUse" : "stop",
    timestamp: 0,
    ...(turn.effort === undefined
      ? {}
      : { providerThinkingLevel: turn.effort }),
  };
  messages.push(message);
  for (const call of turn.calls) {
    const result = turn.results.get(call.id);
    if (result === undefined) throw new Error(`Missing output for ${call.id}.`);
    messages.push(result);
  }
}

function compileHistory(input: {
  items: string | readonly protocol.ModelItem[];
  tools: readonly ModelRequest["tools"][number][];
  modelId: string;
}): { messages: Message[]; tools: Tool[]; shell?: string; patch?: string } {
  const names = toolsFor(input.tools);
  if (typeof input.items === "string") {
    return {
      messages: [{ role: "user", content: input.items, timestamp: 0 }],
      tools: names.declared,
      shell: names.shell,
      patch: names.patch,
    };
  }
  const messages: Message[] = [];
  let turn: Turn | undefined;
  const close = () => {
    if (turn === undefined) return;
    flush(turn, input.modelId, messages);
    turn = undefined;
  };
  const ensure = (): Turn => {
    turn ??= { blocks: [], calls: [], pending: new Map(), results: new Map() };
    return turn;
  };
  input.items.forEach((item, index) => {
    const kind = itemKind(item);
    if (kind === "system") {
      fail(index, kind, "System items belong in the request instructions.");
    }
    if (kind === "user") {
      close();
      messages.push({
        role: "user",
        content: userText(index, item),
        timestamp: 0,
      });
      return;
    }
    if (kind === "assistant") {
      const current = ensure();
      if (current.results.size > 0) {
        fail(
          index,
          kind,
          "Assistant text arrived before tool output finished.",
        );
      }
      const read = assistantText(index, item);
      for (const text of read.texts)
        current.blocks.push({ type: "text", text });
      current.effort ??= read.effort;
      return;
    }
    if (kind === "reasoning") {
      const current = ensure();
      if (current.results.size > 0) {
        fail(index, kind, "Thinking arrived before tool output finished.");
      }
      const read = thinkingFrom(index, item);
      current.blocks.push(read.block);
      current.effort ??= read.effort;
      return;
    }
    if (
      kind === "shell_call" ||
      kind === "apply_patch_call" ||
      kind === "function_call"
    ) {
      const current = ensure();
      if (current.results.size > 0) {
        fail(
          index,
          kind,
          "A new tool call arrived before the previous output.",
        );
      }
      const read = callFrom(index, item, names);
      if (current.pending.has(read.call.id)) {
        fail(index, kind, `Duplicate call ${read.call.id}.`);
      }
      current.pending.set(read.call.id, read.call);
      current.calls.push(read.call);
      current.blocks.push({
        type: "toolCall",
        id: read.call.id,
        name: read.call.name,
        arguments: read.arguments,
      });
      return;
    }
    if (
      kind === "shell_call_output" ||
      kind === "apply_patch_call_output" ||
      kind === "function_call_result"
    ) {
      if (turn === undefined || turn.calls.length === 0) {
        fail(index, kind, "Tool output has no matching call.");
      }
      const callId =
        "callId" in item && typeof item.callId === "string" ? item.callId : "";
      const call = turn.pending.get(callId);
      if (call === undefined || turn.results.has(callId)) {
        fail(index, kind, `No open call for ${callId}.`);
      }
      const expected =
        call.kind === "shell"
          ? "shell_call_output"
          : call.kind === "patch"
            ? "apply_patch_call_output"
            : "function_call_result";
      if (kind !== expected)
        fail(index, kind, `Expected ${expected} for call ${call.id}.`);
      turn.results.set(call.id, resultFrom(index, item, call));
      if (turn.results.size === turn.calls.length) close();
      return;
    }
    fail(index, kind, "This item type is not supported.");
  });
  close();
  return {
    messages,
    tools: names.declared,
    shell: names.shell,
    patch: names.patch,
  };
}

function historyItems(
  input: ModelRequest["input"],
): string | protocol.ModelItem[] {
  if (typeof input === "string") return input;
  return input.map((item, index) => {
    const parsed = protocol.ModelItem.safeParse(item);
    if (!parsed.success)
      fail(index, "input", "The history item is not supported.");
    return parsed.data;
  });
}

type StreamOutput = Extract<
  StreamEvent,
  { type: "response_done" }
>["response"]["output"];

function project(
  message: AssistantMessage,
  names: { shell?: string; patch?: string },
): StreamOutput {
  const output: StreamOutput = [];
  const texts: string[] = [];
  const effort = message.providerThinkingLevel;
  const flushText = () => {
    if (texts.length === 0) return;
    output.push(
      protocol.AssistantMessageItem.parse({
        type: "message",
        role: "assistant",
        status: "completed",
        content: texts.map((text) => ({ type: "output_text", text })),
        providerData: replayData({ effort }),
      }),
    );
    texts.length = 0;
  };
  for (const block of message.content) {
    if (block.type === "text") {
      if (block.text.length > 0) texts.push(block.text);
      continue;
    }
    if (block.type === "thinking") {
      flushText();
      if (
        !block.thinkingSignature ||
        block.thinkingSignature.trim().length === 0
      ) {
        throw new Error("Anthropic thinking has no signature to replay.");
      }
      output.push(
        protocol.ReasoningItem.parse({
          type: "reasoning",
          content: [
            { type: "input_text", text: block.redacted ? "" : block.thinking },
          ],
          rawContent: [
            {
              type: "reasoning_text",
              text: block.redacted ? "" : block.thinking,
            },
          ],
          providerData: replayData({
            signature: block.thinkingSignature,
            redacted: block.redacted === true ? true : undefined,
            effort,
          }),
        }),
      );
      continue;
    }
    if (block.type !== "toolCall") {
      throw new Error("Unsupported assistant content.");
    }
    flushText();
    if (block.argumentsError) {
      throw new Error(`${block.name} arguments were not a JSON object.`);
    }
    output.push(nativeCall(block, names));
  }
  flushText();
  return output;
}

function nativeCall(
  block: ToolCall,
  names: { shell?: string; patch?: string },
): StreamOutput[number] {
  if (names.shell !== undefined && block.name === names.shell) {
    const action = protocol.ShellAction.safeParse(block.arguments);
    if (!action.success)
      throw new Error("Shell arguments do not match the shell tool.");
    return protocol.ShellCallItem.parse({
      type: "shell_call",
      callId: block.id,
      status: "completed",
      action: action.data,
    });
  }
  if (names.patch !== undefined && block.name === names.patch) {
    const record = block.arguments;
    const operation = protocol.ApplyPatchOperation.safeParse(
      typeof record === "object" && record !== null && "operation" in record
        ? record.operation
        : undefined,
    );
    if (!operation.success) {
      throw new Error("Patch arguments do not match the apply_patch tool.");
    }
    return protocol.ApplyPatchCallItem.parse({
      type: "apply_patch_call",
      callId: block.id,
      status: "completed",
      operation: operation.data,
    });
  }
  return protocol.FunctionCallItem.parse({
    type: "function_call",
    callId: block.id,
    name: block.name,
    status: "completed",
    arguments: JSON.stringify(block.arguments),
  });
}

function usageFrom(message: AssistantMessage): Usage {
  const inputTokens =
    message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
  const inputTokensDetails =
    message.usage.cacheRead > 0
      ? { cached_tokens: message.usage.cacheRead }
      : undefined;
  const outputTokensDetails =
    message.usage.reasoning === undefined
      ? undefined
      : { reasoning_tokens: message.usage.reasoning };
  return new Usage({
    requests: 1,
    inputTokens,
    outputTokens: message.usage.output,
    totalTokens: message.usage.totalTokens,
    ...(inputTokensDetails === undefined ? {} : { inputTokensDetails }),
    ...(outputTokensDetails === undefined ? {} : { outputTokensDetails }),
  });
}

function failed(error: unknown, redact: (error: unknown) => string): Error {
  const message = redact(error);
  return error instanceof Error && error.message === message
    ? error
    : new Error(message);
}

export function createAnthropicModel(options: {
  models: Models;
  modelId: string;
  redact: (error: unknown) => string;
}): Model {
  const catalog = options.models.getModel("anthropic", options.modelId);
  if (catalog === undefined) {
    throw new Error(`Unknown anthropic model "${options.modelId}".`);
  }
  const model: Model = {
    async getResponse(request) {
      let response: ModelResponse | undefined;
      for await (const event of model.getStreamedResponse(request)) {
        if (event.type === "response_done") {
          response = {
            usage: new Usage(event.response.usage),
            output: event.response.output,
            responseId: event.response.id,
            ...(event.response.providerData === undefined
              ? {}
              : { providerData: event.response.providerData }),
          };
        }
      }
      if (response === undefined) {
        throw new Error("The model stream ended without a response.");
      }
      return response;
    },
    async *getStreamedResponse(request): AsyncIterable<StreamEvent> {
      try {
        const compiled = compileHistory({
          items: historyItems(request.input),
          tools: request.tools,
          modelId: options.modelId,
        });
        const stream = options.models.stream(
          catalog,
          {
            ...(request.systemInstructions === undefined
              ? {}
              : { systemPrompt: request.systemInstructions }),
            messages: compiled.messages,
            tools: compiled.tools,
          },
          { signal: request.signal },
        );
        let done: AssistantMessage | undefined;
        for await (const event of stream) {
          if (event.type === "text_delta" && event.delta.length > 0) {
            yield { type: "output_text_delta", delta: event.delta };
            continue;
          }
          if (event.type === "error") {
            throw new Error(
              event.error.errorMessage ?? "Anthropic request failed.",
            );
          }
          if (event.type === "done") done = event.message;
        }
        if (done === undefined)
          throw new Error("The model stream ended without a response.");
        if (done.stopReason === "error" || done.stopReason === "aborted") {
          throw new Error(done.errorMessage ?? "Anthropic request failed.");
        }
        request.signal?.throwIfAborted();
        const output = project(done, compiled);
        yield {
          type: "response_done",
          response: {
            id: done.responseId ?? "msg_anthropic",
            usage: usageFrom(done),
            output,
          },
        };
      } catch (error) {
        throw failed(error, options.redact);
      }
    },
  };
  return model;
}
