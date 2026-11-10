import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import controls from "./boundary-source-controls.json" with { type: "json" };

const source = fileURLToPath(new URL("../", import.meta.url));

test("captures omitted defaults without validating them as explicit values", () => {
  const directory = mkdtempSync(join(tmpdir(), "lean-config-defaults-"));
  try {
    for (const name of ["home", "tmp", "config", "cache"])
      mkdirSync(join(directory, name));
    const entry = join(directory, "entry.mts");
    writeFileSync(
      entry,
      `
      import { LitellmModelConfig } from ${JSON.stringify(join(source, "models/litellm-model.ts"))};
      import { DockerEnvironmentConfig } from ${JSON.stringify(join(source, "environments/docker.ts"))};
      process.env.MSWEA_COST_TRACKING = "ignore_errors";
      process.env.MSWEA_DOCKER_EXECUTABLE = "changed";
      const omitted = new LitellmModelConfig({ model_name: "m" }).model_dump();
      let explicit;
      try { new LitellmModelConfig({ model_name: "m", cost_tracking: "bogus" }); }
      catch (error) { explicit = { error_type: error.constructor.name, message: error.message, details: error.details }; }
      console.log(JSON.stringify({ omitted, explicit, executable: new DockerEnvironmentConfig({ image: "" }).executable }));
    `,
    );
    const output = execFileSync(process.execPath, [entry], {
      cwd: directory,
      env: {
        HOME: join(directory, "home"),
        TMPDIR: join(directory, "tmp"),
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_CACHE_HOME: join(directory, "cache"),
        MSWEA_GLOBAL_CONFIG_DIR: join(directory, "config"),
        MSWEA_SILENT_STARTUP: "1",
        MSWEA_COST_TRACKING: "bogus",
        MSWEA_DOCKER_EXECUTABLE: "",
      },
      encoding: "utf8",
      timeout: 10000,
    });
    const result = JSON.parse(output);
    expect(result.omitted).toEqual(controls.captured_default[0]!.value);
    const expected = controls.captured_default[1]!;
    expect(result.explicit).toEqual({
      error_type: expected.error_type,
      message: expected.message,
      details: expected.details,
    });
    expect(result.executable).toBe("");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
