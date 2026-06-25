export type AgentKitContextBuildMode = "all" | "triggered";

export type AgentKitContextTarget = "openai" | "chatgpt" | "claude" | "generic";

export interface AgentKitContextRequest {
  kitPath: string;
  userTask?: string;
  mode: AgentKitContextBuildMode;
  target: AgentKitContextTarget;
  includePolicies?: boolean;
  includeTemplates?: boolean;
  includeWorkflows?: boolean;
  includeReferences?: boolean;
  includePrompts?: boolean;
  maxSkills?: number;
  maxFiles?: number;
  maxBytes?: number;
}

export interface AgentKitContextResult {
  systemContext: string;
  userContext: string;
  includedFiles: string[];
  includedSkills: string[];
  warnings: string[];
}
