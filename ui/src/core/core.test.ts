import { describe, expect, it } from "vitest";
import { addDays, clockWithZone, dueLabel, sinceMonday, weekStart } from "./dates";
import { assignmentBlocks, assignmentText, candidates, canAssign, canAssignInChat, fitFor, taskStatus, ticketLink } from "./delegation";
import { clampInterval, describeInterval, isDue, JOBS, liveJobs, nextRunAt, waitUntil } from "./jobs";
import { looksLikeRequest, requestDue, requestSummary, whereAsked } from "./requests";
import { raisedIn, reviewWaiting, whenRaised } from "./review";
import { findChoices } from "./search";
import { checkFathomKey, checkPhone, checkSlackToken, checkTelegramCode, maskPhone, normalizePhone, SLACK_CREATE_APP_URL } from "./providers";
import { applyRules, ruleHits, ruleMatches, sortConversation } from "./rules";
import { evalMetric } from "./targets";
import type { Conversation, JobSetting, Metric, Person, ReviewItem, Rule, Task } from "./types";

const conv = (over: Partial<Conversation>): Conversation => ({
  id: "c1", source: "slack", from: "Maya Chen", ctx: "#harbor-realty-content", direct: false, tagged: false,
  text: "hi", at: 0, pri: "low", line: "agency", mode: "professional", project: "Harbor Realty", done: false, replied: false, thread: [], ...over,
});

const rule = (over: Partial<Rule>): Rule => ({ id: "r", source: "any", when: "ctx", op: "is", value: "", ...over });

describe("sorting rules", () => {
  const labelRules = [rule({ id: "l1", source: "slack", op: "starts", value: "#consulting-", line: "consulting" })];
  const priorityRules = [
    rule({ id: "p1", when: "tagged", pri: "high" }),
    rule({ id: "p2", source: "slack", value: "#harbor-realty-content", pri: "high" }),
    rule({ id: "p3", when: "direct", pri: "mid" }),
  ];

  it("matches a channel prefix whatever the punctuation or case", () => {
    expect(ruleMatches(labelRules[0], conv({ ctx: "#Consulting-Cohort-3" }))).toBe(true);
    expect(ruleMatches(labelRules[0], conv({ ctx: "#ops" }))).toBe(false);
  });

  it("only applies a rule to its own app", () => {
    expect(ruleMatches(labelRules[0], conv({ source: "telegram", ctx: "#consulting-x" }))).toBe(false);
  });

  it("never lets a text rule with an empty value match everything", () => {
    expect(ruleMatches(rule({ when: "from", op: "contains", value: "  " }), conv({}))).toBe(false);
  });

  it("uses the first matching rule and falls back to Low and Agency", () => {
    expect(sortConversation(conv({ tagged: true, direct: true }), labelRules, priorityRules)).toEqual({ mode: "professional", line: "agency", pri: "high" });
    expect(sortConversation(conv({ ctx: "Direct message", direct: true }), labelRules, priorityRules).pri).toBe("mid");
    expect(sortConversation(conv({ ctx: "#sales" }), labelRules, priorityRules)).toEqual({ mode: "professional", line: "agency", pri: "low" });
    expect(sortConversation(conv({ ctx: "#consulting-omar" }), labelRules, priorityRules).line).toBe("consulting");
  });

  it("keeps a priority that was set by hand", () => {
    const [kept, resorted] = applyRules(
      [conv({ id: "a", ctx: "#sales", pri: "high", manualPri: true }), conv({ id: "b", ctx: "#sales", pri: "high" })],
      labelRules,
      priorityRules,
    );
    expect(kept.pri).toBe("high");
    expect(resorted.pri).toBe("low");
  });

  it("files a chat under Personal when a rule says so, and keeps a side that was picked by hand", () => {
    const withMom = [rule({ id: "l0", when: "from", value: "Mom", mode: "personal" }), ...labelRules];
    expect(sortConversation(conv({ from: "Mom", ctx: "Direct message", direct: true }), withMom, priorityRules).mode).toBe("personal");
    const [kept, resorted] = applyRules([conv({ id: "a", mode: "personal", manualMode: true }), conv({ id: "b", mode: "personal" })], withMom, priorityRules);
    expect([kept.mode, resorted.mode]).toEqual(["personal", "professional"]);
  });

  it("counts each conversation against the first rule it matches", () => {
    const inbox = [conv({ id: "a", tagged: true }), conv({ id: "b" }), conv({ id: "c", ctx: "x", direct: true })];
    expect(ruleHits(priorityRules, inbox)).toEqual({ p1: 1, p2: 1, p3: 1 });
  });
});

describe("delegation", () => {
  const team: Person[] = [
    { id: "u1", name: "Luis Ramos", role: "Lead editor", depts: ["Client Sales"], handles: ["Editing", "Hooks", "Harbor Realty"] },
    { id: "u2", name: "Kai Brooks", role: "Editor", depts: ["Client Sales"], handles: ["Captions"] },
    { id: "u3", name: "Rene Park", role: "Bookkeeper", depts: ["Finances"], handles: ["Invoices"] },
  ];
  const task = (over: Partial<Task>): Task => ({
    id: "t", title: "Swap hook on Harbor clip #4", description: "", mode: "professional", dept: "Client Sales", project: "Harbor Realty", pri: "high",
    due: "2026-10-09", done: false, createdAt: 0, delegable: true, status: "open", number: 1, assignee: "user:owner", assigneeName: "Jeremy", ...over,
  });

  it("finds responsibilities named in the title or project, singular or plural", () => {
    expect(fitFor(team[0], task({}))).toEqual(["Hooks", "Harbor Realty"]);
    expect(fitFor(team[2], task({ title: "Resend Apex invoice link", project: "Apex" }))).toEqual(["Invoices"]);
  });

  it("offers the department and any matching person, best fit first", () => {
    expect(candidates(team, task({}), false).map((p) => p.name)).toEqual(["Luis Ramos", "Kai Brooks"]);
    expect(candidates(team, task({ dept: "Operations", title: "Chase unpaid invoices", project: "Internal Ops" }), false).map((p) => p.name)).toEqual(["Rene Park"]);
    expect(candidates(team, task({}), true)).toHaveLength(3);
  });

  it("lets any open work task be assigned, but not one that is owner-only, done or already assigned", () => {
    expect(canAssign(task({}))).toBe(true);
    expect(canAssign(task({ dept: "Finances", title: "Something nobody on the team list covers" }))).toBe(true);
    expect(canAssign(task({ delegable: false }))).toBe(false);
    expect(canAssign(task({ done: true }))).toBe(false);
    expect(canAssign(task({ delegatedTo: { personId: "u1", name: "Luis Ramos", role: "", note: "", at: 0 } }))).toBe(false);
  });

  it("keeps personal tasks with the owner", () => {
    expect(canAssign(task({ mode: "personal" }))).toBe(false);
  });

  it("can announce an assignment in a channel or a group message, but not in a one-to-one chat", () => {
    expect([canAssignInChat({ ctx: "#sales" }), canAssignInChat({ ctx: "Group message" }), canAssignInChat({ ctx: "Direct message" }), canAssignInChat({ ctx: "App notification" })]).toEqual([true, true, false, false]);
    // A Telegram group is not a place for a Slack assignment, even one whose name starts with #.
    expect(canAssignInChat({ ctx: "#launch", source: "telegram" })).toBe(false);
  });

  it("tags the person, in a direct message too, so Slack notifies them; with no tag a direct message just says it is theirs", () => {
    const about = { title: "Swap the hook", due: "2026-10-12" };
    expect(assignmentText({ ...about, where: "dm", who: "<@ULUIS>", note: "" })).toBe("<@ULUIS> new task for you: Swap the hook\nDue Mon, Oct 12");
    expect(assignmentText({ ...about, where: "dm", who: "", note: "" })).toBe("New task for you: Swap the hook\nDue Mon, Oct 12");
    expect(assignmentText({ ...about, where: "chat", who: "<@ULUIS>", note: "Use the new one." })).toBe("<@ULUIS> new task for you: Swap the hook\nDue Mon, Oct 12\n\nUse the new one.");
  });

  it("says what the task is, when it is due, how much it matters and what it belongs to, then the note", () => {
    const whole = { where: "dm" as const, who: "", title: "Book the venue", due: "2026-10-16", pri: "high" as const, project: "Launch", note: "Ask me if the price moves." };
    expect(assignmentText(whole)).toBe("New task for you: Book the venue\nDue Fri, Oct 16 · High priority · Launch\n\nAsk me if the price moves.");
    // What is not there is left out, with no empty lines in its place.
    expect(assignmentText({ ...whole, note: "", project: "" })).toBe("New task for you: Book the venue\nDue Fri, Oct 16 · High priority");
    expect(assignmentText({ ...whole, pri: "mid", note: "Before Friday." })).toBe("New task for you: Book the venue\nDue Fri, Oct 16 · Medium priority · Launch\n\nBefore Friday.");
  });

  it("lays the message out for Slack: the tag, the task in bold with its note, and one line of facts", () => {
    const blocks = assignmentBlocks({ tag: "<@ULUIS>", title: "Fix <the> hook & clip", ticket: "SPM-23", due: "2026-10-27", note: "Use the one in <Drive>.", pri: "low", project: "Harbor Realty", link: "https://example.com/tasks?task=SPM-23" });
    expect(blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "<@ULUIS> *New task for you*" } },
      // What could read as Slack's own markup is written out.
      { type: "section", text: { type: "mrkdwn", text: "*Fix &lt;the&gt; hook &amp; clip*\nUse the one in &lt;Drive&gt;." } },
      { type: "context", elements: [{ type: "mrkdwn", text: "*SPM-23*  ·  Due *Tue, Oct 27*  ·  Low priority  ·  Harbor Realty  ·  <https://example.com/tasks?task=SPM-23|Open in Command Center>" }] },
    ]);
    // Nothing to say is left out; with nobody tagged it is simply a new task.
    expect(assignmentBlocks({ tag: "", title: "Book the venue", due: "2026-10-27", note: "" }).map((b) => (b.type === "section" ? b.text.text : b.elements[0].text))).toEqual(["*New task*", "*Book the venue*", "Due *Tue, Oct 27*"]);
  });

  it("links to a ticket on the live site's board, and nowhere when the site's address is not known", () => {
    const saved = { site: process.env.SITE_URL, vercel: process.env.VERCEL_PROJECT_PRODUCTION_URL };
    try {
      delete process.env.SITE_URL;
      delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
      expect(ticketLink("SPM-23")).toBeUndefined();
      process.env.VERCEL_PROJECT_PRODUCTION_URL = "spm-command-center.vercel.app";
      expect(ticketLink("SPM-23")).toBe("https://spm-command-center.vercel.app/tasks?task=SPM-23");
      process.env.SITE_URL = "http://127.0.0.1:3100/";
      expect([ticketLink("SPM-23"), ticketLink("")]).toEqual(["http://127.0.0.1:3100/tasks?task=SPM-23", undefined]);
    } finally {
      for (const [key, value] of [["SITE_URL", saved.site], ["VERCEL_PROJECT_PRODUCTION_URL", saved.vercel]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("addresses the channel as a whole when nobody is tagged", () => {
    expect(assignmentText({ where: "channel:C9", who: "", title: "Swap the hook", due: "2026-10-12", note: "" })).toBe("New task: Swap the hook\nDue Mon, Oct 12");
    expect(assignmentText({ where: "channel:C9", who: "@Luis Ramos", title: "Swap the hook", due: "2026-10-12", note: "" })).toBe("@Luis Ramos new task for you: Swap the hook\nDue Mon, Oct 12");
  });

  it("marks a task overdue only before its due day", () => {
    expect(taskStatus(task({ due: "2026-10-08" }), "2026-10-08")).toBe("ontrack");
    expect(taskStatus(task({ due: "2026-10-07" }), "2026-10-08")).toBe("overdue");
    expect(taskStatus(task({ due: "2026-10-07", done: true }), "2026-10-08")).toBe("done");
  });
});

describe("requests in messages", () => {
  it("spots a question or an ask, and ignores chatter, pings and links", () => {
    expect(looksLikeRequest("Are you joining the call tomorrow?")).toBe(true);
    expect(looksLikeRequest("when you get a chance could you please send Dana the contract")).toBe(true);
    expect(looksLikeRequest("lmk what you think")).toBe(true);
    expect(looksLikeRequest("Following up on the contract")).toBe(true);
    expect(looksLikeRequest("Hey @Jeremy Moser")).toBe(false);
    expect(looksLikeRequest("Booked 2 more discovery calls for tomorrow.")).toBe(false);
    expect(looksLikeRequest("here it is https://docs.google.com/spreadsheets/d/abc/edit?gid=42")).toBe(false);
    expect(looksLikeRequest("ok?")).toBe(false);
    // Small talk and one-word questions ask for nothing; a real question of a few words does.
    expect(looksLikeRequest("Hey, how are you?")).toBe(false);
    expect(looksLikeRequest("Thanks so much!")).toBe(false);
    expect(looksLikeRequest("Good morning! How's it going?")).toBe(false);
    expect(looksLikeRequest("really? wow")).toBe(false);
    expect(looksLikeRequest("Is the deck ready yet?")).toBe(true);
    expect(looksLikeRequest("Hey, can you send me the deck?")).toBe(true);
  });

  it("takes the due day from the message, and says tomorrow when it names none", () => {
    const thursday = new Date("2026-10-08T12:00:00");
    expect(requestDue("need this asap", thursday)).toBe("2026-10-08");
    expect(requestDue("can we talk tomorrow", thursday)).toBe("2026-10-09");
    expect(requestDue("Can we swap the hook before Friday?", thursday)).toBe("2026-10-09");
    expect(requestDue("by monday please", thursday)).toBe("2026-10-12");
    expect(requestDue("thoughts on this", thursday)).toBe("2026-10-09");
  });

  it("sums the request up without links or the owner's own tag", () => {
    expect(requestSummary("https://docs.google.com/spreadsheets/d/abc/edit?gid=42 @Jeremy Moser when you get a chance could you please send Dana the contract", "@Jeremy Moser")).toBe("when you get a chance could you please send Dana the contract");
    expect(requestSummary("@Jeremy Moser https://a.co/x", "@Jeremy Moser")).toBe("@Jeremy Moser a.co/x");
    expect(requestSummary("word ".repeat(40), "@Jeremy Moser", 20)).toBe("word word word word…");
  });

  it("says where the request was made", () => {
    expect([whereAsked("#sales"), whereAsked("Direct message"), whereAsked("Group message")]).toEqual(["in #sales", "in a direct message", "in a group message"]);
  });
});

describe("type-to-find pick lists", () => {
  const channels = ["#acme-corp-sales-metrics", "#sales", "#02-team-sales", "#ops-team", "#Sales-Pipeline"].map((label, k) => ({ value: `C${k}`, label }));
  const found = (typed: string) => findChoices(channels, typed).map((c) => c.label);

  it("shows everything until something is typed", () => {
    expect(found("")).toHaveLength(5);
    expect(found("  ")).toHaveLength(5);
  });

  it("finds a name by any of its words, in any order, whatever the case or punctuation", () => {
    expect(found("acme sales")).toEqual(["#acme-corp-sales-metrics"]);
    expect(found("SALES acme")).toEqual(["#acme-corp-sales-metrics"]);
    expect(found("#ops")).toEqual(["#ops-team"]);
    expect(found("zzz")).toEqual([]);
  });

  it("puts the names that start with what was typed first", () => {
    expect(found("sales")).toEqual(["#sales", "#Sales-Pipeline", "#acme-corp-sales-metrics", "#02-team-sales"]);
  });
});

describe("timers", () => {
  const setting = (over: Partial<JobSetting> = {}): JobSetting => ({ id: "slack-pull", intervalMin: 60, enabled: true, ...over });
  const HOUR = 3_600_000;

  it("defines every job once, with a default no faster than its floor", () => {
    expect(new Set(JOBS.map((j) => j.id)).size).toBe(JOBS.length);
    for (const job of JOBS) expect(job.defaultMin).toBeGreaterThanOrEqual(job.minMin);
    expect(JOBS.filter((j) => j.usesAI).map((j) => j.id)).toEqual(["task-check", "task-suggest"]);
  });

  it("leaves out the checks that cannot work yet", () => {
    expect(JOBS.filter((j) => !j.live).map((j) => j.id)).toEqual(["telegram-pull", "gmail-pull", "calendar-pull", "task-suggest"]);
    expect(liveJobs(false).map((j) => j.id)).toEqual(["slack-pull", "fathom-pull", "inbox-rules", "request-finder", "task-check", "slack-directory-sync", "outbox-retry"]);
    // Where Telegram can be used, its check joins them; the AI that finds tasks of its own stays off.
    expect(liveJobs(true).map((j) => j.id)).toEqual(["slack-pull", "telegram-pull", "fathom-pull", "inbox-rules", "request-finder", "task-check", "slack-directory-sync", "outbox-retry"]);
    // The same for Google's two checks.
    expect(liveJobs(false, true).map((j) => j.id)).toEqual(["slack-pull", "fathom-pull", "gmail-pull", "calendar-pull", "inbox-rules", "request-finder", "task-check", "slack-directory-sync", "outbox-retry"]);
  });

  it("keeps a timer at or above the fastest allowed", () => {
    expect(clampInterval("slack-pull", 1)).toBe(5);
    expect(clampInterval("telegram-pull", 10)).toBe(30);
    expect(clampInterval("fathom-pull", 90)).toBe(90);
    expect(clampInterval("slack-pull", Number.NaN)).toBe(60);
  });

  it("runs a job that has never run, then waits out the timer", () => {
    expect(isDue(setting(), null, 1000)).toBe(true);
    expect(isDue(setting(), 1000, 1000 + HOUR - 1)).toBe(false);
    expect(isDue(setting(), 1000, 1000 + HOUR)).toBe(true);
  });

  it("never runs a job that is switched off", () => {
    expect(nextRunAt(setting({ enabled: false }), null)).toBeNull();
    expect(isDue(setting({ enabled: false }), null, 10 * HOUR)).toBe(false);
  });

  it("holds a job back while a service asks it to wait", () => {
    const now = 5 * HOUR;
    const notBefore = waitUntil(now, 120);
    expect(notBefore).toBe(now + 120_000);
    expect(isDue(setting(), 0, now, notBefore)).toBe(false);
    expect(isDue(setting(), 0, notBefore, notBefore)).toBe(true);
  });

  it("describes timers in plain words", () => {
    expect([1, 30, 60, 120, 1440].map(describeInterval)).toEqual(["Every minute", "Every 30 minutes", "Every hour", "Every 2 hours", "Once a day"]);
  });
});

describe("targets", () => {
  const metrics: Metric[] = [
    { id: "calls", name: "Calls Booked", target: 60, unit: "n" },
    { id: "content", name: "Content Output", target: 120, unit: "n", sum: true },
    { id: "a", parent: "content", name: "A", target: 60, unit: "n" },
    { id: "b", parent: "content", name: "B", target: 60, unit: "n" },
  ];
  const clock = { day: 11, dim: 30 };
  const tenDays = (perDay: number) => Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, perDay]));

  it("is on track when the daily rate reaches the target by month end", () => {
    const e = evalMetric(metrics[0], metrics, { calls: tenDays(2) }, clock);
    expect(e).toMatchObject({ actual: 20, expected: 20, projected: 60, status: "ok", elapsed: 10, remaining: 20, perDayNeeded: 2 });
  });

  it("is at risk within 10% of the target and behind below that", () => {
    expect(evalMetric(metrics[0], metrics, { calls: tenDays(1.9) }, clock).status).toBe("risk");
    expect(evalMetric(metrics[0], metrics, { calls: tenDays(1) }, clock).status).toBe("behind");
  });

  it("counts today only once today's numbers are logged", () => {
    const logs = { calls: { ...tenDays(2), 11: 2 } };
    expect(evalMetric(metrics[0], metrics, logs, clock)).toMatchObject({ elapsed: 11, actual: 22 });
  });

  it("adds up the parts of a sum target", () => {
    const e = evalMetric(metrics[1], metrics, { a: tenDays(2), b: tenDays(1) }, clock);
    expect(e.actual).toBe(30);
    expect(e.series[e.series.length - 1]).toBe(30);
  });
});

describe("dates", () => {
  it("shows a time with its timezone named, in whichever timezone it is asked for", () => {
    const winter = Date.parse("2026-01-15T20:00:00Z");
    const summer = Date.parse("2026-07-15T19:00:00Z");
    expect([clockWithZone(winter, "America/New_York"), clockWithZone(summer, "America/New_York")]).toEqual(["3:00 PM EST", "3:00 PM EDT"]);
    expect([clockWithZone(winter, "America/Los_Angeles"), clockWithZone(winter, "UTC")]).toEqual(["12:00 PM PST", "8:00 PM UTC"]);
    expect(clockWithZone(winter, "Asia/Kolkata")).toBe("1:30 AM GMT+5:30");
  });

  const now = new Date(2026, 9, 8, 15, 30); // Thursday 8 October 2026

  it("moves by whole calendar days", () => {
    expect(addDays(now, 0)).toBe("2026-10-08");
    expect(addDays(now, -8)).toBe("2026-09-30");
    expect(weekStart(now)).toBe("2026-10-05");
    // The Review tab's week: from Monday at midnight, where the page is looked at.
    expect(new Date(sinceMonday(now)).toString()).toBe(new Date(2026, 9, 5).toString());
  });

  it("shows on the Review tab what was raised since it started, and sorts it into today, this week, last week and earlier", () => {
    const item = (day: string, hour = 9) => ({ raisedAt: new Date(`${day}T${String(hour).padStart(2, "0")}:00`).getTime() }) as ReviewItem;
    // Before the start: kept, never shown. From the start on: shown, this week and every week after.
    expect(reviewWaiting([item("2026-10-18", 23), item("2026-10-19", 0), item("2026-10-24")]).length).toBe(2);
    const monday = new Date("2026-11-02T10:00");
    expect(["2026-11-02", "2026-11-01", "2026-10-26", "2026-10-25", "2026-10-19"].map((d) => whenRaised(item(d).raisedAt, monday))).toEqual(["today", "last_week", "last_week", "earlier", "earlier"]);
    // This week takes in today.
    expect(raisedIn(item("2026-11-02").raisedAt, "this_week", monday)).toBe(true);
    expect(raisedIn(item("2026-11-01").raisedAt, "this_week", monday)).toBe(false);
    expect(raisedIn(item("2026-10-19").raisedAt, "all", monday)).toBe(true);
  });

  it("labels a due date relative to today", () => {
    const today = "2026-10-08";
    expect(dueLabel("2026-10-08", today)).toEqual({ text: "Today", tone: "today" });
    expect(dueLabel("2026-10-09", today)).toEqual({ text: "Tomorrow", tone: "" });
    expect(dueLabel("2026-10-06", today)).toEqual({ text: "2d overdue", tone: "over" });
    expect(dueLabel("2026-10-12", today).text).toBe("Mon");
    expect(dueLabel("2026-10-20", today).text).toBe("Oct 20");
  });
});

describe("connection forms", () => {
  it("accepts only a Slack user token", () => {
    expect(checkSlackToken("xoxp-1234567890-abcdefghij")).toBeNull();
    expect(checkSlackToken("  ")).toMatch(/Paste the token/);
    expect(checkSlackToken("xoxb-1234567890-abcdefghij")).toMatch(/bot token/);
    expect(checkSlackToken("1234567890-abcdefghij")).toMatch(/starts with xoxp-/);
    expect(checkSlackToken("xoxp-123")).toMatch(/cut off/);
  });

  it("rejects an empty or cut-off Fathom key", () => {
    expect(checkFathomKey("a1b2c3d4e5f6g7h8")).toBeNull();
    expect(checkFathomKey("")).toMatch(/Paste the API key/);
    expect(checkFathomKey("abc 123 def 456")).toMatch(/cut off/);
  });

  it("reads a phone number with its country code, however it is spaced", () => {
    expect(normalizePhone("+44 7700 900123")).toBe("+447700900123");
    expect(normalizePhone("+1 (415) 555-0100")).toBe("+14155550100");
    expect(checkPhone("07700 900123")).toMatch(/country code/);
    expect(checkPhone("+44 7700 900123")).toBeNull();
  });

  it("masks a phone number so it can be recognised but not copied", () => {
    expect(maskPhone("+44 7700 900123")).toBe("+44 •••• 0123");
    expect(maskPhone("not a number")).toBe("");
  });

  it("takes a Telegram code of 5 digits, or the 6 it sends by email", () => {
    expect([checkTelegramCode(" 12345 "), checkTelegramCode("123456")]).toEqual([null, null]);
    expect(checkTelegramCode("1234")).toMatch(/5 or 6 digits/);
    expect(checkTelegramCode("1234567")).toMatch(/5 or 6 digits/);
    expect(checkTelegramCode("12a45")).toMatch(/5 or 6 digits/);
  });

  it("builds a Slack link that carries the whole manifest", () => {
    const manifest = decodeURIComponent(SLACK_CREATE_APP_URL.split("manifest_yaml=")[1]);
    expect(SLACK_CREATE_APP_URL.startsWith("https://api.slack.com/apps?new_app=1&manifest_yaml=")).toBe(true);
    expect(manifest).toContain("name: SPM Command Center");
    for (const scope of ["im:history", "chat:write", "im:write", "search:read"]) expect(manifest).toContain(`- ${scope}`);
    expect(manifest).not.toContain("bot");
  });
});
