// Sorting rules for the inbox. This is plain logic on purpose: what is urgent and
// which business line a chat belongs to are decided by rules the owner sets, not by AI.
import type { Conversation, Line, Priority, Rule } from "./types";

export const DEFAULT_PRIORITY: Priority = "low";
export const DEFAULT_LINE: Line = "agency";

/** Lower-cased with punctuation collapsed, so "#Consulting-" matches "#consulting cohort". */
export const norm = (x: unknown) =>
  String(x ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, " ")
    .trim();

type Sortable = Pick<Conversation, "source" | "from" | "ctx" | "direct" | "tagged">;

export function ruleMatches(rule: Rule, c: Sortable): boolean {
  if (rule.source !== "any" && rule.source !== c.source) return false;
  if (rule.when === "any") return true;
  if (rule.when === "direct") return c.direct;
  if (rule.when === "tagged") return c.tagged;
  const hay = norm(rule.when === "from" ? c.from : c.ctx);
  const value = norm(rule.value);
  // A text rule with nothing to match would silently catch everything.
  if (!value) return false;
  if (rule.op === "is") return hay === value;
  if (rule.op === "starts") return hay.startsWith(value);
  return hay.includes(value);
}

export const firstMatch = (rules: Rule[], c: Sortable) => rules.find((r) => ruleMatches(r, c)) ?? null;

export function sortConversation(c: Sortable, labelRules: Rule[], priorityRules: Rule[]) {
  return {
    line: firstMatch(labelRules, c)?.line ?? DEFAULT_LINE,
    pri: firstMatch(priorityRules, c)?.pri ?? DEFAULT_PRIORITY,
  };
}

/** Re-sorts every conversation. A priority set by hand in the inbox is kept. */
export function applyRules(inbox: Conversation[], labelRules: Rule[], priorityRules: Rule[]): Conversation[] {
  return inbox.map((c) => {
    const sorted = sortConversation(c, labelRules, priorityRules);
    return { ...c, line: sorted.line, pri: c.manualPri ? c.pri : sorted.pri };
  });
}

/** How many conversations each rule is the first match for. */
export function ruleHits(rules: Rule[], inbox: Conversation[]): Record<string, number> {
  const hits: Record<string, number> = {};
  for (const r of rules) hits[r.id] = 0;
  for (const c of inbox) {
    const r = firstMatch(rules, c);
    if (r) hits[r.id] += 1;
  }
  return hits;
}
