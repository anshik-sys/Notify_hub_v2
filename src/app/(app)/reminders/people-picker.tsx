"use client";

// Searchable multi-select for individual recipients. Each chosen person is a
// chip carrying a hidden <input name="users">, so the server action reads it
// like any checkbox. Combobox pattern: arrows move, Enter picks, Escape closes.
import { useId, useMemo, useState } from "react";
import type { Person } from "./form-data";
import styles from "./people-picker.module.css";

export function PeoplePicker({ people, initial }: { people: Person[]; initial: string[] }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [chosen, setChosen] = useState<string[]>(initial);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people.filter((p) => !q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)).slice(0, 50);
  }, [people, query]);

  const toggle = (personId: string) =>
    setChosen((c) => (c.includes(personId) ? c.filter((x) => x !== personId) : [...c, personId]));

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && open && results[active]) {
      e.preventDefault(); // don't submit the reminder form
      toggle(results[active].id);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const listId = `${id}-list`;
  const optionId = (i: number) => `${id}-opt-${i}`;
  const selected = people.filter((p) => chosen.includes(p.id));

  return (
    <div className={styles.picker}>
      <label htmlFor={`${id}-input`} className={styles.label}>
        Search people by name or email
      </label>
      <input
        id={`${id}-input`}
        className={styles.input}
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && results[active] ? optionId(active) : undefined}
        autoComplete="off"
        placeholder="Type a name…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul id={listId} role="listbox" aria-multiselectable="true" className={styles.list}>
          {results.length === 0 && <li className={styles.empty}>No one matches “{query}”.</li>}
          {results.map((p, i) => {
            const isChosen = chosen.includes(p.id);
            return (
              <li
                key={p.id}
                id={optionId(i)}
                role="option"
                aria-selected={isChosen}
                className={i === active ? `${styles.option} ${styles.active}` : styles.option}
                // mousedown, not click: keeps focus in the input so the list stays open.
                onMouseDown={(e) => {
                  e.preventDefault();
                  toggle(p.id);
                }}
              >
                <span className={styles.text}>
                  <span>{p.name}</span>
                  <span className={styles.email}>{p.email}</span>
                </span>
                <span aria-hidden="true" className={styles.check}>
                  {isChosen ? "✓" : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {selected.length > 0 && (
        <ul className={styles.chips} aria-label="Chosen people">
          {selected.map((p) => (
            <li key={p.id} className={styles.chip}>
              {p.name}
              <button type="button" className={styles.remove} aria-label={`Remove ${p.name}`} onClick={() => toggle(p.id)}>
                ×
              </button>
              <input type="hidden" name="users" value={p.id} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
