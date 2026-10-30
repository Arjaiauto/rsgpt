import type { Cite } from "@/lib/ask/types";
import { fmtDay } from "@/lib/guest-format";
import { fmtTime, youtubeAt } from "@/lib/player-types";
import type { Brief, BriefWeb, WebLine } from "./types";

/** A brief as plain sections, for Copy as text and Download Word. Struck-out lines are left out; edited texts are
    already in the brief. Pure, so the page, the .docx writer and the tests share it. */

export const UNOFFICIAL = "Unofficial project, not affiliated with Figuring Out. Every answer links to its source.";

export const citeLabel = (c: Cite) => `${c.speaker} · ${c.date} · ${fmtTime(c.startS)}`;

/** `showUrl`: the address is printed, not only linked (web sources, so a printed page says where a line came from). */
export type ExportCite = { label: string; url: string; showUrl?: boolean };
/** `group`: the item starts a run under this sub-heading (the episode a question was asked in) until the next group. */
export type ExportItem = { text: string; badge?: string; note?: string; group?: string; muted?: boolean; cites: ExportCite[] };
/** `numbered`: the items are a numbered list (the host's questions), not bullets; numbering restarts in each group.
    `lead`: a line shown before the items ("Matched: ..."). `empty`: shown in place of items when the section has none
    (and is still shown). */
export type ExportSection = { heading: string; note?: string; lead?: string; numbered: boolean; items: ExportItem[]; empty?: string };
/** `already`: the "has already been on the show" line, or the muted first-appearance line (`alreadyMuted`). */
export type BriefExport = { title: string; subtitle: string; meta: string; already: string; alreadyMuted: boolean; sections: ExportSection[]; footer: string[] };

const cites = (list: Cite[]): ExportCite[] => list.map((c) => ({ label: citeLabel(c), url: youtubeAt(c.videoId, c.startS) }));
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Heading of a section by its key (see sectionHeading); sections are numbered 1, 2, 3 ... in this order. The first
    three are only for a guest who has been on the show before. */
export const SECTION_HEADINGS = {
  web: "From the web",
  about: "About",
  askedThem: "Already asked to them",
  opportunities: "Opportunities they mentioned",
  similar: "Similar past guests",
  asked: "What the host asked them",
  topics: "Topics already covered",
  suggestions: "Suggested new questions",
  verify: "Points to verify before recording",
} as const;
export type SectionKey = keyof typeof SECTION_HEADINGS;
export const SECTION_NOTES: Record<SectionKey, string> = {
  web: "From public web sources. Not from the podcast archive.",
  about: "From their own past episodes. Every sentence links to its moment.",
  askedThem: "The host's questions to them in past episodes, so they are not asked again.",
  opportunities: "Sectors, ideas, careers, markets and skills they pointed to as opportunities.",
  similar: "Past guests whose episodes are closest to this one.",
  asked: "Real questions from past episodes. Tap a timestamp to hear how it went.",
  topics: "Number of past episodes with a guest in each sector, so you can avoid repeats.",
  suggestions: "Suggestions from the gaps in past episodes, not facts.",
  verify: "Claims from past episodes that may have changed or depend on facts outside the archive.",
};

export const NO_OPPORTUNITIES = "None found in past episodes.";
export const FIRST_APPEARANCE = "First appearance. No past episodes in the archive.";

export const NOT_IDENTIFIED = "Couldn't confidently identify this person on the web.";
export const NOTHING_SINCE = "Nothing new found since their last episode.";
export const WEB_UNAVAILABLE = "Web research unavailable right now. Try again.";

/** The note under a heading; "From the web" says when it was checked. */
export const sectionNote = (key: SectionKey, b: Brief) =>
  (key === "web" && b.web ? `From public web sources, checked ${fmtDay(b.web.checkedAt)}. Not from the podcast archive.` : SECTION_NOTES[key]);

/** The sub-sections of "From the web" that have lines, in order; "Since their last episode" also when it is empty. */
export function webGroups(w: BriefWeb): { key: string; heading: string; lines: WebLine[]; empty?: string }[] {
  if (!w.matched) return [];
  const groups: { key: string; heading: string; lines: WebLine[]; empty?: string }[] = [
    { key: "background", heading: "Background", lines: w.background },
    { key: "news", heading: "Recent news", lines: w.news },
    { key: "appearances", heading: "Other interviews and appearances", lines: w.appearances },
  ];
  if (w.lastEpisode) groups.push({ key: "since", heading: `Since their last episode (${fmtDay(w.lastEpisode)})`, lines: w.since, empty: NOTHING_SINCE });
  return groups.filter((g) => g.lines.length || g.empty);
}

/** A web line's source as a label: the site, and the page's date when the search gave one. */
export const webSource = (l: WebLine) => [hostOf(l.url), l.date && fmtDay(l.date)].filter(Boolean).join(" · ");
const hostOf = (url: string) => {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
};

export const sectionHeading = (key: SectionKey, b: Brief) => (key === "about" ? `About ${b.returning?.name ?? b.title}` : SECTION_HEADINGS[key]);

/** How many items each section has. "Opportunities they mentioned" counts as present for a returning guest even with
    none found, so the page can say so. */
export function sectionCounts(b: Brief): Record<SectionKey, number> {
  const r = b.returning, w = b.web;
  return {
    web: w ? w.background.length + w.news.length + w.appearances.length + w.since.length : 0,
    about: r?.about.length ?? 0,
    askedThem: r?.asked.reduce((n, e) => n + e.questions.length, 0) ?? 0,
    opportunities: r?.opportunities.length ?? 0,
    similar: b.similar.length, asked: b.asked.length, topics: b.topics.length, suggestions: b.suggestions.length, verify: b.verify.length,
  };
}

/** The sections the page shows, in order (the page numbers them 1, 2, 3 ...). */
export function sectionOrder(b: Brief): SectionKey[] {
  const counts = sectionCounts(b);
  return (Object.keys(SECTION_HEADINGS) as SectionKey[]).filter((k) => counts[k] > 0 || (k === "opportunities" && !!b.returning) || (k === "web" && !!b.web));
}

const momentCite = (q: { guest: string; date: string; startS: number; videoId: string }): ExportCite =>
  ({ label: `${q.guest} · ${q.date} · ${fmtTime(q.startS)}`, url: youtubeAt(q.videoId, q.startS) });

/** "Aseem Ghavri described..." becomes "Aseem Ghavri (Org) described..."; a line that does not open with the name gets "Name, Org: " in front. */
const guestLine = (name: string, org: string | null, text: string) =>
  text.startsWith(`${name} `) ? `${name}${org ? ` (${org})` : ""}${text.slice(name.length)}` : `${name}${org ? `, ${org}` : ""}: ${text}`;

export function briefExport(b: Brief): BriefExport {
  const gone = new Set(b.removed);
  const keep = <T extends { id: string }>(items: T[]) => items.filter((i) => !gone.has(i.id));
  const r = b.returning;
  const webItems: ExportItem[] = b.web ? webGroups(b.web).flatMap((g): ExportItem[] => {
    const lines = keep(g.lines);
    if (!lines.length) return g.empty && !g.lines.length ? [{ text: g.empty, group: g.heading, muted: true, cites: [] }] : [];
    return lines.map((l, i) => ({ text: l.text, group: i === 0 ? g.heading : undefined, cites: [{ label: webSource(l), url: l.url, showUrl: true }] }));
  }) : [];
  const raw: [SectionKey, ExportItem[]][] = [
    ["web", webItems],
    ["about", keep(r?.about ?? []).map((l) => ({ text: l.text, cites: cites(l.cites) }))],
    ["askedThem", (r?.asked ?? []).flatMap((e) => keep(e.questions).map((q, i) => ({
      text: q.text, group: i === 0 ? `${e.episode} (${e.date})` : undefined, cites: [momentCite(q)],
    })))],
    ["opportunities", keep(r?.opportunities ?? []).map((o) => ({ text: o.text, note: o.category, cites: [momentCite(o)] }))],
    ["similar", keep(b.similar).map((g) => ({ text: guestLine(g.name, g.org, g.why.text), cites: cites(g.why.cites) }))],
    ["asked", keep(b.asked).map((q) => ({
      text: q.text, note: `to ${q.guest}`, cites: [momentCite(q)],
    }))],
    ["topics", keep(b.topics).map((t) => ({ text: t.tag, note: plural(t.episodes, "episode"), cites: [] }))],
    ["suggestions", keep(b.suggestions).map((s) => ({ text: s.text, badge: "Suggestion", cites: [] }))],
    ["verify", keep(b.verify).map((v) => ({ text: v.text, badge: "Check", cites: cites(v.cites) }))],
  ];
  // Struck-out lines are left out, and a section left with none is too; "none found" opportunities stay, as on the page.
  const noneFound = !!r && r.opportunities.length === 0;
  // "From the web" stays once added: it says who was matched, or that no one could be.
  const sections = raw.filter(([key, items]) => items.length || (key === "opportunities" && noneFound) || (key === "web" && !!b.web)).map(([key, items], i): ExportSection => ({
    heading: `${i + 1}. ${sectionHeading(key, b)}`, note: sectionNote(key, b), numbered: key === "asked" || key === "askedThem", items,
    ...(key === "web" && b.web?.matched ? { lead: `Matched: ${b.web.matched}` } : {}),
    ...(items.length || (key === "web" && b.web?.matched) ? {} : { empty: key === "web" ? NOT_IDENTIFIED : NO_OPPORTUNITIES }),
  }));
  return {
    title: b.title,
    subtitle: b.description,
    meta: ["Prep brief", fmtDay(b.builtAt), b.preparedFor && `prepared for ${b.preparedFor}`, b.archiveEpisodes && `built from ${b.archiveEpisodes} episodes`].filter(Boolean).join(" · "),
    already: b.already ? `${b.already.name} has already been on the show (${plural(b.already.episodes, "episode")}).` : b.firstAppearance ? FIRST_APPEARANCE : "",
    alreadyMuted: !b.already && b.firstAppearance,
    sections,
    footer: [
      b.web
        ? "Built from past episodes, plus the public web sources linked under \"From the web\". Past questions and sourced lines link to their moment; suggestions are ideas, not facts."
        : "Built only from past episodes. Past questions and sourced lines link to their moment; suggestions are ideas, not facts.",
      UNOFFICIAL,
    ],
  };
}

/** The brief as text for the clipboard (and the qa_log row): every sourced line ends with its timestamps and links. */
export function briefToText(b: Brief): string {
  const x = briefExport(b);
  const out = [x.title, x.subtitle, x.meta, x.already].filter(Boolean);
  for (const s of x.sections) {
    out.push("", s.heading);
    if (s.heading.endsWith(SECTION_HEADINGS.web) && s.note) out.push(s.note);
    if (s.lead) out.push(s.lead);
    if (s.empty) out.push(s.empty);
    for (const i of s.items) {
      if (i.group) out.push(i.group);
      const tail = i.cites.map((c) => ` [${c.label} ${c.url}]`).join("");
      if (i.muted) { out.push(i.text); continue; }
      out.push(`- ${i.badge ? `${i.badge.toUpperCase()}: ` : ""}${i.text}${i.note ? ` (${i.note})` : ""}${tail}`);
    }
  }
  out.push("", ...x.footer);
  return out.join("\n");
}
