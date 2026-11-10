#!/usr/bin/env bun
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createTuiController, demoDriver, type TuiController } from "./tui.ts";
import { noColorEnabled, themeDefinition } from "./tui-theme.ts";

const USAGE = `Usage: bun run tui [options]

Open a terminal chat for the coding agent in the current workspace.

Options:
  --help                 Show this help
  --demo                 Run the same UI without credentials, tools, or saved history
  --model <name>         Model to use
  --output <path>        Latest task trajectory, default .lean/last-tui-run.traj.json

Each task starts fresh model context. The screen history is kept in memory only.
Use --model or MSWEA_MODEL_NAME and provider API-key environment variables.
Saved chat sessions, subscription login, and SDK tracing are not supported.
Cancellation waits for the active request or command before stopping later actions.
`;

type ParsedArgs = {
  help: boolean;
  demo: boolean;
  model?: string;
  output?: string;
};

function parseArgv(argv: readonly string[]): ParsedArgs {
  let values: {
    help?: boolean;
    demo?: boolean;
    model?: string;
    provider?: string;
    session?: string;
    output?: string;
    trace?: boolean;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean" },
        demo: { type: "boolean" },
        model: { type: "string" },
        provider: { type: "string" },
        session: { type: "string" },
        output: { type: "string" },
        trace: { type: "boolean" },
      },
      strict: true,
      allowPositionals: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message, { cause: error });
  }
  if (values.help) return { help: true, demo: false };
  if (positionals.length > 0) {
    throw new Error(
      "The TUI does not take a message. Start it, then type at the prompt.",
    );
  }
  if (
    values.provider !== undefined &&
    values.provider !== "openai" &&
    values.provider !== "anthropic"
  ) {
    throw new Error(
      `Unknown provider "${values.provider}". Expected openai or anthropic.`,
    );
  }
  if (
    values.demo &&
    (values.provider !== undefined ||
      values.session !== undefined ||
      values.output !== undefined ||
      values.trace === true)
  ) {
    throw new Error(
      "--demo does not use --provider, --session, --output, or --trace.",
    );
  }
  if (values.session !== undefined) {
    throw new Error(
      "Saved chat sessions are not supported by the new loop. Existing session files are left unchanged. Use --output to save a native task trajectory, not resumable chat history.",
    );
  }
  if (values.provider !== undefined) {
    throw new Error(
      "Subscription login is not supported by the new loop. Use --model openai/<name> or anthropic/<name> and OPENAI_API_KEY or ANTHROPIC_API_KEY. Saved subscription credentials are not read.",
    );
  }
  if (values.trace) {
    throw new Error(
      "SDK tracing is not supported by the new loop. Use --output to save a native task trajectory.",
    );
  }
  return {
    help: false,
    demo: values.demo === true,
    model: values.model,
    output: values.output,
  };
}

function redactStartup(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  let redacted = message;
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    const key = process.env[name];
    if (key) redacted = redacted.split(key).join("[redacted]");
  }
  return redacted;
}

async function runScreen(
  controller: TuiController,
  noColor: boolean,
): Promise<void> {
  const { createNodeApp } = await import("@rezi-ui/node");
  const app = createNodeApp({
    initialState: controller.state,
    theme: themeDefinition(controller.state.theme, noColor),
    config: { screen: { mode: "inline", inlineRows: 1024 } },
  });
  app.view(() => controller.render());
  const bind = (name: string) => ({
    when: (ctx: { focusedId: string | null }) =>
      controller.consumes(name, ctx.focusedId),
    handler: (ctx: { focusedId: string | null }) => {
      try {
        controller.key(name, ctx.focusedId);
      } catch (error) {
        process.stderr.write(`${redactStartup(error)}\n`);
      }
    },
  });
  app.keys({
    "ctrl+c": () => controller.key("ctrl+c"),
    escape: () => controller.key("escape"),
    pageup: () => controller.key("pageup"),
    pagedown: () => controller.key("pagedown"),
    q: {
      when: (ctx) => ctx.focusedId !== "prompt",
      handler: () => controller.key("q", null),
    },
    enter: bind("enter"),
    tab: bind("tab"),
    up: bind("up"),
    down: bind("down"),
    left: bind("left"),
    right: bind("right"),
    "ctrl+d": bind("ctrl+d"),
    "ctrl+o": bind("ctrl+o"),
    y: bind("y"),
    n: bind("n"),
  });
  app.onEvent((event) => {
    if (event.kind === "engine" && event.event.kind === "resize") {
      controller.resize(event.event.cols, event.event.rows);
    }
  });
  const onSignal = () => {
    setTimeout(() => {
      void controller.shutdown();
    }, 0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let failure: unknown;
  try {
    await app.start();
    controller.connect({
      update: (next) => app.update(next),
      setTheme: (theme) => app.setTheme(themeDefinition(theme, noColor)),
    });
    await controller.done;
  } catch (error) {
    failure = error;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await controller.shutdown().catch(() => undefined);
    try {
      await app.stop();
    } finally {
      app.dispose();
    }
  }
  if (failure) throw failure;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgv(argv);
  } catch (error) {
    process.stderr.write(`${redactStartup(error)}\n`);
    return 1;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("The TUI needs a terminal.\n");
    return 1;
  }
  const cwd = process.cwd();
  const noColor = noColorEnabled(process.env);
  if (args.demo) {
    const controller = await createTuiController({
      noColor,
      driver: demoDriver(),
      cwd,
      model: args.model ?? "demo",
      modelLabel: args.model ?? "demo",
      providerLabel: "demo",
      sessionLabel: "demo (not saved)",
      demo: true,
      resolveModel: async (name) => {
        if (!/^[\w.:-]+$/.test(name))
          throw new Error(`Unknown model "${name}".`);
        return name;
      },
    });
    try {
      await runScreen(controller, noColor);
      return 0;
    } catch (error) {
      process.stderr.write(`${redactStartup(error)}\n`);
      return 1;
    }
  }

  try {
    const [
      { getConfigFromSpec, builtinConfigDir },
      { LocalEnvironment },
      { getModel, getModelName },
      { createTuiSession },
    ] = await Promise.all([
      import("../config/index.ts"),
      import("../environments/local.ts"),
      import("../models/index.ts"),
      import("./tui-agent.ts"),
    ]);
    const config = getConfigFromSpec(
      resolve(builtinConfigDir, "mini.yaml"),
    ) as {
      agent: Record<string, unknown>;
      model: Record<string, unknown>;
      environment: Record<string, unknown>;
    };
    const modelLabel = getModelName(args.model, config.model);
    const output = resolve(cwd, args.output ?? ".lean/last-tui-run.traj.json");
    const session = createTuiSession({
      environment: new LocalEnvironment({ ...config.environment, cwd }),
      agentConfig: config.agent,
      output,
    });
    const controller = await createTuiController({
      noColor,
      cwd,
      model: getModel(modelLabel, config.model),
      modelLabel,
      providerLabel: "API key (model-selected)",
      sessionLabel: `memory only; latest task trajectory: ${output}`,
      demo: false,
      boundary:
        "Each task starts fresh model context. Screen history is memory-only; the latest task replaces the saved trajectory. Responses appear after each model call. Cancellation waits for the active request or command; no later action executes. /clear hides the screen, not the trajectory. Subscription login and SDK tracing are unavailable.",
      history: session.history,
      driver: session.driver,
      redact: redactStartup,
      resolveModel: async (name) => getModel(name, config.model),
    });
    await runScreen(controller, noColor);
    return 0;
  } catch (error) {
    process.stderr.write(`${redactStartup(error)}\n`);
    return 1;
  }
}

if (Reflect.get(import.meta, "main") === true) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${redactStartup(error)}\n`);
      process.exit(1);
    });
}
