import type { Line, Mode, Priority, Source } from "./types";

/** Jeremy's five departments, as named in his prototype. */
export const DEPTS = ["Client Sales", "SPM Sales", "SPM Marketing", "Operations", "Finances"] as const;

export const DEPT_ABOUT: Record<string, string> = {
  "Client Sales": "Work that drives results for clients: their content, hooks, reports and deliverables.",
  "SPM Sales": "Selling Social Profit Media: discovery calls, proposals, follow-ups and contracts.",
  "SPM Marketing": "Marketing Social Profit Media: your content, podcast appearances and personal brand.",
  Operations: "Hiring, SOPs, contractors and keeping the team running.",
  Finances: "Invoices, payments, payroll and taxes.",
};

/** Every message source the dashboard is built to hold. */
export const SOURCES: Source[] = ["slack", "telegram"];
/** The ones that work today. Telegram joins this list when it is connected; until then the screens leave it out. */
export const LIVE_SOURCES: Source[] = ["slack"];

/**
 * Departments (the Departments tab, and the department on tasks and team members) are
 * switched off for now: nothing yet says which department a task or a person belongs to, so
 * everything would sit under "Operations". Change this to `true` to bring them back.
 */
export const DEPARTMENTS: boolean = false;

/**
 * The Connections tab is left out of the tab bar for now: Slack and Fathom are connected
 * already, from the keys in the environment. The page itself still works at /connections,
 * for the day a key has to be replaced. Change this to `true` to show the tab again.
 */
export const CONNECTIONS_TAB: boolean = false;

/**
 * Targets (the Targets tab, and the month's pace on Today) are switched off for now: the
 * numbers are the prototype's examples and nothing fills them in yet. Change this to `true`
 * to bring them back.
 */
export const TARGETS: boolean = false;

/**
 * The Personal side (the Professional / Personal switch in the header, and everything that
 * goes with it) is built but switched off for now. Change this to `true` to bring it back.
 * While it is off, everything shows as Professional and nothing is hidden.
 */
export const PERSONAL_SIDE: boolean = false;
export const SOURCE_NAME: Record<Source, string> = { slack: "Slack", telegram: "Telegram" };
export const SOURCE_SHORT: Record<Source, string> = { slack: "SL", telegram: "TG" };

export const PRIORITIES: Priority[] = ["high", "mid", "low"];
export const PRIORITY_NAME: Record<Priority, string> = { high: "High", mid: "Medium", low: "Low" };
export const PRIORITY_RANK: Record<Priority, number> = { high: 0, mid: 1, low: 2 };

export const LINE_NAME: Record<Line, string> = { agency: "Agency", consulting: "Consulting" };

export const MODES: Mode[] = ["professional", "personal"];
export const MODE_NAME: Record<Mode, string> = { professional: "Professional", personal: "Personal" };
/** Department and project a personal task is filed under. Personal tasks have no real ones. */
export const PERSONAL = "Personal";
