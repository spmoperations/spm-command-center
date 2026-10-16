// Reading an email as Gmail hands it over: who wrote it, to whom, the subject, and the text
// of the message without the quoted history underneath. Plain logic, no network.

/** One part of a message, as the Gmail API returns it with format=full. Parts nest. */
export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  /** Epoch milliseconds, as text. */
  internalDate?: string;
  payload?: GmailPart;
}

export interface GmailThread {
  id: string;
  /** Changes whenever anything in the thread changes. */
  historyId?: string;
  messages?: GmailMessage[];
}

export interface Address {
  name: string;
  email: string;
}

/** An email, ready to be stored as one message of an inbox row. */
export interface Email {
  id: string;
  threadId: string;
  at: number;
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  text: string;
  /** Written by the connected account. */
  me: boolean;
  unread: boolean;
  /** A newsletter or automatic mail rather than a person writing: it has an unsubscribe link, comes from a mailing list, or from a no-reply address. */
  bulk: boolean;
  /** The Gmail tab it landed in. "primary" when Gmail sorted it there, or does not sort into tabs. */
  tab: "primary" | "promotions" | "social" | "updates" | "forums";
}

const TABS: [string, Email["tab"]][] = [["CATEGORY_PROMOTIONS", "promotions"], ["CATEGORY_SOCIAL", "social"], ["CATEGORY_UPDATES", "updates"], ["CATEGORY_FORUMS", "forums"]];

/** Longest text kept for one email. The rest is in Gmail. */
const MAX_TEXT = 4000;

export function header(part: GmailPart | undefined, name: string): string {
  const wanted = name.toLowerCase();
  return part?.headers?.find((h) => h.name.toLowerCase() === wanted)?.value ?? "";
}

/** `"Dana Whitfield" <dana@example.com>` becomes { name: "Dana Whitfield", email: "dana@example.com" }. */
export function parseAddress(raw: string): Address {
  const v = raw.trim();
  const angled = /^(.*?)<([^<>]+)>\s*$/.exec(v);
  if (angled) {
    const email = angled[2].trim().toLowerCase();
    const name = angled[1].trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"').trim();
    return { name: name || email, email };
  }
  const email = v.replace(/^"|"$/g, "").toLowerCase();
  return { name: email, email };
}

/** A To or Cc header: addresses split on the commas between them, not those inside a quoted name. */
export function parseAddresses(raw: string): Address[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const ch of raw) {
    if (ch === '"' && !angled) quoted = !quoted;
    else if (ch === "<" && !quoted) angled = true;
    else if (ch === ">" && !quoted) angled = false;
    if (ch === "," && !quoted && !angled) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean).map(parseAddress).filter((a) => a.email.includes("@"));
}

const decode = (data: string) => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", bull: "•", zwnj: "", zwj: "" };

/** The words of an HTML email, with paragraphs and line breaks kept as new lines. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/(p|div|tr|h[1-6]|blockquote|table|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
      if (name[0] === "#") {
        const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/[ \t ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The first part of this type that is the message itself and not an attached file. */
function find(part: GmailPart | undefined, type: string): GmailPart | undefined {
  if (!part) return undefined;
  if (part.mimeType === type && !part.filename && part.body?.data) return part;
  for (const inner of part.parts ?? []) {
    const found = find(inner, type);
    if (found) return found;
  }
  return undefined;
}

/** The names of the files attached to the message. */
export function attachmentNames(part: GmailPart | undefined): string[] {
  if (!part) return [];
  const own = part.filename && (part.body?.attachmentId || part.body?.size) ? [part.filename] : [];
  return [...own, ...(part.parts ?? []).flatMap(attachmentNames)];
}

/**
 * The new part of a reply: what comes before "On Monday, Dana wrote:", an Outlook "From: …"
 * block, or the lines quoted with ">".
 */
export function withoutQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const next = (lines[i + 1] ?? "").trim();
    // "On <date>, <name> wrote:" is sometimes broken over two lines.
    if (/^On .+wrote:$/.test(line) || (/^On .+/.test(line) && /wrote:$/.test(next) && line.length < 200)) { end = i; break; }
    // A forwarded email is kept whole: what was forwarded is the point of it.
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line)) { end = i; break; }
    if (/^_{10,}$/.test(line)) { end = i; break; }
    if (/^From: .+/.test(line) && lines.slice(i + 1, i + 4).some((l) => /^(Sent|Date): /.test(l.trim()))) { end = i; break; }
  }
  const kept = lines.slice(0, end);
  while (kept.length && (kept[kept.length - 1].trim() === "" || kept[kept.length - 1].trimStart().startsWith(">"))) kept.pop();
  return kept.join("\n").trim();
}

/** The readable text of a message: the plain version when it has one, otherwise its HTML as text. */
export function bodyText(payload: GmailPart | undefined): string {
  const plain = find(payload, "text/plain");
  if (plain?.body?.data) return decode(plain.body.data);
  const html = find(payload, "text/html");
  if (html?.body?.data) return htmlToText(decode(html.body.data));
  // A message that is only one part keeps its text in the payload itself.
  if (payload?.body?.data && (payload.mimeType ?? "").startsWith("text/")) {
    const raw = decode(payload.body.data);
    return payload.mimeType === "text/html" ? htmlToText(raw) : raw;
  }
  return "";
}

const AUTOMATIC_SENDER = /^(no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster|bounce[s]?)([+.-][^@]*)?@/i;

/** Sent to many by a tool, not written to the owner by a person. */
export function isBulk(part: GmailPart | undefined, from: Address): boolean {
  return Boolean(header(part, "List-Unsubscribe") || header(part, "List-Id")) || /^(bulk|list|junk)$/i.test(header(part, "Precedence").trim()) || AUTOMATIC_SENDER.test(from.email);
}

/** Reads one Gmail message for the inbox. `ownerEmail` is the connected account's address. */
export function readEmail(message: GmailMessage, ownerEmail: string): Email {
  const p = message.payload;
  const from = parseAddress(header(p, "From") || "unknown");
  const labels = message.labelIds ?? [];
  let text = withoutQuoted(bodyText(p)) || (message.snippet ?? "").trim();
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT).trimEnd()}…`;
  const files = attachmentNames(p);
  if (files.length) text = `${text}${text ? "\n\n" : ""}(attached: ${files.join(", ")})`;
  return {
    id: message.id,
    threadId: message.threadId,
    at: Number(message.internalDate ?? 0),
    from,
    to: parseAddresses(header(p, "To")),
    cc: parseAddresses(header(p, "Cc")),
    subject: header(p, "Subject").trim(),
    text: text || "(no text)",
    me: labels.includes("SENT") || from.email === ownerEmail.toLowerCase(),
    unread: labels.includes("UNREAD"),
    bulk: isBulk(p, from),
    tab: TABS.find(([label]) => labels.includes(label))?.[1] ?? "primary",
  };
}
