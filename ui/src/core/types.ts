export type Source = "slack" | "telegram" | "gmail";
/** Services a person connects themselves, from the Connections tab. */
export type Provider = "slack" | "telegram" | "fathom" | "google";
/** What an email is about, for the filter on the Emails tab (see core/email-tags). */
export type EmailTag = "respond" | "payment" | "newsletter" | "invite" | "notification" | "receipt";
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
  /** Kept by the dashboard itself (a picture the owner added to a reply), so it shows whatever the app allows. */
  here?: boolean;
}

/** A picture added to a reply on screen: where it was kept when it was added, and its size for the screen. */
export interface AddedPicture {
  key: string;
  name: string;
  w?: number;
  h?: number;
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

/** App keys as the screens show them: whose a new connection uses, and the person's own. Never a secret. */
export interface AppKeysOnScreen {
  using: "own" | "team" | "settings" | null;
  label: string | null;
  own: string | null;
}

/** A team member's login, as the owner sees it in Settings. */
export interface TeamLogin {
  id: string;
  name: string;
  email: string;
  /** False once the owner turned it off: their data stays, and they can no longer sign in. */
  active: boolean;
  createdAt: number;
}

/** One change made to many conversations at once, picked on screen. */
export interface ConversationChange {
  /** true marks them done, false puts them back in the inbox. */
  done?: boolean;
  pri?: Priority;
  mode?: Mode;
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
  /**
   * Only the newest messages are here, so the page loads quickly; the rest come when the
   * conversation is opened. An email thread always comes whole.
   */
  partial?: boolean;
}

export interface TaskSource {
  type: "message" | "meeting";
  id: string;
}

/** Where a ticket stands on the board. Done is the last; Waiting is on someone else. */
export type TicketStatus = "open" | "in_progress" | "waiting" | "done";

/** One thing that happened to a ticket, for its history. */
export interface TicketEvent {
  at: number;
  by: string;
  what: string;
}

/** Where a ticket or a suggestion came from, kept so everyone on the team can read it. */
export interface SourceNote {
  /** "Slack · #sales", "Fathom · SPM Ops". */
  label: string;
  /** The line it came from. */
  quote: string;
  /** Its place in Slack, Gmail or the recording, when there is one. */
  link?: string | null;
  /** Whose inbox or call it came from. */
  from: string;
}

/** Someone a ticket can be for: a login (the owner, Alex) or a team member without one. */
export interface TeamPerson {
  /** "user:<id>" for a login, "member:<id>" for someone on the team list. */
  id: string;
  name: string;
  role: string;
  login: boolean;
  /** Where an assignment can reach them: a login on Slack only, someone on the team list on Slack or Telegram. */
  slack: boolean;
  telegram: boolean;
  /**
   * Not told about a task from this page. Between logins, only Jeremy and another login are told,
   * either way; nobody is told about a task they gave themselves.
   */
  notTold?: boolean;
}

/** What a ticket is, as it is made or changed on screen. */
export interface TicketInput {
  title: string;
  description: string;
  /** A TeamPerson id, or null for nobody yet. */
  assignee: string | null;
  client: string;
  due: string;
  status: TicketStatus;
  pri?: Priority;
  /** Where to tell a team member it is theirs. Nothing: they are not told. */
  notify?: ("slack" | "telegram")[];
}

/** Something a check flagged, waiting for someone on the team to make it a ticket or turn it down. */
export interface ReviewItem {
  id: string;
  title: string;
  why: string;
  source: SourceNote;
  /** Who the source says it is for, when it says (Fathom's assignee). */
  forName: string | null;
  /** The TeamPerson it would go to. */
  assignee: string | null;
  client: string;
  due: string;
  pri: Priority;
  /** When it was flagged. */
  at: number;
  /** When it was said: the message, or the start of the call. The Review tab shows everything since `REVIEW_FROM`. */
  raisedAt: number;
  /** A message the rules flagged, read by the AI: how sure it is that this is a real task. Null when not asked. */
  confidence: number | null;
  /** A message the rules flagged that the AI has not read yet. */
  unchecked: boolean;
  /** Why it may be done already, when something says so. */
  looksDone: string | null;
  src: TaskSource | null;
  /** Whose inbox or calls it came from: a login's id. */
  fromUser: string;
  /** From the signed-in person's own inbox or calls, so it can be opened here. */
  mine: boolean;
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
  /** Where it stands on the board. */
  status: TicketStatus;
  /** Its number on the board (SPM-12). */
  number: number | null;
  /** Who it is for: a TeamPerson id. Null: nobody yet, or a whole Slack channel (see delegatedTo). */
  assignee: string | null;
  assigneeName: string | null;
  createdBy?: string | null;
  /** Where it came from, readable by everyone on the team. */
  source?: SourceNote | null;
  /** It came from someone else's inbox or calls: `src` cannot be opened here. */
  theirs?: boolean;
  history?: TicketEvent[];
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
  /** Google's own id for the event, on the first of `accounts`, for changing or answering it. */
  eventId: string;
  /** The owner made it: it can be changed and deleted. Otherwise it is an invitation to answer. */
  mine: boolean;
  /** One occurrence of a repeating event. */
  recurring: boolean;
  description?: string;
  /** The guests' addresses, for the form that changes it. */
  guests: string[];
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
  /** Their Telegram account, so an assignment can reach them there too. */
  telegramId?: string | null;
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
  | "task-check"
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
  /** The team's tickets: everyone with a login shares them. */
  tasks: Task[];
  suggestions: Suggestion[];
  /** What the checks flagged across the team, waiting to be made a ticket or turned down. */
  review: ReviewItem[];
  /** Everyone a ticket can be for. */
  people: TeamPerson[];
  /** What the AI set aside as not a task lately, so anyone can put one back. */
  setAside: ReviewItem[];
  /** Every client a ticket can be filed under: the team's list, and those that tickets, calls and chats already name. */
  clients: string[];
  /** Everyone in the team's Slack, as any login on the team has read it: a ticket can go to any of them. */
  teamSlack: { id: string; name: string }[];
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
  /** The connected Telegram account's chats, and whether each is ticked to come in (see jobs/telegram.ts). */
  telegramChats: { id: string; name: string; kind: "group" | "channel" | "direct"; synced: boolean; lastAt: number | null }[];
  telegramPeople: { id: string; name: string }[];
  /** Profile picture addresses by the name a person's messages carry. A name with no entry gets initials. */
  avatars: Record<string, string>;
  owner: { name: string };
  /** Who is signed in: the owner, or a team member with a Command Center of their own. */
  me: { id: string; isOwner: boolean };
  /** For the owner only: the team members' logins. Empty for everyone else. */
  logins: TeamLogin[];
  /** False while replies are held in the outbox and not sent. */
  sendingEnabled: boolean;
  /**
   * Whether the connected Slack app may read files, which showing pictures needs. Null until
   * the people-and-channels check has asked Slack.
   */
  slackFilesAllowed: boolean | null;
  /** Whether the connected Slack app may send pictures with a reply. Null until Slack has said. */
  slackUploadAllowed: boolean | null;
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
  /**
   * The app keys a new Google or Telegram connection by this person uses: their own, the team's
   * (the owner's), or the server's settings; and their own, when they saved some. Never a secret.
   */
  appKeys: Record<"google" | "telegram" | "anthropic" | "slack", AppKeysOnScreen>;
  /** A fingerprint of each part as it was read, so the page can ask whether anything changed. */
  stamps?: Stamps;
}

/**
 * The parts of the data that are read again only when they changed: the conversations, the
 * calendar, the calls, and everything else (which is small, and comes whenever any part does).
 */
export type StatePart = "inbox" | "calendar" | "meetings" | "rest";
export type Stamps = Record<StatePart, string>;
/** The big parts. An answer leaves out each one that has not changed since the page read it. */
export type HeavyPart = Exclude<StatePart, "rest">;
/** What the server answers when the page asks for what changed. */
export type StateUpdate = Omit<AppState, HeavyPart> & Partial<Pick<AppState, HeavyPart>>;
export type StateAnswer = StateUpdate | { unchanged: true; stamps: Stamps };
