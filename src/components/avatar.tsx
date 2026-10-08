import styles from "./avatar.module.css";

// Initials until people can upload a photo, on a colour picked from the name
// so the same person always gets the same one.
const TONES = ["violet", "coral", "amber", "teal", "blue", "pink", "green"];
const initials = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
const toneOf = (name: string) => TONES[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TONES.length];

export function Avatar({ name }: { name: string }) {
  return (
    <span className={styles.avatar} data-tone={toneOf(name)} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
