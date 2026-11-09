#!/usr/bin/env bun
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { themePresets } from "@rezi-ui/core";
import { createTuiController, demoDriver, type TuiController } from "./tui.ts";

const USAGE = `Usage: bun run tui [options]

Open a terminal chat for the coding agent in the current workspace.

Options:
  --help                 Show this help
  --demo                 Run the same UI without credentials, tools, or saved history
  --model <name>         Model to use
  --session <path>       Session file, default .lean/history.json
  --trace                Enable metadata-only tracing
  --provider <provider>  Use a saved openai or anthropic subscription
`;

type ParsedArgs = {
  help: boolean;
  demo: boolean;
  model?: string;
  provider?: string;
  session?: string;
  trace: boolean;
};

function parseArgv(argv: readonly string[]): ParsedArgs {
  let values: {
    help?: boolean;
    demo?: boolean;
    model?: string;
    provider?: string;
    session?: string;
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
  if (values.help) return { help: true, demo: false, trace: false };
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
      values.trace === true)
  ) {
    throw new Error("--demo does not use --provider, --session, or --trace.");
  }
  return {
    help: false,
    demo: values.demo === true,
    model: values.model,
    provider: values.provider,
    session: values.session,
    trace: values.trace === true,
  };
}

function redactStartup(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const key = process.env.OPENAI_API_KEY;
  return key ? message.split(key).join("[redacted]") : message;
}

async function runScreen(controller: TuiController): Promise<void> {
  const { createNodeApp } = await import("@rezi-ui/node");
  const app = createNodeApp({
    initialState: controller.state,
    theme: themePresets[controller.state.theme],
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
      controller.resize(event.event.cols);
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
      setTheme: (theme) => app.setTheme(themePresets[theme]),
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
  if (args.demo) {
    const controller = await createTuiController({
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
      await runScreen(controller);
      return 0;
    } catch (error) {
      process.stderr.write(`${redactStartup(error)}\n`);
      return 1;
    }
  }

  const [{ runTurn }, { openSession }, { createSubscriptions }] =
    await Promise.all([
      import("../agent.ts"),
      import("../session.ts"),
      import("./auth.ts"),
    ]);
  const subscriptions = createSubscriptions();
  let opened: Awaited<ReturnType<typeof openSession>> | undefined;
  try {
    const model = await subscriptions.resolveModel({
      provider: args.provider,
      model: args.model,
    });
    const modelLabel =
      typeof model === "string" ? model : (args.model ?? "subscription");
    opened = await openSession({
      file: resolve(cwd, args.session ?? ".lean/history.json"),
      cwd,
    });
    const session = opened;
    const controller = await createTuiController({
      cwd,
      model,
      modelLabel,
      providerLabel: args.provider ?? "default",
      sessionLabel: args.session ?? ".lean/history.json",
      demo: false,
      trace: args.trace,
      history: {
        getItems: () => session.session.getItems(),
        restore: async (items) => {
          const snapshot = structuredClone(items) as Parameters<
            typeof session.session.addItems
          >[0];
          await session.session.clearSession();
          if (snapshot.length > 0) await session.session.addItems(snapshot);
        },
        save: () => session.save(),
        close: () => session.close(),
      },
      redact: subscriptions.redact,
      resolveModel: (name) =>
        subscriptions.resolveModel({ provider: args.provider, model: name }),
      driver: async (input) => {
        await runTurn({
          cwd,
          input: input.text,
          session: session.session,
          signal: input.signal,
          model: input.model,
          trace: args.trace,
          onText: input.onText,
          approve: input.approve,
        });
      },
    });
    await runScreen(controller);
    return 0;
  } catch (error) {
    process.stderr.write(`${subscriptions.redact(error)}\n`);
    return 1;
  } finally {
    try {
      await opened?.close();
    } finally {
      await subscriptions.close();
      if (args.trace) {
        const { getGlobalTraceProvider } = await import("@openai/agents");
        await getGlobalTraceProvider().forceFlush();
      }
    }
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
