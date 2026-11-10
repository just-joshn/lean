import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  Agent,
  Environment,
  ExecutionOutput,
  Message,
  Model,
} from "../protocols.ts";
import {
  FormatError,
  InterruptAgentFlow,
  KeyboardInterrupt,
  LimitsExceeded,
  TimeExceeded,
} from "../exceptions.ts";
import { __version__ } from "../version.ts";
import { pythonJson } from "../utils/json.ts";
import { renderStrict } from "../utils/render.ts";
import { recursive_merge } from "../utils/serialize.ts";

import {
  ConfigModel,
  constructConfig,
  type ConfigFactory,
  type Field,
  stringField,
  intField,
  floatField,
  pathField,
  PosixPath,
} from "../config/fields.ts";
import { componentIdentity } from "../utils/load.ts";

export class AgentConfig extends ConfigModel {
  static override fields: Record<string, Field> = {
    system_template: stringField(),
    instance_template: stringField(),
    step_limit: intField(0),
    cost_limit: floatField(3),
    wall_time_limit_seconds: intField(0),
    max_consecutive_format_errors: intField(3),
    output_path: pathField(),
  };
  declare system_template: string;
  declare instance_template: string;
  declare step_limit: number;
  declare cost_limit: number;
  declare wall_time_limit_seconds: number;
  declare max_consecutive_format_errors: number;
  declare output_path: PosixPath | null;
}

async function settled<T>(value: T | Promise<T>): Promise<T> {
  return await value;
}

export class DefaultAgent implements Agent {
  readonly config: AgentConfig;
  static typeName = "minisweagent.agents.default.DefaultAgent";
  messages: Message[] = [];
  model: Model;
  env: Environment;
  extra_template_vars: Record<string, unknown> = {};
  cost = 0;
  n_calls = 0;
  n_consecutive_format_errors = 0;
  protected started = Date.now() / 1000;

  constructor(
    model: Model,
    env: Environment,
    data: Record<string, unknown> = {},
    configClass?: ConfigFactory<AgentConfig>,
  ) {
    this.model = model;
    this.env = env;
    this.config = constructConfig(
      data,
      configClass,
      AgentConfig,
      "minisweagent.agents.default.DefaultAgent",
    );
  }

  async get_template_vars(
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    return recursive_merge(
      this.config.model_dump(),
      await settled(this.env.get_template_vars()),
      await settled(this.model.get_template_vars()),
      {
        n_model_calls: this.n_calls,
        model_cost: this.cost,
        elapsed_seconds: Math.trunc(Date.now() / 1000 - this.started),
      },
      this.extra_template_vars,
      extra,
    );
  }

  protected async render(template: string): Promise<string> {
    return renderStrict(template, await this.get_template_vars());
  }

  add_messages(...messages: Message[]): Message[] {
    this.messages.push(...messages);
    return [...messages];
  }

  async handle_uncaught_exception(error: unknown): Promise<Message[]> {
    const text = error instanceof Error ? error.message : String(error);
    return this.add_messages(
      await settled(
        this.model.format_message({
          role: "exit",
          content: text,
          extra: {
            exit_status: error instanceof Error ? error.name : "Error",
            submission: "",
            exception_str: text,
            traceback: error instanceof Error ? (error.stack ?? "") : "",
          },
        }),
      ),
    );
  }

  async run(
    task = "",
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    this.extra_template_vars = { ...this.extra_template_vars, task, ...extra };
    this.messages = [];
    this.add_messages(
      await settled(
        this.model.format_message({
          role: "system",
          content: await this.render(this.config.system_template),
        }),
      ),
      await settled(
        this.model.format_message({
          role: "user",
          content: await this.render(this.config.instance_template),
        }),
      ),
    );
    while (true) {
      try {
        await this.step();
        this.n_consecutive_format_errors = 0;
      } catch (error) {
        if (error instanceof KeyboardInterrupt) throw error;
        if (error instanceof FormatError) {
          this.cost += Number(error.messages[0]?.extra?.cost ?? 0);
          this.n_consecutive_format_errors += 1;
          if (
            this.config.max_consecutive_format_errors > 0 &&
            this.n_consecutive_format_errors >=
              this.config.max_consecutive_format_errors
          ) {
            this.add_messages(...error.messages, {
              role: "exit",
              content: "RepeatedFormatError",
              extra: { exit_status: "RepeatedFormatError", submission: "" },
            });
          } else {
            this.add_messages(...error.messages);
          }
        } else if (error instanceof InterruptAgentFlow) {
          this.add_messages(...error.messages);
        } else {
          await this.handle_uncaught_exception(error);
          throw error;
        }
      } finally {
        await this.save(this.config.output_path);
      }
      if (this.messages.at(-1)?.role === "exit") break;
    }
    return this.messages.at(-1)?.extra ?? {};
  }

  async step(): Promise<Message[]> {
    return this.execute_actions(await this.query());
  }

  async query(): Promise<Message> {
    if (
      (this.config.step_limit > 0 && this.n_calls >= this.config.step_limit) ||
      (this.config.cost_limit > 0 && this.cost >= this.config.cost_limit)
    ) {
      throw new LimitsExceeded({
        role: "exit",
        content: "LimitsExceeded",
        extra: { exit_status: "LimitsExceeded", submission: "" },
      });
    }
    if (
      this.config.wall_time_limit_seconds > 0 &&
      Math.trunc(Date.now() / 1000 - this.started) >=
        this.config.wall_time_limit_seconds
    ) {
      throw new TimeExceeded({
        role: "exit",
        content: "TimeExceeded",
        extra: { exit_status: "TimeExceeded", submission: "" },
      });
    }
    this.n_calls += 1;
    const message = await settled(this.model.query(this.messages));
    this.cost += Number(message.extra?.cost ?? 0);
    this.add_messages(message);
    return message;
  }

  async execute_actions(message: Message): Promise<Message[]> {
    const actions = Array.isArray(message.extra?.actions)
      ? message.extra.actions
      : [];
    const outputs: ExecutionOutput[] = [];
    for (const action of actions) {
      outputs.push(await settled(this.env.execute(action)));
    }
    const observations = await settled(
      this.model.format_observation_messages(
        message,
        outputs,
        await this.get_template_vars(),
      ),
    );
    return this.add_messages(...observations);
  }

  async serialize(
    ...extra: Array<Record<string, unknown> | null | undefined>
  ): Promise<Record<string, unknown>> {
    const last = this.messages.at(-1);
    const lastExtra = last?.extra ?? {};
    const agentData = {
      info: {
        model_stats: { instance_cost: this.cost, api_calls: this.n_calls },
        config: {
          agent: this.config.model_dump("json"),
          agent_type: componentIdentity(this),
        },
        mini_version: __version__,
        exit_status: lastExtra.exit_status ?? "",
        submission: lastExtra.submission ?? "",
      },
      messages: this.messages,
      trajectory_format: "mini-swe-agent-1.1",
    };
    return recursive_merge(
      agentData,
      await settled(this.model.serialize()),
      await settled(this.env.serialize()),
      ...extra,
    );
  }

  async save(
    path: string | PosixPath | null,
    ...extra: Array<Record<string, unknown> | null | undefined>
  ): Promise<Record<string, unknown>> {
    const data = await this.serialize(...extra);
    if (path) {
      await mkdir(dirname(String(path)), { recursive: true });
      await writeFile(String(path), pythonJson(data));
    }
    return data;
  }
}
