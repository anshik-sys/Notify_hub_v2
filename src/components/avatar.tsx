import styles from "./avatar.module.css";

const initials = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

// The person's photo (a URL from photoUrls) over their initials. If the photo
// can't load, an <img alt=""> shows nothing, so the initials show through.
export function Avatar({ name, photo, size }: { name: string; photo?: string; size?: "large" }) {
  return (
    <span className={size === "large" ? `${styles.avatar} ${styles.large}` : styles.avatar} aria-hidden="true">
      {initials(name)}
      {/* eslint-disable-next-line @next/next/no-img-element -- a tiny private image; next/image adds nothing here */}
      {photo && <img src={photo} alt="" className={styles.photo} />}
    </span>
  );
}
