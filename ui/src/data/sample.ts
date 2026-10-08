// Sample data, taken from Jeremy's prototype and cut down to Phase 1 (Slack, Telegram, recorded
// calls). It stands in for live data until the connections exist, and the UI labels it as sample.
// Everything here depends on the current date, so it is only ever built in the browser.
import { addDays, daysInMonth, monthKey, weekStart } from "@/core/dates";
import { defaultJobSettings } from "@/core/jobs";
import { applyRules } from "@/core/rules";
import type {
  AppState,
  Conversation,
  FocusItem,
  Meeting,
  Metric,
  Person,
  Priority,
  Rule,
  Source,
  Suggestion,
  Task,
  TaskSource,
} from "@/core/types";

type History = ["me" | "them", string, number][];

function sampleInbox(now: Date): Conversation[] {
  const base = now.getTime();
  const c = (
    id: string,
    source: Source,
    from: string,
    ctx: string,
    text: string,
    minsAgo: number,
    project: string,
    opts: { direct?: boolean; tagged?: boolean; history?: History } = {},
  ): Conversation => {
    const at = base - minsAgo * 60_000;
    const earlier = (opts.history ?? []).map(([who, t, before]) => ({ me: who === "me", text: t, at: at - before * 60_000 }));
    return {
      id, source, from, ctx, text, at, project,
      direct: opts.direct ?? false,
      tagged: opts.tagged ?? false,
      pri: "low", line: "agency", done: false, replied: false,
      thread: [...earlier, { me: false, text, at }],
    };
  };
  const dm = "Direct message";
  return [
    c("m1", "slack", "Maya Chen", "#harbor-realty-content", "Approved 3 of the 5 clips. Can we swap the hook on #4 before it goes out Friday?", 22, "Harbor Realty", {
      history: [["me", "This week's clips are in the shared folder. Let me know which ones are good to post.", 190], ["them", "Thanks! Looking now.", 150]],
    }),
    c("m2", "telegram", "Derek Lin", dm, "Card on file expired. Can you resend the invoice link? I want to pay today.", 48, "Apex Fitness Co", {
      direct: true, history: [["them", "Hey Jeremy, quick billing question.", 2]],
    }),
    c("m3", "telegram", "Sam Ortiz", dm, "Kickoff notes look good. Could we add a YouTube long-form package to the proposal?", 170, "Vendly", {
      direct: true, history: [["me", "Sending over the kickoff notes now. Flag anything that looks off.", 1300]],
    }),
    c("m6", "slack", "Gavin", "#ops", "Our editor contractor wants to move to weekly pay starting October. Need your OK.", 185, "Internal Ops", {
      tagged: true, history: [["them", "Luis asked about the pay schedule on our 1:1.", 5]],
    }),
    c("m8", "telegram", "Chris Park", dm, "Want you on the show in October. 45 minutes, remote. Which weeks work?", 360, "Marketing", { direct: true }),
    c("m9", "slack", "Nina Ruiz", "#harbor-realty-content", "Can we get last month's performance report before our call today?", 1500, "Harbor Realty"),
    c("m10", "telegram", "Jordan Blake", dm, "Sent over the contract redlines. Mostly small stuff.", 1560, "Sales", { direct: true }),
    c("m11", "slack", "Priya", "#sales", "Booked 2 more discovery calls for tomorrow off the Tuesday reel.", 300, "Sales"),
    c("m12", "telegram", "Creator Ops", "Creator Ops group", "Anyone have a solid caption editor? Ours is backlogged two days.", 130, "Internal Ops"),
    c("m15", "slack", "Tanya Brooks", "#consulting-cohort-3", "Is the recording from Tuesday's workshop up yet? A few of us missed it.", 140, "Consulting"),
    c("m16", "slack", "Rachel Kim", "#consulting-rachel-kim", "Ran the offer teardown with my team. Can we move Thursday's session to Friday? And could you send the pricing sheet you mentioned?", 95, "Consulting", {
      history: [["me", "Great session today. Homework: rewrite the offer page around one outcome.", 1500]],
    }),
    c("m17", "slack", "Omar Haddad", "#consulting-omar-haddad", "Hit $40k this month off the new clip offer. Want to walk through hiring my first editor on our next call.", 260, "Consulting"),
  ];
}

/** Starting rules. Both lists are edited in Settings. */
function sampleRules(): { labelRules: Rule[]; priorityRules: Rule[] } {
  return {
    labelRules: [{ id: "lr1", source: "slack", when: "ctx", op: "starts", value: "#consulting-", line: "consulting" }],
    priorityRules: [
      { id: "pr1", source: "any", when: "tagged", op: "is", value: "", pri: "high" },
      { id: "pr2", source: "slack", when: "ctx", op: "is", value: "#harbor-realty-content", pri: "high" },
      { id: "pr3", source: "telegram", when: "from", op: "is", value: "Derek Lin", pri: "high" },
      { id: "pr4", source: "any", when: "direct", op: "is", value: "", pri: "mid" },
      { id: "pr5", source: "slack", when: "ctx", op: "starts", value: "#consulting-", pri: "mid" },
    ],
  };
}

// Tasks only Jeremy can do (decisions, on-camera work, his own relationships).
const ONLY_JEREMY = new Set(["t2", "t4", "t5", "t7", "t12"]);
const TASK_SOURCES: Record<string, TaskSource> = {
  t1: { type: "meeting", id: "mt1" }, t2: { type: "message", id: "m6" }, t3: { type: "message", id: "m2" },
  t4: { type: "meeting", id: "mt3" }, t5: { type: "message", id: "m10" }, t8: { type: "meeting", id: "mt4" },
  t10: { type: "meeting", id: "mt4" }, t11: { type: "message", id: "m1" }, t12: { type: "message", id: "m8" },
};

function sampleTasks(now: Date): Task[] {
  const t = (id: string, title: string, dept: string, project: string, pri: Priority, dueIn: number, done = false): Task => ({
    id, title, dept, project, pri, due: addDays(now, dueIn), done, doneAt: null,
    src: TASK_SOURCES[id] ?? null, delegable: !ONLY_JEREMY.has(id), delegatedTo: null,
  });
  return [
    t("t1", "Send September performance report to Harbor Realty", "Client Sales", "Harbor Realty", "high", 0),
    t("t2", "Approve editor weekly-pay change", "Finances", "Internal Ops", "mid", 0),
    t("t3", "Resend Apex invoice link", "Finances", "Apex Fitness Co", "high", 0),
    t("t4", "Draft Vendly YouTube long-form add-on pricing", "SPM Sales", "Vendly", "high", 1),
    t("t5", "Review Jordan's contract redlines", "SPM Sales", "Sales", "mid", 1),
    t("t6", "Write October content calendar for personal brand", "SPM Marketing", "Marketing", "mid", 2),
    t("t7", "Record 3 reels on the agency pricing shift", "SPM Marketing", "Marketing", "mid", 3),
    t("t8", "Hire second caption editor", "Operations", "Internal Ops", "high", -2),
    t("t9", "Update SOP for clip QA and Whisper verification", "Operations", "Internal Ops", "low", 5),
    t("t10", "Follow up with 4 no-show discovery calls", "SPM Sales", "Sales", "high", -1),
    t("t11", "Swap hook on Harbor clip #4", "Client Sales", "Harbor Realty", "high", 1),
    t("t12", "Reply to Chris Park with podcast dates", "SPM Marketing", "Marketing", "low", 2),
    t("t17", "Onboard Vendly editor to Frame.io", "Client Sales", "Vendly", "mid", -4, true),
  ];
}

function sampleMeetings(now: Date): Meeting[] {
  const m = (id: string, day: number, time: string, dur: number, title: string, who: string, where: string, project: string, notes: Meeting["notes"], transcript: Meeting["transcript"]): Meeting => ({
    id, date: addDays(now, day), time, dur, title, who, where, project, notes, transcript,
  });
  return [
    m("mt1", -2, "11:00", 45, "Harbor Realty weekly check-in", "Maya Chen, Nina Ruiz", "Google Meet", "Harbor Realty",
      { summary: "Reviewed last week's listing-tour clips. Retention is strong for the first 3 seconds and drops at the price reveal. Nina wants a performance report before each monthly review.",
        points: ["Listing tours hold 41% at 3 seconds, falling to 18% by the price reveal", "Maya wants hooks that lead with the neighborhood, not the house", "Nina needs a performance report 24 hours before monthly reviews"],
        decisions: ["Test neighborhood-first hooks on the next 5 clips", "Monthly report becomes a standing deliverable"] },
      [["Maya Chen", "The tours do well until the price shows up, then people bail."], ["Jeremy", "That tracks. Let's lead with the neighborhood and hold the price for the end."], ["Nina Ruiz", "Can we also get a report before each monthly review? I need something to show our broker."], ["Jeremy", "Yes. I'll get you September's numbers before our call Wednesday."], ["Maya Chen", "And can you send a few hook options for the Oak Street listing?"], ["Jeremy", "I'll have three options to you by Thursday."]]),
    m("mt2", -1, "10:00", 40, "Discovery call: Brightline Coaching", "Dana Whitfield", "Zoom", "Sales",
      { summary: "Dana runs a coaching business with a weekly 60-minute podcast and no short-form. Strong fit for the clip package, budget around $4–5k a month.",
        points: ["Records weekly, nothing is clipped today", "Tried a freelancer before; quality was inconsistent", "Decision by end of next week; co-founder signs off"],
        decisions: ["Send a proposal with 3 package tiers"] },
      [["Dana Whitfield", "We record every week and basically nothing happens with it after."], ["Jeremy", "That's the most common thing we see. One episode should give you 8 to 12 clips."], ["Dana Whitfield", "What does that cost?"], ["Jeremy", "I'll send three tiers so you and your co-founder can compare. You'll have it by Thursday."], ["Dana Whitfield", "Perfect. Include a sample clip from last week's episode if you can."]]),
    m("mt3", -1, "14:00", 60, "Vendly kickoff", "Sam Ortiz", "Google Meet", "Vendly",
      { summary: "Kicked off Vendly: 60 short-form pieces a month across Instagram and TikTok. Sam is interested in adding YouTube long-form.",
        points: ["Output is behind pace this month because editor onboarding took a week", "Sam will share brand assets and their top 10 past videos", "Interested in a YouTube long-form add-on"],
        decisions: ["Weekly async review in Frame.io", "Jeremy prices the YouTube add-on"] },
      [["Sam Ortiz", "Short-form first, but long term YouTube is the big one for us."], ["Jeremy", "Makes sense. I'll put together pricing for a long-form add-on."], ["Sam Ortiz", "I'll send brand assets and our best-performing videos this week."], ["Jeremy", "Great. We're a bit behind on volume this month because of onboarding. We'll catch up over the next two weeks."]]),
    m("mt4", -1, "09:00", 20, "Team standup", "Gavin, Priya, editors", "Slack huddle", "Internal Ops",
      { summary: "Caption backlog is at 2 days. Four discovery calls no-showed last week.",
        points: ["Caption editor backlog at 2 days", "4 no-shows from last week's booked calls", "Priya is booking calls off the Tuesday reel"],
        decisions: ["Hire a second caption editor", "Jeremy follows up with no-shows personally"] },
      [["Gavin", "Captions are two days behind. We need another editor."], ["Jeremy", "Agreed, let's hire. I'll post the role."], ["Priya", "We had four no-shows last week."], ["Jeremy", "Send me the list. I'll follow up with them myself."]]),
  ];
}

function sampleSuggestions(now: Date): Suggestion[] {
  const g = (id: string, title: string, dept: string, project: string, pri: Priority, dueIn: number, why: string, src: TaskSource): Suggestion => ({
    id, title, dept, project, pri, due: addDays(now, dueIn), why, src, status: "new", delegable: true, example: true,
  });
  return [
    g("s1", "Send Brightline Coaching a 3-tier proposal with a sample clip", "SPM Sales", "Sales", "high", 1, "You told Dana you'd send three tiers by Thursday, with a clip from last week's episode.", { type: "meeting", id: "mt2" }),
    g("s2", "Post the job listing for a second caption editor", "Operations", "Internal Ops", "high", 0, "At standup you said you'd post the role. Captions are 2 days behind.", { type: "meeting", id: "mt4" }),
    g("s3", "Send Maya 3 hook options for the Oak Street listing", "Client Sales", "Harbor Realty", "mid", 1, "You promised Maya three hook options by Thursday.", { type: "meeting", id: "mt1" }),
    g("s4", "Chase Sam for Vendly brand assets and top 10 videos", "Client Sales", "Vendly", "mid", 2, "Sam said he'd send them this week, and Vendly output is behind pace.", { type: "meeting", id: "mt3" }),
  ];
}

function sampleTeam(): Person[] {
  const p = (id: string, name: string, role: string, depts: string[], handles: string[]): Person => ({ id, name, role, depts, handles });
  return [
    p("u1", "Priya Shah", "Sales lead", ["SPM Sales"], ["Discovery calls", "Follow-ups", "No-shows", "Proposals"]),
    p("u2", "Marcus Reed", "Appointment setter", ["SPM Sales"], ["Outbound DMs", "Booking calls", "Follow-ups"]),
    p("u3", "Tess Nguyen", "Content strategist", ["SPM Marketing"], ["Content calendar", "Podcast", "Reels", "Consulting"]),
    p("u4", "Luis Ramos", "Lead editor", ["Client Sales"], ["Editing", "Hooks", "Clip QA", "Harbor Realty", "Vendly"]),
    p("u5", "Kai Brooks", "Editor", ["Client Sales"], ["Editing", "Captions", "Frame.io", "Apex Fitness Co"]),
    p("u6", "Gavin Cole", "Operations manager", ["Operations", "Finances"], ["Hiring", "SOPs", "Contractors", "Payroll"]),
    p("u7", "Rene Park", "Bookkeeper", ["Finances"], ["Invoices", "Payments", "Receivables"]),
  ];
}

// Monthly targets with the leading indicators behind them. `factor` only shapes the sample
// month (1 = exactly on pace) and is not part of a real metric.
const SAMPLE_METRICS: (Metric & { factor?: number })[] = [
  { id: "calls", name: "Calls Booked", target: 60, unit: "n", factor: 0.8 },
  { id: "dms", parent: "calls", name: "Outbound DMs sent", target: 1500, unit: "n", factor: 0.76 },
  { id: "inbound", parent: "calls", name: "Inbound leads from content", target: 90, unit: "n", factor: 0.86 },
  { id: "cash", name: "Client Cash Collected", target: 85000, unit: "$", factor: 1.04 },
  { id: "invoiced", parent: "cash", name: "Invoices issued", target: 95000, unit: "$", factor: 1.0 },
  { id: "ontime", parent: "cash", name: "Invoices paid on time", target: 22, unit: "n", factor: 0.95 },
  { id: "revenue", name: "Overall Agency Revenue", target: 120000, unit: "$", factor: 0.92 },
  { id: "deals", parent: "revenue", name: "New deals closed", target: 6, unit: "n", factor: 0.8 },
  { id: "upsells", parent: "revenue", name: "Upsell / expansion revenue", target: 15000, unit: "$", factor: 1.12 },
  { id: "held", parent: "revenue", name: "Sales calls held", target: 48, unit: "n", factor: 0.87 },
  { id: "content", name: "Content Output", target: 240, unit: "n", sum: true },
  { id: "c-harbor", parent: "content", name: "Harbor Realty pieces", target: 60, unit: "n", factor: 1.02 },
  { id: "c-apex", parent: "content", name: "Apex Fitness Co pieces", target: 60, unit: "n", factor: 0.97 },
  { id: "c-vendly", parent: "content", name: "Vendly pieces", target: 60, unit: "n", factor: 0.72 },
  { id: "c-jeremy", parent: "content", name: "Jeremy personal brand", target: 60, unit: "n", factor: 1.05 },
];

/** Small seeded generator, so the sample month looks the same on every load. */
function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Daily values for days 1 to yesterday. Today is left for the owner to log. */
function sampleLogs(now: Date): AppState["logs"] {
  const logs: AppState["logs"] = {};
  const days = now.getDate() - 1;
  const dim = daysInMonth(now);
  for (const m of SAMPLE_METRICS) {
    if (m.sum) continue;
    const r = rng(m.id + now.getFullYear() + now.getMonth());
    const raw = Array.from({ length: days }, (_, i) => {
      const weekday = new Date(now.getFullYear(), now.getMonth(), i + 1).getDay();
      return (weekday === 0 || weekday === 6 ? 0.35 : 1.15) * (0.4 + 1.2 * r());
    });
    const total = raw.reduce((a, b) => a + b, 0) || 1;
    const goal = (m.target * (m.factor ?? 1) * days) / dim;
    const step = m.unit === "$" ? 250 : 1;
    let cum = 0;
    let prev = 0;
    logs[m.id] = {};
    raw.forEach((v, i) => {
      cum += (v / total) * goal;
      const rounded = Math.round(cum / step) * step;
      logs[m.id][i + 1] = Math.max(0, rounded - prev);
      prev = rounded;
    });
  }
  return logs;
}

function sampleFocus(now: Date): AppState["focus"] {
  const items = (scope: string, ...texts: string[]): FocusItem[] => texts.map((text, k) => ({ id: `f-${scope}-${k}`, text, done: false }));
  return {
    day: { [addDays(now, 0)]: items("day", "Send Brightline the 3-tier proposal", "Nail the Harbor monthly review", "Post the caption editor role") },
    week: { [weekStart(now)]: items("week", "Get calls booked back on pace: 15 more by Friday", "Catch Vendly up on output", "Sign Jordan Blake") },
  };
}

export function sampleState(now: Date): AppState {
  const { labelRules, priorityRules } = sampleRules();
  return {
    month: monthKey(now),
    inbox: applyRules(sampleInbox(now), labelRules, priorityRules),
    tasks: sampleTasks(now),
    suggestions: sampleSuggestions(now),
    meetings: sampleMeetings(now),
    team: sampleTeam(),
    projects: ["Harbor Realty", "Apex Fitness Co", "Vendly", "Consulting", "Internal Ops", "Marketing", "Sales"],
    labelRules,
    priorityRules,
    metrics: SAMPLE_METRICS.map((m) => ({ id: m.id, parent: m.parent, name: m.name, target: m.target, unit: m.unit, sum: m.sum })),
    logs: sampleLogs(now),
    focus: sampleFocus(now),
    links: [
      { id: "l1", label: "Google Drive", url: "https://drive.google.com" },
      { id: "l2", label: "Frame.io reviews", url: "https://app.frame.io" },
      { id: "l3", label: "Stripe dashboard", url: "https://dashboard.stripe.com" },
      { id: "l4", label: "Slack", url: "https://app.slack.com" },
    ],
    outbox: [],
    jobs: defaultJobSettings(),
  };
}
