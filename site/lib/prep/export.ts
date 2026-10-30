import type { Cite } from "@/lib/ask/types";
import { fmtDay } from "@/lib/guest-format";
import { fmtTime, youtubeAt } from "@/lib/player-types";
import type { Brief } from "./types";

/** A brief as plain sections, for Copy as text and Download Word. Struck-out lines are left out; edited texts are
    already in the brief. Pure, so the page, the .docx writer and the tests share it. */

export const UNOFFICIAL = "Unofficial project, not affiliated with Figuring Out. Every answer links to its source.";

export const citeLabel = (c: Cite) => `${c.speaker} · ${c.date} · ${fmtTime(c.startS)}`;

export type ExportCite = { label: string; url: string };
export type ExportItem = { text: string; badge?: string; note?: string; cites: ExportCite[] };
/** `numbered`: the items are a numbered list (the host's questions), not bullets. */
export type ExportSection = { heading: string; note?: string; numbered: boolean; items: ExportItem[] };
export type BriefExport = { title: string; subtitle: string; meta: string; already: string; sections: ExportSection[]; footer: string[] };

const cites = (list: Cite[]): ExportCite[] => list.map((c) => ({ label: citeLabel(c), url: youtubeAt(c.videoId, c.startS) }));
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Heading of a section by its key; the page numbers the sections that have something in them, 1 to 5. */
export const SECTION_HEADINGS = {
  similar: "Similar past guests",
  asked: "What the host asked them",
  topics: "Topics already covered",
  suggestions: "Suggested new questions",
  verify: "Points to verify before recording",
} as const;
export type SectionKey = keyof typeof SECTION_HEADINGS;
export const SECTION_NOTES: Record<SectionKey, string> = {
  similar: "Past guests whose episodes are closest to this one.",
  asked: "Real questions from past episodes. Tap a timestamp to hear how it went.",
  topics: "Number of past episodes with a guest in each sector, so you can avoid repeats.",
  suggestions: "Suggestions from the gaps in past episodes, not facts.",
  verify: "Claims from past episodes that may have changed or depend on facts outside the archive.",
};

/** "Aseem Ghavri described..." becomes "Aseem Ghavri (Org) described..."; a line that does not open with the name gets "Name, Org: " in front. */
const guestLine = (name: string, org: string | null, text: string) =>
  text.startsWith(`${name} `) ? `${name}${org ? ` (${org})` : ""}${text.slice(name.length)}` : `${name}${org ? `, ${org}` : ""}: ${text}`;

export function briefExport(b: Brief): BriefExport {
  const gone = new Set(b.removed);
  const keep = <T extends { id: string }>(items: T[]) => items.filter((i) => !gone.has(i.id));
  const raw: [SectionKey, ExportItem[]][] = [
    ["similar", keep(b.similar).map((g) => ({ text: guestLine(g.name, g.org, g.why.text), cites: cites(g.why.cites) }))],
    ["asked", keep(b.asked).map((q) => ({
      text: q.text, note: `to ${q.guest}`, cites: [{ label: `${q.guest} · ${q.date} · ${fmtTime(q.startS)}`, url: youtubeAt(q.videoId, q.startS) }],
    }))],
    ["topics", keep(b.topics).map((t) => ({ text: t.tag, note: plural(t.episodes, "episode"), cites: [] }))],
    ["suggestions", keep(b.suggestions).map((s) => ({ text: s.text, badge: "Suggestion", cites: [] }))],
    ["verify", keep(b.verify).map((v) => ({ text: v.text, badge: "Check", cites: cites(v.cites) }))],
  ];
  const sections = raw.filter(([, items]) => items.length).map(([key, items], i) => ({
    heading: `${i + 1}. ${SECTION_HEADINGS[key]}`, note: SECTION_NOTES[key], numbered: key === "asked", items,
  }));
  return {
    title: b.title,
    subtitle: b.description,
    meta: ["Prep brief", fmtDay(b.builtAt), b.preparedFor && `prepared for ${b.preparedFor}`, b.archiveEpisodes && `built from ${b.archiveEpisodes} episodes`].filter(Boolean).join(" · "),
    already: b.already ? `${b.already.name} has already been on the show (${plural(b.already.episodes, "episode")}).` : "",
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
    for (const i of s.items) {
      const tail = i.cites.map((c) => ` [${c.label} ${c.url}]`).join("");
      out.push(`- ${i.badge ? `${i.badge.toUpperCase()}: ` : ""}${i.text}${i.note ? ` (${i.note})` : ""}${tail}`);
    }
  }
  out.push("", ...x.footer);
  return out.join("\n");
}
