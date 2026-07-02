// Provider preset cards for the "When an event arrives" wizard step: one card
// per popular event producer, each with copy-paste setup instructions that
// substitute the REAL emit URL for the user's source. Presets whose payloads
// we verify signatures for (github / stripe / slack / sns) also set the
// source's `provider` (kind "provider") and surface a signing-secret input.
//
// The public emit URL shape (Seam C):
//   {origin}/api/hooks/auto/events/{sourceId}/{eventName}?token=…
// The `?token=` query form exists because most SaaS webhook UIs can't set an
// Authorization header; services that can should prefer
// `Authorization: Bearer <token>`.
import { autoEventIngestRoutes, type EventSourceProvider } from "@agentkitforge/contracts";

export const TOKEN_PLACEHOLDER = "<YOUR_TOKEN>";

/**
 * The full public emit URL for a source + event name. `token` is only known
 * right after create/rotate (it is one-time); afterwards the placeholder is
 * shown and the user pastes their saved token.
 */
export function buildEmitUrl(origin: string, sourceId: string, eventName: string, token?: string): string {
  const safeName = eventName.trim() || "my-event";
  return `${origin}${autoEventIngestRoutes.emit(sourceId, safeName)}?token=${
    token ? encodeURIComponent(token) : TOKEN_PLACEHOLDER
  }`;
}

export type ProviderPreset = {
  id: string;
  label: string;
  /** What this preset sets on the created source. Non-verified integrations
   *  stay kind "custom" (provider undefined). */
  provider?: EventSourceProvider;
  /** True → show the signing-secret input (provider signature verification). */
  signatureVerified: boolean;
  /** Suggested event name for the emit URL (user-editable). */
  defaultEventName: string;
  /** One-line card description. */
  blurb: string;
  /** Copy-paste setup steps with the real emit URL substituted. */
  instructions: (emitUrl: string) => string[];
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "zapier",
    label: "Zapier",
    signatureVerified: false,
    defaultEventName: "zap",
    blurb: "Fire this automation from any Zap.",
    instructions: (url) => [
      "In Zapier, add a final action step to your Zap: \"Webhooks by Zapier\" → \"POST\".",
      `Set the URL to: ${url}`,
      "Set Payload Type to \"json\" and add the data fields you want this automation to receive.",
      "Test the Zap — the event appears under Recent events within seconds."
    ]
  },
  {
    id: "ifttt",
    label: "IFTTT",
    signatureVerified: false,
    defaultEventName: "ifttt",
    blurb: "Use the \"Webhooks\" action in any Applet.",
    instructions: (url) => [
      "In IFTTT, create an Applet and choose \"Webhooks\" → \"Make a web request\" as the THEN action.",
      `Set the URL to: ${url}`,
      "Method: POST · Content Type: application/json.",
      "Body example: {\"value1\":\"{{Value1}}\",\"value2\":\"{{Value2}}\"} (IFTTT ingredients become payload fields)."
    ]
  },
  {
    id: "n8n-make",
    label: "n8n / Make",
    signatureVerified: false,
    defaultEventName: "workflow",
    blurb: "Call from an HTTP Request node/module.",
    instructions: (url) => [
      "Add an HTTP Request node (n8n) or HTTP module (Make) at the point in your flow that should trigger this automation.",
      `Method: POST · URL: ${url}`,
      "Body Content Type: JSON — map the fields you want the automation to see.",
      "Run the flow once; the event shows under Recent events."
    ]
  },
  {
    id: "slack-workflow",
    label: "Slack Workflow Builder",
    provider: "slack",
    signatureVerified: true,
    defaultEventName: "slack",
    blurb: "Trigger from a Slack workflow step (signature-verified).",
    instructions: (url) => [
      "In Slack, open Workflow Builder and add a step: \"Send a web request\".",
      `Set the request URL to: ${url}`,
      "Method: POST · add the workflow variables you want as JSON body fields.",
      "Paste your Slack signing secret below so we can verify requests really come from Slack (Slack app settings → Basic Information → Signing Secret)."
    ]
  },
  {
    id: "twilio-sms",
    label: "Twilio SMS",
    signatureVerified: false,
    defaultEventName: "sms",
    blurb: "Run a kit whenever a text message arrives.",
    instructions: (url) => [
      "In the Twilio Console, open your phone number → Messaging Configuration.",
      `Set \"A message comes in\" to Webhook, URL: ${url}`,
      "Method: HTTP POST. Twilio sends From/To/Body as form fields — they arrive as payload fields.",
      "Send a test SMS to your number and check Recent events."
    ]
  },
  {
    id: "home-assistant",
    label: "Home Assistant",
    signatureVerified: false,
    defaultEventName: "home",
    blurb: "Fire from any Home Assistant automation.",
    instructions: (url) => [
      "In Home Assistant, add a rest_command to configuration.yaml (or use a webhook action in an automation):",
      `rest_command:\n  agentkit_auto:\n    url: "${url}"\n    method: POST\n    content_type: application/json\n    payload: '{"entity":"{{ trigger.entity_id }}","state":"{{ trigger.to_state.state }}"}'`,
      "Call service rest_command.agentkit_auto from any automation's actions."
    ]
  },
  {
    id: "github",
    label: "GitHub",
    provider: "github",
    signatureVerified: true,
    defaultEventName: "github",
    blurb: "Repo/org webhooks (pushes, issues, PRs) — signature-verified.",
    instructions: (url) => [
      "In your GitHub repo (or org): Settings → Webhooks → Add webhook.",
      `Payload URL: ${url}`,
      "Content type: application/json · pick the events you care about.",
      "Generate a random secret, paste it into GitHub's \"Secret\" field AND into the signing-secret input below — we verify X-Hub-Signature-256 on every delivery."
    ]
  },
  {
    id: "stripe",
    label: "Stripe",
    provider: "stripe",
    signatureVerified: true,
    defaultEventName: "stripe",
    blurb: "Payments/subscriptions events — signature-verified.",
    instructions: (url) => [
      "In the Stripe Dashboard: Developers → Webhooks → Add endpoint.",
      `Endpoint URL: ${url}`,
      "Select the events to send (e.g. invoice.paid, customer.subscription.updated).",
      "After creating the endpoint, reveal its \"Signing secret\" (whsec_…) and paste it below — we verify Stripe-Signature on every delivery."
    ]
  },
  {
    id: "cloudwatch-sns",
    label: "CloudWatch (SNS)",
    provider: "sns",
    signatureVerified: true,
    defaultEventName: "alarm",
    blurb: "AWS alarms via an SNS HTTPS subscription — signature-verified.",
    instructions: (url) => [
      "Create (or reuse) an SNS topic and point your CloudWatch alarm's actions at it.",
      `Add an HTTPS subscription to the topic with endpoint: ${url}`,
      "SNS sends a SubscriptionConfirmation first — we confirm it automatically and verify the SNS message signature on every notification.",
      "No secret needed below: SNS messages are verified against AWS's signing certificates."
    ]
  },
  {
    id: "grafana",
    label: "Grafana",
    signatureVerified: false,
    defaultEventName: "grafana",
    blurb: "Alerting contact point → webhook.",
    instructions: (url) => [
      "In Grafana: Alerting → Contact points → Add contact point → Webhook.",
      `URL: ${url}`,
      "HTTP Method: POST. Attach the contact point to your notification policy.",
      "Fire a test notification — the alert payload appears under Recent events."
    ]
  },
  {
    id: "alertmanager",
    label: "Alertmanager",
    signatureVerified: false,
    defaultEventName: "alerts",
    blurb: "Prometheus Alertmanager webhook receiver.",
    instructions: (url) => [
      "Add a webhook receiver to alertmanager.yml:",
      `receivers:\n  - name: agentkit-auto\n    webhook_configs:\n      - url: "${url}"`,
      "Route the alerts you want to that receiver and reload Alertmanager."
    ]
  },
  {
    id: "datadog",
    label: "Datadog",
    signatureVerified: false,
    defaultEventName: "datadog",
    blurb: "Monitor alerts via the Webhooks integration.",
    instructions: (url) => [
      "In Datadog: Integrations → Webhooks → New Webhook.",
      `Name it (e.g. agentkit-auto) and set the URL to: ${url}`,
      "In your monitor's message add @webhook-agentkit-auto so alerts POST here.",
      "The default JSON payload (title, alert status, tags) arrives as payload fields."
    ]
  },
  {
    id: "sentry",
    label: "Sentry",
    signatureVerified: false,
    defaultEventName: "sentry",
    blurb: "Error/issue alerts via a webhook alert rule.",
    instructions: (url) => [
      "In Sentry: Settings → Integrations → Webhooks → enable, then add:",
      `Callback URL: ${url}`,
      "Create an Alert Rule whose action is \"Send a notification via WebHooks\".",
      "New issues/alerts POST their JSON payload to this automation."
    ]
  },
  {
    id: "uptimerobot",
    label: "UptimeRobot",
    signatureVerified: false,
    defaultEventName: "uptime",
    blurb: "Up/down monitor alerts.",
    instructions: (url) => [
      "In UptimeRobot: My Settings → Alert Contacts → Add Alert Contact → type Webhook.",
      `URL to notify: ${url}&`,
      "Enable \"Send as JSON (application/json)\" and POST; keep the default *monitorFriendlyName*/*alertType* placeholders in the JSON value.",
      "Attach the alert contact to your monitors."
    ]
  }
];

export function presetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}
