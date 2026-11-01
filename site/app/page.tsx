import { Hero } from "@/components/home/Hero";
import { Explorer } from "@/components/home/Explorer";
import { StoryEffects } from "@/components/home/StoryEffects";
import { LoginButton } from "@/components/home/LoginButton";
import { getHomeExplorer } from "@/lib/home-explorer";
import { getSiteStats, type SiteStats } from "@/lib/site-stats";
import "./home.css";

/* Gate 2: a one-time hand review of a random sample (data/gate2_report.md, Ticket 17, 2026-10-26).
   These are not live counts, so they stay fixed here; every other number comes from getSiteStats(). */
const GATE2 = {
  accuracyPct: 96,
  itemsReviewed: 209,
  itemsCorrect: 199,
  episodesSampled: 50,
  byType: [
    ["Takeaways", 100], ["Opportunities", 100], ["Clips", 100], ["Guest profiles", 100],
    ["Quotes", 96], ["Host questions", 95], ["Disagreements", 88], ["Host opinions", 86],
  ] as [string, number][],
};

const n = (v: number) => v.toLocaleString("en-US");

/** One count-up number: data-count is the target, the text is the final value (shown without JavaScript). */
type Big = { count: string; dec?: string; suffix?: string; text: string };
const big = (v: number, dec = 0, suffix = ""): Big => ({
  count: String(v), dec: dec ? String(dec) : undefined, suffix: suffix || undefined,
  text: (dec ? v.toFixed(dec) : n(v)) + suffix,
});

function stages(s: SiteStats) {
  const millions = Math.round(s.transcriptLines / 10_000) / 100;
  const skipped = s.episodesSkipped === 1 ? "one episode skipped" : `${n(s.episodesSkipped)} episodes skipped`;
  return [
    { name: "Episodes", ...big(s.episodesTranscribed), note: `of the latest ${n(s.episodesListed)} episodes transcribed${s.episodesSkipped ? `; ${skipped} (age-restricted)` : ""}.` },
    { name: "Transcripts", ...big(millions, 2, "M"), note: "timed lines, from YouTube captions first and audio transcription where captions were missing." },
    { name: "Hindi", ...big(s.hindiLines), note: "Hindi lines written in Roman Hinglish and translated to English, so any phrasing finds them." },
    { name: "Speakers", ...big(s.speakerLabelledPct, 1, "%"), note: "of lines labelled host or guest, so opinions are credited to the right person." },
    { name: "Extraction", ...big(s.extracted), note: `takeaways, quotes, clips and questions pulled out; ${n(s.verified)} (${s.verifiedPct.toFixed(1)}%) passed the timestamp and exact-quote checks.` },
    { name: "Search", ...big(s.passages), note: "searchable passages in English, Hinglish and Hindi; most answers arrive in 1 to 3 seconds." },
  ];
}

function tiles(s: SiteStats) {
  return [
    { ...big(s.verified), note: "verified items: takeaways, opportunities, quotes, disagreements, clips and host questions" },
    { ...big(s.verifiedClips), note: "clips of 30 to 90 seconds that stand on their own" },
    { ...big(s.guests), note: "guests, each profile dated to their episode" },
    { ...big(s.verifiedHostQuestions), note: "questions the host asked, sorted by type" },
    { ...big(s.opportunityCategories), note: "opportunity categories, from growing sectors to warnings" },
    // A product fact, not a data count.
    { ...big(3), note: "languages you can ask in: English, Hindi and Hinglish" },
  ];
}

export default async function Home() {
  // Counted from verified rows in Supabase, cached for 24 hours (lib/site-stats.ts).
  const [stats, explorer] = await Promise.all([getSiteStats(), getHomeExplorer()]);
  return (
    <main id="main" className="home" tabIndex={-1}>
      <Hero />
      <div className="story">
        <section id="built" aria-labelledby="built-h">
          <div className="wrap">
            <p className="eyebrow">How it was built</p>
            <h2 className="h2" id="built-h">From 500 episodes to one search box</h2>
            <p className="lead">
              Every episode went through the same six steps. Each step is checked by code before the next one starts, so nothing
              reaches the search box that can&apos;t be traced back to a moment in an episode.
            </p>
            <ol className="pipe" id="pipe">
              <div className="pipe__track" aria-hidden="true"><div className="pipe__fill" id="pipefill" /></div>
              {stages(stats).map((s, i) => (
                <li className="stage on" key={s.name}>
                  <span className="dot">{i + 1}</span>
                  <h3>{s.name}</h3>
                  <span className="big num" data-count={s.count} data-dec={s.dec} data-suffix={s.suffix}>{s.text}</span>
                  <p>{s.note}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="accuracy" aria-labelledby="acc-h">
          <div className="wrap">
            <p className="eyebrow">How we checked accuracy</p>
            <h2 className="h2" id="acc-h">Checked by hand, not only by code</h2>
            <div className="acc">
              <div className="acc__num">
                <div className="acc__big num" data-count={GATE2.accuracyPct} data-suffix="%" aria-label={`${GATE2.accuracyPct} percent`}>{GATE2.accuracyPct}%</div>
                <p className="acc__cap">
                  {GATE2.itemsReviewed} items picked at random from {GATE2.episodesSampled} episodes and checked against the
                  episode itself. {GATE2.itemsCorrect} were correct. Most of the rest credited a guest&apos;s line to the host.
                </p>
              </div>
              <ul className="bars" id="bars">
                {GATE2.byType.map(([name, pct]) => (
                  <li className="bar" key={name}>
                    <span>{name}</span>
                    <span className="bar__t"><span className={`bar__f${pct < 90 ? " lo" : ""}`} style={{ width: `${pct}%` }} /></span>
                    <b className="num">{pct}%</b>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section id="inside" aria-labelledby="in-h">
          <div className="wrap">
            <p className="eyebrow">What&apos;s inside</p>
            <h2 className="h2" id="in-h">Every answer points to a moment</h2>
            <div className="tiles">
              {tiles(stats).map((t) => (
                <div className="tile" key={t.note}>
                  <span className="big num" data-count={t.count}>{t.text}</span>
                  <p>{t.note}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="insights" aria-labelledby="ins-h">
          <div className="wrap">
            <p className="eyebrow">Insights preview</p>
            <h2 className="h2" id="ins-h">Patterns behind the views</h2>
            <p className="lead">
              Each episode&apos;s views are compared with typical episodes of the same age. These are patterns, not proof: guest fame,
              news and the algorithm move views too.
            </p>
            <div className="ins" id="ins">
              {explorer ? <Explorer data={explorer} /> : (
                <div className="card explorer">
                  <div className="ex__head"><h3>Explore the patterns</h3></div>
                  <p className="sub">Data unavailable right now. Try again in a few minutes.</p>
                </div>
              )}
              <div className="card answer">
                <h3>One question, answered<span className="tag">SAMPLE ANSWER</span></h3>
                <div className="q"><i aria-hidden="true">Q</i>What have founders said about raising their first round?</div>
                <ul className="ans">
                  <li>Several founders said their first cheque came from people who already knew their work, not from cold pitches.<span className="cite">Guest A · Mar 2025 · 41:12</span></li>
                  <li>One guest advised raising only after a few paying customers, so the pitch rests on numbers rather than an idea.<span className="cite">Guest B · Aug 2024 · 18:05</span></li>
                  <li>Another warned that taking too much money too early made later rounds harder.<span className="cite">Guest C · Jan 2026 · 1:02:40</span></li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section className="cta" aria-labelledby="cta-h">
          <div className="wrap">
            <h2 className="h2" id="cta-h">Ask your first question</h2>
            <LoginButton className="pill pill--primary" />
          </div>
        </section>
      </div>
      <StoryEffects />
    </main>
  );
}
