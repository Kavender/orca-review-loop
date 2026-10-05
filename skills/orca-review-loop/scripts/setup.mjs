import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ConfigError, DEFAULTS, mergeConfig, validateConfig } from "./config.mjs";

const DEFAULT_CHOICE = "__orca_loop_default__";
const MANUAL_CHOICE = "__orca_loop_manual__";
const DISCOVERY_AGENTS = new Set(["claude", "codex"]);
const CLAUDE_MODEL_EXCLUSIONS = new Set(["best", "default", "opusplan", "or a full model id"]);
const CLAUDE_EFFORT_EXCLUSIONS = new Set(["auto", "ultracode"]);

// Orca agent harnesses this tool knows how to describe. The list is a seed, not a restriction:
// ids advertised by the installed Orca CLI are merged in at runtime and any id can be typed.
// `supportsModel` mirrors Orca's rule that only some agents accept --model/--effort at launch.
export const AGENT_CATALOGUE = [
  { id: "claude", label: "Claude Code", binaries: ["claude"], supportsModel: true },
  { id: "codex", label: "Codex", binaries: ["codex"], supportsModel: true },
  { id: "cursor", label: "Cursor Agent CLI", binaries: ["cursor-agent", "agent"], supportsModel: true },
  { id: "antigravity", label: "Antigravity", binaries: ["antigravity"], supportsModel: true },
  { id: "muse", label: "Muse", binaries: ["muse"], supportsModel: true },
  { id: "opencode", label: "OpenCode", binaries: ["opencode"], supportsModel: false },
  { id: "opencode2", label: "OpenCode 2", binaries: ["opencode"], supportsModel: false },
  { id: "zcode", label: "ZCode", binaries: ["zcode"], supportsModel: false },
];

export function parseSetupArgs(argv) {
  const options = { set: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      if (index + 1 >= argv.length) throw new ConfigError(`${arg} requires a value`);
      return argv[++index];
    };
    if (arg === "--config") options.config = take();
    else if (arg === "--discover") options.discover = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--set") options.set.push(take());
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new ConfigError(`unknown setup argument: ${arg}`);
  }
  if (options.discover && options.set.length) throw new ConfigError("--discover and --set cannot be combined");
  return options;
}

export function setupUsage() {
  return "Usage:\n" +
    "  orca-review-loop setup [--config <path>]                 interactive: pick agents, models, effort\n" +
    "  orca-review-loop setup --discover [--json]               print available agents, models, and current config\n" +
    "  orca-review-loop setup --set <role>.<field>=<value> ...  write values without prompting\n\n" +
    "Roles: implement, review. Fields: agent, model, effort. Use the value `default` to clear model or effort. `maxRounds=<1-20>` is also accepted.\n" +
    "Example: orca-review-loop setup --set implement.agent=claude --set implement.model=opus --set implement.effort=high\n";
}

// ---------- agent catalogue ----------

export function parseOrcaAgentIds(helpText) {
  const match = String(helpText ?? "").match(/--agent takes an Orca agent id[^.]*?such as\s+([^.]+)\./i);
  if (!match) return [];
  return unique(match[1].replace(/\bor\b/g, ",").split(","))
    .map((id) => id.toLowerCase())
    .filter((id) => /^[a-z0-9][a-z0-9_-]*$/.test(id));
}

function defaultWhich(binary) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

function orcaWorkerStartHelp(spawn) {
  const result = spawn("orca", ["orchestration", "worker-start", "--help"], { encoding: "utf8", timeout: 10_000, env: process.env });
  if (result.error || result.status !== 0) return "";
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

export function buildAgentCatalogue({ orcaHelp, which = defaultWhich, spawn = spawnSync } = {}) {
  const help = orcaHelp ?? orcaWorkerStartHelp(spawn);
  const advertised = parseOrcaAgentIds(help);
  const entries = AGENT_CATALOGUE.map((entry) => ({
    ...entry,
    source: advertised.includes(entry.id) ? "orca" : "builtin",
    installed: entry.binaries.some((binary) => Boolean(which(binary))),
  }));
  for (const id of advertised) {
    if (entries.some((entry) => entry.id === id)) continue;
    entries.push({ id, label: id, binaries: [id], supportsModel: null, source: "orca", installed: Boolean(which(id)) });
  }
  return entries;
}

export function agentCapability(catalogue, id) {
  return catalogue.find((entry) => entry.id === id) ?? { id, label: id, binaries: [], supportsModel: null, source: "unknown", installed: null };
}

// ---------- model discovery ----------

function parseProbeJson(result, label) {
  if (result.error?.code === "ENOENT") throw new ConfigError(`${label} is not installed or not on PATH`);
  if (result.error?.code === "ETIMEDOUT") throw new ConfigError(`${label} discovery timed out`);
  if (result.error) throw new ConfigError(`${label} discovery failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new ConfigError(`${label} discovery failed: ${detail.slice(0, 300)}`);
  }
  try {
    return JSON.parse(String(result.stdout).trim());
  } catch {
    throw new ConfigError(`${label} discovery returned invalid JSON`);
  }
}

function unique(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

export function parseClaudeDiscovery(modelReceipt, effortReceipt) {
  if (modelReceipt?.is_error) throw new ConfigError("Claude model discovery reported an error");
  if (effortReceipt?.is_error) throw new ConfigError("Claude effort discovery reported an error");
  const modelText = String(modelReceipt?.result ?? "");
  const effortText = String(effortReceipt?.result ?? "");
  const modelMatch = modelText.match(/Available:\s*([^\n]+)/i);
  const effortMatch = effortText.match(/\/effort\s+<([^>]+)>/i);
  if (!modelMatch) throw new ConfigError("Claude model discovery returned no usable models");
  const models = unique(modelMatch[1].replace(/[.]\s*$/, "").split(","))
    .filter((value) => !CLAUDE_MODEL_EXCLUSIONS.has(value.toLowerCase()));
  // Entries with their own argument syntax (for example `ultracode [on|off]`) are
  // slash-command controls, not values that can safely be passed to --effort.
  const effortExpression = effortMatch?.[1].replace(/\|?[^|\s]+\s+\[[^\]]+\].*$/, "") ?? "";
  const efforts = unique(effortExpression.split("|"))
    .filter((value) => !CLAUDE_EFFORT_EXCLUSIONS.has(value.toLowerCase()));
  if (models.length === 0) throw new ConfigError("Claude model discovery returned no usable models");
  return { models: models.map((id) => ({ id, efforts })), defaultEfforts: efforts };
}

export function parseCodexDiscovery(receipt) {
  if (!Array.isArray(receipt?.models)) throw new ConfigError("Codex discovery returned no model list");
  const models = receipt.models
    .filter((model) => model && typeof model.slug === "string" && model.slug.trim() && model.visibility !== "hide")
    .map((model) => ({
      id: model.slug.trim(),
      efforts: unique((model.supported_reasoning_levels ?? []).map((level) => level?.effort)),
    }));
  if (models.length === 0) throw new ConfigError("Codex discovery returned no usable models");
  return { models, defaultEfforts: [] };
}

function probe(spawn, binary, args, timeoutMs, cwd) {
  return spawn(binary, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 << 20,
    env: process.env,
  });
}

export function discoverAgent(agent, { spawn = spawnSync, timeoutMs = 15_000, temporaryRoot = tmpdir() } = {}) {
  if (!DISCOVERY_AGENTS.has(agent)) {
    return { adapter: false, available: false, reason: `no model discovery adapter for agent ${agent}`, models: [], defaultEfforts: [] };
  }
  let discoveryDirectory;
  try {
    discoveryDirectory = mkdtempSync(join(temporaryRoot, "orca-review-loop-discovery-"));
    if (agent === "claude") {
      const models = parseProbeJson(probe(spawn, "claude", ["-p", "/model", "--output-format", "json"], timeoutMs, discoveryDirectory), "Claude");
      const efforts = parseProbeJson(probe(spawn, "claude", ["-p", "/effort", "--output-format", "json"], timeoutMs, discoveryDirectory), "Claude");
      return { adapter: true, available: true, ...parseClaudeDiscovery(models, efforts) };
    }
    const models = parseProbeJson(probe(spawn, "codex", ["debug", "models"], timeoutMs, discoveryDirectory), "Codex");
    return { adapter: true, available: true, ...parseCodexDiscovery(models) };
  } catch (error) {
    return { adapter: true, available: false, reason: error.message, models: [], defaultEfforts: [] };
  } finally {
    if (discoveryDirectory) rmSync(discoveryDirectory, { recursive: true, force: true });
  }
}

// ---------- terminal prompter ----------

const sgr = (code) => (text) => `\x1b[${code}m${text}\x1b[0m`;
const STYLE = { bold: sgr(1), dim: sgr(2), accent: sgr("1;36"), chip: sgr("1;7;36") };
class SetupCancelled extends Error {}
// Ctrl-C arrives as a keypress in raw mode; surface it as an interrupt (exit 130), not a cancel.
export class SetupInterrupted extends Error {}
const KEY = { up: ["\x1b[A", "k"], down: ["\x1b[B", "j"], enter: ["\r", "\n"], cancel: ["\x1b"], interrupt: ["\x03"] };

export class TerminalPrompter {
  constructor(input = process.stdin, output = process.stdout) {
    this.input = input;
    this.output = output;
  }

  note(message = "") {
    this.afterSummary = false;
    this.output.write(`${message}\n`);
  }

  async question(query) {
    const readline = createInterface({ input: this.input, output: this.output });
    try {
      return await readline.question(query);
    } finally {
      readline.close();
    }
  }

  async text(label, defaultValue = "") {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = (await this.question(`${label}${suffix}: `)).trim();
    return answer || defaultValue;
  }

  get canSelectInteractively() {
    return Boolean(this.input.isTTY && typeof this.input.setRawMode === "function" && this.output.isTTY);
  }

  async choose(label, choices, defaultValue, header) {
    const defaultIndex = Math.max(0, choices.findIndex((choice) => choice.value === defaultValue));
    if (this.canSelectInteractively) return this.selectWithKeys(label, choices, defaultIndex, header);
    this.note(header ? `[${header}] ${label}` : label);
    choices.forEach((choice, index) => this.note(`  ${index + 1}) ${choice.label}${choice.description ? ` — ${choice.description}` : ""}`));
    for (;;) {
      const answer = (await this.question(`Choose [${defaultIndex + 1}]: `)).trim();
      const index = answer ? Number(answer) - 1 : defaultIndex;
      if (Number.isInteger(index) && index >= 0 && index < choices.length) return choices[index].value;
      this.note(`Enter a number from 1 to ${choices.length}.`);
    }
  }

  // Arrow-key list styled like Claude Code's question picker: header chip, bold question,
  // bold labels with dim descriptions. Digits jump, Enter confirms, Esc or Ctrl-C cancels setup.
  selectWithKeys(label, choices, initialIndex, header) {
    const { input, output } = this;
    let index = initialIndex;
    let drawn = 0;
    const erase = () => { if (drawn) output.write(`\x1b[${drawn}A\x1b[J`); };
    const render = () => {
      erase();
      const lines = [];
      if (this.afterSummary) lines.push("");
      if (header) lines.push(`${STYLE.chip(` ${header} `)}`, "");
      lines.push(STYLE.bold(label), "");
      choices.forEach((choice, i) => {
        const text = `${i + 1}. ${choice.label}`;
        lines.push(i === index ? STYLE.accent(`❯ ${text}`) : `  ${STYLE.bold(text)}`);
        if (choice.description) lines.push(`     ${STYLE.dim(choice.description)}`);
      });
      lines.push("", STYLE.dim("↑/↓ to navigate · Enter to select · Esc to cancel"));
      output.write(`${lines.join("\n")}\n`);
      drawn = lines.length;
    };
    const summarize = () => {
      erase();
      output.write(`${STYLE.dim("●")} ${label} ${STYLE.dim("→")} ${STYLE.bold(choices[index].label)}\n`);
      this.afterSummary = true;
    };
    return new Promise((resolvePromise, reject) => {
      const wasRaw = input.isRaw;
      const finish = (callback) => {
        input.removeListener("data", onData);
        input.setRawMode(Boolean(wasRaw));
        input.pause();
        callback();
      };
      const onData = (chunk) => {
        const key = chunk.toString();
        if (KEY.cancel.includes(key)) return finish(() => { erase(); reject(new SetupCancelled()); });
        if (KEY.interrupt.includes(key)) return finish(() => reject(new SetupInterrupted("setup interrupted")));
        if (KEY.enter.includes(key)) return finish(() => { summarize(); resolvePromise(choices[index].value); });
        if (KEY.up.includes(key)) index = (index - 1 + choices.length) % choices.length;
        else if (KEY.down.includes(key)) index = (index + 1) % choices.length;
        else if (/^[1-9]$/.test(key) && Number(key) <= choices.length) index = Number(key) - 1;
        else return;
        render();
      };
      input.setRawMode(true);
      input.resume();
      input.on("data", onData);
      render();
    });
  }

  async confirm(label) {
    const answer = (await this.question(`${label} [y/N]: `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  }

  close() {}
}

// ---------- role configuration ----------

function choiceSet(values, current, kind) {
  const choices = [{ value: DEFAULT_CHOICE, label: "Default", description: "use the agent's configured default" }];
  for (const value of unique(values)) choices.push({ value, label: value });
  if (current && !choices.some((choice) => choice.value === current)) {
    choices.push({ value: current, label: current });
  }
  for (const choice of choices) {
    if (choice.value === current) choice.description = [choice.description, "current"].filter(Boolean).join(" · ");
  }
  choices.push({ value: MANUAL_CHOICE, label: "Type something.", description: `enter a ${kind} manually` });
  return choices;
}

function agentChoices(catalogue, current) {
  const ordered = [...catalogue].sort((a, b) => Number(b.installed) - Number(a.installed));
  const choices = ordered.map((entry) => ({
    value: entry.id,
    label: entry.label,
    description: [
      entry.id,
      entry.id === current && "current",
      !entry.installed && "CLI not found on PATH",
      entry.supportsModel === false && "uses its own model config",
    ].filter(Boolean).join(" · "),
  }));
  if (current && !choices.some((choice) => choice.value === current)) {
    choices.push({ value: current, label: current, description: "current" });
  }
  choices.push({ value: MANUAL_CHOICE, label: "Type something.", description: "enter another Orca agent id" });
  return choices;
}

async function requiredManualText(prompt, label) {
  for (;;) {
    const value = (await prompt.text(label)).trim();
    if (value) return value;
    prompt.note(`${label} must not be empty; try again.`);
  }
}

export async function configureRole(name, current, prompt, discoveryFn = discoverAgent, catalogue = AGENT_CATALOGUE) {
  let agent;
  let capability;
  for (;;) {
    agent = await prompt.choose(`Which agent should handle the ${name} phase?`, agentChoices(catalogue, current.agent), current.agent, `${name} phase`);
    if (agent === MANUAL_CHOICE) agent = await requiredManualText(prompt, `${name} agent id`);
    capability = agentCapability(catalogue, agent);
    if (capability.source !== "unknown") break;
    if (await prompt.confirm(`Agent ${agent} is not advertised by this Orca CLI and cannot be validated by setup. Use it anyway?`)) break;
    prompt.note("Choose another agent.");
  }
  if (capability.installed === false) {
    prompt.note(`  Note: no ${capability.label} CLI was found on this machine's PATH; the Orca worker server may still have it.`);
  }
  if (capability.supportsModel === false) {
    prompt.note(`  ${capability.label} launches with the model from its own configuration; Orca does not accept --model or --effort for it.`);
    return { agent, model: null, effort: null };
  }

  const discovery = discoveryFn(agent);
  if (discovery.adapter && !discovery.available) prompt.note(`  Discovery unavailable: ${discovery.reason}`);
  if (!discovery.adapter) prompt.note(`  No live model discovery for ${capability.label}; pick default or enter a model ID.`);

  const retainedModel = agent === current.agent ? current.model : null;
  const currentModel = retainedModel ?? DEFAULT_CHOICE;
  let model = await prompt.choose(`Which ${capability.label} model for ${name}?`, choiceSet(discovery.models.map((item) => item.id), retainedModel, "model ID"), currentModel, `${name} phase`);
  if (model === MANUAL_CHOICE) model = await requiredManualText(prompt, `${name} model ID`);
  if (model === DEFAULT_CHOICE) model = null;
  if (model === null) {
    prompt.note(`  ${name} thinking effort: default (an explicit effort requires an explicit model).`);
    return { agent, model: null, effort: null };
  }

  const discoveredModel = discovery.models.find((item) => item.id === model);
  const effortValues = discoveredModel?.efforts ?? discovery.defaultEfforts;
  if (!discoveredModel && agent === "codex") {
    prompt.note("  This Codex model was not discovered; its effort values cannot be verified.");
  }
  const currentEffort = agent === current.agent && current.model === model && current.effort
    ? current.effort
    : DEFAULT_CHOICE;
  let effort = await prompt.choose(`How much thinking effort for ${model}?`, choiceSet(effortValues, currentEffort === DEFAULT_CHOICE ? null : currentEffort, "effort"), currentEffort, `${name} phase`);
  if (effort === MANUAL_CHOICE) effort = await requiredManualText(prompt, `${name} effort`);
  if (effort === DEFAULT_CHOICE) effort = null;
  return { agent, model, effort };
}

export async function chooseMaxRounds(current, prompt) {
  for (;;) {
    const answer = (await prompt.text("Max review rounds (1-20; each round is one implement + one review turn)", String(current))).trim();
    const value = Number(answer);
    if (Number.isInteger(value) && value >= 1 && value <= 20) return value;
    prompt.note("Enter a whole number from 1 to 20.");
  }
}

// ---------- config file ----------

function safeConfigPath(root, configured) {
  const path = isAbsolute(configured) ? resolve(configured) : resolve(root, configured);
  const realRoot = realpathSync(root);
  let realParent;
  try {
    realParent = realpathSync(dirname(path));
  } catch (error) {
    throw new ConfigError(`setup config parent is not usable: ${error.code ?? error.message}`);
  }
  const rel = relative(realRoot, realParent);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ConfigError("setup config must be inside the target project");
  }
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info?.isSymbolicLink()) throw new ConfigError("setup config must not be a symbolic link");
  if (info && !info.isFile()) throw new ConfigError("setup config must be a regular file");
  return path;
}

export function writeConfigAtomic(path, value) {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) throw new ConfigError("setup config must not be a symbolic link");
  const mode = existing ? statSync(path).mode & 0o777 : 0o600;
  const temporary = resolve(dirname(path), `.${randomUUID()}.orca-loop.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readRawConfig(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`could not parse ${path}: ${error.message}`);
  }
}

function displayValue(value) {
  return value ?? "default";
}

function previewLines(path, implement, review, maxRounds) {
  return [
    "Configuration preview:",
    "  Role       Agent       Model       Effort",
    `  implement  ${implement.agent}  ${displayValue(implement.model)}  ${displayValue(implement.effort)}`,
    `  review     ${review.agent}  ${displayValue(review.model)}  ${displayValue(review.effort)}`,
    `  max review rounds: ${maxRounds}`,
    `  File       ${path}`,
  ];
}

// `--set role.field=value` entries applied on top of the current roles. All assignments are
// parsed first so the outcome does not depend on argument order: an agent change resets a role's
// model/effort to default, then every explicit model/effort from the same command is applied.
export function applySetArguments(current, assignments, catalogue) {
  const pending = { implement: {}, review: {} };
  let maxRounds = current.maxRounds;
  for (const assignment of assignments) {
    const rounds = assignment.match(/^maxRounds=(.*)$/);
    if (rounds) {
      const value = Number(rounds[1].trim());
      if (!Number.isInteger(value) || value < 1 || value > 20) throw new ConfigError("maxRounds must be an integer from 1 to 20");
      maxRounds = value;
      continue;
    }
    const match = assignment.match(/^(implement|review)\.(agent|model|effort)=(.*)$/s);
    if (!match) throw new ConfigError(`invalid --set ${assignment}; expected <implement|review>.<agent|model|effort>=<value> or maxRounds=<n>`);
    const [, role, field, rawValue] = match;
    const value = rawValue.trim();
    if (field === "agent") {
      if (!value) throw new ConfigError(`${role}.agent must not be empty`);
      pending[role].agent = value;
    } else {
      pending[role][field] = value === "" || value.toLowerCase() === "default" || value.toLowerCase() === "null" ? null : value;
    }
  }
  const roles = {};
  for (const role of ["implement", "review"]) {
    const next = { ...current[role] };
    const changes = pending[role];
    if (changes.agent !== undefined && changes.agent !== next.agent) {
      next.agent = changes.agent;
      next.model = null;
      next.effort = null;
    }
    if (changes.model !== undefined) next.model = changes.model;
    if (changes.effort !== undefined) next.effort = changes.effort;
    const capability = agentCapability(catalogue, next.agent);
    const explicitPin = changes.model != null || changes.effort != null;
    if (capability.supportsModel === false && (next.model !== null || next.effort !== null)) {
      throw new ConfigError(`${role}.agent ${next.agent} does not accept --model or --effort; ${explicitPin ? "remove them or set them to default" : "set them to default"}`);
    }
    if (next.effort !== null && next.model === null) {
      throw new ConfigError(`${role}.effort requires ${role}.model`);
    }
    roles[role] = next;
  }
  return { ...roles, maxRounds };
}

export function discoveryReport({ root, path, catalogue, discoveryFn }) {
  const current = validateConfig(mergeConfig(DEFAULTS, readRawConfig(path)));
  const agents = catalogue.map((entry) => {
    const base = { id: entry.id, label: entry.label, installed: entry.installed, supportsModel: entry.supportsModel, source: entry.source };
    if (entry.supportsModel === false) return { ...base, discovery: { available: false, reason: "agent uses its own model configuration", models: [], defaultEfforts: [] } };
    if (!DISCOVERY_AGENTS.has(entry.id)) return { ...base, discovery: { available: false, reason: "no model discovery adapter", models: [], defaultEfforts: [] } };
    if (!entry.installed) return { ...base, discovery: { available: false, reason: `${entry.label} CLI not found on PATH`, models: [], defaultEfforts: [] } };
    const found = discoveryFn(entry.id);
    return { ...base, discovery: { available: found.available, reason: found.reason ?? null, models: found.models, defaultEfforts: found.defaultEfforts } };
  });
  return { root, path: relative(root, path) || path, exists: existsSync(path), current: { implement: current.implement, review: current.review, maxRounds: current.maxRounds }, agents };
}

function printDiscovery(report, output) {
  output.write(`Config: ${report.path}${report.exists ? "" : " (not created yet)"}\n`);
  output.write(`Current: implement=${report.current.implement.agent}/${displayValue(report.current.implement.model)}/${displayValue(report.current.implement.effort)}`);
  output.write(`  review=${report.current.review.agent}/${displayValue(report.current.review.model)}/${displayValue(report.current.review.effort)}  maxRounds=${report.current.maxRounds}\n\nAgents:\n`);
  for (const agent of report.agents) {
    const status = agent.installed ? "installed" : "not on PATH";
    const models = agent.discovery.available ? agent.discovery.models.map((m) => m.id).join(", ") : agent.discovery.reason;
    output.write(`  ${agent.id.padEnd(12)} ${agent.label.padEnd(18)} ${status.padEnd(12)} ${agent.supportsModel === false ? "model: own config" : `models: ${models}`}\n`);
  }
}

export async function runSetup({ root, argv = [], input = process.stdin, output = process.stdout,
  prompt: suppliedPrompt, discoveryFn, catalogue: suppliedCatalogue } = {}) {
  const options = parseSetupArgs(argv);
  if (options.help) {
    output.write(setupUsage());
    return { help: true };
  }
  const path = safeConfigPath(root, options.config ?? ".orca-loop.json");
  const catalogue = suppliedCatalogue ?? buildAgentCatalogue();
  const discoveryCache = new Map();
  const discover = (agent) => {
    if (!discoveryCache.has(agent)) discoveryCache.set(agent, discoveryFn ? discoveryFn(agent) : discoverAgent(agent));
    return discoveryCache.get(agent);
  };

  if (options.discover) {
    const report = discoveryReport({ root, path, catalogue, discoveryFn: discover });
    if (options.json) output.write(`${JSON.stringify(report, null, 2)}\n`);
    else printDiscovery(report, output);
    return { discovered: true, report };
  }

  const raw = readRawConfig(path);
  const current = validateConfig(mergeConfig(DEFAULTS, raw));

  if (options.set.length) {
    const roles = applySetArguments(current, options.set, catalogue);
    const nextRaw = { ...raw, maxRounds: roles.maxRounds, implement: { ...(raw.implement ?? {}), ...roles.implement }, review: { ...(raw.review ?? {}), ...roles.review } };
    validateConfig(mergeConfig(DEFAULTS, nextRaw));
    writeConfigAtomic(path, nextRaw);
    if (options.json) output.write(`${JSON.stringify({ configured: true, path, implement: roles.implement, review: roles.review, maxRounds: roles.maxRounds }, null, 2)}\n`);
    else output.write(`${previewLines(path, roles.implement, roles.review, roles.maxRounds).join("\n")}\nConfigured ${path}\n`);
    return { configured: true, path, config: nextRaw };
  }

  if (!suppliedPrompt && (!input.isTTY || !output.isTTY)) {
    throw new ConfigError("setup requires an interactive terminal; use `setup --set ...` or edit .orca-loop.json directly in non-interactive environments");
  }
  const prompt = suppliedPrompt ?? new TerminalPrompter(input, output);
  try {
    prompt.note("Configure Orca Review Loop workers. Choose default to use the agent's own setting.\n");
    const implement = await configureRole("implement", current.implement, prompt, discover, catalogue);
    prompt.note();
    const review = await configureRole("review", current.review, prompt, discover, catalogue);
    prompt.note();
    const maxRounds = await chooseMaxRounds(current.maxRounds, prompt);
    const nextRaw = {
      ...raw,
      maxRounds,
      implement: { ...(raw.implement ?? {}), ...implement },
      review: { ...(raw.review ?? {}), ...review },
    };
    validateConfig(mergeConfig(DEFAULTS, nextRaw));
    prompt.note("");
    for (const line of previewLines(path, implement, review, maxRounds)) prompt.note(line);
    if (!await prompt.confirm(`Write ${path}?`)) {
      prompt.note("Setup cancelled; configuration was not changed.");
      return { cancelled: true, path };
    }
    writeConfigAtomic(path, nextRaw);
    prompt.note(`Configured ${path}`);
    prompt.note('Next: orca-review-loop --task "<your task>"');
    return { configured: true, path, config: nextRaw };
  } catch (error) {
    if (!(error instanceof SetupCancelled)) throw error;
    prompt.note("Setup cancelled; configuration was not changed.");
    return { cancelled: true, path };
  } finally {
    if (!suppliedPrompt) prompt.close();
  }
}
