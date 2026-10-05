# Orca Review Loop

A reusable deterministic controller and Codex Skill for this workflow:

```text
Claude produces → Codex reviews → PASS
                        ↓ NEEDS_FIX
                  Claude revises → fresh Codex review
```

It runs in two modes over the same controller:

- `--mode code` (default): Claude implements and repairs code; Codex reviews the working-tree diff for bugs, regressions, and missing tests.
- `--mode spec`: Claude creates or revises one specification file; Codex reviews that document for implementation readiness.

The controller uses Orca's durable Run, Task, Dispatch, and mailbox lifecycle. It runs one worker at a time, distinguishes lifecycle success from review approval, forwards exact review feedback, and defaults to at most five Codex reviews.

## Requirements

- Node.js 22 or newer
- The Orca CLI (`orca`) on your `PATH`, with Claude Code and Codex configured as Orca agents

The controller drives both agents through Orca; it does not call any model API itself.

## CLI

Install from npm:

```bash
npm install -g orca-review-loop
```

Or install straight from the repository:

```bash
npm install -g github:Kavender/orca-review-loop
```

Configure the two workers in the target project:

```bash
cd /path/to/project
orca-review-loop setup
```

Setup discovers the models currently offered by the installed Claude Code and Codex CLIs, then lets you choose the model and thinking effort independently for implementation and review. Discovery runs from an isolated temporary directory and filters Claude session/router aliases that Orca cannot forward. Codex effort choices are specific to the selected model. Choosing `default` stores `null` and leaves that setting to the agent; you can also enter an opaque model or effort value manually when using a newer or custom configuration. An agent without a discovery adapter requires explicit confirmation before it is saved.

Setup requires an interactive terminal. It previews the result before atomically creating or updating `.orca-loop.json`, preserves unrelated settings, and never launches an Orca worker. Use `orca-review-loop setup --config <path>` for another config file inside the target project.

Run it from any target repository:

```bash
cd /path/to/project
orca-review-loop --task "Fix the bug and add regression coverage" --max-rounds 5
```

Use `--task-file <path>` for a longer specification. The target worktree must be clean unless `--allow-dirty` is explicitly supplied.

### Spec mode

```bash
orca-review-loop \
  --mode spec \
  --task "Design guest access with abuse protection" \
  --artifact docs/specs/guest-access.md
```

`--artifact` names the one file Claude may deliver. It must be a regular file inside the target worktree (symlinks are rejected); if it does not exist Claude creates it, otherwise Claude revises it in place. The controller verifies Claude actually produced it before each review, and tracks its content even when the path is git-ignored. Codex reviews the document and returns `PASS:` only when it is implementation-ready; its review body separates blocking findings from optional suggestions, and only blocking findings justify another round.

The two modes form a natural two-stage workflow, run by hand:

```bash
orca-review-loop --mode spec --task "..." --artifact docs/specs/guest-access.md   # until PASS
orca-review-loop --mode code --task-file docs/specs/guest-access.md               # then implement it
```

After a spec-mode `PASS` the controller prints that suggested code-mode command. It does not start it automatically. The controller never commits, pushes, merges, resets, cleans, or stashes; review the resulting diff and commit it yourself.

Defaults can be overridden with a `.orca-loop.json` in the target project root (see [`examples/orca-loop.config.json`](examples/orca-loop.config.json)). Runtime state lives under `.orca-loop/`, which you should add to the target project's `.gitignore`.

An explicit `effort` requires an explicit `model`; invalid role configuration is rejected before the controller contacts Orca. Users who skip setup retain the built-in Claude/Codex defaults.

## Codex Skill

The CLI is all you need to run the loop from a terminal or from a Claude Code session. If you also want to trigger it from inside a Codex session with `$orca-review-loop`, expose the Skill folder to Codex:

```bash
npm install -g orca-review-loop
ln -s "$(npm root -g)/orca-review-loop/skills/orca-review-loop" ~/.codex/skills/orca-review-loop
```

Detailed configuration, protocol, recovery, and result statuses are documented in [the Skill usage reference](skills/orca-review-loop/references/usage.md).

## Development

```bash
npm test
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/orca-review-loop
```

Tests use a stateful fake Orca executable and do not require Claude or Codex accounts.

## Releasing

```bash
npm version <patch|minor|major>
git push --follow-tags
npm publish
```
