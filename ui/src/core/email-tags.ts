// Tags on emails, for the views on the Emails tab: Must respond, Payments, Newsletters. Plain
// rules on the subject, the text, who sent it and who it was to. No AI.
import type { EmailTag } from "./types";

export const EMAIL_TAGS: EmailTag[] = ["respond", "payment", "newsletter"];
/** The tag on one email. */
export const EMAIL_TAG_NAME: Record<EmailTag, string> = { respond: "Must respond", payment: "Payment", newsletter: "Newsletter" };
/** The view of all the emails with that tag. */
export const EMAIL_TAG_VIEW: Record<EmailTag, string> = { respond: "Must respond", payment: "Payments", newsletter: "Newsletters" };

/** Services whose emails are about money: card payments, banks, invoicing, payouts. Matched on the sender's domain. */
const PAYMENT_SENDERS = [
  "stripe.com", "paypal.com", "wise.com", "transferwise.com", "squareup.com", "intuit.com", "xero.com", "freshbooks.com", "bill.com",
  "gusto.com", "mercury.com", "brex.com", "ramp.com", "revolut.com", "payoneer.com", "fanbasis.com", "whop.com", "razorpay.com",
  "paddle.com", "gumroad.com", "lemonsqueezy.com", "chase.com", "wellsfargo.com", "bankofamerica.com", "americanexpress.com", "venmo.com",
];

/** Words that make an email about money. */
const PAYMENT_WORDS = /\b(invoices?|invoiced|receipts?|payments?|paid|payouts?|refund(s|ed)?|charged|billing|billed|transactions?|remittance|wire transfer|bank transfer|direct deposit|amount due|balance due|past due|overdue|purchase|order confirmation|your order)\b/i;
/** An amount of money: "$1,200.00", "€50", "300 USD". */
const MONEY = /(?:[$€£₹]\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|INR|AUD|CAD)\b)/;

/** Words that make an email's subject about a subscription, which is money too: a renewal, a trial ending. */
const SUBSCRIPTION_SUBJECT = /\b(subscriptions?|renewal|renews?|renewed|auto-?renew(al)?|trial|membership|your plan|plan (change|upgrade|downgrade)|cancel(l?ed|lation)?)\b/i;
/** The same in the text, said more fully, so a passing word does not count. */
const SUBSCRIPTION_TEXT = /\b(your (subscription|membership|plan)|subscription (will|has|is|renews|renewal|payment)|auto-?renew(s|al|ed)?|free trial|trial (ends|will end|expires|period|is ending)|renews on|will (automatically )?renew|billing cycle|recurring (payment|charge|billing))\b/i;

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
const ROLE_SENDER = /^(billing|receipts?|invoices?|invoicing|payments?|accounts?|accounting|orders?|support|help|helpdesk|care|info|news|newsletters?|updates?|notify|alerts?|security|team|hello|hi|admin|system|automated|mailer|marketing|service|feedback|calendar-notification|drive-shares-dm-noreply|comments-noreply)([+.-][^@]*)?@/i;

const domainOf = (email: string) => email.toLowerCase().split("@")[1] ?? "";
const fromPaymentService = (senders: string[]) => senders.some((s) => PAYMENT_SENDERS.some((d) => domainOf(s) === d || domainOf(s).endsWith(`.${d}`)));

/** The tags of one email thread. */
export function emailTags(e: TaggedEmail): EmailTag[] {
  const text = e.texts
    .join("\n")
    .split("\n")
    .filter((line) => !FOOTER.test(line))
    .join("\n");
  const tags: EmailTag[] = [];
  // A person wrote to the owner and is waiting: the owner has not answered since. A company's
  // address or a payment service sending to them is not a person asking.
  const latest = e.senders.at(-1) ?? "";
  if (e.direct && !e.answered && !ROLE_SENDER.test(latest) && !fromPaymentService([latest])) tags.push("respond");
  if (fromPaymentService(e.senders) || PAYMENT_WORDS.test(e.subject) || (PAYMENT_WORDS.test(text) && MONEY.test(text)) || SUBSCRIPTION_SUBJECT.test(e.subject) || SUBSCRIPTION_TEXT.test(text)) tags.push("payment");
  // A receipt or a renewal sent by a tool is about money first, not a newsletter.
  if (!tags.length && (e.bulk || e.tab === "promotions" || e.tab === "social" || e.tab === "forums")) tags.push("newsletter");
  return tags;
}
