"use client";

import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { EXAMPLE_QUESTIONS } from "@/lib/ask/config";
import type { AskEvent, AskLanguage, Cite, RefMoment, Source } from "@/lib/ask/types";
import { fmtTime, youtubeAt, type Clip } from "@/lib/player-types";
import { toast } from "@/lib/toast";
import { ClipPlayer } from "@/components/player/ClipPlayer";
import { getPlayer, player } from "@/components/player/store";
import { ReportButton } from "@/components/report/ReportButton";

type Block = { text: string; cites: Cite[] };
type Turn = {
  id: string;
  q: string;
  status: "thinking" | "answering" | "done" | "notfound" | "error";
  step: 1 | 2 | 3;
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

const citeLabel = (c: Cite) => `${c.speaker} · ${c.date} · ${fmtTime(c.startS)}`;

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

function Composer({ docked, busy, onAsk, autoFocus }: { docked?: boolean; busy: boolean; onAsk: (q: string) => void; autoFocus?: boolean }) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    if (!q || busy) return;
    onAsk(q);
    setValue("");
  };
  return (
    <form className="composer" onSubmit={submit}>
      <label htmlFor={docked ? "ask-follow" : "ask-first"} className="sr">{docked ? "Ask a follow-up" : "Your question"}</label>
      <input
        id={docked ? "ask-follow" : "ask-first"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={docked ? "Ask a follow-up" : "What have founders said about raising their first round?"}
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

function Thinking({ turn }: { turn: Turn }) {
  const cls = (n: 1 | 2 | 3) => (turn.step > n ? "done" : turn.step === n ? "on" : "");
  return (
    <div className="think" role="status">
      <div className="wave" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} />)}</div>
      <div className="steps">
        <span className={cls(1)}>Searching 500 episodes</span>
        <span className={cls(2)}>{turn.moments != null ? `Found ${turn.moments} moments in ${turn.episodes} episodes` : "Finding the moments"}</span>
        <span className={cls(3)}>Writing the answer</span>
      </div>
    </div>
  );
}

export function AskView() {
  const router = useRouter();
  const params = useSearchParams();
  const [turns, setTurns] = useState<Turn[]>(load);
  const startedQ = useRef<string | null>(null);
  const busy = turns.some((t) => t.status === "thinking" || t.status === "answering");

  useEffect(() => {
    try { sessionStorage.setItem(STORE, JSON.stringify(turns.filter((t) => t.status === "done" || t.status === "notfound"))); } catch {}
  }, [turns]);

  const patch = (id: string, fn: (t: Turn) => Turn) => setTurns((all) => all.map((t) => (t.id === id ? fn(t) : t)));

  const apply = (t: Turn, e: AskEvent): Turn => {
    switch (e.type) {
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

  const ask = async (q: string) => {
    if (busy) return;
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const earlier = turns.map((t) => t.q).slice(-3);
    setTurns((all) => [...all, { id, q, status: "thinking", step: 1, blocks: [], sources: [], followups: [], suggestions: [], answerId: null }]);
    window.setTimeout(() => document.getElementById(`turn-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 50);
    try {
      const res = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q, earlier }) });
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
      patch(id, (t) => ({ ...t, status: "error" }));
    }
  };

  // /ask?q=... from quick search asks straight away (once), then clears the URL.
  const q = params.get("q")?.trim();
  useEffect(() => {
    if (!q || startedQ.current === q) return;
    startedQ.current = q;
    router.replace("/ask", { scroll: false });
    void ask(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const reset = () => { setTurns([]); window.scrollTo({ top: 0 }); };

  if (!turns.length) {
    return (
      <section className="ask-empty">
        <h1 className="ask-h rise">Ask anything from 500 episodes<span>in English, Hindi or Hinglish</span></h1>
        <div className="rise d1"><Composer busy={busy} onAsk={ask} autoFocus /></div>
        <div className="chips rise d2">
          {EXAMPLE_QUESTIONS.map((x) => (
            <button key={x} className="chip" type="button" onClick={() => ask(x)} lang={/[ऀ-ॿ]/.test(x) ? "hi" : undefined}>{x}</button>
          ))}
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="thread">
        {turns.map((t, i) => (
          <article className="turn" key={t.id} id={`turn-${t.id}`}>
            {i === 0 ? <h1 className="q1">{t.q}</h1> : <h2 className="qn">{t.q}</h2>}
            {(t.status === "thinking" || (t.status === "answering" && !t.blocks.length)) && !t.ref && <Thinking turn={t} />}
            {t.status === "error" && (
              <div className="nf">
                <b>Couldn&apos;t reach the archive.</b>
                <p>Nothing was lost. Try the question again.</p>
                <div className="chips"><button className="chip chip--follow" type="button" onClick={() => ask(t.q)} disabled={busy}>Try again</button></div>
              </div>
            )}
            {t.status === "notfound" && (
              <div className="nf">
                <b>{t.thin ? "I couldn't find enough in the episodes to answer this well." : "I couldn't find this in the episodes."}</b>
                <p>Cuepoint only answers from what was said on the show. Try one of these instead:</p>
                <div className="chips">
                  {t.suggestions.map((s) => <button key={s} className="chip chip--follow" type="button" onClick={() => ask(s)} disabled={busy}>{s}</button>)}
                </div>
              </div>
            )}
            {(t.status === "thinking" || t.status === "answering" || t.status === "done") && (t.blocks.length > 0 || t.ref) && <Answer turn={t} busy={busy} onAsk={ask} onToggle={(k) => patch(t.id, (x) => ({ ...x, open: x.open === k ? undefined : k }))} />}
          </article>
        ))}
        <button className="linkbtn ask-new" type="button" onClick={reset} disabled={busy}>Start a new question</button>
      </section>
      <div className="dock"><Composer docked busy={busy} onAsk={ask} /></div>
    </>
  );
}

function Answer({ turn: t, busy, onAsk, onToggle }: { turn: Turn; busy: boolean; onAsk: (q: string) => void; onToggle: (key: string) => void }) {
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

  return (
    <div className="answer">
      {t.ref && (
        <ClipPlayer clip={clipOf(`ask:${t.id}:ref`, t.ref, 45)} label="Best matching moment" report={false} />
      )}
      {!t.blocks.length && <Thinking turn={t} />}
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
