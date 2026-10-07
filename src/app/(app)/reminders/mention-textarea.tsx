"use client";

// A comment box where typing "@" opens a list of people. Picking one inserts
// "@Name" and records their id in a hidden <input name="mentions">; ids whose
// "@Name" has been deleted from the text are dropped before submitting (the
// server checks again). Arrows move, Enter picks, Escape closes.
import { useId, useMemo, useRef, useState } from "react";
import styles from "./mention-textarea.module.css";

type Person = { id: string; name: string; email: string };

export function MentionTextarea({
  people,
  label,
  name = "body",
  defaultValue = "",
  defaultMentions = [],
  required = true,
}: {
  people: Person[];
  label: string;
  name?: string;
  defaultValue?: string;
  defaultMentions?: string[];
  required?: boolean;
}) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(defaultValue);
  const [picked, setPicked] = useState<string[]>(defaultMentions);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const results = useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    return people.filter((p) => p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)).slice(0, 8);
  }, [people, query]);

  // The "@partial" right before the caret, if any.
  function update(value: string, caret: number) {
    setText(value);
    const m = /(?:^|\s)@([\p{L}\p{N} .'-]{0,30})$/u.exec(value.slice(0, caret));
    setQuery(m ? m[1] : null);
    setActive(0);
  }

  function pick(p: Person) {
    const el = ref.current!;
    const caret = el.selectionStart;
    const before = text.slice(0, caret).replace(/@([\p{L}\p{N} .'-]{0,30})$/u, `@${p.name} `);
    const next = before + text.slice(caret);
    setText(next);
    setPicked((ids) => (ids.includes(p.id) ? ids : [...ids, p.id]));
    setQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (query === null || !results.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(results[active]);
    } else if (e.key === "Escape") setQuery(null);
  }

  // Only mentions whose "@Name" is still in the text are sent.
  const kept = people.filter((p) => picked.includes(p.id) && text.includes(`@${p.name}`));
  const listId = `${id}-list`;

  return (
    <div className={styles.wrap}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <textarea
        ref={ref}
        id={id}
        name={name}
        className={styles.textarea}
        value={text}
        required={required}
        maxLength={5000}
        rows={3}
        role="combobox"
        aria-expanded={query !== null && results.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={query !== null && results[active] ? `${id}-opt-${active}` : undefined}
        placeholder="Write a comment. Type @ to mention someone."
        onChange={(e) => update(e.target.value, e.target.selectionStart)}
        onKeyDown={onKeyDown}
        onBlur={() => setQuery(null)}
      />
      {query !== null && results.length > 0 && (
        <ul id={listId} role="listbox" className={styles.list}>
          {results.map((p, i) => (
            <li
              key={p.id}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? `${styles.option} ${styles.active}` : styles.option}
              onMouseDown={(e) => {
                e.preventDefault(); // keep focus in the textarea
                pick(p);
              }}
            >
              {p.name} <span className={styles.email}>{p.email}</span>
            </li>
          ))}
        </ul>
      )}
      {kept.map((p) => (
        <input key={p.id} type="hidden" name="mentions" value={p.id} />
      ))}
    </div>
  );
}
