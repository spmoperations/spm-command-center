// Turns a chat message's text into pieces the screen can lay out: paragraphs, lists, quotes,
// code, bold, italics and links. Plain logic: it returns data, never HTML, so nothing a
// stranger types can end up as markup on the page.

export type Inline =
  | { kind: "text" | "bold" | "italic" | "strike" | "code"; text: string }
  | { kind: "link"; text: string; href: string };

export type Block =
  | { kind: "paragraph" | "quote"; lines: Inline[][] }
  | { kind: "list"; items: Inline[][] }
  | { kind: "code"; text: string };

// One pass, left to right. Links come first so the underscores and stars inside an address
// are never read as formatting. Formatting marks must hug the words they wrap.
const INLINE = new RegExp(
  [
    String.raw`\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)`, // 1,2  [label](url)
    String.raw`(https?:\/\/[^\s<>]+)`, // 3  bare address
    "`([^`\\n]+)`", // 4  code
    String.raw`(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])`, // 5  bold
    String.raw`(?<![\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w_])`, // 6  italic
    String.raw`(?<![\w~])~(?=\S)([^~\n]+?)(?<=\S)~(?![\w~])`, // 7  strike
  ].join("|"),
  "g",
);

/** "docs.google.com/spreadsheets/d/1V3s…" in place of a hundred characters of address. */
export function shortUrl(url: string, max = 44): string {
  const bare = url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
  return bare.length > max ? `${bare.slice(0, max - 1)}…` : bare;
}

export function formatInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const push = (value: string) => {
    if (value) out.push({ kind: "text", text: value });
  };
  for (const m of text.matchAll(INLINE)) {
    push(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) out.push({ kind: "link", text: m[1], href: m[2] });
    else if (m[3] !== undefined) {
      // Punctuation that ends the sentence is not part of the address.
      const trailing = m[3].match(/[.,;:!?)\]]+$/)?.[0] ?? "";
      const href = trailing ? m[3].slice(0, -trailing.length) : m[3];
      out.push({ kind: "link", text: shortUrl(href), href });
      push(trailing);
    } else if (m[4] !== undefined) out.push({ kind: "code", text: m[4] });
    else if (m[5] !== undefined) out.push({ kind: "bold", text: m[5] });
    else if (m[6] !== undefined) out.push({ kind: "italic", text: m[6] });
    else out.push({ kind: "strike", text: m[7] });
  }
  push(text.slice(last));
  return out;
}

type TextBlock = Extract<Block, { kind: "paragraph" | "quote" }>;
type ListBlock = Extract<Block, { kind: "list" }>;

const BULLET = /^\s*(?:[•◦▪‣-]|\d+[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

export function formatMessage(text: string): Block[] {
  const blocks: Block[] = [];
  // Odd pieces sit between ``` fences and are shown exactly as typed.
  text.split("```").forEach((piece, index) => {
    if (index % 2 === 1) {
      if (piece.trim()) blocks.push({ kind: "code", text: piece.replace(/^\n+|\n+$/g, "") });
      return;
    }
    // The block being built. It is closed by a blank line or by a line of a different kind.
    const open: { block: TextBlock | ListBlock | null } = { block: null };
    const close = () => {
      if (open.block) blocks.push(open.block);
      open.block = null;
    };
    for (const line of piece.split("\n")) {
      const bullet = line.match(BULLET);
      const quote = line.match(QUOTE);
      if (!line.trim()) {
        close();
      } else if (bullet) {
        if (open.block?.kind !== "list") {
          close();
          open.block = { kind: "list", items: [] };
        }
        (open.block as ListBlock).items.push(formatInline(bullet[1]));
      } else {
        const kind = quote ? "quote" : "paragraph";
        if (open.block?.kind !== kind) {
          close();
          open.block = { kind, lines: [] };
        }
        (open.block as TextBlock).lines.push(formatInline(quote ? quote[1] : line.trim()));
      }
    }
    close();
  });
  return blocks;
}

/** One plain line for a list preview: no marks, no line breaks, short links. */
export function plainPreview(text: string, max = 180): string {
  const flat = formatMessage(text)
    .map((block) => {
      if (block.kind === "code") return block.text;
      const rows = block.kind === "list" ? block.items : block.lines;
      return rows.map((row) => row.map((piece) => piece.text).join("")).join(" ");
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** "Maya Chen" becomes "MC"; a single name gives its first two letters. */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** A steady color per person, so the same name always looks the same. Returns a hue, 0 to 359. */
export function hueFor(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}
