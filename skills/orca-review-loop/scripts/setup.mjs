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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ConfigError, DEFAULTS, mergeConfig, validateConfig } from "./config.mjs";

const DEFAULT_CHOICE = "__orca_loop_default__";
const MANUAL_CHOICE = "__orca_loop_manual__";
const DISCOVERY_AGENTS = new Set(["claude", "codex"]);
const CLAUDE_MODEL_EXCLUSIONS = new Set(["best", "default", "opusplan", "or a full model id"]);
const CLAUDE_EFFORT_EXCLUSIONS = new Set(["auto", "ultracode"]);

export function parseSetupArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      if (index + 1 >= argv.length) throw new ConfigError("--config requires a value");
      options.config = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new ConfigError(`unknown setup argument: ${arg}`);
    }
  }
  return options;
}

export function setupUsage() {
  return "Usage: orca-review-loop setup [--config <path>]\n\n" +
    "Interactively configure the implement and review agents, models, and thinking effort.\n";
}

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

export class TerminalPrompter {
  constructor(input = process.stdin, output = process.stdout) {
    this.output = output;
    this.readline = createInterface({ input, output });
  }

  note(message = "") {
    this.output.write(`${message}\n`);
  }

  async text(label, defaultValue = "") {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = (await this.readline.question(`${label}${suffix}: `)).trim();
    return answer || defaultValue;
  }

  async choose(label, choices, defaultValue) {
    this.note(label);
    choices.forEach((choice, index) => this.note(`  ${index + 1}) ${choice.label}`));
    const defaultIndex = Math.max(0, choices.findIndex((choice) => choice.value === defaultValue));
    for (;;) {
      const answer = (await this.readline.question(`Choose [${defaultIndex + 1}]: `)).trim();
      const index = answer ? Number(answer) - 1 : defaultIndex;
      if (Number.isInteger(index) && index >= 0 && index < choices.length) return choices[index].value;
      this.note(`Enter a number from 1 to ${choices.length}.`);
    }
  }

  async confirm(label) {
    const answer = (await this.readline.question(`${label} [y/N]: `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  }

  close() {
    this.readline.close();
  }
}

function choiceSet(values, current, kind) {
  const choices = [{ value: DEFAULT_CHOICE, label: "default (use the agent's configured default)" }];
  for (const value of unique(values)) choices.push({ value, label: value });
  if (current && !choices.some((choice) => choice.value === current)) {
    choices.push({ value: current, label: `${current} (current)` });
  }
  choices.push({ value: MANUAL_CHOICE, label: `enter a ${kind} manually` });
  return choices;
}

async function requiredManualText(prompt, label) {
  for (;;) {
    const value = (await prompt.text(label)).trim();
    if (value) return value;
    prompt.note(`${label} must not be empty; try again.`);
  }
}

export async function configureRole(name, current, prompt, discoveryFn = discoverAgent) {
  let agent;
  let discovery;
  for (;;) {
    agent = (await prompt.text(`${name} agent`, current.agent)).trim();
    if (!agent) {
      prompt.note(`${name} agent must not be empty; try again.`);
      continue;
    }
    discovery = discoveryFn(agent);
    if (!discovery.available) prompt.note(`  Discovery unavailable: ${discovery.reason}`);
    const hasAdapter = discovery.adapter ?? DISCOVERY_AGENTS.has(agent);
    if (hasAdapter || await prompt.confirm(`Agent ${agent} cannot be validated by setup. Use it anyway?`)) break;
    prompt.note("Choose another agent.");
  }

  const retainedModel = agent === current.agent ? current.model : null;
  const currentModel = retainedModel ?? DEFAULT_CHOICE;
  let model = await prompt.choose(`${name} model`, choiceSet(discovery.models.map((item) => item.id), retainedModel, "model ID"), currentModel);
  if (model === MANUAL_CHOICE) model = await requiredManualText(prompt, `${name} model ID`);
  if (model === DEFAULT_CHOICE) model = null;
  if (model === null) return { agent, model: null, effort: null };

  const discoveredModel = discovery.models.find((item) => item.id === model);
  const effortValues = discoveredModel?.efforts ?? discovery.defaultEfforts;
  if (!discoveredModel && agent === "codex") {
    prompt.note("  This Codex model was not discovered; its effort values cannot be verified.");
  }
  const currentEffort = agent === current.agent && current.model === model && current.effort
    ? current.effort
    : DEFAULT_CHOICE;
  let effort = await prompt.choose(`${name} thinking effort`, choiceSet(effortValues, currentEffort === DEFAULT_CHOICE ? null : currentEffort, "effort"), currentEffort);
  if (effort === MANUAL_CHOICE) effort = await requiredManualText(prompt, `${name} effort`);
  if (effort === DEFAULT_CHOICE) effort = null;
  return { agent, model, effort };
}

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

function displayValue(value) {
  return value ?? "default";
}

export async function runSetup({ root, argv = [], input = process.stdin, output = process.stdout,
  prompt: suppliedPrompt, discoveryFn } = {}) {
  const options = parseSetupArgs(argv);
  if (options.help) {
    output.write(setupUsage());
    return { help: true };
  }
  if (!suppliedPrompt && (!input.isTTY || !output.isTTY)) {
    throw new ConfigError("setup requires an interactive terminal; edit .orca-loop.json directly in non-interactive environments");
  }
  const path = safeConfigPath(root, options.config ?? ".orca-loop.json");
  let raw = {};
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new ConfigError(`could not parse ${path}: ${error.message}`);
    }
  }
  const current = validateConfig(mergeConfig(DEFAULTS, raw));
  const prompt = suppliedPrompt ?? new TerminalPrompter(input, output);
  const discoveryCache = new Map();
  const discover = (agent) => {
    if (!discoveryCache.has(agent)) {
      discoveryCache.set(agent, discoveryFn ? discoveryFn(agent) : discoverAgent(agent));
    }
    return discoveryCache.get(agent);
  };
  try {
    prompt.note("Configure Orca Review Loop workers. Choose default to use the agent's own setting.\n");
    const implement = await configureRole("implement", current.implement, prompt, discover);
    prompt.note();
    const review = await configureRole("review", current.review, prompt, discover);
    const nextRaw = {
      ...raw,
      implement: { ...(raw.implement ?? {}), ...implement },
      review: { ...(raw.review ?? {}), ...review },
    };
    validateConfig(mergeConfig(DEFAULTS, nextRaw));
    prompt.note("\nConfiguration preview:");
    prompt.note("  Role       Agent       Model       Effort");
    prompt.note(`  implement  ${implement.agent}  ${displayValue(implement.model)}  ${displayValue(implement.effort)}`);
    prompt.note(`  review     ${review.agent}  ${displayValue(review.model)}  ${displayValue(review.effort)}`);
    if (!await prompt.confirm(`Write ${path}?`)) {
      prompt.note("Setup cancelled; configuration was not changed.");
      return { cancelled: true, path };
    }
    writeConfigAtomic(path, nextRaw);
    prompt.note(`Configured ${path}`);
    prompt.note('Next: orca-review-loop --task "<your task>"');
    return { configured: true, path, config: nextRaw };
  } finally {
    if (!suppliedPrompt) prompt.close();
  }
}
