// Tags on emails, for the filter on the Emails tab: Payment, Subscription, Newsletter. Plain
// rules on the subject, the text and who sent it. No AI.
import type { EmailTag } from "./types";

export const EMAIL_TAGS: EmailTag[] = ["payment", "subscription", "newsletter"];
export const EMAIL_TAG_NAME: Record<EmailTag, string> = { payment: "Payment", subscription: "Subscription", newsletter: "Newsletter" };

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

/** Words that make an email's subject about a subscription. */
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
}

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
  if (fromPaymentService(e.senders) || PAYMENT_WORDS.test(e.subject) || (PAYMENT_WORDS.test(text) && MONEY.test(text))) tags.push("payment");
  if (SUBSCRIPTION_SUBJECT.test(e.subject) || SUBSCRIPTION_TEXT.test(text)) tags.push("subscription");
  // A receipt or a renewal sent by a tool is about money first, not a newsletter.
  if (!tags.length && (e.bulk || e.tab === "promotions" || e.tab === "social" || e.tab === "forums")) tags.push("newsletter");
  return tags;
}
