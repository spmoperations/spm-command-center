// Reading an email as Gmail hands it over: who wrote it, to whom, the subject, and the text
// of the message without the quoted history underneath. Showing it formatted, as a safe page
// of its own. And writing one out to send. Plain logic, no network.
import { tidyEmailText } from "@/core/email-text";

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
  /** Its Message-ID and References headers, which a reply carries to stay in the same thread. */
  messageId: string;
  references: string;
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
  let text = tidyEmailText(withoutQuoted(bodyText(p))) || (message.snippet ?? "").trim();
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
    messageId: header(p, "Message-ID").trim(),
    references: header(p, "References").trim(),
  };
}

// ---------- Showing one formatted ----------

/** The HTML of a message, as its sender laid it out. Null when it only has plain text. */
export function htmlOf(payload: GmailPart | undefined): string | null {
  const html = find(payload, "text/html");
  if (html?.body?.data) return decode(html.body.data);
  if (payload?.mimeType === "text/html" && payload.body?.data) return decode(payload.body.data);
  return null;
}

const escapeHtml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * What an email's own HTML may not keep, even though the page it is shown in can run nothing:
 * scripts, frames, forms, plugins, refreshes and base addresses, "on…" handlers, and
 * javascript: links. The page is also served under a policy that forbids all of these.
 */
function stripActive(html: string): string {
  return html
    .replace(/<(script|iframe|frameset|object|embed|applet|form|noscript)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|iframe|frame|object|embed|applet|form|input|button|textarea|select|base|link|meta)\b[^>]*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src|action|formaction|xlink:href)\s*=\s*(["']?)\s*(javascript|vbscript|data:text\/html)[^"'>\s]*\2/gi, '$1="#"');
}

/** Hides the quoted history under a reply, as Gmail does: the earlier messages are in the thread already. */
const QUOTES = ".gmail_quote, blockquote[type=cite], #divRplyFwdMsg, #divRplyFwdMsg ~ *, .yahoo_quoted, #appendonsend ~ * { display: none !important; }";

/**
 * An email's styles for a dark screen, switched off, and its styles for a light one always on.
 * The email is drawn on white, as Gmail draws it, and a computer set to dark would otherwise
 * switch on the sender's dark styles inside the frame and turn the text pale on that white.
 * The conditions put in are always false and always true, so "screen and …" and "not …" still work.
 */
export const lightOnly = (html: string) => html.replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, "(max-width: 0px)").replace(/\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi, "(min-width: 0px)");

/**
 * A whole page showing one email: its own HTML when it has some, made safe, or else its text with
 * the links made clickable. Links open in a new tab. It is drawn on white, as senders design for.
 */
export function emailPage(message: GmailMessage): string {
  const html = htmlOf(message.payload);
  const body = html
    ? lightOnly(stripActive(html))
    : `<pre class="cc-plain">${escapeHtml(bodyText(message.payload) || message.snippet || "").replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1">$1</a>')}</pre>`;
  // The page has no height of its own, so the dashboard can read the email's height from it and
  // make the frame exactly that tall. It never scrolls up and down: the frame shows all of it.
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank"><style>
html { background: #fff; overflow-y: hidden; }
html, body { height: auto !important; min-height: 0 !important; color-scheme: only light !important; }
body { margin: 0; padding: 14px 16px; color: #202124; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; overflow-wrap: anywhere; }
img { max-width: 100%; height: auto; }
table { max-width: 100%; }
.cc-plain { white-space: pre-wrap; font: inherit; margin: 0; }
${QUOTES}
</style>`;
  // Laid out the way Gmail lays out every email, whatever its own first line says: an email with
  // no doctype would otherwise be drawn the old way, with its body as tall as the frame.
  const page = body.replace(/<!doctype[^>]*>/gi, "");
  // The dashboard's settings go first in the head, whether the email brought one or not.
  if (/<head[^>]*>/i.test(page)) return `<!doctype html>${page.replace(/<head[^>]*>/i, (h) => `${h}${head}`)}`;
  if (/<html[^>]*>/i.test(page)) return `<!doctype html>${page.replace(/<html[^>]*>/i, (h) => `${h}<head>${head}</head>`)}`;
  return `<!doctype html><html><head>${head}</head><body>${page}</body></html>`;
}

// ---------- Writing one ----------

/** An address someone typed, such as "dana@example.com". */
export const isEmailAddress = (v: string) => /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(v.trim());

/** An email to send, before it is written out. */
export interface Outgoing {
  to: Address[];
  cc: Address[];
  subject: string;
  body: string;
  /** For a reply: the Message-ID of the email answered, and the thread's References. */
  inReplyTo?: string;
  references?: string;
}

/** A header value on one line: nothing typed can start a header of its own. */
const oneLine = (v: string) => v.replace(/[\r\n]+/g, " ").trim();
const plain = (v: string) => /^[\x20-\x7e]*$/.test(v);
/** Text with letters outside plain ASCII, written the way mail headers allow (RFC 2047). */
const headerText = (v: string) => (plain(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`);

function formatAddress(a: Address): string {
  const email = oneLine(a.email);
  const name = oneLine(a.name ?? "");
  if (!name || name.toLowerCase() === email.toLowerCase()) return email;
  return `${plain(name) ? `"${name.replace(/["\\]/g, "\\$&")}"` : headerText(name)} <${email}>`;
}

/**
 * The email written out as Gmail's API takes it: the whole message, base64url encoded. Plain
 * text in UTF-8. There is no From: Gmail sends it from the account, under its own name.
 */
export function rawEmail(m: Outgoing): string {
  const lines = [
    `To: ${m.to.map(formatAddress).join(", ")}`,
    ...(m.cc.length ? [`Cc: ${m.cc.map(formatAddress).join(", ")}`] : []),
    `Subject: ${headerText(oneLine(m.subject))}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${oneLine(m.inReplyTo)}`] : []),
    ...(m.references ? [`References: ${oneLine(m.references)}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(m.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}
