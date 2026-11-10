import { spawn } from "node:child_process";
import { hostname, machine, release, type, version } from "node:os";
import type { Action, ExecutionOutput } from "../protocols.ts";
import { KeyboardInterrupt } from "../exceptions.ts";
import { recursive_merge } from "../utils/serialize.ts";
import { checkSubmitted } from "./submit.ts";
import { commandExitCode, decodeOutput } from "./command-text.ts";

import {
  ConfigModel,
  constructConfig,
  type ConfigFactory,
  type Field,
  stringField,
  dictField,
  intField,
} from "../config/fields.ts";
import { componentIdentity } from "../utils/load.ts";
import { platformProcessor } from "./processor.ts";

export class LocalEnvironmentConfig extends ConfigModel {
  static override fields: Record<string, Field> = {
    cwd: stringField(""),
    env: dictField(true),
    timeout: intField(30),
  };
  declare cwd: string;
  declare env: Record<string, string>;
  declare timeout: number;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function executionError(error: unknown, output: string): ExecutionOutput {
  const name = error instanceof Error ? error.name : "Error";
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return {
    output,
    returncode: -1,
    exception_info: `An error occurred while executing the command: ${message}`,
    extra: {
      exception_type: code === "ENOENT" ? "FileNotFoundError" : name,
      exception: message,
    },
  };
}

export async function runShell(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeout: number,
): Promise<{ stdout: string; returncode: number }> {
  const chunks: Buffer[] = [];
  const collector = spawn("/bin/cat", [], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const child = spawn("/bin/sh", ["-c", command], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", collector.stdin, collector.stdin],
  });
  collector.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const output = () => decodeOutput(Buffer.concat(chunks));
  let timedOut = false;
  let interrupted = false;
  const killGroup = () => {
    if (child.pid === undefined) {
      child.kill("SIGKILL");
      return;
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, timeout * 1000);
  const onSigint = () => {
    interrupted = true;
    killGroup();
  };
  process.once("SIGINT", onSigint);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (status, signal) =>
        resolve(commandExitCode(status, signal)),
      );
    });
    collector.stdin?.end();
    await new Promise((resolve) => collector.once("close", resolve));
    if (interrupted) throw new KeyboardInterrupt();
    if (timedOut) {
      const error = new Error(
        `Command '${command}' timed out after ${timeout} seconds`,
      );
      error.name = "TimeoutExpired";
      throw Object.assign(error, { output: output() });
    }
    return { stdout: output(), returncode: code };
  } catch (error) {
    collector.stdin?.end();
    if (interrupted) throw new KeyboardInterrupt();
    throw error;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", onSigint);
  }
}

export class LocalEnvironment {
  readonly config: LocalEnvironmentConfig;
  static typeName = "minisweagent.environments.local.LocalEnvironment";

  constructor(
    data: Record<string, unknown> = {},
    configClass?: ConfigFactory<LocalEnvironmentConfig>,
  ) {
    this.config = constructConfig(
      data,
      configClass,
      LocalEnvironmentConfig,
      "minisweagent.environments.local.LocalEnvironment",
    );
  }

  async execute(
    action: Action,
    cwd = "",
    timeout: number | null = null,
  ): Promise<ExecutionOutput> {
    const command = String(action.command ?? "");
    const directory = cwd || this.config.cwd || process.cwd();
    const limit = timeout || this.config.timeout;
    let output: ExecutionOutput;
    try {
      const result = await runShell(
        command,
        directory,
        { ...stringEnv(process.env), ...this.config.env },
        limit,
      );
      output = {
        output: result.stdout,
        returncode: result.returncode,
        exception_info: "",
      };
    } catch (error) {
      if (error instanceof KeyboardInterrupt) throw error;
      const partial =
        typeof error === "object" &&
        error !== null &&
        "output" in error &&
        typeof error.output === "string"
          ? error.output
          : "";
      output = executionError(error, partial);
    }
    checkSubmitted(output);
    return output;
  }

  get_template_vars(
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return recursive_merge(
      this.config.model_dump(),
      {
        system: type(),
        node: hostname(),
        release: release(),
        version: version(),
        machine: machine(),
        processor: platformProcessor(),
      },
      stringEnv(process.env),
      extra,
    );
  }

  serialize(): Record<string, unknown> {
    return {
      info: {
        config: {
          environment: this.config.model_dump("json"),
          environment_type: componentIdentity(this),
        },
      },
    };
  }
}
