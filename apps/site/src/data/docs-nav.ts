// Single source of truth for the in-site /docs sidebar + ordering.
// Plain data so DocsLayout, the docs index, and prev/next can all read it.
// Keep `href` paths in sync with the .astro files under src/pages/docs/.

export type DocLink = {
  title: string;
  href: string;
  /** One-line summary shown on the docs index cards. */
  summary?: string;
};

export type DocSection = {
  title: string;
  links: DocLink[];
};

export const DOCS_SECTIONS: DocSection[] = [
  {
    title: 'Overview',
    links: [
      {
        title: 'Documentation home',
        href: '/docs/',
        summary: 'Start here — the map of the AgentKitProject docs.'
      },
      {
        title: 'What is an Agent Kit?',
        href: '/docs/what-is-an-agent-kit/',
        summary: 'The reusable package behind every AgentKitProject workflow.'
      },
      {
        title: 'Concepts & the SPEC',
        href: '/docs/concepts/',
        summary: 'Skills, prepared prompts, policies, the .agentkit.zip package, and the spec.'
      },
      {
        title: 'Architecture overview',
        href: '/docs/architecture/',
        summary: 'How the apps, core, and cloud services fit together — local-first by design.'
      }
    ]
  },
  {
    title: 'Get started',
    links: [
      {
        title: 'Getting started',
        href: '/docs/getting-started/',
        summary: 'From opening Forge to running your first kit.'
      },
      {
        title: 'Signing in',
        href: '/docs/signing-in/',
        summary: 'Device authorization for hosted Market and Auto features.'
      }
    ]
  },
  {
    title: 'Products',
    links: [
      {
        title: 'Forge desktop',
        href: '/docs/forge-desktop/',
        summary: 'The local-first desktop app for building and running kits.'
      },
      {
        title: 'Web Forge',
        href: '/docs/web-forge/',
        summary: 'The browser edition — same core engine, your account anywhere.'
      },
      {
        title: 'Market',
        href: '/docs/market/',
        summary: 'Browse, publish, organizations, private catalogs, and paid kits.'
      },
      {
        title: 'AgentKitAuto',
        href: '/docs/auto/',
        summary: 'Run kits unattended on schedules, webhooks, and on demand.'
      },
      {
        title: 'Profile',
        href: '/docs/profile/',
        summary: 'Shared account and identity across the ecosystem.'
      }
    ]
  },
  {
    title: 'Tools & operations',
    links: [
      {
        title: 'CLI (agentkitforge)',
        href: '/docs/cli/',
        summary: 'Validate, package, export, and run Market operations from the terminal.'
      },
      {
        title: 'Self-hosting on Kubernetes',
        href: '/docs/self-hosting/',
        summary: 'Run Market, Web Forge, Auto, and Profile on your own cluster with Helm.'
      }
    ]
  }
];

/** Flattened, in-order list of all doc links (used for prev/next). */
export const DOCS_FLAT: DocLink[] = DOCS_SECTIONS.flatMap((s) => s.links);
