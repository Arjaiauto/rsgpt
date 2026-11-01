"use client";

/** The last resort: an error in the root layout itself. It replaces the whole page, so it brings its own <html> and
    styles (the site's stylesheets and fonts may be what failed). Nothing about the error is shown. */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100svh", display: "grid", placeItems: "center", background: "#101117", color: "#f2f2f5", fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif", padding: 16 }}>
        <main style={{ maxWidth: 480 }}>
          <svg width="44" height="44" viewBox="0 0 56 56" aria-hidden="true">
            <rect width="56" height="56" rx="16" fill="#5b07fb" />
            <rect x="25.4" y="19" width="5.2" height="26" rx="2.6" fill="#fff" />
            <path d="M20.6 9.6h14.8a1.6 1.6 0 0 1 1.2 2.7l-7.4 7.6a1.6 1.6 0 0 1-2.3 0l-7.4-7.6a1.6 1.6 0 0 1 1.1-2.7z" fill="#4fe3c1" />
          </svg>
          <h1 style={{ fontSize: 34, fontWeight: 500, letterSpacing: "-0.04em", margin: "22px 0 8px" }}>Something went wrong</h1>
          <p style={{ color: "#b4b4c0", lineHeight: 1.5, margin: "0 0 22px" }}>Cuepoint hit an error and couldn&apos;t show this page. Nothing was lost. Try again, or go back to the start.</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" onClick={reset} style={{ height: 44, padding: "0 22px", borderRadius: 999, border: 0, background: "#5b07fb", color: "#fff", font: "inherit", fontWeight: 500, cursor: "pointer" }}>Try again</button>
            {/* A plain link on purpose: the router itself may be what failed. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" style={{ height: 44, padding: "0 22px", borderRadius: 999, border: "1px solid #3a3a48", color: "#f2f2f5", display: "inline-flex", alignItems: "center", textDecoration: "none" }}>Go to the start</a>
          </div>
          <p style={{ marginTop: 40, fontSize: 12.5, color: "#8d8d9c" }}>Unofficial project, not affiliated with Figuring Out. Every answer links to its source.</p>
        </main>
      </body>
    </html>
  );
}
