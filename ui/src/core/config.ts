import type { Line, Mode, Priority, Provider, Source } from "./types";

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
export const SOURCES: Source[] = ["slack", "telegram", "gmail"];
/**
 * The ones that work on this server. Telegram and Gmail count only where the server says
 * they can be used (see `AppState.telegramAvailable` and `AppState.googleAvailable`).
 */
export const liveSources = (telegram: boolean, google = false): Source[] =>
  SOURCES.filter((s) => s === "slack" || (s === "telegram" && telegram) || (s === "gmail" && google));

/**
 * Departments (the Departments tab, and the department on tasks and team members) are
 * switched off for now: nothing yet says which department a task or a person belongs to, so
 * everything would sit under "Operations". Change this to `true` to bring them back.
 */
export const DEPARTMENTS: boolean = false;

/**
 * The Connections tab. It is where a person logs in to Telegram, and it says what is missing
 * when Telegram is not switched on yet, so it is always shown. Change this to `false` to
 * leave it out of the tab bar: the page itself still works at /connections.
 */
export const CONNECTIONS_TAB: boolean = true;

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

export const SOURCE_NAME: Record<Source, string> = { slack: "Slack", telegram: "Telegram", gmail: "Gmail" };
/** The tab a conversation is read on: emails have a tab of their own. */
export const conversationPage = (id: string) => (id.startsWith("gmail:") ? "/emails" : "/inbox");

/** The connection each source comes through: Gmail comes with the Google account. */
export const SOURCE_PROVIDER: Record<Source, Provider> = { slack: "slack", telegram: "telegram", gmail: "google" };

/**
 * A conversation with nothing new for this many days is cleared from the inbox by itself.
 * It stays in the cleared list, and a new message brings it back.
 */
export const INBOX_DAYS = 3;
export const SOURCE_SHORT: Record<Source, string> = { slack: "SL", telegram: "TG", gmail: "GM" };

export const PRIORITIES: Priority[] = ["high", "mid", "low"];
export const PRIORITY_NAME: Record<Priority, string> = { high: "High", mid: "Medium", low: "Low" };
export const PRIORITY_RANK: Record<Priority, number> = { high: 0, mid: 1, low: 2 };

export const LINE_NAME: Record<Line, string> = { agency: "Agency", consulting: "Consulting" };

export const MODES: Mode[] = ["professional", "personal"];
export const MODE_NAME: Record<Mode, string> = { professional: "Professional", personal: "Personal" };
/** Department and project a personal task is filed under. Personal tasks have no real ones. */
export const PERSONAL = "Personal";
