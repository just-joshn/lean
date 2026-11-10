import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { hostname, machine, release, type, version } from "node:os";
import type { Action, ExecutionOutput } from "../protocols.ts";
import { recursive_merge } from "../utils/serialize.ts";
import { checkSubmitted } from "./submit.ts";
import {
  calledProcessError,
  commandExitCode,
  decodeOutput,
  pythonStrip,
  strictText,
  timeoutExpiredError,
} from "./command-text.ts";

import {
  ConfigModel,
  constructConfig,
  type ConfigFactory,
  type Field,
  stringField,
  dictField,
  listField,
  intField,
} from "../config/fields.ts";
import { componentIdentity } from "../utils/load.ts";
import { platformProcessor } from "./processor.ts";

export class DockerEnvironmentConfig extends ConfigModel {
  static override fields: Record<string, Field> = {
    image: stringField(),
    cwd: stringField("/"),
    env: dictField(true),
    forward_env: listField([]),
    timeout: intField(30),
    executable: stringField(process.env.MSWEA_DOCKER_EXECUTABLE ?? "docker"),
    run_args: listField(["--rm"]),
    container_timeout: stringField("2h"),
    pull_timeout: intField(120),
    interpreter: listField(["bash", "-lc"]),
  };
  declare image: string;
  declare cwd: string;
  declare env: Record<string, string>;
  declare forward_env: string[];
  declare timeout: number;
  declare executable: string;
  declare run_args: string[];
  declare container_timeout: string;
  declare pull_timeout: number;
  declare interpreter: string[];
}

async function run(
  args: string[],
  timeout: number,
): Promise<{ stdout: string; stderr: string; returncode: number }> {
  const collector = spawn("/bin/cat", [], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const chunks: Buffer[] = [];
  collector.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const child = spawn(args[0] ?? "", args.slice(1), {
    stdio: ["ignore", collector.stdin, collector.stdin],
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeout * 1000);
  try {
    const returncode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (status, signal) =>
        resolve(commandExitCode(status, signal)),
      );
    });
    collector.stdin?.end();
    await new Promise((resolve) => collector.once("close", resolve));
    const out = decodeOutput(Buffer.concat(chunks), !timedOut);
    if (timedOut) {
      const error = new Error(
        `Command '${args.join(" ")}' timed out after ${timeout} seconds`,
      );
      error.name = "TimeoutExpired";
      throw Object.assign(error, { output: out });
    }
    return { stdout: out, stderr: "", returncode };
  } finally {
    clearTimeout(timer);
  }
}

const finalizers = new FinalizationRegistry<{
  executable: string;
  containerId: string;
}>((held) => {
  const command = `(timeout 60 ${held.executable} stop ${held.containerId} || ${held.executable} rm -f ${held.containerId}) >/dev/null 2>&1 &`;
  const child = spawn("/bin/sh", ["-c", command], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
});

export class DockerEnvironment {
  readonly config: DockerEnvironmentConfig;
  static typeName = "minisweagent.environments.docker.DockerEnvironment";
  container_id: string | null = null;

  constructor(
    data: Record<string, unknown> = {},
    configClass?: ConfigFactory<DockerEnvironmentConfig>,
  ) {
    this.config = constructConfig(
      data,
      configClass,
      DockerEnvironmentConfig,
      "minisweagent.environments.docker.DockerEnvironment",
    );
    const name = `minisweagent-${randomBytes(4).toString("hex")}`;
    const args = [
      this.config.executable,
      "run",
      "-d",
      "--name",
      name,
      "-w",
      this.config.cwd,
      ...this.config.run_args,
      this.config.image,
      "sleep",
      this.config.container_timeout,
    ];
    const result = spawnSync(args[0] ?? "", args.slice(1), {
      timeout: this.config.pull_timeout * 1000,
    });
    if (result.error) {
      if ("code" in result.error && result.error.code === "ETIMEDOUT") {
        throw timeoutExpiredError(
          args,
          this.config.pull_timeout,
          result.stdout ?? Buffer.alloc(0),
          result.stderr ?? Buffer.alloc(0),
        );
      }
      throw result.error;
    }
    const stdout = strictText(result.stdout);
    const stderr = strictText(result.stderr);
    const status = commandExitCode(result.status, result.signal);
    if (status !== 0) throw calledProcessError(args, status, stdout, stderr);
    this.container_id = pythonStrip(stdout);
    finalizers.register(
      this,
      { executable: this.config.executable, containerId: this.container_id },
      this,
    );
  }

  async execute(
    action: Action,
    cwd = "",
    timeout: number | null = null,
  ): Promise<ExecutionOutput> {
    const command = String(action.command ?? "");
    const directory = cwd || this.config.cwd;
    const args = [this.config.executable, "exec", "-w", directory];
    for (const key of this.config.forward_env) {
      const value = process.env[key];
      if (value !== undefined) args.push("-e", `${key}=${value}`);
    }
    for (const [key, value] of Object.entries(this.config.env))
      args.push("-e", `${key}=${value}`);
    args.push(this.container_id ?? "", ...this.config.interpreter, command);
    let output: ExecutionOutput;
    try {
      const result = await run(args, timeout || this.config.timeout);
      output = {
        output: result.stdout + result.stderr,
        returncode: result.returncode,
        exception_info: "",
      };
    } catch (error) {
      const partial =
        typeof error === "object" &&
        error !== null &&
        "output" in error &&
        typeof error.output === "string"
          ? error.output
          : "";
      const message = error instanceof Error ? error.message : String(error);
      output = {
        output: partial,
        returncode: -1,
        exception_info: `An error occurred while executing the command: ${message}`,
        extra: {
          exception_type: error instanceof Error ? error.name : "Error",
          exception: message,
        },
      };
    }
    checkSubmitted(output);
    return output;
  }

  cleanup(): void {
    if (this.container_id === null) return;
    const containerId = this.container_id;
    const executable = this.config.executable;
    const command = `(timeout 60 ${executable} stop ${containerId} || ${executable} rm -f ${containerId}) >/dev/null 2>&1 &`;
    const child = spawn("/bin/sh", ["-c", command], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
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
