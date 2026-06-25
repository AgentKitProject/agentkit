export type AgentKitTemplateName = "blank" | "financial-review";

export interface AgentKitTemplateVariables {
  id: string;
  name: string;
  description: string;
}

export interface AgentKitTemplate {
  name: AgentKitTemplateName;
  files: Record<string, string>;
}

export const templates: Record<AgentKitTemplateName, AgentKitTemplate> = {
  blank: {
    name: "blank",
    files: {
      "agentkit.yaml": `schemaVersion: "0.1"
kind: AgentKit
id: "{{id}}"
name: "{{name}}"
version: "1"
description: "{{description}}"
author:
  name: Unknown
license: MIT
entrypoints:
  human: START_HERE.md
  agent: AGENTKIT.md
userExperience:
  setupLevel: low
compatibility:
  targets:
    - codex
risk:
  level: low
skills:
  - id: first-skill
    path: skills/first-skill/SKILL.md
    description: First starter skill.
    triggers:
      - first skill
`,
      "AGENTKIT.md": `# {{name}}

Use this Agent Kit when the user's task matches one of the listed skill triggers.
`,
      "START_HERE.md": `# {{name}}

{{description}}
`,
      "skills/first-skill/SKILL.md": `---
id: first-skill
name: First Skill
description: First starter skill.
triggers:
  - first skill
riskLevel: low
---

# First Skill

## Use when

Use this skill when a user asks for the starter workflow.

## Procedure

Clarify the goal, follow the kit instructions, and produce a concise result.

## Output

Return Markdown.
`
    }
  },
  "financial-review": {
    name: "financial-review",
    files: {
      "agentkit.yaml": `schemaVersion: "0.1"
kind: AgentKit
id: "{{id}}"
name: "{{name}}"
version: "1"
description: "{{description}}"
author:
  name: Unknown
license: MIT
entrypoints:
  human: START_HERE.md
  agent: AGENTKIT.md
userExperience:
  setupLevel: medium
compatibility:
  targets:
    - codex
risk:
  level: medium
skills:
  - id: map-workbook-structure
    path: skills/map-workbook-structure/SKILL.md
    description: Map workbook sheets, tables, and important financial review areas.
    triggers:
      - map workbook
      - workbook structure
  - id: audit-formulas
    path: skills/audit-formulas/SKILL.md
    description: Audit formulas for consistency, risk, and review follow-up.
    triggers:
      - audit formulas
      - review spreadsheet formulas
`,
      "AGENTKIT.md": `# {{name}}

Use this Agent Kit to support structured financial workbook reviews. Stay within the guardrails in policies/financial-review-guardrails.yaml.
`,
      "START_HERE.md": `# {{name}}

{{description}}
`,
      "README.md": `# {{name}}

{{description}}

This template provides starter skills and guardrails for reviewing financial workbooks.
`,
      LICENSE: `MIT
`,
      "CHANGELOG.md": `# Changelog

## 0.1.0

Initial financial review template.
`,
      "skills/map-workbook-structure/SKILL.md": `---
id: map-workbook-structure
name: Map Workbook Structure
description: Map workbook sheets, tables, and important financial review areas.
triggers:
  - map workbook
  - workbook structure
riskLevel: medium
---

# Map Workbook Structure

## Use when

Use this skill when a user needs an overview of a financial workbook before detailed review.

## Procedure

Identify sheets, major tables, assumptions, outputs, and areas requiring follow-up.

## Output

Return a concise workbook map with notable review risks.
`,
      "skills/audit-formulas/SKILL.md": `---
id: audit-formulas
name: Audit Formulas
description: Audit formulas for consistency, risk, and review follow-up.
triggers:
  - audit formulas
  - review spreadsheet formulas
riskLevel: medium
---

# Audit Formulas

## Use when

Use this skill when a user asks for a formula review in a financial workbook.

## Procedure

Check formula consistency, hardcoded values, broken references, unusual ranges, and unexplained overrides.

## Output

Return findings with severity, location, rationale, and recommended follow-up.
`,
      "policies/financial-review-guardrails.yaml": `riskLevel: medium
guardrails:
  - Do not provide investment, tax, legal, or accounting advice.
  - Flag uncertain conclusions for human review.
  - Preserve source workbook assumptions unless explicitly asked to propose alternatives.
`,
      "examples/prompts/monthly-review.md": `# Monthly Review Prompt

Review this monthly finance workbook for formula consistency and obvious structural risks.
`,
      "examples/outputs/monthly-review-summary.md": `# Monthly Review Summary

## Summary

No critical issues found in the sample output.

## Follow-up

Confirm assumptions and investigate any formula ranges that differ from adjacent periods.
`
    }
  }
};

export function renderTemplate(input: string, variables: AgentKitTemplateVariables): string {
  return input
    .replaceAll("{{id}}", escapeYamlStringValue(variables.id))
    .replaceAll("{{name}}", escapeYamlStringValue(variables.name))
    .replaceAll("{{description}}", escapeYamlStringValue(variables.description));
}

function escapeYamlStringValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
