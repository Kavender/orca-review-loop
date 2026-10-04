# Automated Orca review–fix loop

`orca-review-loop` runs one deterministic, serial workflow in the current worktree:

```text
Claude produce → Codex review
                  ├─ PASS → finish
                  ├─ NEEDS_FIX → Claude revise → fresh Codex review
                  └─ BLOCKED → stop for a human
```

The same controller runs in two modes; only the worker prompts differ.

The controller creates one fresh Orca Run per invocation. It starts exactly one worker at a time, validates every completion against the expected Run, Task, and Dispatch, releases each settled worker, and uses Codex's exact review subject/body in the next Claude repair prompt. It never uses an LLM as the coordinator.

## Usage

Run the guided setup once per project, or whenever worker pins need to change:

```bash
orca-review-loop setup
```

It requires an interactive terminal. Setup asks for each role's agent, model, and thinking effort; shows a preview; and then creates or updates `.orca-loop.json`. It preserves unrelated top-level settings and never creates an Orca Run or worker. Pass `--config <path>` to update another config file inside the target project.

For Claude, setup reads the live choices from the installed CLI's local `/model` and `/effort` commands. For Codex, it reads `codex debug models`, excludes hidden entries, and offers the reasoning levels declared by the selected model. A discovery failure is reported and falls back to `default` or manual opaque values. The package does not ship a model-name catalogue.

Choosing `default` writes `null`. At runtime that means the corresponding flag is omitted and the agent's own configured default applies. An explicit effort requires an explicit model.

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

## Modes

```text
--mode code   (default) Claude implements/repairs code; Codex reviews the working-tree diff
--mode spec             Claude creates/revises one spec file; Codex reviews that document
```

Omitting `--mode` is identical to v1 behavior. A `"mode"` key in `.orca-loop.json` sets the default; the CLI flag wins.

Spec mode requires `--artifact <path>`:

- The path is resolved against the caller's current directory, like `--task-file`, and must stay inside the target project root after resolving symlinks; a symlinked artifact or a non-regular file is rejected.
- `--artifact` is rejected in code mode.
- After each Claude `DONE:` the controller checks the artifact exists as a regular file before starting the reviewer; otherwise it stops with `PROTOCOL_ERROR`.
- If the file does not exist, Claude is told to create it; otherwise to revise it in place.
- Claude is instructed to deliver only that file (closely related supporting spec files must be listed in its completion body). This is a prompt-level rule, not enforced by the controller.
- Codex is told it is reviewing a document, not code, and must not modify any file.

Spec-mode PASS criteria given to Codex: requirements clear, scope bounded, acceptance criteria testable, important edge and failure behavior defined, dependencies and assumptions explicit, no major contradictions, no ambiguity likely to cause significant rework. The review body is structured as `Blocking findings:` followed by `Optional suggestions:`; only blocking findings justify `NEEDS_FIX:`.

On a spec-mode `PASS` the controller prints a suggested `--mode code --task-file <artifact>` command. It never starts it.

Reviewer read-only protection, no-progress detection, and the review-round cap work identically in both modes. The working-tree snapshot additionally hashes the artifact's existence, type, and content directly, so a spec under a git-ignored directory is still observed. Note that an ignored artifact will not appear in `git status`; commit it deliberately.

`maxRounds` counts Codex review attempts. With the default of five, review five returning `NEEDS_FIX` produces `MAX_ROUNDS`; no sixth Claude repair is launched.

## Configuration

Built-in defaults can be overridden by a `.orca-loop.json` file in the target project's root. A complete example is included in the repository at `examples/orca-loop.config.json`.

- Claude implements and repairs; Codex reviews.
- `implement.agent`, `implement.model`, and `implement.effort` select the implementation worker. The corresponding `review` fields select the reviewer. Agent must be a non-empty string; model and effort are either non-empty strings or `null`. An effort without a model is rejected before Orca is contacted.
- `worktree: "current"` means the directory the controller runs in. Before creating the Run, the controller resolves the configured selector with `orca worktree show` (`current` becomes `path:<that directory>`), requires the resolved path to equal its own directory, and passes the resolved worktree ID to every `worker-start`. Any selector that resolves elsewhere stops with `ORCA_ERROR` before any worker exists, because git hashing, artifact checks, and mutation detection all run against the controller's directory. If a start receipt still reports a different worktree, that worker is stopped and released before the controller exits with `ORCA_ERROR`. Consequently `worktree` only accepts selectors that resolve to the controller's directory; creation selectors such as `new-child` or `new-top-level` are rejected.
- Workers use the agent's configured model unless `model` is explicitly set. `effort` is only passed with an explicit model.
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

These prefixes are the same in both modes. The verdict is parsed only from the subject prefix. A lifecycle payload with `outcome=succeeded` means the worker completed its assigned phase; it does not mean the code passed review.

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
