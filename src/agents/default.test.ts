import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  FormatError,
  KeyboardInterrupt,
  LimitsExceeded,
  Submitted,
} from "../exceptions.ts";
import type {
  Action,
  Environment,
  ExecutionOutput,
  Message,
  Model,
} from "../protocols.ts";
import { DefaultAgent } from "./default.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function json(value: unknown): Message {
  return value as Message;
}

class ScriptModel implements Model {
  config = { model_dump: () => ({ model_name: "script" }) };
  outputs: Message[];
  seen: Message[][] = [];
  constructor(outputs: Message[]) {
    this.outputs = outputs;
  }
  query(messages: Message[]): Message {
    this.seen.push(messages.map((message) => ({ ...message })));
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
    return actions.map((action, index) => ({
      role: action.tool_call_id ? "tool" : "user",
      tool_call_id: action.tool_call_id,
      content: outputs[index]?.output ?? "action was not executed",
    }));
  }
  get_template_vars(): Record<string, unknown> {
    return { model_name: "script" };
  }
  serialize(): Record<string, unknown> {
    return { info: { config: { model_type: "script" } } };
  }
}

class ScriptEnv implements Environment {
  config = { model_dump: () => ({ cwd: "" }) };
  commands: string[] = [];
  failAt: number | null = null;
  submittedAt: string | null;
  constructor(submittedAt: string | null = null) {
    this.submittedAt = submittedAt;
  }
  execute(action: Action): ExecutionOutput {
    const command = String(action.command);
    this.commands.push(command);
    if (this.failAt !== null && this.commands.length === this.failAt)
      throw new Error("disk full");
    if (command === this.submittedAt) {
      throw new Submitted({
        role: "exit",
        content: "done",
        extra: { exit_status: "Submitted", submission: "done" },
      });
    }
    return { output: `${command}\n`, returncode: 0, exception_info: "" };
  }
  get_template_vars(): Record<string, unknown> {
    return { cwd: "/work" };
  }
  serialize(): Record<string, unknown> {
    return { info: { config: { environment_type: "script" } } };
  }
}

const templates = {
  system_template: "sys {{task}}",
  instance_template: "task {{task}}",
};

describe("DefaultAgent", () => {
  test("runs ordered actions until submit and saves the trajectory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lean-agent-"));
    directories.push(directory);
    const output = join(directory, "out.traj.json");
    const model = new ScriptModel([
      json({
        role: "assistant",
        content: "two",
        tool_calls: [{ id: "1" }, { id: "2" }],
        extra: {
          actions: [
            { command: "echo one", tool_call_id: "1" },
            { command: "echo two", tool_call_id: "2" },
          ],
          cost: 0.2,
        },
      }),
      json({
        role: "assistant",
        content: "submit",
        extra: {
          actions: [{ command: "submit", tool_call_id: "3" }],
          cost: 0.2,
        },
      }),
    ]);
    const env = new ScriptEnv("submit");
    const agent = new DefaultAgent(model, env, {
      ...templates,
      output_path: output,
      cost_limit: 1,
    });
    const result = await agent.run("fix it");
    expect(result).toMatchObject({
      exit_status: "Submitted",
      submission: "done",
    });
    expect(env.commands).toEqual(["echo one", "echo two", "submit"]);
    expect(agent.n_calls).toBe(2);
    expect(agent.cost).toBeCloseTo(0.4);
    expect(agent.messages[0]).toMatchObject({
      role: "system",
      content: "sys fix it",
    });
    const saved = JSON.parse(await readFile(output, "utf8")) as {
      trajectory_format: string;
      info: { mini_version: string };
    };
    expect(saved.trajectory_format).toBe("mini-swe-agent-1.1");
    expect(saved.info.mini_version).toBe("2.4.6");
  });

  test("bills three consecutive format errors and then stops", async () => {
    const model = new ScriptModel([
      json({
        role: "assistant",
        extra: { actions: [{ command: "ok" }], cost: 0.1 },
      }),
    ]);
    const original = model.query.bind(model);
    let failures = 0;
    model.query = (messages) => {
      failures += 1;
      if (failures < 4) {
        throw new FormatError({
          role: "user",
          content: `bad ${failures}`,
          extra: { interrupt_type: "FormatError", cost: 0.25 },
        });
      }
      return original(messages);
    };
    const agent = new DefaultAgent(model, new ScriptEnv(), templates);
    const result = await agent.run("t");
    expect(result).toMatchObject({ exit_status: "RepeatedFormatError" });
    expect(agent.cost).toBeCloseTo(0.75);
    expect(agent.n_calls).toBe(3);
    expect(
      agent.messages.filter((message) => message.role === "exit"),
    ).toHaveLength(1);
  });

  test("blocks the next call when step or cost is already at the limit", async () => {
    const model = new ScriptModel([
      json({
        role: "assistant",
        extra: { actions: [{ command: "echo" }], cost: 1 },
      }),
    ]);
    const agent = new DefaultAgent(model, new ScriptEnv(), {
      ...templates,
      cost_limit: 1,
      step_limit: 2,
    });
    await agent.run("t");
    expect(agent.cost).toBe(1);
    const again = new ScriptModel([]);
    const limited = new DefaultAgent(again, new ScriptEnv(), {
      ...templates,
      step_limit: 0,
      cost_limit: 1,
    });
    limited.cost = 1;
    const result = await limited.run("t");
    expect(result).toMatchObject({ exit_status: "LimitsExceeded" });
    expect(again.seen).toHaveLength(0);
  });

  test("does not save when rendering fails before the loop, and records an uncaught error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lean-render-"));
    directories.push(directory);
    const output = join(directory, "missing.traj.json");
    const agent = new DefaultAgent(new ScriptModel([]), new ScriptEnv(), {
      system_template: "{{ missing }}",
      instance_template: "x",
      output_path: output,
    });
    await expect(agent.run("t")).rejects.toThrow(/missing/);
    await expect(readFile(output, "utf8")).rejects.toThrow(/ENOENT/);
    const broken = new ScriptEnv();
    broken.failAt = 1;
    const running = new DefaultAgent(
      new ScriptModel([
        json({
          role: "assistant",
          extra: { actions: [{ command: "boom" }], cost: 0.1 },
        }),
      ]),
      broken,
      { ...templates, output_path: output },
    );
    await expect(running.run("t")).rejects.toThrow(/disk full/);
    const saved = JSON.parse(await readFile(output, "utf8")) as {
      messages: Message[];
    };
    expect(saved.messages.at(-1)?.extra?.exit_status).toBe("Error");
  });

  test("lets keyboard interrupt leave the loop without an exit message", async () => {
    const model = new ScriptModel([]);
    model.query = () => {
      throw new KeyboardInterrupt();
    };
    const agent = new DefaultAgent(model, new ScriptEnv(), templates);
    await expect(agent.run("t")).rejects.toBeInstanceOf(KeyboardInterrupt);
    expect(agent.messages.some((message) => message.role === "exit")).toBe(
      false,
    );
  });

  test("reuses run without clearing cost and abandons a batch when submit interrupts it", async () => {
    const model = new ScriptModel([
      json({
        role: "assistant",
        extra: {
          actions: [{ command: "first" }, { command: "submit" }],
          cost: 0.2,
        },
      }),
      json({
        role: "assistant",
        extra: { actions: [{ command: "submit" }], cost: 0.2 },
      }),
    ]);
    const env = new ScriptEnv("submit");
    const agent = new DefaultAgent(model, env, { ...templates, cost_limit: 3 });
    await agent.run("one");
    expect(env.commands).toEqual(["first", "submit"]);
    expect(
      agent.messages.some((message) => message.content === "first\n"),
    ).toBe(false);
    await agent.run("two");
    expect(agent.messages[0]?.content).toBe("sys two");
    expect(agent.cost).toBeCloseTo(0.4);
    expect(agent.n_calls).toBe(2);
  });
});

test("stops on integer elapsed wall time without calling the model", async () => {
  class AgedAgent extends DefaultAgent {
    constructor(model: Model, env: Environment) {
      super(model, env, { ...templates, wall_time_limit_seconds: 1 });
      this.started = Date.now() / 1000 - 5;
    }
  }
  const model = new ScriptModel([]);
  const agent = new AgedAgent(model, new ScriptEnv());
  const result = await agent.run("t");
  expect(result).toMatchObject({ exit_status: "TimeExceeded" });
  expect(model.seen).toHaveLength(0);
});

void LimitsExceeded;
