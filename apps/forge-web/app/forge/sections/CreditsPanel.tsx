"use client";

// Managed prepaid-credit balance UI. Fetches /api/me/credits and renders
// "Credits: $X.XX". Used in Settings and the Build-with-AI tab.
//
// The dev-grant button calls POST /api/credits/dev-grant, which is gated to an
// admin allowlist server-side (ADMIN_EMAILS); for non-admins it simply returns
// 403 and we surface the message. It is a pre-Stripe testing affordance.
//
// The real "top up" (Stripe) was added in Gateway 1b-ii: preset amount buttons
// call POST /api/credits/topup → Stripe Checkout → webhook credits the ledger.
// Returns are handled via ?topup=success|cancelled query params.
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@agentkitforge/ui";
import type { Notify } from "./shared";
import { errMsg } from "./shared";
import { TOP_UP_PRESETS_CENTS } from "@/lib/topup-presets";

/** UI display labels for preset top-up amounts. */
const TOP_UP_PRESETS: { cents: number; label: string }[] = TOP_UP_PRESETS_CENTS.map((cents) => ({
  cents,
  label: `$${(cents / 100).toFixed(0)}`
}));

export type Credits = { balanceCents: number; currency: string };

export function formatCents(cents: number, currency = "USD"): string {
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${symbol}${(cents / 100).toFixed(2)}`;
}

/** Fetches the current credit balance. Exposed so other panels can reuse it. */
export async function fetchCredits(): Promise<Credits | null> {
  const res = await fetch("/api/me/credits", { credentials: "include" });
  if (!res.ok) return null;
  return (await res.json()) as Credits;
}

export function CreditsPanel({
  notify,
  showDevGrant = false
}: {
  notify: Notify;
  showDevGrant?: boolean;
}) {
  const [credits, setCredits] = useState<Credits | null>(null);
  const [busy, setBusy] = useState(false);
  const [topupBusy, setTopupBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const didHandleReturn = useRef(false);

  const load = useCallback(async () => {
    try {
      setCredits(await fetchCredits());
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Handle ?topup=success|cancelled return from Stripe Checkout.
  useEffect(() => {
    if (didHandleReturn.current) return;
    const params = new URLSearchParams(window.location.search);
    const topup = params.get("topup");
    if (topup === "success") {
      didHandleReturn.current = true;
      notify("Top-up successful! Your credits have been applied.");
      void load();
      // Clean the query param without a full reload.
      const url = new URL(window.location.href);
      url.searchParams.delete("topup");
      window.history.replaceState(null, "", url.toString());
    } else if (topup === "cancelled") {
      didHandleReturn.current = true;
      notify("Top-up cancelled.");
      const url = new URL(window.location.href);
      url.searchParams.delete("topup");
      window.history.replaceState(null, "", url.toString());
    }
  }, [load, notify]);

  const devGrant = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/credits/dev-grant", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents: 500 })
      });
      const data = (await res.json()) as { balanceCents?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Grant failed (${res.status})`);
      notify("Dev credit grant applied.");
      await load();
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };

  const startTopup = async (amountCents: number) => {
    setTopupBusy(amountCents);
    try {
      const res = await fetch("/api/credits/topup", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents })
      });
      const data = (await res.json()) as { url?: string; message?: string };
      if (!res.ok) {
        if (res.status === 503) {
          notify("Stripe payments are not configured on this instance.", true);
        } else {
          notify(data.message ?? `Top-up failed (${res.status})`, true);
        }
        return;
      }
      if (data.url) {
        window.location.href = data.url;
      }
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setTopupBusy(null);
    }
  };

  const anyBusy = busy || topupBusy !== null;

  return (
    <div className="provider-card" style={{ padding: "10px 12px", marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <strong>
          Credits:{" "}
          {credits ? formatCents(credits.balanceCents, credits.currency) : error ? "—" : "…"}
        </strong>
        <span style={{ flex: 1, fontSize: "0.85em", color: "var(--color-text-secondary)" }}>
          Managed AI uses prepaid credits (used when you have no AI provider configured).
        </span>
        {showDevGrant && (
          <Button variant="secondary" disabled={anyBusy} onClick={() => void devGrant()}>
            {busy ? "…" : "+ $5 (dev/admin)"}
          </Button>
        )}
      </div>
      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: "0.85em", color: "var(--color-text-secondary)" }}>Top up:</span>
        {TOP_UP_PRESETS.map(({ cents, label }) => (
          <Button
            key={cents}
            variant="secondary"
            disabled={anyBusy}
            onClick={() => void startTopup(cents)}
            title={`Add ${label} of prepaid credits`}
          >
            {topupBusy === cents ? "…" : label}
          </Button>
        ))}
        <span style={{ fontSize: "0.78em", color: "var(--color-text-secondary)" }}>
          Credits are non-refundable.
        </span>
      </div>
      {error && <p className="inline-warning" style={{ marginTop: 6 }}>{error}</p>}
    </div>
  );
}

/**
 * Inline banner for a 402 insufficient-credits response from a draft route.
 * Renders the server message + preset top-up buttons that redirect to Stripe.
 */
export function InsufficientCreditsBanner({
  message,
  requiredCents,
  balanceCents,
  currency = "USD",
  notify
}: {
  message: string;
  requiredCents?: number;
  balanceCents?: number;
  currency?: string;
  notify?: Notify;
}) {
  const [topupBusy, setTopupBusy] = useState<number | null>(null);

  const startTopup = async (amountCents: number) => {
    setTopupBusy(amountCents);
    try {
      const res = await fetch("/api/credits/topup", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents })
      });
      const data = (await res.json()) as { url?: string; message?: string };
      if (!res.ok) {
        const msg =
          res.status === 503
            ? "Stripe payments are not configured on this instance."
            : (data.message ?? `Top-up failed (${res.status})`);
        notify?.(msg, true);
        return;
      }
      if (data.url) {
        window.location.href = data.url;
      }
    } catch (e) {
      notify?.(errMsg(e), true);
    } finally {
      setTopupBusy(null);
    }
  };

  return (
    <div className="inline-warning" style={{ marginTop: 10, padding: "8px 10px" }}>
      <strong>Out of credits.</strong> {message}
      {typeof balanceCents === "number" && (
        <div style={{ fontSize: "0.85em", marginTop: 4 }}>
          Balance: {formatCents(balanceCents, currency)}
          {typeof requiredCents === "number" && <> · Needed: ~{formatCents(requiredCents, currency)}</>}
        </div>
      )}
      <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: "0.85em" }}>Top up:</span>
        {TOP_UP_PRESETS.map(({ cents, label }) => (
          <Button
            key={cents}
            disabled={topupBusy !== null}
            onClick={() => void startTopup(cents)}
            title={`Add ${label} of prepaid credits`}
          >
            {topupBusy === cents ? "…" : label}
          </Button>
        ))}
      </div>
      <div style={{ marginTop: 4, fontSize: "0.78em", color: "var(--color-text-secondary)" }}>
        Credits are non-refundable.
      </div>
    </div>
  );
}
