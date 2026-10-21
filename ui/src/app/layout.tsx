import type { Metadata } from "next";
import { Bricolage_Grotesque, Instrument_Sans, JetBrains_Mono } from "next/font/google";
import { Shell } from "@/components/Shell";
import "./globals.css";

const display = Bricolage_Grotesque({ variable: "--font-display", subsets: ["latin"], weight: ["500", "700"] });
const body = Instrument_Sans({ variable: "--font-body", subsets: ["latin"], weight: ["400", "500", "600"] });
const mono = JetBrains_Mono({ variable: "--font-mono", subsets: ["latin"], weight: ["400", "600"] });

export const metadata: Metadata = {
  title: "SPM Command Center",
  description: "Messages, calls and tasks in one place.",
};

/** Applies the theme kept by the header's button (Shell.tsx, THEME_KEY). Nothing kept: the computer's own setting. */
const THEME_SCRIPT = `try{var t=localStorage.getItem("cc-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The theme chosen with the header's button is put on <html> before the page draws, so it
    // never flashes the other one. React leaves that attribute alone.
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
