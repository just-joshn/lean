import { homedir, platform } from "node:os";
import { join } from "node:path";

export function globalConfigDir(): string {
  if (process.env.MSWEA_GLOBAL_CONFIG_DIR)
    return process.env.MSWEA_GLOBAL_CONFIG_DIR;
  const name = "mini-swe-agent";
  if (platform() === "darwin")
    return join(homedir(), "Library", "Application Support", name);
  if (platform() === "win32")
    return join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      name,
    );
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), name);
}
