# Authentication

AgentKitProfile uses WorkOS AuthKit as the hosted AgentKitProject authentication provider.

## WorkOS Setup

Configure these redirect URIs in WorkOS:

- `https://profile.agentkitproject.com/auth/callback`
- `http://localhost:3000/auth/callback`

Configure the app sign-in endpoint as:

- Production: `https://profile.agentkitproject.com/auth/sign-in`
- Local: `http://localhost:3000/auth/sign-in`

Configure sign-out to return users to this app's home page:

- Production: `https://profile.agentkitproject.com`
- Local: `http://localhost:3000`

## Environment Variables

Production:

```bash
APP_URL=https://profile.agentkitproject.com
NEXT_PUBLIC_APP_URL=https://profile.agentkitproject.com
WORKOS_REDIRECT_URI=https://profile.agentkitproject.com/auth/callback
WORKOS_API_KEY=...
WORKOS_CLIENT_ID=...
WORKOS_COOKIE_PASSWORD=...
AGENTKITPROJECT_ADMIN_EMAILS=admin@example.com,owner@example.com:owner
PROFILE_API_BASE_URL=...
PROFILE_SERVICE_KEY=...
# NEXT_PUBLIC_WORKOS_REDIRECT_URI is not currently required because the app passes WORKOS_REDIRECT_URI server-side.
```

Local:

```bash
APP_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000
WORKOS_REDIRECT_URI=http://localhost:3000/auth/callback
WORKOS_API_KEY=...
WORKOS_CLIENT_ID=...
WORKOS_COOKIE_PASSWORD=...
AGENTKITPROJECT_ADMIN_EMAILS=
PROFILE_API_BASE_URL=
PROFILE_SERVICE_KEY=
# NEXT_PUBLIC_WORKOS_REDIRECT_URI is not currently required because the app passes WORKOS_REDIRECT_URI server-side.
```

`WORKOS_COOKIE_PASSWORD` must be a strong secret and at least 32 characters long.

`APP_URL` and `WORKOS_REDIRECT_URI` are required in production. The app allows `http://localhost:3000` fallbacks only for local development and local builds. Production sign-in and sign-out should never redirect to localhost.

Server-only variables must not use the `NEXT_PUBLIC_` prefix:

- `WORKOS_API_KEY`
- `WORKOS_CLIENT_ID`
- `WORKOS_COOKIE_PASSWORD`
- `WORKOS_REDIRECT_URI`
- `PROFILE_SERVICE_KEY`

Client-safe variables:

- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI` only if a future SDK integration explicitly requires it

## Middleware and Cookie Handling

WorkOS AuthKit `withAuth()` depends on headers injected by AuthKit middleware. Any page or route that calls `withAuth()` directly or through `getCurrentUser()`, `requireUser()`, or `requireAdmin()` must be covered by `middleware.ts`.

The middleware matcher covers normal app routes and excludes static assets:

- `_next/static`
- `_next/image`
- `favicon.ico`
- file-extension asset requests

Public Server Components avoid AuthKit helpers because the SDK may set, refresh, or clear cookies. Next.js rejects cookie mutation from ordinary Server Components, which can cause SSR errors. The public root page and not-found page render generic account navigation without reading the session.

Protected account pages call `requireUser()` server-side. Anonymous users are redirected to WorkOS AuthKit sign-in, and successful sign-in returns to `/account`.

AuthKit cookie mutation is kept in supported surfaces:

- middleware refresh/injection
- `/auth/sign-in` route handler
- `/auth/callback` route handler
- `/auth/sign-out` route handler

Sign-out must be a full-page navigation to `/auth/sign-out`, for example `<a href="/auth/sign-out">Sign out</a>`. Do not call sign-out with client `fetch()`, do not use `router.push()`, and do not use a prefetched Next.js `Link` unless `prefetch={false}` is set.

The sign-out route clears local AuthKit cookies and redirects to the app-specific `APP_URL` home page. In production, `APP_URL` must be the current app host, such as `https://profile.agentkitproject.com` for AgentKitProfile or `https://market.agentkitproject.com` for AgentKitMarket.

## Role Model

The internal role model is intentionally simple:

- `anonymous`
- `user`
- `admin`
- `owner`

For now:

- signed-out visitors are `anonymous`
- signed-in users are `user`
- `admin` and `owner` are assigned through `AGENTKITPROJECT_ADMIN_EMAILS`

The allowlist is comma-separated, trimmed, and case-insensitive. Add `:owner` to an allowlisted email to assign owner:

```bash
AGENTKITPROJECT_ADMIN_EMAILS=admin@example.com,owner@example.com:owner
```

## Auth Modules

- `lib/auth/session.ts`: current user and required user/admin helpers
- `lib/auth/workos.ts`: WorkOS AuthKit URL helpers
- `lib/auth/roles.ts`: normalized roles
- `lib/auth/urls.ts`: app URL and safe return URL handling

The app should keep product permissions and marketplace workflow authorization out of WorkOS-specific code. Future self-hosted AgentKitMarket deployments can map OIDC, SAML, or local identity claims into these same internal roles without rewriting page logic.

Hosted AgentKitProfile uses WorkOS/AuthKit today. Future shared account/auth deployments can add OIDC, SAML, or local identity adapters as long as they normalize identity into the internal roles above.

Profile routes use WorkOS only to identify the signed-in user. Profile fields are read and written through the profile API via local Next.js route handlers so `PROFILE_SERVICE_KEY` is never exposed to the browser.

## Redirect Safety

`safeReturnTo()` accepts same-origin return destinations and normalizes them to an internal path. External URLs, protocol-relative URLs, malformed URLs, and empty values fall back to `/account`.

## Product Boundary

AgentKitProfile owns AgentKitProject account/profile UX. AgentKitMarket owns marketplace actions, including submissions, review, publish, and downloads. AgentKitForge and AgentKitAuto will integrate with AgentKitProject login later.
