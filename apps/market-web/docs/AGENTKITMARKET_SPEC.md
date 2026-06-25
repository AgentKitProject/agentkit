# AgentKitMarket Spec

AgentKitMarket is the discovery, publishing, validation, review, and distribution layer for Agent Kits in the AgentKitProject family. It is distinct from AgentKitForge and AgentKitAuto: Forge is the creation/import destination, Auto is not implemented here, and Market uses the cyan/teal catalog and discovery identity from `reference/`.

## Roadmap

The canonical AgentKitProject roadmap lives at https://agentkitproject.com/roadmap. AgentKitMarket does not maintain separate roadmap details in this app.

Current AgentKitMarket app behavior:

- Public users can browse kits, view kit detail pages, and view safe publisher display data.
- Signed-in users can submit kits, view their own submissions, and download approved kits.
- Admins/owners can validate submissions, approve or reject submissions, publish kits, hide or unhide kits, remove listings, and remove test submissions from the active queue.
- AgentKitProfile owns account/profile UX and public display profile fields.
- AgentKitProject owns the centralized roadmap.

## Trust Model

AgentKitMarket uses four visible trust statuses:

- `Validated`: the kit package is expected to pass automated structural and policy checks.
- `Reviewed`: a human or trusted review process has approved the public listing.
- `Verified Publisher`: the publisher identity has been verified.
- `Featured`: the marketplace has editorially promoted the listing.

The admin UI uses backend validation and review statuses while keeping raw package internals out of the browser UI.

## Listing Visibility Model

Public AgentKitMarket listings must satisfy all of:

- `status=published`
- `validationStatus=passed`
- `reviewStatus=approved`

Public listings must not expose:

- Full skill markdown.
- Full prepared prompt text.
- Raw kit files.
- Full file tree.
- `packageS3Key` or direct bucket URLs.
- `submittedByEmail`, `submittedByUserId`, or raw WorkOS user IDs.
- Server secrets such as `AGENTKITMARKET_ADMIN_KEY`, `PROFILE_SERVICE_KEY`, `WORKOS_API_KEY`, or `WORKOS_COOKIE_PASSWORD`.
- Enough implementation detail to recreate the kit without downloading or importing it.

## Data Model

Initial mock kit fields:

- `slug`
- `name`
- `summary`
- `publisher`
- `publisherSlug`
- `categories`
- `tags`
- `version`
- `trust`
- `requiredInputs`
- `preparedPromptSummaries`
- `skillSummaries`
- `outcomes`
- `updatedAt`
- `downloads`

Initial mock publisher fields:

- `slug`
- `name`
- `summary`
- `verified`
- `kits`
- `domain`

## Publishing Flow

1. Any signed-in AgentKitProject user prepares public metadata.
2. The user submits a `.agentkit.zip` package.
3. The app obtains a short-lived upload URL through a server route.
4. The browser uploads the package directly to private S3 through the pre-signed URL.
5. The app queues validation through a server route.
6. Admins review public-safe metadata and validation results.
7. Admins approve or reject the submission.
8. Approved, validation-passed submissions can be published.
9. Published kits become visible through the public catalog API.

## Public Read API

The app is wired to the initial public read API with:

- `NEXT_PUBLIC_AGENTKITMARKET_API_BASE_URL`
- `GET /health`
- `GET /kits`
- `GET /kits/{slug}`

Development can use local mocks when the API base URL is missing or `NEXT_PUBLIC_AGENTKITMARKET_USE_MOCKS=true`. Production must be configured with a real API URL and does not silently fall back to mocks when the backend fails.

Public catalog reads use uncached server fetches (`cache: "no-store"`) and dynamic route rendering so newly published kits appear after refresh.

The public UI consumes summarized metadata only. It must not display raw package contents, S3 keys, internal validation logs, full prompt text, full skill markdown, or file trees.

Catalog browsing supports client-side search and filters over already-public kits:

- Search by kit, summary, publisher, version, category, or tag.
- Category filter.
- Tag filter.
- Trust filter for validated/reviewed, featured, or verified publisher listings.
- Empty search result and backend unavailable states.

## Admin Package Ingestion

Market includes an admin-only upload and validation flow:

1. Admin enters listing draft metadata.
2. Admin selects a `.agentkit.zip` package.
3. The app requests `POST /admin/submissions/upload-url` through a server-side proxy.
4. The browser uploads the package to the returned pre-signed URL.
5. The app requests `POST /admin/submissions/{submissionId}/validate` through a server-side proxy.
6. Admin can view validation status and public-safe extracted metadata in the submission queue and detail pages.
7. Admin can approve, reject, publish, remove submissions, or hide/unhide/remove kit listings through server-side admin proxy routes.

Admin routes:

- `/admin`
- `/admin/upload`
- `/admin/submissions`
- `/admin/submissions/{submissionId}`
- `/admin/review`

Admin server proxy routes:

- `POST /api/admin/submissions/{submissionId}/approve`
- `POST /api/admin/submissions/{submissionId}/reject`
- `POST /api/admin/submissions/{submissionId}/publish`
- `POST /api/admin/submissions/{submissionId}/archive`
- `POST /api/admin/submissions/{submissionId}/remove`
- `POST /api/admin/kits/{kitId}/hide`
- `POST /api/admin/kits/{kitId}/unhide`
- `POST /api/admin/kits/{kitId}/remove`

Temporary configuration:

- `AGENTKITMARKET_ADMIN_KEY` is server-side only.
- `NEXT_PUBLIC_AGENTKITMARKET_ADMIN_KEY` must not be used in production.
- WorkOS AuthKit protects admin pages and server proxy routes.
- `AGENTKITMARKET_ADMIN_EMAILS` is a comma-separated, case-insensitive allowlist for admin users.
- The backend admin key remains service-to-service only and is attached by Next.js server route handlers.

Raw package contents, S3 keys, internal validation logs, full skill markdown, full prepared prompt text, and full file trees are intentionally not displayed.

Admin pages may show `submittedByEmail`, `submittedByUserId`, and `packageS3Key` for review/debug context. Those fields must remain unavailable on public pages.

## Signed-In User Submissions

1. Anonymous users visiting `/submit`, `/submissions`, or `/submissions/{submissionId}` are redirected through Market sign-in.
2. Signed-in users enter listing draft metadata and select a `.agentkit.zip` package.
3. The browser calls `POST /api/submissions/upload-url`.
4. The Next.js route derives `submittedByUserId` and `submittedByEmail` from the WorkOS session.
5. The Next.js route fetches safe public profile data from AgentKitProfile.
6. The Next.js route sends a `publisherSnapshot` containing only `displayName`, `handle`, `avatarInitials`, and `verified`.
7. The Next.js route calls the backend admin upload-url endpoint with `AGENTKITMARKET_ADMIN_KEY` server-side.
8. The browser uploads to the returned short-lived pre-signed S3 URL.
9. The browser calls `POST /api/submissions/{submissionId}/validate`.
10. The signed-in user can view their own submission status at `/submissions/{submissionId}`.
11. If a duplicate active kit/version submission is detected, the app shows a friendly conflict message and links the user back to their submissions.
12. A signed-in submitter can cancel their own pending submission or remove their own published listing through server-side routes that derive `userId` from the session.

User-facing submit forms do not expose editable `kitId`, `slug`, or `kitSlug` fields. Users provide the listing name/title and public metadata only. The app may display backend-generated slugs and kit IDs after submission or publish workflows return them.

User-facing server routes:

- `POST /api/kits/{slug}/download`
- `POST /api/forge/kits/{slug}/download`
- `POST /api/submissions/upload-url`
- `POST /api/submissions/{submissionId}/validate`
- `POST /api/forge/submissions/upload-url`
- `POST /api/forge/submissions/{submissionId}/validate`
- `POST /api/submissions/{submissionId}/cancel`
- `POST /api/kits/{kitId}/remove`
- `GET /api/submissions`
- `GET /api/submissions/{submissionId}`

Browser routes require a signed-in web user. Forge routes require a verified bearer token from Forge's AgentKitProject login flow. These routes never trust client-provided submitter identity or client-provided kit identity, attach the backend service key only on the server, and filter non-admin submission access to the current user's own submissions. User cancel/remove calls send only a session-derived `userId`; the backend enforces ownership.

## Authenticated Downloads

Browsing and public kit detail pages are anonymous. Downloading a `.agentkit.zip` package requires a signed-in AgentKitProject account.

Download flow:

1. Anonymous users see `Sign in to download` and return to the kit detail page after login.
2. Signed-in users click `Download .agentkit.zip`.
3. The browser calls `POST /api/kits/{slug}/download`.
4. The Next.js route derives the user from the WorkOS session.
5. The Next.js route calls `POST /admin/kits/by-slug/{slug}/download-url` with `AGENTKITMARKET_ADMIN_KEY` server-side.
6. The backend verifies the kit is `published`, validation-passed, and review-approved.
7. The backend returns a short-lived pre-signed S3 `downloadUrl`.
8. The browser navigates to the returned URL.

Package objects remain private in S3. Public Market pages and browser bundles must not expose `AGENTKITMARKET_ADMIN_KEY`, `packageS3Key`, raw package contents, direct public bucket URLs, or full kit internals. Expired URLs can be refreshed by clicking download again. AgentKitForge import integration is deferred.

The browser never sends `x-agentkitmarket-admin-key`. Download and mutation routes call backend admin/service APIs only from Next.js server route handlers after authenticated user/admin checks.

Forge desktop authenticated download flow:

1. AgentKitForge obtains a WorkOS/AuthKit bearer token from its optional AgentKitProject login flow.
2. Forge calls `POST /api/forge/kits/{slug}/download` with `Authorization: Bearer <token>`.
3. Market verifies the token server-side against WorkOS/AuthKit JWKS and derives the user from verified token claims.
4. Market does not accept user ID, email, or publisher identity from the Forge request body.
5. Market calls `POST /admin/kits/by-slug/{slug}/download-url` with `AGENTKITMARKET_ADMIN_KEY` server-side.
6. The backend confirms the kit is published, validation-passed, review-approved, and not hidden.
7. Market returns only safe package metadata and a short-lived `downloadUrl` to Forge.

Forge responses must not include `AGENTKITMARKET_ADMIN_KEY`, `packageS3Key`, submitter metadata, backend admin internals, raw validation logs, or secrets. Missing or invalid bearer tokens return `401` with `NOT_SIGNED_IN` or `INVALID_TOKEN`. Backend 404 maps to `KIT_NOT_FOUND`, 403 maps to `DOWNLOAD_NOT_ALLOWED`, backend availability failures map to `BACKEND_UNAVAILABLE`, and server admin config failures map to `SERVER_CONFIG_ERROR`.

If Forge later uses a token format Market cannot verify, Market must return an explicit unsupported/error response rather than accepting unsigned client-provided identity.

Forge desktop authenticated submit flow:

1. AgentKitForge obtains a WorkOS/AuthKit bearer token from its optional AgentKitProject login flow.
2. Forge calls `POST /api/forge/submissions/upload-url` with `Authorization: Bearer <token>` and only package/listing draft fields.
3. Market verifies the bearer token server-side and derives canonical user identity from verified token claims.
4. Market fetches the safe AgentKitProfile publisher snapshot and requires a `displayName`.
5. Market calls `POST /admin/submissions/upload-url` with `AGENTKITMARKET_ADMIN_KEY` server-side and adds backend-only submitter fields plus `publisherId` set to the AgentKitProfile display name.
6. Forge uploads the `.agentkit.zip` package to the returned pre-signed URL.
7. Forge calls `POST /api/forge/submissions/{submissionId}/validate` with the bearer token.
8. Market verifies ownership when practical and calls `POST /admin/submissions/{submissionId}/validate` server-side.

Forge submit responses must not include admin/service keys, private S3 paths, `packageS3Key`, raw validation logs, or package internals. Missing auth returns clean JSON with `NOT_SIGNED_IN`; backend conflicts return `CONFLICT` with the backend message; unexpected backend failures return `MARKET_BACKEND_ERROR`.

Forge submit and Forge download must share the same `requireForgeUser()` bearer-token helper. Hosted Forge device-auth tokens are valid when their signature verifies and they include a stable subject; browser-session-specific claims such as `sid` and email claims in the token are optional. For hosted Market submissions, the app then verifies the subject against the WorkOS User Management API server-side and uses the account email from that canonical WorkOS user record. If the account lookup fails or the account has no email, Market returns `PROFILE_INCOMPLETE` rather than trusting Forge-provided identity.

Forge does not choose publisher IDs, kit IDs, or public slugs for new submissions. If a Forge request body includes `publisherId`, `kitId`, `slug`, or `kitSlug`, Market treats those values as untrusted and does not forward them to the backend upload-url request. New Forge and web submissions require an AgentKitProfile display name because public publisher identity is display-name based.

## Server-Owned Identity And Slugs

Canonical kit identity is backend-owned. AgentKitMarket web and Forge clients submit package/listing data, but the Market backend generates canonical kit IDs and public slugs because it owns the DynamoDB writes and can enforce uniqueness atomically.

Rules:

- Users and Forge submit only `listingDraft.name` plus public metadata; they do not choose `publisherId`, `kitId`, `slug`, or `kitSlug`.
- Duplicate kit IDs are never allowed.
- Duplicate slugs are never allowed.
- Duplicate names/titles are allowed.
- Public URLs use the backend-generated slug.
- New submission and publish APIs must ignore or reject user-controlled `kitId`, `slug`, or `kitSlug`.

Slug generation:

- Generate the base slug server-side from `listingDraft.name`.
- If the base slug exists, allocate an incrementing suffix: `my-kit`, `my-kit-2`, `my-kit-3`.
- Check uniqueness at write time, not with a frontend preflight.

DynamoDB/write safety:

- Use conditional writes, uniqueness records, or equivalent atomic write protection for kit IDs and slugs.
- If a generated `kitId` collides, generate a new ID and retry.
- If a slug collision occurs, retry with the next suffix.
- Concurrent or near-concurrent publishes with the same name must not produce duplicate slugs.

Public download panels can show safe package metadata when available:

- Current version.
- Package file name.
- Package size.
- SHA-256 checksum.
- Publication date.

If file name is missing, Market displays `agentkit-{slug}-{version}.agentkit.zip`. If SHA-256 is present, it can be copied from the detail page.

Kit detail pages include an `Open in Forge` action that launches:

```text
agentkitforge://market/import?market=https%3A%2F%2Fmarket.agentkitproject.com&kit={slug}
```

The deep link passes only the Market base URL and a safe kit reference such as slug, with optional public-safe `kitId` support later. It must not include auth tokens, signed S3 URLs, `downloadUrl`, `packageS3Key`, admin/service keys, submitter metadata, or raw package internals. Forge performs authenticated download/import after launch. Manual `.agentkit.zip` download remains available for signed-in web users.

Report listing support uses a placeholder workflow. Detail pages and footer links may use support mailto/report placeholders with the copy: `Report this listing` and `Abuse/reporting workflow coming soon. Contact support for now.`

## AgentKitProfile Public Profiles

AgentKitProfile owns shared AgentKitProject account and public display profile data. AgentKitMarket integrates with the Profile API server-side using:

- `PROFILE_API_BASE_URL`
- `PROFILE_SERVICE_KEY` if required by the Profile API

`PROFILE_SERVICE_KEY` is never exposed to the browser. During submission, Market snapshots only safe public fields:

- `displayName`
- `handle`
- `avatarInitials`
- `verified`

Emails, raw WorkOS user IDs, raw internal user IDs, and raw user-like publisher IDs are not displayed on public Market pages. New user/Forge submissions require an AgentKitProfile display name; if profile lookup is unavailable or the display name is missing, Market returns a profile-completion error instead of submitting with a raw or fallback publisher identity. Existing published kits may need republish or resync to receive updated publisher profile fields.

Public publisher display priority is:

- `displayName`
- `handle`
- `AgentKit user`

## Moderation Flow

The admin submissions queue supports filters for submission status, validation status, review status, history visibility, and submitter email. Archived/canceled submissions are excluded from the default queue. Approved/rejected reviewed submissions older than the backend retention window are also excluded from the default queue, while history mode can include them.

The admin review queue groups submissions into needs validation, validation failed, ready for approval, approved and ready to publish, published, rejected, and history sections. Reviewers should confirm:

- Public metadata is accurate.
- Listing content does not reveal raw internals.
- Required input summaries are clear.
- Trust badges are justified.
- Publisher identity is represented correctly.
- The kit fits marketplace content policy.

Admin action rules:

- Approve is enabled only when `validationStatus=passed` and the submission is not already approved.
- Reject is available for unpublished submissions and requires review notes.
- Publish is enabled only when `validationStatus=passed`, `reviewStatus=approved`, and `status` is not `published`.
- Remove submission is enabled for unpublished submissions and keeps the record in history.
- Hide kit is available when a published kit reference or `kitId` exists and removes the kit from public catalog visibility.
- Unhide kit is available for hidden kit references that still satisfy the public listing gate.
- Remove listing is available for published kit references and withdraws the listing from public catalog/detail/download surfaces.

Remove submission, hide, unhide, and remove listing are intentionally separate. Remove submission is queue cleanup. Hide/unhide changes reversible public visibility. Remove listing withdraws a published listing.

## Auth And Roles

WorkOS AuthKit is used for AgentKitMarket route protection. AgentKitProfile owns shared AgentKitProject account/profile UX at `https://profile.agentkitproject.com/account`. AgentKitMarket owns marketplace-specific actions and permissions.

Initial roles:

- `anonymous`: public catalog only.
- `user`: signed-in user; can submit kits and download approved kits.
- `admin`: upload, validate, review, publish.
- `owner`: system-level controls.

There is no `publisher` auth role requirement in Market. Anonymous users can browse and view public listings. Signed-in users can submit kits and download approved kits. Admins/owners can review submissions and publish kits. Admin access is derived from `AGENTKITMARKET_ADMIN_EMAILS`. Organization membership, SSO policy, private catalogs, Forge login integration, and corporate marketplace controls are covered by the centralized AgentKitProject roadmap.

No WorkOS secrets are committed.

Auth URL configuration is centralized so production sign-in, callback, and sign-out flows do not fall back to localhost:

- `APP_URL=https://market.agentkitproject.com`
- `NEXT_PUBLIC_APP_URL=https://market.agentkitproject.com`
- `WORKOS_REDIRECT_URI=https://market.agentkitproject.com/auth/callback`
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://market.agentkitproject.com/auth/callback`

Development may use `http://localhost:3000` and `http://localhost:3000/auth/callback`. Production must provide the market domain values, and localhost app or callback URLs are rejected. Sign-in return paths are normalized to the configured app origin, and absolute return URLs are accepted only when they stay on the same origin.

AuthKit sessions use a stable `WORKOS_COOKIE_PASSWORD` of at least 32 characters. The production callback re-saves the session cookie against the configured `WORKOS_REDIRECT_URI` so cookie attributes are based on the market domain rather than any internal hosting URL. `/debug/session` exposes safe diagnostics in development or to admin/owner users in production; it does not show tokens, cookies, API keys, or authorization headers.

Sign-out is a full-page navigation to `/auth/sign-out`. The route ignores prefetch/RSC probes, clears local AuthKit cookies, and redirects to server-side `APP_URL`, so each deployed AgentKitProject app returns to its own home page without visiting the WorkOS logout page. It must not use a sign-in URL, a cross-product profile/market URL, localhost in production, client fetch, `router.push`, or a prefetched Next.js link.

## Environment Variables

Server-only variables:

- `WORKOS_API_KEY`
- `WORKOS_CLIENT_ID`
- `WORKOS_COOKIE_PASSWORD`
- `WORKOS_REDIRECT_URI`
- `APP_URL`
- `AGENTKITMARKET_ADMIN_EMAILS`
- `AGENTKITMARKET_ADMIN_KEY`
- `PROFILE_API_BASE_URL`
- `PROFILE_SERVICE_KEY`

Client-safe variables:

- `NEXT_PUBLIC_AGENTKITMARKET_API_BASE_URL`
- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI`

Do not prefix secrets with `NEXT_PUBLIC_`. Amplify environment variables must be set directly on the `main` branch. If using `aws amplify update-branch`, include the full environment map because the command may replace values rather than merging them.

## Security Verification

Check public API responses for private fields:

```bash
curl -s "$API/kits/$SLUG" | jq '.. | objects | select(has("packageS3Key") or has("submittedByEmail") or has("submittedByUserId"))'
```

Check client bundles for service/admin secrets:

```bash
grep -RIn "AGENTKITMARKET_ADMIN_KEY\\|PROFILE_SERVICE_KEY\\|WORKOS_API_KEY\\|x-agentkitmarket-admin-key" .next/static
```

Both commands should return no matches for public data or client bundles.

## Self-Hosting Direction

Hosted AgentKitMarket uses WorkOS/AuthKit. App code should keep marketplace authorization behind internal helpers:

- `requireUser()`
- `requireAdmin()`
- `canDownloadKit()`
- `canSubmitKit()`
- `canReviewSubmission()`
- `canPublishKit()`

Future self-hosted deployments should be able to map OIDC, SAML, local auth, or other identity claims into the same internal roles and permission helpers. Business logic should not depend directly on WorkOS-specific user objects outside the auth/session adapter layer.

The hosted Forge desktop endpoint is specific to AgentKitProject Market and WorkOS/AuthKit. Future private or self-hosted markets should provide an equivalent authenticated download route using their own auth model while preserving the same server-side service-key boundary.

## Relationship To Forge And Auto

AgentKitForge is the builder and intended import target for kits discovered in Market. Market can launch Forge through a custom protocol link that contains only a safe Market URL and kit reference.

AgentKitAuto is not implemented in this repo. Market should not use AgentKitAuto green as its primary color. Market should use the cyan/teal marketplace identity visible in the `reference/` logo and icon assets.

## Brand Note

AgentKitMarket should communicate discovery, catalog browsing, trusted listings, and reusable kits. The visual system uses:

- Cyan/teal primary accent.
- Dark navy text.
- Rounded modern cards.
- Catalog grid and trust badge patterns.
- The reference AgentKitMarket logo and icon copied to `public/brand/`.
