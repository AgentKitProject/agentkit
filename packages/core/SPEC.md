# Agent Kit Specification

This is the public preview Agent Kit package specification for AgentKitForge Core.

## What Is an Agent Kit?

An Agent Kit is a portable package of AI-agent skills, workflows, policies, references, templates, examples, evals, adapters, scripts, assets, prepared prompts, and exports.

AgentKitForge Core validates, renders, packages, exports, and builds AI-ready context from Agent Kits. It does not call AI providers and does not execute scripts.

## Canonical Package Structure

Required for `local-valid`:

```text
agentkit.yaml
AGENTKIT.md
START_HERE.md
skills/
skills/<skill-id>/SKILL.md
```

Optional or profile-specific files and folders:

```text
README.md
LICENSE
CHANGELOG.md
workflows/
policies/
references/
templates/
examples/
examples/prompts/
examples/inputs/
examples/outputs/
evals/
adapters/
scripts/
assets/
exports/
prompts/
prompts/<prompt-id>.yaml
```

## Manifest

`agentkit.yaml` is the package manifest.

Required fields:

- `schemaVersion`
- `kind`
- `id`
- `name`
- `version` — the kit's CONTENT version: a sequential positive integer
  (`1`, `2`, `3`, …) starting at `1`, displayed to authors as `vN` (`v1`,
  `v2`, …). Stored as a quoted string in `agentkit.yaml` (e.g. `version: "1"`)
  and auto-incremented when an author publishes a new revision. This is
  distinct from `schemaVersion` (the spec FORMAT version, currently `"0.1"`),
  which it does not affect. Legacy kits carrying a semver `version` (e.g.
  `"0.1.0"`) are treated as `v1` and normalized to `"1"` on the next write.
- `description`
- `author.name`
- `license`
- `entrypoints.human`
- `entrypoints.agent`
- `userExperience.setupLevel`
- `compatibility.targets`
- `risk.level`
- `skills[]`
- `skills[].id`
- `skills[].path`
- `skills[].description`
- `skills[].triggers`

Current public preview schema:

```yaml
schemaVersion: "0.1"
```

## Skills

Each manifest skill points to a `SKILL.md` file.

Required frontmatter:

- `id`
- `name`
- `description`
- `triggers`
- `riskLevel`

Required Markdown sections:

- `# Title`
- `## Use when`
- `## Procedure`
- `## Output`

## Prepared Prompts

Prepared Prompts are reusable prompt templates stored under:

```text
prompts/<prompt-id>.yaml
```

Manifest entries are optional:

```yaml
prompts:
  - id: financial-review
    path: prompts/financial-review.yaml
    description: Review a financial workbook and produce a summary.
```

Canonical variable syntax is `{{variable_name}}`. The simple `{variable_name}` form is tolerated for compatibility. Core validates inputs and blocks unresolved variables before a rendered prompt is considered valid.

Supported input types:

- `short-text`
- `long-text`
- `choice`
- `multi-choice`
- `date`
- `number`
- `boolean`

## Suggested Automations

Kit authors may declare suggested automations in the manifest. They describe
recurring or event-driven runs of the kit that a consumer can enable in
AgentKitAuto. They are suggestions only: Core never schedules or executes
anything, and enabling an automation always goes through a human-completed
wizard.

The `automations:` manifest block is optional and additive — kits that carry
it keep `schemaVersion: "0.1"` (the same policy as the optional `prompts` and
`scripts` blocks). When present it is validated under every profile; a
malformed block fails validation (including `publishable`), while absence is
always fine.

```yaml
automations:
  - name: Daily financial summary
    description: Summarize yesterday's transactions every morning.
    trigger:
      type: schedule
      config:
        cron: "0 9 * * *"
        timezone: America/New_York
    promptTemplate: |
      Use the financial-review skill to summarize the last 24 hours of
      transactions and highlight anomalies.
  - name: New invoice triage
    trigger:
      type: event
      config:
        eventName: invoice.received
    promptTemplate: Triage the incoming invoice and draft a review note.
```

Constraints:

- At most 10 entries per kit.
- `name` — required, 1–80 characters.
- `description` — optional, at most 300 characters.
- `trigger.type` — required, `schedule` or `event`.
- `trigger.config` — optional. For `schedule`: suggested `cron` and
  `timezone` only. For `event`: a suggested `eventName` only.
- `promptTemplate` — required, 1–4000 characters. This is the instruction
  source the consumer reviews before enabling the automation.

Safety rule: automation suggestions may NEVER carry approvals, budgets,
destinations, or connections — the human completes those in the Auto wizard.
Validation enforces this structurally: automation entries and trigger configs
are strict schemas, so any unknown key (for example `approvalId`, `budget`,
`destinations`, or `connectionId`) is rejected.

## Validation Profiles

`local-valid` requires:

- `agentkit.yaml`
- `AGENTKIT.md`
- `START_HERE.md`
- `skills/`
- At least one `skills/<skill-id>/SKILL.md`

`publishable` requires all `local-valid` requirements plus:

- `README.md`
- `LICENSE`

`trusted` requires all `publishable` requirements plus:

- `CHANGELOG.md`
- `policies/`
- `examples/`

`verified` requires all `trusted` requirements plus:

- `evals/`

## Security Notes

Agent Kits are untrusted input.

- Manifest paths must be safe relative paths that resolve inside the kit root.
- IDs used in filesystem paths must be path-safe kebab-case identifiers.
- Path traversal, absolute paths, Windows drive-root paths, and null bytes are invalid.
- Core does not execute files in `scripts/`.
- Packaging, context building, and target exports reject symbolic links and apply conservative file-count and byte limits.
- Generated and dependency-heavy folders such as `exports/`, `.git`, `node_modules`, `dist`, and `build` are skipped by package/export safety traversal.
