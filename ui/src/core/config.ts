import type { Line, Priority, Source } from "./types";

/** Jeremy's five departments, as named in his prototype. */
export const DEPTS = ["Client Sales", "SPM Sales", "SPM Marketing", "Operations", "Finances"] as const;

export const DEPT_ABOUT: Record<string, string> = {
  "Client Sales": "Work that drives results for clients: their content, hooks, reports and deliverables.",
  "SPM Sales": "Selling Social Profit Media: discovery calls, proposals, follow-ups and contracts.",
  "SPM Marketing": "Marketing Social Profit Media: your content, podcast appearances and personal brand.",
  Operations: "Hiring, SOPs, contractors and keeping the team running.",
  Finances: "Invoices, payments, payroll and taxes.",
};

/** Message sources connected in Phase 1. */
export const SOURCES: Source[] = ["slack", "telegram"];
export const SOURCE_NAME: Record<Source, string> = { slack: "Slack", telegram: "Telegram" };
export const SOURCE_SHORT: Record<Source, string> = { slack: "SL", telegram: "TG" };

export const PRIORITIES: Priority[] = ["high", "mid", "low"];
export const PRIORITY_NAME: Record<Priority, string> = { high: "High", mid: "Mid", low: "Low" };
export const PRIORITY_RANK: Record<Priority, number> = { high: 0, mid: 1, low: 2 };

export const LINE_NAME: Record<Line, string> = { agency: "Agency", consulting: "Consulting" };
