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
// The full control (Settings > Appearance): System / Light / Dark. Each option
// is a submit button; the server action sets the cookie and the page
// re-renders in the new theme.
export async function ThemeSwitcher() {
  const theme = await currentTheme();
  return (
    <form action={setTheme} className={styles.switcher} aria-label="Theme">
      {THEMES.map((t) => (
        <button key={t} name="theme" value={t} className={styles.option} aria-pressed={theme === t}>
          {LABELS[t]}
        </button>
      ))}
    </form>
  );
}

// The top-bar toggle: one round button that flips light/dark. The server
// can't see the device's theme while the choice is "system", so both buttons
// render and CSS shows the one that fits what's on screen. Going back to
// "system" is in Settings > Appearance.
export function ThemeToggle({ className }: { className: string }) {
  return (
    <form action={setTheme} className={styles.toggle}>
      <button name="theme" value="dark" className={`${className} ${styles.toDark}`} aria-label="Dark theme" title="Dark theme">
        <Icon name="moon" />
      </button>
      <button name="theme" value="light" className={`${className} ${styles.toLight}`} aria-label="Light theme" title="Light theme">
        <Icon name="sun" />
      </button>
    </form>
  );
}
