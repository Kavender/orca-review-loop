# Agent configuration setup: implementation plan

Status: ready for implementation  
Target branch: `feat/setup-agent-configuration`

## Problem

The controller already reads `implement.agent`, `implement.model`, `implement.effort`, and the equivalent `review` fields from `.orca-loop.json`, and forwards explicit model and effort pins to `orca orchestration worker-start`. Users currently have to discover valid values and edit JSON by hand. Runtime validation also permits an `effort` without a `model`, although Orca rejects that combination.

The setup experience should make the existing configuration contract usable without embedding a model catalogue that will become stale.

## Scope

Add a guided command:

```text
orca-review-loop setup [--config <path>]
```

It configures the implement and review workers, discovers current model and effort choices from installed Claude Code and Codex CLIs, previews the resulting configuration, and writes the selected values to the target project's config file.

This release keeps the controller's current role model: `implement` defaults to Claude and `review` defaults to Codex. Agent IDs remain editable so an existing advanced configuration is not trapped, but live model discovery is guaranteed only for `claude` and `codex`.

## User flow

1. Resolve the target root exactly as normal runs do and load `.orca-loop.json`, or the path supplied with `--config`.
2. If the config exists, use its current implement/review values as prompt defaults. Refuse malformed JSON before asking questions or writing.
3. Ask for the implement agent and review agent, defaulting to `claude` and `codex` when absent.
4. For each role, probe the selected installed harness when a supported discovery adapter exists.
5. Offer `default` first, followed by the live model choices. Also accept a manually entered opaque model ID for forward compatibility.
6. When an explicit model is selected, offer only the effort values reported for that model. For Claude, use the effort choices returned by its local command. For Codex, use that model's `supported_reasoning_levels`.
7. Show a final two-row summary and ask before replacing an existing config. A newly created config also gets a final confirmation.
8. Write only after confirmation, then print the config path and a copy-pasteable command for starting a run.

The literal interactive choice `default` is stored as `null`, matching current controller behavior: omit `--model` or `--effort` and let the harness choose its configured default.

## Discovery design

Keep discovery code separate from the review-loop controller. Store adapter mechanics, not model names.

### Claude Code

- Check that `claude` is executable.
- Run `claude -p /model --output-format json` and parse the `result` field's `Available:` list.
- Run `claude -p /effort --output-format json` and parse the reported effort alternatives.
- Treat `is_error: true`, non-JSON output, nonzero exit, timeout, or an empty parsed catalogue as discovery unavailable.

These slash-command probes are local in current Claude Code: the observed receipts report `num_turns: 0`, `duration_api_ms: 0`, and `total_cost_usd: 0`. Tests must still use fakes and must not depend on an installed or authenticated Claude CLI.

### Codex CLI

- Check that `codex` is executable.
- Run `codex debug models` and parse the JSON object.
- Exclude models whose `visibility` is `hide`.
- Read effort choices from each selected model's `supported_reasoning_levels`; do not create one global Codex effort list.
- Treat non-JSON output, nonzero exit, timeout, or an empty usable catalogue as discovery unavailable.

### Fallback

If a CLI is missing or discovery fails, explain the reason and offer `default` or a manual opaque model ID. An explicit manual model may also use a manual effort value. For a manually entered Codex model that is absent from discovery, make clear that its effort cannot be verified. If the agent is not backed by a discovery adapter, preserve an existing pin unless the user explicitly replaces it, and warn that Orca or that agent may reject unsupported model/effort flags.

Discovery launches no Orca Run or worker and writes no harness settings.

## Configuration and validation

Extract config loading, merging, and validation into reusable functions shared by `setup` and normal execution.

Validate before contacting Orca or launching workers:

- `implement` and `review` must be objects.
- `agent` must be a non-empty string.
- `model` and `effort` must each be `null` or a non-empty string.
- A non-null `effort` requires a non-null `model`.
- Existing numeric and enum validation remains unchanged.

The setup writer updates only `implement` and `review`, preserves every unrelated top-level key, formats JSON with two spaces and a trailing newline, and replaces the destination atomically. It must not follow a symlink at the destination. Cancellation and discovery failure leave the file byte-for-byte unchanged.

## CLI structure

- Dispatch `setup` before the existing run argument parser so current invocations and help text remain backward compatible.
- Add `orca-review-loop setup --help` and mention setup in top-level help.
- Implement prompts with Node built-ins; add no runtime dependency.
- Require an interactive terminal for this first version and fail clearly instead of hanging when standard input or output is not a TTY. Non-interactive configuration remains available by writing the documented JSON schema.
- Keep prompt and discovery functions injectable/exported so tests can drive them without real CLIs or a TTY.
- Return `0` after a successful write or explicit cancellation, and `1` for invalid configuration, unsafe destination, or unrecoverable prompt/discovery errors.

## Planned file changes

- `skills/orca-review-loop/scripts/orca-review-loop.mjs`: command dispatch, shared config validation, and the runtime fix for effort-without-model.
- `skills/orca-review-loop/scripts/setup.mjs`: prompts, discovery adapters, selection logic, preview, and atomic config update.
- `tests/orca-review-loop.test.mjs`: runtime validation and command dispatch coverage.
- `tests/setup.test.mjs`: discovery parsing, interactive flows, preservation, cancellation, and write-safety coverage.
- `README.md`: add setup to quickstart and explain `default`/manual pins.
- `skills/orca-review-loop/SKILL.md`: tell an agent when and how to invoke setup before a run.
- `skills/orca-review-loop/references/usage.md`: detailed configuration, discovery, and failure behavior.
- `examples/orca-loop.config.json`: retain the current schema and annotate it through surrounding documentation rather than adding non-JSON comments.

## Test matrix

Unit and subprocess tests will cover:

- Claude model/effort receipt parsing, including malformed and empty results.
- Codex model filtering and model-specific effort choices.
- Missing binary, probe timeout, nonzero exit, and malformed output fallback.
- Fresh config creation with defaults and with explicit pins.
- Existing config defaults preselected; unrelated keys preserved.
- Manual opaque model entry.
- `default` represented as `null` and never forwarded as a literal flag value.
- Effort omitted when model is default; effort-without-model rejected in both setup and normal runs.
- Invalid role shapes and empty strings rejected before `orca status` or `worker-start`.
- Cancellation, an invalid answer, or aborting after failed discovery does not change an existing file.
- Symlink destination refusal and atomic replacement.
- Existing `--task`, `--task-file`, code mode, and spec mode behavior remains green.

No test invokes a real Claude, Codex, or Orca worker. After the automated suite passes, perform one manual setup smoke test against the installed Claude/Codex discovery commands, inspect the generated JSON, and use the fake Orca harness to verify the selected flags. A paid worker E2E is optional because setup itself does not launch workers.

## Acceptance criteria

- A new user can run `orca-review-loop setup`, choose model and thinking effort for both roles, and obtain a valid `.orca-loop.json` without hand-editing JSON.
- Offered choices come from the currently installed harnesses; the package contains no versioned model-name catalogue.
- Codex effort choices are constrained to the selected model.
- The controller rejects invalid pins before creating an Orca Run or worker.
- Re-running setup safely edits only role configuration and preserves all other settings.
- Existing users who never run setup keep the current Claude/Codex defaults and all current run commands continue to work.
- `npm test` and `npm run validate:skill` pass.

## Out of scope

- Installing or authenticating agent CLIs.
- Changing Claude or Codex global defaults.
- Starting trust dialogs or answering them for the user.
- Maintaining a static model catalogue.
- Probing arbitrary third-party agents beyond the explicit Claude and Codex adapters.
- A non-interactive setup flag API.
- Launching a review loop automatically at the end of setup.
