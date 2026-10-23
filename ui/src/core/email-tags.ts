// Tags on emails, for the views on the Emails tab: Must respond, Payments and Newsletters first,
// then Invites, Notifications and Receipts for what is left that has a kind of its own. Plain rules
// on the subject, the text, who sent it and who it was to. No AI.
import type { EmailTag } from "./types";

export const EMAIL_TAGS: EmailTag[] = ["respond", "payment", "newsletter", "invite", "notification", "receipt"];
/** The tag on one email. */
export const EMAIL_TAG_NAME: Record<EmailTag, string> = { respond: "Must respond", payment: "Payment", newsletter: "Newsletter", invite: "Invite", notification: "Notification", receipt: "Receipt" };
/** The view of all the emails with that tag. */
export const EMAIL_TAG_VIEW: Record<EmailTag, string> = { respond: "Must respond", payment: "Payments", newsletter: "Newsletters", invite: "Invites", notification: "Notifications", receipt: "Receipts" };

/** Services whose emails are about money: card payments, banks, invoicing, payouts. Matched on the sender's domain. */
const PAYMENT_SENDERS = [
  "stripe.com", "paypal.com", "wise.com", "transferwise.com", "squareup.com", "intuit.com", "xero.com", "freshbooks.com", "bill.com",
  "gusto.com", "mercury.com", "brex.com", "ramp.com", "revolut.com", "payoneer.com", "fanbasis.com", "whop.com", "razorpay.com",
  "paddle.com", "gumroad.com", "lemonsqueezy.com", "chase.com", "wellsfargo.com", "bankofamerica.com", "americanexpress.com", "venmo.com",
];

/**
 * Tools whose emails tell of something that happened (a booking, a mention, a sign-in, a document
 * to sign), not mailings to read: they are neither newsletters nor people writing.
 */
const NOTIFIERS = [
  "calendly.com", "slack.com", "zoom.us", "google.com", "hellosign.com", "dropboxsign.com", "docusign.net", "docusign.com", "notion.so", "github.com",
  "atlassian.net", "atlassian.com", "linear.app", "figma.com", "loom.com", "fathom.video", "airtable.com", "clickup.com", "asana.com", "trello.com",
  "vercel.com", "supabase.com", "supabase.io", "zapier.com", "typeform.com", "canva.com", "dropbox.com", "microsoft.com", "apple.com", "skool.com",
  ...PAYMENT_SENDERS,
];

// Payments are money to act on: something to pay, a payment that failed, or a subscription or trial
// about to renew or end. Money already paid, coming back, or coming in is not.
/** Something to pay. */
const DUE = /\b(amount due|balance due|payment due|past due|overdue|due (date|on|by|today|tomorrow|now|soon)|pay now|please pay|payment request(ed)?|requested (a )?payment|awaiting (your )?payment|outstanding (balance|invoice|amount|payment)|unpaid|payment reminder|invoice reminder)\b/i;
/** A bill: in a subject, without the words of a receipt, it is one to pay. */
const BILL = /\b(invoices?|bills?)\b/i;
/** A payment that did not go through, or a card that will stop working. */
const FAILED = /\b(payment (failed|declined|unsuccessful|issue|problem)|failed payment|(card|payment method) (declined|was declined|expir\w*|has expired|is expiring)|unable to (charge|process)|could ?n[o']t (charge|process)|update your (payment|billing|card))\b/i;
/** A subscription about to renew, and charge again. */
const RENEWAL = /\b(renews? (on|in|soon|tomorrow|next)|will (automatically )?renew|auto-?renew\w*|upcoming (renewal|charge|payment)|renewal (notice|reminder|date))\b/i;
/** A subscription, plan or trial about to end, or ended. */
const ENDING = /\b(trial (ends|ending|expires|expiring|will end|is ending|is over|has ended)|(subscription|plan|membership) (expires|expiring|will expire|has expired|ends|ending|will end|has ended|is ending|(has been |was )?cancel+ed))\b/i;
/** Money already paid, coming back or coming in: a receipt, a confirmation, a refund, a payout. */
const SETTLED = /\b(receipts?|payment (received|confirmation|confirmed|successful|complete[d]?)|thanks? (you )?for your (payment|order|purchase)|has been (paid|processed|charged)|paid in full|order confirm\w*|your order|refund\w*|payouts?|you('ve| have) been paid|money (received|sent))\b/i;

const moneyToAct = (v: string) => DUE.test(v) || FAILED.test(v) || RENEWAL.test(v) || ENDING.test(v);

/** A calendar invitation and its answers: answered in the Calendar, not by email. */
const INVITATION = /^(invitation|updated invitation|invitation updated|accepted|declined|tentatively accepted|cancel+ed event|event cancel+ed|new event|event rescheduled)\b/i;

/** The lines at the foot of a mailing, which every newsletter has and which say nothing about the email. */
const FOOTER = /(unsubscribe|email preferences|manage (your )?(subscription|preferences|email)|you('re| are) receiving|you received this|update your preferences|view (it |this )?in (your )?browser|privacy policy|no longer wish)/i;

export interface TaggedEmail {
  subject: string;
  /** The text of the emails in the thread from other people, newest last. */
  texts: string[];
  /** Who wrote them, by address. */
  senders: string[];
  /** Every email from someone else in it is a mailing (a list, an unsubscribe link, a no-reply sender). */
  bulk: boolean;
  /** The Gmail tab its latest email landed in. */
  tab?: string;
  /** Its latest email was written to the owner by a person: in Primary, not a mailing, and to them, not copied. */
  direct: boolean;
  /** The owner wrote the latest email in it. */
  answered: boolean;
}

/** Addresses a company sends from, not a person: a tool's receipts, a help desk, a team inbox. */
const ROLE_SENDER = /^(billing|receipts?|invoices?|invoicing|payments?|accounts?|accounting|orders?|support|help|helpdesk|care|info|news|newsletters?|updates?|notify|notifications?|alerts?|security|team|hello|hi|admin|system|automated|mailer|marketing|service|feedback|calendar-notification|drive-shares-dm-noreply|comments-noreply|no-?reply|do-?not-?reply)([+.-][^@]*)?@/i;

/** Addresses no person writes from: a tool telling of something that happened. */
const AUTOMATED = /^(no-?reply|do-?not-?reply|notifications?|notify|alerts?|calendar-notification|drive-shares-dm-noreply|comments-noreply|mailer(-daemon)?|automated|bounces?)([+.-][^@]*)?@/i;
/** A sign-in, a code or a security warning: in a subject, from a company or an automatic address. */
const SECURITY = /\b(sign[- ]?in|log[- ]?in|login code|verification code|verify your|security (alert|notice)|new device|password (reset|changed)|one[- ]time (code|password)|two-factor|2fa)\b/i;

const domainOf = (email: string) => email.toLowerCase().split("@")[1] ?? "";
const fromAny = (senders: string[], domains: string[]) => senders.some((s) => domains.some((d) => domainOf(s) === d || domainOf(s).endsWith(`.${d}`)));

/** The tags of one email thread. */
export function emailTags(e: TaggedEmail): EmailTag[] {
  const text = e.texts
    .join("\n")
    .split("\n")
    .filter((line) => !FOOTER.test(line))
    .join("\n");
  const latest = e.senders.at(-1) ?? "";
  const invitation = INVITATION.test(e.subject.trim());
  const settled = SETTLED.test(e.subject);
  const tags: EmailTag[] = [];
  // A person wrote to the owner and is waiting: the owner has not answered since. A company's
  // address, a payment service, or a calendar invitation is not a person asking.
  if (e.direct && !e.answered && !invitation && !ROLE_SENDER.test(latest) && !fromAny([latest], PAYMENT_SENDERS)) tags.push("respond");
  // Money to act on, by the subject; or by the text, when it is not a mailing or comes from a
  // billing address or a payment service. Never a sale in Gmail's Promotions tab.
  const billingSender = ROLE_SENDER.test(latest) || fromAny(e.senders, PAYMENT_SENDERS);
  const bySubject = moneyToAct(e.subject) || (BILL.test(e.subject) && !settled);
  // A receipt that says when the plan renews next is still a receipt: only something to pay, or a
  // payment that failed, counts in a text that is otherwise about money already paid.
  const byText = !settled && (DUE.test(text) || FAILED.test(text) || ((RENEWAL.test(text) || ENDING.test(text)) && !SETTLED.test(text))) && (!e.bulk || billingSender);
  if (e.tab !== "promotions" && (bySubject || byText)) tags.push("payment");
  // A mailing to read: not a tool telling of something that happened, and not a receipt.
  const mailing = e.bulk || e.tab === "promotions" || e.tab === "social" || e.tab === "forums";
  // A receipt from a billing address is something that happened, not something to read.
  const receipt = settled || (SETTLED.test(text) && billingSender);
  if (!tags.length && mailing && !receipt && !invitation && !fromAny(e.senders, NOTIFIERS)) tags.push("newsletter");
  if (tags.length) return tags;
  // What is left that has a kind of its own: an invitation, money already settled, or a notice.
  // A person's own email is none of these, and stays in Other.
  if (invitation) return ["invite"];
  if (receipt) return ["receipt"];
  if (fromAny(e.senders, NOTIFIERS) || AUTOMATED.test(latest) || (SECURITY.test(e.subject) && (ROLE_SENDER.test(latest) || e.bulk))) return ["notification"];
  return tags;
}
