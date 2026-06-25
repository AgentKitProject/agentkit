import type { MarketKitDetail, MarketKitListItem, PublisherSummary } from "@/lib/market-api";

export type MockTrustStatus = "Validated" | "Reviewed" | "Verified Publisher" | "Featured";

const publishers: PublisherSummary[] = [
  {
    slug: "northstar-ops",
    name: "Northstar Ops",
    initials: "NO",
    summary: "Operational reporting kits for revenue, customer success, and executive workflows.",
    verified: true
  },
  {
    slug: "signalroom",
    name: "Signalroom",
    initials: "S",
    summary: "Reusable collaboration kits for teams that turn conversations into durable decisions.",
    verified: true
  },
  {
    slug: "civic-stack-labs",
    name: "Civic Stack Labs",
    initials: "CS",
    summary: "Policy, compliance, and public-interest workflow kits with review-first publishing practices.",
    verified: false
  },
  {
    slug: "atlas-research",
    name: "Atlas Research",
    initials: "AR",
    summary: "Research synthesis kits for strategic decisions, analyst briefs, and knowledge teams.",
    verified: true
  },
  {
    slug: "queuecraft",
    name: "QueueCraft",
    initials: "Q",
    summary: "Support operations kits for triage, routing, and customer response quality.",
    verified: false
  }
];

const mockKits: MarketKitDetail[] = [
  {
    slug: "sales-report-generator",
    name: "Sales Report Generator",
    summary: "Turns CRM exports and revenue notes into weekly sales summaries with forecast risks and next actions.",
    description:
      "A reporting kit for weekly revenue reviews that turns structured exports and team notes into concise summaries, risks, and follow-up actions.",
    publisher: publishers[0],
    categories: ["Sales", "Reporting"],
    tags: ["CRM", "Weekly reporting", "Forecasting"],
    currentVersion: "0.4.2",
    trustBadges: ["Validated", "Reviewed", "Verified Publisher", "Featured"],
    validationStatus: "Validated",
    reviewStatus: "Reviewed",
    requiredInputs: [
      { name: "CSV revenue export", summary: "Pipeline and booked revenue data for the reporting period." },
      { name: "Pipeline notes", summary: "Rep or manager notes that explain movement and risks." },
      { name: "Reporting period", summary: "The date range covered by the report." }
    ],
    preparedPrompts: [
      { name: "Executive sales narrative", summary: "Summarizes revenue movement and major risks for leadership." },
      { name: "Pipeline variance analysis", summary: "Compares pipeline changes against the prior reporting period." },
      { name: "Next-step planner", summary: "Turns observations into owner-oriented follow-up actions." }
    ],
    skills: [
      { name: "Spreadsheet summarization", summary: "Condenses structured sales data into narrative insights." },
      { name: "Forecast risk extraction", summary: "Finds deal and segment-level forecast risks." },
      { name: "Action item formatting", summary: "Formats next steps for review workflows." }
    ],
    outcomes: ["Board-ready weekly summary", "Opportunity risk register", "Rep-level follow-up list"],
    updatedAt: "2026-05-24T00:00:00.000Z",
    versionMetadata: { releaseChannel: "public", compatibility: "AgentKitForge import placeholder" },
    importCountLabel: "2.4k"
  },
  {
    slug: "meeting-notes-summarizer",
    name: "Meeting Notes Summarizer",
    summary: "Creates concise recaps, owners, blockers, and follow-up plans from messy call notes or transcripts.",
    description:
      "A collaboration kit that turns raw notes into durable team memory while preserving only public summaries in Market.",
    publisher: publishers[1],
    categories: ["Productivity", "Operations"],
    tags: ["Meetings", "Transcripts", "Action items"],
    currentVersion: "0.3.8",
    trustBadges: ["Validated", "Reviewed", "Verified Publisher"],
    validationStatus: "Validated",
    reviewStatus: "Reviewed",
    requiredInputs: [
      { name: "Transcript or notes", summary: "Meeting content to summarize." },
      { name: "Meeting type", summary: "Context such as planning, review, or customer call." },
      { name: "Attendee list", summary: "Names or roles for assignment context." }
    ],
    preparedPrompts: [
      { name: "Decision log", summary: "Extracts decisions and unresolved questions." },
      { name: "Action item extraction", summary: "Finds owners, deadlines, and blockers." },
      { name: "Stakeholder recap", summary: "Creates a short recap for non-attendees." }
    ],
    skills: [
      { name: "Speaker-aware summarization", summary: "Keeps participant context without exposing raw transcript text." },
      { name: "Task normalization", summary: "Normalizes follow-ups into actionable tasks." },
      { name: "Follow-up drafting", summary: "Drafts a concise post-meeting note." }
    ],
    outcomes: ["Readable recap", "Assigned tasks", "Open questions"],
    updatedAt: "2026-05-18T00:00:00.000Z",
    importCountLabel: "5.8k"
  },
  {
    slug: "policy-review-assistant",
    name: "Policy Review Assistant",
    summary: "Reviews internal policy drafts for gaps, ambiguity, approval readiness, and implementation impact.",
    publisher: publishers[2],
    categories: ["Legal Ops", "Compliance"],
    tags: ["Policy", "Review", "Risk"],
    currentVersion: "0.2.5",
    trustBadges: ["Validated", "Reviewed"],
    validationStatus: "Validated",
    reviewStatus: "Reviewed",
    requiredInputs: [
      { name: "Policy draft", summary: "Document text or excerpt to review." },
      { name: "Audience", summary: "Intended readers and policy owners." },
      { name: "Relevant control family", summary: "Compliance area used for review framing." }
    ],
    preparedPrompts: [
      { name: "Plain-language policy critique", summary: "Identifies unclear language and missing expectations." },
      { name: "Control mapping summary", summary: "Summarizes likely control relationships." },
      { name: "Approval checklist", summary: "Produces review questions for final approval." }
    ],
    skills: [
      { name: "Ambiguity detection", summary: "Flags unclear obligations and weak definitions." },
      { name: "Risk scoring", summary: "Summarizes relative implementation risk." },
      { name: "Checklist generation", summary: "Builds an approval-readiness checklist." }
    ],
    outcomes: ["Review memo", "Gap list", "Approval questions"],
    updatedAt: "2026-05-09T00:00:00.000Z",
    importCountLabel: "1.1k"
  },
  {
    slug: "research-brief-builder",
    name: "Research Brief Builder",
    summary: "Synthesizes trusted notes and source snippets into compact research briefs with assumptions and evidence gaps.",
    publisher: publishers[3],
    categories: ["Research", "Strategy"],
    tags: ["Briefs", "Synthesis", "Sources"],
    currentVersion: "0.5.0",
    trustBadges: ["Validated", "Reviewed", "Verified Publisher", "Featured"],
    validationStatus: "Validated",
    reviewStatus: "Reviewed",
    requiredInputs: [
      { name: "Research question", summary: "The decision or question the brief should support." },
      { name: "Source notes", summary: "Trusted notes and source snippets." },
      { name: "Decision context", summary: "Audience, stakes, and constraints." }
    ],
    preparedPrompts: [
      { name: "Evidence synthesis", summary: "Groups evidence into decision-relevant themes." },
      { name: "Assumptions register", summary: "Captures assumptions and uncertainty." },
      { name: "Decision brief outline", summary: "Structures findings for executive review." }
    ],
    skills: [
      { name: "Source clustering", summary: "Clusters source notes by theme." },
      { name: "Contradiction surfacing", summary: "Highlights conflicting evidence." },
      { name: "Executive framing", summary: "Frames findings for leadership decisions." }
    ],
    outcomes: ["Two-page brief", "Evidence matrix", "Open research questions"],
    updatedAt: "2026-05-29T00:00:00.000Z",
    importCountLabel: "3.2k"
  },
  {
    slug: "support-ticket-classifier",
    name: "Support Ticket Classifier",
    summary: "Classifies incoming support tickets by urgency, intent, product area, and routing destination.",
    publisher: publishers[4],
    categories: ["Support", "Automation"],
    tags: ["Routing", "Classification", "Triage"],
    currentVersion: "0.1.9",
    trustBadges: ["Validated", "Reviewed"],
    validationStatus: "Validated",
    reviewStatus: "Reviewed",
    requiredInputs: [
      { name: "Ticket text", summary: "Incoming customer support request." },
      { name: "Product area list", summary: "Allowed product or team routing labels." },
      { name: "Priority rules", summary: "Escalation and severity guidance." }
    ],
    preparedPrompts: [
      { name: "Intent classifier", summary: "Summarizes the likely customer intent." },
      { name: "Urgency rationale", summary: "Explains urgency without exposing internal logs." },
      { name: "Escalation recommendation", summary: "Suggests a routing destination." }
    ],
    skills: [
      { name: "Label normalization", summary: "Maps tickets to allowed labels." },
      { name: "Priority scoring", summary: "Scores severity from policy summaries." },
      { name: "Routing summary", summary: "Creates a short routing note." }
    ],
    outcomes: ["Triage labels", "Routing recommendation", "Escalation note"],
    updatedAt: "2026-05-12T00:00:00.000Z",
    importCountLabel: "890"
  }
];

export const mockPublicKits: MarketKitListItem[] = mockKits.map((kit) => ({
  slug: kit.slug,
  name: kit.name,
  summary: kit.summary,
  publisher: kit.publisher,
  categories: kit.categories,
  tags: kit.tags,
  currentVersion: kit.currentVersion,
  trustBadges: kit.trustBadges,
  validationStatus: kit.validationStatus,
  reviewStatus: kit.reviewStatus,
  requiredInputs: kit.requiredInputs,
  preparedPrompts: kit.preparedPrompts,
  skills: kit.skills,
  updatedAt: kit.updatedAt,
  importCountLabel: kit.importCountLabel
}));

export function getMockKit(slug: string) {
  return mockKits.find((kit) => kit.slug === slug);
}

export function getMockPublisher(slug: string) {
  return publishers.find((publisher) => publisher.slug === slug);
}

export function getMockPublisherKits(slug: string) {
  return mockPublicKits.filter((kit) => kit.publisher.slug === slug);
}
