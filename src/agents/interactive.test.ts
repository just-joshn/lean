import { describe, expect, test } from "vitest";
import { KeyboardInterrupt, Submitted } from "../exceptions.ts";
import type {
  Action,
  Environment,
  ExecutionOutput,
  Message,
  Model,
} from "../protocols.ts";
import { InteractiveAgent } from "./interactive.ts";

class ScriptModel implements Model {
  config = { model_dump: () => ({ model_name: "script" }) };
  outputs: Message[];
  constructor(outputs: Message[]) {
    this.outputs = outputs;
  }
  query(): Message {
    const next = this.outputs.shift();
    if (!next) throw new Error("no scripted output");
    return next;
  }
  format_message(fields: Message): Message {
    return fields;
  }
  format_observation_messages(
    message: Message,
    outputs: ExecutionOutput[],
  ): Message[] {
    const actions = (message.extra?.actions as Action[] | undefined) ?? [];
    const padded = actions.map(
      (action, index) =>
        outputs[index] ?? {
          output: "",
          returncode: -1,
          exception_info: "action was not executed",
        },
    );
    return padded.map((output, index) => ({
      role: "user",
      content: `${String(actions[index]?.command)} => ${output.exception_info || output.output}`,
    }));
  }
  get_template_vars(): Record<string, unknown> {
    return {};
  }
  serialize(): Record<string, unknown> {
    return {};
  }
}

class ScriptEnv implements Environment {
  config = { model_dump: () => ({}) };
  commands: string[] = [];
  execute(action: Action): ExecutionOutput {
    const command = String(action.command);
    this.commands.push(command);
    if (command.includes("COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT")) {
      throw new Submitted({
        role: "exit",
        content: "body",
        extra: { exit_status: "Submitted", submission: "body" },
      });
    }
    return { output: `${command}\n`, returncode: 0, exception_info: "" };
  }
  get_template_vars(): Record<string, unknown> {
    return {};
  }
  serialize(): Record<string, unknown> {
    return {};
  }
}

function agent(
  lines: string[],
  outputs: Message[],
  data: Record<string, unknown> = {},
) {
  const env = new ScriptEnv();
  const interactive = new InteractiveAgent(new ScriptModel(outputs), env, {
    system_template: "sys",
    instance_template: "task",
    ...data,
  });
  const pending = [...lines];
  interactive.readLine = async () => pending.shift() ?? "";
  interactive.stdinIsInteractive = () => data.interactive !== false;
  return { interactive, env };
}

const bash = (command: string, cost = 0.1): Message => ({
  role: "assistant",
  content: command,
  extra: { actions: [{ command }], cost },
});

describe("InteractiveAgent", () => {
  test("asks before executing and can reject without running the command", async () => {
    const confirmed = agent(
      ["", ""],
      [bash("echo ok"), bash("COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT")],
    );
    const result = await confirmed.interactive.run("t");
    expect(confirmed.env.commands).toEqual([
      "echo ok",
      "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT",
    ]);
    expect(result).toMatchObject({ exit_status: "Submitted" });

    const rejected = agent(
      ["do not", ""],
      [
        bash("rm -rf /"),
        bash("echo ok"),
        bash("COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"),
      ],
    );
    await rejected.interactive.run("t");
    expect(rejected.env.commands).toEqual([
      "echo ok",
      "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT",
    ]);
    expect(
      rejected.interactive.messages.some((message) =>
        String(message.content).includes("do not"),
      ),
    ).toBe(true);
    expect(
      rejected.interactive.messages.some((message) =>
        String(message.content).includes("action was not executed"),
      ),
    ).toBe(true);
  });

  test("skips confirmation for yolo mode and prefix whitelist entries", async () => {
    const yolo = agent(
      [""],
      [bash("echo yolo"), bash("COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT")],
      { mode: "yolo" },
    );
    await yolo.interactive.run("t");
    expect(yolo.env.commands[0]).toBe("echo yolo");

    const allowed = agent(
      ["", ""],
      [
        bash("echo allowed"),
        bash("rm secret"),
        bash("COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"),
      ],
      { whitelist_actions: ["echo"] },
    );
    await allowed.interactive.run("t");
    expect(allowed.env.commands).toEqual([
      "echo allowed",
      "rm secret",
      "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT",
    ]);
  });

  test("executes a human command and switches modes with slash commands", async () => {
    const human = agent(
      ["echo from-user", "/y"],
      [bash("echo model"), bash("COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT")],
      { mode: "human" },
    );
    await human.interactive.run("t");
    expect(human.env.commands[0]).toBe("echo from-user");
    expect(
      human.interactive.messages.some(
        (message) => message.role === "assistant",
      ),
    ).toBe(true);
  });

  test("stops on limits when stdin is not a terminal and continues a new task", async () => {
    const stopped = agent([], [bash("echo", 3)], {
      cost_limit: 1,
      interactive: false,
    });
    const result = await stopped.interactive.run("t");
    expect(result).toMatchObject({ exit_status: "LimitsExceeded" });

    const continued = agent(
      ["", "keep going", "", ""],
      [
        bash("COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"),
        bash("echo next"),
        bash("COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"),
      ],
    );
    const continuedResult = await continued.interactive.run("t");
    expect(continued.env.commands).toContain("echo next");
    expect(continuedResult).toMatchObject({ exit_status: "Submitted" });
  });

  test("turns a keyboard interrupt into a user message instead of an error exit", async () => {
    const model = new ScriptModel([
      bash("echo after"),
      bash("COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"),
    ]);
    const original = model.query.bind(model);
    let calls = 0;
    model.query = () => {
      calls += 1;
      if (calls === 1) throw new KeyboardInterrupt();
      return original();
    };
    const env = new ScriptEnv();
    const interactive = new InteractiveAgent(model, env, {
      system_template: "sys",
      instance_template: "task",
      mode: "yolo",
    });
    interactive.readLine = async () => (calls === 1 ? "hold on" : "");
    await interactive.run("t");
    expect(
      interactive.messages.some((message) =>
        String(message.content).includes("Interrupted by user: hold on"),
      ),
    ).toBe(true);
    expect(
      interactive.messages.some(
        (message) => message.extra?.exit_status === "KeyboardInterrupt",
      ),
    ).toBe(false);
    expect(env.commands).toContain("echo after");
  });
});
