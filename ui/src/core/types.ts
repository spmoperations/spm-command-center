export type Source = "slack" | "telegram";
export type Priority = "high" | "mid" | "low";
/** Business line of a conversation: the agency or the consulting offer. */
export type Line = "agency" | "consulting";

export interface ThreadMessage {
  me: boolean;
  text: string;
  at: number;
  /** Set on replies written in the dashboard until the source confirms delivery. */
  status?: "queued" | "sent";
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
  project: string;
  done: boolean;
  replied: boolean;
  /** Priority set by hand in the inbox; rules no longer change it. */
  manualPri?: boolean;
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
  dept: string;
  project: string;
  pri: Priority;
  /** ISO day, YYYY-MM-DD. */
  due: string;
  done: boolean;
  doneAt?: number | null;
  src?: TaskSource | null;
  /** False for decisions and anything only the owner can do. */
  delegable: boolean;
  delegatedTo?: Delegation | null;
}

export interface Suggestion {
  id: string;
  title: string;
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

export interface Meeting {
  id: string;
  date: string;
  time: string;
  dur: number;
  title: string;
  who: string;
  where: string;
  project: string;
  notes: { summary: string; points: string[]; decisions: string[] };
  /** [speaker, line]; "Jeremy" marks the owner. */
  transcript: [string, string][];
}

export interface Person {
  id: string;
  name: string;
  role: string;
  depts: string[];
  /** Kinds of work this person can own; matched against a task's title and project. */
  handles: string[];
}

/**
 * One sorting rule. Rules run top to bottom and the first match wins.
 * Label rules set `line`; priority rules set `pri`.
 */
export interface Rule {
  id: string;
  source: Source | "any";
  when: "any" | "direct" | "tagged" | "ctx" | "from";
  op: "is" | "starts" | "contains";
  value: string;
  pri?: Priority;
  line?: Line;
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
}

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
  | "task-suggest"
  | "slack-directory-sync"
  | "outbox-retry";

export interface JobSetting {
  id: JobId;
  intervalMin: number;
  enabled: boolean;
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
  focus: { day: Record<string, FocusItem[]>; week: Record<string, FocusItem[]> };
  links: QuickLink[];
  outbox: OutboxItem[];
  jobs: JobSetting[];
}
