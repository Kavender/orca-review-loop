import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGENT_CATALOGUE,
  applySetArguments,
  buildAgentCatalogue,
  configureRole,
  discoverAgent,
  parseOrcaAgentIds,
  TerminalPrompter,
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
    if (answer === "$manual") return choices.find((choice) => choice.label === "Type something.").value;
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

const DEFAULT = "__orca_loop_default__";

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
  const prompt = new FakePrompt({ choices: ["codex"] });
  const result = await configureRole("implement", { agent: "claude", model: "opus", effort: "high" }, prompt, discovery);
  assert.deepEqual(result, { agent: "codex", model: null, effort: null });
  assert.doesNotMatch(prompt.offers[1].choices.map((choice) => choice.label).join("\n"), /opus \(current\)/);
});

test("changing agent does not retain effort for an identically named model", async () => {
  const prompt = new FakePrompt({ choices: ["codex", "shared-model"] });
  const result = await configureRole("implement", { agent: "claude", model: "shared-model", effort: "high" }, prompt,
    () => ({ adapter: true, available: true, models: [{ id: "shared-model", efforts: ["low"] }], defaultEfforts: [] }));
  assert.deepEqual(result, { agent: "codex", model: "shared-model", effort: null });
  assert.doesNotMatch(prompt.offers[2].choices.map((choice) => choice.label).join("\n"), /high \(current\)/);
});

test("an unrecognized agent requires confirmation and can be corrected", async () => {
  const prompt = new FakePrompt({ choices: ["$manual", "codex"], text: ["codxe"], confirmed: [false, true] });
  const result = await configureRole("review", { agent: "codex", model: null, effort: null }, prompt, discovery);
  assert.deepEqual(result, { agent: "codex", model: null, effort: null });
  assert.ok(prompt.notes.some((note) => note.includes("cannot be validated")));
});

test("an unknown agent id is accepted after confirmation", async () => {
  const prompt = new FakePrompt({ choices: ["$manual"], text: ["kiro"], confirmed: true });
  const result = await configureRole("review", { agent: "codex", model: null, effort: null }, prompt,
    (agent) => (agent === "kiro" ? discoverAgent(agent) : discovery(agent)));
  assert.deepEqual(result, { agent: "kiro", model: null, effort: null });
  assert.ok(prompt.notes.some((note) => note.includes("No live model discovery")));
});

test("agents that run on their own model config skip model and effort", async () => {
  const prompt = new FakePrompt({ choices: ["opencode"] });
  const result = await configureRole("implement", { agent: "claude", model: "opus", effort: "high" }, prompt, discovery);
  assert.deepEqual(result, { agent: "opencode", model: null, effort: null });
  assert.equal(prompt.offers.length, 1);
  assert.ok(prompt.notes.some((note) => note.includes("does not accept --model")));
});

test("choosing the default model explains that effort follows it", async () => {
  const prompt = new FakePrompt();
  await configureRole("implement", { agent: "claude", model: null, effort: null }, prompt, discovery);
  assert.ok(prompt.notes.some((note) => note.includes("thinking effort: default")));
});

test("agent choices list installed agents first and flag missing CLIs", async () => {
  const catalogue = buildAgentCatalogue({ orcaHelp: "", which: (b) => (b === "codex" ? "/bin/codex" : null) });
  const prompt = new FakePrompt();
  await configureRole("implement", { agent: "codex", model: null, effort: null }, prompt, discovery, catalogue);
  const { choices } = prompt.offers[0];
  assert.equal(choices[0].label, "Codex");
  assert.equal(choices[0].description, "codex · current");
  assert.match(choices.find((c) => c.value === "claude").description, /CLI not found on PATH/);
  assert.match(choices.find((c) => c.value === "opencode").description, /uses its own model config/);
});

test("manual opaque model and effort values remain available", async () => {
  const prompt = new FakePrompt({
    text: ["future-model", "future-effort"],
    choices: ["claude", "$manual", "$manual"],
  });
  const result = await configureRole("implement", { agent: "claude", model: null, effort: null }, prompt,
    () => ({ adapter: true, available: false, reason: "probe failed", models: [], defaultEfforts: [] }));
  assert.deepEqual(result, { agent: "claude", model: "future-model", effort: "future-effort" });
});

test("empty manual model and effort entries are re-prompted", async () => {
  const prompt = new FakePrompt({
    text: ["", "future-model", "", "future-effort"],
    choices: ["claude", "$manual", "$manual"],
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
    maxRounds: 5,
    implement: { agent: "claude", model: null, effort: null },
    review: { agent: "codex", model: null, effort: null },
  });
});

test("setup probes the same selected agent only once", async () => {
  const root = freshRoot();
  let calls = 0;
  const prompt = new FakePrompt({ choices: ["claude", DEFAULT, "claude", DEFAULT] });
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
  const prompt = new FakePrompt({ choices: ["claude", "sonnet", "high", "codex", "gpt-test", "xhigh"] });
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

test("setup argument parser accepts config, discover, set, json and help", () => {
  assert.deepEqual(parseSetupArgs(["--config", "config.json"]), { config: "config.json", set: [] });
  assert.deepEqual(parseSetupArgs(["--discover", "--json"]), { discover: true, json: true, set: [] });
  assert.deepEqual(parseSetupArgs(["--set", "a=b", "--set", "c=d"]).set, ["a=b", "c=d"]);
  assert.throws(() => parseSetupArgs(["--task", "x"]), /unknown setup argument/);
  assert.throws(() => parseSetupArgs(["--discover", "--set", "a=b"]), /cannot be combined/);
});

test("Orca agent ids are parsed from worker-start help and merged into the catalogue", () => {
  const help = "--agent takes an Orca agent id enabled on the worker server, such as claude, codex, cursor, antigravity, muse, zcode, opencode, or opencode2.\n--model supports ...";
  assert.deepEqual(parseOrcaAgentIds(help), ["claude", "codex", "cursor", "antigravity", "muse", "zcode", "opencode", "opencode2"]);
  const catalogue = buildAgentCatalogue({ orcaHelp: help.replace("opencode2", "opencode2, or futureagent"), which: () => null });
  const future = catalogue.find((a) => a.id === "futureagent");
  assert.deepEqual(future, { id: "futureagent", label: "futureagent", binaries: ["futureagent"], supportsModel: null, source: "orca", installed: false });
  assert.equal(catalogue.find((a) => a.id === "claude").source, "orca");
  assert.equal(parseOrcaAgentIds("no agent sentence here").length, 0);
  assert.equal(buildAgentCatalogue({ orcaHelp: "", which: () => null }).length, AGENT_CATALOGUE.length);
});

test("setup --discover --json reports agents, discovery and current config", async () => {
  const root = freshRoot();
  const out = [];
  const catalogue = buildAgentCatalogue({ orcaHelp: "", which: (b) => (b === "claude" ? "/bin/claude" : null) });
  const result = await runSetup({ root, argv: ["--discover", "--json"], output: { write: (s) => out.push(s), isTTY: false }, discoveryFn: discovery, catalogue });
  assert.equal(result.discovered, true);
  const report = JSON.parse(out.join(""));
  assert.equal(report.exists, false);
  assert.equal(report.current.maxRounds, 5);
  const claude = report.agents.find((a) => a.id === "claude");
  assert.equal(claude.installed, true);
  assert.deepEqual(claude.discovery.models.map((m) => m.id), ["sonnet"]);
  const codex = report.agents.find((a) => a.id === "codex");
  assert.equal(codex.discovery.available, false);
  assert.match(codex.discovery.reason, /not found on PATH/);
  assert.equal(report.agents.find((a) => a.id === "opencode").supportsModel, false);
});

test("setup --set writes roles and maxRounds without prompting and validates them", async () => {
  const root = freshRoot();
  writeFileSync(join(root, ".orca-loop.json"), JSON.stringify({ retainTerminals: true, implement: { agent: "claude", model: "opus", effort: "high" } }));
  const out = [];
  await runSetup({ root, argv: ["--set", "implement.model=sonnet", "--set", "review.agent=cursor", "--set", "review.model=grok-4", "--set", "maxRounds=3"],
    output: { write: (s) => out.push(s), isTTY: false }, discoveryFn: discovery, catalogue: AGENT_CATALOGUE });
  const written = JSON.parse(readFileSync(join(root, ".orca-loop.json"), "utf8"));
  assert.deepEqual(written, { retainTerminals: true, maxRounds: 3,
    implement: { agent: "claude", model: "sonnet", effort: "high" }, review: { agent: "cursor", model: "grok-4", effort: null } });
  assert.match(out.join(""), /Configured /);
  await assert.rejects(() => runSetup({ root, argv: ["--set", "review.agent=opencode", "--set", "review.model=x"], output: { write() {}, isTTY: false }, discoveryFn: discovery, catalogue: AGENT_CATALOGUE }),
    /does not accept --model/);
  await assert.rejects(() => runSetup({ root, argv: ["--set", "implement.effort=high", "--set", "implement.model=default"], output: { write() {}, isTTY: false }, discoveryFn: discovery, catalogue: AGENT_CATALOGUE }),
    /effort requires implement.model/);
  await assert.rejects(() => runSetup({ root, argv: ["--set", "bogus=1"], output: { write() {}, isTTY: false }, discoveryFn: discovery, catalogue: AGENT_CATALOGUE }), /invalid --set/);
  await assert.rejects(() => runSetup({ root, argv: ["--set", "maxRounds=99"], output: { write() {}, isTTY: false }, discoveryFn: discovery, catalogue: AGENT_CATALOGUE }), /maxRounds must be/);
});

test("--set is order-independent: explicit pins survive an agent change in the same command", () => {
  const current = { maxRounds: 5, implement: { agent: "claude", model: "opus", effort: "high" }, review: { agent: "codex", model: null, effort: null } };
  const forward = applySetArguments(current, ["implement.agent=codex", "implement.model=gpt-5", "implement.effort=max"], AGENT_CATALOGUE);
  const reversed = applySetArguments(current, ["implement.model=gpt-5", "implement.effort=max", "implement.agent=codex"], AGENT_CATALOGUE);
  assert.deepEqual(forward.implement, { agent: "codex", model: "gpt-5", effort: "max" });
  assert.deepEqual(reversed.implement, forward.implement);
});

test("--set rejects a model pin for an own-config agent regardless of order", () => {
  const current = { maxRounds: 5, implement: { agent: "claude", model: null, effort: null }, review: { agent: "codex", model: null, effort: null } };
  for (const order of [["review.model=x", "review.agent=opencode"], ["review.agent=opencode", "review.model=x"]]) {
    assert.throws(() => applySetArguments(current, order, AGENT_CATALOGUE), /does not accept --model or --effort; remove them/);
  }
  // Switching to an own-config agent without pins is fine and clears the old ones.
  const ok = applySetArguments({ ...current, review: { agent: "codex", model: "gpt-5", effort: "high" } }, ["review.agent=opencode"], AGENT_CATALOGUE);
  assert.deepEqual(ok.review, { agent: "opencode", model: null, effort: null });
});

test("--set changing an agent clears that role's model and effort", () => {
  const roles = applySetArguments({ maxRounds: 5, implement: { agent: "claude", model: "opus", effort: "high" }, review: { agent: "codex", model: null, effort: null } },
    ["implement.agent=codex"], AGENT_CATALOGUE);
  assert.deepEqual(roles.implement, { agent: "codex", model: null, effort: null });
});

test("arrow-key selection moves, jumps by digit, confirms with Enter, and cancels with Esc", async () => {
  const { EventEmitter } = await import("node:events");
  const makeInput = () => Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, setRawMode(v) { this.isRaw = v; }, resume() {}, pause() {} });
  const out = [];
  const output = { isTTY: true, write: (s) => out.push(s) };
  const input = makeInput();
  const prompter = new TerminalPrompter(input, output);
  const choices = [{ value: "a", label: "A" }, { value: "b", label: "B" }, { value: "c", label: "C" }];
  const pending = prompter.choose("pick", choices, "a");
  input.emit("data", Buffer.from("\x1b[B"));
  input.emit("data", Buffer.from("\x1b[B"));
  input.emit("data", Buffer.from("\x1b[A"));
  input.emit("data", Buffer.from("\r"));
  assert.equal(await pending, "b");
  assert.equal(input.isRaw, false);
  assert.match(out.join(""), /❯ 2\. B/);
  assert.match(out.join(""), /●.*pick.*→.*B/);
  const second = prompter.choose("pick", choices, "a");
  input.emit("data", Buffer.from("3"));
  input.emit("data", Buffer.from("\n"));
  assert.equal(await second, "c");
  const third = prompter.choose("pick", choices, "a");
  input.emit("data", Buffer.from("\x1b"));
  await assert.rejects(third, /setup cancelled/);
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

test("setup stores max review rounds and re-asks on out-of-range input", async () => {
  const root = freshRoot();
  const prompt = new FakePrompt({ text: ["0", "abc", "3"] });
  await runSetup({ root, prompt, discoveryFn: discovery });
  assert.equal(JSON.parse(readFileSync(join(root, ".orca-loop.json"), "utf8")).maxRounds, 3);
  assert.equal(prompt.notes.filter((n) => n === "Enter a whole number from 1 to 20.").length, 2);
  assert.ok(prompt.notes.includes("  max review rounds: 3"));
});
