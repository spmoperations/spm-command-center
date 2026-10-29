import type { Line, Mode, Priority, Provider, Source, TaskLine, TicketStatus } from "./types";

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

/**
 * Suggested tasks (action items from calls, and requests waiting for a reply) are reviewed on
 * the Review tab, by the whole team. This shows how many are waiting on Today; `false` hides it.
 */
export const SUGGESTED_TASKS: boolean = true;

/** The most one picture added to a reply may weigh: what one request to the live site can carry, with room to spare. */
export const MOST_PICTURE_BYTES = 4 * 1024 * 1024;
/** The most pictures that go with one Slack message. */
export const MOST_PICTURES = 10;

/** Tickets on the board are numbered SPM-1, SPM-2 and so on. */
export const TICKET_PREFIX = "SPM";

/**
 * The team's Google Workspace. Anyone with a Google account there who is on the team's Slack
 * signs in with Google to see their own tasks, without being given a login first (see
 * server/task-logins.ts). A developer's machine can name its own with TEAM_GOOGLE_DOMAIN.
 */
export const TEAM_GOOGLE_DOMAIN = "socialprofitmedia.co";

/**
 * The first day the Review tab shows: suggestions raised before it are kept but never shown.
 * The week the Review tab started, so everything from then on stays visible, this week and
 * after, until someone accepts or rejects it.
 */
export const REVIEW_FROM = "2026-10-19";
export const TICKET_STATUSES: TicketStatus[] = ["open", "in_progress", "waiting", "done"];
export const TICKET_STATUS_NAME: Record<TicketStatus, string> = { open: "Open", in_progress: "In progress", waiting: "Waiting", done: "Done" };
/** Why a suggestion was turned down, as the review asks. */
export const REJECT_REASONS = { not_task: "Not a task", duplicate: "Duplicate", already_done: "Already done", wrong_person: "Wrong person", chit_chat: "Chit-chat", other: "Other" } as const;
export type RejectReason = keyof typeof REJECT_REASONS;

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
/** What a task can be labelled: whose side of the business it is for (see ChatLine). */
export const TASK_LINES: TaskLine[] = ["agency", "consulting", "sales"];
export const TASK_LINE_NAME: Record<TaskLine, string> = { ...LINE_NAME, sales: "Sales" };

export const MODES: Mode[] = ["professional", "personal"];
export const MODE_NAME: Record<Mode, string> = { professional: "Professional", personal: "Personal" };
/** Department and project a personal task is filed under. Personal tasks have no real ones. */
export const PERSONAL = "Personal";
