import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { getAgent } from "../agents/index.ts";
import { readInteractive, readSetup } from "../agents/prompt.ts";
import { globalConfigDir } from "../utils/global-config-dir.ts";
import { pythonFloat } from "../config/fields.ts";
import { builtinConfigDir, getConfigFromSpec } from "../config/index.ts";
import { getEnvironment } from "../environments/index.ts";
import { KeyboardInterrupt } from "../exceptions.ts";
import { getModel } from "../models/index.ts";
import { UNSET, recursive_merge } from "../utils/serialize.ts";

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function redact(text: string): string {
  let result = text;
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    const value = process.env[key];
    if (value) result = result.split(value).join("[redacted]");
  }
  return result;
}

async function setup(): Promise<void> {
  const file = join(globalConfigDir(), ".env");
  process.stdout.write("Enter your default model (leave blank to skip): ");
  const model = (await readSetup("")).trim();
  if (model) {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `MSWEA_MODEL_NAME=${model}\n`);
    process.env.MSWEA_MODEL_NAME ??= model;
  }
  process.stdout.write("Enter your API key name (leave blank to skip): ");
  const keyName = (await readSetup("")).trim();
  if (keyName) {
    process.stdout.write("Enter your API key value (leave blank to skip): ");
    const key = (await readSetup("")).trim();
    if (key) {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${keyName}=${key}\n`);
      process.env[keyName] ??= key;
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, "MSWEA_CONFIGURED=true\n");
  process.env.MSWEA_CONFIGURED = "true";
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  loadEnvFile(join(globalConfigDir(), ".env"));
  let values: {
    help?: boolean;
    model?: string;
    "model-class"?: string;
    "agent-class"?: string;
    "environment-class"?: string;
    task?: string;
    yolo?: boolean;
    "cost-limit"?: string;
    config?: string[];
    output?: string;
    "exit-immediately"?: boolean;
  };
  try {
    values = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean" },
        model: { type: "string", short: "m" },
        "model-class": { type: "string" },
        "agent-class": { type: "string" },
        "environment-class": { type: "string" },
        task: { type: "string", short: "t" },
        yolo: { type: "boolean", short: "y" },
        "cost-limit": { type: "string", short: "l" },
        config: { type: "string", short: "c", multiple: true },
        output: { type: "string", short: "o" },
        "exit-immediately": { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    process.stderr.write(
      `${redact(error instanceof Error ? error.message : String(error))}\n`,
    );
    return 1;
  }
  if (values.help) {
    process.stdout.write(
      "Usage: lean [-m model] [-t task] [-y] [-l cost] [-c spec] [-o output] [--exit-immediately]\n",
    );
    return 0;
  }
  if (!process.env.MSWEA_CONFIGURED && process.stdin.isTTY) await setup();
  try {
    const specs = values.config ?? [
      process.env.MSWEA_MINI_CONFIG_PATH ?? join(builtinConfigDir, "mini.yaml"),
    ];
    const output =
      values.output ?? join(globalConfigDir(), "last_mini_run.traj.json");
    const config = recursive_merge(
      ...specs.map((spec) => {
        const data = getConfigFromSpec(spec);
        if (data === null) return null;
        if (typeof data !== "object" || Array.isArray(data))
          throw new TypeError("Config file must contain a dictionary");
        return data as Record<string, unknown>;
      }),
      {
        run: { task: values.task ?? UNSET },
        agent: {
          agent_class: values["agent-class"] ?? UNSET,
          mode: values.yolo ? "yolo" : UNSET,
          cost_limit:
            values["cost-limit"] !== undefined
              ? pythonFloat(values["cost-limit"])
              : UNSET,
          confirm_exit: values["exit-immediately"] ? false : UNSET,
          output_path: output,
        },
        model: {
          model_class: values["model-class"] ?? UNSET,
          model_name: values.model ?? UNSET,
        },
        environment: {
          environment_class: values["environment-class"] ?? UNSET,
        },
      },
    );
    const run = config.run as Record<string, unknown> | undefined;
    let task = run?.task;
    if (task === UNSET || task === undefined) {
      process.stdout.write("What do you want to do?\n");
      task = await readInteractive("multiline");
    }
    const modelConfig =
      (config.model as Record<string, unknown> | undefined) ?? {};
    const environmentConfig =
      (config.environment as Record<string, unknown> | undefined) ?? {};
    const agentConfig =
      (config.agent as Record<string, unknown> | undefined) ?? {};
    const model = getModel(null, modelConfig);
    const env = getEnvironment(environmentConfig, "local");
    const agent = getAgent(model, env, agentConfig, "interactive");
    await Promise.resolve(agent.run(String(task)));
    const saved = agentConfig.output_path;
    if (typeof saved === "string" && saved)
      process.stdout.write(`Saved trajectory to '${saved}'\n`);
    return 0;
  } catch (error) {
    if (error instanceof KeyboardInterrupt) return 130;
    process.stderr.write(
      `${redact(error instanceof Error ? error.message : String(error))}\n`,
    );
    return 1;
  }
}
