import type {
  AiProviderType,
  KnownModel,
  ProviderCapabilities
} from "./types.js";

export const aiProviderTypes: AiProviderType[] = [
  "openai",
  "anthropic",
  "gemini",
  "ollama",
  "openai-compatible"
];

export const modelCatalog: Record<AiProviderType, KnownModel[]> = {
  openai: [
    {
      id: "gpt-5.5",
      label: "GPT-5.5",
      providerTypes: ["openai"],
      recommendedFor: ["kit-use", "draft-generation"],
      supportsStructuredJson: true,
      notes: "Current flagship suggestion for complex reasoning, coding, and agentic workflows. Consumers must allow custom OpenAI model IDs."
    },
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      providerTypes: ["openai"],
      recommendedFor: ["kit-use", "draft-generation"],
      supportsStructuredJson: true,
      notes: "Current affordable GPT-5.4 suggestion for coding and professional work."
    },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 Mini",
      providerTypes: ["openai"],
      recommendedFor: ["kit-use", "fast", "cheap"],
      supportsStructuredJson: true,
      notes: "Lower-latency, lower-cost suggestion for well-defined kit use and draft iteration."
    },
    {
      id: "gpt-5.4-nano",
      label: "GPT-5.4 Nano",
      providerTypes: ["openai"],
      recommendedFor: ["fast", "cheap"],
      supportsStructuredJson: true,
      notes: "Smallest current GPT-5.4 variant suggestion for fast, cost-sensitive tasks."
    }
  ],
  anthropic: [
    {
      id: "claude-opus-4-7",
      label: "Claude Opus 4.7",
      providerTypes: ["anthropic"],
      recommendedFor: ["kit-use", "draft-generation"],
      supportsStructuredJson: true,
      notes: "Anthropic's most capable generally available Claude model suggestion for complex reasoning and agentic coding."
    },
    {
      id: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6",
      providerTypes: ["anthropic"],
      recommendedFor: ["kit-use", "draft-generation", "fast"],
      supportsStructuredJson: true,
      notes: "Balanced Claude suggestion for speed and intelligence."
    },
    {
      id: "claude-haiku-4-5",
      label: "Claude Haiku 4.5",
      providerTypes: ["anthropic"],
      recommendedFor: ["kit-use", "fast", "cheap"],
      supportsStructuredJson: true,
      notes: "Fast Claude suggestion for lower-latency workflows."
    }
  ],
  gemini: [
    {
      id: "gemini-3.1-pro-preview",
      label: "Gemini 3.1 Pro Preview",
      providerTypes: ["gemini"],
      recommendedFor: ["kit-use", "draft-generation"],
      supportsStructuredJson: true,
      notes: "Gemini 3.1 Pro preview suggestion for advanced multimodal and agentic work."
    },
    {
      id: "gemini-3.5-flash",
      label: "Gemini 3.5 Flash",
      providerTypes: ["gemini"],
      recommendedFor: ["kit-use", "fast"],
      supportsStructuredJson: true,
      notes: "Stable Gemini 3.5 suggestion for speed, scale, and agentic workflows."
    },
    {
      id: "gemini-3.1-flash-lite",
      label: "Gemini 3.1 Flash-Lite",
      providerTypes: ["gemini"],
      recommendedFor: ["fast", "cheap"],
      supportsStructuredJson: true,
      notes: "Stable cost-efficient Gemini 3.1 suggestion for high-throughput workflows."
    }
  ],
  ollama: [
    {
      id: "gpt-oss:20b",
      label: "gpt-oss 20B",
      providerTypes: ["ollama"],
      recommendedFor: ["kit-use", "local"],
      supportsStructuredJson: true,
      notes: "OpenAI open-weight Ollama model suggestion. Installed local model IDs vary by machine."
    },
    {
      id: "qwen3:30b",
      label: "Qwen3 30B",
      providerTypes: ["ollama"],
      recommendedFor: ["kit-use", "draft-generation", "local"],
      supportsStructuredJson: false,
      notes: "Strong local reasoning/coding suggestion. JSON reliability depends on local runtime and prompting."
    },
    {
      id: "gemma3:12b",
      label: "Gemma 3 12B",
      providerTypes: ["ollama"],
      recommendedFor: ["kit-use", "fast", "local"],
      supportsStructuredJson: false,
      notes: "Local model suggestion. Installed Ollama model IDs vary by machine."
    }
  ],
  "openai-compatible": []
};

const providerCapabilities: Record<AiProviderType, ProviderCapabilities> = {
  openai: {
    providerType: "openai",
    apiKeyRequired: true,
    baseUrlRequired: false,
    supportsCustomModels: true,
    supportsStructuredJson: true
  },
  anthropic: {
    providerType: "anthropic",
    apiKeyRequired: true,
    baseUrlRequired: false,
    supportsCustomModels: true,
    supportsStructuredJson: true
  },
  gemini: {
    providerType: "gemini",
    apiKeyRequired: true,
    baseUrlRequired: false,
    supportsCustomModels: true,
    supportsStructuredJson: true
  },
  ollama: {
    providerType: "ollama",
    apiKeyRequired: false,
    baseUrlRequired: true,
    supportsCustomModels: true,
    supportsStructuredJson: false,
    notes: "Local model JSON reliability depends on the installed model and runtime options."
  },
  "openai-compatible": {
    providerType: "openai-compatible",
    apiKeyRequired: true,
    baseUrlRequired: true,
    supportsCustomModels: true,
    supportsStructuredJson: false,
    notes: "Structured JSON support depends on the compatible server and selected model."
  }
};

export const structuredOutputGuidance = {
  draftGeneration:
    "Agent Kit draft generation must return valid JSON matching the AgentKitDraft schema.",
  reliability:
    "Providers and models vary in JSON reliability. Validate every returned draft before rendering it.",
  localModelWarning:
    "Local and custom models should warn users when structured JSON support is not known or explicitly disabled."
} as const;

export function getKnownModelsForProvider(providerType: AiProviderType): KnownModel[] {
  return [...modelCatalog[providerType]];
}

export function getDefaultModelForProvider(providerType: AiProviderType): string | undefined {
  return modelCatalog[providerType][0]?.id;
}

export function getProviderCapabilities(providerType: AiProviderType): ProviderCapabilities {
  return { ...providerCapabilities[providerType] };
}

export function isApiKeyRequiredForProvider(providerType: AiProviderType): boolean {
  return providerCapabilities[providerType].apiKeyRequired;
}

export function isBaseUrlRequiredForProvider(providerType: AiProviderType): boolean {
  return providerCapabilities[providerType].baseUrlRequired;
}

export function normalizeBaseUrl(
  providerType: AiProviderType,
  baseUrl?: string
): string | undefined {
  const trimmed = baseUrl?.trim();
  if (trimmed) {
    return trimmed.replace(/\/+$/, "");
  }

  if (providerType === "openai") {
    return "https://api.openai.com/v1";
  }

  if (providerType === "anthropic") {
    return "https://api.anthropic.com/v1";
  }

  if (providerType === "gemini") {
    return "https://generativelanguage.googleapis.com/v1beta";
  }

  if (providerType === "ollama") {
    return "http://localhost:11434";
  }

  return undefined;
}

export function providerSupportsStructuredJson(
  providerType: AiProviderType,
  modelId?: string,
  explicitOverride?: boolean
): boolean {
  if (explicitOverride !== undefined) {
    return explicitOverride;
  }

  const knownModel = modelCatalog[providerType].find((model) => model.id === modelId);
  if (knownModel?.supportsStructuredJson !== undefined) {
    return knownModel.supportsStructuredJson;
  }

  return providerCapabilities[providerType].supportsStructuredJson;
}
