// Lays a conversation out the way Slack does: each message that started a thread with its
// replies under it. Plain logic, used by the inbox.
import type { ThreadMessage } from "./types";

export interface MessageGroup {
  /** The id of the first message of the thread, or of the single message. */
  key: string;
  /** The message that started it. Null when only its replies have been read so far. */
  first: ThreadMessage | null;
  replies: ThreadMessage[];
  /** True when the group is a thread in Slack, so a reply can go into it. */
  threaded: boolean;
  /** When the newest message in the group was written. */
  at: number;
}

/**
 * Groups messages by thread, oldest first, with the group that was written in most recently
 * at the bottom: a new reply in last week's thread is what needs reading now.
 */
export function groupByThread(messages: ThreadMessage[]): MessageGroup[] {
  const groups = new Map<string, MessageGroup>();
  messages.forEach((m, k) => {
    const key = m.thread ?? m.ts ?? `unsent-${k}`;
    const group = groups.get(key) ?? { key, first: null, replies: [], threaded: false, at: 0 };
    if (m.thread) group.threaded = true;
    // The message that started the thread carries the thread's id as its own.
    if (!m.thread || m.ts === m.thread) group.first = m;
    else group.replies.push(m);
    group.at = Math.max(group.at, m.at);
    groups.set(key, group);
  });
  for (const group of groups.values()) group.replies.sort((a, b) => a.at - b.at);
  return [...groups.values()].sort((a, b) => a.at - b.at);
}

/** The thread a new reply should go into by default: the one the latest message from someone else is in. */
export function threadToAnswer(messages: ThreadMessage[]): string | null {
  const latest = [...messages].reverse().find((m) => !m.me);
  return latest?.thread ?? null;
}
