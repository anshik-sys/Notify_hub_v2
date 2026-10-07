import { cookies } from "next/headers";
import { currentTheme, THEME_COOKIE, THEMES, type Theme } from "@/lib/theme";
import styles from "./theme-switcher.module.css";

async function setTheme(formData: FormData) {
  "use server";
  const theme = formData.get("theme") as Theme;
  if (!THEMES.includes(theme)) return;
  (await cookies()).set(THEME_COOKIE, theme, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
}

const LABELS: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };

// A segmented control: each option is a submit button; the server action sets
// the cookie and the page re-renders in the new theme.
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
