import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export { DefaultAgent } from "./agents/default.ts";
export { InteractiveAgent } from "./agents/interactive.ts";
export { getAgent } from "./agents/index.ts";
export { LocalEnvironment } from "./environments/local.ts";
export { DockerEnvironment } from "./environments/docker.ts";
export { getEnvironment } from "./environments/index.ts";
export {
  FormatError,
  InterruptAgentFlow,
  KeyboardInterrupt,
  LimitsExceeded,
  RuntimeError,
  Submitted,
  TimeExceeded,
  UserInterruption,
} from "./exceptions.ts";
export { LitellmModel } from "./models/litellm-model.ts";
export { LitellmTextbasedModel } from "./models/litellm-textbased-model.ts";
export { getModel } from "./models/index.ts";
export type {
  Action,
  Agent,
  Environment,
  ExecutionOutput,
  Message,
  Model,
} from "./protocols.ts";
export { __version__ } from "./version.ts";
export { main } from "./run/mini.ts";

import { main } from "./run/mini.ts";

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
}
