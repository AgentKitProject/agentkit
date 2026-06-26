"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

// Shape returned by GET /api/credits/packs
interface CreditPack {
  id: string;
  label: string;
  priceCents: number;
  creditCents: number;
  currency: string;
}

type PacksState =
  | { status: "loading" }
  | { status: "loaded"; packs: CreditPack[] }
  | { status: "failed"; message: string };

type BuyState =
  | { status: "idle" }
  | { status: "pending"; packId: string }
  | { status: "failed"; message: string };

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function formatCredits(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars % 1 === 0 ? dollars.toFixed(0) : dollars.toFixed(2)} of usage`;
}

export default function CreditsPage() {
  const searchParams = useSearchParams();
  const topup = searchParams.get("topup");

  const [packsState, setPacksState] = useState<PacksState>({ status: "loading" });
  const [buyState, setBuyState] = useState<BuyState>({ status: "idle" });

  useEffect(() => {
    let active = true;

    fetch("/api/credits/packs")
      .then(async (res) => {
        if (!res.ok) {
          const json = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(json.error === "commerce_disabled" ? "Credits are not available on this instance." : `Failed to load packs (${res.status}).`);
        }
        return res.json() as Promise<CreditPack[]>;
      })
      .then((packs) => {
        if (active) setPacksState({ status: "loaded", packs });
      })
      .catch((err: unknown) => {
        if (active) setPacksState({ status: "failed", message: err instanceof Error ? err.message : "Failed to load credit packs." });
      });

    return () => { active = false; };
  }, []);

  async function handleBuy(packId: string) {
    setBuyState({ status: "pending", packId });

    try {
      const res = await fetch("/api/credits/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packId }),
      });

      const json = (await res.json()) as { url?: string; error?: string; message?: string };

      if (!res.ok) {
        const msg = json.message ?? json.error ?? `Checkout failed (${res.status}).`;
        setBuyState({ status: "failed", message: msg });
        return;
      }

      if (!json.url) {
        setBuyState({ status: "failed", message: "No checkout URL returned." });
        return;
      }

      // Redirect to Stripe Checkout
      window.location.href = json.url;
    } catch (err: unknown) {
      setBuyState({ status: "failed", message: err instanceof Error ? err.message : "Checkout failed." });
    }
  }

  return (
    <section className="page-shell">
      <div>
        <p className="eyebrow">AgentKitAuto</p>
        <h1>Add Credits</h1>
      </div>

      <div className="page-body">
        {/* Return banners */}
        {topup === "success" && (
          <div className="rule-callout">
            <strong>Purchase complete</strong>
            <span>Your credits have been added to your account and are ready to use.</span>
          </div>
        )}
        {topup === "cancelled" && (
          <div className="rule-callout">
            <strong>Purchase cancelled</strong>
            <span>Your payment was not processed. You can try again whenever you&apos;re ready.</span>
          </div>
        )}

        {/* Pack catalog */}
        {packsState.status === "loading" && (
          <div className="empty-state">
            <strong>Loading credit packs&hellip;</strong>
          </div>
        )}

        {packsState.status === "failed" && (
          <div className="empty-state">
            <strong>Credit packs unavailable</strong>
            <span>{packsState.message}</span>
          </div>
        )}

        {packsState.status === "loaded" && (
          <>
            <p>
              Credits are used to run AgentKitAuto agents. Purchases go to your account balance and are consumed as
              agents run. Credits do not expire.
            </p>
            <div className="info-grid">
              {packsState.packs.map((pack) => {
                const isPending = buyState.status === "pending" && buyState.packId === pack.id;
                const isDisabled = buyState.status === "pending";
                return (
                  <div className="flow-card" key={pack.id} style={{ padding: "20px", display: "grid", gap: "12px" }}>
                    <div>
                      <p className="eyebrow">{pack.label}</p>
                      <h2 style={{ margin: 0 }}>{formatPrice(pack.priceCents, pack.currency)}</h2>
                      <p style={{ marginBottom: 0 }}>{formatCredits(pack.creditCents)}</p>
                    </div>
                    <button
                      className="primary-button"
                      disabled={isDisabled}
                      onClick={() => void handleBuy(pack.id)}
                      type="button"
                    >
                      {isPending ? "Redirecting…" : "Buy"}
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* Checkout error */}
        {buyState.status === "failed" && (
          <div className="empty-state">
            <strong>Checkout failed</strong>
            <span>{buyState.message}</span>
          </div>
        )}
      </div>
    </section>
  );
}
