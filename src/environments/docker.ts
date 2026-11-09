import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { hostname, machine, release, type, version } from "node:os";
import type { Action, ExecutionOutput } from "../protocols.ts";
import { recursive_merge } from "../utils/serialize.ts";
import { checkSubmitted } from "./submit.ts";

export class DockerEnvironmentConfig {
  image = "";
  cwd = "/";
  env: Record<string, string> = {};
  forward_env: string[] = [];
  timeout = 30;
  executable = process.env.MSWEA_DOCKER_EXECUTABLE || "docker";
  run_args = ["--rm"];
  container_timeout = "2h";
  pull_timeout = 120;
  interpreter = ["bash", "-lc"];

  constructor(data: Record<string, unknown> = {}) {
    if (typeof data.image !== "string" || data.image === "") {
      throw new Error("DockerEnvironment requires image.");
    }
    this.image = data.image;
    if (typeof data.cwd === "string") this.cwd = data.cwd;
    if (data.env && typeof data.env === "object")
      this.env = { ...(data.env as Record<string, string>) };
    if (Array.isArray(data.forward_env))
      this.forward_env = data.forward_env.map(String);
    if (data.timeout !== undefined) this.timeout = Number(data.timeout);
    if (typeof data.executable === "string") this.executable = data.executable;
    if (Array.isArray(data.run_args)) this.run_args = data.run_args.map(String);
    if (typeof data.container_timeout === "string")
      this.container_timeout = data.container_timeout;
    if (data.pull_timeout !== undefined)
      this.pull_timeout = Number(data.pull_timeout);
    if (Array.isArray(data.interpreter))
      this.interpreter = data.interpreter.map(String);
  }

  model_dump(): Record<string, unknown> {
    return {
      image: this.image,
      cwd: this.cwd,
      env: this.env,
      forward_env: this.forward_env,
      timeout: this.timeout,
      executable: this.executable,
      run_args: this.run_args,
      container_timeout: this.container_timeout,
      pull_timeout: this.pull_timeout,
      interpreter: this.interpreter,
    };
  }
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
      child.once("exit", (status) => resolve(status ?? 1));
    });
    collector.stdin?.end();
    await new Promise((resolve) => collector.once("close", resolve));
    const out = Buffer.concat(chunks).toString("utf8");
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
  readonly type_name = "minisweagent.environments.docker.DockerEnvironment";
  container_id: string | null = null;
  private cleaned = false;

  constructor(
    data: Record<string, unknown> = {},
    configClass: typeof DockerEnvironmentConfig = DockerEnvironmentConfig,
  ) {
    this.config = new configClass(data);
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
      encoding: "utf8",
      timeout: this.config.pull_timeout * 1000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        result.stderr ||
          result.stdout ||
          `docker run failed with ${result.status}`,
      );
    }
    this.container_id = result.stdout.trim();
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
    if (this.cleaned || !this.container_id) return;
    this.cleaned = true;
    const containerId = this.container_id;
    const executable = this.config.executable;
    finalizers.unregister(this);
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
      },
      extra,
    );
  }

  serialize(): Record<string, unknown> {
    return {
      info: {
        config: {
          environment: this.config.model_dump(),
          environment_type: this.type_name,
        },
      },
    };
  }
}
