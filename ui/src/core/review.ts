// The Review tab's dates: where it starts, and its filter by when something was raised. Plain
// logic, worked out in the timezone of whoever is looking.
import { REVIEW_FROM } from "./config";
import { addDays, parseDay, sinceMonday } from "./dates";
import type { ReviewItem } from "./types";

/** What the Review tab shows: everything raised since `REVIEW_FROM`. Older suggestions are kept, not shown. */
export const reviewWaiting = (review: ReviewItem[]) => review.filter((g) => g.raisedAt >= parseDay(REVIEW_FROM).getTime());

/** The Review tab's date filter. */
export type ReviewWhen = "all" | "today" | "this_week" | "last_week" | "earlier";
export const REVIEW_WHEN_NAME: Record<ReviewWhen, string> = { all: "All", today: "Today", this_week: "This week", last_week: "Last week", earlier: "Earlier" };

/** Which part of the date filter a suggestion raised at `at` falls in, where the page is looked at. */
export function whenRaised(at: number, now: Date): Exclude<ReviewWhen, "all"> {
  const monday = sinceMonday(now);
  if (at >= parseDay(addDays(now, 0)).getTime()) return "today";
  if (at >= monday) return "this_week";
  return at >= parseDay(addDays(new Date(monday), -7)).getTime() ? "last_week" : "earlier";
}

/** Whether `at` is in `when`. Today is part of this week too. */
export function raisedIn(at: number, when: ReviewWhen, now: Date): boolean {
  if (when === "all") return true;
  const part = whenRaised(at, now);
  return part === when || (when === "this_week" && part === "today");
}
