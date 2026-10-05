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

## 2. Ask, one dependent question at a time

Each answer determines the next question's options, and `AskUserQuestion` builds all of a call's
questions up front. So ask **sequentially**, one `AskUserQuestion` call per step, and derive each
step's options from the previous answer. Do not bundle agent, model, and effort into one call.

For `implement`, then for `review`:

1. **Agent** — one question. List installed agents first; mark uninstalled ones "(CLI not on this
   machine)" but keep them selectable, since the Orca worker server may differ. Pre-select the current
   agent. If the user picks "Other" and types an id that discovery does not know, warn once that setup
   cannot validate it.
2. **Model** — only after the agent is known, and only if that agent's `supportsModel` is not
   `false`. If it is `false`, skip with one line ("<agent> launches with the model from its own
   config") and go to the next role. Otherwise the options are `default` (agent's own setting), each
   id in *that agent's* `discovery.models`, and "Other" for a manual id. Pre-select the current model
   only if the agent did not change.
3. **Effort** — only after an explicit (non-default) model is chosen. Options are that model's
   `efforts`, or the agent's `defaultEfforts` for a manual id, plus `default`. If the model is
   `default`, do not ask; effort must also be default.

Then one final question for **max review rounds** (integer 1-20, default `current.maxRounds`).

Never reuse a previous agent's model list or a previous model's effort list.

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
