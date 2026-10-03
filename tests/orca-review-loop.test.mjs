import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { payloadOf, subjectDisposition, validateDone } from "../skills/orca-review-loop/scripts/orca-review-loop.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "skills/orca-review-loop/scripts/orca-review-loop.mjs");
const FAKE = join(REPO, "tests/fake-orca.mjs");

function runScenario(completions, options = {}) {
  const area = mkdtempSync(join(tmpdir(), "orca-loop-test-"));
  const root = join(area, "repo");
  spawnSync("mkdir", [root]);
  writeFileSync(join(root, ".gitignore"), ".orca-loop/\n");
  writeFileSync(join(root, "candidate.txt"), "baseline\n");
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"], { cwd: root });
  const scenarioPath = join(area, "scenario.json");
  const statePath = join(area, "state.json");
  writeFileSync(scenarioPath, JSON.stringify({ completions, ...options.scenario }));
  writeFileSync(join(root, ".orca-loop.json"), JSON.stringify({
    maxRounds: options.maxRounds || 5,
    waitTimeoutMs: 1,
    maxEmptyWaitsBeforeInspect: 1,
    maxTotalMinutes: options.maxTotalMinutes ?? 1,
  }));
  const result = spawnSync(process.execPath, [CLI, "--task", "test task", "--allow-dirty"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ORCA_LOOP_ROOT: root,
      ORCA_CLI_COMMAND: `${process.execPath} ${FAKE}`,
      FAKE_ORCA_SCENARIO: scenarioPath,
      FAKE_ORCA_STATE: statePath,
    },
  });
  return { result, state: JSON.parse(readFileSync(statePath, "utf8")), root };
}

test("payloadOf accepts object and JSON string payloads", () => {
  assert.deepEqual(payloadOf({ payload: { outcome: "succeeded" } }), { outcome: "succeeded" });
  assert.deepEqual(payloadOf({ payload: '{"outcome":"succeeded"}' }), { outcome: "succeeded" });
  assert.deepEqual(payloadOf({ payload: "bad" }), {});
});

test("subject parser is strict and does not inspect bodies", () => {
  assert.equal(subjectDisposition("PASS: accepted", ["PASS", "NEEDS_FIX"]), "PASS");
  assert.equal(subjectDisposition("NEEDS_FIX issue", ["PASS", "NEEDS_FIX"]), "NEEDS_FIX");
  assert.equal(subjectDisposition("prefix PASS:", ["PASS"]), null);
});

test("validation rejects stale lifecycle identity", () => {
  const message = { type: "worker_done", run_id: "r", subject: "PASS: ok", payload: { taskId: "wrong", dispatchId: "d", outcome: "succeeded" } };
  assert.throws(() => validateDone(message, { taskId: "t", dispatchId: "d", runId: "r" }, ["PASS"]), /another Task/);
});

test("PASS on first review", () => {
  const { result, state } = runScenario([{ disposition: "DONE" }, { disposition: "PASS", objectPayload: true }]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RESULT PASS/);
  assert.deepEqual(state.commands.filter((x) => x.command === "worker-start").map((x) => x.args[x.args.indexOf("--agent") + 1]), ["claude", "codex"]);
  assert.equal(state.maxActive, 1);
  assert.equal(state.releases.length, 2);
});

test("NEEDS_FIX automatically routes exact feedback and then passes", () => {
  const body = "Fix candidate.txt at line 1";
  const { result, state } = runScenario([
    { disposition: "DONE" }, { disposition: "NEEDS_FIX", body },
    { disposition: "DONE", mutate: "fixed\n" }, { disposition: "PASS" },
  ]);
  assert.equal(result.status, 0, result.stderr);
  const starts = state.commands.filter((x) => x.command === "worker-start");
  assert.deepEqual(starts.map((x) => x.args[x.args.indexOf("--agent") + 1]), ["claude", "codex", "claude", "codex"]);
  assert.match(starts[2].args[starts[2].args.indexOf("--spec") + 1], /Fix candidate\.txt at line 1/);
  assert.equal(state.maxActive, 1);
});

test("multiple fixes can pass on the fifth review", () => {
  const completions = [];
  for (let round = 1; round <= 5; round += 1) {
    completions.push({ disposition: "DONE", mutate: round > 1 ? `fix${round}\n` : undefined });
    completions.push({ disposition: round === 5 ? "PASS" : "NEEDS_FIX", body: `finding ${round}` });
  }
  const { result, state } = runScenario(completions);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.starts, 10);
});

test("fifth rejection stops without a sixth repair", () => {
  const completions = [];
  for (let round = 1; round <= 5; round += 1) {
    completions.push({ disposition: "DONE", mutate: round > 1 ? `fix${round}\n` : undefined });
    completions.push({ disposition: "NEEDS_FIX", body: `finding ${round}` });
  }
  const { result, state } = runScenario(completions);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RESULT MAX_ROUNDS/);
  assert.equal(state.starts, 10);
});

for (const [name, completions, expected, starts] of [
  ["reviewer BLOCKED", [{ disposition: "DONE" }, { disposition: "BLOCKED" }], "BLOCKED", 2],
  ["implementer BLOCKED", [{ disposition: "BLOCKED" }], "BLOCKED", 1],
  ["implementer NEEDS_REPLAN", [{ disposition: "NEEDS_REPLAN" }], "NEEDS_REPLAN", 1],
  ["worker lifecycle failure", [{ disposition: "DONE", outcome: "failed" }], "WORKER_FAILED", 1],
  ["malformed review verdict", [{ disposition: "DONE" }, { disposition: "MAYBE" }], "PROTOCOL_ERROR", 2],
  ["wrong task id", [{ disposition: "DONE", wrongTask: true }], "PROTOCOL_ERROR", 1],
]) {
  test(name, () => {
    const { result, state } = runScenario(completions);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`RESULT ${expected}`));
    assert.equal(state.starts, starts);
  });
}

test("stale worker_done cannot advance state", () => {
  const { result, state } = runScenario([{ disposition: "DONE", wrongDispatch: true }], { maxTotalMinutes: 0.01 });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /Codex/);
  assert.equal(state.starts, 1);
});

for (const type of ["question", "escalation"]) {
  test(`${type} stops for a human`, () => {
    const { result, state } = runScenario([{ type, subject: `${type} help`, disposition: type }]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /RESULT NEEDS_HUMAN/);
    assert.equal(state.starts, 1);
  });
}

test("reviewer mutation is detected", () => {
  const { result } = runScenario([{ disposition: "DONE" }, { disposition: "PASS", mutate: "review edit\n" }]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RESULT REVIEWER_MUTATED_WORKTREE/);
});

test("repeated unchanged repair and finding stops NO_PROGRESS", () => {
  const body = "same finding";
  const { result, state } = runScenario([
    { disposition: "DONE" }, { disposition: "NEEDS_FIX", body },
    { disposition: "DONE" }, { disposition: "NEEDS_FIX", body },
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RESULT NO_PROGRESS/);
  assert.equal(state.starts, 4);
});

test("settled workers are released once and deliveries acknowledged", () => {
  const { result, state } = runScenario([{ disposition: "DONE" }, { disposition: "PASS" }]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(new Set(state.releases).size, state.releases.length);
  assert.equal(state.releases.length, 2);
  assert.equal(state.acks.length, 4);
});

test("wait timeout is a checkpoint and does not duplicate the worker", () => {
  const { result, state } = runScenario(
    [{ disposition: "DONE" }, { disposition: "PASS" }],
    { scenario: { timeoutsBeforeCompletion: 1 } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.starts, 2);
});

test("missing heartbeat with unverifiable liveness never duplicates", () => {
  const { result, state } = runScenario([], { scenario: { skipHeartbeat: true, liveness: "unverifiable" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RESULT NEEDS_HUMAN/);
  assert.equal(state.starts, 1);
});

test("exited worker without worker_done fails without blind retry", () => {
  const { result, state } = runScenario([], { scenario: { skipHeartbeat: true, liveness: "exited" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RESULT WORKER_FAILED/);
  assert.equal(state.starts, 1);
});

test("positive no-start receipt permits one same-Task retry", () => {
  const { result, state } = runScenario(
    [{ disposition: "DONE" }, { disposition: "PASS" }],
    { scenario: { startFailures: 1 } },
  );
  assert.equal(result.status, 0, result.stderr);
  const starts = state.commands.filter((entry) => entry.command === "worker-start");
  assert.equal(starts.length, 3);
  assert.ok(starts[1].args.includes("--retry-of"));
  assert.equal(starts[1].args[starts[1].args.indexOf("--task") + 1], "task_1");
  assert.equal(state.maxActive, 1);
});

test("a second proven no-start is not retried again", () => {
  const { result, state } = runScenario([], { scenario: { startFailures: 2 } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RESULT WORKER_FAILED/);
  assert.equal(state.starts, 2);
  assert.equal(state.releases.length, 2);
  assert.equal(state.maxActive, 1);
});
