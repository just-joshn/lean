import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  Agent,
  Runner,
  getDefaultModel,
  type Model,
  type RunStreamEvent,
  type RunToolApprovalItem,
  type Session,
} from "@openai/agents";
import { createWorkspaceTools, type WorkspaceHost } from "./tools.ts";

const MAX_TURNS = 25;
const DEFAULT_INSTRUCTIONS =
  "You are a coding agent working in this workspace.";

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export function resolveModel(explicit?: string): string {
  if (explicit) return explicit;
  const named = process.env.OPENAI_MODEL;
  if (named) return named;
  return getDefaultModel();
}

export async function createAgent(options: {
  cwd: string;
  signal: AbortSignal;
  model?: string | Model;
}): Promise<Agent> {
  const cwd = await realpath(options.cwd);
  let instructions = DEFAULT_INSTRUCTIONS;
  try {
    instructions = await readFile(join(cwd, "AGENTS.md"), "utf8");
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
  const host: WorkspaceHost = { cwd, signal: options.signal };
  const tools = createWorkspaceTools(host);
  return new Agent({
    name: "lean",
    instructions,
    handoffs: [],
    model: options.model ?? resolveModel(),
    modelSettings: { parallelToolCalls: false },
    tools: [tools.read, tools.shell, tools.applyPatch],
  });
}

function approvalDetail(item: RunToolApprovalItem): string {
  const raw = item.rawItem;
  const body =
    raw.type === "shell_call"
      ? { tool: item.name ?? "shell", action: raw.action }
      : raw.type === "apply_patch_call"
        ? { tool: item.name ?? "apply_patch", operation: raw.operation }
        : { tool: item.name, arguments: item.arguments };
  return JSON.stringify(body);
}

async function consume(
  stream: AsyncIterable<RunStreamEvent> & { completed: Promise<void> },
  onText: (delta: string) => void,
): Promise<void> {
  const completed = stream.completed;
  try {
    for await (const event of stream) {
      if (
        event.type === "raw_model_stream_event" &&
        event.data.type === "output_text_delta"
      ) {
        onText(event.data.delta);
      }
    }
  } catch (error) {
    await completed.catch(() => undefined);
    throw error;
  }
  await completed;
}

export async function runTurn(options: {
  cwd: string;
  input: string;
  session: Session;
  signal: AbortSignal;
  approve: (detail: string) => boolean | Promise<boolean>;
  onText: (delta: string) => void;
  onTool?: (detail: string) => void;
  model?: string | Model;
  trace?: boolean;
}) {
  const agent = await createAgent({
    cwd: options.cwd,
    signal: options.signal,
    model: options.model,
  });
  const runner = new Runner({
    tracingDisabled: options.trace !== true,
    traceIncludeSensitiveData: false,
  });
  const runOptions = {
    stream: true as const,
    session: options.session,
    signal: options.signal,
    maxTurns: MAX_TURNS,
  };
  options.signal.throwIfAborted();
  let stream = await runner.run(agent, options.input, runOptions);
  for (;;) {
    await consume(stream, options.onText);
    options.signal.throwIfAborted();
    if (stream.interruptions.length === 0) {
      if (stream.error) throw stream.error;
      return stream;
    }
    for (const interruption of stream.interruptions) {
      options.signal.throwIfAborted();
      const detail = approvalDetail(interruption);
      options.onTool?.(detail);
      if (await options.approve(detail)) stream.state.approve(interruption);
      else stream.state.reject(interruption);
    }
    options.signal.throwIfAborted();
    stream = await runner.run(agent, stream.state, runOptions);
  }
}
