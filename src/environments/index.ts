import type { Environment } from "../protocols.ts";
import { copyConfig, loadClass } from "../utils/load.ts";
import { DockerEnvironment } from "./docker.ts";
import { LocalEnvironment } from "./local.ts";

const ENVIRONMENTS: Record<
  string,
  new (data: Record<string, unknown>) => Environment
> = {
  local: LocalEnvironment,
  docker: DockerEnvironment,
};

export function getEnvironmentClass(
  spec: string,
): (typeof ENVIRONMENTS)[string] {
  return loadClass(spec, ENVIRONMENTS, "environment type");
}

export function getEnvironment(
  config: Record<string, unknown> = {},
  defaultType = "",
): Environment {
  const copy = copyConfig(config);
  const spec =
    typeof copy.environment_class === "string"
      ? copy.environment_class
      : defaultType;
  delete copy.environment_class;
  const EnvironmentClass = getEnvironmentClass(spec);
  return new EnvironmentClass(copy);
}
