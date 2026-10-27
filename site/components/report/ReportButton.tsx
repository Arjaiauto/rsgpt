"use client";

import { useRef, useState, useTransition } from "react";
import { usePathname } from "next/navigation";
import { sendReport } from "@/app/actions/report";
import { fmtTime } from "@/lib/player-types";
import { REPORT_REASONS, type ReportItem } from "@/lib/report-types";
import { toast } from "@/lib/toast";
import { IconFlag, IconX } from "@/components/Icons";

/** Flag button + "Report an error" popup (a bottom sheet under 820px). */
export function ReportButton({ item, compact = false, variant }: { item: ReportItem; compact?: boolean; variant?: "link" }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const path = usePathname();
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [reported, setReported] = useState(false);
  const [pending, start] = useTransition();

  const open = () => { setReason(""); setNote(""); setError(""); dialogRef.current?.showModal(); };
  const close = () => dialogRef.current?.close();

  const send = () =>
    start(async () => {
      const res = await sendReport({
        itemType: item.itemType, itemId: item.itemId, videoId: item.videoId, startS: item.startS, reason, note, page: path,
      });
      if (!res.ok) { setError(res.error); return; }
      close();
      setReported(true);
      toast("Reported. Thanks, it goes to the review queue.");
    });

  const where = [item.episode, item.title, item.startS != null ? fmtTime(item.startS) : ""].filter(Boolean).join(" · ");

  return (
    <>
      {variant === "link" ? (
        <button className="linkbtn" type="button" onClick={open} disabled={reported}>
          {reported ? "Reported" : "Report an error"}
        </button>
      ) : compact ? (
        <button className="ib" type="button" onClick={open} disabled={reported} aria-label={reported ? "Reported" : "Report an error"}>
          <IconFlag />
        </button>
      ) : (
        <button className="pill pill--ghost" type="button" onClick={open} disabled={reported}>
          <IconFlag />{reported ? "Reported" : "Report"}
        </button>
      )}
      <dialog
        ref={dialogRef}
        className="sheet"
        aria-labelledby="rep-title"
        onClick={(e) => { if (e.target === dialogRef.current) close(); }}
      >
        <form onSubmit={(e) => { e.preventDefault(); if (reason && !pending) send(); }}>
          <div className="dh">
            <div>
              <h2 id="rep-title">Report an error</h2>
              <p>{where}</p>
            </div>
            <button className="ib" type="button" onClick={close} aria-label="Close"><IconX /></button>
          </div>
          <fieldset className="db">
            <legend className="sr">Reason</legend>
            {REPORT_REASONS.map((r) => (
              <label className="opt" key={r.label}>
                <input type="radio" name="reason" value={r.label} checked={reason === r.label} onChange={() => setReason(r.label)} />
                <span>{r.label}{r.hint && <small>{r.hint}</small>}</span>
              </label>
            ))}
          </fieldset>
          <div className="db">
            <label htmlFor="rep-note" className="db__label">Note (optional)</label>
            <textarea
              id="rep-note"
              maxLength={280}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="E.g. the quote starts about 20 seconds later"
            />
            <div className="cnt num" aria-live="polite">{note.length} / 280</div>
          </div>
          <div className="df">
            <span className={`note${error ? " err" : ""}`} role={error ? "alert" : undefined}>
              {error || "Goes to the review queue. The item stays visible until checked."}
            </span>
            <button className="pill pill--ghost" type="button" onClick={close}>Cancel</button>
            <button className="pill pill--primary pill--sm" type="submit" disabled={!reason || pending}>
              {pending ? "Sending…" : "Send report"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
