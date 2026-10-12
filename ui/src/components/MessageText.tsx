import { formatMessage, hueFor, initials, type Inline } from "@/core/message-format";

function Pieces({ row }: { row: Inline[] }) {
  return (
    <>
      {row.map((piece, k) => {
        switch (piece.kind) {
          case "bold":
            return <strong key={k}>{piece.text}</strong>;
          case "italic":
            return <em key={k}>{piece.text}</em>;
          case "strike":
            return <s key={k}>{piece.text}</s>;
          case "code":
            return <code key={k}>{piece.text}</code>;
          case "link":
            return (
              <a key={k} href={piece.href} target="_blank" rel="noopener noreferrer" title={piece.href}>
                {piece.text}
              </a>
            );
          default:
            return <span key={k}>{piece.text}</span>;
        }
      })}
    </>
  );
}

/** A chat message laid out the way it was written: paragraphs, lists, quotes, code and links. */
export function MessageText({ text }: { text: string }) {
  return (
    <div className="mtext">
      {formatMessage(text).map((block, k) => {
        if (block.kind === "code") return <pre key={k}>{block.text}</pre>;
        if (block.kind === "list") {
          return (
            <ul key={k}>
              {block.items.map((item, i) => (
                <li key={i}>
                  <Pieces row={item} />
                </li>
              ))}
            </ul>
          );
        }
        const Tag = block.kind === "quote" ? "blockquote" : "p";
        return (
          <Tag key={k}>
            {block.lines.map((line, i) => (
              <span key={i}>
                {i > 0 && <br />}
                <Pieces row={line} />
              </span>
            ))}
          </Tag>
        );
      })}
    </div>
  );
}

/** A person's initials on their own steady color. */
export function Avatar({ name, small }: { name: string; small?: boolean }) {
  return (
    <span className={`avatar ${small ? "small" : ""}`} style={{ "--hue": hueFor(name) } as React.CSSProperties} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
