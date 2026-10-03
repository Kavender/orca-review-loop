# Automated Orca review–fix loop

`orca-review-loop` runs one deterministic, serial workflow in the current worktree:

```text
Claude implementation → Codex review
                         ├─ PASS → finish
                         ├─ NEEDS_FIX → Claude repair → fresh Codex review
                         └─ BLOCKED → stop for a human
```

The controller creates one fresh Orca Run per invocation. It starts exactly one worker at a time, validates every completion against the expected Run, Task, and Dispatch, releases each settled worker, and uses Codex's exact review subject/body in the next Claude repair prompt. It never uses an LLM as the coordinator.

## Usage

```bash
orca-review-loop \
  --task "Fix the bug and add regression coverage" \
  --max-rounds 5
```

For a longer request:

```bash
orca-review-loop --task-file ./request.md --max-rounds 5
```

The worktree must be clean by default. `--allow-dirty` is an explicit override for a deliberately preserved baseline; the controller still checks that Codex did not mutate that baseline during review.

`maxRounds` counts Codex review attempts. With the default of five, review five returning `NEEDS_FIX` produces `MAX_ROUNDS`; no sixth Claude repair is launched.

## Configuration

Built-in defaults can be overridden by a `.orca-loop.json` file in the target project's root. A complete example is included in the repository at `examples/orca-loop.config.json`.

- Claude implements and repairs; Codex reviews.
- Workers use the user's configured model unless `model` is explicitly set. `effort` is only passed with a model.
- A worker gets 60 seconds to acknowledge its dispatch and 15 minutes per mailbox wait.
- Three empty waits trigger worker inspection.
- Full task and review bodies are not written to the JSONL event log by default.
- Settled terminals are released, not retained.

Use `--config <path>` for another JSON configuration, `--max-rounds` for a one-run override, and `--verbose-log` only when storing review text locally is acceptable. `ORCA_CLI_COMMAND` can point to a version-matched Orca executable or a test double.

Runtime prompts and abnormal-run metadata are stored under ignored `.orca-loop/<run-id>/`. Successful runs remove their local directory. Abnormal runs retain it for diagnosis.

## Message protocol

Claude completion subjects must begin with exactly one of:

```text
DONE:
BLOCKED:
NEEDS_REPLAN:
```

Codex completion subjects must begin with exactly one of:

```text
PASS:
NEEDS_FIX:
BLOCKED:
```

The verdict is parsed only from the subject prefix. A lifecycle payload with `outcome=succeeded` means the worker completed its assigned phase; it does not mean the code passed review.

Before a message can advance the loop, the controller checks its type, Run, Task ID, Dispatch ID, lifecycle outcome, and allowed subject. Stale messages are ignored and cannot advance the state machine. Deliveries are acknowledged only after their messages have been processed.

## Results and safety boundaries

Terminal results include:

- `PASS`
- `MAX_ROUNDS`
- `BLOCKED`
- `NEEDS_REPLAN`
- `NO_PROGRESS`
- `WORKER_FAILED`
- `PROTOCOL_ERROR`
- `REVIEWER_MUTATED_WORKTREE`
- `ORCA_ERROR`
- `NEEDS_HUMAN`

The controller never commits, merges, pushes, force-pushes, resets, cleans, or stashes. Its worker prompts prohibit those operations too. It does not automatically answer questions or escalations. Ambiguous liveness produces `NEEDS_HUMAN`; it never launches a duplicate editor merely because a wait or heartbeat timed out.

One launch retry is allowed only when `worker-start` itself fails and its structured receipt explicitly proves that task input was not accepted. The retry reuses the same Task with `--retry-of`; missing heartbeats, timeouts, and `unverifiable` liveness do not qualify.

No-progress detection stops when a repair leaves the working tree unchanged and Codex repeats the same review feedback.

## Inspection and recovery

Use Orca's durable mailbox and worker records:

```bash
orca orchestration inbox --limit 50 --full --json
orca orchestration worker-list --run <run-id> --json
orca orchestration worker-show --dispatch <dispatch-id> --json
orca orchestration worker-read --dispatch <dispatch-id> --source auto --limit 200 --json
orca orchestration run-show --id <run-id> --json
```

On abnormal termination, inspect the recorded active Dispatch before taking action. Absence or `unverifiable` liveness is not proof that a worker stopped. Do not relaunch an editor until Orca provides positive lifecycle evidence.

To disable the feature, stop invoking or uninstall `orca-review-loop`. This does not alter or erase product changes already present in the target worktree.

## Tests

The test suite uses a stateful fake Orca runtime and requires no Claude or Codex account:

```bash
npm test
```

It covers first-pass success, repeated repairs, the five-review cap, strict lifecycle correlation, serialized/object payloads, questions and escalations, review mutation, no-progress detection, timeout checkpoints, release/ack accounting, and ambiguous-liveness safety.
