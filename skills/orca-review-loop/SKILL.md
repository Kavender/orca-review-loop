---
name: orca-review-loop
description: Run a reusable, supervised implement / review loop between Orca agents (Claude Code implements and Codex reviews by default; any Orca agent can fill either role), for code changes (--mode code) or a specification document (--mode spec). Use when a user wants one task implemented or one spec written, independently reviewed, automatically revised from NEEDS_FIX feedback, and re-reviewed until PASS or a bounded stop condition.
---

# Orca Review Loop

Use the deterministic controller in `scripts/orca-review-loop.mjs`; do not coordinate the loop by manually copying findings between agents.

## Before running

1. Work from the target project's root directory.
2. Resolve the session's Orca executable and load its version-matched orchestration guide with `orca skills get orchestration --json` (or the executable selected by the Orca CLI discovery rules).
3. If the user wants to select worker models, thinking effort, or the max review rounds, have them run `orca-review-loop setup` in an interactive terminal from the project root. It lets them pick any Orca agent per role, discovers live model choices for Claude Code and Codex, and updates `.orca-loop.json` without starting a worker. Do not start interactive setup inside a non-interactive command session.
4. Inspect the target worktree. The controller refuses dirty work by default; use `--allow-dirty` only when the user deliberately accepts that baseline.
5. Confirm the task is concrete enough for an implementer and independent reviewer. Do not broaden its authority.

## Run

Invoke the bundled script from the target project's root:

```bash
node <skill-directory>/scripts/orca-review-loop.mjs \
  --task "<user task>"
```

Pass `--max-rounds <n>` only when the user asks for a different limit for this run; otherwise the configured `maxRounds` (default 5) applies.

For a specification document instead of code:

```bash
node <skill-directory>/scripts/orca-review-loop.mjs \
  --mode spec \
  --task "<what the spec must cover>" \
  --artifact docs/specs/<name>.md
```

`--artifact` is required in spec mode and must be inside the target worktree. Use `--task-file <path>` for long task specifications. The controller creates a fresh Run, starts one worker at a time, routes the reviewer's exact feedback to a fresh implementer repair worker, and stops at `PASS`, the review limit, or a safety boundary.

Do not automatically answer worker questions, override escalations, clean a worktree, or relaunch a worker whose liveness is ambiguous. Those outcomes require the user or explicit Orca recovery evidence.

Report the controller's final status, review round, verification evidence, and any retained abnormal-run path. Never describe lifecycle `outcome=succeeded` as review approval; only a `PASS:` review subject is approval. In code mode `PASS` means the diff passed review; in spec mode it means the document was judged implementation-ready. After a spec-mode `PASS`, relay the suggested code-mode command the controller prints; do not start it unprompted.

Read [references/usage.md](references/usage.md) when configuring the controller, diagnosing an abnormal Run, or explaining its protocol and result statuses.
