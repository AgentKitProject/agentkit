# AgentKitForge Core

AgentKitForge Core is the initial TypeScript engine for validating, exporting, and packaging portable Agent Kits. This package intentionally contains only core package/spec/validation/export logic. It does not include a desktop app, AWS infrastructure, or Agent Kit Market integration.

## Install

```bash
npm install @agentkitforge/core
```

## Npm Package

AgentKitForge Core is published as the public scoped npm package `@agentkitforge/core`. Apps should depend on it using SemVer:

```json
"@agentkitforge/core": "^0.1.0"
```

The published package includes built `dist/` output. The repository does not commit generated `dist/`; `npm pack` and `npm publish` run the build first. Package entrypoints point at:

- `main`: `dist/index.js`
- `types`: `dist/index.d.ts`
- `bin`: `dist/cli/index.js`

Release Please creates GitHub Releases, and the release workflow publishes `@agentkitforge/core` to npm automatically using npm Trusted Publishing.

## Build

```bash
npm run build
```

## Test

```bash
npm test
```

## Smoke Test

```bash
npm run build
npm run smoke
```

The smoke test exercises the built CLI across init, validation, packaging, one-file export, prepared prompts, context building, target exports, inspection, summary, and load-as-draft workflows.

## Security Checks

GitHub Actions runs security scanning on pushes, pull requests, and manual dispatch. Blocking checks currently include `npm audit --audit-level=critical`. A non-blocking high vulnerability audit is reported in logs.

See [SECURITY_CI_POLICY.md](SECURITY_CI_POLICY.md) for the v0.1 failure policy.

## Project Documents

- [SPEC.md](SPEC.md): Agent Kit public preview package specification.
- [CLI.md](CLI.md): CLI command reference.
- [CONTRIBUTING.md](CONTRIBUTING.md): Local setup, contribution scope, and PR expectations.
- [SECURITY.md](SECURITY.md): Vulnerability reporting and supported versions.
- [VERSIONING.md](VERSIONING.md): SemVer and schema compatibility policy.
- [RELEASE_PROCESS.md](RELEASE_PROCESS.md): Release checklist and tagging flow.
- [CHANGELOG.md](CHANGELOG.md): Release notes.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md): Contributor conduct expectations.

## Agent Kit Input Safety

Agent Kit folders are treated as untrusted input. Manifest-controlled paths must be safe relative paths that stay inside the kit root, and IDs used for package/export folder names must be path-safe kebab-case identifiers. Core reports validation errors for unsafe manifest paths or IDs instead of reading, copying, packaging, or exporting them.

Core never executes files from `scripts/`; it only validates whether script files are declared. Packaging, context building, and target exports reject symbolic links, skip generated or dependency-heavy folders such as `exports/`, `.git`, `node_modules`, `dist`, and `build`, and apply conservative file-count and byte limits to avoid unexpectedly large or malicious kits.

## CLI

Create a blank Agent Kit:

```bash
npm run build
node dist/cli/index.js init ./my-agentkit \
  --template blank \
  --id my-agentkit \
  --name "My Agent Kit" \
  --description "A starter Agent Kit."
```

Create a trusted financial review starter kit:

```bash
node dist/cli/index.js init ./financial-review-kit \
  --template financial-review \
  --id financial-review-kit \
  --name "Financial Review Kit" \
  --description "Review financial workbooks for structure, formulas, and follow-up risks."
```

Use `--force` to initialize into a non-empty directory and overwrite generated template files.

Render an Agent Kit draft JSON file:

```bash
node dist/cli/index.js render-draft ./draft.json ./rendered-agentkit --force
```

Draft rendering validates the JSON structure before writing files. Rendered kits include the standard manifest, entrypoint Markdown files, README, LICENSE, CHANGELOG, skills, and any draft policies, examples, or templates.

List prepared prompts in a kit:

```bash
node dist/cli/index.js list-prompts ./path/to/agentkit
```

Render a prepared prompt with input values:

```bash
node dist/cli/index.js render-prompt ./path/to/agentkit financial-review --inputs inputs.json --out rendered-prompt.md
```

Validate prepared prompt inputs:

```bash
node dist/cli/index.js validate-prompt-inputs ./path/to/agentkit financial-review --inputs inputs.json
```

Inspect, summarize, or load an existing kit as a draft:

```bash
node dist/cli/index.js inspect ./path/to/repo-or-kit
node dist/cli/index.js summarize ./path/to/agentkit
node dist/cli/index.js load-as-draft ./path/to/agentkit --out draft.json
```

Prepare a provider-neutral AI draft request:

```bash
node dist/cli/index.js draft-request \
  --request "Build a financial review kit for monthly workbook review." \
  --level trusted \
  --domain Finance \
  --target-user analyst \
  --out draft-request.json
```

The command writes deterministic instructions, prompt text, and the expected `AgentKitDraft` JSON schema. It does not call OpenAI or any other provider. A future app can send `draft-request.json` to an AI provider, validate the returned `AgentKitDraft` JSON, then render it:

```bash
node dist/cli/index.js render-draft draft.json ./my-kit --force
```

Prepare a revision request for an existing draft:

```bash
node dist/cli/index.js draft-revision-request ./draft.json \
  --change "Add a reusable prepared prompt for monthly workbook review." \
  --level trusted \
  --out draft-revision-request.json
```

Build with AI is designed as an iterative flow:

1. Create a draft request from the user's initial request.
2. A future app sends that request to an AI provider.
3. Validate the returned `AgentKitDraft`.
4. Create an AI Draft Session and store revision v1.
5. For user changes, create a draft revision request from the current draft.
6. Validate the returned full updated draft and add a new revision.
7. Render the current revision into an Agent Kit folder.

Core only builds request/session data. The app performs provider calls.

Validate an Agent Kit:

```bash
node dist/cli/index.js validate ./path/to/agentkit --profile local-valid
```

Supported validation profiles:

- `local-valid`
- `publishable`
- `trusted`
- `verified`

Export a one-file Markdown bundle:

```bash
node dist/cli/index.js export-onefile ./path/to/agentkit --out ./bundle.md
```

Create a `.agentkit.zip` package:

```bash
node dist/cli/index.js package ./path/to/agentkit --out ./agentkit.agentkit.zip
```

Build AI-ready context from an Agent Kit:

```bash
node dist/cli/index.js build-context ./path/to/agentkit \
  --task "Audit formulas in this workbook." \
  --mode triggered \
  --target generic \
  --out context.json
```

The context builder does not call OpenAI or any other provider. It creates a JSON payload with:

- `systemContext`: Agent Kit instructions, selected skills, and requested supporting files.
- `userContext`: the user task, ready to pair with the system context.
- `includedFiles`: normalized package paths included in the context.
- `includedSkills`: skill ids included in the context.
- `warnings`: deterministic fallback or selection warnings.

Use `--mode all` to include every manifest skill. Use `--mode triggered` to match the user task against skill triggers and descriptions. If no skill matches, the builder includes all skills and records a warning.

Policies, templates, and workflows are included by default in the CLI. Use `--no-policies`, `--no-templates`, or `--no-workflows` to exclude them. References are excluded by default; pass `--include-references` when the target workflow needs them.

Export Agent Kit skills to a Codex-compatible skills directory:

```bash
node dist/cli/index.js export-codex ./financial-review --dest ~/.codex/skills --force
```

This is the first target adapter. It copies each manifest skill into a namespaced Codex skill folder like `<kit-id>-<skill-id>`, creates an index skill for the kit, and writes AgentKitForge markers so `--force` only replaces folders generated by this adapter. It does not call Codex and does not assume your actual Codex skills path.

Export an Agent Kit to an initial Claude Code plugin-style folder:

```bash
node dist/cli/index.js export-claude-code ./financial-review --dest ./claude-code-plugins --force
```

This adapter creates `<kit-id>-claude-code-plugin/`, writes `.claude-plugin/plugin.json`, copies manifest skills into `skills/<skill-id>/`, and includes root Agent Kit instructions plus supporting `policies/`, `templates/`, `workflows/`, and `references/` when present. The plugin manifest is intentionally conservative because Claude Code plugin loading behavior may evolve; verify loading with your Claude Code version.

After this package is installed globally or linked, the same commands are available through `agentkitforge`.

## AI Provider Metadata

AgentKitForge Core defines shared provider and model metadata only. It does not call OpenAI, Anthropic, Gemini, Ollama, OpenAI-compatible servers, or any other provider. It does not store API keys.

The exported provider helpers cover:

- provider types: `openai`, `anthropic`, `gemini`, `ollama`, `openai-compatible`
- starter known-model suggestions
- default model suggestions
- API key and base URL requirements
- structured JSON capability hints for AgentKitDraft generation

Known models are suggestions, not constraints. Apps and CLIs that consume this package must always allow custom model IDs, especially for Ollama and OpenAI-compatible providers.

## Prepared Prompts

Prepared Prompts are reusable prompt templates stored under `prompts/<prompt-id>.yaml`. They let a kit define exact prompts that can be rendered later in Use mode after an app collects required inputs.

Canonical variable syntax is `{{variable_name}}`. A simpler `{variable_name}` form is tolerated for compatibility. Whitespace is allowed inside braces, such as `{{ company_name }}`. Inputs are defined by the prepared prompt, and AgentKitForge validates/rendered prompts so unresolved variables are blocked before an app sends the prompt to an AI provider.

Prompt input types:

- `short-text`
- `long-text`
- `choice`
- `multi-choice`
- `date`
- `number`
- `boolean`

Prepared prompt paths can be referenced from `agentkit.yaml`:

```yaml
prompts:
  - id: financial-review
    path: prompts/financial-review.yaml
    description: Review a financial workbook and produce a summary.
```

One-file export renders prepared prompts in a readable Markdown section instead of dumping raw YAML.

Default artifact naming helpers return predictable names such as:

- `<kit-id>-<version>.onefile.md`
- `<kit-id>-<version>.agentkit.zip`
- `<kit-id>-output-<timestamp>.md`

## Domains

Core includes a known domain catalog for guided builders and filtering. Domains are suggestions, not constraints. Consumers should always allow custom domains.

## App-Support Helpers

Core includes reusable helpers for app workflows:

- `inspectAgentKitCandidate(path)` for import-friendly diagnostics.
- `getAgentKitSummary(path)` for details, export, and install target screens.
- `loadAgentKitAsDraft(path)` for Edit with AI and guided editing.
- `requestedSections` and `excludedSections` on draft request builders for AI section control.
- Example input document metadata helpers for `.txt`, `.md`, `.csv`, `.xlsx`, and `.xls`.
- Artifact naming helpers for one-file exports, packages, and generated outputs.

Example input documents are app-provided metadata. Core does not upload files, call AI providers, or perform heavy spreadsheet parsing. Apps can use them to help AI infer formatting, terminology, expected outputs, required inputs, skill procedures, and prepared prompt variables.

## Agent Kit Structure

```text
agentkit.yaml
AGENTKIT.md
START_HERE.md
README.md
LICENSE
CHANGELOG.md
skills/<skill-id>/SKILL.md
prompts/<prompt-id>.yaml
workflows/
policies/
references/
templates/
examples/
evals/
adapters/
scripts/
assets/
exports/
```

## Validation Profiles

`local-valid` requires `agentkit.yaml`, `AGENTKIT.md`, `START_HERE.md`, `skills/`, and at least one `skills/<skill-id>/SKILL.md`.

`publishable` adds `README.md` and `LICENSE`.

`trusted` adds `CHANGELOG.md`, `policies/`, and `examples/`.

`verified` adds `evals/`.
