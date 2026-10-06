export const MODES = ["code", "spec"];

export const DEFAULTS = {
  mode: "code",
  maxRounds: 5,
  worktree: "current",
  implement: { agent: "claude", model: null, effort: null },
  review: { agent: "codex", model: null, effort: null },
  ackTimeoutMs: 60_000,
  waitTimeoutMs: 900_000,
  maxTotalMinutes: 360,
  maxLaunchRetries: 1,
  maxEmptyWaitsBeforeInspect: 3,
  dirtyWorktreePolicy: "refuse",
  retainTerminals: false,
  closeTakenOverTerminals: false,
  logBodies: false,
};

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeConfig(base, extra) {
  if (!isObject(extra)) throw new ConfigError("configuration must be a JSON object");
  for (const role of ["implement", "review"]) {
    if (extra[role] !== undefined && !isObject(extra[role])) {
      throw new ConfigError(`${role} must be an object`);
    }
  }
  return {
    ...base,
    ...extra,
    implement: { ...base.implement, ...(extra.implement ?? {}) },
    review: { ...base.review, ...(extra.review ?? {}) },
  };
}

function validateRole(name, role) {
  if (!isObject(role)) throw new ConfigError(`${name} must be an object`);
  if (typeof role.agent !== "string" || !role.agent.trim()) {
    throw new ConfigError(`${name}.agent must be a non-empty string`);
  }
  for (const field of ["model", "effort"]) {
    const value = role[field];
    if (value !== null && (typeof value !== "string" || !value.trim())) {
      throw new ConfigError(`${name}.${field} must be null or a non-empty string`);
    }
  }
  if (role.effort !== null && role.model === null) {
    throw new ConfigError(`${name}.effort requires ${name}.model`);
  }
}

export function validateConfig(config) {
  if (!isObject(config)) throw new ConfigError("configuration must be a JSON object");
  if (!MODES.includes(config.mode)) throw new ConfigError("mode must be code or spec");
  if (!Number.isInteger(config.maxRounds) || config.maxRounds < 1 || config.maxRounds > 20) {
    throw new ConfigError("maxRounds must be an integer from 1 to 20");
  }
  if (!Number.isInteger(config.maxLaunchRetries) || config.maxLaunchRetries < 0 || config.maxLaunchRetries > 1) {
    throw new ConfigError("maxLaunchRetries must be 0 or 1");
  }
  for (const flag of ["retainTerminals", "closeTakenOverTerminals", "logBodies"]) {
    if (typeof config[flag] !== "boolean") throw new ConfigError(`${flag} must be true or false`);
  }
  validateRole("implement", config.implement);
  validateRole("review", config.review);
  return config;
}
