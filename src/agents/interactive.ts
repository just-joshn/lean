import type { ExecutionOutput, Message } from "../protocols.ts";
import {
  LimitsExceeded,
  Submitted,
  TimeExceeded,
  UserInterruption,
} from "../exceptions.ts";
import { KeyboardInterrupt } from "../exceptions.ts";
import { getContentString } from "../models/utils/content-string.ts";
import { AgentConfig, DefaultAgent } from "./default.ts";
import { readBuiltinLimit, readInteractive } from "./prompt.ts";

export class InteractiveAgentConfig extends AgentConfig {
  mode: "human" | "confirm" | "yolo" = "confirm";
  whitelist_actions: string[] = [];
  confirm_exit = true;

  constructor(data: Record<string, unknown> = {}) {
    super(data);
    if (
      data.mode === "human" ||
      data.mode === "confirm" ||
      data.mode === "yolo"
    )
      this.mode = data.mode;
    if (Array.isArray(data.whitelist_actions))
      this.whitelist_actions = data.whitelist_actions.map(String);
    if (typeof data.confirm_exit === "boolean")
      this.confirm_exit = data.confirm_exit;
  }

  override model_dump(): Record<string, unknown> {
    return {
      ...super.model_dump(),
      mode: this.mode,
      whitelist_actions: this.whitelist_actions,
      confirm_exit: this.confirm_exit,
    };
  }
}

const MODE_COMMANDS: Record<string, "human" | "confirm" | "yolo"> = {
  "/u": "human",
  "/c": "confirm",
  "/y": "yolo",
};

function visible(text: string): string {
  return text.replace(/\[[^\]]*\]/g, "");
}

function anchored(pattern: string, text: string): boolean {
  const match = new RegExp(pattern).exec(text);
  return match !== null && match.index === 0;
}

export class InteractiveAgent extends DefaultAgent {
  override readonly type_name =
    "minisweagent.agents.interactive.InteractiveAgent";
  cost_last_confirmed = 0;
  readLine: (lines?: "single" | "multiline") => Promise<string> =
    readInteractive;
  readLimit: () => Promise<string> = readBuiltinLimit;
  stdinIsInteractive: () => boolean = () => {
    try {
      return Boolean(process.stdin.isTTY);
    } catch {
      return false;
    }
  };

  constructor(
    model: DefaultAgent["model"],
    env: DefaultAgent["env"],
    data: Record<string, unknown> = {},
  ) {
    super(model, env, data, InteractiveAgentConfig);
  }

  private options(): InteractiveAgentConfig {
    return this.config as InteractiveAgentConfig;
  }

  private interrupt(content: string, itype = "UserInterruption"): never {
    throw new UserInterruption({
      role: "user",
      content,
      extra: { interrupt_type: itype },
    });
  }

  override add_messages(...messages: Message[]): Message[] {
    for (const message of messages) {
      const role =
        message.role ||
        (typeof message.type === "string" ? message.type : "unknown");
      const content = getContentString(message);
      if (role === "assistant") {
        process.stdout.write(
          `\nmini-swe-agent (step ${this.n_calls}, $${this.cost.toFixed(2)}):\n`,
        );
      } else {
        process.stdout.write(
          `\n${role.charAt(0).toUpperCase()}${role.slice(1)}:\n`,
        );
      }
      process.stdout.write(`${content}\n`);
    }
    return super.add_messages(...messages);
  }

  override async query(): Promise<Message> {
    if (this.options().mode === "human") {
      const command = await this.prompt("[bold yellow]>[/bold yellow] ");
      if (command !== "/y" && command !== "/c") {
        const message: Message = {
          role: "user",
          content: `User command: \n\`\`\`bash\n${command}\n\`\`\``,
          extra: { actions: [{ command }] },
        };
        this.add_messages(message);
        return message;
      }
    }
    try {
      process.stdout.write("Waiting for the LM to respond...\n");
      return await super.query();
    } catch (error) {
      if (error instanceof TimeExceeded) throw error;
      if (!(error instanceof LimitsExceeded)) throw error;
      if (!this.stdinIsInteractive()) throw error;
      process.stdout.write(
        `Limits exceeded. Limits: ${this.config.step_limit} steps, $${this.config.cost_limit}.\nCurrent spend: ${this.n_calls} steps, $${this.cost.toFixed(2)}.\n`,
      );
      process.stdout.write("New step limit: ");
      this.config.step_limit = Number.parseInt(await this.readLimit(), 10);
      process.stdout.write("New cost limit: ");
      this.config.cost_limit = Number.parseFloat(await this.readLimit());
      return await super.query();
    }
  }

  override async step(): Promise<Message[]> {
    try {
      process.stdout.write("\n---\n");
      return await super.step();
    } catch (error) {
      if (!(error instanceof KeyboardInterrupt)) throw error;
      let message = (
        await this.prompt(
          "\n\n[bold yellow]Interrupted.[/bold yellow] [green]Type a comment/command[/green] (/h for available commands)\n[bold yellow]>[/bold yellow] ",
        )
      ).trim();
      if (!message || message in MODE_COMMANDS)
        message = "Temporary interruption caught.";
      this.interrupt(`Interrupted by user: ${message}`);
    }
  }

  override async execute_actions(message: Message): Promise<Message[]> {
    const actions = Array.isArray(message.extra?.actions)
      ? message.extra.actions
      : [];
    const commands = actions.map((action) => String(action.command ?? ""));
    const outputs: ExecutionOutput[] = [];
    let observations: Message[] = [];
    try {
      await this.askConfirmation(commands);
      for (const action of actions) {
        try {
          outputs.push(await Promise.resolve(this.env.execute(action)));
        } catch (error) {
          if (error instanceof Submitted) await this.checkSubmit(error);
          else throw error;
        }
      }
    } finally {
      observations = this.add_messages(
        ...(await Promise.resolve(
          this.model.format_observation_messages(
            message,
            outputs,
            await this.get_template_vars(),
          ),
        )),
      );
    }
    return observations;
  }

  private async checkSubmit(error: Submitted): Promise<never> {
    if (this.options().confirm_exit) {
      const userInput = (
        await this.prompt(
          "[bold yellow]Agent wants to finish.[/bold yellow] [bold green]Type new task[/bold green] or [bold]Enter[/bold] to quit ([bold]/h[/bold] for commands)\n[bold yellow]>[/bold yellow] ",
        )
      ).trim();
      if (userInput === "/u") this.interrupt("Switched to human mode.");
      if (userInput in MODE_COMMANDS) return this.checkSubmit(error);
      if (userInput)
        this.interrupt(
          `The user added a new task: ${userInput}`,
          "UserNewTask",
        );
    }
    throw error;
  }

  private shouldConfirm(action: string): boolean {
    return (
      this.options().mode === "confirm" &&
      !this.options().whitelist_actions.some((pattern) =>
        anchored(pattern, action),
      )
    );
  }

  private async askConfirmation(commands: string[]): Promise<void> {
    if (!commands.some((command) => this.shouldConfirm(command))) return;
    const userInput = (
      await this.prompt(
        `[bold yellow]Execute ${commands.length} action(s)?[/] [green][bold]Enter[/] to confirm[/], [red]type [bold]comment[/] to reject[/], or [blue][bold]/h[/] to show available commands[/]\n[bold yellow]>[/bold yellow] `,
      )
    ).trim();
    if (userInput === "" || userInput === "/y") return;
    if (userInput === "/u")
      this.interrupt(
        "Commands not executed. Switching to human mode",
        "UserRejection",
      );
    this.interrupt(
      `Commands not executed. The user rejected your commands with the following message: ${userInput}`,
      "UserRejection",
    );
  }

  private async prompt(prompt: string, multiline = false): Promise<string> {
    process.stdout.write(visible(prompt));
    const userInput = await this.readLine(multiline ? "multiline" : "single");
    if (userInput === "/m") return this.prompt(prompt, true);
    if (userInput === "/h") {
      process.stdout.write(
        `Current mode: ${this.options().mode}\n/y to switch to yolo mode (execute LM commands without confirmation)\n/c to switch to confirmation mode (ask for confirmation before executing LM commands)\n/u to switch to human mode (execute commands issued by the user)\n/m to enter multiline comment\n`,
      );
      return this.prompt(prompt);
    }
    const next = MODE_COMMANDS[userInput];
    if (next) {
      if (this.options().mode === next) {
        return this.prompt(
          `[bold red]Already in ${this.options().mode} mode.[/bold red]\n${prompt}`,
        );
      }
      this.options().mode = next;
      process.stdout.write(`Switched to ${this.options().mode} mode.\n`);
      return userInput;
    }
    return userInput;
  }
}
