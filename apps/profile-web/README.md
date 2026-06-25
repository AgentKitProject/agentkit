# AgentKitProfile

AgentKitProfile is the central AgentKitProject account and profile app. It is intended to run at:

- Production: `https://profile.agentkitproject.com`
- Local: `http://localhost:3000`

This app owns AgentKitProject account/profile UX and normalized account roles. AgentKitMarket remains responsible for marketplace workflows such as kit submissions, reviews, publishing, and downloads.

## Current Behavior

Signed-in users can:

- view the account page
- edit display name
- set a public handle
- set avatar initials
- set bio and website URL when supported by the profile API

Public users can view `/u/[handle]`. Public profile pages show only public-safe fields: `displayName`, `handle`, `avatarInitials`, `bio`, `websiteUrl`, and `verified`.

Public profile pages must not show email, raw WorkOS user objects, raw WorkOS user IDs, cookies, session data, `PROFILE_SERVICE_KEY`, or WorkOS secrets.

## Stack

- Next.js App Router
- TypeScript
- WorkOS AuthKit
- Tailwind CSS
- Amplify Hosting compatible SSR build config

## Local Setup

1. Install dependencies:

   ```bash
   npm ci
   ```

2. Create `.env.local` from `.env.example` and fill in WorkOS values:

   ```bash
   cp .env.example .env.local
   ```

3. Start the local server:

   ```bash
   npm run dev
   ```

## Continuous Integration

GitHub Actions runs CI on pull requests and by manual `workflow_dispatch`. CI validates dependency installation, lint when present, tests when present, and the production build.

CI does not run on pushes to `main`; Amplify handles the main branch build and deployment after merge. Branch protection should require the `CI` status check before PRs can merge.

## Required Environment Variables

Server-side only:

- `WORKOS_API_KEY`
- `WORKOS_CLIENT_ID`
- `WORKOS_COOKIE_PASSWORD`
- `APP_URL`
- `WORKOS_REDIRECT_URI`
- `AGENTKITPROJECT_ADMIN_EMAILS`
- `PROFILE_API_BASE_URL`
- `PROFILE_SERVICE_KEY`

Client-safe:

- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI` only if a future SDK integration explicitly requires it

Do not expose WorkOS secrets through `NEXT_PUBLIC_` variables.

`APP_URL` and `WORKOS_REDIRECT_URI` are required in production. Localhost fallbacks are only used for local development and local builds.

## Auth Boundary

Public pages such as `/` and the not-found page do not call WorkOS/AuthKit session helpers. Those helpers can set or refresh cookies, which Next.js only allows from middleware, route handlers, or server actions.

Account pages are protected server-side and call `requireUser()`:

- `/account`
- `/account/profile`
- `/account/security`
- `/account/products`

Any route that calls `withAuth()` or helpers built on it must be covered by `middleware.ts`. The middleware matcher covers normal app routes and excludes static assets, images, favicon, and file-extension asset requests.

Profile API calls are made only from local Next.js server routes. Browser code calls `/api/profile/*`; the server route attaches trusted WorkOS-derived identity headers and `PROFILE_SERVICE_KEY`.

## Routes

- `/`
- `/account`
- `/account/profile`
- `/account/security`
- `/account/products`
- `/u/[handle]`
- `/api/profile/me`
- `/api/profile/handle/[handle]`
- `/auth/sign-in`
- `/auth/callback`
- `/auth/sign-out`
- `/unauthorized`

See [docs/AUTH.md](docs/AUTH.md), [docs/PROFILE.md](docs/PROFILE.md), and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for setup details.
