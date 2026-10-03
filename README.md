# Orca Review Loop

A reusable deterministic controller and Codex Skill for this workflow:

```text
Claude implements → Codex reviews → PASS
                         ↓ NEEDS_FIX
                   Claude repairs → fresh Codex review
```

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

Run it from any target repository:

```bash
cd /path/to/project
orca-review-loop --task "Fix the bug and add regression coverage" --max-rounds 5
```

Use `--task-file <path>` for a longer specification. The target worktree must be clean unless `--allow-dirty` is explicitly supplied. The controller never commits, pushes, merges, resets, cleans, or stashes; review the resulting diff and commit it yourself.

Defaults can be overridden with a `.orca-loop.json` in the target project root (see [`examples/orca-loop.config.json`](examples/orca-loop.config.json)). Runtime state lives under `.orca-loop/`, which you should add to the target project's `.gitignore`.

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
