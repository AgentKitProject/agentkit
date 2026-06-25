export type AiProviderType =
  | "openai"
  | "anthropic"
  | "gemini"
  | "ollama"
  | "openai-compatible";

export type ModelRecommendationTag =
  | "kit-use"
  | "draft-generation"
  | "fast"
  | "cheap"
  | "local";

export interface AiProviderConfigBase {
  id: string;
  name: string;
  type: AiProviderType;
  baseUrl?: string;
  apiKeyRequired?: boolean;
  defaultModel?: string;
  supportsStructuredJson?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export type AiProviderConfigShape = AiProviderConfigBase;

export interface KnownModel {
  id: string;
  label: string;
  providerTypes: AiProviderType[];
  recommendedFor: ModelRecommendationTag[];
  supportsStructuredJson?: boolean;
  notes?: string;
}

export interface ProviderCapabilities {
  providerType: AiProviderType;
  apiKeyRequired: boolean;
  baseUrlRequired: boolean;
  supportsCustomModels: boolean;
  supportsStructuredJson: boolean;
  notes?: string;
}
