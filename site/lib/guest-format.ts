/** Display helpers for the Guests pages. Pure, so server and client code can both use them. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IST_OFFSET_MS = 5.5 * 3600_000;

/** Calendar parts of an ISO timestamp in India time, where the episodes are dated. */
function ist(iso: string) {
  const d = new Date(Date.parse(iso) + IST_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
}

/** "Mar 2025" */
export function fmtMonth(iso: string | null): string {
  if (!iso) return "";
  const { y, m } = ist(iso);
  return `${MONTHS[m]} ${y}`;
}

/** "14 Mar 2025" */
export function fmtDay(iso: string | null): string {
  if (!iso) return "";
  const { y, m, d } = ist(iso);
  return `${d} ${MONTHS[m]} ${y}`;
}

export const yearOf = (iso: string | null): number | null => (iso ? ist(iso).y : null);

/** "4.8M", "310K", "950" */
export function fmtViews(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** "1h 48m", "48m" */
export function fmtLength(seconds: number | null): string {
  if (!seconds) return "–";
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

/** The language shown for an episode (caption_language en or hi; Hindi episodes are written in Roman Hinglish). */
export const languageLabel = (code: string | null): string => (code === "hi" ? "Hindi" : "English");

const TITLES = new Set(["dr", "prof", "professor", "mr", "mrs", "ms", "shri", "smt", "sri", "adv", "ca", "col", "maj", "major", "sir"]);

/** Words of a name without titles such as Dr or Col. */
const nameWords = (name: string) => {
  const words = name.replace(/\(.*?\)/g, " ").split(/\s+/).filter(Boolean);
  while (words.length > 1 && TITLES.has(words[0].replace(/\./g, "").toLowerCase())) words.shift();
  return words;
};

/** "Dr S Jaishankar" -> "SJ"; "Khan Sir" -> "KS" */
export function initialsOf(name: string): string {
  const w = nameWords(name);
  const ini = (w[0]?.[0] ?? "") + (w.length > 1 ? w[w.length - 1][0] : "");
  return ini.toUpperCase() || "G";
}

/** Sort key for A to Z: the name without titles, accents folded. */
export const sortName = (name: string): string =>
  nameWords(name).join(" ").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Lower case, accents folded: what search compares. */
export const fold = (s: string): string => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** A gradient generated from the name, for guests without a photo. */
export function gradientOf(name: string): string {
  let h = 7;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `linear-gradient(150deg, hsl(${h} 42% 36%), hsl(${(h + 40) % 360} 48% 16%))`;
}

/** A sector tag for display: first letter up, the rest as written, so acronyms stay ("enterprise AI" is "Enterprise
    AI", "FMCG" stays). A first word with capitals inside it (iPhone, eCommerce) is a name and is left as it is. */
export const tagLabel = (raw: string): string =>
  (/^\p{Ll}\S*\p{Lu}/u.test(raw) ? raw : raw.charAt(0).toUpperCase() + raw.slice(1));

/** The opportunity categories (insights.category check constraint) as readable headings, in display order. */
export const CATEGORY_LABELS: Record<string, string> = {
  growing_sectors: "Growing sectors",
  business_ideas: "Business ideas",
  market_gaps: "Market gaps",
  underrated_skills: "Underrated skills",
  career_paths: "Career paths",
  investment_themes: "Investment themes",
  hiring_signals: "Hiring signals",
  policy_shifts: "Policy shifts",
  geographic_opportunities: "Geographic opportunities",
  tools_and_tech: "Tools and tech",
  contrarian_takes: "Contrarian takes",
  resources: "Resources",
  warnings: "Warnings",
};
export const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);
export const categoryLabel = (c: string | null): string =>
  (c && CATEGORY_LABELS[c]) || (c ? c.replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase()) : "Other");

/**
 * Splits a disagreement into the host's side and the guest's side. The extraction writes one sentence or two,
 * e.g. "Raj asks why ..., and the guest says ..." or "Raj says ... The guest says ...". Returns null when the text
 * does not have both sides in that shape, so the page shows it whole instead of guessing.
 */
export function splitDisagreement(text: string): { host: string; guest: string } | null {
  const mark = (re: RegExp) => {
    const m = re.exec(text);
    return m ? m.index + m[1].length : -1;
  };
  // A side starts at the start of the text, after a full stop, or after ", and" / ", but" / ", while" / ", whereas".
  const start = (word: string) => new RegExp(`(^|[.;]\\s+|,\\s*(?:and|but|while|whereas)\\s+)(?=${word}\\b)`, "i");
  const raj = mark(start("raj")), guest = mark(start("the guest"));
  if (raj < 0 || guest < 0 || raj === guest) return null;
  const tidy = (s: string) => {
    const t = s.replace(/[\s,;]+$/, "").replace(/\s*\b(and|but|while|whereas)$/i, "").replace(/[\s,;]+$/, "").trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
  };
  const [a, b] = raj < guest ? [text.slice(raj, guest), text.slice(guest)] : [text.slice(guest, raj), text.slice(raj)];
  const [host, who] = raj < guest ? [tidy(a), tidy(b)] : [tidy(b), tidy(a)];
  return host && who ? { host, guest: who } : null;
}
