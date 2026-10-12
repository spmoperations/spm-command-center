// Type-to-find for pick lists: the channel and people pickers hold a hundred names or more.

export interface Choice {
  value: string;
  label: string;
  /** Heading the choice sits under, e.g. "People on Slack". */
  group?: string;
}

const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The choices that fit what was typed. Every word typed must appear somewhere in the name, in
 * any order, so "acme sales" finds "#acme-corp-sales-metrics". Names that start with what was
 * typed come first; otherwise the list keeps its order.
 */
export function findChoices<T extends Choice>(choices: T[], typed: string): T[] {
  const words = plain(typed).split(" ").filter(Boolean);
  if (!words.length) return choices;
  const start = words.join(" ");
  const fits = choices.filter((c) => {
    const name = plain(c.label);
    return words.every((w) => name.includes(w));
  });
  return [...fits.filter((c) => plain(c.label).startsWith(start)), ...fits.filter((c) => !plain(c.label).startsWith(start))];
}
