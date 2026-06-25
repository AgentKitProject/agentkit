import { readFile } from "node:fs/promises";
import YAML from "yaml";
import type { SkillDocument, ValidationIssue } from "../types.js";

const REQUIRED_FRONTMATTER_FIELDS = [
  "id",
  "name",
  "description",
  "triggers",
  "riskLevel"
] as const;

const REQUIRED_SECTIONS = ["## Use when", "## Procedure", "## Output"] as const;

export function parseSkillMarkdown(content: string, filePath: string): SkillDocument {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    throw new Error("Missing YAML frontmatter block");
  }

  const endMatch = /\r?\n---\r?\n/.exec(content.slice(3));
  if (!endMatch) {
    throw new Error("Unclosed YAML frontmatter block");
  }

  const frontmatterEnd = 3 + endMatch.index;
  const frontmatterText = content.slice(3, frontmatterEnd);
  const body = content.slice(frontmatterEnd + endMatch[0].length);
  const parsed = YAML.parse(frontmatterText) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("YAML frontmatter must be an object");
  }

  return {
    path: filePath,
    frontmatter: parsed as Record<string, unknown>,
    body
  };
}

export async function validateSkillFile(filePath: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  let skill: SkillDocument;

  try {
    skill = parseSkillMarkdown(await readFile(filePath, "utf8"), filePath);
  } catch (error) {
    return [
      {
        severity: "error",
        code: "skill.frontmatter.invalid",
        message: error instanceof Error ? error.message : "Invalid SKILL.md frontmatter",
        path: filePath
      }
    ];
  }

  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    const value = skill.frontmatter[field];
    if (
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    ) {
      issues.push({
        severity: "error",
        code: "skill.frontmatter.missing",
        message: `Missing required SKILL.md frontmatter field: ${field}`,
        path: filePath
      });
    }
  }

  if (!/^#\s+\S+/m.test(skill.body)) {
    issues.push({
      severity: "error",
      code: "skill.section.missing_title",
      message: "Missing required SKILL.md title section: # Title",
      path: filePath
    });
  }

  for (const section of REQUIRED_SECTIONS) {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`^${escaped}\\s*$`, "m").test(skill.body)) {
      issues.push({
        severity: "error",
        code: "skill.section.missing",
        message: `Missing required SKILL.md section: ${section}`,
        path: filePath
      });
    }
  }

  return issues;
}
