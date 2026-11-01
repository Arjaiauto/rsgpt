/** The welcome tour (Ticket 25b): the slides, and the names the tour's parts share. Pictures are screenshots of the live
    site in public/tour/ (made by scripts/tour-capture.mjs); the dots on them come from public/tour/pins.json. */

/** A signed cookie that says this device has already shown this person the tour (the record itself is
    visitors.tour_seen_at, keyed by name). */
export const TOUR_COOKIE = "tour_seen";
/** Fired on window to open the tour from anywhere (the "? Tour" pill, the phone menu). */
export const TOUR_OPEN_EVENT = "cuepoint:open-tour";
/** Fired on window when the tour has opened, so the page behind it can stop (Reels pause). */
export const TOUR_OPENED_EVENT = "cuepoint:tour-opened";

export type TourSlide = {
  id: string;
  title: string;
  /** What the page is for, in one line. */
  purpose: string;
  /** Three numbered callouts; the numbers are the dots on the screenshot. */
  callouts: [string, string, string];
  tryIt: { label: string; href: string };
  alt: string;
};

export const TOUR_SLIDES: TourSlide[] = [
  {
    id: "welcome",
    title: "Welcome to Cuepoint",
    purpose: "Search every episode and jump to the moment something was said. Every answer links to its source.",
    callouts: [
      "Every page is in the top bar (in the menu on a phone).",
      "Search guests and episodes from anywhere (Ctrl K).",
      "Your name and Log out. Reopen this tour anytime from ? Tour.",
    ],
    tryIt: { label: "Start with Ask", href: "/ask" },
    alt: "The top bar of Cuepoint with the page links, the search box and the name and Log out buttons, above the Ask page.",
  },
  {
    id: "ask",
    title: "Ask",
    purpose: "Ask in English, Hindi or Hinglish. Answers use only what was said on the show.",
    callouts: [
      "Type a question, or tap an example. “Find a line” finds a quote you half remember.",
      "Tap a timestamp to hear that exact moment.",
      "Check the sources, or tap a follow-up under “Ask next”.",
    ],
    tryIt: { label: "Ask a question", href: "/ask" },
    alt: "An answered question on the Ask page: the answer with timestamp buttons, the source episodes, follow-up questions and the question box at the bottom.",
  },
  {
    id: "prep",
    title: "Prep brief",
    purpose: "Get ready for an upcoming guest, built only from past episodes.",
    callouts: [
      "Type a name and one line about them, or pick a sector.",
      "Press Build brief. Every line links to its moment.",
      "Copy it, download it as PDF or Word, or save it to reopen later.",
    ],
    tryIt: { label: "Build a brief", href: "/prep" },
    alt: "The Prep brief page: the guest form on the left and a finished brief with its copy, download and save buttons.",
  },
  {
    id: "guests",
    title: "Guests",
    purpose: "Browse every guest and see what they said.",
    callouts: [
      "Search by name or organisation.",
      "Filter by year, language, sort order or sector.",
      "Hover or tap a card for views, length and clips. Open a profile for takeaways, quotes and clips.",
    ],
    tryIt: { label: "Browse guests", href: "/guests" },
    alt: "The Guests page: a search box, year, language and sort filters, sector chips and a grid of guest cards, one open to show its takeaway and numbers.",
  },
  {
    id: "clips",
    title: "Clips + Reels",
    purpose: "Ready-made moments you can search, play and save.",
    callouts: [
      "Search clips, then narrow them by topic, guest, length, year or language.",
      "Tap a clip to play it with a live transcript, and Save it.",
      "Watch as reels: swipe or press ↑ ↓, M mutes, Esc goes back.",
    ],
    tryIt: { label: "Find clips", href: "/clips" },
    alt: "The Clips page: a search box, filters, the Watch as reels button and a grid of clip cards.",
  },
  {
    id: "saved",
    title: "Saved",
    purpose: "Everything you saved, in one place.",
    callouts: [
      "Switch between Clips, Answers and Prep briefs.",
      "Sort what you saved into folders.",
      "Add a note to any item. Saved items stay on this browser.",
    ],
    tryIt: { label: "See saved items", href: "/saved" },
    alt: "The Saved page: folders on the left, tabs for clips, answers and briefs, and saved clips with notes.",
  },
  {
    id: "insights",
    title: "Insights",
    purpose: "The archive in numbers.",
    callouts: [
      "The size of the archive: episodes, guests, hours and clips.",
      "Which topics the show covers, with episodes and clips for each.",
      "Click a topic to see its clips. Further down: guests, views and more.",
    ],
    tryIt: { label: "Open Insights", href: "/insights" },
    alt: "The Insights page: tiles with the size of the archive, then the topics chart and the guests lists.",
  },
];
