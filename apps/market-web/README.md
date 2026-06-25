# AgentKitMarket App

AgentKitMarket is the public discovery, validation, review, and distribution surface for Agent Kits.

## Local Development

Install dependencies:

```bash
npm ci
```

Run the app:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Backend API Configuration

Set the public read API base URL:

```bash
NEXT_PUBLIC_AGENTKITMARKET_API_BASE_URL=https://u8u5r1puai.execute-api.us-east-1.amazonaws.com/v0
```

The app reads:

- `GET /health`
- `GET /kits`
- `GET /kits/{slug}`

Admin ingestion reads/writes through server-side Next.js route handlers that attach `AGENTKITMARKET_ADMIN_KEY`:

- `POST /admin/submissions/upload-url`
- `POST /admin/submissions/{submissionId}/validate`
- `POST /admin/submissions/{submissionId}/approve`
- `POST /admin/submissions/{submissionId}/reject`
- `POST /admin/submissions/{submissionId}/publish`
- `POST /admin/submissions/{submissionId}/archive`
- `POST /admin/submissions/{submissionId}/remove`
- `POST /admin/kits/{kitId}/hide`
- `POST /admin/kits/{kitId}/unhide`
- `POST /admin/kits/{kitId}/remove`
- `GET /admin/submissions`
- `GET /admin/submissions/{submissionId}`

Signed-in user submissions use the same backend ingestion API through user-facing server route handlers:

- `POST /api/submissions/upload-url`
- `POST /api/submissions/{submissionId}/validate`
- `POST /api/forge/submissions/upload-url`
- `POST /api/forge/submissions/{submissionId}/validate`
- `POST /api/submissions/{submissionId}/cancel`
- `POST /api/kits/{kitId}/remove`
- `GET /api/submissions`
- `GET /api/submissions/{submissionId}`

Browser submission routes require an AgentKitProject web session. Forge submission routes require `Authorization: Bearer <token>` from Forge's AgentKitProject login flow. Both derive user identity server-side and never trust submitter identity sent by the browser or Forge request body. New submissions send listing name/title and public metadata only; clients do not choose `publisherId`, `kitId`, `slug`, or `kitSlug`. Owner cancel/remove routes send only the session-derived `userId` to the backend, which enforces ownership.

Signed-in kit downloads use a user-facing server route:

- `POST /api/kits/{slug}/download`
- `POST /api/forge/kits/{slug}/download`

The browser route requires an AgentKitProject web session. The Forge desktop route requires `Authorization: Bearer <token>` from Forge's AgentKitProject login flow. Market validates the bearer token server-side, calls `POST /admin/kits/by-slug/{slug}/download-url` with `AGENTKITMARKET_ADMIN_KEY` server-side, and returns only the backend's short-lived `downloadUrl`. Package objects remain private in S3; public pages and Forge responses do not display `packageS3Key` or direct bucket URLs.

Development fallback behavior:

- If `NEXT_PUBLIC_AGENTKITMARKET_API_BASE_URL` is missing and `NODE_ENV=development`, the app uses local mock catalog data.
- If `NEXT_PUBLIC_AGENTKITMARKET_USE_MOCKS=true`, the app uses local mock catalog data.

Production behavior:

- The API base URL must be configured.
- Public catalog pages only render kits with `status=published`, `validationStatus=passed`, and `reviewStatus=approved`.
- Public catalog reads use `cache: "no-store"` plus dynamic pages so newly published kits appear after refresh.
- Failed API requests render a user-friendly unavailable state.
- The app does not silently fall back to mocks in production.

## AWS Amplify Hosting

This app is prepared for AWS Amplify Hosting with [amplify.yml](/Users/jag8765/ws/agentkit/agentkitmarket-app/amplify.yml).

Required Amplify environment variables must be set directly on the Amplify `main` branch. If you update a branch with the AWS CLI, include the full environment map because `update-branch` may replace existing values rather than merging them.

Client-safe environment variables:

```bash
NEXT_PUBLIC_AGENTKITMARKET_API_BASE_URL=https://u8u5r1puai.execute-api.us-east-1.amazonaws.com/v0
NEXT_PUBLIC_APP_URL=https://market.agentkitproject.com
NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://market.agentkitproject.com/auth/callback
```

Server-only app/auth variables:

```bash
WORKOS_API_KEY=sk_...
WORKOS_CLIENT_ID=client_...
WORKOS_COOKIE_PASSWORD=at-least-32-characters
WORKOS_REDIRECT_URI=https://market.agentkitproject.com/auth/callback
APP_URL=https://market.agentkitproject.com
AGENTKITMARKET_ADMIN_EMAILS=jag8765@gmail.com
AGENTKITMARKET_ADMIN_KEY=service-to-service-admin-key
AGENTKITMARKET_AUTH_DEBUG=false
```

AgentKitProfile server-side environment variables:

```bash
PROFILE_API_BASE_URL=https://profile.agentkitproject.com/api
PROFILE_SERVICE_KEY=optional-profile-service-key
```

`AGENTKITMARKET_ADMIN_KEY`, `PROFILE_SERVICE_KEY`, `WORKOS_API_KEY`, and `WORKOS_COOKIE_PASSWORD` are server-side only. Never expose secrets through a `NEXT_PUBLIC_` variable. `NEXT_PUBLIC_*` values are embedded into browser-delivered JavaScript and must be treated as public.

`APP_URL` is the canonical production app origin. Auth sign-in converts relative return paths such as `/admin` into absolute URLs under this origin, sign-out returns to this origin, and production builds reject localhost app or callback URLs. Configure the same callback URL in the WorkOS dashboard:

```text
https://market.agentkitproject.com/auth/callback
```

Do not set this in Amplify production:

```bash
NEXT_PUBLIC_AGENTKITMARKET_USE_MOCKS=true
```

Amplify build behavior:

- Fails early if `NEXT_PUBLIC_AGENTKITMARKET_API_BASE_URL` is missing.
- Fails early if `APP_URL`, `NEXT_PUBLIC_APP_URL`, `WORKOS_REDIRECT_URI`, or `NEXT_PUBLIC_WORKOS_REDIRECT_URI` is missing or points to localhost.
- Fails early if production mock mode is enabled.
- Writes `NEXT_PUBLIC_AGENTKITMARKET_API_BASE_URL`, `APP_URL`, `NEXT_PUBLIC_APP_URL`, `WORKOS_REDIRECT_URI`, and `NEXT_PUBLIC_WORKOS_REDIRECT_URI` into `.env.production` during `preBuild`.
- Runs `npm ci`.
- Runs `npm run build`.

The expected backend API URL for the current infra output is:

```bash
https://u8u5r1puai.execute-api.us-east-1.amazonaws.com/v0
```

Custom domain:

```text
market.agentkitproject.com
```

## Continuous Integration

GitHub Actions runs `npm ci`, `npm run lint --if-present`, `npm test --if-present`, and `npm run build` on pull requests, with a manual `workflow_dispatch` option. It does not run on pushes to `main`; Amplify remains the build/deploy source for the main branch.

The intended flow is PR → GitHub CI passes → merge to `main` → Amplify builds and deploys. Branch protection should require the `CI` status check before merge. The CI workflow does not deploy, configure AWS credentials, invalidate CloudFront, call Amplify APIs, or perform release automation.

## Current Scope

The canonical roadmap lives at https://agentkitproject.com/roadmap. AgentKitMarket keeps this README focused on marketplace browsing, submission, downloads, and admin workflows.

Implemented:

- Public catalog shell.
- API-backed kit listing and detail pages.
- Public homepage with featured kits, category/tag entry points, trust/safety copy, and AgentKitForge placeholder.
- Search, category, tag, and trust filters on `/kits`.
- Safe publisher display data from AgentKitProfile snapshots.
- Signed-in user `.agentkit.zip` submission flow.
- Signed-in user `.agentkit.zip` download flow for approved kits.
- Admin upload, validation, review, approval, rejection, publish, submission removal, and kit hide/unhide/remove listing flows.
- Footer placeholders for terms, privacy, security, support, and listing reports.
- Docs and central roadmap link placeholders.

Not implemented:

- Payments.
- Corporate organization roles.
- Private organization catalogs.
- AWS credentials in the app.

## Paid Kits And Seller Payouts (Stripe Connect)

Paid kits use Stripe Checkout. Each sale routes proceeds to the selling
organization via a Stripe Connect **destination charge** (Express connected
account), and the platform keeps a **10% fee** (`PLATFORM_FEE_PERCENT` in
`lib/stripe-connect.ts`). Paid sales are **blocked** until the owning org
completes payout onboarding (no escrow / held funds): the Buy button shows
"Seller hasn't set up payouts yet" and checkout returns a `409
seller_payout_setup_pending`. Org owners/admins set this up under
Organizations → (org) → Payouts.

Provisioning required (server-side only, `STRIPE_SECRET_KEY` /
`STRIPE_WEBHOOK_SECRET`; payments + payouts are inert without them):

1. **Enable Stripe Connect** in the Stripe dashboard for these keys.
2. **Subscribe the webhook** (`/api/stripe/webhook`) to `account.updated` (in
   addition to the existing `checkout.session.completed`,
   `customer.subscription.updated`, `customer.subscription.deleted`) so each
   org's `chargesEnabled`/`payoutsEnabled` stay in sync.

Refunds/chargebacks claw funds back from the connected account proportionally
(no refund UI here). If an org loses `payouts_enabled`, new purchases are
blocked by the gate; existing buyer entitlements are unaffected. Self-hosted
Market needs its own Connect-enabled Stripe keys.

## Security And Data Boundaries

Public users can browse kits, view kit detail pages, and see safe publisher display data. Signed-in users can submit kits, view their own submissions, cancel pending submissions, remove their own published listings, and download approved kits. Admins/owners can validate submissions, approve or reject submissions, publish kits, hide or unhide kits, remove listings, and remove test submissions from the active queue.

AgentKitProfile owns shared account/profile UX at `https://profile.agentkitproject.com/account` plus public display profile fields: handle, display name, avatar initials, and verification state. AgentKitProject owns the centralized roadmap at `https://agentkitproject.com/roadmap`.

Public pages must not show:

- `submittedByEmail`
- `submittedByUserId`
- Raw WorkOS user IDs
- `packageS3Key`
- Package bucket/object paths except inside short-lived signed S3 download URLs after an authenticated request
- `AGENTKITMARKET_ADMIN_KEY`
- `PROFILE_SERVICE_KEY`
- `WORKOS_API_KEY`
- `WORKOS_COOKIE_PASSWORD`

Admin pages may show `submittedByEmail`, `submittedByUserId`, and `packageS3Key` for review/debug context. These values must stay out of public kit pages and public browser bundles.

The browser never sends `x-agentkitmarket-admin-key`. Browser code calls local Next.js routes; server route handlers attach service/admin keys server-side after `requireUser()` or `requireAdmin()` checks. Signed-in downloads return only a short-lived pre-signed S3 URL. The package bucket remains private.

Security verification commands:

```bash
curl -s "$API/kits/$SLUG" | jq '.. | objects | select(has("packageS3Key") or has("submittedByEmail") or has("submittedByUserId"))'
```

```bash
grep -RIn "AGENTKITMARKET_ADMIN_KEY\\|PROFILE_SERVICE_KEY\\|WORKOS_API_KEY\\|x-agentkitmarket-admin-key" .next/static
```

The first command should return no objects for public kit API responses. The second command should return no matches in client static bundles.

## Admin Review And Publishing

Admin upload, review, and publishing are AuthKit-protected flows for `.agentkit.zip` packages. They are available at:

- `/admin/upload`
- `/admin/submissions`
- `/admin/submissions/{submissionId}`
- `/admin/review`

Admin access is protected by WorkOS AuthKit plus an email allowlist:

```bash
AGENTKITMARKET_ADMIN_EMAILS=jag8765@gmail.com
AGENTKITMARKET_ADMIN_KEY=replace-with-temporary-admin-key
```

The browser never receives `AGENTKITMARKET_ADMIN_KEY`. The UI calls local Next.js route handlers under `/api/admin/...`, and those server handlers require an authenticated admin/owner AgentKitProject account before calling backend admin APIs.

Do not use `NEXT_PUBLIC_AGENTKITMARKET_ADMIN_KEY` in production. WorkOS AuthKit is the login layer; the admin key remains a service-to-service backend credential.

The admin UI intentionally does not display raw package contents, S3 keys, validation logs, full skill markdown, full prepared prompt text, or file trees. It only shows public-safe extracted metadata and summaries.

Review workflow:

- Pending validation and failed validation submissions are visible in the review queue but cannot be approved or published.
- Admins can approve submissions only after `validationStatus=passed`.
- Admins can reject unpublished submissions, and rejection requires review notes.
- Admins can publish only after `validationStatus=passed` and `reviewStatus=approved`.
- Public catalog visibility requires `status=published`, `validationStatus=passed`, and `reviewStatus=approved`.
- Admin submission queues include status, validation, review, submitter, and history filters. Archived/canceled submissions and approved/rejected submissions older than the backend retention window are excluded from the default queue but remain available when history is included.
- Admins can remove unpublished submissions from the active queue without deleting history. Published submissions should use listing visibility actions instead.
- Admins can hide, unhide, or remove a published kit listing through the detail page when a `kitId` is available. Hide/unhide changes catalog visibility; remove withdraws the public listing.

## Signed-In User Submissions

Any signed-in AgentKitProject user can submit a `.agentkit.zip` package at `/submit` and view their own submissions at `/submissions`.

Submission rules:

- Anonymous users visiting `/submit` or `/submissions` are redirected to sign in.
- The browser sends listing draft metadata and the selected package name only.
- The browser does not expose editable `kitId`, `slug`, or `kitSlug` fields.
- Next.js server routes derive `submittedByUserId` and `submittedByEmail` from the WorkOS session.
- Next.js server routes fetch a safe public profile snapshot from AgentKitProfile, require `displayName`, use that display name as the Market publisher identity, and send only `displayName`, `handle`, `avatarInitials`, and `verified` to the Market backend.
- Next.js server routes attach `AGENTKITMARKET_ADMIN_KEY` when calling backend mutation APIs.
- Non-admin users can only list or view submissions associated with their own session identity.
- Users can cancel their own pending submissions before review closes.
- Users can remove their own published listings; the backend verifies ownership against the session-derived user ID.
- If the backend detects an active duplicate kit/version submission, Market shows `You already have an active submission for this kit/version.` and links back to `/submissions`.
- User submission pages show validation, review, published, rejected, archived, canceled, removed, and failure status descriptions so submitters can understand the next step.
- Raw package contents, full prompt text, full skill markdown, validation logs, S3 keys, and file trees are not displayed.
- Public pages do not show emails, raw WorkOS user IDs, raw internal user IDs, or raw publisher IDs that look like user IDs.
- Market displays backend-generated slugs and kit IDs only after they are returned by submission/publish workflows.

Admins/owners continue to review and publish through `/admin/*`.

AgentKitProfile owns public display profiles at `https://profile.agentkitproject.com`. Market snapshots safe publisher profile fields during submission/publish so public listings can render a display name, handle, avatar initials, and verification state without exposing private email or raw user ids. New user/Forge submissions require an AgentKitProfile display name. Existing published kits may need republish or resync to receive updated publisher profile fields.

Public publisher display priority is `displayName`, then `handle`, then `AgentKit user`. Public pages must not render emails, raw WorkOS user IDs, raw internal user IDs, `submittedByEmail`, `submittedByUserId`, `packageS3Key`, or service secrets.

## Authenticated Kit Downloads

Anonymous users can browse `/kits` and view public kit details, but downloading a package requires a signed-in AgentKitProject account. Public kit detail pages show `Sign in to download` for anonymous visitors and `Download .agentkit.zip` for signed-in users.

The browser calls only the local route `POST /api/kits/{slug}/download`. That route derives the user from the WorkOS session, attaches `AGENTKITMARKET_ADMIN_KEY` server-side, and asks the backend for a short-lived pre-signed S3 download URL. The browser then navigates to that returned URL.

AgentKitForge desktop can request a package URL with `POST /api/forge/kits/{slug}/download` and an `Authorization: Bearer <token>` header from Forge's optional AgentKitProject login. Market verifies the bearer token against WorkOS/AuthKit server-side, derives the user from verified token claims, and then calls the same backend download-url route with the server-side admin key. Forge never receives `AGENTKITMARKET_ADMIN_KEY`, never calls backend admin routes directly, and does not send user IDs or emails in the request body.

The Forge response is limited to safe download metadata:

```json
{
  "kitId": "...",
  "slug": "...",
  "version": "...",
  "fileName": "...",
  "packageSizeBytes": 123,
  "sha256": "...",
  "downloadUrl": "...",
  "expiresIn": 300
}
```

Invalid, missing, or expired Forge bearer tokens return `401` with safe JSON such as `NOT_SIGNED_IN` or `INVALID_TOKEN`. If Forge's login flow changes to a token format Market cannot verify, the route must return an explicit unsupported/error response rather than trusting unsigned client data.

Forge desktop submit uses the same bearer-token model:

- `POST /api/forge/submissions/upload-url`
- `POST /api/forge/submissions/{submissionId}/validate`

Forge sends only package/listing draft fields. Market verifies the bearer token, derives the canonical user ID from verified claims, fetches the AgentKitProfile display name, uses that display name as the backend `publisherId`, and calls backend ingestion/validation APIs with `AGENTKITMARKET_ADMIN_KEY` server-side. Forge never receives the admin key and does not send trusted `publisherId`, `submittedByUserId`, `submittedByEmail`, `publisherSnapshot`, `kitId`, `slug`, or `kitSlug` values.

Forge submit uses the same `requireForgeUser()` bearer-token helper as Forge download. Device-auth tokens are accepted when their signature verifies and they include a stable subject; browser-session-specific claims and email claims in the token are optional. For hosted Market submissions, the app then verifies the subject against the WorkOS User Management API server-side and uses the account email from that canonical WorkOS user record. If the account lookup fails or the account has no email, Market returns `PROFILE_INCOMPLETE` rather than trusting Forge-provided identity.

## Server-Owned Kit Identity

AgentKitMarket clients do not generate canonical kit identity. Web submit and Forge submit send a listing name/title, summary, description, categories, tags, version, and package file name. The Market app server derives authenticated user identity and safe publisher snapshot fields, uses the AgentKitProfile display name as `publisherId`, and does not accept `publisherId`, `kitId`, `slug`, or `kitSlug` from user-controlled request bodies.

Canonical `kitId` and public URL `slug` generation belongs to the Market backend because it owns the DynamoDB writes. The backend should:

- Generate `kitId` server-side and retry if a conditional write detects a collision.
- Generate the base slug from `listingDraft.name`.
- Allow duplicate names/titles.
- For slug collisions, append an incrementing suffix such as `my-kit`, `my-kit-2`, and `my-kit-3`.
- Enforce unique kit IDs and slugs with conditional writes or an equivalent atomic uniqueness record.
- Retry slug suffix allocation at write time so concurrent publishes cannot create duplicate public URLs.
- Ignore or reject any client-supplied `kitId`, `slug`, or `kitSlug` on new submissions.

Public URLs use the backend-generated slug. Submission and listing management pages may display generated `kitId` or slug after the backend returns them.

Public kit details may show safe package metadata such as version, file name, package size, SHA-256 checksum, and publication date. Package objects stay private. Market does not expose raw S3 keys, package contents, direct public bucket URLs, or the backend admin key. If a pre-signed URL expires, the user can click download again to request a fresh one.

The detail page includes an `Open in Forge` action. It launches AgentKitForge with a safe reference such as:

```text
agentkitforge://market/import?market=https%3A%2F%2Fmarket.agentkitproject.com&kit=sales-report-generator
```

The deep link passes the Market base URL and kit slug, and may include a public-safe `kitId` later. It never includes auth tokens, signed S3 URLs, `downloadUrl`, `packageS3Key`, admin/service keys, submitter metadata, or raw package internals. Forge handles authenticated download and import after launch. Manual `.agentkit.zip` download remains available for signed-in web users.

Report listing support uses a placeholder workflow. Public pages and the footer link to support mailto/report placeholders with copy that the abuse/reporting workflow is coming soon.

## WorkOS AuthKit

WorkOS AuthKit is the AgentKitProject account provider for Market route protection. AgentKitProfile owns shared account/profile UX at `https://profile.agentkitproject.com/account`; AgentKitMarket links account/profile actions there and keeps marketplace-specific permissions local.

Auth routes:

- `/auth/sign-in`
- `/auth/callback`
- `/auth/sign-out`

Production auth URL configuration:

```bash
APP_URL=https://market.agentkitproject.com
NEXT_PUBLIC_APP_URL=https://market.agentkitproject.com
WORKOS_REDIRECT_URI=https://market.agentkitproject.com/auth/callback
NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://market.agentkitproject.com/auth/callback
```

In development, these can point to `http://localhost:3000`. In production, localhost values are rejected so post-login and sign-out redirects stay on `https://market.agentkitproject.com`.

Sign-out must be rendered as a full-page navigation, not a prefetched Next.js `<Link>` or client-side fetch. The header uses a plain `<a href="/auth/sign-out">` link. The sign-out route ignores prefetch/RSC probes, clears local AuthKit cookies, and redirects to server-side `APP_URL`, so Market returns to `https://market.agentkitproject.com/` and never redirects to sign-in, localhost, WorkOS logout, or another AgentKitProject app.

The WorkOS cookie password must be stable across deployments and at least 32 characters. Leave `WORKOS_COOKIE_DOMAIN` unset for a host-only cookie on `market.agentkitproject.com` unless a broader AgentKitProject domain cookie is intentionally introduced later. Set `AGENTKITMARKET_AUTH_DEBUG=true` temporarily to emit safe session lifecycle logs without tokens, cookies, API keys, or authorization headers.

Admins can inspect safe runtime auth state at `/debug/session`. In production this route is only available to admin/owner users; in development it can also show anonymous state.

The callback route saves the AuthKit session using the configured `WORKOS_REDIRECT_URI` so production cookie attributes are based on `https://market.agentkitproject.com/auth/callback`, even if hosting infrastructure presents a different internal request URL.

Market roles:

- `anonymous`: public catalog only.
- `user`: signed-in user; can submit kits and download approved kits.
- `admin`: upload, validate, review, publish administration.
- `owner`: system-level controls.

In Market, `admin` is derived from `AGENTKITMARKET_ADMIN_EMAILS`, a comma-separated case-insensitive allowlist. There is no `publisher` auth role requirement.

AgentKitMarket permission rules:

- Anonymous users can browse and view public listings.
- Signed-in users can submit kits.
- Signed-in users can download approved kits.
- Admins/owners can review submissions and publish kits.

Organization roles, SSO policy, private catalogs, AgentKitForge login integration, and corporate marketplace controls are covered by the centralized AgentKitProject roadmap.

## Self-Hosting Direction

Hosted AgentKitMarket uses WorkOS/AuthKit. App authorization should stay organized around internal helpers such as `requireUser()`, `requireAdmin()`, `canDownloadKit()`, `canSubmitKit()`, `canReviewSubmission()`, and `canPublishKit()`.

Future self-hosted deployments can map OIDC, SAML, local auth, or other identity claims into the same internal roles and permissions. Marketplace business logic should not be hardwired directly to WorkOS-specific objects beyond the auth/session adapter layer.

The hosted Forge desktop download endpoint is for AgentKitProject Market. Future private or self-hosted markets can provide their own equivalent authenticated download route using their own auth model while preserving the same server-side service-key boundary.
