export type Provider = "codex" | "claude";

export const FREE_LIMITS: Record<Provider, number> = { codex: 2, claude: 1 };
export const PLANS = {
  monthly: { name: "Monthly", amount: 1, per: "month" },
  yearly: { name: "Yearly", amount: 3, per: "year" },
} as const;
export type Billing = keyof typeof PLANS;
export const YEARLY_SAVINGS = Math.round((1 - PLANS.yearly.amount / (PLANS.monthly.amount * 12)) * 100);
const licenseKey = "usage-widget.license.v1";

// The single gate for Pro features; replace this with a real license check once payments exist.
export function hasPro(): boolean {
  try {
    const license = JSON.parse(localStorage.getItem(licenseKey) || "null");
    return license?.tier === "pro" && (license.expiresAt === undefined || (Number.isFinite(license.expiresAt) && license.expiresAt > Date.now()));
  } catch { return false; }
}

export function accountLimit(provider: Provider, pro: boolean) {
  return pro ? Infinity : FREE_LIMITS[provider];
}
