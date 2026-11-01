/* Line icons from design/10-global-components.html, drawn inline so they inherit currentColor. */
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const base = (p: P) => ({ viewBox: "0 0 24 24", "aria-hidden": true, focusable: false, ...p }) as P;

export const IconPlay = (p: P) => <svg {...base(p)}><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>;
export const IconPause = (p: P) => (
  <svg {...base(p)}><rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" /><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" /></svg>
);
export const IconX = (p: P) => <svg {...base(p)}><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>;
export const IconSearch = (p: P) => (
  <svg {...base(p)}><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
);
export const IconFlag = (p: P) => (
  <svg {...base(p)}><path d="M6 21V4m0 1h11l-2 4 2 4H6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /></svg>
);
export const IconCheck = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="10" fill="currentColor" opacity=".18" /><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
export const IconBookmark = (p: P) => <svg {...base(p)}><path d="M7 4h10v16l-5-3.5L7 20z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>;
export const IconCloudOff = (p: P) => (
  <svg {...base(p)}><path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 9.5 4.3 4.3 0 0 0 7 18z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /><path d="M4 4l16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
);
export const IconMenu = (p: P) => <svg {...base(p)}><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>;
export const IconUser = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="8.5" r="4" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M4.5 20c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
);
export const IconEpisode = (p: P) => (
  <svg {...base(p)}><rect x="3.5" y="5.5" width="17" height="13" rx="3" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M10.5 9.5v5l4-2.5z" fill="currentColor" /></svg>
);
export const IconPage = (p: P) => <svg {...base(p)}><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
export const IconAsk = (p: P) => (
  <svg {...base(p)}><path d="M5 18.5V7a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H8.5z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>
);
export const IconLink = (p: P) => (
  <svg {...base(p)}><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
);
export const IconExternal = (p: P) => (
  <svg {...base(p)}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
export const IconLogout = (p: P) => (
  <svg {...base(p)}><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
export const IconVolume = (p: P) => (
  <svg {...base(p)}><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor" /><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
);
export const IconVolumeOff = (p: P) => (
  <svg {...base(p)}><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor" /><path d="M16 9.5l5 5M21 9.5l-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
);
export const IconCaptions = (p: P) => (
  <svg {...base(p)}><rect x="3" y="5.5" width="18" height="13" rx="3" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M10.6 10.3a2.3 2.3 0 1 0 0 3.4M16.6 10.3a2.3 2.3 0 1 0 0 3.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
);
export const IconFullscreen = (p: P) => (
  <svg {...base(p)}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

export const IconHelp = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2.9-1.2 1.7M12 16.4v.1" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
