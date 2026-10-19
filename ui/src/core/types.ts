export type Source = "slack" | "telegram" | "gmail";
/** Services a person connects themselves, from the Connections tab. */
export type Provider = "slack" | "telegram" | "fathom" | "google";
/** What an email is about, for the filter on the Emails tab (see core/email-tags). */
export type EmailTag = "payment" | "subscription" | "newsletter";
export type Priority = "high" | "mid" | "low";
/** Business line of a conversation: the agency or the consulting offer. */
export type Line = "agency" | "consulting";
/** The two sides of the dashboard. The switch in the header shows one at a time. */
export type Mode = "professional" | "personal";

/** A picture or sticker sent with a message. Videos are never shown. */
export interface MessagePicture {
  kind: "image" | "sticker";
  /** Where the dashboard serves it from, at a size for the screen. */
  src: string;
  /** The same picture at full size, when there is a bigger one. */
  full?: string;
  name: string;
  w?: number;
  h?: number;
  /** The message's own page in its app, for when the picture cannot be shown here. */
  link?: string;
}

/** An emoji people put on a message. One the dashboard has no picture for reads ":name:". */
export interface Reaction {
  emoji: string;
  count: number;
  /** The owner is one of the people who reacted. */
  mine?: boolean;
}

export interface ThreadMessage {
  me: boolean;
  text: string;
  at: number;
  /** Who wrote it, when it was not the owner. Group conversations have several people. */
  from?: string;
  /** Set on replies written in the dashboard until the source confirms delivery. */
  status?: "queued" | "sent";
  /** The message's id in its source (Slack's timestamp). Missing on replies not sent yet. */
  ts?: string;
  /** The id of the message that started the thread this one is in, when it is in one. */
  thread?: string;
  attachments?: MessagePicture[];
  reactions?: Reaction[];
  /** The sender's profile picture, when it is kept by the dashboard itself (Telegram). Slack's come from `AppState.avatars`. */
  avatar?: string;
}

export interface Conversation {
  id: string;
  source: Source;
  from: string;
  /** Channel or chat name, e.g. "#ops" or "Direct message". */
  ctx: string;
  direct: boolean;
  /** True when the owner is tagged in the latest message. */
  tagged: boolean;
  text: string;
  at: number;
  pri: Priority;
  line: Line;
  mode: Mode;
  project: string;
  done: boolean;
  replied: boolean;
  /** Priority set by hand in the inbox; rules no longer change it. */
  manualPri?: boolean;
  /** Personal or Professional picked by hand in the inbox; rules no longer change it. */
  manualMode?: boolean;
  /** The profile picture for the row, when it is kept by the dashboard itself (Telegram). */
  avatar?: string;
  /** Cleared by itself, for having nothing new in `INBOX_DAYS` days, and not by the owner. */
  autoCleared?: boolean;
  /** For an email: what it is about (payment, subscription, newsletter). */
  tags?: EmailTag[];
  /** From a channel, chat or person ticked as important in Settings: High, and first in the inbox. */
  important?: boolean;
  /**
   * Set when this row is one thread in a Slack channel: the id of the message that started
   * it. A reply written here goes into that thread.
   */
  root?: string;
  thread: ThreadMessage[];
}

export interface TaskSource {
  type: "message" | "meeting";
  id: string;
}

export interface Delegation {
  personId: string;
  name: string;
  role: string;
  note: string;
  at: number;
}

export interface Task {
  id: string;
  title: string;
  /** The rest of it: context, links, what done looks like. Empty when none was written. */
  description: string;
  mode: Mode;
  dept: string;
  project: string;
  pri: Priority;
  /** ISO day, YYYY-MM-DD. */
  due: string;
  done: boolean;
  doneAt?: number | null;
  /** When the task was added. */
  createdAt: number;
  src?: TaskSource | null;
  /** False for decisions and anything only the owner can do. */
  delegable: boolean;
  delegatedTo?: Delegation | null;
}

export interface Suggestion {
  id: string;
  title: string;
  mode: Mode;
  dept: string;
  project: string;
  pri: Priority;
  due: string;
  why: string;
  src: TaskSource | null;
  status: "new" | "accepted" | "dismissed";
  delegable: boolean;
  /** Marks built-in sample suggestions. */
  example?: boolean;
}

export interface ActionItem {
  text: string;
  /** Who it was assigned to on the call. */
  who: string;
  /** Assigned to the owner of this dashboard. */
  mine: boolean;
  done: boolean;
}

export interface Meeting {
  id: string;
  /** The moment the call started, in epoch milliseconds. The day and time shown are worked out from this where it is looked at. */
  at: number;
  /** The day ("2026-10-13") and the time ("15:00") the call started, in the timezone of whoever is looking. */
  date: string;
  time: string;
  dur: number;
  title: string;
  who: string;
  where: string;
  project: string;
  /** Link to the recording. */
  url?: string | null;
  /** The call's notes, as Markdown. */
  summary: string;
  actionItems: ActionItem[];
  /** [speaker, line]. Loaded only when a person opens the transcript. */
  transcript: [string, string][];
  transcriptLines?: number;
  /** Name the owner speaks under in the transcript. */
  ownerSpeaker?: string;
}

/** An event on one of the owner's Google Calendars, for the Calendar tab and the meetings coming up. */
export interface CalendarItem {
  /** Google's id for the event. The same meeting on two connected calendars is one item. */
  id: string;
  /** The connected accounts whose calendar it is on. */
  accounts: string[];
  title: string;
  /**
   * Start and end, in epoch milliseconds, shown in the timezone of whoever is looking. For an
   * all-day event they are midnight UTC of its first day and of the day after its last.
   */
  at: number;
  end: number;
  allDay: boolean;
  /** "meeting", or the kinds Google Calendar shows apart: "focus" time and "away" (out of office). */
  kind: "meeting" | "focus" | "away";
  /** Who else is invited, by name. */
  who: string;
  /** "Google Meet", "Zoom", a room or an address. Empty when the event says nothing. */
  where: string;
  /** Where to join the call. */
  link?: string;
  /** The event in Google Calendar. */
  calendarLink?: string;
  /** Who sent the invite, when it was not the owner. */
  organizer?: string;
  /** The owner's own answer to the invite: "accepted", "tentative" or "needsAction". */
  response?: string;
}

/** Something ticked as important in Settings. */
export interface ImportantPick {
  source: "slack" | "telegram";
  /** A Slack channel or Telegram group ("chat"), or someone ("person"). */
  kind: "chat" | "person";
  id: string;
  name: string;
}

/** A connected Google account, and what it allowed: reading Gmail, sending, reading the calendar, adding events. */
export interface GoogleAccountInfo {
  email: string;
  connectedAt: number;
  gmail: boolean;
  send: boolean;
  calendar: boolean;
  addEvents: boolean;
}

export interface Person {
  id: string;
  name: string;
  role: string;
  depts: string[];
  /** Kinds of work this person can own; matched against a task's title and project. */
  handles: string[];
  /** Their Slack account, so a delegated task can reach them as a direct message. */
  slackUserId?: string | null;
}

/**
 * One sorting rule. Rules run top to bottom and the first match wins.
 * Label rules set `mode` and `line`; priority rules set `pri`.
 */
export interface Rule {
  id: string;
  source: Source | "any";
  when: "any" | "direct" | "tagged" | "ctx" | "from";
  op: "is" | "starts" | "contains";
  value: string;
  pri?: Priority;
  line?: Line;
  mode?: Mode;
}

export interface Metric {
  id: string;
  parent?: string;
  name: string;
  target: number;
  unit: "n" | "$";
  /** A parent whose value is the sum of its children. */
  sum?: boolean;
}

export interface FocusItem {
  id: string;
  text: string;
  done: boolean;
}

export interface QuickLink {
  id: string;
  label: string;
  url: string;
  mode: Mode;
}

export type FocusBoard = { day: Record<string, FocusItem[]>; week: Record<string, FocusItem[]> };

export interface OutboxItem {
  id: string;
  source: Source;
  to: string;
  ctx: string;
  text: string;
  at: number;
  status: "queued" | "sent" | "failed";
  conversationId?: string;
  taskId?: string;
  /** True for a reply that goes under another message, in its thread: a task's description under its announcement. */
  inThread?: boolean;
}

export type JobId =
  | "slack-pull"
  | "telegram-pull"
  | "fathom-pull"
  | "gmail-pull"
  | "calendar-pull"
  | "inbox-rules"
  | "request-finder"
  | "task-suggest"
  | "slack-directory-sync"
  | "outbox-retry";

export interface JobSetting {
  id: JobId;
  intervalMin: number;
  enabled: boolean;
}

export interface ProviderConnection {
  connected: boolean;
  connectedAt?: number;
  /** A non-secret detail to show on screen, such as the account name. Never a key or token. */
  label?: string;
}

/** A Slack channel the owner is in. Only ticked channels are read. */
export interface Channel {
  id: string;
  name: string;
  kind: "public" | "private";
  selected: boolean;
}

export interface JobStatus {
  lastRunAt: number | null;
  ok: boolean | null;
  items: number;
  message: string | null;
  /** Set while a service has asked the job to wait. */
  notBefore: number | null;
}

export interface AppState {
  /** YYYY-MM the target logs belong to. */
  month: string;
  inbox: Conversation[];
  tasks: Task[];
  suggestions: Suggestion[];
  meetings: Meeting[];
  /** The connected Google Calendars, from the start of last week to three weeks ahead. */
  calendar: CalendarItem[];
  team: Person[];
  /** Clients and internal buckets a task can belong to. */
  projects: string[];
  labelRules: Rule[];
  priorityRules: Rule[];
  metrics: Metric[];
  /** metric id -> day of month -> value logged that day. */
  logs: Record<string, Record<number, number>>;
  /** Each side of the dashboard keeps its own focus. */
  focus: Record<Mode, FocusBoard>;
  links: QuickLink[];
  outbox: OutboxItem[];
  jobs: JobSetting[];
  connections: Record<Provider, ProviderConnection>;
  jobStatus: Partial<Record<JobId, JobStatus>>;
  channels: Channel[];
  /** People in the Slack workspace, for linking team members. */
  slackPeople: { id: string; name: string }[];
  /** What is ticked as important in Settings. */
  important: ImportantPick[];
  /** The Telegram groups and channels, and the people, there are to tick. Empty where Telegram is not used. */
  telegramChats: { id: string; name: string; kind: "group" | "channel" }[];
  telegramPeople: { id: string; name: string }[];
  /** Profile picture addresses by the name a person's messages carry. A name with no entry gets initials. */
  avatars: Record<string, string>;
  owner: { name: string };
  /** False while replies are held in the outbox and not sent. */
  sendingEnabled: boolean;
  /**
   * Whether the connected Slack app may read files, which showing pictures needs. Null until
   * the people-and-channels check has asked Slack.
   */
  slackFilesAllowed: boolean | null;
  /** True where Telegram can be connected: its app keys are set, and this server may hold a Telegram login. */
  telegramAvailable: boolean;
  /** Why Telegram cannot be connected here, in a sentence for whoever sets the server up. Null when it can. */
  telegramBlocked: string | null;
  /** The same for Google: its app keys are set, and this server may hold a Google login. */
  googleAvailable: boolean;
  googleBlocked: string | null;
  /** The connected Google accounts. */
  googleAccounts: GoogleAccountInfo[];
  /** Whether any connected Google account allowed each of these. */
  googleAllows: { gmail: boolean; send: boolean; calendar: boolean; addEvents: boolean };
  /** True when the data is the copy on this machine and not the hosted database. */
  localData: boolean;
  /** False until the AI key is set and has credit to run. */
  aiConfigured: boolean;
}
