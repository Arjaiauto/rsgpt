"use client";

import { saveItem, unsaveItem } from "@/app/actions/saved";
import type { SaveInput } from "@/lib/saved-types";
import { toast } from "@/lib/toast";

/** Saves, then shows a toast with Undo (which deletes the row). Resolves true when saved; `onUndo` runs after Undo. */
export async function saveWithUndo(input: SaveInput, message: string, onUndo?: () => void): Promise<boolean> {
  const res = await saveItem(input).catch(() => null);
  if (!res || !res.ok) {
    toast(res && !res.ok ? res.error : "Couldn't save. Try again.");
    return false;
  }
  toast(message, { undo: () => { void unsaveItem(res.id); onUndo?.(); } });
  return true;
}
