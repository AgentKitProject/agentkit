# AgentKitProject Site

Static Astro site for the AgentKitProject ecosystem.

## Brand Assets

The `reference/` directory contains visual source references for the AgentKitProject brand. Treat those files as the source of truth for the parent ecosystem mark, palette, spacing, rounded geometry, and blue/cyan/purple gradient direction.

The `public/brand/` directory contains site-consumable assets used by Astro pages, including the AgentKitProject logo/icon and product brand assets for Forge and Market.

## Commands

- `npm ci`
- `npm run check`
- `npm run build`

## CI

GitHub Actions runs CI for pull requests and manual checks. The workflow validates dependency
installation, lint when a lint script exists, tests when a test script exists, and the static build.
Pushes to `main` are validated by the deploy workflow before publishing.

## Deploy

Deploys run automatically on pushes to `main`. A manual deploy can also be triggered from the
`Deploy` workflow with `workflow_dispatch` when the selected ref is `main`.

Deployment uses GitHub Actions OIDC to assume the AWS role
`AgentKitProjectGitHubDeployRole` (`arn:aws:iam::609086950193:role/AgentKitProjectGitHubDeployRole`).
No long-lived `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` credentials are required or stored in
GitHub.

The deploy workflow treats dependency install, lint, build, `dist/roadmap/index.html`, S3 sync,
CloudFront invalidation creation, and CloudFront invalidation completion as hard deployment gates.
After those pass, it runs best-effort public URL smoke checks against `/`, `/roadmap`, `/about`,
and `/docs`. Smoke checks use DNS diagnostics and curl retries, but they do not fail the
deployment because GitHub runner DNS/public-network failures can be transient.

Local public verification:

```bash
curl -I https://agentkitproject.com/
curl -I https://agentkitproject.com/roadmap
```

Current production targets:

- S3 bucket: `agentkitprojecthostingstack-sitebucket397a1860-fux9rw5jz1gy`
- CloudFront distribution: `E1CGNR4ZGEMZ14`

CloudFront uses a Function from infra to rewrite clean URLs such as `/roadmap`, `/about`, and
`/docs` to their static `index.html` files.

Manual deploy command reference:

Build the static Astro site:

```bash
npm run build
```

Deploy the built `dist/` directory to the current AgentKitProject hosting bucket:

```bash
aws s3 sync dist/ s3://agentkitprojecthostingstack-sitebucket397a1860-fux9rw5jz1gy/ --delete
aws cloudfront create-invalidation --distribution-id E1CGNR4ZGEMZ14 --paths "/*"
```
