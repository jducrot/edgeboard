import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "EdgeBoard",
    template: "%s | EdgeBoard",
  },
  description:
    "NBA game signals, injury news, and a prediction journal that grades itself.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-indigo-700 focus:px-4 focus:py-3 focus:text-white"
        >
          Skip to main content
        </a>
        <header className="border-b border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-8 gap-y-2 px-4 py-4">
            <p className="text-xl font-bold tracking-tight">
              <Link
                href="/"
                className="rounded focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-indigo-700 dark:focus-visible:outline-indigo-300"
              >
                EdgeBoard
              </Link>
            </p>
            <nav aria-label="Primary">
              <ul className="flex gap-2">
                <li>
                  <Link
                    href="/"
                    className="inline-block rounded px-3 py-2 font-medium text-zinc-700 underline-offset-4 hover:underline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-indigo-700 dark:text-zinc-300 dark:focus-visible:outline-indigo-300"
                  >
                    Slate
                  </Link>
                </li>
                <li>
                  <Link
                    href="/review"
                    className="inline-block rounded px-3 py-2 font-medium text-zinc-700 underline-offset-4 hover:underline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-indigo-700 dark:text-zinc-300 dark:focus-visible:outline-indigo-300"
                  >
                    Review
                  </Link>
                </li>
              </ul>
            </nav>
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
          {children}
        </main>
        <footer className="border-t border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900">
          <div className="mx-auto max-w-5xl px-4 py-4 text-sm text-zinc-700 dark:text-zinc-300">
            <p>
              Data from ESPN public APIs. Lines shown for information, not
              advice. Past results never guarantee future outcomes.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
