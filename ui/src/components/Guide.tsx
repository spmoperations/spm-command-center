"use client";

// What the setup guides are made of: simple drawings of the screens a person goes through, with
// what to fill in or click outlined, and the numbered parts of each step. Used by the guides for
// Google, Slack, Fathom and Telegram.

import { toast } from "@/store/store";

/** One part of a screen sketch. `hi` outlines it as the thing to fill in or click. */
export type SketchPart =
  /** A service's bar along the top: its name and, for Google Cloud, the project picked. */
  | { t: "topbar"; brand?: string; project?: string; hi?: boolean }
  /** A side menu, with the item to open marked. */
  | { t: "menu"; items: string[]; picked: number }
  /** A message as a chat app shows it. */
  | { t: "message"; from: string; text: string; hi?: boolean }
  | { t: "title"; text: string }
  | { t: "text"; text: string }
  | { t: "field"; label: string; value: string; hi?: boolean }
  | { t: "radio"; options: string[]; picked: number; hi?: boolean }
  | { t: "check"; label: string; hi?: boolean }
  | { t: "code"; lines: string[]; hi?: boolean }
  | { t: "buttons"; items: { label: string; primary?: boolean; hi?: boolean }[] };

/** A simple drawing of a screen, with what to do on it outlined. */
export function Sketch({ url, parts, caption }: { url: string; parts: SketchPart[]; caption: string }) {
  return (
    <figure className="sk">
      <div className="sk-frame" role="img" aria-label={caption}>
        <div className="sk-bar">
          <span className="sk-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="sk-url">{url}</span>
        </div>
        <div className="sk-body">
          {parts.map((p, k) => {
            if (p.t === "topbar")
              return (
                <div key={k} className="sk-top">
                  <b>{p.brand ?? "Google Cloud"}</b>
                  {p.project && <span className={`sk-project ${p.hi ? "hi" : ""}`}>● {p.project} ▾</span>}
                  <span className="sk-search">Search</span>
                </div>
              );
            if (p.t === "menu")
              return (
                <div key={k} className="sk-menu">
                  {p.items.map((item, n) => (
                    <span key={item} className={n === p.picked ? "hi" : ""}>
                      {item}
                    </span>
                  ))}
                </div>
              );
            if (p.t === "message")
              return (
                <div key={k} className={`sk-msg ${p.hi ? "hi" : ""}`}>
                  <b>{p.from}</b>
                  <span>{p.text}</span>
                </div>
              );
            if (p.t === "title") return <div key={k} className="sk-title">{p.text}</div>;
            if (p.t === "text") return <div key={k} className="sk-text">{p.text}</div>;
            if (p.t === "field")
              return (
                <div key={k} className={`sk-field ${p.hi ? "hi" : ""}`}>
                  <span>{p.label}</span>
                  <b>{p.value}</b>
                </div>
              );
            if (p.t === "radio")
              return (
                <div key={k} className={`sk-radio ${p.hi ? "hi" : ""}`}>
                  {p.options.map((o, n) => (
                    <span key={o} className={n === p.picked ? "on" : ""}>
                      <i aria-hidden="true" />
                      {o}
                    </span>
                  ))}
                </div>
              );
            if (p.t === "check")
              return (
                <div key={k} className={`sk-check ${p.hi ? "hi" : ""}`}>
                  <i aria-hidden="true">✓</i>
                  {p.label}
                </div>
              );
            if (p.t === "code")
              return (
                <pre key={k} className={`sk-code ${p.hi ? "hi" : ""}`}>
                  {p.lines.join("\n")}
                </pre>
              );
            return (
              <div key={k} className="sk-buttons">
                {p.items.map((b) => (
                  <span key={b.label} className={`sk-btn ${b.primary ? "primary" : ""} ${b.hi ? "hi" : ""}`}>
                    {b.label}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

export function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  return (
    <button
      className="btn"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => toast("Copied"),
          () => toast("Select it and copy it by hand"),
        );
      }}
    >
      {label}
    </button>
  );
}

export const Open = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a className="btn primary extlink" href={href} target="_blank" rel="noopener noreferrer">
    {children} ↗
  </a>
);

/** One numbered part of a step. */
export function GuidePart({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <li className="gs-part">
      <div className="gs-n" aria-hidden="true">
        {n}
      </div>
      <div className="gs-body">
        <h4>{title}</h4>
        {children}
      </div>
    </li>
  );
}

