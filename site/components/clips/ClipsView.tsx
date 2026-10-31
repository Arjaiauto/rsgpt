"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type FormEvent } from "react";
import { clipTranscript, moreClips, savedClipMarks } from "@/app/actions/clips";
import { IconPlay, IconX } from "@/components/Icons";
import { ClipPlayer } from "@/components/player/ClipPlayer";
import { player, usePlayer } from "@/components/player/store";
import { markClipSaved } from "@/components/player/useClipSave";
import { EmptyState } from "@/components/states";
import { ReelCover } from "./ReelCover";
import {
  GROUP_PREVIEW, LANGS, LENGTHS, SORTS, clipDetailsFilename, clipDetailsText, clipQuery, effectiveSort,
  type ClipCard, type ClipLine, type ClipOptions, type ClipPage, type ClipParams, type ClipSort,
} from "@/lib/clip-types";
import { fmtTime, type Clip } from "@/lib/player-types";
import { toast } from "@/lib/toast";

const plural = (n: number, one: string) => `${n.toLocaleString("en-IN")} ${one}${n === 1 ? "" : "s"}`;
const toClip = (c: ClipCard, sourcePath: string): Clip => ({
  key: `clip:${c.id}`, itemType: "clip", itemId: String(c.id), videoId: c.videoId, startS: c.startS, endS: c.endS,
  title: c.topic, guest: c.guest, episode: c.episode, date: c.date, sourcePath,
});

/** The reels feed for the same filters, search and sort (the same query string), optionally from one clip. */
export const reelsHref = (p: ClipParams, start?: number) => {
  const qs = clipQuery(p);
  return `/clips/reels${qs}${start ? `${qs ? "&" : "?"}start=${start}` : ""}`;
};

/* ---------- one reel card ---------- */

function Reel({ c, active, onOpen, showMore }: { c: ClipCard; active: boolean; onOpen: (c: ClipCard) => void; showMore: boolean }) {
  return (
    <article className={`cl-card${active ? " on" : ""}`} data-clip={c.id}>
      <button
        className="cl-reel"
        type="button"
        onClick={() => onOpen(c)}
        aria-label={`Play clip: ${c.topic}${c.guest ? `, ${c.guest}` : ""}, ${fmtTime(c.endS - c.startS)}`}
        aria-pressed={active}
      >
        <ReelCover name={c.guest || c.topic} photo={c.photo} />
        <span className="cl-len num">{fmtTime(c.endS - c.startS)}</span>
        <span className="cl-topic">{c.topic}</span>
        <span className="cl-pl" aria-hidden="true"><IconPlay /></span>
        <span className="cl-cap">
          <span className="cl-open" lang={c.lang === "hi" ? "hi-Latn" : undefined}>“{c.opening}”</span>
          <span className="cl-who"><b>{c.guest || "Guest not listed"}</b> · {c.date}</span>
        </span>
      </button>
      <div className="cl-meta">
        {showMore && c.repeat && c.guestSlug && <Link className="cl-more" href={`/clips${clipQuery({ guest: c.guestSlug })}`}>More from this guest</Link>}
        {c.photo && c.photoLicense && <span className="cl-lic">Photo: {c.photoLicense}</span>}
      </div>
    </article>
  );
}

/* ---------- live transcript ---------- */

function Transcript({ clip, lines }: { clip: Clip; lines: ClipLine[] | null | "error" }) {
  const { clip: cur, pos } = usePlayer();
  const box = useRef<HTMLOListElement>(null);
  const here = cur?.key === clip.key;
  const active = here && Array.isArray(lines) ? lines.findLastIndex((l) => l.start <= pos + 0.15) : -1;
  useEffect(() => {
    const el = box.current?.children[active] as HTMLElement | undefined;
    const b = box.current;
    if (!el || !b) return;
    const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    b.scrollTo({ top: Math.max(0, el.offsetTop - b.clientHeight / 3), behavior: smooth ? "smooth" : "auto" });
  }, [active]);
  if (lines === null) return <p className="cl-tx-note" role="status">Loading the transcript…</p>;
  if (lines === "error") return <p className="cl-tx-note" role="alert">Couldn&apos;t load the transcript. The clip still plays.</p>;
  if (!lines.length) return <p className="cl-tx-note">No transcript lines for this clip.</p>;
  const len = clip.endS - clip.startS;
  return (
    <ol className="cl-tx" ref={box} aria-label="Transcript">
      {lines.map((l, i) => (
        <li key={`${l.start}-${i}`} className={i === active ? "on" : undefined} aria-current={i === active ? "true" : undefined}>
          <button type="button" onClick={() => player.seekFraction((l.start - clip.startS) / len, clip)}>
            <span className="cl-tx-t num">{fmtTime(l.start)}</span>
            <span className="cl-tx-b">
              {l.speaker && <span className="cl-tx-s">{l.speaker}</span>}
              <span lang={l.english ? "hi-Latn" : undefined}>{l.text}</span>
              {l.english && <span className="cl-tx-en">{l.english}</span>}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

/* ---------- player panel ---------- */

function Panel({ card, onClose }: { card: ClipCard; onClose: () => void }) {
  const pathname = usePathname();
  const clip = useMemo(() => toClip(card, `${pathname}${typeof window === "undefined" ? "" : window.location.search}`), [card, pathname]);
  const [lines, setLines] = useState<ClipLine[] | null | "error">(null);
  useEffect(() => {
    // The panel is keyed by the clip, so it starts with no lines for each new clip.
    let live = true;
    clipTranscript(card.id).then((l) => { if (live) setLines(l ?? "error"); }).catch(() => { if (live) setLines("error"); });
    return () => { live = false; };
  }, [card.id]);

  const download = () => {
    const blob = new Blob([clipDetailsText(card)], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = clipDetailsFilename(card);
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    toast("Clip details downloaded");
  };

  return (
    <aside className="cl-panel" aria-label={`Clip: ${card.topic}`}>
      <div className="cl-panel-head">
        <p>{card.guest || "Clip"} · {card.date}</p>
        <button className="ib" type="button" onClick={onClose} aria-label="Close the player"><IconX /></button>
      </div>
      <ClipPlayer clip={clip} label={card.topic} />
      <div className="cl-acts">
        <button className="pill pill--ghost" type="button" onClick={download}>Download clip details</button>
        <p className="cl-export">
          <b>Export clip:</b> real clip files cut from the raw footage come with the team version. <Link href="/future#slide-2">See how</Link>
        </p>
      </div>
      <h3 className="cl-tx-h">Transcript</h3>
      <Transcript clip={clip} lines={lines} />
    </aside>
  );
}

/* ---------- results (one list per URL) ---------- */

function Results({ params, initial, open, onOpen }: { params: ClipParams; initial: ClipPage; open: number | null; onOpen: (c: ClipCard) => void }) {
  const [items, setItems] = useState(initial.items);
  const [next, setNext] = useState(initial.next);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const sentinel = useRef<HTMLDivElement>(null);
  const busy = useRef(false);

  const loadMore = useCallback(async () => {
    if (next == null || busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      const page = await moreClips(params, next);
      setItems((all) => [...all, ...page.items.filter((c) => !all.some((x) => x.id === c.id))]);
      setNext(page.next);
    } catch {
      toast("Couldn't load more clips. Try again.");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [next, params]);

  // Infinite scroll: the next page loads when the end of the grid comes near; the button stays as a fallback.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || next == null) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) void loadMore(); }, { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, next]);

  const gv = initial.guestView;
  if (gv) {
    return (
      <>
        <div className="cl-guesthead">
          <h2>{gv.name}</h2>
          <p>{plural(gv.episodes, "episode")} · {plural(gv.clips, "clip")}</p>
          <Link className="cl-linkbtn" href={`/clips${clipQuery({ ...params, guest: "" })}`}>All guests</Link>
        </div>
        {gv.groups.map((g) => {
          const all = expanded.has(g.videoId);
          const shown = all ? g.clips : g.clips.slice(0, GROUP_PREVIEW);
          return (
            <section className="cl-group" key={g.videoId} aria-label={g.episode}>
              <h3>
                {g.episode}<span>{g.date} · {plural(g.clips.length, "clip")}</span>
                <Link className="cl-reelsbtn cl-reelsbtn--sm" href={reelsHref(params, g.clips[0].id)}>Watch as reels</Link>
              </h3>
              <div className="cl-grid">
                {shown.map((c) => <Reel key={c.id} c={c} active={open === c.id} onOpen={onOpen} showMore={false} />)}
              </div>
              {g.clips.length > GROUP_PREVIEW && (
                <button
                  className="cl-linkbtn cl-expand"
                  type="button"
                  aria-expanded={all}
                  onClick={() => setExpanded((s) => { const n = new Set(s); if (all) n.delete(g.videoId); else n.add(g.videoId); return n; })}
                >
                  {all ? "Show fewer" : `Show all ${g.clips.length} from this episode`}
                </button>
              )}
            </section>
          );
        })}
      </>
    );
  }

  return (
    <>
      <div className="cl-grid">
        {items.map((c) => <Reel key={c.id} c={c} active={open === c.id} onOpen={onOpen} showMore />)}
      </div>
      {next != null && (
        <div className="cl-moreRow" ref={sentinel}>
          <button className="pill pill--ghost" type="button" onClick={() => void loadMore()} disabled={loading}>
            {loading ? "Loading…" : `Load more (${(initial.total - items.length).toLocaleString("en-IN")} left)`}
          </button>
        </div>
      )}
    </>
  );
}

/* ---------- search ---------- */

/** Keyed by the search in the URL, so it shows what the page searched after a reload or Back. */
function SearchBox({ initial, onSearch }: { initial: string; onSearch: (q: string) => void }) {
  const [q, setQ] = useState(initial);
  const submit = (e: FormEvent) => { e.preventDefault(); onSearch(q.trim()); };
  return (
    <form className="cl-search rise d1" role="search" onSubmit={submit}>
      <label className="sr" htmlFor="cl-q">Search clips</label>
      <input id="cl-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clips: failure, first salary, AI jobs" maxLength={120} autoComplete="off" />
      {initial && <button type="button" className="ib cl-clear" aria-label="Clear search" onClick={() => onSearch("")}><IconX /></button>}
      <button className="pill pill--primary pill--sm" type="submit">Search</button>
    </form>
  );
}

/* ---------- the page ---------- */

export function ClipsView({ params, initial, options }: { params: ClipParams; initial: ClipPage; options: ClipOptions }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState<ClipCard | null>(null);
  const marks = useRef<Set<string> | null>(null);
  const qs = clipQuery(params);
  useEffect(() => {
    savedClipMarks().then((m) => { marks.current = new Set(m); }).catch(() => { marks.current = new Set(); });
  }, []);

  const go = (patch: Partial<ClipParams>) => {
    const next = { ...params, ...patch };
    if (next.sort === "match" && !next.q) next.sort = "";
    start(() => router.replace(`/clips${clipQuery(next)}`, { scroll: false }));
  };
  const onOpen = useCallback((c: ClipCard) => {
    setOpen(c);
    if (marks.current?.has(`${c.videoId}@${Math.round(c.startS)}`)) markClipSaved(`clip:${c.id}`);
    // The panel's player slot mounts in this render; play once it is there.
    window.setTimeout(() => player.play(toClip(c, `/clips${window.location.search}`)), 0);
  }, []);

  const sort = effectiveSort(params);
  const filtered = !!(params.q || params.topic || params.guest || params.len || params.year || params.lang);
  const sel = (label: string, value: string, onChange: (v: string) => void, opts: [string, string][], all: string) => (
    <label className="cl-sel">
      <span className="sr">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        <option value="">{all}</option>
        {opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
    </label>
  );

  if (options.total === 0) {
    return (
      <>
        <h1 className="page-title rise">Clips</h1>
        <EmptyState icon={<IconPlay />} title="No clips yet" text="Clips show up here once the archive has verified clips." actions={[{ label: "Ask a question", href: "/ask", primary: true }]} />
      </>
    );
  }

  return (
    <>
      <div className="cl-head">
        <h1 className="page-title rise">Clips<span className="soft">ready-made moments</span></h1>
        <SearchBox key={params.q} initial={params.q} onSearch={(text) => go({ q: text, sort: "" })} />
      </div>

      <div className="cl-filters rise d1" role="group" aria-label="Filters">
        {sel("Topic", params.topic, (v) => go({ topic: v }), options.topics.map((t) => [t.key, `${t.label} (${t.n})`]), "All topics")}
        {sel("Guest", params.guest, (v) => go({ guest: v }), options.guests.map((g) => [g.slug, `${g.name} (${g.n})`]), "All guests")}
        {sel("Length", params.len, (v) => go({ len: v as ClipParams["len"] }), options.lengths.map((l) => [l.key, `${LENGTHS[l.key]} (${l.n})`]), "Any length")}
        {sel("Year", params.year, (v) => go({ year: v }), options.years.map((y) => [y.year, `${y.year} (${y.n})`]), "Any year")}
        {sel("Language", params.lang, (v) => go({ lang: v as ClipParams["lang"] }), options.langs.map((l) => [l.key, `${LANGS[l.key]} (${l.n})`]), "Any language")}
        <label className="cl-sel cl-sort">
          <span className="sr">Sort</span>
          <select value={sort} aria-label="Sort" onChange={(e) => go({ sort: (e.target.value === (params.q ? "match" : "score") ? "" : e.target.value) as ClipSort | "" })}>
            {(Object.keys(SORTS) as ClipSort[]).filter((k) => k !== "match" || params.q).map((k) => <option key={k} value={k}>{SORTS[k]}</option>)}
          </select>
        </label>
        {filtered && <Link className="cl-linkbtn" href="/clips">Reset</Link>}
      </div>

      <div className="cl-countrow">
        <p className="cl-count" role="status" aria-live="polite">
          {pending ? "Updating…" : initial.guestView ? "" : `${plural(initial.total, "clip")}${params.q ? ` for “${params.q}”` : ""}${filtered ? "" : " in the archive"}`}
        </p>
        {initial.total > 0 && <Link className="cl-reelsbtn" href={reelsHref(params)}><IconPlay />Watch as reels</Link>}
      </div>

      <div className={`cl-layout${open ? " open" : ""}`}>
        <div className={`cl-results${pending ? " busy" : ""}`} aria-busy={pending}>
          {initial.total === 0 ? (
            <EmptyState
              icon={<IconPlay />}
              title="No clips match"
              text={params.q ? "No clip covers that search with these filters. Try fewer words, or reset the filters." : "No clips have all of these filters. Reset them to see every clip."}
              actions={[{ label: "Reset filters", href: "/clips", primary: true }, ...(params.q ? [{ label: "Ask instead", href: `/ask?q=${encodeURIComponent(params.q)}` }] : [])]}
            />
          ) : (
            <Results key={qs} params={params} initial={initial} open={open?.id ?? null} onOpen={onOpen} />
          )}
        </div>
        {open && <Panel key={open.id} card={open} onClose={() => setOpen(null)} />}
      </div>
    </>
  );
}
