"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { CATEGORY_ORDER, categoryLabel, fmtLength, fmtMonth, fmtViews, languageLabel } from "@/lib/guest-format";
import type { EpisodeInfo, Profile } from "@/lib/guest-types";
import { fmtTime, type Clip } from "@/lib/player-types";
import { IconPlay } from "@/components/Icons";
import { ClipPlayer } from "@/components/player/ClipPlayer";
import { player, usePlayerClip } from "@/components/player/store";
import { ReportButton } from "@/components/report/ReportButton";
import { GuestCardView } from "./GuestCardView";
import { Portrait } from "./Portrait";

type TabKey = "takeaways" | "opportunities" | "quotes" | "disagreements" | "clips";
const TABS: { key: TabKey; label: string }[] = [
  { key: "takeaways", label: "Takeaways" },
  { key: "opportunities", label: "Opportunities" },
  { key: "quotes", label: "Quotes" },
  { key: "disagreements", label: "Disagreements" },
  { key: "clips", label: "Clips" },
];
/** Items drawn per tab before "Show more" (each one carries its own report popup). */
const SHOWN = 30;

/** The sticky player column is for wide screens; below this the shared mini player is docked at the bottom. */
const WIDE = "(min-width: 1001px)";
function useWide(): boolean {
  return useSyncExternalStore(
    (notify) => { const m = window.matchMedia(WIDE); m.addEventListener("change", notify); return () => m.removeEventListener("change", notify); },
    () => window.matchMedia(WIDE).matches,
    () => false,
  );
}

const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function GuestProfile({ profile: p }: { profile: Profile }) {
  const router = useRouter();
  const wide = useWide();
  const current = usePlayerClip();
  const episodeOf = new Map(p.episodes.map((e) => [e.videoId, e]));
  const latest: EpisodeInfo | undefined = p.episodes[0];
  const repeat = p.episodes.length > 1;

  const counts: Record<TabKey, number> = {
    takeaways: p.takeaways.length, opportunities: p.opportunities.length, quotes: p.quotes.length,
    disagreements: p.disagreements.length, clips: p.clips.length,
  };
  const tabs = TABS.filter((t) => counts[t.key] > 0); // empty sections are hidden
  const [picked, setPicked] = useState<TabKey | null>(null);
  const tab = tabs.find((t) => t.key === picked)?.key ?? tabs[0]?.key;
  const [limits, setLimits] = useState<Partial<Record<TabKey, number>>>({});
  const limit = (tab && limits[tab]) || SHOWN;

  const clipOf = (kind: string, itemType: Clip["itemType"], id: string | number, videoId: string, startS: number, endS: number, title: string): Clip => {
    const ep = episodeOf.get(videoId);
    return {
      key: `guest:${p.slug}:${kind}:${id}`, itemType, itemId: String(id), videoId, startS, endS: Math.max(endS, startS + 30),
      title: short(title), guest: p.name, episode: ep?.title ?? "", date: fmtMonth(ep?.publishedAt ?? null), sourcePath: `/guests/${p.slug}`,
    };
  };

  /** Teal timestamp chip that plays in the shared player, the episode month for repeat guests, and Report.
      A plain function (not a component), so items keep their state when this page re-renders. */
  const meta = (clip: Clip) => (
    <div className="gx-row2">
      <button className="gx-ts" type="button" onClick={() => player.play(clip)} aria-label={`Play from ${fmtTime(clip.startS)}`}>{fmtTime(clip.startS)}</button>
      {repeat && <span className="gx-epdate">{clip.date}</span>}
      <ReportButton variant="link" item={{ itemType: clip.itemType, itemId: clip.itemId, videoId: clip.videoId, startS: clip.startS, episode: clip.episode, title: clip.title }} />
    </div>
  );
  const playing = (clip: Clip) => (current?.key === clip.key ? " playing" : "");

  const insight = (i: { id: number; videoId: string; startS: number; endS: number; text: string }) =>
    clipOf("i", "insight", i.id, i.videoId, i.startS, i.endS, i.text);

  let panel: ReactNode = null;
  if (tab === "takeaways") {
    panel = p.takeaways.slice(0, limit).map((i) => {
      const clip = insight(i);
      return <div className={`gx-item${playing(clip)}`} key={i.id}><p>{i.text}</p>{meta(clip)}</div>;
    });
  } else if (tab === "opportunities") {
    const shown = p.opportunities.slice(0, limit);
    const groups = [...CATEGORY_ORDER, ""].map((c) => ({ c, items: shown.filter((i) => (i.category ?? "") === c) })).filter((g) => g.items.length);
    // A category outside the known list still shows, under its own heading.
    const known = new Set(CATEGORY_ORDER);
    const other = [...new Set(shown.map((i) => i.category).filter((c): c is string => !!c && !known.has(c)))];
    for (const c of other) groups.push({ c, items: shown.filter((i) => i.category === c) });
    panel = groups.map((g) => (
      <section key={g.c || "other"} aria-label={categoryLabel(g.c || null)}>
        <h3 className="gx-cat">{categoryLabel(g.c || null)}</h3>
        <div className="gx-stack">
          {g.items.map((i) => {
            const clip = insight(i);
            return <div className={`gx-item${playing(clip)}`} key={i.id}><p>{i.text}</p>{meta(clip)}</div>;
          })}
        </div>
      </section>
    ));
  } else if (tab === "quotes") {
    panel = p.quotes.slice(0, limit).map((i) => {
      const clip = insight(i);
      return <div className={`gx-item gx-quote${playing(clip)}`} key={i.id}><p>&ldquo;{i.text}&rdquo;</p>{meta(clip)}</div>;
    });
  } else if (tab === "disagreements") {
    panel = p.disagreements.slice(0, limit).map((i) => {
      const clip = insight(i);
      return (
        <div className={`gx-item${playing(clip)}`} key={i.id}>
          {i.host && i.guest ? (
            <div className="gx-dis">
              <div className="gx-side"><b>Host</b><span>{i.host}</span></div>
              <div className="gx-side g"><b>{p.name}</b><span>{i.guest}</span></div>
            </div>
          ) : (
            <p>{i.text}</p>
          )}
          {meta(clip)}
        </div>
      );
    });
  } else if (tab === "clips") {
    panel = p.clips.slice(0, limit).map((c) => {
      const clip = clipOf("c", "clip", c.id, c.videoId, c.startS, c.endS, c.topic);
      return (
        <div className={`gx-item gx-clip${playing(clip)}`} key={c.id}>
          <span className="gx-len num" title="Clip length">{fmtTime(c.endS - c.startS)}</span>
          <p>{c.topic}</p>
          {meta(clip)}
        </div>
      );
    });
  }

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const at = tabs.findIndex((t) => t.key === tab);
    const next = tabs[(at + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    setPicked(next.key);
    requestAnimationFrame(() => document.getElementById(`gx-tab-${next.key}`)?.focus());
    e.preventDefault();
  };

  const [question, setQuestion] = useState("");
  const ask = (e: FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (q) router.push(`/ask?${new URLSearchParams({ q, guest: p.slug, gn: p.name })}`);
  };

  const episodeClip = (e: EpisodeInfo): Clip => ({
    key: `guest:${p.slug}:ep:${e.videoId}`, itemType: "episode", itemId: e.videoId, videoId: e.videoId, startS: 0,
    endS: e.durationS ?? 4 * 3600, title: e.title, guest: p.name, episode: e.title, date: fmtMonth(e.publishedAt), sourcePath: `/guests/${p.slug}`,
  });
  const here = current && current.key.startsWith(`guest:${p.slug}:`) ? current : null;
  const [similarOpen, setSimilarOpen] = useState<string | null>(null);
  // "Founder of Unblock" already names the organisation, so it is not added again.
  const role = p.role && p.org && p.role.toLowerCase().includes(p.org.toLowerCase()) ? p.role : [p.role, p.org].filter(Boolean).join(", ");
  const { links } = p;

  return (
    <>
      <Link className="gx-back" href="/guests">&larr; All guests</Link>
      <div className="gx-layout">
        <div className="gx-main">
          <section className="gx-hero">
            <div>
              <div className="gx-photo"><Portrait name={p.name} photoUrl={p.photo?.url ?? null} priority /></div>
              {p.photo && p.photo.source !== "manual" && (
                <p className="gx-credit">
                  Photo: {[p.photo.credit, p.photo.license].filter(Boolean).join(", ")}
                  {p.photo.source && <>, via <a href={p.photo.source} target="_blank" rel="noopener noreferrer">Wikimedia Commons</a></>}
                </p>
              )}
            </div>
            <div>
              <h1 className="gx-h1">{p.name}</h1>
              {(role || p.asOf) && (
                <p className="gx-role">{role}{p.asOf && <span className="gx-asof">as of {p.asOf}</span>}</p>
              )}
              {p.tags.length > 0 && <div className="gx-tags gx-tags--lg">{p.tags.map((t) => <span className="gx-tag" key={t}>{t}</span>)}</div>}
              {p.bio.length > 0 && <p className="gx-bio">{p.bio.join(" ")}</p>}
              <div className="gx-pills">
                {links.linkedinProfile ? (
                  <a className="gx-lp" href={links.linkedinProfile} target="_blank" rel="noopener noreferrer">LinkedIn</a>
                ) : links.linkedinSearch ? (
                  <a className="gx-lp" href={links.linkedinSearch} target="_blank" rel="noopener noreferrer" title="Opens a search, not a profile">Search on LinkedIn</a>
                ) : null}
                {links.youtube && (
                  <a className="gx-lp" href={links.youtube} target="_blank" rel="noopener noreferrer">
                    YouTube channel{links.auto && <small>Matched automatically</small>}
                  </a>
                )}
                {links.wikipedia && (
                  <a className="gx-lp" href={links.wikipedia} target="_blank" rel="noopener noreferrer">
                    From Wikipedia{links.auto && <small>Matched automatically</small>}
                  </a>
                )}
                <ReportButton variant="link" item={{ itemType: "guest", itemId: p.slug, episode: latest?.title ?? "", title: p.name }} />
              </div>
            </div>
          </section>

          {latest && (
            <div className="gx-ep">
              <div className="gx-ep__t">
                <b>{latest.title}</b>
                <span>
                  {[fmtMonth(latest.publishedAt), fmtLength(latest.durationS), latest.views ? `${fmtViews(latest.views)} views` : "", languageLabel(latest.lang)].filter(Boolean).join(" · ")}
                </span>
              </div>
              <button className="pill pill--primary pill--sm" type="button" onClick={() => player.play(episodeClip(latest))}>
                <IconPlay />Play episode
              </button>
            </div>
          )}

          <form className="gx-askg" onSubmit={ask}>
            <label className="sr" htmlFor="gx-ask">Ask about {p.name}</label>
            <input id="gx-ask" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={400} autoComplete="off"
              placeholder={`Ask about ${p.name}${repeat ? "'s episodes" : "'s episode"}`} />
            <button className="pill pill--primary pill--sm" type="submit" disabled={!question.trim()}>Ask</button>
          </form>

          {tabs.length > 0 && tab && (
            <>
              <div className="gx-tabs" role="tablist" aria-label={`What ${p.name} said`} onKeyDown={onTabKey}>
                {tabs.map((t) => (
                  <button key={t.key} id={`gx-tab-${t.key}`} className="gx-tab" role="tab" type="button" aria-selected={t.key === tab}
                    aria-controls="gx-panel" tabIndex={t.key === tab ? 0 : -1} onClick={() => setPicked(t.key)}>
                    {t.label}<span className="num">{counts[t.key]}</span>
                  </button>
                ))}
              </div>
              <div id="gx-panel" key={tab} className="gx-panel" role="tabpanel" aria-labelledby={`gx-tab-${tab}`}>
                {tab === "opportunities" ? panel : <div className="gx-stack">{panel}</div>}
                {counts[tab] > limit && (
                  <div className="gx-more-row">
                    <button className="pill pill--ghost" type="button" onClick={() => setLimits({ ...limits, [tab]: limit + SHOWN })}>
                      Show more ({counts[tab] - limit} left)
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <aside className="gx-aside" aria-label="Player and more episodes">
          {wide && (here ? (
            <ClipPlayer clip={here} />
          ) : (
            <div className="card gx-idle">
              <div className="gx-idle__v" aria-hidden="true"><IconPlay /></div>
              <b>Tap any timestamp to play it here</b>
              <span>The player stays here while you browse the tabs.</span>
            </div>
          ))}
          {repeat && (
            <div className="gx-box">
              <h2 className="gx-box__h">Other episodes</h2>
              {p.episodes.slice(1).map((e) => (
                <div className="gx-oe" key={e.videoId}>
                  <button className="gx-ts" type="button" onClick={() => player.play(episodeClip(e))} aria-label={`Play ${e.title}`}>Play</button>
                  <div>{e.title}<span>{[fmtMonth(e.publishedAt), fmtLength(e.durationS)].filter(Boolean).join(" · ")}</span></div>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>

      {p.similar.length > 0 && (
        <section className="gx-similar" aria-labelledby="gx-sim-h">
          <h2 className="gx-box__h" id="gx-sim-h">Similar guests</h2>
          <div className="gx-grid">
            {p.similar.map((g, i) => (
              <GuestCardView key={g.slug} g={g} index={i} open={similarOpen === g.slug} onToggle={() => setSimilarOpen(similarOpen === g.slug ? null : g.slug)} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}
