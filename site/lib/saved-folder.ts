import { SAVED_LIMITS } from "@/lib/saved-types";

/** A folder name as the page and the server both keep it: control characters out, spaces collapsed, at most 40
    characters; null when nothing is left (no folder). */
export const folderName = (v: unknown): string | null => {
  const f = typeof v === "string" ? v.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, SAVED_LIMITS.folder).trim() : "";
  return f || null;
};
