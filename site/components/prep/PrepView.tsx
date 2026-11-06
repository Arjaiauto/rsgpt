"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { loadBrief, updateBrief } from "@/app/actions/briefs";
import { gradientOf, fmtDay, initialsOf } from "@/lib/guest-format";
import type { Cite as CiteT } from "@/lib/ask/types";
import { fmtTime, youtubeAt, type Clip } from "@/lib/player-types";
import { briefDocx } from "@/lib/prep/docx";
import {
  FIRST_APPEARANCE, NOT_IDENTIFIED, NO_OPPORTUNITIES, UNOFFICIAL, WEB_UNAVAILABLE, briefToText, sectionCounts, sectionHeading, sectionNote, sectionOrder,
  webGroups, webSource, type SectionKey,
} from "@/lib/prep/export";
import { PREP_LIMITS, type Brief, type BriefQuestion, type BriefWeb, type PastBrief, type PrepEvent, type WebEvent } from "@/lib/prep/types";
import { FeedbackButtons } from "@/components/feedback/FeedbackButtons";
import { RunMeta } from "@/components/progress/RunMeta";
import { saveWithUndo } from "@/lib/save-client";
import { toast } from "@/lib/toast";
import { player } from "@/components/player/store";

type Sector = { key: string; label: string; n: number };
type Phase = "idle" | "building" | "done" | "notfound" | "error";
type WebPhase = "idle" | "loading" | "error";

/** Each is ticked when the server finishes it (events from POST /api/prep). */
const STEPS = ["Finding past episodes", "Finding similar guests", "Collecting host questions", "Writing the brief", "Checking citations"];
/** The stages of "Add web research" (events from POST /api/prep/web). */
const WEB_STEPS = ["Searching the web", "Writing the summary", "Checking against sources"];

/* ---------- small pieces ---------- */

/** A line the reader can edit in place. The element is filled in by hand (not by React) so typing is never reset by
    a re-render; the text is committed when it loses focus. Enter commits, Escape goes back, empty is not allowed. */
function Editable({ value, label, disabled, onCommit }: { value: string; label: string; disabled?: boolean; onCommit: (text: string) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && el.textContent !== value) el.textContent = value;
  }, [value]);
  return (
    <span
      ref={ref}
      className="prep-txt"
      role="textbox"
      aria-label={label}
      aria-multiline="true"
      contentEditable={!disabled}
      suppressContentEditableWarning
      spellCheck={false}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e: KeyboardEvent<HTMLSpanElement>) => {
        if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
        else if (e.key === "Escape") { e.currentTarget.textContent = value; e.currentTarget.blur(); }
      }}
      onPaste={(e) => {
        e.preventDefault();
        document.execCommand("insertText", false, e.clipboardData.getData("text/plain").replace(/\s+/g, " "));
      }}
      onBlur={(e) => {
        const text = (e.currentTarget.textContent ?? "").replace(/\s+/g, " ").trim();
        if (!text || text === value) { e.currentTarget.textContent = value; return; }
        onCommit(text);
      }}
    />
  );
}

/** Teal timestamp chip: plays the moment in the shared player; a modified click opens it on YouTube. */
function Chip({ clip, label }: { clip: Clip; label: string }) {
  return (
    <a
      className="prep-cite"
      href={youtubeAt(clip.videoId, clip.startS)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        player.play(clip);
      }}
    >
      {label}
    </a>
  );
}

const citeClip = (key: string, c: CiteT, itemId: string): Clip => ({
  key, itemType: "answer", itemId, videoId: c.videoId, startS: c.startS, endS: Math.max(c.endS, c.startS + 30),
  title: c.episode, guest: c.guest, episode: c.episode, date: c.date, sourcePath: "/prep",
});

function Chips({ cites, id, short }: { cites: CiteT[]; id: string; short?: boolean }) {
  return (
    <>
      {cites.map((c, i) => (
        <Chip key={i} clip={citeClip(`prep:${id}:${i}`, c, id)} label={short ? `${c.date} · ${fmtTime(c.startS)}` : `${c.speaker} · ${c.date} · ${fmtTime(c.startS)}`} />
      ))}
    </>
  );
}

function Remove({ gone, onToggle, what }: { gone: boolean; onToggle: () => void; what: string }) {
  return (
    <button className="prep-rm" type="button" onClick={onToggle} aria-label={gone ? `Undo: bring back ${what}` : `Remove ${what}`} title={gone ? "Undo" : "Remove"}>
      {gone ? "↺" : "×"}
    </button>
  );
}

/* ---------- the page ---------- */

export function PrepView({ sectors, past: pastIn, openId }: { sectors: Sector[]; past: PastBrief[]; openId: number | null }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [sector, setSector] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>(openId ? "building" : "idle");
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [run, setRun] = useState<{ t0: number; eta: number | null }>({ t0: 0, eta: null });
  const [webStep, setWebStep] = useState<1 | 2 | 3>(1);
  const [webRun, setWebRun] = useState<{ t0: number; eta: number | null }>({ t0: 0, eta: null });
  const abortRef = useRef<AbortController | null>(null);
  const webAbortRef = useRef<AbortController | null>(null);
  const [message, setMessage] = useState("");
  const [brief, setBrief] = useState<Brief | null>(null);
  const [past, setPast] = useState(pastIn);
  const [savedId, setSavedId] = useState<number | null>(null);
  /** The qa_log row of the brief just built (for thumbs up/down); none for a brief opened from Saved. */
  const [logId, setLogId] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [webPhase, setWebPhase] = useState<WebPhase>("idle");
  const savedRef = useRef<number | null>(null);
  const opened = useRef<number | null>(null);
  const outRef = useRef<HTMLElement>(null);
  const busy = phase === "building";

  const show = (b: Brief, id: number | null) => {
    setWebPhase("idle");
    setBrief(b);
    setSavedId(id);
    savedRef.current = id;
    setDirty(false);
    setPhase("done");
  };

  // /prep?brief=<id> (from Saved) opens that past brief once.
  useEffect(() => {
    if (!openId || opened.current === openId) return;
    opened.current = openId;
    setLogId(null);
    router.replace("/prep", { scroll: false });
    void loadBrief(openId).then((b) => {
      if (b) show(b, openId);
      else { setPhase("idle"); toast("Couldn't open that brief."); }
    }).catch(() => { setPhase("idle"); toast("Couldn't open that brief."); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  const build = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim() && !sector) { toast("Add a name or pick a sector"); return; }
    setPhase("building");
    setStep(1);
    setRun({ t0: Date.now(), eta: null });
    const abort = new AbortController();
    abortRef.current = abort;
    setBrief(null);
    setLogId(null);
    setSavedId(null);
    savedRef.current = null;
    window.setTimeout(() => outRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 50);
    try {
      const res = await fetch("/api/prep", {
        method: "POST",
        signal: abort.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: desc.trim(), ...(sector ? { sector } : {}) }),
      });
      if (!res.ok || !res.body) {
        toast(res.status === 429 ? "Too many briefs. Wait a few minutes and try again." : "Couldn't build the brief. Try again.");
        setMessage(res.status === 429 ? "Too many briefs in a short time. Wait a few minutes and try again." : "Nothing was lost. Try the brief again.");
        setPhase("error");
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as PrepEvent;
          if (ev.type === "step") setStep(ev.step);
          else if (ev.type === "eta") setRun((r) => ({ ...r, eta: ev.ms }));
          else if (ev.type === "brief") { show(ev.brief, null); finished = true; }
          else if (ev.type === "done") setLogId(ev.logId);
          else if (ev.type === "notfound") { setMessage(ev.message); setPhase("notfound"); finished = true; }
          else if (ev.type === "error") { setMessage("Nothing was lost. Try the brief again."); setPhase("error"); finished = true; }
        }
      }
      if (!finished) { setMessage("Nothing was lost. Try the brief again."); setPhase("error"); }
    } catch {
      if (abort.signal.aborted) return;
      setMessage("Nothing was lost. Try the brief again.");
      setPhase("error");
    }
  };
  const cancelBuild = () => {
    abortRef.current?.abort();
    setPhase("idle");
    toast("Cancelled");
  };

  const pickSector = (key: string) => {
    const on = sector !== key;
    setSector(on ? key : null);
    if (on) { setName(""); setDesc(""); }
  };

  /* ---------- editing ---------- */
  const change = (fn: (b: Brief) => Brief) => { setBrief((b) => (b ? fn(b) : b)); setDirty(true); };
  const edit = (id: string, text: string) => change((b) => ({
    ...b,
    web: b.web && {
      ...b.web,
      background: b.web.background.map((l) => (l.id === id ? { ...l, text } : l)),
      news: b.web.news.map((l) => (l.id === id ? { ...l, text } : l)),
      appearances: b.web.appearances.map((l) => (l.id === id ? { ...l, text } : l)),
      since: b.web.since.map((l) => (l.id === id ? { ...l, text } : l)),
    },
    returning: b.returning && {
      ...b.returning,
      about: b.returning.about.map((l) => (l.id === id ? { ...l, text } : l)),
      asked: b.returning.asked.map((e) => ({ ...e, questions: e.questions.map((q) => (q.id === id ? { ...q, text } : q)) })),
      opportunities: b.returning.opportunities.map((o) => (o.id === id ? { ...o, text } : o)),
    },
    similar: b.similar.map((g) => (g.why.id === id ? { ...g, why: { ...g.why, text } } : g)),
    asked: b.asked.map((q) => (q.id === id ? { ...q, text } : q)),
    suggestions: b.suggestions.map((s) => (s.id === id ? { ...s, text } : s)),
    verify: b.verify.map((v) => (v.id === id ? { ...v, text } : v)),
  }));
  const strike = (id: string) => change((b) => ({ ...b, removed: b.removed.includes(id) ? b.removed.filter((r) => r !== id) : [...b.removed, id] }));

  /* ---------- actions ---------- */
  const copy = async () => {
    if (!brief) return;
    try { await navigator.clipboard.writeText(briefToText(brief)); toast("Brief copied, without removed items"); }
    catch { toast("Copy isn't available here; select the text instead"); }
  };
  const pdf = () => {
    if (!brief) return;
    // The browser names the PDF after the page title.
    const before = document.title;
    document.title = `Prep brief - ${brief.title}`;
    const restore = () => { document.title = before; window.removeEventListener("afterprint", restore); };
    window.addEventListener("afterprint", restore);
    window.print();
  };
  /** "From the web": a separate request after the brief is built, so the brief never waits for it. The section goes
      in at the top; a brief that is already saved then shows "Save changes". */
  const addWeb = async () => {
    if (!brief || webPhase === "loading") return;
    setWebPhase("loading");
    setWebStep(1);
    setWebRun({ t0: Date.now(), eta: null });
    const abort = new AbortController();
    webAbortRef.current = abort;
    try {
      const res = await fetch("/api/prep/web", {
        method: "POST",
        signal: abort.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: brief.title, description: brief.description }),
      });
      if (!res.ok || !res.body) {
        setWebPhase("error");
        if (res.status === 429) {
          const why = (await res.json().catch(() => ({}))) as { error?: string };
          toast(why.error === "site-limit" ? "Web research has reached its limit for today. Try again tomorrow." : "Daily limit for web research reached. Try again tomorrow.");
        }
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let web: BriefWeb | null = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as WebEvent;
          if (ev.type === "step") setWebStep(ev.step);
          else if (ev.type === "eta") setWebRun((r) => ({ ...r, eta: ev.ms }));
          else if (ev.type === "web") web = ev.web;
        }
      }
      if (!web) { setWebPhase("error"); return; }
      const got = web;
      change((b) => ({ ...b, web: got }));
      setWebPhase("idle");
    } catch {
      if (!abort.signal.aborted) setWebPhase("error");
    }
  };
  const cancelWeb = () => {
    webAbortRef.current?.abort();
    setWebPhase("idle");
    toast("Cancelled");
  };
  const word = () => {
    if (!brief) return;
    const blob = new Blob([briefDocx(brief)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Prep brief - ${brief.title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "guest"}.docx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    toast("Word file downloaded, without removed items");
  };
  const save = async () => {
    if (!brief || saving) return;
    setSaving(true);
    try {
      if (savedRef.current != null) {
        const r = await updateBrief(savedRef.current, brief).catch(() => ({ ok: false }));
        if (r.ok) setDirty(false);
        toast(r.ok ? "Brief updated in Past briefs" : "Couldn't save. Try again.");
        return;
      }
      await saveWithUndo(
        { kind: "brief", ref: brief },
        "Saved to Past briefs",
        () => { setPast((p) => p.filter((x) => x.id !== savedRef.current)); savedRef.current = null; setSavedId(null); },
        (id) => {
          savedRef.current = id;
          setSavedId(id);
          setDirty(false);
          setPast((p) => [{ id, title: brief.title, description: brief.description, createdAt: new Date().toISOString() }, ...p]);
        },
      );
    } finally {
      setSaving(false);
    }
  };

  const openPast = async (id: number) => {
    if (busy || id === savedId) return;
    const b = await loadBrief(id).catch(() => null);
    if (!b) { toast("Couldn't open that brief."); return; }
    show(b, id);
    window.setTimeout(() => outRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 50);
  };

  return (
    <>
      <h1 className="prep-h rise">Prep brief<span>for your next guest</span></h1>
      <div className="prep-layout">
        <aside className="prep-side">
          <form className="prep-box prep-form" onSubmit={build}>
            <h2>Upcoming guest</h2>
            <label className="prep-fld" htmlFor="prep-name">Name
              <input id="prep-name" value={name} maxLength={PREP_LIMITS.name} autoComplete="off" placeholder="Nikhil Kamath"
                onChange={(e) => { setName(e.target.value); if (e.target.value) setSector(null); }} />
            </label>
            <label className="prep-fld" htmlFor="prep-desc">One line about them
              <input id="prep-desc" value={desc} maxLength={PREP_LIMITS.description} autoComplete="off" placeholder="Co-founder of Zerodha, investor"
                onChange={(e) => { setDesc(e.target.value); if (e.target.value) setSector(null); }} />
            </label>
            {sectors.length > 0 && (
              <>
                <p className="prep-or">or build from a sector</p>
                <div className="prep-chips" role="group" aria-label="Sector">
                  {sectors.map((s) => (
                    <button key={s.key} className="prep-chip" type="button" aria-pressed={sector === s.key} onClick={() => pickSector(s.key)}>{s.label}</button>
                  ))}
                </div>
              </>
            )}
            <button className="pill pill--primary" type="submit" disabled={busy}>{busy ? "Building…" : "Build brief"}</button>
          </form>

          <div className="prep-box prep-past">
            <h2>Past briefs</h2>
            {past.length === 0 ? (
              <p className="prep-none">Saved briefs show up here, so you can reopen them.</p>
            ) : (
              <div className="prep-pastlist">
                {past.map((p) => (
                  <button key={p.id} type="button" className={`prep-pb${p.id === savedId ? " on" : ""}`} onClick={() => openPast(p.id)} title={p.description || p.title}>
                    <b>{p.title}</b><span>{fmtDay(p.createdAt)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>

        <section className="prep-out" ref={outRef} aria-label="Brief" aria-live="polite">
          {phase === "idle" && (
            <div className="prep-empty rise">
              <b>Your brief will appear here</b>
              <p>Type a name and one line about the guest, or pick a sector. The brief is built only from past episodes: similar guests, the questions the host asked them and the topics already covered. Every line links to its moment.</p>
            </div>
          )}
          {phase === "building" && (
            <div className="prep-build">
              <div className="prep-build-row">
                <div className="prep-wave" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} />)}</div>
                <div className="prep-steps">
                  {STEPS.map((s, i) => <span key={s} className={step > i + 1 ? "done" : step === i + 1 ? "on" : ""}>{s}</span>)}
                </div>
              </div>
              <RunMeta etaMs={run.eta} startedAt={run.t0} stage={STEPS[step - 1]} onCancel={cancelBuild} />
            </div>
          )}
          {(phase === "notfound" || phase === "error") && (
            <div className="prep-nf rise">
              <b>{phase === "notfound" ? "I couldn't build this brief from the episodes." : "Couldn't build the brief."}</b>
              <p>{phase === "notfound" ? `${message} Try a different description, or pick a sector.` : message}</p>
              {phase === "notfound" && <FeedbackButtons key={logId ?? "none"} qaLogId={logId} />}
            </div>
          )}
          {phase === "done" && brief && (
            <BriefDoc brief={brief} edit={edit} strike={strike} web={{ add: addWeb, phase: webPhase, step: webStep, run: webRun, cancel: cancelWeb }} actions={{ copy, pdf, word, save, saved: savedId != null, dirty, saving, logId }} />
          )}
        </section>
      </div>
    </>
  );
}

/* ---------- the document ---------- */

function BriefDoc({ brief: b, edit, strike, web, actions }: {
  brief: Brief;
  edit: (id: string, text: string) => void;
  strike: (id: string) => void;
  web: { add: () => void; phase: WebPhase; step: 1 | 2 | 3; run: { t0: number; eta: number | null }; cancel: () => void };
  actions: { copy: () => void; pdf: () => void; word: () => void; save: () => void; saved: boolean; dirty: boolean; saving: boolean; logId: number | null };
}) {
  const gone = new Set(b.removed);
  const counts = sectionCounts(b);
  // Sections with something in them are numbered 1, 2, 3 ... in order; empty ones are hidden (except a returning
  // guest's opportunities, which say none were found).
  const order = sectionOrder(b);
  const r = b.returning;
  const head = (key: SectionKey) => (
    <>
      <h3>{order.indexOf(key) + 1}. {sectionHeading(key, b)} <i>{counts[key]}</i></h3>
      <p className="prep-why">{sectionNote(key, b)}</p>
    </>
  );
  const row = (id: string, n: number, what: string, body: ReactNode) => (
    <div className={`prep-li${gone.has(id) ? " gone" : ""}`} key={id}>
      <span className="prep-num">{n}</span>
      <div className="prep-body">{body}</div>
      <Remove gone={gone.has(id)} onToggle={() => strike(id)} what={what} />
    </div>
  );

  /** A verified moment of the returning guest's episodes (a question to them, an opportunity they named). */
  const moment = (q: BriefQuestion, n: number, what: string, note?: string) => row(q.id, n, what,
    <>
      <Editable value={q.text} label={what} disabled={gone.has(q.id)} onCommit={(t) => edit(q.id, t)} />
      {note && <>{" "}<span className="prep-to">{note}</span></>}
      <Chip clip={{ key: `prep:${q.id}`, itemType: "insight", itemId: String(q.insightId), videoId: q.videoId, startS: q.startS, endS: q.endS, title: q.text, guest: q.guest, episode: q.episode, date: q.date, sourcePath: "/prep" }}
        label={`${q.date} · ${fmtTime(q.startS)}`} />
    </>,
  );

  const w = b.web;
  const sections: Record<SectionKey, ReactNode> = {
    web: !w ? null : !w.matched ? <p className="prep-none-found">{NOT_IDENTIFIED}</p> : (
      <>
        <p className="prep-matched">Matched: <b>{w.matched}</b></p>
        {webGroups(w).map((g) => (
          <div className="prep-ep" key={g.key}>
            <p className="prep-eph">{g.heading}</p>
            {g.lines.length === 0 && g.empty && <p className="prep-none-found">{g.empty}</p>}
            {g.lines.map((l, i) => row(l.id, i + 1, "web line",
              <>
                <Editable value={l.text} label={g.heading} disabled={gone.has(l.id)} onCommit={(t) => edit(l.id, t)} />
                <a className="prep-cite prep-web" href={l.url} target="_blank" rel="noopener noreferrer nofollow">{webSource(l)}</a>
              </>,
            ))}
          </div>
        ))}
      </>
    ),
    about: (
      <>
        {r?.about.map((l, i) => row(l.id, i + 1, "sentence",
          <>
            <Editable value={l.text} label={`About ${r.name}`} disabled={gone.has(l.id)} onCommit={(t) => edit(l.id, t)} />
            <Chips cites={l.cites} id={l.id} short />
          </>,
        ))}
      </>
    ),
    askedThem: (
      <>
        {r?.asked.map((e) => (
          <div className="prep-ep" key={e.videoId}>
            <p className="prep-eph">{e.episode} <span>{e.date}</span></p>
            {e.questions.map((q, i) => moment(q, i + 1, "question"))}
          </div>
        ))}
      </>
    ),
    opportunities: r?.opportunities.length
      ? <>{r.opportunities.map((o, i) => moment(o, i + 1, "opportunity", o.category))}</>
      : <p className="prep-none-found">{NO_OPPORTUNITIES}</p>,
    similar: (
      <div className="prep-guests">
        {b.similar.map((g) => (
          <div className={`prep-gc${gone.has(g.id) ? " gone" : ""}`} key={g.id}>
            <span className="prep-av" style={{ background: gradientOf(g.name) }} aria-hidden={g.photoUrl ? undefined : true}>
              {g.photoUrl
                // eslint-disable-next-line @next/next/no-img-element -- a 400 px webp already resized by the photo script
                ? <img src={g.photoUrl} alt={g.name} width={40} height={40} loading="lazy" decoding="async" />
                : initialsOf(g.name)}
            </span>
            <Link className="prep-gname" href={`/guests/${g.slug}`}>{g.name}</Link>
            {g.org && <span className="prep-org">{g.org}</span>}
            <div className="prep-why1">
              <Editable value={g.why.text} label={`Why ${g.name} is similar`} disabled={gone.has(g.id)} onCommit={(t) => edit(g.why.id, t)} />
              <span className="prep-chipsrow"><Chips cites={g.why.cites} id={g.why.id} short /></span>
            </div>
            <Remove gone={gone.has(g.id)} onToggle={() => strike(g.id)} what={g.name} />
          </div>
        ))}
      </div>
    ),
    asked: (
      <>
        {b.asked.map((q, i) => row(q.id, i + 1, "question",
          <>
            <Editable value={q.text} label="Question" disabled={gone.has(q.id)} onCommit={(t) => edit(q.id, t)} />
            {" "}<span className="prep-to">to {q.guest}</span>
            <Chip clip={{ key: `prep:${q.id}`, itemType: "insight", itemId: String(q.insightId), videoId: q.videoId, startS: q.startS, endS: q.endS, title: q.text, guest: q.guest, episode: q.episode, date: q.date, sourcePath: "/prep" }}
              label={fmtTime(q.startS)} />
          </>,
        ))}
      </>
    ),
    topics: (
      <div className="prep-topics">
        {b.topics.map((t) => (
          <span className={`prep-tp${gone.has(t.id) ? " gone" : ""}`} key={t.id} title={t.examples.length ? `e.g. ${t.examples.join(", ")}` : undefined}>
            {t.tag}<em>{t.episodes} episode{t.episodes === 1 ? "" : "s"}</em>
            <button type="button" onClick={() => strike(t.id)} aria-label={gone.has(t.id) ? `Undo: bring back ${t.tag}` : `Remove ${t.tag}`}>{gone.has(t.id) ? "↺" : "×"}</button>
          </span>
        ))}
      </div>
    ),
    suggestions: (
      <>
        {b.suggestions.map((s, i) => row(s.id, i + 1, "suggestion",
          <>
            <span className="prep-badge">Suggestion</span>
            <Editable value={s.text} label="Suggested question" disabled={gone.has(s.id)} onCommit={(t) => edit(s.id, t)} />
          </>,
        ))}
      </>
    ),
    verify: (
      <>
        {b.verify.map((v, i) => row(v.id, i + 1, "point to verify",
          <>
            <span className="prep-badge chk">Check</span>
            <Editable value={v.text} label="Point to verify" disabled={gone.has(v.id)} onCommit={(t) => edit(v.id, t)} />
            <Chips cites={v.cites} id={v.id} />
          </>,
        ))}
      </>
    ),
  };

  return (
    <article className="prep-doc rise" id="prep-doc">
      <div className="prep-actions" role="toolbar" aria-label="Brief actions">
        <FeedbackButtons key={actions.logId ?? "none"} qaLogId={actions.logId} />
        <button className="prep-ghost" type="button" onClick={actions.copy}>Copy as text</button>
        <button className="prep-ghost" type="button" onClick={actions.pdf}>Download PDF</button>
        <button className="prep-ghost" type="button" onClick={actions.word}>Download Word</button>
        <button className="prep-ghost pri" type="button" onClick={actions.save} disabled={actions.saving}>
          {actions.saved ? (actions.dirty ? "Save changes" : "Saved ✓") : "Save brief"}
        </button>
      </div>
      <p className="prep-meta">
        Prep brief · {fmtDay(b.builtAt)}{b.preparedFor && ` · prepared for ${b.preparedFor}`}{b.archiveEpisodes > 0 && ` · built from ${b.archiveEpisodes} episodes`}
      </p>
      <h2 className="prep-title">{b.title}</h2>
      {b.description && <p className="prep-sub">{b.description}. Tap any line to edit it, or × to remove it before sharing.</p>}
      {!b.description && <p className="prep-sub">Tap any line to edit it, or × to remove it before sharing.</p>}
      {b.already && (
        <p className="prep-already">
          <b>{b.already.name}</b> has already been on the show ({b.already.episodes} episode{b.already.episodes === 1 ? "" : "s"}). <Link href={`/guests/${b.already.slug}`}>See their profile</Link>
        </p>
      )}
      {!b.already && b.firstAppearance && <p className="prep-first">{FIRST_APPEARANCE}</p>}
      {!b.web && !b.sector && (
        <div className="prep-addweb">
          {web.phase !== "loading" && (
            <button className="prep-ghost" type="button" onClick={web.add}>
              {web.phase === "error" ? "Try web research again" : "Add web research"}
            </button>
          )}
          {web.phase === "loading" ? (
            <>
              <span className="prep-web-steps">{WEB_STEPS.map((s, i) => <span key={s} className={web.step > i + 1 ? "done" : web.step === i + 1 ? "on" : ""}>{s}</span>)}</span>
              <RunMeta etaMs={web.run.eta} startedAt={web.run.t0} stage={WEB_STEPS[web.step - 1]} onCancel={web.cancel} />
            </>
          ) : (
            <span role="status">{web.phase === "error" ? WEB_UNAVAILABLE : "Background, recent news and other interviews, from public web sources. Not from the archive."}</span>
          )}
        </div>
      )}
      {order.map((key) => (
        <Fragment key={key}>
          <div className="prep-sec">{head(key)}{sections[key]}</div>
        </Fragment>
      ))}
      <p className="prep-note">Built only from past episodes. Past questions and sourced lines link to their moment; suggestions are ideas, not facts.</p>
      <p className="prep-print-only">{UNOFFICIAL}</p>
    </article>
  );
}
