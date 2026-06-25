export interface KnownDomain {
  id: string;
  label: string;
}

export const knownDomains: KnownDomain[] = [
  { id: "finance-accounting", label: "Finance / Accounting" },
  { id: "legal", label: "Legal" },
  { id: "healthcare-medical", label: "Healthcare / Medical" },
  { id: "devops-sre", label: "DevOps / SRE" },
  { id: "cloud-infrastructure", label: "Cloud / Infrastructure" },
  { id: "security", label: "Security" },
  { id: "software-engineering", label: "Software Engineering" },
  { id: "data-analytics", label: "Data / Analytics" },
  { id: "sales-marketing", label: "Sales / Marketing" },
  { id: "customer-support", label: "Customer Support" },
  { id: "research", label: "Research" },
  { id: "education", label: "Education" },
  { id: "operations", label: "Operations" },
  { id: "general-business", label: "General Business" },
  { id: "personal-productivity", label: "Personal Productivity" },
  { id: "real-estate", label: "Real Estate" },
  { id: "hr-recruiting", label: "HR / Recruiting" },
  { id: "procurement", label: "Procurement" },
  { id: "compliance", label: "Compliance" },
  { id: "product-management", label: "Product Management" },
  { id: "project-management", label: "Project Management" },
  { id: "writing-editing", label: "Writing / Editing" },
  { id: "design-creative", label: "Design / Creative" },
  { id: "insurance", label: "Insurance" },
  { id: "government-public-policy", label: "Government / Public Policy" },
  { id: "construction-trades", label: "Construction / Trades" },
  { id: "logistics-supply-chain", label: "Logistics / Supply Chain" },
  { id: "manufacturing", label: "Manufacturing" },
  { id: "retail-ecommerce", label: "Retail / E-commerce" },
  { id: "nonprofit", label: "Nonprofit" },
  { id: "other-custom", label: "Other / Custom" }
];

export function getKnownDomains(): KnownDomain[] {
  return [...knownDomains];
}

export function findMatchingDomains(query: string): KnownDomain[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  return knownDomains.filter(
    (domain) =>
      domain.id.includes(normalized.replaceAll(" ", "-")) ||
      domain.label.toLowerCase().includes(normalized)
  );
}
