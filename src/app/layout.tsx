import type { Metadata, Viewport } from "next";
import { Geist_Mono, Manrope } from "next/font/google";
import { currentTheme } from "@/lib/theme";
import "./globals.css";

// A rounded geometric sans (the design reference's feel). Self-hosted by
// next/font at build time, so the CSP's font-src 'self' covers it.
const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "NotifyHub",
  robots: { index: false, follow: false },
};

// viewport-fit=cover: lets the app shell pad for the notch and home indicator.
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const theme = await currentTheme();
  return (
    <html
      lang="en"
      className={`${manrope.variable} ${geistMono.variable}`}
      data-theme={theme === "system" ? undefined : theme}
    >
      <body>{children}</body>
    </html>
  );
}
