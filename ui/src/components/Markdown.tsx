// Call notes arrive as Markdown. This shows the parts they use (headings, lists, bold,
// links) as plain React elements, so no HTML from outside is ever put on the page.

const INLINE = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

/** "Q\&A" is how Markdown writes "Q&A": drop the backslash in front of punctuation. */
const unescape = (text: string) => text.replace(/\\([\\`*_{}[\]()#+\-.!&<>~|])/g, "$1");

function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(unescape(text.slice(last, m.index)));
    out.push(
      m[1] !== undefined ? (
        <strong key={m.index}>{unescape(m[1])}</strong>
      ) : (
        // Fathom links every line of its notes to that moment in the recording, and the
        // linked text has bold of its own.
        <a key={m.index} href={m[3]} target="_blank" rel="noopener noreferrer" title="Open this moment in the recording">
          {inline(m[2])}
        </a>
      ),
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(unescape(text.slice(last)));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let items: string[] = [];
  const flush = () => {
    if (!items.length) return;
    blocks.push(
      <ul key={`list-${blocks.length}`}>
        {items.map((item, k) => (
          <li key={k}>{inline(item)}</li>
        ))}
      </ul>,
    );
    items = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = line.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (bullet) {
      items.push(bullet[1]);
      continue;
    }
    flush();
    if (!line) continue;
    blocks.push(heading ? <h5 key={blocks.length}>{inline(heading[1])}</h5> : <p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return <div className="md">{blocks}</div>;
}
