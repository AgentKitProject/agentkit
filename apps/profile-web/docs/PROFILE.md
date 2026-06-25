# Profiles

AgentKitProfile owns shared AgentKitProject account/profile UX. The profile API is accessed only from local Next.js route handlers, never directly from the browser.

AgentKitMarket consumes safe public profile snapshots. It should use public profile fields for kit listings instead of raw user IDs or emails.

## Routes

- `/account`: signed-in account overview with email, role, display name, handle, profile completeness, and product links.
- `/account/profile`: signed-in profile editor.
- `/u/[handle]`: public profile page.
- `GET /api/profile/me`: authenticated local route for the current user's private profile.
- `PUT /api/profile/me`: authenticated local route for editable profile fields.
- `GET /api/profile/handle/[handle]`: public local route for safe public profile fields.

## Editable Fields

Signed-in users can edit:

- `displayName`
- `handle`
- `avatarInitials`
- `bio`
- `websiteUrl`

Users cannot directly edit:

- `email`
- `role`
- `verified`
- raw WorkOS user ID

## Public Fields

Public profile pages and public APIs may show:

- `displayName`
- `handle`
- `avatarInitials`
- `bio`
- `websiteUrl`
- `verified`

Public profile pages must not show:

- email
- raw WorkOS user ID
- raw WorkOS user object
- cookies or session data
- `PROFILE_SERVICE_KEY`
- `WORKOS_API_KEY`
- profile service internals

## Handle Rules

Handles are normalized to lowercase and must:

- be 3-32 characters
- contain only lowercase letters, numbers, hyphens, and underscores
- not look like an email address
- not be a reserved route or system word

Reserved examples include `account`, `admin`, `api`, `auth`, `market`, `profile`, `security`, `settings`, `sign-in`, `sign-out`, and `u`.

## Website Rules

`websiteUrl` must be empty or start with `https://`.

## First Login Sync

When a signed-in user requests their profile, the local server route calls `GET /me`. The profile API creates or syncs a default profile if none exists:

- `userId` from WorkOS
- `email` from WorkOS
- normalized `role`
- `displayName` null
- `handle` empty
- `avatarInitials` null
- `verified` false

The UI prompts the user to set a public handle.

## Profile API Boundary

Browser code calls local Next.js routes under `/api/profile/*`. Those route handlers call `PROFILE_API_BASE_URL`, attach signed-in identity headers, and include `PROFILE_SERVICE_KEY` only on the server when configured.

`PROFILE_SERVICE_KEY` should be the raw profile service key value. The Secrets Manager secret `agentkitprofile/profile-service-key` is JSON:

```json
{ "keyId": "...", "serviceKey": "..." }
```

Set Amplify `PROFILE_SERVICE_KEY` to the raw `.serviceKey` value, not the full JSON object.

Example extraction:

```bash
aws secretsmanager get-secret-value --secret-id agentkitprofile/profile-service-key --query SecretString --output text | jq -r '.serviceKey'
```

If deployment injects a JSON secret, it must contain one of these string fields: `serviceKey`, `profileServiceKey`, `PROFILE_SERVICE_KEY`, `profile_service_key`, `secretKey`, or `secret_key`. The app will not forward an unrecognized JSON blob as a service key.

For signed-in `/me` calls, the app derives trusted context from the WorkOS session and sends:

- `x-profile-service-key`
- `x-agentkit-user-id`
- `x-agentkit-user-email` when the session has an email

The browser cannot provide or override trusted `userId` or `email`.

The Profile API base URL may include an API Gateway stage path, such as `/prod`. The app joins Profile API URLs with a helper that preserves that base path for `/me`, `PUT /me`, and `/profiles/handle/{handle}`.

Profile API errors are normalized:

- `SERVER_CONFIG_ERROR`: missing or invalid profile API base URL/service key
- `SESSION_USER_MISSING`: authenticated session did not include a user ID
- `TRUSTED_CONTEXT_MISSING`: profile API rejected trusted context
- `SERVICE_AUTH_FAILED`: profile API rejected service authentication

Expected upstream profile endpoints:

- `GET /me`
- `PUT /me`
- `GET /profiles/{userId}`
- `GET /profiles/handle/{handle}`

## AgentKitMarket Listings

AgentKitMarket listings should display public `displayName`, `handle`, `avatarInitials`, `bio`, `websiteUrl`, and `verified` snapshots from this profile system instead of raw user IDs or emails. Marketplace submission, review, publishing, downloads, and product-specific authorization stay in AgentKitMarket.
