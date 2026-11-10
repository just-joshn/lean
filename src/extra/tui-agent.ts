import { DefaultAgent } from "../agents/default.ts";
import { KeyboardInterrupt } from "../exceptions.ts";
import { getContentString } from "../models/utils/content-string.ts";
import type { Environment, Message } from "../protocols.ts";
import type { HistoryPort, TurnDriver, TurnInput } from "./tui.ts";

class TuiAgent extends DefaultAgent {
  private readonly input: TurnInput;

  constructor(
    model: DefaultAgent["model"],
    environment: Environment,
    config: Record<string, unknown>,
    input: TurnInput,
  ) {
    super(model, environment, { ...config, output_path: null });
    this.input = input;
  }

  override add_messages(...messages: Message[]): Message[] {
    for (const message of messages) {
      if (message.role === "assistant") {
        const text = getContentString(message);
        if (text) this.input.onText(`${text}\n`);
      }
    }
    return super.add_messages(...messages);
  }

  override async query(): Promise<Message> {
    this.checkCancelled();
    const message = await super.query();
    this.checkCancelled();
    return message;
  }

  private checkCancelled() {
    if (this.input.signal.aborted) throw new KeyboardInterrupt();
  }
}

export function createTuiSession(options: {
  environment: Environment;
  agentConfig: Record<string, unknown>;
  output: string;
}): { history: HistoryPort; driver: TurnDriver } {
  let items: readonly unknown[] = [];
  let completed: TuiAgent | null = null;
  return {
    history: {
      getItems: async () => items,
      restore: async (snapshot) => {
        items = structuredClone(snapshot);
        completed = null;
      },
      save: async () => {
        if (completed) await completed.save(options.output);
      },
      close: async () => {},
    },
    driver: async (input) => {
      input.signal.throwIfAborted();
      const model = input.model;
      if (typeof model === "string")
        throw new Error("The TUI needs a resolved model.");
      const env = options.environment;
      const environment: Environment = {
        config: env.config,
        get_template_vars: (extra) => env.get_template_vars(extra),
        serialize: () => env.serialize(),
        execute: async (action, cwd, timeout) => {
          input.signal.throwIfAborted();
          const allowed = await input.approve(
            JSON.stringify({ tool: "bash", command: action.command }),
          );
          input.signal.throwIfAborted();
          if (!allowed)
            return {
              output: "",
              returncode: -1,
              exception_info:
                "The user denied this command. It was not executed.",
            };
          const output = await env.execute(action, cwd, timeout);
          input.signal.throwIfAborted();
          return output;
        },
      };
      const agent = new TuiAgent(
        model,
        environment,
        options.agentConfig,
        input,
      );
      const result = await agent.run(input.text);
      input.signal.throwIfAborted();
      input.onText(
        `\nTask ended (${String(result.exit_status ?? "unknown")}).\n${String(result.submission ?? "")}`,
      );
      items = [...items, ...agent.messages];
      completed = agent;
    },
  };
}
