import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { describeStartFailure, payloadOf, subjectDisposition, validateDone } from "../skills/orca-review-loop/scripts/orca-review-loop.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "skills/orca-review-loop/scripts/orca-review-loop.mjs");
const FAKE = join(REPO, "tests/fake-orca.mjs");

function runScenario(completions, options = {}) {
  const area = mkdtempSync(join(tmpdir(), "orca-loop-test-"));
  const root = join(area, "repo");
  spawnSync("mkdir", [root]);
  writeFileSync(join(root, ".gitignore"), ".orca-loop/\n");
  writeFileSync(join(root, "candidate.txt"), "baseline\n");
  for (const [path, content] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  options.setup?.(root);
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
    ...(options.config ?? {}),
  }));
  const result = spawnSync(process.execPath, [CLI, "--task", "test task", "--allow-dirty", ...(options.args ?? [])], {
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
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { starts: 0, commands: [], releases: [], acks: [] };
  return { result, state, root };
}

function specsOf(state) {
  return state.commands.filter((c) => c.command === "worker-start").map((c) => c.args[c.args.indexOf("--spec") + 1]);
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

test("configured model and effort pins are forwarded by role", () => {
  const { result, state } = runScenario([{ disposition: "DONE" }, { disposition: "PASS" }], {
    config: {
      implement: { agent: "claude", model: "opus", effort: "high" },
      review: { agent: "codex", model: "gpt-test", effort: "xhigh" },
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const starts = state.commands.filter((entry) => entry.command === "worker-start");
  assert.deepEqual(starts.map((entry) => entry.args[entry.args.indexOf("--model") + 1]), ["opus", "gpt-test"]);
  assert.deepEqual(starts.map((entry) => entry.args[entry.args.indexOf("--effort") + 1]), ["high", "xhigh"]);
});

for (const [name, config, pattern] of [
  ["effort without model", { implement: { effort: "high" } }, /implement\.effort requires implement\.model/],
  ["non-object role", { implement: "claude" }, /implement must be an object/],
  ["empty model", { review: { model: "" } }, /review\.model must be null or a non-empty string/],
]) {
  test(`invalid config rejects ${name} before contacting Orca`, () => {
    const { result, state } = runScenario([], { config });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /RESULT PROTOCOL_ERROR/);
    assert.match(result.stderr, pattern);
    assert.deepEqual(state.commands, []);
  });
}

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

const SPEC = ["--mode", "spec", "--artifact", "docs/specs/guest.md"];

test("omitting --mode behaves as code mode", () => {
  const { result, state } = runScenario([{ disposition: "DONE" }, { disposition: "PASS" }]);
  assert.equal(result.status, 0, result.stderr);
  const [producer, reviewer] = specsOf(state);
  assert.match(producer, /You are the implementation owner/);
  assert.doesNotMatch(producer, /specification/);
  assert.match(reviewer, /independent code reviewer/);
  assert.doesNotMatch(result.stdout, /Suggested next step/);
});

test("spec mode creates a missing artifact and passes", () => {
  const { result, state, root } = runScenario([
    { disposition: "DONE", write: { path: "docs/specs/guest.md", content: "# Guest\n" } },
    { disposition: "PASS" },
  ], { args: SPEC });
  assert.equal(result.status, 0, result.stderr);
  const [producer, reviewer] = specsOf(state);
  assert.match(producer, /You are the specification author/);
  assert.match(producer, /does not exist yet: create it/);
  assert.match(producer, /docs\/specs\/guest\.md/);
  assert.match(reviewer, /independent specification reviewer/);
  assert.match(reviewer, /Blocking findings:/);
  assert.equal(readFileSync(join(root, "docs/specs/guest.md"), "utf8"), "# Guest\n");
  assert.match(result.stdout, /Suggested next step:\n  orca-review-loop --mode code --task-file docs\/specs\/guest\.md/);
  assert.match(result.stdout, /RESULT PASS/);
});

test("spec mode revises an existing artifact", () => {
  const { result, state } = runScenario([
    { disposition: "DONE", write: { path: "docs/specs/guest.md", content: "# Guest v2\n" } },
    { disposition: "PASS" },
  ], { args: SPEC, files: { "docs/specs/guest.md": "# Guest v1\n" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(specsOf(state)[0], /already exists: revise it in place/);
});

test("spec mode forwards exact review feedback to a fresh revision", () => {
  const body = "Blocking findings:\n- acceptance criteria untestable\nOptional suggestions:\n- none";
  const { result, state } = runScenario([
    { disposition: "DONE", write: { path: "docs/specs/guest.md", content: "v1\n" } },
    { disposition: "NEEDS_FIX", body },
    { disposition: "DONE", write: { path: "docs/specs/guest.md", content: "v2\n" } },
    { disposition: "PASS" },
  ], { args: SPEC });
  assert.equal(result.status, 0, result.stderr);
  const specs = specsOf(state);
  assert.equal(specs.length, 4);
  assert.match(specs[2], /revising an independently reviewed specification/);
  assert.ok(specs[2].includes(`BEGIN REVIEW FEEDBACK\nSubject: NEEDS_FIX: test\nBody:\n${body}\nEND REVIEW FEEDBACK`));
});

for (const [name, args, pattern] of [
  ["spec mode without --artifact fails early", ["--mode", "spec"], /requires --artifact/],
  ["invalid --mode fails early", ["--mode", "plan"], /mode must be code or spec/],
  ["artifact outside the worktree is rejected", ["--mode", "spec", "--artifact", "../outside.md"], /inside the target worktree/],
]) {
  test(name, () => {
    const { result, state } = runScenario([], { args });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /RESULT PROTOCOL_ERROR/);
    assert.match(result.stderr, pattern);
    assert.equal(state.starts, 0);
  });
}

test("spec reviewer editing the artifact is detected", () => {
  const { result } = runScenario([
    { disposition: "DONE", write: { path: "docs/specs/guest.md", content: "v1\n" } },
    { disposition: "PASS", write: { path: "docs/specs/guest.md", content: "reviewer edit\n" } },
  ], { args: SPEC });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RESULT REVIEWER_MUTATED_WORKTREE/);
});

test("current resolves through a path selector and workers get the resolved worktree id", () => {
  const { result, state, root } = runScenario([{ disposition: "DONE" }, { disposition: "PASS" }]);
  assert.equal(result.status, 0, result.stderr);
  const show = state.commands.find((c) => c.command === "worktree-show");
  assert.equal(show.args[show.args.indexOf("--worktree") + 1], `path:${root}`);
  for (const c of state.commands.filter((c) => c.command === "worker-start")) {
    assert.equal(c.args[c.args.indexOf("--worktree") + 1], `id:fake-repo::${root}`);
  }
});

test("a selector resolving to another worktree stops before any worker starts", () => {
  const { result, state } = runScenario([{ disposition: "DONE" }], {
    config: { worktree: "name:another-worktree" }, scenario: { resolveTo: "/tmp/some-other-repo" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RESULT ORCA_ERROR: worktree selector name:another-worktree resolves to \/tmp\/some-other-repo/);
  assert.equal(state.starts, 0);
});

test("a misplaced worker is stopped and released before ORCA_ERROR", () => {
  const { result, state } = runScenario([{ disposition: "DONE" }], { scenario: { placeAt: "/tmp/some-other-repo" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RESULT ORCA_ERROR: worker was placed in \/tmp\/some-other-repo.*was stopped and released/);
  assert.equal(state.starts, 1);
  assert.deepEqual(state.stops, ["ctx_1"]);
  assert.deepEqual(state.releases, ["ctx_1"]);
  assert.equal(state.active, 0);
});

test("config mode is the default and the CLI flag wins", () => {
  const specConfig = { config: { mode: "spec" } };
  const a = runScenario([], { ...specConfig });
  assert.match(a.result.stderr, /requires --artifact/);
  const b = runScenario([{ disposition: "DONE" }, { disposition: "PASS" }], { ...specConfig, args: ["--mode", "code"] });
  assert.equal(b.result.status, 0, b.result.stderr);
  assert.match(specsOf(b.state)[0], /implementation owner/);
});

test("code mode rejects --artifact", () => {
  const { result, state } = runScenario([], { args: ["--artifact", "docs/x.md"] });
  assert.match(result.stderr, /RESULT PROTOCOL_ERROR: --artifact is only valid with --mode spec/);
  assert.equal(state.starts, 0);
});

test("artifact reached through a symlinked directory is rejected", () => {
  const { result, state } = runScenario([], {
    args: ["--mode", "spec", "--artifact", "linked/out.md"],
    setup: (root) => { mkdirSync(join(dirname(root), "elsewhere")); symlinkSync(join(dirname(root), "elsewhere"), join(root, "linked")); },
  });
  assert.match(result.stderr, /RESULT PROTOCOL_ERROR: artifact must be inside the target worktree/);
  assert.equal(state.starts, 0);
});

test("a symlink artifact is rejected", () => {
  const { result } = runScenario([], {
    args: SPEC,
    setup: (root) => { mkdirSync(join(root, "docs/specs"), { recursive: true }); symlinkSync(join(root, "candidate.txt"), join(root, "docs/specs/guest.md")); },
  });
  assert.match(result.stderr, /artifact must not be a symbolic link/);
});

test("reviewer edits to a git-ignored artifact are still detected", () => {
  const { result } = runScenario([
    { disposition: "DONE", write: { path: "docs/specs/guest.md", content: "v1\n" } },
    { disposition: "PASS", write: { path: "docs/specs/guest.md", content: "reviewer edit\n" } },
  ], { args: SPEC, files: { ".gitignore": ".orca-loop/\ndocs/\n" } });
  assert.match(result.stderr, /RESULT REVIEWER_MUTATED_WORKTREE/);
});

test("revisions to a git-ignored artifact count as progress", () => {
  const body = "Blocking findings:\n- same";
  const { result } = runScenario([
    { disposition: "DONE", write: { path: "docs/specs/guest.md", content: "v1\n" } },
    { disposition: "NEEDS_FIX", body },
    { disposition: "DONE", write: { path: "docs/specs/guest.md", content: "v2\n" } },
    { disposition: "NEEDS_FIX", body },
    { disposition: "DONE", write: { path: "docs/specs/guest.md", content: "v3\n" } },
    { disposition: "PASS" },
  ], { args: SPEC, files: { ".gitignore": ".orca-loop/\ndocs/\n" } });
  assert.equal(result.status, 0, result.stderr);
});

test("producer DONE without delivering the artifact is a protocol error", () => {
  const { result, state } = runScenario([{ disposition: "DONE" }], { args: SPEC });
  assert.match(result.stderr, /RESULT PROTOCOL_ERROR: producer reported DONE but docs\/specs\/guest\.md is not a regular file/);
  assert.equal(state.starts, 1);
});

test("suggested next command quotes paths with spaces", () => {
  const { result } = runScenario([
    { disposition: "DONE", write: { path: "docs/my specs/guest.md", content: "v1\n" } },
    { disposition: "PASS" },
  ], { args: ["--mode", "spec", "--artifact", "docs/my specs/guest.md"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--task-file 'docs\/my specs\/guest\.md'/);
});

test("producer turning the artifact parent into an outside symlink is rejected", () => {
  const { result, state } = runScenario([
    { disposition: "DONE", symlinkParent: "docs/specs" },
  ], { args: SPEC });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RESULT PROTOCOL_ERROR: producer reported DONE but docs\/specs\/guest\.md is no longer valid: artifact must be inside the target worktree/);
  assert.equal(state.starts, 1);
});

test("a misplaced worker that refuses to stop is reported as residual", () => {
  const { result, state } = runScenario([{ disposition: "DONE" }], { scenario: { placeAt: "/tmp/some-other-repo", stopFails: true } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RESULT ORCA_ERROR: worker was placed in .*worker-stop failed, dispatch ctx_1 may still be running/);
  assert.deepEqual(state.stops, ["ctx_1"]);
  assert.deepEqual(state.releases, []);
});

test("a dot-prefixed artifact name inside the worktree is accepted", () => {
  const { result } = runScenario([
    { disposition: "DONE", write: { path: "docs/..draft.md", content: "v1\n" } },
    { disposition: "PASS" },
  ], { args: ["--mode", "spec", "--artifact", "docs/..draft.md"] });
  assert.equal(result.status, 0, result.stderr);
});

test("run_created records the resolved worktree", () => {
  const { root } = runScenario([{ disposition: "DONE" }], { scenario: { placeAt: "/tmp/elsewhere" } });
  const runDir = join(root, ".orca-loop", "run_test");
  const events = readFileSync(join(runDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const created = events.find((e) => e.event === "run_created");
  assert.equal(created.worktreePath, root);
  assert.equal(created.worktreeId, `fake-repo::${root}`);
  assert.equal(created.worktreeSelector, `path:${root}`);
});

test("a failed worker-start with a stray worktree id is still WORKER_FAILED", () => {
  const { result, state } = runScenario([], { scenario: { startFailures: 1, placeAt: "/tmp/elsewhere" }, config: { maxLaunchRetries: 0 } });
  assert.match(result.stderr, /RESULT WORKER_FAILED/);
  assert.deepEqual(state.stops, []);
});

test("an artifact whose parent is a regular file fails with a clear error", () => {
  const { result, state } = runScenario([], { args: ["--mode", "spec", "--artifact", "candidate.txt/guest.md"] });
  assert.match(result.stderr, /RESULT PROTOCOL_ERROR: artifact path is not usable: ENOTDIR/);
  assert.equal(state.starts, 0);
});

test("a blocked agent start reports Orca's reason and recovery command", () => {
  const { result, state } = runScenario([{ disposition: "DONE" }], { scenario: { blockedStartAt: 2 } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RESULT WORKER_FAILED: worker-start failed at stage agent_readiness: Agent startup blocked: agent-hooks-review-prompt/);
  assert.match(result.stderr, /Residual resources: terminal term_blocked/);
  assert.match(result.stderr, /Recovery: .*worker-release --dispatch ctx_2/);
  assert.equal(state.starts, 2);
  assert.deepEqual(state.releases, ["ctx_1"]);
});

test("describeStartFailure degrades gracefully on a bare receipt", () => {
  assert.equal(describeStartFailure({}), "worker-start failed");
  assert.equal(describeStartFailure({ failedStage: "x", lastError: { message: "boom" } }), "worker-start failed at stage x: boom");
  assert.equal(describeStartFailure({ ok: false, error: { code: "e", message: "m", data: { recovery: "do this" } } }), "worker-start failed (e): m. Recovery: do this");
});

test("recovery given as nextCommands is surfaced too", () => {
  const { result } = runScenario([{ disposition: "DONE" }], { scenario: { blockedStartAt: 2, recoveryAsNextCommands: true } });
  assert.match(result.stderr, /Recovery: orca orchestration worker-release --dispatch ctx_2 --json/);
});

test("a pre-dispatch start rejection reports Orca's error instead of 'omitted lifecycle IDs'", () => {
  const { result, state } = runScenario([], { scenario: { preDispatchFailureAt: 1 } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RESULT WORKER_FAILED: worker-start failed \(consumer_fenced\): worker-start requires the coordinator terminal/);
  assert.match(result.stderr, /Recovery: orca orchestration run-show --id run_test --json/);
  assert.doesNotMatch(result.stderr, /omitted lifecycle IDs/);
  assert.equal(state.starts, 1);
  assert.deepEqual(state.releases, []);
});
