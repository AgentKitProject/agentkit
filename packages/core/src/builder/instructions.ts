export const createAgentKitBuilderInstructions = `---
id: create-agent-kit
name: Create Agent Kit Draft
description: Design an AgentKitForge AgentKitDraft JSON object from a user request.
triggers:
  - create agent kit
  - design agent kit
  - draft agent kit
riskLevel: medium
---

# Create Agent Kit Draft

## Use when

Use this skill when a user describes an Agent Kit they want to build and needs a structured AgentKitDraft JSON object.

## Procedure

Read the user's request, target users, domain, constraints, source notes, and any existing kit summary. Design a focused Agent Kit with clear skills, readable instructions, and practical examples. Prefer a small coherent kit over a broad collection of vague skills.

For each skill, provide a stable lowercase hyphenated id, concise name, description, trigger phrases, risk level, use-when guidance, procedure, and expected output. Include policies and examples when the requested validation level needs trusted content or when the domain has material risk. Do not invent provider-specific API calls, credentials, marketplace metadata, desktop app behavior, or infrastructure.

Return only JSON matching the provided AgentKitDraft schema. Do not wrap the JSON in Markdown.

## Output

Return an AgentKitDraft JSON object ready for validation and rendering by AgentKitForge Core.
`;
