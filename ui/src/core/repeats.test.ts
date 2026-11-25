// When a repeating task is made: its days, at 6:00 Central European time, summer and winter, once a day.
import { describe, expect, it } from "vitest";
import { cleanDays, dayAfter, daysName, heldBackTo, inRepeatZone, nextRepeatDay, repeatIsDue, repeatsLabel } from "./repeats";

// Monday 12 Oct 2026 is summer time in Berlin (UTC+2); Monday 16 Nov is winter time (UTC+1).
const at = (iso: string) => new Date(iso);

describe("repeating tasks: when", () => {
  it("reads the day, weekday and time in Central European time, summer and winter", () => {
    expect(inRepeatZone(at("2026-10-12T04:00:00Z"))).toEqual({ day: "2026-10-12", weekday: 1, minutes: 360 });
    expect(inRepeatZone(at("2026-11-16T05:00:00Z"))).toEqual({ day: "2026-11-16", weekday: 1, minutes: 360 });
    // Late on Sunday in UTC is already Monday in Berlin.
    expect(inRepeatZone(at("2026-11-15T23:30:00Z"))).toEqual({ day: "2026-11-16", weekday: 1, minutes: 30 });
    expect(inRepeatZone(at("2026-11-15T22:59:00Z")).weekday).toBe(7);
  });

  it("names the days and keeps only real ones", () => {
    expect(daysName([4, 1])).toBe("Mon and Thu");
    expect(daysName([1, 3, 5])).toBe("Mon, Wed and Fri");
    expect(daysName([1, 2, 3, 4, 5])).toBe("weekdays");
    expect(daysName([1, 2, 3, 4, 5, 6, 7])).toBe("every day");
    expect(daysName([2])).toBe("Tue");
    expect(cleanDays([4, "1", 4, 0, 8, "x"])).toEqual([1, 4]);
    expect(cleanDays("Mon")).toEqual([]);
    expect(dayAfter("2026-12-31", 1)).toBe("2027-01-01");
    expect(repeatsLabel([1, 4])).toBe("Repeats every Mon and Thu");
    expect(repeatsLabel([1, 2, 3, 4, 5])).toBe("Repeats on weekdays");
    expect(repeatsLabel([1, 2, 3, 4, 5, 6, 7])).toBe("Repeats every day");
  });

  it("is due on its days from 6:00 CET, once a day", () => {
    const r = { days: [1, 4], lastDay: null, active: true };
    expect(repeatIsDue(r, at("2026-11-16T04:59:00Z"))).toEqual({ due: false, day: "2026-11-16" });
    expect(repeatIsDue(r, at("2026-11-16T05:00:00Z"))).toEqual({ due: true, day: "2026-11-16" });
    // Summer time: 6:00 in Berlin is 4:00 UTC.
    expect(repeatIsDue(r, at("2026-10-12T04:00:00Z")).due).toBe(true);
    expect(repeatIsDue(r, at("2026-10-12T03:59:00Z")).due).toBe(false);
    // Made already today; not one of its days; paused.
    expect(repeatIsDue({ ...r, lastDay: "2026-11-16" }, at("2026-11-16T09:00:00Z")).due).toBe(false);
    expect(repeatIsDue(r, at("2026-11-17T09:00:00Z")).due).toBe(false);
    expect(repeatIsDue({ ...r, active: false }, at("2026-11-16T09:00:00Z")).due).toBe(false);
    // A scheduler that was down at 6:00 still makes it later that day.
    expect(repeatIsDue({ ...r, lastDay: "2026-11-12" }, at("2026-11-16T15:00:00Z")).due).toBe(true);
  });

  it("starts from the next 6:00 when set up after 6:00, and today when before", () => {
    expect(heldBackTo(null, at("2026-11-16T09:00:00Z"))).toBe("2026-11-16");
    expect(heldBackTo(null, at("2026-11-16T04:00:00Z"))).toBeNull();
    expect(heldBackTo("2026-11-12", at("2026-11-16T04:00:00Z"))).toBe("2026-11-12");
    expect(heldBackTo("2026-11-16", at("2026-11-16T09:00:00Z"))).toBe("2026-11-16");
  });

  it("says when the next one comes", () => {
    const r = { days: [1, 4], lastDay: null, active: true };
    // Monday before 6:00: today. Monday once it is made: Thursday.
    expect(nextRepeatDay(r, at("2026-11-16T04:00:00Z"))).toBe("2026-11-16");
    expect(nextRepeatDay({ ...r, lastDay: "2026-11-16" }, at("2026-11-16T09:00:00Z"))).toBe("2026-11-19");
    // Friday: next Monday.
    expect(nextRepeatDay({ ...r, lastDay: "2026-11-19" }, at("2026-11-20T09:00:00Z"))).toBe("2026-11-23");
    // Only on Mondays, made this Monday: next Monday, a week on.
    expect(nextRepeatDay({ days: [1], lastDay: "2026-11-16", active: true }, at("2026-11-16T09:00:00Z"))).toBe("2026-11-23");
    expect(nextRepeatDay({ ...r, active: false }, at("2026-11-16T04:00:00Z"))).toBeNull();
    expect(nextRepeatDay({ ...r, days: [] }, at("2026-11-16T04:00:00Z"))).toBeNull();
  });
});
