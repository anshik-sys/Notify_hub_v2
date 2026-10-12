import styles from "./loading.module.css";

// Shown inside the shell the moment a link is clicked, until the page is
// ready: a title bar and three cards, softly pulsing. The sidebar and top bar
// stay as they are.
export default function Loading() {
  return (
    <div className={styles.page} role="status">
      <span className={styles.hidden}>Loading…</span>
      <div className={styles.title} />
      <div className={styles.card} />
      <div className={styles.card} />
      <div className={styles.card} />
    </div>
  );
}
