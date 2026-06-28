export type DocsPage = {
  slug: string;
  title: string;
  summary: string;
  category: string;
  audience: string;
  before: string[];
  steps: string[];
  visual: 'concept' | 'build' | 'guided' | 'edit' | 'use' | 'prompts' | 'import' | 'export' | 'install' | 'providers' | 'cli' | 'trouble' | 'faq';
  tips: string[];
  mistakes: string[];
  related: string[];
};

export const docsPages: DocsPage[] = [
  {
    slug: 'what-is-an-agent-kit',
    title: 'What is an Agent Kit?',
    summary: 'An Agent Kit is a reusable package for a specific AI workflow.',
    category: 'Start here',
    audience: 'New users who want to understand what Agent Kits are before building, importing, or running one.',
    before: ['No setup required.', 'Think of one AI workflow you repeat often, such as a review, memo, checklist, triage, or summary.'],
    steps: [
      'Start with a repeatable AI job you do more than once.',
      'Save the prompts, skills, guardrails, templates, examples, and context that make the job work well.',
      'Add inputs users should fill in each time, such as company name, reporting period, topic, or tone.',
      'Run the kit inside Forge with your selected AI provider.',
      'Package, export, import, or install the kit later when you want to reuse or share it.',
      'Remember the distinction: OpenAI, Claude, Gemini, and Ollama are providers; an Agent Kit is the workflow package given to that provider.'
    ],
    visual: 'concept',
    tips: [
      'Use Agent Kits for work you repeat, not every one-off question.',
      'Prepared Prompts make a kit easier to run because Forge can collect required inputs first.',
      'The same kit can often be used with different AI providers.'
    ],
    mistakes: [
      'Defining a kit first as files or YAML instead of a reusable workflow.',
      'Confusing the AI provider/model with the Agent Kit.',
      'Building a kit that is too broad to run consistently.'
    ],
    related: ['getting-started', 'build-with-ai', 'guided-builder', 'prepared-prompts', 'use-kits']
  },
  {
    slug: 'getting-started',
    title: 'Getting Started',
    summary: 'Install AgentKitForge, add an AI provider, build your first kit, and run it inside Forge.',
    category: 'Start here',
    audience: 'New users who want the shortest path from opening the app to running a reusable workflow.',
    before: ['Install or open AgentKitForge.', 'Have one AI provider ready, such as OpenAI, Claude, Gemini, Ollama, or a custom compatible endpoint.'],
    steps: [
      'Open AgentKitForge and go to My Kits.',
      'Add an AI provider in Settings.',
      'Choose Build with AI or Guided Builder.',
      'Create a small first kit with one clear purpose.',
      'Open Use, fill required inputs, preview the prompt, and run the kit.',
      'Download the generated Markdown/Text output or package the kit for later.'
    ],
    visual: 'use',
    tips: ['Start with one narrow workflow.', 'Use a provider with reliable structured output for Build with AI.', 'Package the kit only after you have run it once.'],
    mistakes: ['Trying to build a very broad kit first.', 'Skipping provider setup.', 'Confusing one-file Markdown export with a full .agentkit.zip package.'],
    related: ['what-is-an-agent-kit', 'build-with-ai', 'guided-builder', 'use-kits']
  },
  {
    slug: 'build-with-ai',
    title: 'Build with AI',
    summary: 'Use AI Draft Sessions to generate, revise, and save Agent Kits from plain-language instructions.',
    category: 'Build',
    audience: 'People who want Forge to draft the kit structure, prompts, inputs, and optional sections from a goal.',
    before: ['Configure an AI provider.', 'Write down what the kit should help someone do.', 'Gather any example input documents you want the draft to consider.'],
    steps: [
      'Open Build with AI.',
      'Describe the workflow, audience, required inputs, and desired output.',
      'Attach or paste example input documents if helpful.',
      'Review the generated draft session.',
      'Request changes such as more inputs, simpler output, or stronger policies.',
      'Decide which optional sections to keep.',
      'Save when the draft is ready. Saving creates a usable kit.',
      'Use Advanced only when you need to inspect or work with raw draft JSON.'
    ],
    visual: 'build',
    tips: ['Ask for a narrow kit with a clear output.', 'Request changes in small steps.', 'Treat raw JSON as advanced, not the normal path.'],
    mistakes: ['Saving before reviewing required inputs.', 'Using a model that cannot produce reliable JSON.', 'Adding optional sections that do not help the workflow.'],
    related: ['guided-builder', 'edit-existing-kits', 'ai-providers', 'use-kits']
  },
  {
    slug: 'guided-builder',
    title: 'Guided Builder',
    summary: 'Build Agent Kits manually with approachable forms instead of editing package files.',
    category: 'Build',
    audience: 'Users who know what they want and prefer guided controls over AI-generated drafts.',
    before: ['Know the kit purpose.', 'Decide whether the kit needs prepared prompts.', 'Gather any examples, policies, or templates you want to include.'],
    steps: [
      'Open Guided Builder.',
      'Fill in Basics such as name, purpose, and audience.',
      'Add Skills only when the kit needs reusable agent instructions.',
      'Add Policies, Outputs/Templates, and Examples if they improve the workflow.',
      'Create Prepared Prompts for repeatable runs. They are recommended, not required.',
      'Review the generated kit summary.',
      'Create the kit and run validation.'
    ],
    visual: 'guided',
    tips: ['Prepared Prompts make kits easier for non-technical users.', 'Policies, examples, and templates are optional.', 'Review before creating so required inputs are clear.'],
    mistakes: ['Adding too many fields.', 'Treating every optional section as required.', 'Forgetting to test the kit in Use mode.'],
    related: ['prepared-prompts', 'use-kits', 'package-export']
  },
  {
    slug: 'edit-existing-kits',
    title: 'Edit Existing Kits',
    summary: 'Refine saved or imported kits with Edit with AI or the Guided Editor.',
    category: 'Build',
    audience: 'Users improving a kit after a test run, import, or team review.',
    before: ['Open an existing kit.', 'Know what should change.', 'Keep example input documents nearby if they explain the desired behavior.'],
    steps: [
      'Choose Edit with AI when you can describe the change in plain language.',
      'Use Guided Editor for controlled field-by-field updates.',
      'Review changes before saving.',
      'Save update when replacing the current kit is correct.',
      'Save as new kit when you want a variant or experiment.',
      'Run validation after editing.'
    ],
    visual: 'edit',
    tips: ['Use Save as new kit for experiments.', 'Use example documents to explain output changes.', 'Validate after every meaningful edit.'],
    mistakes: ['Overwriting a working kit too quickly.', 'Requesting many unrelated AI edits at once.', 'Skipping a test run after editing.'],
    related: ['build-with-ai', 'guided-builder', 'use-kits']
  },
  {
    slug: 'use-kits',
    title: 'Use Kits',
    summary: 'Run prepared prompts or custom prompts inside Forge and download generated output.',
    category: 'Use',
    audience: 'Anyone who wants to use an existing kit without switching between tools.',
    before: ['Open or import a kit.', 'Choose an AI provider.', 'Prepare any notes, links, or documents the prompt needs.'],
    steps: [
      'Select a kit from My Kits.',
      'Choose a Prepared Prompt or switch to Custom Prompt.',
      'Fill required prepared prompt inputs.',
      'Review the prompt preview.',
      'Add additional context if needed.',
      'Run with the selected provider.',
      'Review the result and download Markdown/Text output.'
    ],
    visual: 'use',
    tips: ['Prepared Prompts are best for repeatable workflows.', 'Custom Prompt is useful for one-off questions.', 'Preview before running to catch missing context.'],
    mistakes: ['Running with unresolved inputs.', 'Choosing the wrong provider/model for the job.', 'Forgetting to download output before moving on.'],
    related: ['prepared-prompts', 'ai-providers', 'getting-started']
  },
  {
    slug: 'prepared-prompts',
    title: 'Prepared Prompts',
    summary: 'Create reusable prompt flows with variables, inputs, previews, and document-like outputs.',
    category: 'Use',
    audience: 'Users who want repeatable runs with structured inputs instead of rewriting prompts each time.',
    before: ['Know the repeatable prompt goal.', 'List the inputs a user must provide.', 'Decide what kind of output should be downloaded.'],
    steps: [
      'Name the prepared prompt.',
      'Write prompt text with variables such as {{company_name}}.',
      'Use {company_name} only when the app supports that tolerated syntax.',
      'Define input types and mark required vs optional fields.',
      'Preview the rendered prompt.',
      'Run and download Markdown/Text output.',
      'Use Custom Prompt when the task is ad hoc and does not need saved inputs.'
    ],
    visual: 'prompts',
    tips: ['Use clear variable names.', 'Keep required inputs minimal.', 'Document-like outputs are easiest to share.'],
    mistakes: ['Leaving variables unresolved.', 'Making every input required.', 'Using Custom Prompt for a workflow that should be reusable.'],
    related: ['use-kits', 'guided-builder', 'build-with-ai']
  },
  {
    slug: 'import-kits',
    title: 'Import Kits',
    summary: 'Bring kits into Forge from .agentkit.zip files, folders, or Git repositories.',
    category: 'Import/export',
    audience: 'Users receiving kits from teammates, local folders, package files, or source control.',
    before: ['Know where the kit is stored.', 'For private Git repositories, confirm your local Git credentials work.', 'Confirm the repo root or folder contains Agent Kit files.'],
    steps: [
      'Choose Import.',
      'Select .agentkit.zip, folder, or Git repository.',
      'For Git, enter the repository URL and branch if needed.',
      'Let Forge clone or read the source.',
      'Review friendly missing-file errors if the root is not an Agent Kit.',
      'Open the imported kit and validate it.'
    ],
    visual: 'import',
    tips: ['Private repositories use local Git credentials.', 'The repo root must contain Agent Kit files unless Forge supports a subfolder option.', 'Validate immediately after import.'],
    mistakes: ['Importing the wrong folder level.', 'Using a private Git URL without credentials.', 'Ignoring missing manifest errors.'],
    related: ['package-export', 'troubleshooting', 'agent-kit-spec']
  },
  {
    slug: 'package-export',
    title: 'Package / Export',
    summary: 'Understand .agentkit.zip packages, .onefile.md exports, and when to use each.',
    category: 'Import/export',
    audience: 'Users sharing, storing, installing, or preparing kits for web assistants.',
    before: ['Validate the kit.', 'Decide who or what will consume the output.', 'Choose package, one-file Markdown, or local agent install.'],
    steps: [
      'Use .agentkit.zip for structured packages that can be imported later.',
      'Use .onefile.md for web assistants or quick review.',
      'Choose default export locations or select a destination.',
      'Share packages safely, especially if references include sensitive context.',
      'Keep the difference clear: package preserves structure; one-file flattens for portability.'
    ],
    visual: 'export',
    tips: ['Use packages for reuse.', 'Use one-file Markdown for ChatGPT/Claude web workflows.', 'Check exported content before sharing outside your team.'],
    mistakes: ['Treating one-file Markdown as a full package replacement.', 'Sharing private references unintentionally.', 'Skipping validation before package.'],
    related: ['install-local-agent', 'import-kits', 'agent-kit-spec']
  },
  {
    slug: 'install-local-agent',
    title: 'Install on Local Agent',
    summary: 'Export compatible kit content into local agent tools such as Codex and Claude Code.',
    category: 'Providers and integrations',
    audience: 'Users who want an Agent Kit available in supported local agent tools.',
    before: ['Install the target local agent tool.', 'Know its destination folder.', 'Confirm the kit supports that install target.'],
    steps: [
      'Open Install on Local Agent.',
      'Choose Codex or Claude Code.',
      'Review or select the destination folder.',
      'Run the install.',
      'Open the target tool and confirm the exported files are available.'
    ],
    visual: 'install',
    tips: ['Install copies/exports files into target-specific locations.', 'Codex and Claude Code do not read the Forge library automatically.', 'Provider setup is separate from install target setup.'],
    mistakes: ['Confusing AI providers with install targets.', 'Choosing the wrong destination folder.', 'Expecting every kit to support every local agent format.'],
    related: ['package-export', 'cli', 'use-kits']
  },
  {
    slug: 'ai-providers',
    title: 'AI Providers',
    summary: 'Configure OpenAI, Anthropic Claude, Google Gemini, Ollama, or custom OpenAI-compatible endpoints.',
    category: 'Providers and integrations',
    audience: 'Users connecting Forge to hosted, local, or self-hosted model providers.',
    before: ['Have provider credentials or a local endpoint.', 'Know which model you want to use.', 'For local/self-hosted models, confirm the server is running.'],
    steps: [
      'Open Settings.',
      'Choose OpenAI, Anthropic Claude, Google Gemini, Ollama, or Custom OpenAI-compatible.',
      'Enter credentials, base URL, or local endpoint details.',
      'Select a known model from dropdowns where available.',
      'Enter a custom model ID for newer, private, or self-hosted models.',
      'Test the provider with a small prompt.',
      'Use stronger structured-output models for Build with AI.'
    ],
    visual: 'providers',
    tips: ['Local models vary in speed, context size, and JSON reliability.', 'Custom endpoints should follow OpenAI-compatible APIs.', 'Build with AI needs reliable JSON output.'],
    mistakes: ['Wrong base URL.', 'Model ID not available on the selected provider.', 'Using a weak structured-output model for kit generation.'],
    related: ['build-with-ai', 'use-kits', 'troubleshooting']
  },
  {
    slug: 'cli',
    title: 'CLI',
    summary: 'Use the command line for validation, inspection, summaries, packaging, exports, and local agent installs.',
    category: 'Reference and troubleshooting',
    audience: 'Developers and power users who want repeatable automation using the same core as the app.',
    before: ['Install the CLI if distributed with your build.', 'Have a kit folder available.', 'Know the output path you want to write to.'],
    steps: [
      'Run validate before sharing or installing a kit.',
      'Use inspect or summarize to review a folder or repo.',
      'Package with package for .agentkit.zip.',
      'Export with export-onefile for .onefile.md.',
      'List or render prepared prompts.',
      'Use export-codex or export-claude-code for local agent targets.',
      'See the CLI overview page for examples.'
    ],
    visual: 'cli',
    tips: ['Use the CLI in scripts and checks.', 'Keep generated outputs in a dist folder.', 'The app and CLI share the same core concepts.'],
    mistakes: ['Running commands from the wrong folder.', 'Skipping validation before export.', 'Confusing CLI exports with AI provider setup.'],
    related: ['package-export', 'install-local-agent']
  },
  {
    slug: 'troubleshooting',
    title: 'Troubleshooting',
    summary: 'Fix common provider, import, validation, prepared prompt, and export problems.',
    category: 'Reference and troubleshooting',
    audience: 'Anyone blocked by connection errors, malformed output, clone failures, or confusing exports.',
    before: ['Note the exact error text.', 'Check which kit, provider, model, and import/export path you used.'],
    steps: [
      'Provider connection fails: check credentials, base URL, network access, and provider selection.',
      'Model not found: choose a known model or enter a custom model ID supported by your provider.',
      'Malformed JSON: use a model with stronger structured output reliability for Build with AI.',
      'Unresolved prepared prompt inputs: fill every required input before running.',
      'Git clone fails: check URL, branch, Git install, credentials, and network access.',
      'Access denied/private repo: confirm local Git credentials can access the repository.',
      'Kit validation errors: inspect missing files, manifest fields, and unsupported sections.',
      'One-file export confusion: use .onefile.md for web assistants, not as a full package replacement.',
      'Download page release status: v0.1 links stay disabled until release artifacts are uploaded.'
    ],
    visual: 'trouble',
    tips: ['Start with validation errors before provider errors.', 'Test providers with a small prompt.', 'Use .agentkit.zip when preserving structure matters.'],
    mistakes: ['Retrying without changing the failing setting.', 'Assuming private Git repos use browser login.', 'Expecting unavailable release downloads.'],
    related: ['ai-providers', 'import-kits', 'package-export']
  },
  {
    slug: 'faq',
    title: 'FAQ',
    summary: 'Short answers to common AgentKitForge questions.',
    category: 'Reference and troubleshooting',
    audience: 'New users comparing providers, packages, exports, app workflows, and Market plans.',
    before: ['No setup required.'],
    steps: [
      'Do I need to code? No. Build with AI and guided forms support no-code/low-code workflows.',
      'Do I need OpenAI? No. You can use Claude, Gemini, Ollama, or custom compatible endpoints.',
      'Can I use local models? Yes, through Ollama or compatible local/self-hosted providers.',
      'What is a Prepared Prompt? A saved prompt flow with variables, required inputs, preview, and outputs.',
      'Using inside Forge vs ChatGPT? Forge runs kits in app; one-file Markdown prepares context for web assistants.',
      'What is .agentkit.zip? A structured portable package.',
      'What is .onefile.md? A flattened Markdown export.',
      'What is Agent Kit Market? A future marketplace and repository for distributing kits.',
      'Is marketplace/org support here yet? Not yet; public and private organization repos are later work.'
    ],
    visual: 'faq',
    tips: ['Start with Getting Started if you are new.', 'Use Docs for tasks and Spec for package details.'],
    mistakes: ['Mixing up AI providers and install targets.', 'Expecting marketplace features before they are released.'],
    related: ['getting-started', 'ai-providers', 'package-export']
  }
];

export const docsNav = docsPages.map(({ slug, title, category }) => ({ slug, title, category }));

export const docsCategories = [...new Set(docsPages.map((page) => page.category))];

export function getDocPage(slug: string) {
  return docsPages.find((page) => page.slug === slug);
}
