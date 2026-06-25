export type AgentKitValidationProfile =
  | "local-valid"
  | "publishable"
  | "trusted"
  | "verified";

export type ValidationIssueSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: ValidationIssueSeverity;
  code: string;
  message: string;
  path?: string;
}

export interface ValidationReport {
  valid: boolean;
  profile: AgentKitValidationProfile;
  rootPath: string;
  issues: ValidationIssue[];
}

export interface AgentKitSkillManifest {
  id: string;
  path: string;
  description: string;
  triggers: string[];
}

export interface AgentKitPromptManifest {
  id: string;
  path: string;
  description: string;
}

export interface AgentKitManifest {
  schemaVersion: string;
  kind: string;
  id: string;
  name: string;
  version: string;
  description: string;
  author: {
    name: string;
  };
  license: string;
  entrypoints: {
    human: string;
    agent: string;
  };
  userExperience: {
    setupLevel: string;
  };
  compatibility: {
    targets: string[];
  };
  risk: {
    level: string;
  };
  skills: AgentKitSkillManifest[];
  prompts?: AgentKitPromptManifest[];
  scripts?: Array<string | { id?: string; path: string; description?: string }>;
  [key: string]: unknown;
}

export interface LoadedAgentKit {
  rootPath: string;
  manifestPath: string;
  manifestRaw: unknown;
  manifest?: AgentKitManifest;
}

export interface SkillDocument {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
}
