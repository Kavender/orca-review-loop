# Orca Review Loop

A reusable deterministic controller and Codex Skill for this workflow:

```text
implementer produces → reviewer checks → PASS
                             ↓ NEEDS_FIX
                 implementer revises → fresh review
```

Each role can be any agent Orca can launch (Claude Code, Codex, Cursor Agent, OpenCode, ...), with its own model and thinking effort. Out of the box Claude Code implements and Codex reviews; `orca-review-loop setup` changes either.

It runs in two modes over the same controller:

- `--mode code` (default): the implementer writes and repairs code; the reviewer checks the working-tree diff for bugs, regressions, and missing tests.
- `--mode spec`: the implementer creates or revises one specification file; the reviewer checks that document for implementation readiness.

The controller uses Orca's durable Run, Task, Dispatch, and mailbox lifecycle. It runs one worker at a time, distinguishes lifecycle success from review approval, forwards exact review feedback, and defaults to at most five reviews.

## Requirements

- Node.js 22 or newer
- The Orca CLI (`orca`) on your `PATH`, with the agents you choose configured in Orca (by default Claude Code and Codex)

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

Setup discovers the models currently offered by the installed Claude Code and Codex CLIs, then lets you choose the model and thinking effort independently for implementation and review, plus the maximum number of review rounds (default 5; each round costs one implement and one review turn). Discovery runs from an isolated temporary directory and filters Claude session/router aliases that Orca cannot forward. Codex effort choices are specific to the selected model. Choosing `default` stores `null` and leaves that setting to the agent; you can also enter an opaque model or effort value manually when using a newer or custom configuration. An agent without a discovery adapter requires explicit confirmation before it is saved.

In a terminal, setup is an arrow-key picker (number keys also work). Inside a Claude Code session, use the bundled skill instead so choices are presented with Claude Code's own question UI:

```bash
ln -s "$(npm root -g)/orca-review-loop/skills/orca-review-loop-setup" ~/.claude/skills/orca-review-loop-setup
# then in Claude Code: /orca-review-loop-setup
```

The skill and any script can use the non-interactive forms:

```bash
orca-review-loop setup --discover --json     # agents Orca knows, which CLIs are installed, live models/efforts, current config
orca-review-loop setup --set implement.agent=claude --set implement.model=opus --set implement.effort=high \
                       --set review.agent=codex --set maxRounds=5
```

Agents are not limited to Claude and Codex. Setup lists every agent id the installed Orca CLI advertises (claude, codex, cursor, antigravity, muse, opencode, zcode, ...) and accepts any other id you type; model and effort are only offered for agents Orca lets you launch with `--model`. Live model discovery currently exists for Claude Code and Codex; other agents take a manual model id or `default`.

Interactive setup requires a terminal. It previews the result before atomically creating or updating `.orca-loop.json`, preserves unrelated settings, and never launches an Orca worker. Use `orca-review-loop setup --config <path>` for another config file inside the target project.

Run it from any target repository:

```bash
cd /path/to/project
orca-review-loop --task "Fix the bug and add regression coverage"
```

Use `--task-file <path>` for a longer specification. The target worktree must be clean unless `--allow-dirty` is explicitly supplied.

### Spec mode

```bash
orca-review-loop \
  --mode spec \
  --task "Design guest access with abuse protection" \
  --artifact docs/specs/guest-access.md
```

`--artifact` names the one file the implementer may deliver. It must be a regular file inside the target worktree (symlinks are rejected); if it does not exist the implementer creates it, otherwise it revises it in place. The controller verifies the file was actually produced before each review, and tracks its content even when the path is git-ignored. The reviewer checks the document and returns `PASS:` only when it is implementation-ready; its review body separates blocking findings from optional suggestions, and only blocking findings justify another round.

The two modes form a natural two-stage workflow, run by hand:

```bash
orca-review-loop --mode spec --task "..." --artifact docs/specs/guest-access.md   # until PASS
orca-review-loop --mode code --task-file docs/specs/guest-access.md               # then implement it
```

After a spec-mode `PASS` the controller prints that suggested code-mode command. It does not start it automatically. The controller never commits, pushes, merges, resets, cleans, or stashes; review the resulting diff and commit it yourself.

Defaults can be overridden with a `.orca-loop.json` in the target project root (see [`examples/orca-loop.config.json`](examples/orca-loop.config.json)). Runtime state lives under `.orca-loop/`, which you should add to the target project's `.gitignore`.

An explicit `effort` requires an explicit `model`; invalid role configuration is rejected before the controller contacts Orca. Users who skip setup retain the built-in Claude/Codex defaults; a run with no config file prints the workers it is using and points to `orca-review-loop setup`.

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

Tests use a stateful fake Orca executable and do not require any agent accounts.

## Releasing

```bash
npm version <patch|minor|major>
git push --follow-tags
npm publish
```
