"use client";

import { useState } from "react";
import { formatMessage, hueFor, initials, type Inline } from "@/core/message-format";
import type { MessagePicture, Reaction } from "@/core/types";

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

/** The largest a picture is drawn in a conversation, and a sticker. Clicking opens it full size. */
const PICTURE_BOX = { w: 300, h: 220 };
const STICKER_BOX = { w: 120, h: 120 };

/** The size to draw at, known before the picture arrives so the conversation does not jump when it does. */
function drawnSize(p: MessagePicture): React.CSSProperties | undefined {
  if (!p.w || !p.h) return undefined;
  const box = p.kind === "sticker" ? STICKER_BOX : PICTURE_BOX;
  const scale = Math.min(1, box.w / p.w, box.h / p.h);
  return { width: Math.round(p.w * scale), aspectRatio: `${p.w} / ${p.h}` };
}

/**
 * The pictures and stickers sent with a message. `blocked` is for pictures the dashboard is
 * not allowed to fetch: they are named, with a way to open them where they live. A picture
 * that will not load is shown the same way.
 */
export function Pictures({ pictures, blocked }: { pictures: MessagePicture[]; blocked?: boolean }) {
  const [broken, setBroken] = useState<string[]>([]);
  return (
    <div className="pics">
      {pictures.map((p) =>
        (blocked && !p.here) || broken.includes(p.src) ? (
          <span className="pic-missing" key={p.src}>
            <span>Picture: {p.name}</span>
            {p.link ? (
              <a href={p.link} target="_blank" rel="noopener noreferrer">
                Open in Slack
              </a>
            ) : (
              <span>cannot be shown</span>
            )}
          </span>
        ) : (
          <a className={`pic ${p.kind}`} key={p.src} href={p.full ?? p.src} target="_blank" rel="noopener noreferrer" title={`${p.name}. Opens full size.`}>
            {/* Served by the dashboard itself, already at a size for the screen. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.src} alt={p.name} loading="lazy" style={drawnSize(p)} onError={() => setBroken((b) => [...b, p.src])} />
          </a>
        ),
      )}
    </div>
  );
}

/** The emoji people put on a message, each with how many. The owner's own are picked out. */
export function Reactions({ reactions }: { reactions: Reaction[] }) {
  return (
    <div className="reactions">
      {reactions.map((r) => {
        const who = r.mine ? (r.count > 1 ? `You and ${r.count - 1} more` : "You") : `${r.count} ${r.count === 1 ? "person" : "people"}`;
        return (
          <span className={`reaction ${r.mine ? "mine" : ""}`} key={r.emoji} title={`${who} reacted with ${r.emoji}`}>
            <span aria-hidden="true">{r.emoji}</span>
            <span className="num">{r.count}</span>
            <span className="sr-only">{`${r.emoji}: ${who}`}</span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * A person's profile picture. Without one, or if it will not load, their initials on their
 * own steady color.
 */
export function Avatar({ name, src, small }: { name: string; src?: string; small?: boolean }) {
  const [broken, setBroken] = useState<string | null>(null);
  if (src && broken !== src) {
    return (
      // A small picture, from Slack's own servers or from the dashboard: nothing to resize or cache here.
      // eslint-disable-next-line @next/next/no-img-element
      <img className={`avatar ${small ? "small" : ""}`} src={src} alt="" title={name} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(src)} />
    );
  }
  return (
    <span className={`avatar ${small ? "small" : ""}`} style={{ "--hue": hueFor(name) } as React.CSSProperties} title={name} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
