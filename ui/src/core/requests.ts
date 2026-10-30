// Spots a message that asks the owner for something. Plain rules, no AI: a question of a few
// words, or one of the phrases people use when they need an answer or an action. Small talk does
// not count. The AI check (jobs/task-check) then reads each one and keeps only real tasks.
import { addDays, daysBetween, isoDay } from "./dates";
import { plainPreview } from "./message-format";

/** Addresses are removed first, so the "?" in a link does not read as a question. */
const LINKS = /\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/\S+/g;

const ASKS = [
  /\b(can|could|would|will|did|do|are|have|were) (you|u|ya)\b/,
  /\b(please|pls|plz)\b/,
  /\bneed (you|your|u)\b/,
  /\b(let me know|lmk|get back to me|thoughts)\b/,
  /\bwaiting (on|for) (you|your)\b/,
  /\bfollow(ing)?[ -]?up\b/,
  /\b(reminder|reminding you)\b/,
  /\b(approve|approval|sign[- ]?off|confirm)\b/,
  /\bwhen you (get|have) (a|the|some) (chance|minute|moment|sec|second|time)\b/,
  /\b(asap|urgent|urgently|deadline)\b/,
];

/** Greetings, thanks and how-are-yous. Taken out before judging, so "Hey, how are you?" asks for nothing. */
const SMALL_TALK = /\b(hi|hey|hello|yo|thanks|thank you|thx|ty|ok|okay|cool|nice|great|awesome|congrats|good (morning|afternoon|evening|night)|gm|how are (you|u)( doing)?|how('?s| is) (it going|everything|your day)|what'?s up|sup|lol|haha)\b/g;
/** A question mark alone counts from this many words: "ok?" and "really? wow" ask for nothing. */
const QUESTION_WORDS = 4;

/** True when the message reads as a question or a request. Too short to judge, or only small talk, counts as no. */
export function looksLikeRequest(text: string): boolean {
  const plain = text.replace(LINKS, " ").toLowerCase().replace(SMALL_TALK, " ");
  if (plain.replace(/[^a-z0-9]/g, "").length < 6) return false;
  const words = plain.split(/\s+/).filter((w) => /[a-z0-9]/.test(w)).length;
  return ASKS.some((ask) => ask.test(plain)) || (plain.includes("?") && words >= QUESTION_WORDS);
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const NAMED_DAY = /\b(by|on|before|this|until|till|next)\s+(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs?|rsday)?|fri(?:day)?|sat(?:urday)?)\b/;
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?![a-z])\\.?";
/** "Nov 6", "November 6th", "6 Nov", "the 6th of November". */
const MONTH_DAY = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b|\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}`);
/** A date this long ago is next year's ("Jan 5" said in October); one closer is in the past, not a deadline. */
const PAST_DAYS = 60;

/**
 * The day a call or a message names for something to be done, or "" when it names none: no
 * date is made up. Plain rules: today, tomorrow, a weekday ("by Friday"), the end of the week or
 * the month, or a date with its month ("Nov 6"). `now` is when it was said.
 */
export function namedDay(text: string, now: Date): string {
  const plain = text.replace(LINKS, " ").toLowerCase();
  if (/\b(today|tonight|eod|end of (the )?day|asap|urgent|urgently|right now|this (morning|afternoon|evening))\b/.test(plain)) return isoDay(now);
  if (/\b(tomorrow|tmrw|tmr)\b/.test(plain)) return addDays(now, 1);
  const weekday = plain.match(NAMED_DAY);
  if (weekday) {
    const ahead = (WEEKDAYS.indexOf(weekday[2].slice(0, 3)) - now.getDay() + 7) % 7;
    return addDays(now, ahead === 0 && weekday[1] === "next" ? 7 : ahead);
  }
  if (/\b(eow|end of (the )?week)\b/.test(plain)) return addDays(now, (5 - now.getDay() + 7) % 7);
  if (/\b(eom|end of (the )?month)\b/.test(plain)) return isoDay(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  const dated = plain.match(MONTH_DAY);
  if (dated) {
    const month = MONTHS.indexOf((dated[1] ?? dated[4]).slice(0, 3));
    const day = Number(dated[2] ?? dated[3]);
    const on = new Date(now.getFullYear(), month, day);
    if (on.getMonth() !== month) return "";
    const today = isoDay(now);
    if (isoDay(on) >= today) return isoDay(on);
    return daysBetween(isoDay(on), today) > PAST_DAYS ? isoDay(new Date(now.getFullYear() + 1, month, day)) : "";
  }
  return "";
}

/** The request in a few words for a task title: no links, and not the owner's own tag. */
export function requestSummary(text: string, ownerTag: string, max = 70): string {
  const bare = text.replace(LINKS, " ");
  const said = plainPreview(ownerTag.length > 1 ? bare.split(ownerTag).join(" ") : bare, max);
  return said || plainPreview(text, max);
}

/** "in #sales", "in a direct message": where the request was made, for a sentence. */
export const whereAsked = (ctx: string) => (ctx.startsWith("#") ? `in ${ctx}` : `in a ${ctx.toLowerCase()}`);
