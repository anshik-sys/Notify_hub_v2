import { cookies } from "next/headers";

// The user's theme choice, per device, in a cookie the server reads, so the
// first paint is already right (no flash, no client JS). "system" = follow
// the device's light/dark setting (PRD 8).
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_COOKIE = "theme";

export async function currentTheme(): Promise<Theme> {
  const value = (await cookies()).get(THEME_COOKIE)?.value;
  return THEMES.includes(value as Theme) ? (value as Theme) : "system";
}
