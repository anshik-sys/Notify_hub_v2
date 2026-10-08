import { cookies } from "next/headers";
import { currentTheme, THEME_COOKIE, THEMES, type Theme } from "@/lib/theme";
import { Icon } from "./icon";
import styles from "./theme-switcher.module.css";

async function setTheme(formData: FormData) {
  "use server";
  const theme = formData.get("theme") as Theme;
  if (!THEMES.includes(theme)) return;
  (await cookies()).set(THEME_COOKIE, theme, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
}

const LABELS: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };
const ICONS = { system: "system", light: "sun", dark: "moon" } as const;

// A segmented control: each option is a submit button; the server action sets
// the cookie and the page re-renders in the new theme. compact: round icon
// buttons for the top bar (name via aria-label, tooltip via title).
export async function ThemeSwitcher({ compact }: { compact?: boolean }) {
  const theme = await currentTheme();
  return (
    <form action={setTheme} className={compact ? `${styles.switcher} ${styles.compact}` : styles.switcher} aria-label="Theme">
      {THEMES.map((t) => (
        <button
          key={t}
          name="theme"
          value={t}
          className={styles.option}
          aria-pressed={theme === t}
          aria-label={compact ? `${LABELS[t]} theme` : undefined}
          title={compact ? `${LABELS[t]} theme` : undefined}
        >
          {compact ? <Icon name={ICONS[t]} /> : LABELS[t]}
        </button>
      ))}
    </form>
  );
}
