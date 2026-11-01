import type { Metadata, Viewport } from "next";
import { Inter, Noto_Sans_Devanagari } from "next/font/google";
import { PlayerLayer } from "@/components/player/PlayerLayer";
import { Toaster } from "@/components/Toaster";
import "./globals.css";
import "./components.css";

const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-inter" });
const deva = Noto_Sans_Devanagari({ subsets: ["devanagari"], weight: ["400", "500"], variable: "--font-deva" });

const DESCRIPTION = "The searchable brain of the Figuring Out podcast: ask questions, get cited answers with timestamps, clips and guest prep briefs.";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://cuepoint-two.vercel.app"),
  title: { default: "Cuepoint", template: "%s · Cuepoint" },
  description: DESCRIPTION,
  openGraph: { type: "website", siteName: "Cuepoint", locale: "en_IN", url: "/", title: "Cuepoint", description: DESCRIPTION },
  twitter: { card: "summary_large_image", title: "Cuepoint", description: DESCRIPTION },
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export const viewport: Viewport = { themeColor: "#101117", viewportFit: "cover" };

const FOOT_LINE = "Unofficial project, not affiliated with Figuring Out. Every answer links to its source.";

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${deva.variable}`} data-scroll-behavior="smooth">
      <body>
        {/* The Cuepoint mark, drawn once and reused by <use href="#cp-mark"> */}
        <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="cp-g" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#7c3cff" />
              <stop offset=".55" stopColor="#5b07fb" />
              <stop offset="1" stopColor="#3a0aa8" />
            </linearGradient>
          </defs>
          <symbol id="cp-mark" viewBox="0 0 56 56">
            <rect width="56" height="56" rx="16" fill="url(#cp-g)" />
            <g fill="#fff" opacity=".38">
              <rect x="10.5" y="27" width="3.2" height="8" rx="1.6" />
              <rect x="16.8" y="22.5" width="3.2" height="17" rx="1.6" />
              <rect x="36" y="20.5" width="3.2" height="21" rx="1.6" />
              <rect x="42.3" y="25" width="3.2" height="12" rx="1.6" />
            </g>
            <rect x="25.4" y="19" width="5.2" height="26" rx="2.6" fill="#fff" />
            <path d="M20.6 9.6h14.8a1.6 1.6 0 0 1 1.2 2.7l-7.4 7.6a1.6 1.6 0 0 1-2.3 0l-7.4-7.6a1.6 1.6 0 0 1 1.1-2.7z" fill="#4fe3c1" />
          </symbol>
        </svg>
        {children}
        <p className="foot">{FOOT_LINE}</p>
        {/* Shared across every page: the single player layer (one iframe, never moved) and the toasts. */}
        <PlayerLayer />
        <Toaster />
      </body>
    </html>
  );
}
