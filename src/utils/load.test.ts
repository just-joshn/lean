import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import controls from "../config/loading-source-controls.json" with { type: "json" };

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const source = fileURLToPath(new URL("../", import.meta.url));

test("loads native subclasses through actual public factories without a prepass", () => {
  const directory = mkdtempSync(join(tmpdir(), "lean-loader-"));
  directories.push(directory);
  for (const name of ["home", "tmp", "config", "cache"])
    mkdirSync(join(directory, name));
  const fixture = join(directory, "custom.mts");
  writeFileSync(
    fixture,
    `
    import { LitellmModel, LitellmModelConfig } from ${JSON.stringify(join(source, "models/litellm-model.ts"))};
    import { LocalEnvironment } from ${JSON.stringify(join(source, "environments/local.ts"))};
    import { DefaultAgent } from ${JSON.stringify(join(source, "agents/default.ts"))};
    import { stringField } from ${JSON.stringify(join(source, "config/fields.ts"))};
    export class ReviewConfig extends LitellmModelConfig {
      static fields = { reviewer: stringField("ada") };
      declare reviewer: string;
      constructor(data = {}) { super(data); this.reviewer = this.reviewer.trim(); }
    }
    export class CustomModel extends LitellmModel {
      get_template_vars() { return { custom: true, ...super.get_template_vars() }; }
    }
    export default CustomModel;
    export class CustomEnvironment extends LocalEnvironment {}
    export class CustomAgent extends DefaultAgent {}
  `,
  );
  writeFileSync(
    join(directory, "async.mts"),
    "await Promise.resolve(); export class AsyncModule {}\n",
  );
  writeFileSync(
    join(directory, "deferred.mts"),
    "await new Promise(resolve => setTimeout(resolve, 1)); export class DeferredModule {}\n",
  );
  const entry = join(directory, "entry.mts");
  writeFileSync(
    entry,
    `
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    import { getModel, getModelClass, getModelName } from ${JSON.stringify(join(source, "models/index.ts"))};
    import { getAgent, getAgentClass } from ${JSON.stringify(join(source, "agents/index.ts"))};
    import { getEnvironment, getEnvironmentClass } from ${JSON.stringify(join(source, "environments/index.ts"))};
    import { LitellmModel } from ${JSON.stringify(join(source, "models/litellm-model.ts"))};
    import { DefaultAgent } from ${JSON.stringify(join(source, "agents/default.ts"))};
    import { LocalEnvironment } from ${JSON.stringify(join(source, "environments/local.ts"))};
    const spec = ${JSON.stringify(`import:${fixture}`)};
    const cold = getModel("m", { model_class: spec });
    const require = createRequire(import.meta.url);
    const fixture = require(${JSON.stringify(fixture)});
    assert.equal(cold.constructor, fixture.CustomModel);
    assert.equal(getModelClass("m", spec), fixture.CustomModel);
    assert.equal(getModelClass("m", spec + "#CustomModel"), fixture.CustomModel);
    assert.equal(getModelClass("m", "litellm"), LitellmModel);
    assert.equal(getModelClass("m", LitellmModel.typeName), LitellmModel);
    assert.equal(getAgentClass("default"), DefaultAgent);
    assert.equal(getAgentClass(DefaultAgent.typeName), DefaultAgent);
    assert.equal(getEnvironmentClass("local"), LocalEnvironment);
    assert.equal(getEnvironmentClass(LocalEnvironment.typeName), LocalEnvironment);
    const nested = { retained: true };
    const config = { model_class: spec, config_class: fixture.ReviewConfig, reviewer: " bob ", model_kwargs: { nested } };
    const model = getModel("m", config);
    assert.equal(model.get_template_vars().custom, true);
    assert.equal(model.config.model_dump().reviewer, "bob");
    assert.notEqual(model.config.model_kwargs.nested, nested);
    assert.equal(config.model_class, spec);
    assert.equal(model.serialize().info.config.model_type, spec);
    const env = getEnvironment({ environment_class: spec + "#CustomEnvironment" }, "local");
    const agent = getAgent(model, env, { agent_class: spec + "#CustomAgent", system_template: "s", instance_template: "i" }, "default");
    assert.equal(env.constructor, fixture.CustomEnvironment);
    assert.equal(agent.constructor, fixture.CustomAgent);
    const serialized = await agent.serialize();
    assert.equal(serialized.info.config.agent_type, spec + "#CustomAgent");
    assert.equal(serialized.info.config.environment_type, spec + "#CustomEnvironment");
    process.env.MSWEA_MODEL_NAME = "env-model";
    assert.equal(getModelName("input", { model_name: "config" }), "input");
    assert.equal(getModelName(null, { model_name: "config" }), "config");
    assert.equal(getModelName(null, {}), "env-model");
    assert.equal(getModelName(null, null), "env-model");
    assert.equal(getModel("m", null).config.model_name, "m");
    delete process.env.MSWEA_MODEL_NAME;
    const missingModel = ${JSON.stringify({ name: controls.missing_model_control.error_type, message: controls.missing_model_control.message })};
    assert.throws(() => getModelName(null, {}), missingModel);
    assert.throws(() => getModelName(null, null), missingModel);
    assert.equal(getModel("claude", { model_class: spec }).config.set_cache_control, "default_end");
    assert.equal(getModel("claude", { model_class: spec, set_cache_control: null }).config.set_cache_control, null);
    assert.equal(getModel("m", { model_class: spec }).config.set_cache_control, null);
    assert.throws(() => getModelClass("m", "bad"), { name: "ValueError", message: /Unknown model class/ });
    assert.throws(() => getAgentClass("bad"), { name: "ValueError", message: /Unknown agent type/ });
    assert.throws(() => getEnvironmentClass("bad"), { name: "ValueError", message: /Unknown environment type/ });
    assert.throws(() => getModelClass("m", "import:/nonexistent/owned-lean-module.mts"), /Cannot find module/);
    assert.throws(() => getModelClass("m", spec + "#Absent"), /no callable export/);
    for (const name of ["async", "deferred"]) {
      const native = ${JSON.stringify(`import:${directory}/`)} + name + ".mts#" + (name === "async" ? "AsyncModule" : "DeferredModule");
      if (process.versions.bun && name === "async") assert.equal(typeof getModelClass("m", native), "function");
      else assert.throws(() => getModelClass("m", native), error => process.versions.bun ? error instanceof TypeError && /async module/.test(error.message) : error.code === "ERR_REQUIRE_ASYNC_MODULE");
    }
    console.log(JSON.stringify({ ok: true, runtime: process.versions.bun ? "bun" : "node" }));
  `,
  );
  const env = {
    HOME: join(directory, "home"),
    TMPDIR: join(directory, "tmp"),
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_CACHE_HOME: join(directory, "cache"),
    MSWEA_GLOBAL_CONFIG_DIR: join(directory, "config"),
    MSWEA_SILENT_STARTUP: "1",
  };
  const output = execFileSync(process.execPath, [entry], {
    cwd: directory,
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  expect(JSON.parse(output)).toEqual({
    ok: true,
    runtime: process.versions.bun ? "bun" : "node",
  });
});
