/** Content of the Future updates deck (/future, design/FRONTEND_DESIGN.md page 9): static text, no data. The deck is
    the intro slide, one slide per feature, and the closing offer. Slide numbers in the URL (#slide-4) start at 1.
    "Built" means it works in this demo today; everything else on the slides is a proposal for a team version. No figure
    from the archive is written here (rule 9): counts of episodes, clips and so on belong to the pages that count them. */

export type Glyph =
  | "upload" | "wave" | "brain" | "search" | "doc" | "globe" | "flag" | "clip" | "mic" | "tablet" | "pen" | "check"
  | "map" | "user" | "chat" | "chart" | "lang" | "tag" | "shield";

export type Step = { icon: Glyph; title: string; note: string };
export type Link = { label: string; href: string };

export type Feature = {
  title: string;
  tag: string;
  problem: string;
  how: string;
  who: string;
  time: string;
  steps: Step[];
  /** Rows of "in this demo" against "with raw files" (slide 1). */
  compare?: { label: string; demo: string; team: string }[];
  /** A made-up illustration, shown as one (slide 3). */
  illustration?: { clip: string; full: string };
  /** A dashed note under the flow. */
  note?: string;
  /** What already works in this demo for this idea, with where to try it. */
  built?: { text: string; links: Link[] };
};

export const FEATURES: Feature[] = [
  {
    title: "Add any podcast or raw footage",
    tag: "Bring in a new show, a new episode the day it's recorded, or Figuring Out's raw studio files, and every Cuepoint tool works on it.",
    problem: "Cuepoint only covers the YouTube episodes it was built on, from YouTube's own captions, and it can only link back to YouTube.",
    how: "Upload audio or video, or paste a channel. The best transcriber is picked per language (Hindi, English, Hinglish) and runs on the raw audio, then the same checked pipeline runs. Clips are cut from the raw video files.",
    who: "Whole team",
    time: "3-4 weeks",
    steps: [
      { icon: "upload", title: "Upload raw files or a channel", note: "Studio audio and video, or a YouTube link" },
      { icon: "wave", title: "Word-perfect transcript from the raw audio", note: "Best transcriber per language: Hindi, English or Hinglish" },
      { icon: "check", title: "Checked extraction", note: "Quotes, timestamps and numbers verified" },
      { icon: "clip", title: "Search it, and cut real clips", note: "Ask, guests, briefs and insights, plus clips exported as video files" },
    ],
    compare: [
      { label: "Clips", demo: "Link to the moment on YouTube. No video file is made.", team: "The actual clip, start to end, cut from the raw footage and ready to edit." },
      { label: "Transcripts", demo: "Built from YouTube's automatic captions, which can get words, names and numbers wrong.", team: "A word-perfect transcript from the raw audio, so quotes, names and numbers are right." },
    ],
    built: {
      text: "The whole archive is searchable in English, Hindi and Hinglish, and every answer links to its moment.",
      links: [{ label: "Try Ask", href: "/ask" }],
    },
  },
  {
    title: "Deep guest research",
    tag: "A research agent on the Claude API that studies an upcoming guest from several angles and writes a briefing in minutes.",
    problem: "Good guest research takes hours, and angles get missed.",
    how: "It reads public sources about the guest, compares them with what past guests said, and runs fixed frameworks: career arc, numbers to verify, contrarian views, what the audience will ask.",
    who: "Research team",
    time: "2-3 weeks",
    steps: [
      { icon: "user", title: "Guest name + context", note: "Plus any links the team already has" },
      { icon: "globe", title: "Reads public sources", note: "Interviews, articles, filings, with links kept" },
      { icon: "brain", title: "Runs research frameworks", note: "Career arc, controversies, numbers, contrarian angles" },
      { icon: "doc", title: "Cited research brief", note: "Every claim linked to its source" },
    ],
    built: {
      text: "A Prep brief already joins the guest's past episodes with a short web search (background, recent news, other interviews), every line with its source link. The team version goes deeper, with the frameworks above.",
      links: [{ label: "Try Prep brief", href: "/prep" }],
    },
  },
  {
    title: "Context guard",
    tag: "An AI agent that finds clips of the show posted by others and flags the ones that cut away the context.",
    problem: "Short clips reposted by other creators can make a point mean the opposite of what was said.",
    how: "The agent searches platforms for reposted clips, matches each one to the exact moment in the archive, compares the clip with the full conversation around it, and flags the ones that change the meaning for the team to review.",
    who: "Leadership, legal, social",
    time: "5-6 weeks",
    steps: [
      { icon: "search", title: "Find reposted clips", note: "Searches YouTube first, other platforms where their rules allow" },
      { icon: "clip", title: "Match to the original", note: "Locates the exact second in the archive" },
      { icon: "brain", title: "Compare with full context", note: "Did the cut change what was meant?" },
      { icon: "flag", title: "Flag for the team", note: "Side by side: the clip vs the full moment" },
    ],
    illustration: { clip: "“Loyalty is bad.”", full: "Said about staying loyal to an organisation that doesn't give you your due." },
    built: {
      text: "Find a line on Ask already finds the exact archive moment for any line you remember, which is the first step of matching a reposted clip.",
      links: [{ label: "Try Find a line", href: "/ask" }],
    },
  },
  {
    title: "Live recording copilot",
    tag: "A tablet screen during the shoot that surfaces related past moments and sharper follow-up questions as the guest speaks.",
    problem: "The best follow-up questions are often thought of after the recording.",
    how: "It listens to the live conversation, searches the archive in the background, and shows short prompts: a past guest who said the opposite, a number to check, a question not yet asked.",
    who: "Host, producers",
    time: "4 weeks",
    steps: [
      { icon: "mic", title: "Listens live", note: "Live transcript during the recording" },
      { icon: "search", title: "Searches the archive", note: "Every few seconds, in the background" },
      { icon: "tablet", title: "Quiet prompts on a tablet", note: "One line each, easy to ignore" },
    ],
    built: {
      text: "Before the shoot, a Prep brief already shows which questions the host asked similar guests, so they are not repeated.",
      links: [{ label: "Try Prep brief", href: "/prep" }],
    },
  },
  {
    title: "Repurpose studio",
    tag: "For every clip, a first draft of the reel hook, caption, title and thumbnail text, in English and Hindi.",
    problem: "Writing hooks and captions for every clip takes the social team hours a day.",
    how: "Pick a clip; Cuepoint drafts three hooks, captions in English and Hindi, a title and thumbnail text, all from what was actually said. The team edits and posts.",
    who: "Social, editing",
    time: "2 weeks",
    steps: [
      { icon: "clip", title: "Pick a clip", note: "A saved clip or a search result" },
      { icon: "pen", title: "Draft hooks and captions", note: "3 options, English and Hindi" },
      { icon: "check", title: "Team edits and approves", note: "Nothing posts automatically" },
    ],
    built: {
      text: "Clips can already be saved from any player into folders with notes, and exported as a CSV with their YouTube links.",
      links: [{ label: "Open Saved", href: "/saved" }],
    },
  },
  {
    title: "Fact-check before publish",
    tag: "Flags names, numbers and claims in a new episode that need checking before it goes live.",
    problem: "A wrong name, number or claim in a published episode is hard to take back.",
    how: "After recording, Cuepoint lists every number, name and factual claim with its timestamp, marks the ones it could not confirm, and links sources for the rest.",
    who: "Research, editing",
    time: "3 weeks",
    steps: [
      { icon: "wave", title: "New episode transcribed", note: "Before it is published" },
      { icon: "search", title: "Finds checkable claims", note: "Numbers, names, dates, facts" },
      { icon: "shield", title: "Checklist with timestamps", note: "Confirmed, unclear, or needs a source" },
    ],
    built: {
      text: "A Prep brief already lists claims from past episodes to verify before recording, each with its timestamp.",
      links: [{ label: "Try Prep brief", href: "/prep" }],
    },
  },
  {
    title: "Guest ideas from gaps",
    tag: "A map of every topic the show has covered, and suggested guests for the topics it hasn't.",
    problem: "Choosing the next guests without a clear view of what's already covered.",
    how: "Topics from all episodes are grouped into a map sized by how often they come up and how they perform. Thin areas get suggested guest profiles to look for.",
    who: "Research, leadership",
    time: "2 weeks",
    steps: [
      { icon: "map", title: "Topic map of the archive", note: "Sized by coverage and performance" },
      { icon: "chart", title: "Finds the gaps", note: "Topics audiences want but the show rarely covers" },
      { icon: "user", title: "Suggested guest profiles", note: "The kind of guest to book, with reasons" },
    ],
    built: {
      text: "A Prep brief already shows which topics past episodes cover for a type of guest, and suggests questions the archive has not asked.",
      links: [{ label: "Try Prep brief", href: "/prep" }],
    },
  },
  {
    title: "Audience comment insights",
    tag: "Reads the comments on every episode to find what viewers want next and which moments they quote.",
    problem: "Thousands of comments per episode, and nobody can read them all.",
    how: "Comments are pulled through the YouTube Data API, grouped into themes, and matched to the moments viewers mention. A weekly summary shows requests, praise and complaints.",
    who: "Content, leadership",
    time: "2 weeks",
    steps: [
      { icon: "chat", title: "Pull every comment", note: "Official YouTube Data API" },
      { icon: "brain", title: "Group into themes", note: "Requests, praise, complaints, quoted moments" },
      { icon: "chart", title: "Weekly summary", note: "With links to the comments behind each theme" },
    ],
  },
  {
    title: "Regional language subtitles",
    tag: "Subtitles and short summaries in Tamil, Telugu, Bengali, Marathi and more, so episodes reach all of India.",
    problem: "Hindi and English leave most of India's languages out.",
    how: "Checked transcripts are translated into regional languages, kept in sync with the timestamps, and exported as subtitle files plus a short summary per episode.",
    who: "Social, growth",
    time: "3 weeks",
    steps: [
      { icon: "wave", title: "Checked transcript", note: "With exact timestamps" },
      { icon: "lang", title: "Translate per language", note: "Tamil, Telugu, Bengali, Marathi, more" },
      { icon: "doc", title: "Subtitles + summaries", note: "Ready-to-upload subtitle files" },
    ],
    built: {
      text: "Hindi episodes are already kept in Roman script with a line-by-line English translation, each line with its timestamp.",
      links: [{ label: "Try Ask in Hindi", href: "/ask" }],
    },
  },
  {
    title: "Sponsor match + brand safety",
    tag: "Matches brands to the right episodes and checks that each episode is safe for that brand.",
    problem: "Matching sponsors to episodes is done by hand, with brand risk checked by memory.",
    how: "Pick a brand or category; Cuepoint lists matching episodes with views and topics, and flags moments a brand may want to avoid, each with a timestamp.",
    who: "Partnerships",
    time: "3 weeks",
    steps: [
      { icon: "tag", title: "Pick a brand or category", note: "e.g. fintech, health, travel" },
      { icon: "search", title: "Matching episodes", note: "With views, audience and topics" },
      { icon: "shield", title: "Brand safety check", note: "Flagged moments with timestamps" },
    ],
  },
];

/** What already works in this demo, for the intro slide. */
export const LIVE_TODAY: Link[] = [
  { label: "Ask, with cited clips", href: "/ask" },
  { label: "Find a line", href: "/ask" },
  { label: "Guest profiles", href: "/guests" },
  { label: "Prep brief with guest history", href: "/prep" },
  { label: "Prep brief: From the web", href: "/prep" },
  { label: "Saved clips, answers and briefs", href: "/saved" },
];

/** The Context guard slide points at a real moment, found with the archive's search rather than written from memory,
    and read in the transcript on 2026-10-31: in Sandeep Das's episode the guest raises the worry that short clips cut
    from a long podcast spread without their context (from 2:12:18), and the host answers that it is a valid fear
    because of how many people the show reaches (2:13:09). Nothing from it is quoted on the slide. */
export const CONTEXT_MOMENT = {
  key: "future:context-guard",
  videoId: "JOsrihef5gM",
  startS: 7938, // 2:12:18
  endS: 8025, // 2:13:45
  episode: "Power of Office Politics, Salary Negotiation & Career Growth | Sandeep Das | FO455 Raj Shamani",
  guest: "Sandeep Das",
  date: "Jan 2026",
} as const;

export const CLOSING = {
  title: "Built on your raw files,",
  soft: "with your team",
  offer: [
    "Every feature here gets better on Figuring Out's own raw recordings: word-perfect transcripts, real clips cut from the footage, and no YouTube limits.",
    "With access to your YouTube Analytics, Insights can show watch time and retention: which moments viewers re-watch or drop off, matched to clip timestamps.",
    "I'd start with whichever one saves the team the most hours, ship it in weeks, and measure it. I'm also happy to rebuild this whole demo on Figuring Out's raw files.",
    "This demo stays private, and I'll take it down whenever you ask.",
  ],
  disclaimer: "Unofficial project, not affiliated with Figuring Out.",
};

export type SlideInfo = { title: string; kind: "intro" | "feature" | "close"; feature?: Feature; n?: number };

/** The deck in order: the intro, one slide per feature, the closing offer. */
export const SLIDES: SlideInfo[] = [
  { title: "What Cuepoint could do next", kind: "intro" },
  ...FEATURES.map((f, i): SlideInfo => ({ title: f.title, kind: "feature", feature: f, n: i + 1 })),
  { title: CLOSING.title + " " + CLOSING.soft, kind: "close" },
];
