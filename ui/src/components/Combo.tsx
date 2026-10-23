"use client";

import { useEffect, useId, useRef, useState } from "react";
import { findChoices, type Choice } from "@/core/search";

interface Props {
  id?: string;
  /** The picked choice's value, or "" for none. */
  value: string;
  onChange(value: string): void;
  choices: Choice[];
  /** Shown in the empty box. */
  placeholder: string;
  /** Adds a first choice that picks nothing, with this label. Leave out when something must be picked. */
  none?: string;
  /** Read out for the box when it has no visible label. */
  label?: string;
}

/**
 * A pick list you can type in. Click it to see everything, or type a few letters to narrow
 * it down; arrow keys and Enter work too.
 */
export function Combo({ id, value, onChange, choices, placeholder, none, label }: Props) {
  const listId = useId();
  const box = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [active, setActive] = useState(0);
  // The list is placed on the window, not inside the form, so a scrolling table cannot cut it off.
  const [place, setPlace] = useState<React.CSSProperties>({});

  const picked = choices.find((c) => c.value === value);
  const empty: Choice[] = none ? [{ value: "", label: none }] : [];
  // The "nothing" choice stays on offer until the person starts typing a name.
  const shown = typed.trim() ? findChoices(choices, typed) : [...empty, ...choices];

  const close = () => {
    setOpen(false);
    setTyped("");
  };
  const show = () => {
    const at = box.current?.getBoundingClientRect();
    if (at) {
      const width = Math.max(at.width, 260);
      const left = Math.max(8, Math.min(at.left, window.innerWidth - width - 8));
      // Below the box when there is room, above it when there is not.
      const below = window.innerHeight - at.bottom > 300 || at.top < 300;
      setPlace(below ? { left, width, top: at.bottom + 4 } : { left, width, bottom: window.innerHeight - at.top + 4 });
    }
    setOpen(true);
  };

  // Once the page moves, the list would no longer sit under its box: close it.
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      // A resize comes from the window, which is not part of the page: that closes it too.
      if (!(e.target instanceof Node) || !list.current?.contains(e.target)) close();
    };
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => {
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
    };
  }, [open]);

  // Keep the highlighted choice in view while moving with the arrow keys.
  useEffect(() => {
    if (open) list.current?.querySelector(".combo-option.active")?.scrollIntoView({ block: "nearest" });
  }, [open, active]);
  const pick = (choice: Choice) => {
    onChange(choice.value);
    close();
  };
  const move = (by: number) => {
    if (!open) show();
    setActive((at) => (shown.length ? (at + by + shown.length) % shown.length : 0));
  };

  return (
    <div className="combo">
      <input
        id={id}
        ref={box}
        className="f"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        placeholder={picked ? picked.label : (value === "" && none) || placeholder}
        // While closed the box shows what is picked; while open, what is being typed.
        value={open ? typed : (picked?.label ?? "")}
        onFocus={show}
        onClick={show}
        onBlur={close}
        onChange={(e) => {
          setTyped(e.target.value);
          setActive(0);
          if (!open) show();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            move(-1);
          } else if (e.key === "Enter" && open) {
            // Enter picks from the list; it must not send the form the box sits in.
            e.preventDefault();
            if (shown[active]) pick(shown[active]);
          } else if (e.key === "Escape" && open) {
            e.preventDefault();
            close();
          }
        }}
      />
      <span className="combo-caret" aria-hidden="true">
        ▾
      </span>
      {open && (
        <ul className="combo-list" id={listId} role="listbox" ref={list} style={place}>
          {shown.map((choice, k) => (
            <li key={choice.value || "none"} role="presentation">
              {choice.group && choice.group !== shown[k - 1]?.group && <div className="combo-group">{choice.group}</div>}
              <div
                id={`${listId}-${k}`}
                role="option"
                aria-selected={choice.value === value}
                className={`combo-option ${k === active ? "active" : ""}`}
                // Picked on mouse down, before the box loses focus and closes the list.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(choice);
                  box.current?.blur();
                }}
                onMouseEnter={() => setActive(k)}
              >
                {choice.label}
              </div>
            </li>
          ))}
          {shown.length === 0 && <li className="combo-empty">Nothing matches &ldquo;{typed.trim()}&rdquo;</li>}
        </ul>
      )}
    </div>
  );
}
