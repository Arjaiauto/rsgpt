import Link from "next/link";
import { CountBars, MixTable, MonthChart, SpreadBars, TableToggle } from "@/components/insights/Charts";
import { PlayClip } from "@/components/insights/PlayClip";
import { clipQuery } from "@/lib/clip-types";
import { fmtDay, fmtMonth, fmtViews } from "@/lib/guest-format";
import { MIN_GROUP, type GuestStat, type Insights, type ThumbInsights, type Usage } from "@/lib/insights-types";
import { fmtTime } from "@/lib/player-types";

/** The Insights page (FRONTEND_DESIGN.md page 8, scope of Ticket 23d): what the archive holds, which topics and guests
    come up, how views and likes spread, the best clips per topic and how Cuepoint itself is used. Server rendered from
    the aggregates of lib/insights.ts; only the play buttons run in the browser. */

const topicHref = (key: string) => `/clips${clipQuery({ topic: key })}`;
const n = (v: number) => v.toLocaleString("en-IN");

function Section({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children: React.ReactNode }) {
  return (
    <section className="in-sec" aria-labelledby={`${id}-h`}>
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="in-hl" id={`${id}-h`}>{title}</h2>
      {children}
    </section>
  );
}

function Tiles({ items }: { items: { label: string; value: string; note?: string }[] }) {
  return (
    <dl className="in-tiles">
      {items.map((t) => (
        <div className="in-tile" key={t.label}>
          <dt>{t.label}</dt>
          <dd>{t.value}{t.note ? <small>{t.note}</small> : null}</dd>
        </div>
      ))}
    </dl>
  );
}

function GuestList({ title, rows, value }: { title: string; rows: GuestStat[]; value: (g: GuestStat) => string }) {
  return (
    <div className="in-card">
      <h3>{title}</h3>
      <ol className="in-gl">
        {rows.map((g) => (
          <li key={g.slug}><Link href={`/guests/${g.slug}`} prefetch={false}>{g.name}</Link><span>{value(g)}</span></li>
        ))}
      </ol>
    </div>
  );
}

export function InsightsView({ data }: { data: Insights }) {
  const { overview: o, topics, guests, performance: p, best } = data;
  return (
    <>
      <Section id="in-overview" eyebrow="The archive" title={`${n(o.episodes)} episodes, ${n(o.hours)} hours of conversation`}>
        <Tiles items={[
          { label: "Episodes", value: n(o.episodes) },
          { label: "Guests", value: n(o.guests) },
          { label: "Hours", value: n(o.hours) },
          { label: "Clips", value: n(o.clips) },
          { label: "Dates", value: `${fmtMonth(o.first)} to ${fmtMonth(o.last)}` },
          { label: "Languages", value: o.langs.map((l) => `${l.label} ${n(l.n)}`).join(" · ") },
        ]} />
      </Section>

      <Section id="in-topics" eyebrow="Topics" title={topics.takeaway}>
        <p className="in-sub">Episodes with a guest tagged with each topic (an episode can have several). Click a topic for its clips.</p>
        <CountBars label="Episodes per topic" rows={topics.rows.map((t) => ({ key: t.key, label: t.label, n: t.episodes, note: `· ${n(t.clips)} clips`, href: topicHref(t.key) }))} />
        <h3 className="in-h3">How the mix changed by year</h3>
        {topics.mixTakeaway && <p className="in-take">{topics.mixTakeaway}</p>}
        <MixTable mix={topics.mix} href={topicHref} />
        {topics.mix.partial && <p className="in-note">{topics.mix.partial}. Years with fewer than {MIN_GROUP} episodes are left out of the sentence above.</p>}
      </Section>

      <Section id="in-guests" eyebrow="Guests" title={guests.takeaway}>
        <div className="in-two">
          <GuestList title="Most appearances" rows={guests.most} value={(g) => `${g.episodes} episodes`} />
          <GuestList title="Highest average views per episode" rows={guests.topAvg} value={(g) => `${fmtViews(Math.round(g.avgViews))}${g.episodes > 1 ? ` · ${g.episodes} eps` : ""}`} />
        </div>
        {guests.avgTakeaway && <p className="in-note">{guests.avgTakeaway} One viral episode can put a guest on this list.</p>}
        {guests.returning.length > 0 && (
          <>
            <h3 className="in-h3">First appearance or returning guest</h3>
            {guests.returningTakeaway && <p className="in-take">{guests.returningTakeaway}</p>}
            <SpreadBars label="Views per episode, first appearances and returning guests" groups={guests.returning} />
          </>
        )}
      </Section>

      <Section id="in-perf" eyebrow="Performance" title={p.viewsTakeaway || "Views and likes by month"}>
        <p className="in-sub">YouTube&apos;s view and like counts as last stored, by the month an episode came out.</p>
        <MonthChart points={p.months} pick={(m) => m.views} label="Views per episode by month" unit="views" />
        <h3 className="in-h3">Likes</h3>
        {p.likesTakeaway && <p className="in-take">{p.likesTakeaway}</p>}
        <MonthChart points={p.months} pick={(m) => m.likes} label="Likes per episode by month" unit="likes" />
        {p.length.length > 0 && (
          <>
            <h3 className="in-h3">Episode length</h3>
            {p.lengthTakeaway && <p className="in-take">{p.lengthTakeaway}</p>}
            <SpreadBars label="Views per episode by episode length" groups={p.length} />
          </>
        )}
        {p.lang.length > 0 && (
          <>
            <h3 className="in-h3">Language</h3>
            {p.langTakeaway && <p className="in-take">{p.langTakeaway}</p>}
            <SpreadBars label="Views per episode by language" groups={p.lang} href={(k) => `/clips${clipQuery({ lang: k as "hi" | "en" })}`} />
          </>
        )}
        {p.hidden.length > 0 && <p className="in-note">Hidden for having fewer than {MIN_GROUP} episodes: {p.hidden.join(", ")}.</p>}
      </Section>

      {best.topics.length > 0 && (
        <Section id="in-best" eyebrow="Best clips" title={best.takeaway || "The best clips per topic"}>
          <p className="in-sub">The three highest-scoring clips in the topics with the most clips. Play opens the mini player.</p>
          <div className="in-best">
            {best.topics.map((t) => (
              <div className="in-card" key={t.key}>
                <h3><Link href={topicHref(t.key)} prefetch={false}>{t.label}</Link></h3>
                <ul className="in-clips">
                  {t.clips.map((c) => (
                    <li key={c.id}>
                      <PlayClip c={c} />
                      <span className="in-clip-t"><b>{c.topic}</b><small>{c.guest || c.episode} · {fmtTime(c.endS - c.startS)} · score {c.score.toFixed(2)}</small></span>
                    </li>
                  ))}
                </ul>
                <Link className="in-more" href={topicHref(t.key)} prefetch={false}>All {t.label} clips</Link>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

const rel = (v: number) => `${v.toFixed(2)}x`;

/** Thumbnails (Ticket 23e): how the thumbnails' style changed (facts), then each feature against views, compared
    within the same year (patterns). No thumbnail image is shown (CLAUDE.md rule 1). */
export function ThumbnailsView({ t }: { t: ThumbInsights }) {
  return (
    <Section id="in-thumbs" eyebrow="Thumbnails" title={t.headline}>
      <p className="in-sub">
        What {n(t.analysed)} of {n(t.episodes)} episodes&apos; YouTube thumbnails show (faces, headline text, brightness), measured from the images, which
        are never shown here.
      </p>
      <h3 className="in-h3 in-h3--first">How the thumbnails changed</h3>
      {t.shifts.length
        ? <ul className="in-fall">{t.shifts.map((f) => <li key={f.key}>{f.text}</li>)}</ul>
        : <p className="in-take">No feature&apos;s share of thumbnails moved 10 points from the first year to the latest.</p>}
      <p className="in-note">Share of each year&apos;s thumbnails with the feature, first year to latest; moves of 10 points or more.</p>

      <h3 className="in-h3">Features and views</h3>
      <p className="in-sub">
        Each card compares episodes with a feature to episodes without it, in views relative to the median of the same year (1.00x is a typical
        episode of that year), so older episodes&apos; extra time to collect views doesn&apos;t count. When the years disagree, the card says
        so. Only features with at least {MIN_GROUP} episodes on each side are shown.
      </p>
      <p className="in-badge">Pattern, not proof</p>
      <p className="in-legend in-legend--top">
        <span><i className="sq" /> median, relative to the year</span><span><i className="wh" /> middle half of episodes</span><span><i className="avg" /> average</span>
      </p>
      <div className="in-thumbs">
        {t.patterns.map((p) => (
          <div className={`in-card${p.mixed ? " in-card--mixed" : ""}`} key={p.key}>
            <h3>{p.label}<small>{p.with.n} with · {p.without.n} without</small></h3>
            <p className="in-take in-take--sm">{p.takeaway}</p>
            <SpreadBars compact groups={[p.with, p.without]} format={rel} unit="views relative to the year" label={`${p.label}: views relative to the year, with and without`} />
            <p className="in-note">
              {p.years.length
                ? <>By year: {p.years.map((y) => `${y.year} ${y.ratio.toFixed(1)}x (${y.nWith} with, ${y.nWithout} without)`).join(" · ")}</>
                : <>No single year has {MIN_GROUP} episodes on each side.</>}
            </p>
          </div>
        ))}
      </div>
      <TableToggle>
        <table className="in-dt">
          <thead><tr><th scope="col">Feature</th><th scope="col">With</th><th scope="col">Without</th><th scope="col">Median with</th><th scope="col">Median without</th><th scope="col">Ratio</th><th scope="col">Years agree</th></tr></thead>
          <tbody>{t.patterns.map((p) => (
            <tr key={p.key}><th scope="row">{p.label}</th><td>{p.with.n}</td><td>{p.without.n}</td><td>{rel(p.with.median)}</td><td>{rel(p.without.median)}</td><td>{p.ratio.toFixed(2)}x</td><td>{p.mixed ? "No (mixed)" : "Yes"}</td></tr>
          ))}</tbody>
        </table>
      </TableToggle>
      <p className="in-note">
        {t.hidden.length > 0 && <>Hidden for having fewer than {MIN_GROUP} episodes on one side: {t.hidden.join(", ")}. </>}
        &quot;Brighter&quot; and &quot;higher contrast&quot; mean above the archive&apos;s median (lightness {t.brightness.toFixed(0)} of 100, contrast {t.contrast.toFixed(0)}).
        The view-count badge the channel adds to thumbnails is left out, and who appears is not identified, only faces counted.
      </p>
    </Section>
  );
}

export function UsageView({ u }: { u: Usage }) {
  return (
    <Section id="in-usage" eyebrow="Use of Cuepoint" title={u.takeaway || "How Cuepoint is used"}>
      <Tiles items={[
        { label: "Questions asked", value: n(u.questions) },
        { label: "Prep briefs built", value: n(u.briefs) },
        { label: "Web research runs", value: n(u.web) },
        { label: "Clips saved", value: n(u.saved.clip), note: u.saved.answer || u.saved.brief ? ` + ${n(u.saved.answer)} answers, ${n(u.saved.brief)} briefs` : undefined },
      ]} />
      {u.topics.length > 0 && (
        <>
          <h3 className="in-h3">Most-asked topics</h3>
          <CountBars label="Questions per topic" rows={u.topics.map((t) => ({ key: t.key, label: t.label, n: t.n, href: topicHref(t.key) }))} />
        </>
      )}
      <p className="in-note">
        {u.since ? `Since ${fmtDay(u.since)}. ` : ""}A question&apos;s topics are those of the guests whose episodes its answer cited. Test runs are left out, and
        the Prep brief&apos;s web research is counted on its own. Updated every 10 minutes.
      </p>
    </Section>
  );
}
