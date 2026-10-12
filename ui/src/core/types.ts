export type Source = "slack" | "telegram";
/** Services a person connects themselves, from the Connections tab. */
export type Provider = "slack" | "telegram" | "fathom";
export type Priority = "high" | "mid" | "low";
/** Business line of a conversation: the agency or the consulting offer. */
export type Line = "agency" | "consulting";
/** The two sides of the dashboard. The switch in the header shows one at a time. */
export type Mode = "professional" | "personal";

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
}

export type JobId =
  | "slack-pull"
  | "telegram-pull"
  | "fathom-pull"
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
  owner: { name: string };
  /** False while replies are held in the outbox and not sent. */
  sendingEnabled: boolean;
  /** False until the AI key is set and has credit to run. */
  aiConfigured: boolean;
}
