---
name: orca-review-loop-setup
description: Guided, in-session configuration of the Orca Review Loop workers (which Orca agent, model, and thinking effort implement and review, plus max review rounds). Use when the user asks to set up, configure, or change the review loop's agents or models, or when a loop run fails because an agent/model is not configured. Presents choices with AskUserQuestion instead of a terminal prompt.
---

# Orca Review Loop setup (Claude Code)

Drive `orca-review-loop setup` through its non-interactive subcommands and let the user pick with
`AskUserQuestion`. Never run the bare interactive `orca-review-loop setup` from inside a Claude Code
session: it needs a TTY you do not have, and its prompts cannot be answered here.

## 1. Discover

From the target project root:

```bash
orca-review-loop setup --discover --json
```

The JSON contains `current` (implement/review roles and `maxRounds` as configured today), `path`
(the config file, usually `.orca-loop.json`), and `agents`: every Orca agent harness this CLI knows,
with `installed` (CLI found on PATH), `supportsModel` (whether Orca accepts `--model`/`--effort`
for it; `null` = unknown), and `discovery.models[]` with per-model `efforts[]` when live discovery
succeeded. Do not invent models: offer only what discovery returned, plus "default" and "type a model id".

If `orca-review-loop` is not found, tell the user to `npm install -g orca-review-loop` and stop.

## 2. Ask, one role at a time

Use **one** `AskUserQuestion` call per role with up to three questions (agent, model, effort) so the
user sees tabs for the role. Ask `implement` first, then `review`, then one question for max rounds.

- **Agent**: list installed agents first; mark uninstalled ones "(CLI not on this machine)" but keep them
  selectable, since the Orca worker server may differ. Pre-select the current agent.
- **Model**: skip entirely when the chosen agent has `supportsModel: false` and say why in one line
  ("<agent> launches with the model from its own config"). Otherwise options are: `default` (agent's
  own setting), each discovered model id, and "Other" for a manual id. Pre-select the current model.
- **Effort**: ask only when a model was chosen. Options are the discovered efforts for that model
  (`efforts`, or `defaultEfforts` if the model is manual) plus `default`. An effort without a model is
  invalid; the CLI will reject it.
- **Max review rounds**: integer 1-20, default to `current.maxRounds`.

If the user's agent isn't in the list, let them type an id and warn once that setup cannot validate it.

## 3. Preview and write

Show a short table (role / agent / model / effort, then max rounds) and ask for confirmation. Then:

```bash
orca-review-loop setup \
  --set implement.agent=<id> --set implement.model=<id|default> --set implement.effort=<level|default> \
  --set review.agent=<id>    --set review.model=<id|default>    --set review.effort=<level|default> \
  --set maxRounds=<n> --json
```

Changing an agent via `--set` clears that role's model and effort unless you set them in the same
command. Report the CLI's own output; if it rejects a value, show the error and re-ask that field only.

## 4. Finish

Confirm the file written and suggest the next command, e.g.
`orca-review-loop --task "<task>"` or `orca-review-loop --mode spec --task "..." --artifact <path>`.
Do not start a review loop unless the user asked for one.
