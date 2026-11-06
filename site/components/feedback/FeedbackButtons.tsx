"use client";

import { useId, useRef, useState, useTransition, type FormEvent } from "react";
import { sendFeedback, type Rating } from "@/app/actions/feedback";
import { IconThumbDown, IconThumbUp } from "@/components/Icons";
import { toast } from "@/lib/toast";

/** Thumbs up / down on an answer or brief (a qa_log row). A vote can be changed; after a thumbs-down an optional
    one-line "What was wrong?" (200 characters, Send / Skip) opens. Renders nothing without a qa_log id (the log insert
    failed). */
export function FeedbackButtons({ qaLogId }: { qaLogId: number | null }) {
  const [vote, setVote] = useState<Rating | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [noteSent, setNoteSent] = useState(false);
  const [live, setLive] = useState("");
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  if (qaLogId == null) return null;

  /** Saves the vote; `then` runs only when it was saved (a failure shows its reason and changes nothing). */
  const save = (rating: Rating, text: string | undefined, then: () => void) =>
    start(async () => {
      const res = await sendFeedback({ qaLogId, rating, note: text });
      if (!res.ok) { toast(res.error); return; }
      setLive("Thanks for the feedback");
      then();
    });

  const choose = (rating: Rating) => {
    if (pending || vote === rating) return;
    save(rating, undefined, () => {
      setVote(rating);
      setNoteSent(false);
      if (rating === "down") {
        setAsking(true);
        window.setTimeout(() => input.current?.focus(), 30);
      } else {
        setAsking(false);
        setNote("");
      }
    });
  };

  const sendNote = (e: FormEvent) => {
    e.preventDefault();
    const text = note.trim();
    if (!text) { setAsking(false); return; }
    save("down", text, () => { setAsking(false); setNoteSent(true); });
  };

  return (
    <div className="fb" role="group" aria-label="Was this helpful?">
      <button className="fb__btn" type="button" aria-pressed={vote === "up"} aria-label="Helpful" title="Helpful" onClick={() => choose("up")}>
        <IconThumbUp />
      </button>
      <button className="fb__btn" type="button" aria-pressed={vote === "down"} aria-label="Not helpful" title="Not helpful" onClick={() => choose("down")}>
        <IconThumbDown />
      </button>
      {asking && (
        <form className="fb__form" onSubmit={sendNote}>
          <label htmlFor={id} className="sr">What was wrong?</label>
          <input
            ref={input}
            id={id}
            className="fb__input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setAsking(false); }}
            placeholder="What was wrong? (optional)"
            maxLength={200}
            autoComplete="off"
          />
          <button className="fb__send" type="submit" disabled={pending}>Send</button>
          <button className="fb__skip" type="button" onClick={() => setAsking(false)}>Skip</button>
        </form>
      )}
      {noteSent && <span className="fb__done">Noted</span>}
      <span className="sr" role="status" aria-live="polite">{live}</span>
    </div>
  );
}
