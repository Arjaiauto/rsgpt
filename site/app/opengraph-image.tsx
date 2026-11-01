import { ImageResponse } from "next/og";

/** The link-preview card (LinkedIn, WhatsApp, Slack, X): drawn here, no fetches and no external images. The colours
    are the site's tokens from app/globals.css, written out because ImageResponse can't read CSS variables. */
export const alt = "Cuepoint: every Figuring Out episode, searchable. Unofficial project, not affiliated with Figuring Out.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const PAPER = "#101117", INK = "#f2f2f5", SOFT = "rgba(242,242,245,0.55)", FAINT = "rgba(242,242,245,0.38)", VIOLET = "#5b07fb", CITE = "#4fe3c1";

export default function Image() {
  const wm = 168; // wordmark size in px; the i's stem is 0.545em tall, as on the site
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "72px 84px", background: `radial-gradient(90% 90% at 50% 35%, #1a1b24 0%, ${PAPER} 58%, #08090c 100%)`, color: INK }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <svg width="56" height="56" viewBox="0 0 56 56">
            <rect width="56" height="56" rx="16" fill={VIOLET} />
            <rect x="10.5" y="27" width="3.2" height="8" rx="1.6" fill="#fff" opacity="0.38" />
            <rect x="16.8" y="22.5" width="3.2" height="17" rx="1.6" fill="#fff" opacity="0.38" />
            <rect x="36" y="20.5" width="3.2" height="21" rx="1.6" fill="#fff" opacity="0.38" />
            <rect x="42.3" y="25" width="3.2" height="12" rx="1.6" fill="#fff" opacity="0.38" />
            <rect x="25.4" y="19" width="5.2" height="26" rx="2.6" fill="#fff" />
            <path d="M20.6 9.6h14.8a1.6 1.6 0 0 1 1.2 2.7l-7.4 7.6a1.6 1.6 0 0 1-2.3 0l-7.4-7.6a1.6 1.6 0 0 1 1.1-2.7z" fill={CITE} />
          </svg>
          <div style={{ fontSize: 26, color: SOFT, letterSpacing: "0.02em" }}>Every Figuring Out episode, searchable</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "flex-end", fontSize: wm, fontWeight: 700, letterSpacing: "-0.05em", lineHeight: 1 }}>
            <span>cuepo</span>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginLeft: wm * 0.04, marginRight: wm * 0.04, marginBottom: wm * 0.145 }}>
              <div style={{ width: wm * 0.12, height: wm * 0.2, borderRadius: wm * 0.06, background: CITE, marginBottom: wm * 0.05 }} />
              <div style={{ width: wm * 0.12, height: wm * 0.545, borderRadius: wm * 0.06, background: INK }} />
            </div>
            <span>nt</span>
          </div>
          <div style={{ marginTop: 28, fontSize: 38, lineHeight: 1.3, color: SOFT, maxWidth: 900 }}>
            Ask questions, get cited answers with timestamps, clips and guest prep briefs.
          </div>
        </div>

        <div style={{ fontSize: 22, color: FAINT }}>Unofficial project, not affiliated with Figuring Out. Every answer links to its source.</div>
      </div>
    ),
    size,
  );
}
