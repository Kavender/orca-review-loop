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

## 2. Ask in rounds, both roles per call

Put the implement and review questions for the same step into **one** `AskUserQuestion` call (one
question each, headers `implement` and `review`) so the user gets the tabbed
`□ implement □ review ✔ Submit` picker. A call's options are fixed up front, so a later step's
options can only come from earlier answers: never put agent and model in the same call.

`AskUserQuestion` requires **2-4 declared options** per question. The free-text "Other"/"Type
something." entry it adds does not count toward the minimum, and a call with any one-option
question is rejected outright. Use Other for anything that does not fit (more agents, a manual model
id). Put the current value first, marked "(current)" in its description, but only when that value
is still valid (see each round).

**Fewer than 2 real options:** if a model or effort question would have only `default` (discovery
failed, returned no models, or a manual model has no `defaultEfforts`), do not put it in the call.
Instead say in one line that the role uses the default ("no models discovered for <agent>; using its
default"), and in plain chat ask the user to reply with an id if they want to pin one. Never pad
with made-up values.

**Round 1: agents and rounds** (one call, three questions):
- `implement` / `review`: "Which agent should handle the <role> phase?" Options are 4 agents: the
  current one, then installed agents, then known uninstalled agents to fill the remaining slots
  (discovery always lists more than 2, so this question always has 2-4 options). Use the agent `label` as the option label and put the id
  and caveats in the description ("CLI not on this machine", "uses its own model config"). Users can
  type any other Orca agent id via Other; if discovery does not know it, warn once that setup cannot
  validate it.
- `rounds`: "Max review rounds?" Options: `current.maxRounds` plus up to three of 3 / 5 / 10. Other
  takes any integer 1-20.

**Round 2: models** (one call; ask only the roles whose agent's `supportsModel` is not `false`):
For an own-config agent, say in one line that "<agent> launches with the model from its own config"
and set its model and effort to default. For each other role, offer `default` (agent's own setting)
plus up to 3 ids from *that role's agent's* `discovery.models`. Only offer the current model if that
role's agent did not change. Other takes a manual id. Skip the call if no role needs it.

**Round 3: effort** (one call; ask only roles with an explicit, non-default model): options are
`default` plus up to 3 of that model's `efforts` (or the agent's `defaultEfforts` for a manual id).
A default model means default effort; do not ask. The current effort is valid only if **both** that
role's agent and model are unchanged. Only then offer it first as "(current)". Otherwise put
`default` first and do not carry the old effort over (the same rule the CLI applies).

If a role ends up with a single question, ask it alone. Never reuse one role's model or effort list
for the other role.

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
