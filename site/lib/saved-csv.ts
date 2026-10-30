import { youtubeAt } from "@/lib/player-types";
import type { SavedClip } from "@/lib/saved-types";

/** Saved clips as a CSV file for a spreadsheet: one row per clip with its title, guest, episode, date, start and end
    (in seconds, so a spreadsheet does not turn "1:03" into a time of day), a YouTube link at the start, folder and note.
    Pure, so the page and the test script share it. Notes and titles are typed or extracted text, so a cell that opens
    with = + - @ (a formula in Excel and Sheets) gets a quote in front, and the file starts with a byte-order mark so
    Excel reads Hindi and other non-English text correctly. */

const HEADER = ["Title", "Guest", "Episode", "Date", "Start (s)", "End (s)", "YouTube link", "Folder", "Note"];

const cell = (v: string | number): string => {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function savedClipsCsv(clips: Pick<SavedClip, "title" | "guest" | "episode" | "date" | "startS" | "endS" | "videoId" | "folder" | "note">[]): string {
  const rows = clips.map((c) => [
    c.title, c.guest, c.episode, c.date, Math.round(c.startS), Math.round(c.endS), youtubeAt(c.videoId, c.startS), c.folder ?? "", c.note,
  ]);
  return `﻿${[HEADER, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}
