/** Guest names for display. Verified guest rows always win; when an episode has none, the name is read from the
    episode title, and only if the title has no name does it fall back to "Guest". Shared by Ask, Guests and Clips. */

/** Words that mark a title part as a company, role or topic rather than a person's name. */
const NOT_A_NAME = new Set([
  "founder", "co-founder", "cofounder", "ceo", "cfo", "cto", "md", "chairman", "expert", "doctor", "coach", "official",
  "care", "sciences", "science", "studio", "studios", "fm", "skin", "bank", "capital", "ventures", "labs", "foods",
  "insurance", "india", "technologies", "tech", "group", "media", "network", "finance", "health", "hospital", "clinic",
  "podcast", "episode", "raj", "shamani", "the", "and", "&", "of", "on", "in", "with", "how", "why", "what",
]);
const TITLES = /^(dr|mr|mrs|ms|prof|col|maj|gen|capt|lt|sir|adv|ca|swami|sadhguru)\.?$/i;

function looksLikeName(part: string): boolean {
  const words = part.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 5 || part.length > 40) return false;
  if (/[@#\d:?!,]/.test(part)) return false;
  let nameWords = 0;
  for (const w of words) {
    const bare = w.replace(/[.'’]/g, "");
    if (NOT_A_NAME.has(bare.toLowerCase())) return false;
    if (TITLES.test(w)) continue;
    if (!/^\p{Lu}/u.test(bare)) return false;
    nameWords += 1;
  }
  return nameWords >= 1 && (nameWords >= 2 || words.length >= 2);
}

const clean = (s: string) => s.replace(/^(ft\.?|feat\.?|featuring|with)\s+/i, "").replace(/\s+/g, " ").trim();

/**
 * The guest's name from an episode title, or null. Titles look like
 *   "Smartest Way To Use AI: Powerful Words | Sowmay Jain | FO439 Raj Shamani"   -> "Sowmay Jain"
 *   "Men's Rights, Dowry & Divorce - Vikas Nagwan | FO274 Raj Shamani"            -> "Vikas Nagwan"
 *   "PARA SFs, Indian Army & Dangerous Missions ft. Col. Shivender Kanwar | FO 239" -> "Col. Shivender Kanwar"
 * The part just before "FO<number>" is used (skipping one one-word company tag like "| Multipl |"): a whole "|"
 * part if it is a name, else the text after its last " - " or "ft.". Company names, roles, @handles and one-word
 * names are not used, since a one-word part is as often a company ("Wegofin") as a person.
 */
export function guestNameFromTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const parts = title.split("|").map((p) => p.trim()).filter(Boolean);
  let fo = parts.findIndex((p) => /\bFO\s?\d+/i.test(p));
  if (fo < 0) fo = parts.length;
  // A part made only of the episode number and the host's name ends the title; the guest is just before it.
  const tail = parts[fo] ? parts[fo].replace(/\bFO\s?\d+\b.*$/i, "").trim() : "";
  const candidates: string[] = [];
  if (tail) candidates.push(tail);
  // The part before FO; if that is a one-word company tag ("| Multipl |"), also the part before it.
  const look = [fo - 1];
  if (fo - 2 >= 0 && parts[fo - 1] && !/\s/.test(parts[fo - 1])) look.push(fo - 2);
  for (const i of look) {
    if (i < 0) continue;
    const p = parts[i];
    if (i > 0) candidates.push(p);
    const dash = p.split(/\s[-–—]\s?/);
    if (dash.length > 1) candidates.push(dash[dash.length - 1]);
    const ft = p.match(/\b(?:ft\.?|feat\.?|featuring)\s+(.+)$/i);
    if (ft) candidates.push(ft[1]);
  }
  for (const c of candidates) {
    const name = clean(c);
    if (looksLikeName(name)) return name;
  }
  return null;
}

/** Verified guest names joined, else the name in the title, else "Guest". */
export function guestDisplayName(verifiedNames: string[], title: string | null | undefined): string {
  return verifiedNames.join(", ") || guestNameFromTitle(title) || "Guest";
}
