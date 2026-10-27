"use client";

import { useEffect, useState } from "react";
import { FIND_LINE } from "@/lib/ask/config";
import type { LineMatch, LineRow } from "@/lib/ask/types";
import { fmtTime, youtubeAt, type Clip } from "@/lib/player-types";
import { toast } from "@/lib/toast";
import { ClipPlayer } from "@/components/player/ClipPlayer";
import { player } from "@/components/player/store";
import { ReportButton } from "@/components/report/ReportButton";

/** The steps shown while the database is searched (no counts: they would be hard-coded numbers, rule 9). */
const STEPS = ["Searching every transcript line", "Allowing for spelling and caption errors", "Lining up the clip on that second"];

export function LineThinking() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = [window.setTimeout(() => setStep(1), 600), window.setTimeout(() => setStep(2), 1150)];
    return () => t.forEach(window.clearTimeout);
  }, []);
  return (
    <div className="think" role="status">
      <div className="wave" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} />)}</div>
      <div className="steps">
        {STEPS.map((s, i) => <span key={s} className={step > i ? "done" : step === i ? "on" : ""}>{s}</span>)}
      </div>
    </div>
  );
}

const clipAt = (turnId: string, m: LineMatch, line: LineRow): Clip => ({
  key: `ask:${turnId}:line:${line.segmentId}`,
  itemType: "clip",
  itemId: `line:${line.segmentId}`,
  videoId: m.videoId,
  startS: line.startS,
  endS: line.startS + FIND_LINE.clipSeconds,
  title: m.episode,
  guest: m.guest,
  episode: m.episode,
  date: m.date,
  sourcePath: "/ask",
});

export function LineAnswer({ turnId, match: m, busy, onAsk }: { turnId: string; match: LineMatch; busy: boolean; onAsk: (q: string) => void }) {
  const hit = m.lines.find((l) => l.segmentId === m.hitId) ?? m.lines[0];
  // The line the clip starts on: the matched line until a transcript line is tapped.
  const [at, setAt] = useState(hit.segmentId);
  const start = m.lines.find((l) => l.segmentId === at) ?? hit;
  const clip = clipAt(turnId, m, start);
  const pct = Math.round(m.similarity * 100);

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(youtubeAt(m.videoId, hit.startS)); } catch {}
    toast("Link to this moment copied");
  };

  return (
    <div className="exact rise">
      <div className="exact__head">
        <span className={`found${m.exact ? "" : " near"}`}>{m.exact ? "Exact line found" : "Closest line"} · {pct}% match</span>
        <span className="qmeta">{[m.guest, m.date].filter(Boolean).join(" · ")} · said at <span className="ts">{fmtTime(hit.startS)}</span></span>
      </div>
      <ClipPlayer key={clip.key} clip={clip} label={start === hit ? (m.exact ? "Starts on the line" : "Starts on the closest line") : `Starts at ${fmtTime(start.startS)}`} />
      <p className="lbl">Transcript around this moment · tap a line to start there</p>
      <div className="tx">
        {m.lines.map((l) => (
          <button
            key={l.segmentId}
            className={`tx__l${l.segmentId === hit.segmentId ? " hit" : ""}${l.segmentId === at && at !== hit.segmentId ? " sel" : ""}`}
            type="button"
            onClick={() => {
              setAt(l.segmentId);
              player.play(clipAt(turnId, m, l));
              toast(`Clip now starts at ${fmtTime(l.startS)}`);
            }}
          >
            <span className="tx__t">{fmtTime(l.startS)}</span>
            <span className="tx__s">{l.speaker}</span>
            <span>
              {l.speaker && <em className="tx__sm">{l.speaker}: </em>}
              {l.segmentId === hit.segmentId ? <mark>{l.text}</mark> : l.text}
            </span>
          </button>
        ))}
      </div>
      {!m.exact && <p className="note">Not word for word: the captions may have heard a few words differently. Tap another line if this isn&apos;t the one.</p>}
      {m.guest !== "Guest" && (
        <div className="chips">
          <button className="chip chip--follow" type="button" disabled={busy} onClick={() => onAsk(`What else did ${m.guest} say about this?`)}>
            What else did {m.guest} say about this?
          </button>
        </div>
      )}
      <div className="acts">
        <button className="linkbtn" type="button" onClick={copyLink}>Copy link to this moment</button>
        <ReportButton variant="link" item={{ itemType: "clip", itemId: `line:${hit.segmentId}`, videoId: m.videoId, startS: hit.startS, episode: m.episode, title: m.episode }} />
      </div>
    </div>
  );
}
