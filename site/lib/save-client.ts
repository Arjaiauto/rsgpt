"use client";

import { saveItem, unsaveItem } from "@/app/actions/saved";
import type { SaveInput } from "@/lib/saved-types";
import { toast } from "@/lib/toast";

/** Saves, then shows a toast with Undo (which deletes the row). Resolves true when saved; `onSaved` gets the new row's id
    and `onUndo` runs after Undo. */
export async function saveWithUndo(input: SaveInput, message: string, onUndo?: () => void, onSaved?: (id: number) => void): Promise<boolean> {
  const res = await saveItem(input).catch(() => null);
  if (!res || !res.ok) {
    toast(res && !res.ok ? res.error : "Couldn't save. Try again.");
    return false;
  }
  onSaved?.(res.id);
  toast(message, { undo: () => { void unsaveItem(res.id); onUndo?.(); } });
  return true;
}
