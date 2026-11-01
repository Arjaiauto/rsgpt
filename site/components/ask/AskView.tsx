"use client";

import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { EXAMPLE_QUESTIONS, HOST_NAME } from "@/lib/ask/config";
import { isQuoted, unquote } from "@/lib/ask/quote";
import type { AskEvent, AskLanguage, Cite, FindLineResult, LineMatch, RefMoment, Source } from "@/lib/ask/types";
import { fmtTime, youtubeAt, type Clip } from "@/lib/player-types";
import { saveWithUndo } from "@/lib/save-client";
import { toast } from "@/lib/toast";
import { ClipPlayer } from "@/components/player/ClipPlayer";
import { getPlayer, player } from "@/components/player/store";
import { ReportButton } from "@/components/report/ReportButton";
import { RunMeta } from "@/components/progress/RunMeta";
import { LineAnswer, LineThinking } from "./LineAnswer";

type Block = { text: string; cites: Cite[] };
type Turn = {
  id: string;
  q: string;
  /** "line": a Find a line turn (database only, no answer text). */
  kind?: "line";
  line?: LineMatch;
  status: "thinking" | "answering" | "done" | "notfound" | "error";
  /** Name of the guest whose episodes this question was limited to (asked from a guest page). */
  scope?: string;
  step: 1 | 2 | 3 | 4;
  /** Median duration of recent answers in ms (from the server) and when this one started, for the time left. */
  eta?: number;
  t0: number;
  moments?: number;
  episodes?: number;
  language?: AskLanguage;
  ref?: RefMoment;
  blocks: Block[];
  sources: Source[];
  followups: string[];
  suggestions: string[];
  /** Not found because too little of the answer could be cited (rule 2), rather than no match at all. */
  thin?: boolean;
  answerId: number | null;
  /** "block:cite" of the timestamp chip whose clip is open under its sentence. */
  open?: string;
};

const STORE = "cp-ask-thread";
const load = (): Turn[] => {
  try {
    const t = JSON.parse(sessionStorage.getItem(STORE) ?? "[]") as Turn[];
    return t.filter((x) => x.status === "done" || x.status === "notfound");
  } catch { return []; }
};

/** A question can be limited to one guest's episodes (the "Ask about this guest" box on a guest page). */
type Scope = { slug: string; name: string };
const SCOPE_STORE = "cp-ask-scope";
const loadScope = (): Scope | null => {
  try {
    const s = JSON.parse(sessionStorage.getItem(SCOPE_STORE) ?? "null") as Partial<Scope> | null;
    return s && typeof s.slug === "string" && typeof s.name === "string" ? { slug: s.slug, name: s.name } : null;
  } catch { return null; }
};

function ScopeBar({ scope, onClear, disabled }: { scope: Scope; onClear: () => void; disabled: boolean }) {
  return (
    <div className="scopebar" role="status">
      <span>Searching only <b>{scope.name}</b>&apos;s episodes</span>
      <button className="linkbtn" type="button" onClick={onClear} disabled={disabled}>Search all episodes</button>
    </div>
  );
}

// Threads kept in sessionStorage before 21b say "Host".
const citeLabel = (c: Cite) => `${c.speaker === "Host" ? HOST_NAME : c.speaker} · ${c.date} · ${fmtTime(c.startS)}`;

const clipOf = (key: string, m: { videoId: string; startS: number; endS: number; episode: string; guest: string; date: string }, minLen = 30): Clip => ({
  key, itemType: "answer", itemId: key, videoId: m.videoId, startS: m.startS, endS: Math.max(m.endS, m.startS + minLen),
  title: m.episode, guest: m.guest, episode: m.episode, date: m.date, sourcePath: "/ask",
});

/** Initials on a colour generated from the name (no photos). */
function Initials({ name }: { name: string }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const parts = name.split(/[\s,]+/).filter(Boolean);
  const ini = ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "G";
  return <span className="src__ini" style={{ background: `linear-gradient(140deg, hsl(${h} 55% 42%), hsl(${(h + 40) % 360} 55% 30%))` }}>{ini}</span>;
}

const LINE_ICON = "M9.5 6C6.5 7 5 9.4 5 12.5V18h5v-5H7.6c.2-1.9 1.2-3.2 2.9-4zM18.5 6c-3 1-4.5 3.4-4.5 6.5V18h5v-5h-2.4c.2-1.9 1.2-3.2 2.9-4z";

function Composer({ docked, busy, onAsk, autoFocus, lineMode, onLineMode }: {
  docked?: boolean; busy: boolean; onAsk: (q: string, line?: boolean) => void; autoFocus?: boolean; lineMode: boolean; onLineMode: (on: boolean) => void;
}) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    if (!q || busy) return;
    onAsk(q, lineMode);
    setValue("");
  };
  const quoted = isQuoted(value);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <form className="composer" onSubmit={submit}>
      <button
        className="modebtn"
        type="button"
        aria-pressed={lineMode || quoted}
        title="Find the exact moment a line was said"
        onClick={() => {
          onLineMode(!lineMode);
          toast(lineMode ? "Back to asking questions" : "Find a line is on: type words you remember");
          inputRef.current?.focus();
        }}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={LINE_ICON} /></svg><span>Find a line</span>
      </button>
      <label htmlFor={docked ? "ask-follow" : "ask-first"} className="sr">{docked ? "Ask a follow-up" : "Your question"}</label>
      <input
        ref={inputRef}
        id={docked ? "ask-follow" : "ask-first"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={lineMode ? (docked ? "Type a line you remember" : "Type a line you remember from an episode") : docked ? "Ask a follow-up" : "What have founders said about raising their first round?"}
        autoComplete="off"
        maxLength={400}
        autoFocus={autoFocus}
      />
      <button className="send" type="submit" aria-label="Ask" disabled={busy}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
      </button>
    </form>
  );
}

/** The names of the stages, each ticked when the server finishes it. */
function stagesOf(turn: Turn): string[] {
  return [
    turn.scope ? `Searching ${turn.scope}’s episodes` : "Searching 500 episodes",
    turn.moments != null ? `Found ${turn.moments} moments in ${turn.episodes} episodes` : "Finding the moments",
    "Writing the answer",
    "Checking citations",
  ];
}

function Thinking({ turn, onCancel }: { turn: Turn; onCancel: () => void }) {
  const stages = stagesOf(turn);
  const cls = (n: number) => (turn.step > n ? "done" : turn.step === n ? "on" : "");
  return (
    <div className="think think--run">
      <div className="think-row">
        <div className="wave" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} />)}</div>
        <div className="steps">
          {stages.map((s, i) => <span key={i} className={cls(i + 1)}>{s}</span>)}
        </div>
      </div>
      <RunMeta etaMs={turn.eta ?? null} startedAt={turn.t0} stage={stages[turn.step - 1]} onCancel={onCancel} />
    </div>
  );
}

export function AskView() {
  const router = useRouter();
  const params = useSearchParams();
  const [turns, setTurns] = useState<Turn[]>(load);
  const startedQ = useRef<string | null>(null);
  const [lineMode, setLineMode] = useState(false);
  const [scope, setScope] = useState<Scope | null>(loadScope);
  const busy = turns.some((t) => t.status === "thinking" || t.status === "answering");

  useEffect(() => {
    try { sessionStorage.setItem(STORE, JSON.stringify(turns.filter((t) => t.status === "done" || t.status === "notfound"))); } catch {}
  }, [turns]);

  useEffect(() => {
    try {
      if (scope) sessionStorage.setItem(SCOPE_STORE, JSON.stringify(scope));
      else sessionStorage.removeItem(SCOPE_STORE);
    } catch {}
  }, [scope]);

  /** The request of each running question, so Cancel can stop it. */
  const running = useRef(new Map<string, AbortController>());
  const cancel = (id: string) => {
    running.current.get(id)?.abort();
    running.current.delete(id);
    setTurns((all) => all.filter((t) => t.id !== id));
    toast("Cancelled");
  };

  const patch = (id: string, fn: (t: Turn) => Turn) => setTurns((all) => all.map((t) => (t.id === id ? fn(t) : t)));

  const apply = (t: Turn, e: AskEvent): Turn => {
    switch (e.type) {
      case "eta": return { ...t, eta: e.ms };
      case "step": return { ...t, step: e.step, moments: e.moments ?? t.moments, episodes: e.episodes ?? t.episodes };
      case "found": return { ...t, sources: e.sources, language: e.language };
      // The best-matching moment arrives with the search results; the first cited moment replaces it, unless the
      // reader is already playing it.
      case "ref": return t.ref && getPlayer().clip?.key === `ask:${t.id}:ref` ? t : { ...t, ref: e.ref };
      case "text": {
        const blocks = [...t.blocks];
        while (blocks.length <= e.block) blocks.push({ text: "", cites: [] });
        blocks[e.block] = { ...blocks[e.block], text: blocks[e.block].text + e.text };
        return { ...t, status: "answering", blocks };
      }
      case "cite": {
        const blocks = [...t.blocks];
        while (blocks.length <= e.block) blocks.push({ text: "", cites: [] });
        blocks[e.block] = { ...blocks[e.block], cites: [...blocks[e.block].cites, e.cite] };
        return { ...t, blocks };
      }
      case "sources": return { ...t, sources: e.sources };
      case "notfound": return { ...t, status: "notfound", suggestions: e.suggestions, language: e.language, thin: e.thin, blocks: [], ref: undefined };
      case "done": return { ...t, status: t.status === "notfound" ? "notfound" : "done", answerId: e.answerId, followups: e.followups };
      case "error": return { ...t, status: "error" };
      default: return t;
    }
  };

  /** Find a line: the database only, no Claude call. */
  const findLine = async (id: string, query: string) => {
    try {
      const res = await fetch("/api/find-line", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
      if (!res.ok) {
        toast(res.status === 429 ? "Too many searches. Wait a few minutes and try again." : "Couldn't reach the archive. Try again.");
        patch(id, (t) => ({ ...t, status: "error" }));
        return;
      }
      const r = (await res.json()) as FindLineResult;
      patch(id, (t) => (r.status === "found" ? { ...t, status: "done", line: r.match } : { ...t, status: "notfound" }));
    } catch {
      patch(id, (t) => ({ ...t, status: "error" }));
    }
  };

  /** `inScope` limits the question to a guest's episodes (default: the current scope); `fresh` ignores earlier questions. */
  const ask = async (q: string, line = false, inScope: Scope | null = scope, fresh = false) => {
    if (busy) return;
    const asLine = line || isQuoted(q);
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const earlier = fresh ? [] : turns.map((t) => t.q).slice(-3);
    const turn: Turn = { id, q: asLine ? unquote(q) : q, kind: asLine ? "line" : undefined, scope: !asLine ? inScope?.name : undefined, status: "thinking", step: 1, t0: Date.now(), blocks: [], sources: [], followups: [], suggestions: [], answerId: null };
    setTurns((all) => (fresh ? [turn] : [...all, turn]));
    window.setTimeout(() => document.getElementById(`turn-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 50);
    if (asLine) return findLine(id, q);
    const abort = new AbortController();
    running.current.set(id, abort);
    try {
      const res = await fetch("/api/ask", { method: "POST", signal: abort.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q, earlier, ...(inScope ? { guest: inScope.slug } : {}) }) });
      if (!res.ok || !res.body) {
        const msg = res.status === 429 ? "Too many questions. Wait a few minutes and try again." : "Couldn't reach the archive. Try again.";
        toast(msg);
        patch(id, (t) => ({ ...t, status: "error" }));
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const e = JSON.parse(line) as AskEvent;
          if (e.type === "debug") continue;
          patch(id, (t) => apply(t, e));
        }
      }
      patch(id, (t) => (t.status === "thinking" || t.status === "answering" ? { ...t, status: t.blocks.length ? "done" : "error" } : t));
    } catch {
      if (!abort.signal.aborted) patch(id, (t) => ({ ...t, status: "error" }));
    } finally {
      running.current.delete(id);
    }
  };

  // /ask?q=... from quick search asks straight away (once), then clears the URL.
  // With guest=<slug> (from a guest page) the question is limited to that guest's episodes; a different scope than
  // the thread's starts a fresh thread, and a question without a guest searches everything.
  const q = params.get("q")?.trim();
  const guestSlug = params.get("guest");
  const guestName = params.get("gn");
  useEffect(() => {
    if (!q || startedQ.current === q) return;
    startedQ.current = q;
    const next: Scope | null = guestSlug && /^[a-z0-9-]{1,120}$/.test(guestSlug)
      ? { slug: guestSlug, name: (guestName ?? "").trim().slice(0, 80) || "this guest" }
      : null;
    const fresh = next?.slug !== scope?.slug;
    setScope(next);
    router.replace("/ask", { scroll: false });
    void ask(q, false, next, fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const reset = () => { setTurns([]); setLineMode(false); window.scrollTo({ top: 0 }); };

  if (!turns.length) {
    return (
      <section className="ask-empty">
        {scope ? (
          <h1 className="ask-h rise">Ask about {scope.name}<span>using only their episodes</span></h1>
        ) : (
          <h1 className="ask-h rise">Ask anything from 500 episodes<span>in English, Hindi or Hinglish</span></h1>
        )}
        <div className="rise d1">
          {scope && <ScopeBar scope={scope} onClear={() => setScope(null)} disabled={busy} />}
          <Composer busy={busy} onAsk={ask} autoFocus lineMode={lineMode} onLineMode={setLineMode} />
        </div>
        {!scope && (
          <div className="chips rise d2">
            {EXAMPLE_QUESTIONS.map((x) => (
              <button key={x} className="chip" type="button" onClick={() => ask(x)} lang={/[ऀ-ॿ]/.test(x) ? "hi" : undefined}>{x}</button>
            ))}
          </div>
        )}
      </section>
    );
  }

  return (
    <>
      <section className="thread">
        {turns.map((t, i) => (
          <article className="turn" key={t.id} id={`turn-${t.id}`}>
            {i === 0 ? <h1 className="q1">{t.kind === "line" ? `“${t.q}”` : t.q}</h1> : <h2 className="qn">{t.kind === "line" ? `“${t.q}”` : t.q}</h2>}
            {t.kind === "line" && t.status === "thinking" && <LineThinking />}
            {t.kind === "line" && t.status === "notfound" && (
              <div className="nf rise">
                <b>I couldn&apos;t find that line in the episodes.</b>
                <p>Check the spelling, try a shorter part of the line you remember, or ask about the topic instead.</p>
                <div className="chips"><button className="chip chip--follow" type="button" onClick={() => ask(t.q)} disabled={busy}>{t.q.length > 60 ? `${t.q.slice(0, 57)}…` : t.q}</button></div>
              </div>
            )}
            {t.kind === "line" && t.status === "done" && t.line && <LineAnswer turnId={t.id} match={t.line} busy={busy} onAsk={ask} />}
            {t.kind !== "line" && (t.status === "thinking" || (t.status === "answering" && !t.blocks.length)) && !t.ref && <Thinking turn={t} onCancel={() => cancel(t.id)} />}
            {t.status === "error" && (
              <div className="nf">
                <b>Couldn&apos;t reach the archive.</b>
                <p>Nothing was lost. Try the question again.</p>
                <div className="chips"><button className="chip chip--follow" type="button" onClick={() => ask(t.q, t.kind === "line")} disabled={busy}>Try again</button></div>
              </div>
            )}
            {t.kind !== "line" && t.status === "notfound" && (
              <div className="nf">
                <b>{t.thin ? "I couldn't find enough in the episodes to answer this well." : "I couldn't find this in the episodes."}</b>
                <p>Cuepoint only answers from what was said on the show. Try one of these instead:</p>
                <div className="chips">
                  {t.suggestions.map((s) => <button key={s} className="chip chip--follow" type="button" onClick={() => ask(s)} disabled={busy}>{s}</button>)}
                </div>
              </div>
            )}
            {t.kind !== "line" && (t.status === "thinking" || t.status === "answering" || t.status === "done") && (t.blocks.length > 0 || t.ref) && <Answer turn={t} busy={busy} onAsk={ask} onCancel={() => cancel(t.id)} onToggle={(k) => patch(t.id, (x) => ({ ...x, open: x.open === k ? undefined : k }))} />}
            {t.kind !== "line" && (t.status === "thinking" || t.status === "answering") && t.blocks.length > 0 && (
              <RunMeta etaMs={t.eta ?? null} startedAt={t.t0} stage={stagesOf(t)[t.step - 1]} label onCancel={() => cancel(t.id)} />
            )}
          </article>
        ))}
        <button className="linkbtn ask-new" type="button" onClick={reset} disabled={busy}>Start a new question</button>
      </section>
      <div className="dock">
        {scope && <ScopeBar scope={scope} onClear={() => setScope(null)} disabled={busy} />}
        <Composer docked busy={busy} onAsk={ask} lineMode={lineMode} onLineMode={setLineMode} />
      </div>
    </>
  );
}

function Answer({ turn: t, busy, onAsk, onToggle, onCancel }: { turn: Turn; busy: boolean; onAsk: (q: string) => void; onToggle: (key: string) => void; onCancel: () => void }) {
  const lang = t.language === "hi" ? "hi" : undefined;

  // Paragraphs from the streamed text blocks: a blank line starts a new paragraph; chips follow their block.
  type Piece = { block: number; text: string; last: boolean };
  const paras: Piece[][] = [[]];
  t.blocks.forEach((b, bi) => {
    const parts = b.text.split(/\n{2,}/);
    parts.forEach((part, pi) => {
      if (pi > 0) paras.push([]);
      paras[paras.length - 1].push({ block: bi, text: pi === 0 ? part : part.replace(/^\s+/, ""), last: pi === parts.length - 1 });
    });
  });
  const visible = paras.filter((p) => p.some((x) => x.text.trim() || (x.last && t.blocks[x.block].cites.length)));

  const copy = async () => {
    const lines = t.blocks.map((b) => b.text + b.cites.map((c) => ` [${citeLabel(c)} ${youtubeAt(c.videoId, c.startS)}]`).join("")).join("");
    try { await navigator.clipboard.writeText(`${t.q}\n\n${lines.trim()}`); toast("Answer copied with its timestamps"); }
    catch { toast("Copy isn't available here; select the text instead"); }
  };

  const [saved, setSaved] = useState(false);
  const saveAnswer = async () => {
    if (saved) return;
    const citations = t.blocks.flatMap((b) => b.cites);
    setSaved(true);
    const ok = await saveWithUndo(
      { kind: "answer", ref: { question: t.q, answer: t.blocks.map((b) => b.text).join("").trim(), citations } },
      "Answer saved",
      () => setSaved(false),
    );
    if (!ok) setSaved(false);
  };

  return (
    <div className="answer">
      {t.ref && (
        <ClipPlayer clip={clipOf(`ask:${t.id}:ref`, t.ref, 45)} label="Best matching moment" report={false} />
      )}
      {!t.blocks.length && <Thinking turn={t} onCancel={onCancel} />}
      <div className="ans" lang={lang}>
        {visible.map((para, pi) => {
          const openHere = para.find((x) => x.last && t.open?.startsWith(`${x.block}:`));
          let inline: ReactNode = null;
          if (openHere && t.open) {
            const [b, c] = t.open.split(":").map(Number);
            const cite = t.blocks[b]?.cites[c];
            if (cite) inline = (
              <div className="inline">
                <ClipPlayer clip={clipOf(`ask:${t.id}:${b}:${c}`, cite)} label="From this sentence" report={false} />
              </div>
            );
          }
          return (
            <Fragment key={pi}>
              <p>
                {para.map((x, xi) => (
                  <Fragment key={xi}>
                    {x.text}
                    {x.last && t.blocks[x.block].cites.map((c, ci) => {
                      const k = `${x.block}:${ci}`;
                      return (
                        <button
                          key={k}
                          className="cite"
                          type="button"
                          aria-expanded={t.open === k}
                          onClick={() => {
                            const opening = t.open !== k;
                            onToggle(k);
                            if (opening) player.play(clipOf(`ask:${t.id}:${x.block}:${ci}`, c));
                          }}
                        >
                          {citeLabel(c)}
                        </button>
                      );
                    })}
                  </Fragment>
                ))}
              </p>
              {inline}
            </Fragment>
          );
        })}
      </div>
      {/* Source cards show as soon as the search is done; follow-ups and actions once the answer is. */}
      {(t.status === "done" || t.sources.length > 0) && (
        <div className="after rise">
          {t.sources.length > 0 && (
            <>
              <p className="lbl">Sources · {t.sources.length} episode{t.sources.length === 1 ? "" : "s"}</p>
              <div className="srcs">
                {t.sources.map((s) => (
                  <button key={s.videoId} className="src" type="button" onClick={() => player.play(clipOf(`ask:${t.id}:src:${s.videoId}`, s, 45))}>
                    <Initials name={s.guest} />
                    <span className="src__tx">
                      <b>{s.episode}</b>
                      <span>{s.guest} · {s.date}{s.durationS ? ` · ${Math.round(s.durationS / 60)} min` : ""} · <span className="ts">{fmtTime(s.startS)}</span></span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          {t.status === "done" && t.followups.length > 0 && (
            <>
              <p className="lbl">Ask next</p>
              <div className="chips">
                {t.followups.map((f) => <button key={f} className="chip chip--follow" type="button" onClick={() => onAsk(f)} disabled={busy}>{f}</button>)}
              </div>
            </>
          )}
          {t.status === "done" && <div className="acts">
            <button className="linkbtn" type="button" onClick={copy}>Copy answer</button>
            <button className="linkbtn" type="button" onClick={saveAnswer} disabled={saved}>{saved ? "Saved" : "Save answer"}</button>
            <ReportButton
              variant="link"
              item={{
                itemType: "answer",
                itemId: String(t.answerId ?? "unsaved"),
                videoId: t.ref?.videoId,
                startS: t.ref?.startS,
                episode: t.ref?.episode ?? "",
                title: t.q,
              }}
            />
          </div>}
        </div>
      )}
    </div>
  );
}
