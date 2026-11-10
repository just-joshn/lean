import { execFileSync } from "node:child_process";

export function platformProcessor(): string {
  try {
    const value = execFileSync("uname", ["-p"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value === "unknown" ? "" : value;
  } catch {
    return "";
  }
}
