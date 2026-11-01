import { ImageResponse } from "next/og";

/** The home-screen icon (iOS "Add to Home Screen"): the Cuepoint mark, the same one as app/icon.svg and the link-preview
    image, drawn once at build time. iOS rounds the corners itself, so the square is filled edge to edge. */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex" }}>
        <svg width="180" height="180" viewBox="0 0 56 56">
          <defs>
            <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#7c3cff" />
              <stop offset="0.55" stopColor="#5b07fb" />
              <stop offset="1" stopColor="#3a0aa8" />
            </linearGradient>
          </defs>
          <rect width="56" height="56" fill="url(#g)" />
          <g fill="#fff" opacity="0.38">
            <rect x="10.5" y="27" width="3.2" height="8" rx="1.6" />
            <rect x="16.8" y="22.5" width="3.2" height="17" rx="1.6" />
            <rect x="36" y="20.5" width="3.2" height="21" rx="1.6" />
            <rect x="42.3" y="25" width="3.2" height="12" rx="1.6" />
          </g>
          <rect x="25.4" y="19" width="5.2" height="26" rx="2.6" fill="#fff" />
          <path d="M20.6 9.6h14.8a1.6 1.6 0 0 1 1.2 2.7l-7.4 7.6a1.6 1.6 0 0 1-2.3 0l-7.4-7.6a1.6 1.6 0 0 1 1.1-2.7z" fill="#4fe3c1" />
        </svg>
      </div>
    ),
    size,
  );
}
