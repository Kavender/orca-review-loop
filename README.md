# Orca Review Loop

A reusable deterministic controller and Codex Skill for this workflow:

```text
Claude implements → Codex reviews → PASS
                         ↓ NEEDS_FIX
                   Claude repairs → fresh Codex review
```

The controller uses Orca's durable Run, Task, Dispatch, and mailbox lifecycle. It runs one worker at a time, distinguishes lifecycle success from review approval, forwards exact review feedback, and defaults to at most five Codex reviews.

## CLI

Install from a local checkout or Git URL:

```bash
npm install -g /path/to/orca-review-loop
```

Run it from any target repository:

```bash
cd /path/to/project
orca-review-loop --task "Fix the bug and add regression coverage" --max-rounds 5
```

The target worktree must be clean unless `--allow-dirty` is explicitly supplied. The controller never commits, pushes, merges, resets, cleans, or stashes.

## Codex Skill

The reusable Skill is in `skills/orca-review-loop`. Install that folder with your normal Codex Skill installation workflow, then invoke `$orca-review-loop` from a target project.

Detailed configuration, protocol, recovery, and result statuses are documented in [the Skill usage reference](skills/orca-review-loop/references/usage.md).

## Development

```bash
npm test
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/orca-review-loop
```

Tests use a stateful fake Orca executable and do not require Claude or Codex accounts.
