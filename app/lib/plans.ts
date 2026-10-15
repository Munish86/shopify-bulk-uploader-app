// Plans and their monthly limits. Prices, trial days and the plan picker live in Shopify (Managed
// Pricing, set up in the Partner Dashboard). The plan names there must match `name` below (any case);
// an unknown or missing subscription counts as Free.
// Used by the server (limits) and the browser (plan page), so no server-only code here.

export interface Plan {
  key: "free" | "pro" | "unlimited";
  name: string;
  productsPerMonth: number | null; // products created or updated per calendar month; null = no limit
  features: string[];
}

export const PLANS: Plan[] = [
  {
    key: "free",
    name: "Free",
    productsPerMonth: 50,
    features: ["50 products created or updated per month", "Image check and preview are always free", "Backups and undo"],
  },
  {
    key: "pro",
    name: "Pro",
    productsPerMonth: 2000,
    features: ["2,000 products per month", "Images from your computer or Google Drive", "Backups and undo"],
  },
  {
    key: "unlimited",
    name: "Unlimited",
    productsPerMonth: null,
    features: ["No monthly product limit", "Everything in Pro", "Priority email support"],
  },
];

export const BACKUP_HIDE_MONTHS = 2; // older backups are hidden from the list, but kept
export const BACKUP_KEEP_MONTHS = 6; // older backups are deleted

export const planByKey = (key?: string | null): Plan => PLANS.find((p) => p.key === key) || PLANS[0];

// Shopify subscription name ("Pro", "Pro plan", "UNLIMITED") -> plan key
export function planKeyFromName(name?: string | null): Plan["key"] {
  const n = String(name || "").toLowerCase();
  return (PLANS.slice(1).find((p) => n.includes(p.key))?.key ?? "free") as Plan["key"];
}

// "2026-10" in UTC: usage resets on the 1st of each month
export const monthOf = (d = new Date()) => d.toISOString().slice(0, 7);

export function remaining(plan: Plan, used: number): number | null {
  return plan.productsPerMonth == null ? null : Math.max(0, plan.productsPerMonth - used);
}
