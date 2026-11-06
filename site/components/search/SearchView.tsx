"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { IconAsk, IconPlay, IconSearch, IconX } from "@/components/Icons";
import { player } from "@/components/player/store";
import { Skeleton } from "@/components/states";
import { scopeIsEmpty, type AskScope } from "@/lib/ask/scope-types";
import { contentWords, romanFold } from "@/lib/search/normalize";
import type { Chip, EpisodeHit, MomentHit, SearchResult } from "@/lib/search/types";
import { fmtTime, youtubeAt } from "@/lib/player-types";

/** The results page (/search): the names and titles at once (phase=fast), the passages and clips when they arrive
    (phase=full). Both come from /api/search; the full one is what gets logged. */

type Failure = { message: string; retryAfter?: number };
type Popular = { label: string; href: string; sub: string }[];

const searchHref = (q: string, scope: AskScope, literal = false) => {
  const p = new URLSearchParams({ q });
  if (!scopeIsEmpty(scope)) p.set("scope", JSON.stringify(scope));
  if (literal) p.set("literal", "1");
  return `/search?${p}`;
};

async function ask(q: string, scope: AskScope, phase: "fast" | "full", literal: boolean, signal: AbortSignal): Promise<SearchResult> {
  const p = new URLSearchParams({ q, phase });
  if (!scopeIsEmpty(scope)) p.set("scope", JSON.stringify(scope));
  if (literal) p.set("literal", "1");
  if (phase === "fast") p.set("submit", "1");
  const r = await fetch(`/api/search?${p}`, { signal });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error ?? "Search isn't available right now. Try again."), { status: r.status, retryAfter: body.retryAfter });
  return body as SearchResult;
}

/** The searched words in a snippet, marked. */
function highlight(text: string, words: string[]): ReactNode {
  const list = words.filter((w) => w.length >= 2).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!list.length) return text;
  return text.split(new RegExp(`(${list.join("|")})`, "giu")).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function playMoment(m: MomentHit) {
  player.play({
    key: `search:${m.chunkId}`, itemType: "episode", itemId: m.videoId, videoId: m.videoId, startS: m.startS, endS: m.endS,
    title: m.episode, guest: m.guests.join(" & "), episode: m.episode, sourcePath: null,
  });
}
function playEpisode(e: EpisodeHit) {
  player.play({
    key: `episode:${e.videoId}`, itemType: "episode", itemId: e.videoId, videoId: e.videoId, startS: 0, endS: 4 * 3600,
    title: e.title, guest: e.guests.join(" & "), episode: e.title, sourcePath: null,
  });
}

export function SearchView({ q, scope, scopeText, scopeTopics, literal }: { q: string; scope: AskScope; scopeText: string; scopeTopics: string[]; literal: boolean }) {
  const router = useRouter();
  const [fast, setFast] = useState<SearchResult | null>(null);
  const [full, setFull] = useState<SearchResult | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [popular, setPopular] = useState<Popular>([]);
  const [text, setText] = useState(q);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => { document.title = q ? `Search: ${q} · Cuepoint` : "Search · Cuepoint"; }, [q]);

  useEffect(() => {
    if (!q) return;
    const ctrl = new AbortController();
    const fail = (e: unknown) => {
      if (ctrl.signal.aborted) return;
      const err = e as { message?: string; status?: number; retryAfter?: number };
      if (err.status === 401) { router.push("/login"); return; }
      setFailure({ message: err.message || "Search isn't available right now. Try again.", retryAfter: err.retryAfter });
    };
    // The fast answer (names and titles) usually lands first; the full one is asked for at the same time and merged in.
    ask(q, scope, "fast", literal, ctrl.signal).then(setFast).catch(() => {});
    ask(q, scope, "full", literal, ctrl.signal).then(setFull).catch(fail);
    return () => ctrl.abort();
  }, [q, scope, literal, attempt, router]);

  // With nothing typed: a few places to start (the same popular suggestions as the quick search).
  useEffect(() => {
    if (q) return;
    const ctrl = new AbortController();
    fetch("/api/search/suggest?q=", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((j: { items: { label: string; href: string; sub: string }[] }) => setPopular(j.items))
      .catch(() => {});
    return () => ctrl.abort();
  }, [q]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = text.trim();
    if (next) router.push(searchHref(next, scope));
  };

  const result = full ?? fast;
  const groups = result?.groups;
  const loadingFull = !full && !failure;
  const corrected = (full ?? fast)?.corrected;
  const effective = corrected ? corrected.corrected : q;
  const words = q ? contentWords(romanFold(effective)) : [];
  const empty = !!full && !full.groups.moments.length && !full.groups.guests.length && !full.groups.episodes.length && !full.groups.clips.length && !full.groups.topics.length;
  const narrowing = full?.vague && full.chips.length > 0;

  /** Where a narrowing chip leads: a topic or a guest becomes the scope, a refinement changes the words. A topic the scope
      cannot hold (only the main sectors can) is added to the words instead. */
  const chipHref = (c: Chip) => {
    if (c.kind === "guest") return searchHref(q, { ...scope, guest: c.value });
    if (c.kind === "topic" && scopeTopics.includes(c.value)) return searchHref(q, { ...scope, topic: c.value });
    return searchHref(c.kind === "topic" ? `${q} ${c.label}` : c.value, scope);
  };

  return (
    <>
      <h1 className="page-title rise">Search</h1>
      <form className="sx-form rise d1" role="search" onSubmit={submit}>
        <label className="sr" htmlFor="sx-q">Search guests, episodes, clips and what was said</label>
        <input id="sx-q" type="search" enterKeyHint="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search guests, episodes, clips and what was said" autoComplete="off" autoFocus={!q} maxLength={200} />
        <button className="pill pill--primary" type="submit"><IconSearch />Search</button>
      </form>
      {scopeText && (
        <p className="sx-scope">
          <span>Only in <b>{scopeText}</b></span>
          <Link href={searchHref(q, {})} aria-label="Search everything again"><IconX />Everything</Link>
        </p>
      )}

      {!q && (
        <section className="sx-start">
          <p>Type a name, a topic or a few words. Cuepoint finds the guest, the episode, the clip and the moment it was said.</p>
          {popular.length > 0 && (
            <ul className="sx-chips" aria-label="Places to start">
              {popular.map((p) => <li key={p.href}><Link className="sx-chip" href={p.href}>{p.label}</Link></li>)}
            </ul>
          )}
        </section>
      )}

      {q && (
        <div className="sx-status" role="status" aria-live="polite">
          {corrected ? (
            <p>Showing results for <b>{corrected.corrected}</b> · <Link href={searchHref(q, scope, true)}>search instead for {q}</Link></p>
          ) : full?.mode === "closest" ? (
            <p>Closest matches for <b>“{q}”</b>. Nothing in the transcripts says these exact words, so these are the nearest in meaning.</p>
          ) : loadingFull ? (
            <p>Searching for <b>“{q}”</b>…</p>
          ) : (
            <p className="sx-faint">Results for <b>“{effective}”</b></p>
          )}
        </div>
      )}

      {q && (narrowing || (loadingFull && fast?.vague)) && (
        <section className="sx-narrow" aria-label="Narrow it down">
          <h2>Narrow it down</h2>
          {narrowing ? (
            <ul className="sx-chips">
              {full!.chips.map((c) => <li key={`${c.kind}-${c.value}`}><Link className={`sx-chip sx-chip--${c.kind}`} href={chipHref(c)}>{c.label}</Link></li>)}
            </ul>
          ) : (
            <div className="sx-chips" aria-hidden="true">{[88, 120, 96, 110].map((w) => <Skeleton key={w} w={w} h={34} style={{ borderRadius: 999 }} />)}</div>
          )}
        </section>
      )}

      {q && failure && (
        <div className="sx-fail" role="alert">
          <b>{failure.message}</b>
          <div className="sx-actions">
            <button className="pill pill--ghost" type="button" onClick={() => { setFailure(null); setFull(null); setAttempt((n) => n + 1); }}>
              {failure.retryAfter ? `Try again in ${failure.retryAfter} s` : "Try again"}
            </button>
          </div>
        </div>
      )}

      {q && !empty && (
        <div className="sx-results">
          <Section title="Moments" count={groups?.moments.length} loading={loadingFull && !groups?.moments.length} rows={3}>
            <ul className="sx-moments">
              {groups?.moments.map((m) => (
                <li key={m.chunkId}>
                  <button type="button" className="sx-moment" onClick={() => playMoment(m)} aria-label={`Play from ${fmtTime(m.startS)} in ${m.episode}`}>
                    <span className="sx-play" aria-hidden="true"><IconPlay /></span>
                    <span className="sx-mbody">
                      <span className="sx-snip">{highlight(m.snippet, words)}</span>
                      <span className="sx-meta">{[m.episode, m.guests.slice(0, 2).join(" & "), m.year].filter(Boolean).join(" · ")}</span>
                    </span>
                    <span className="sx-ts num">{fmtTime(m.startS)}</span>
                  </button>
                  <a className="sx-yt" href={youtubeAt(m.videoId, m.startS)} target="_blank" rel="noopener noreferrer" aria-label={`Open on YouTube at ${fmtTime(m.startS)}`}>YouTube</a>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Clips" count={groups?.clips.length} loading={loadingFull && !groups?.clips.length} rows={2}>
            <ul className="sx-list">
              {groups?.clips.map((c) => (
                <li key={c.id}>
                  <Link className="sx-row" href={`/clips/reels?start=${c.id}`}>
                    <span className="sx-k" aria-hidden="true"><IconPlay /></span>
                    <span className="sx-rbody"><b>{c.title}</b><span className="sx-meta">{c.guest || "Clip"} · {fmtTime(c.endS - c.startS)}</span></span>
                    <span className="sx-side">Watch as reel</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Episodes" count={groups?.episodes.length}>
            <ul className="sx-list">
              {groups?.episodes.map((e) => (
                <li key={e.videoId}>
                  <button type="button" className="sx-row" onClick={() => playEpisode(e)}>
                    <span className="sx-k" aria-hidden="true"><IconPlay /></span>
                    <span className="sx-rbody"><b>{e.title}</b><span className="sx-meta">{[e.year, e.guests.slice(0, 2).join(" & ")].filter(Boolean).join(" · ")}</span></span>
                    <span className="sx-side">{e.matched ? "Matches the title" : plural(e.hits, "moment")}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Guests" count={groups?.guests.length}>
            <ul className="sx-list">
              {groups?.guests.map((g) => (
                <li key={g.slug}>
                  <Link className="sx-row" href={`/guests/${g.slug}`}>
                    <span className="sx-k sx-k--initial" aria-hidden="true">{g.name.slice(0, 1)}</span>
                    <span className="sx-rbody"><b>{g.name}</b></span>
                    <span className="sx-side">{g.matched ? "Name matches" : plural(g.hits, "moment")}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Topics" count={groups?.topics.length}>
            <ul className="sx-chips">
              {groups?.topics.map((t) => (
                <li key={t.key}><Link className="sx-chip" href={`/clips?topic=${encodeURIComponent(t.key)}`}>{t.label}{!t.matched && t.hits > 0 ? <small>{t.hits}</small> : null}</Link></li>
              ))}
            </ul>
          </Section>
        </div>
      )}

      {q && (empty || failure) && !loadingFull && (
        <div className="sx-none">
          <b>{failure ? "We couldn't search just now." : `Nothing in the archive matched “${q}”.`}</b>
          <p>Ask Cuepoint instead, or try fewer or different words.</p>
        </div>
      )}
      {q && (
        <p className="sx-ask">
          <Link className="pill pill--ghost" href={`/ask?q=${encodeURIComponent(effective)}`}><IconAsk />Ask Cuepoint about “{effective}”</Link>
        </p>
      )}
    </>
  );
}

/** One group of results: its heading, a few skeleton rows while it loads, nothing when it has no items. */
function Section({ title, count, loading, rows = 2, children }: { title: string; count?: number; loading?: boolean; rows?: number; children: ReactNode }) {
  if (!loading && !count) return null;
  return (
    <section className="sx-sec" aria-label={title} aria-busy={loading || undefined}>
      <h2>{title}{count ? <span className="num">{count}</span> : null}</h2>
      {loading ? (
        <div className="sx-skel" aria-hidden="true">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} h={58} style={{ borderRadius: 14 }} />)}</div>
      ) : children}
    </section>
  );
}
