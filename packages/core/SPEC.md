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
