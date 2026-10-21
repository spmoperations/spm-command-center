// The plain text of an email, tidied for a preview: the addresses a mailing writes out in angle
// brackets after its words ("Read more <https://…>", "<mailto:…>") are left out. Plain logic.

const BRACKETED = /\s*<(?:https?:\/\/|mailto:|www\.)[^<>\s]*>/gi;

export function tidyEmailText(text: string): string {
  return text
    .replace(BRACKETED, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
