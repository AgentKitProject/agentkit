"use client";

import { useMemo, useState } from "react";
import { Button, Input, Select } from "@agentkitforge/ui";
import { EmptyCatalog } from "@/components/CatalogStatus";
import { KitCard } from "@/components/KitCard";
import type { MarketKitListItem } from "@/lib/market-api";

type CatalogExplorerProps = {
  kits: MarketKitListItem[];
  initialCategory?: string;
  initialTag?: string;
};

export function CatalogExplorer({ kits, initialCategory = "all", initialTag = "all" }: CatalogExplorerProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(initialCategory);
  const [tag, setTag] = useState(initialTag);
  const [trust, setTrust] = useState("public");

  const categories = useMemo(() => uniqueSorted(kits.flatMap((kit) => kit.categories)), [kits]);
  const tags = useMemo(() => uniqueSorted(kits.flatMap((kit) => kit.tags)), [kits]);
  const filteredKits = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return kits.filter((kit) => {
      const matchesQuery =
        !needle ||
        [kit.name, kit.summary, kit.publisher.name, kit.currentVersion, ...kit.categories, ...kit.tags]
          .filter((value): value is string => typeof value === "string" && value.length > 0)
          .some((value) => value.toLowerCase().includes(needle));
      const matchesCategory = category === "all" || kit.categories.includes(category);
      const matchesTag = tag === "all" || kit.tags.includes(tag);
      const matchesTrust =
        trust === "public" ||
        (trust === "featured" && kit.trustBadges.includes("Featured")) ||
        (trust === "verified" && kit.trustBadges.includes("Verified Publisher"));

      return matchesQuery && matchesCategory && matchesTag && matchesTrust;
    });
  }, [category, kits, query, tag, trust]);

  if (kits.length === 0) {
    return <EmptyCatalog />;
  }

  return (
    <div className="catalog-explorer">
      <div className="filter-bar">
        <Input
          label="Search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search kits, publishers, or tags"
          value={query}
        />
        <Select label="Category" onChange={(event) => setCategory(event.target.value)} value={category}>
          <option value="all">All categories</option>
          {categories.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </Select>
        <Select label="Tag" onChange={(event) => setTag(event.target.value)} value={tag}>
          <option value="all">All tags</option>
          {tags.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </Select>
        <Select label="Trust" onChange={(event) => setTrust(event.target.value)} value={trust}>
          <option value="public">Validated + Reviewed</option>
          <option value="featured">Featured</option>
          <option value="verified">Verified publisher</option>
        </Select>
      </div>
      <div className="catalog-results-summary" aria-live="polite">
        {filteredKits.length === 1 ? "1 kit matches" : `${filteredKits.length} kits match`}
      </div>
      {filteredKits.length > 0 ? (
        <div className="kit-grid">
          {filteredKits.map((kit) => (
            <KitCard key={kit.slug} kit={kit} />
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <strong>No kits found</strong>
          <p>Try a different search, category, tag, or trust filter.</p>
          <Button
            variant="secondary"
            onClick={() => {
              setQuery("");
              setCategory("all");
              setTag("all");
              setTrust("public");
            }}
            type="button"
          >
            Clear filters
          </Button>
        </div>
      )}
    </div>
  );
}

function uniqueSorted(values: string[]) {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}
