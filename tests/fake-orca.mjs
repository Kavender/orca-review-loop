#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const scenarioPath = process.env.FAKE_ORCA_SCENARIO;
const statePath = process.env.FAKE_ORCA_STATE;
const root = process.env.ORCA_LOOP_ROOT;
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { starts: 0, completion: 0, current: null, heartbeatSent: false, pending: null,
      active: 0, maxActive: 0, commands: [], releases: [], acks: [], stops: [] };

const args = process.argv.slice(2).filter((arg) => arg !== "--json");
const command = args[0] === "orchestration" || args[0] === "worktree" ? `${args[0] === "worktree" ? "worktree-" : ""}${args[1]}` : args[0];
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const output = (result, status = 0) => {
  save();
  process.stdout.write(`${JSON.stringify({ ok: status === 0, result })}\n`);
  process.exitCode = status;
};

state.commands.push({ command, args });

if (command === "worktree-show") {
  const selector = value("--worktree") || "";
  const path = scenario.resolveTo || (selector.startsWith("path:") ? selector.slice(5) : root);
  output({ worktree: { id: `fake-repo::${path}`, path } });
} else if (command === "worker-stop") {
  state.stops.push(value("--dispatch"));
  if (scenario.stopFails) output({ error: { message: "stop refused" } }, 1);
  else output({ dispatchId: value("--dispatch"), state: "stopped" });
} else if (command === "status") {
  output({ runtime: { reachable: true, state: "ready" } });
} else if (command === "run-create") {
  output({ run: { id: "run_test" } });
} else if (command === "worker-start") {
  state.starts += 1;
  state.active += 1;
  state.maxActive = Math.max(state.maxActive, state.active);
  const role = value("--agent");
  const id = state.starts;
  state.current = { taskId: `task_${id}`, dispatchId: `ctx_${id}`, role };
  if (value("--task")) state.current.taskId = value("--task");
  state.heartbeatSent = false;
  state.pending = null;
  if (scenario.preDispatchFailureAt === id) {
    // Real shape when Orca rejects the start before creating a Dispatch: no result, no lifecycle IDs.
    save();
    process.stdout.write(`${JSON.stringify({ id: "fake", ok: false, error: { code: "consumer_fenced",
      message: "worker-start requires the coordinator terminal currently bound to the Task Run.",
      data: { nextCommands: ["orca orchestration run-show --id run_test --json"] } } })}\n`);
    process.exitCode = 1;
  } else if (scenario.blockedStartAt === id) {
    output({ runId: "run_test", taskId: state.current.taskId, dispatchId: state.current.dispatchId, state: "failed",
      stage: "agent_readiness", failedStage: "agent_readiness", lastError: "Agent startup blocked: agent-hooks-review-prompt",
      residualResources: [{ kind: "terminal", role: "agent", action: "created", id: "term_blocked" }],
      ...(scenario.recoveryAsNextCommands
        ? { nextCommands: [`orca orchestration worker-release --dispatch ${state.current.dispatchId} --json`] }
        : { recovery: `This start created a terminal that never ran the Task. Close it with: orca orchestration worker-release --dispatch ${state.current.dispatchId}` }) }, 1);
  } else if ((scenario.startFailures || 0) >= id) {
    output({ task: { id: state.current.taskId }, dispatch: { id: state.current.dispatchId },
      inputAccepted: false, failedStage: "before_input" }, 1);
  } else {
    const selector = value("--worktree") || "";
    const placed = scenario.placeAt || (selector.startsWith("id:fake-repo::") ? selector.slice("id:fake-repo::".length) : root);
    output({ task: { id: state.current.taskId }, dispatch: { id: state.current.dispatchId }, terminal: { handle: `term_${id}` },
      resolvedWorktreeId: `fake-repo::${placed}` });
  }
} else if (command === "check" && value("--ack")) {
  state.acks.push(value("--ack"));
  state.pending = null;
  output({ acknowledged: true });
} else if (command === "check") {
  if (state.pending) {
    output({ delivery: state.pending });
  } else if (!state.heartbeatSent && !scenario.skipHeartbeat) {
    state.heartbeatSent = true;
    state.pending = {
      id: `delivery_h_${state.starts}`,
      messages: [{ type: "heartbeat", run_id: "run_test", payload: JSON.stringify(state.current) }],
    };
    output({ delivery: state.pending });
  } else if ((scenario.timeoutsBeforeCompletion || 0) > (state.timeouts || 0)) {
    state.timeouts = (state.timeouts || 0) + 1;
    output({ timedOut: true, delivery: { id: `empty_${state.timeouts}`, messages: [] } });
  } else if (state.completion < scenario.completions.length) {
    const item = scenario.completions[state.completion++];
    if (item.mutate) appendFileSync(`${root}/candidate.txt`, item.mutate);
    if (item.symlinkParent) {
      const outside = join(dirname(root), `outside_${state.completion}`);
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "guest.md"), "outside\n");
      mkdirSync(dirname(join(root, item.symlinkParent)), { recursive: true });
      symlinkSync(outside, join(root, item.symlinkParent));
    }
    if (item.write) {
      const target = join(root, item.write.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, item.write.content ?? "");
    }
    const payload = {
      taskId: item.wrongTask ? "task_stale" : state.current.taskId,
      dispatchId: item.wrongDispatch ? "ctx_stale" : state.current.dispatchId,
      outcome: item.outcome || "succeeded",
    };
    const message = {
      type: item.type || "worker_done",
      run_id: item.wrongRun ? "run_stale" : "run_test",
      subject: item.subject || `${item.disposition}: ${item.summary || "test"}`,
      body: item.body || `${item.disposition || item.type} body`,
      payload: item.objectPayload ? payload : JSON.stringify(payload),
    };
    state.pending = { id: `delivery_c_${state.completion}`, messages: [message] };
    output({ delivery: state.pending });
  } else {
    output({ timedOut: true, delivery: { id: `empty_${state.commands.length}`, messages: [] } });
  }
} else if (command === "worker-list") {
  output({ workers: [{ dispatchId: state.current?.dispatchId, projection: { liveness: { verdict: scenario.liveness || "unverifiable" } } }] });
} else if (command === "worker-show") {
  output({ worker: { dispatchId: value("--dispatch"), observation: { status: scenario.liveness || "unverifiable" } } });
} else if (command === "worker-read") {
  output({ dispatchId: value("--dispatch"), content: "fake bounded transcript" });
} else if (command === "worker-release" || command === "worker-retain") {
  const dispatch = value("--dispatch");
  state.releases.push(dispatch);
  state.active = Math.max(0, state.active - 1);
  output({ dispatchId: dispatch, state: command === "worker-release" ? "released" : "retained" });
} else {
  output({ error: { message: `unsupported fake command: ${command}` } }, 1);
}
