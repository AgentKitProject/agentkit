# Protected kits — what buyers get

Some paid Market kits are **protected** (paid + non-downloadable). A protected
kit works differently from a normal download, and it's worth knowing what you do
and don't receive before you buy.

## You run it, you don't download it

A protected kit's files are **never delivered to you**. Instead of downloading
the kit and running it yourself, you run it on **AgentKitAuto**: the kit's
instructions are resolved server-side, the run executes against your input, and
you receive only the **output** the run produced.

- The kit bytes are fetched server-side, held in memory, and never written to the
  run record, your workspace, the delivery payload, or any log.
- You don't get an `.agentkit.zip`, the `AGENTKIT.md`, the skills, or any other
  file from the kit. There is no "download" button for a protected kit.

This is how a seller can charge for a kit without handing over the source.

## What protection does and doesn't guarantee

This is the same honest framing the platform applies everywhere (see
`packages/auto-core/src/core/leakage-guard.ts` and the
[verification runbook](./protected-kit-verification.md)):

> The airtight property is **no-deliver of the bytes** — the kit's files are
> never handed to you. Protection against extracting the *instructions* is
> **best-effort, not airtight**: a kit is plain text and can't be DRM'd, so a
> determined buyer can still coax the model into paraphrasing or inferring the
> instructions. The guards raise the cost of casual extraction; they are a strong
> deterrent, not a security boundary.

In short: you can rely on never receiving the kit's files. You cannot rely on the
kit's *ideas* being impossible to infer from its output.

## Running a protected kit costs Auto credits

Because you run a protected kit on AgentKitAuto, the run is billed like any other
managed Auto run — on the standard Auto compute model (a per-invocation fee plus a
per-active-minute charge, with a free monthly active-minute allowance). Protected
kits always run **managed**: they can never run on your own provider key, because
that would route the seller's instructions through your provider console.

For the current rates and free allowance, see your Auto billing page and the
published pricing — this doc intentionally doesn't restate the numbers so they
can't drift out of sync.

## Entitlement

You can only run a protected kit you're **entitled** to (you bought it, or were
granted access). A non-entitled run is refused server-side before any kit bytes
are assembled into a prompt — so an un-purchased protected kit produces no output
and leaks nothing.
