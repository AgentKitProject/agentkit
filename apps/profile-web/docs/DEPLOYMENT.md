# Deployment

AgentKitProfile is designed to deploy to AWS Amplify Hosting as a Next.js SSR app.

## Deployment Flow

The intended flow is:

1. Open a pull request.
2. GitHub Actions `CI` validates install, lint, tests, and build.
3. Branch protection requires `CI` before merge.
4. Merge to `main`.
5. Amplify builds and deploys `main`.

GitHub CI does not deploy, configure AWS credentials, call Amplify APIs, or run on `main` pushes. Amplify remains the deployment source for the main branch.

## Amplify Build

The included `amplify.yml`:

- requires the expected environment variables during `preBuild`
- writes required values into `.env.production`
- runs `npm ci`
- runs `npm run build`
- publishes `.next` as the artifact directory

## Amplify Environment Variables

Set these in Amplify:

```bash
APP_URL=https://profile.agentkitproject.com
NEXT_PUBLIC_APP_URL=https://profile.agentkitproject.com
WORKOS_REDIRECT_URI=https://profile.agentkitproject.com/auth/callback
WORKOS_API_KEY=...
WORKOS_CLIENT_ID=...
WORKOS_COOKIE_PASSWORD=...
AGENTKITPROJECT_ADMIN_EMAILS=...
PROFILE_API_BASE_URL=...
PROFILE_SERVICE_KEY=...
```

Server-only:

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

Only `NEXT_PUBLIC_APP_URL` is currently required client-side. Do not use `NEXT_PUBLIC_` for WorkOS API keys, cookie passwords, profile service keys, or other secrets.

## Profile Service Key

The Secrets Manager secret `agentkitprofile/profile-service-key` is JSON:

```json
{ "keyId": "...", "serviceKey": "..." }
```

Set Amplify `PROFILE_SERVICE_KEY` to the raw `.serviceKey` value, not the full JSON object:

```bash
aws secretsmanager get-secret-value --secret-id agentkitprofile/profile-service-key --query SecretString --output text | jq -r '.serviceKey'
```

The app sends this value only from Next.js server routes as `x-profile-service-key`.

## WorkOS Redirects

Required callback redirect URIs:

- `https://profile.agentkitproject.com/auth/callback`
- `http://localhost:3000/auth/callback`

Recommended sign-in endpoints:

- `https://profile.agentkitproject.com/auth/sign-in`
- `http://localhost:3000/auth/sign-in`

Recommended sign-out redirects:

- `https://profile.agentkitproject.com`
- `http://localhost:3000`

`APP_URL` controls sign-out return behavior. For each deployed app, set it to that app's own origin. The sign-out route redirects to `APP_URL/` and must not point to another AgentKitProject product.

## Validation

Run before deployment:

```bash
npm ci
npm run lint --if-present
npm run build
```

## Future Auth Adapter Direction

WorkOS AuthKit is the hosted AgentKitProject auth provider. The app code uses normalized helpers for users and roles so future self-hosted deployments can adapt OIDC, SAML, or local identity claims into the same internal model.
