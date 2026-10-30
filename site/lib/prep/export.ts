import type { Cite } from "@/lib/ask/types";
import { fmtDay } from "@/lib/guest-format";
import { fmtTime, youtubeAt } from "@/lib/player-types";
import type { Brief } from "./types";

/** A brief as plain sections, for Copy as text and Download Word. Struck-out lines are left out; edited texts are
    already in the brief. Pure, so the page, the .docx writer and the tests share it. */

export const UNOFFICIAL = "Unofficial project, not affiliated with Figuring Out. Every answer links to its source.";

export const citeLabel = (c: Cite) => `${c.speaker} · ${c.date} · ${fmtTime(c.startS)}`;

export type ExportCite = { label: string; url: string };
/** `group`: the item starts a run under this sub-heading (the episode a question was asked in) until the next group. */
export type ExportItem = { text: string; badge?: string; note?: string; group?: string; cites: ExportCite[] };
/** `numbered`: the items are a numbered list (the host's questions), not bullets; numbering restarts in each group.
    `empty`: shown in place of items when the section has none (and is still shown). */
export type ExportSection = { heading: string; note?: string; numbered: boolean; items: ExportItem[]; empty?: string };
/** `already`: the "has already been on the show" line, or the muted first-appearance line (`alreadyMuted`). */
export type BriefExport = { title: string; subtitle: string; meta: string; already: string; alreadyMuted: boolean; sections: ExportSection[]; footer: string[] };

const cites = (list: Cite[]): ExportCite[] => list.map((c) => ({ label: citeLabel(c), url: youtubeAt(c.videoId, c.startS) }));
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Heading of a section by its key (see sectionHeading); sections are numbered 1, 2, 3 ... in this order. The first
    three are only for a guest who has been on the show before. */
export const SECTION_HEADINGS = {
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

export const sectionHeading = (key: SectionKey, b: Brief) => (key === "about" ? `About ${b.returning?.name ?? b.title}` : SECTION_HEADINGS[key]);

/** How many items each section has. "Opportunities they mentioned" counts as present for a returning guest even with
    none found, so the page can say so. */
export function sectionCounts(b: Brief): Record<SectionKey, number> {
  const r = b.returning;
  return {
    about: r?.about.length ?? 0,
    askedThem: r?.asked.reduce((n, e) => n + e.questions.length, 0) ?? 0,
    opportunities: r?.opportunities.length ?? 0,
    similar: b.similar.length, asked: b.asked.length, topics: b.topics.length, suggestions: b.suggestions.length, verify: b.verify.length,
  };
}

/** The sections the page shows, in order (the page numbers them 1, 2, 3 ...). */
export function sectionOrder(b: Brief): SectionKey[] {
  const counts = sectionCounts(b);
  return (Object.keys(SECTION_HEADINGS) as SectionKey[]).filter((k) => counts[k] > 0 || (k === "opportunities" && !!b.returning));
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
  const raw: [SectionKey, ExportItem[]][] = [
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
  const sections = raw.filter(([key, items]) => items.length || (key === "opportunities" && noneFound)).map(([key, items], i) => ({
    heading: `${i + 1}. ${sectionHeading(key, b)}`, note: SECTION_NOTES[key], numbered: key === "asked" || key === "askedThem", items,
    ...(items.length ? {} : { empty: NO_OPPORTUNITIES }),
  }));
  return {
    title: b.title,
    subtitle: b.description,
    meta: ["Prep brief", fmtDay(b.builtAt), b.preparedFor && `prepared for ${b.preparedFor}`, b.archiveEpisodes && `built from ${b.archiveEpisodes} episodes`].filter(Boolean).join(" · "),
    already: b.already ? `${b.already.name} has already been on the show (${plural(b.already.episodes, "episode")}).` : b.firstAppearance ? FIRST_APPEARANCE : "",
    alreadyMuted: !b.already && b.firstAppearance,
    sections,
    footer: ["Built only from past episodes. Past questions and sourced lines link to their moment; suggestions are ideas, not facts.", UNOFFICIAL],
  };
}

/** The brief as text for the clipboard (and the qa_log row): every sourced line ends with its timestamps and links. */
export function briefToText(b: Brief): string {
  const x = briefExport(b);
  const out = [x.title, x.subtitle, x.meta, x.already].filter(Boolean);
  for (const s of x.sections) {
    out.push("", s.heading);
    if (s.empty) out.push(s.empty);
    for (const i of s.items) {
      if (i.group) out.push(i.group);
      const tail = i.cites.map((c) => ` [${c.label} ${c.url}]`).join("");
      out.push(`- ${i.badge ? `${i.badge.toUpperCase()}: ` : ""}${i.text}${i.note ? ` (${i.note})` : ""}${tail}`);
    }
  }
  out.push("", ...x.footer);
  return out.join("\n");
}
