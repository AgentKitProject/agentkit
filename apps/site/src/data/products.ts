export const githubOrgUrl = 'https://github.com/AgentKitProject';
export const forgeUrl = 'https://forge.agentkitproject.com';
export const forgeDocsUrl = 'https://docs.agentkitproject.com';
export const marketUrl = 'https://market.agentkitproject.com';
export const profileUrl = 'https://profile.agentkitproject.com';
export const roadmapUrl = '/roadmap';
export const docsUrl = 'https://docs.agentkitproject.com';
export const autoUrl = 'https://auto.agentkitproject.com';
export const autoRoadmapUrl = `${roadmapUrl}#agentkitauto`;
export const marketRoadmapUrl = `${roadmapUrl}#agentkitmarket`;
export const profileRoadmapUrl = `${roadmapUrl}#agentkitprofile`;
export const forgeRoadmapUrl = `${roadmapUrl}#agentkitforge`;

export const products = [
  {
    name: 'AgentKitForge',
    href: forgeUrl,
    externalHref: forgeUrl,
    status: 'Public preview',
    statusTone: 'live',
    accent: '#5b4cf0',
    accentSoft: '#eef2ff',
    icon: '/brand/agentkitforge-icon.svg',
    purpose: 'Build, edit, run, package, export, and install Agent Kits — on desktop or in the browser.',
    summary:
      'The local-first app for creating portable Agent Kits and running them with your preferred AI provider. A cross-platform desktop build (signed, auto-updating) plus a browser-based Web Forge.'
  },
  {
    name: 'AgentKitMarket',
    href: marketUrl,
    status: 'Public preview',
    statusTone: 'live',
    accent: '#0fb3d1',
    accentSoft: '#ecfeff',
    icon: '/brand/agentkitmarket-icon.svg',
    purpose: 'Discover, publish, validate, review, distribute, and sell Agent Kits.',
    summary:
      'The catalog for Agent Kits — browse, submit, and download kits with admin review. Now with organizations, private team catalogs, and paid kits. Self-hostable on your own infrastructure.'
  },
  {
    name: 'AgentKitAuto',
    href: autoUrl,
    status: 'Live',
    statusTone: 'live',
    accent: '#16a34a',
    accentSoft: '#f0fdf4',
    icon: '/brand/agentkitauto-icon.png',
    purpose: 'Automate Agent Kits on schedules, events, and workflow triggers.',
    summary:
      'On-demand, scheduled, and webhook-triggered Agent Kit runs — hosted and self-hostable. Deeper Market and Forge integration is planned.'
  }
] as const;

export const webForgeUrl = 'https://webapp.forge.agentkitproject.com';
export const contactEmail = 'hello@agentkit-project.com';
