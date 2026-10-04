import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  configureRole,
  discoverAgent,
  parseClaudeDiscovery,
  parseCodexDiscovery,
  parseSetupArgs,
  runSetup,
  writeConfigAtomic,
} from "../skills/orca-review-loop/scripts/setup.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "skills/orca-review-loop/scripts/orca-review-loop.mjs");

class FakePrompt {
  constructor({ text = [], choices = [], confirmed = true } = {}) {
    this.textAnswers = [...text];
    this.choiceAnswers = [...choices];
    this.confirmations = Array.isArray(confirmed) ? [...confirmed] : [confirmed];
    this.notes = [];
    this.offers = [];
  }

  note(message = "") { this.notes.push(message); }

  async text(_label, defaultValue = "") {
    return this.textAnswers.length ? this.textAnswers.shift() : defaultValue;
  }

  async choose(label, choices, defaultValue) {
    this.offers.push({ label, choices, defaultValue });
    if (!this.choiceAnswers.length) return defaultValue;
    const answer = this.choiceAnswers.shift();
    if (answer === "$manual") return choices.find((choice) => choice.label.startsWith("enter a ")).value;
    return answer;
  }

  async confirm(label) {
    this.notes.push(`CONFIRM: ${label}`);
    return this.confirmations.length > 1 ? this.confirmations.shift() : this.confirmations[0];
  }
}

const discovery = (agent) => agent === "claude"
  ? { adapter: true, available: true, models: [{ id: "sonnet", efforts: ["low", "high"] }], defaultEfforts: ["low", "high"] }
  : { adapter: true, available: true, models: [{ id: "gpt-test", efforts: ["medium", "xhigh"] }], defaultEfforts: [] };

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "orca-loop-setup-"));
}

test("Claude discovery parses live choices without treating prose as a model", () => {
  const result = parseClaudeDiscovery(
    { result: "Current model: Fable\nAvailable: sonnet, opus, best, opusplan, default, or a full model ID." },
    { result: "Usage: /effort <low|medium|high|xhigh|max|auto|ultracode [on|off]>" },
  );
  assert.deepEqual(result.models.map((model) => model.id), ["sonnet", "opus"]);
  assert.deepEqual(result.defaultEfforts, ["low", "medium", "high", "xhigh", "max"]);
});

test("Codex discovery filters hidden models and keeps effort per model", () => {
  const result = parseCodexDiscovery({ models: [
    { slug: "visible", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
    { slug: "secret", visibility: "hide", supported_reasoning_levels: [{ effort: "medium" }] },
  ] });
  assert.deepEqual(result.models, [{ id: "visible", efforts: ["low", "high"] }]);
});

test("discovery reports a missing CLI as an unavailable catalogue", () => {
  const result = discoverAgent("claude", { spawn: () => ({ status: null, stdout: "", stderr: "", error: { code: "ENOENT" } }) });
  assert.equal(result.available, false);
  assert.equal(result.adapter, true);
  assert.match(result.reason, /not installed/);
});

test("unknown agents have no discovery adapter", () => {
  const result = discoverAgent("custom-agent");
  assert.equal(result.available, false);
  assert.equal(result.adapter, false);
  assert.match(result.reason, /no model discovery adapter/);
});

test("Claude probes run in one isolated temporary directory and clean it up", () => {
  const temporaryRoot = freshRoot();
  const calls = [];
  const spawn = (binary, args, options) => {
    calls.push({ binary, args, cwd: options.cwd });
    const result = args.includes("/model")
      ? "Available: sonnet, best, default, or a full model ID."
      : "Usage: /effort <low|high|auto|ultracode [on|off]>";
    return { status: 0, stdout: JSON.stringify({ is_error: false, result }), stderr: "" };
  };
  const result = discoverAgent("claude", { spawn, temporaryRoot });
  assert.equal(result.available, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].cwd, calls[1].cwd);
  assert.match(calls[0].cwd, /orca-review-loop-discovery-/);
  assert.equal(existsSync(calls[0].cwd), false);
});

test("changing an agent resets the old agent's model default", async () => {
  const prompt = new FakePrompt({ text: ["codex"] });
  const result = await configureRole("implement", { agent: "claude", model: "opus", effort: "high" }, prompt, discovery);
  assert.deepEqual(result, { agent: "codex", model: null, effort: null });
  assert.doesNotMatch(prompt.offers[0].choices.map((choice) => choice.label).join("\n"), /opus \(current\)/);
});

test("changing agent does not retain effort for an identically named model", async () => {
  const prompt = new FakePrompt({ text: ["codex"], choices: ["shared-model"] });
  const result = await configureRole("implement", { agent: "claude", model: "shared-model", effort: "high" }, prompt,
    () => ({ adapter: true, available: true, models: [{ id: "shared-model", efforts: ["low"] }], defaultEfforts: [] }));
  assert.deepEqual(result, { agent: "codex", model: "shared-model", effort: null });
  assert.doesNotMatch(prompt.offers[1].choices.map((choice) => choice.label).join("\n"), /high \(current\)/);
});

test("an unrecognized agent requires confirmation and can be corrected", async () => {
  const prompt = new FakePrompt({ text: ["codxe", "codex"], confirmed: [false, true] });
  const result = await configureRole("review", { agent: "codex", model: null, effort: null }, prompt,
    (agent) => agent === "codex" ? discovery(agent) : {
      adapter: false, available: false, reason: "no adapter", models: [], defaultEfforts: [],
    });
  assert.deepEqual(result, { agent: "codex", model: null, effort: null });
  assert.ok(prompt.notes.some((note) => note.includes("cannot be validated")));
});

test("manual opaque model and effort values remain available", async () => {
  const prompt = new FakePrompt({
    text: ["claude", "future-model", "future-effort"],
    choices: ["$manual", "$manual"],
  });
  const result = await configureRole("implement", { agent: "claude", model: null, effort: null }, prompt,
    () => ({ adapter: true, available: false, reason: "probe failed", models: [], defaultEfforts: [] }));
  assert.deepEqual(result, { agent: "claude", model: "future-model", effort: "future-effort" });
});

test("empty manual model and effort entries are re-prompted", async () => {
  const prompt = new FakePrompt({
    text: ["claude", "", "future-model", "", "future-effort"],
    choices: ["$manual", "$manual"],
  });
  const result = await configureRole("implement", { agent: "claude", model: null, effort: null }, prompt,
    () => ({ adapter: true, available: false, reason: "probe failed", models: [], defaultEfforts: [] }));
  assert.deepEqual(result, { agent: "claude", model: "future-model", effort: "future-effort" });
  assert.equal(prompt.notes.filter((note) => note.includes("must not be empty")).length, 2);
});

test("fresh setup writes minimal role configuration using agent defaults", async () => {
  const root = freshRoot();
  const prompt = new FakePrompt();
  const result = await runSetup({ root, prompt, discoveryFn: discovery });
  assert.equal(result.configured, true);
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".orca-loop.json"), "utf8")), {
    implement: { agent: "claude", model: null, effort: null },
    review: { agent: "codex", model: null, effort: null },
  });
});

test("setup probes the same selected agent only once", async () => {
  const root = freshRoot();
  let calls = 0;
  const prompt = new FakePrompt({ text: ["claude", "claude"] });
  await runSetup({
    root,
    prompt,
    discoveryFn: (agent) => {
      calls += 1;
      return discovery(agent);
    },
  });
  assert.equal(calls, 1);
});

test("setup writes explicit model pins and preserves unrelated settings", async () => {
  const root = freshRoot();
  writeFileSync(join(root, ".orca-loop.json"), `${JSON.stringify({
    mode: "spec", maxRounds: 7, retainTerminals: true, implement: { futureOption: true },
  })}\n`);
  const prompt = new FakePrompt({ choices: ["sonnet", "high", "gpt-test", "xhigh"] });
  await runSetup({ root, prompt, discoveryFn: discovery });
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".orca-loop.json"), "utf8")), {
    mode: "spec",
    maxRounds: 7,
    retainTerminals: true,
    implement: { futureOption: true, agent: "claude", model: "sonnet", effort: "high" },
    review: { agent: "codex", model: "gpt-test", effort: "xhigh" },
  });
});

test("cancelling setup leaves an existing config byte-for-byte unchanged", async () => {
  const root = freshRoot();
  const path = join(root, ".orca-loop.json");
  const before = '{"maxRounds":4}\n';
  writeFileSync(path, before);
  const result = await runSetup({ root, prompt: new FakePrompt({ confirmed: false }), discoveryFn: discovery });
  assert.equal(result.cancelled, true);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("atomic config replacement preserves file mode and adds a trailing newline", () => {
  const root = freshRoot();
  const path = join(root, ".orca-loop.json");
  writeFileSync(path, "{}\n", { mode: 0o640 });
  chmodSync(path, 0o640);
  writeConfigAtomic(path, { implement: { agent: "claude", model: null, effort: null } });
  assert.match(readFileSync(path, "utf8"), /\n$/);
  assert.equal(statSync(path).mode & 0o777, 0o640);
});

test("setup refuses a symlink config destination", async () => {
  const root = freshRoot();
  const target = join(root, "actual.json");
  writeFileSync(target, "{}\n");
  symlinkSync(target, join(root, ".orca-loop.json"));
  await assert.rejects(() => runSetup({ root, prompt: new FakePrompt(), discoveryFn: discovery }), /must not be a symbolic link/);
  assert.equal(readFileSync(target, "utf8"), "{}\n");
});

test("setup argument parser accepts only config and help", () => {
  assert.deepEqual(parseSetupArgs(["--config", "config.json"]), { config: "config.json" });
  assert.throws(() => parseSetupArgs(["--task", "x"]), /unknown setup argument/);
});

test("setup help works without a TTY and documents the command", () => {
  const root = freshRoot();
  const result = spawnSync(process.execPath, [CLI, "setup", "--help"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ORCA_LOOP_ROOT: root },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /orca-review-loop setup/);
});

test("setup fails clearly instead of hanging without a TTY", () => {
  const root = freshRoot();
  const result = spawnSync(process.execPath, [CLI, "setup"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ORCA_LOOP_ROOT: root },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RESULT PROTOCOL_ERROR: setup requires an interactive terminal/);
});
