import styles from "./avatar.module.css";

// Initials until people can upload a photo.
const initials = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

export function Avatar({ name, size }: { name: string; size?: "large" }) {
  return (
    <span className={size === "large" ? `${styles.avatar} ${styles.large}` : styles.avatar} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
