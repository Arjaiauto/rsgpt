import { Hero } from "@/components/home/Hero";
import { Explorer } from "@/components/home/Explorer";
import { StoryEffects } from "@/components/home/StoryEffects";
import { LoginButton } from "@/components/home/LoginButton";
import "./home.css";

/* Build numbers from FRONTEND_DESIGN.md (Page 1A) and gate 2. Extraction and "What's inside" counts match the
   database for the final run (extract-haiku-v5-20261023-011718), checked 2026-10-27: 36,797 rows extracted,
   36,197 verified (98.4%); verified clips 2,705; verified host questions 18,533; 429 guests (unique guest_key). */
const STAGES = [
  { name: "Episodes", count: "499", text: "499", note: "of the latest 500 episodes transcribed; one age-restricted episode skipped." },
  { name: "Transcripts", count: "1.04", dec: "2", suffix: "M", text: "1.04M", note: "timed lines, from YouTube captions first and audio transcription where captions were missing." },
  { name: "Hindi", count: "676500", text: "676,500", note: "Hindi lines written in Roman Hinglish and translated to English, so any phrasing finds them." },
  { name: "Speakers", count: "99", suffix: "%", text: "99%", note: "of lines labelled host or guest, so opinions are credited to the right person." },
  { name: "Extraction", count: "36797", text: "36,797", note: "takeaways, quotes, clips and questions pulled out; 36,197 (98.4%) passed the timestamp and exact-quote checks." },
  { name: "Search", count: "35234", text: "35,234", note: "searchable passages in English, Hinglish and Hindi; most answers arrive in 1 to 3 seconds." },
];

const ACCURACY: [string, number][] = [
  ["Takeaways", 100], ["Opportunities", 100], ["Clips", 100], ["Guest profiles", 100],
  ["Quotes", 96], ["Host questions", 95], ["Disagreements", 88], ["Host opinions", 86],
];

const TILES = [
  { count: "36197", text: "36,197", note: "verified items: takeaways, opportunities, quotes, disagreements, clips and host questions" },
  { count: "2705", text: "2,705", note: "clips of 30 to 90 seconds that stand on their own" },
  { count: "429", text: "429", note: "guests, each profile dated to their episode" },
  { count: "18533", text: "18,533", note: "questions the host asked, sorted by type" },
  { count: "13", text: "13", note: "opportunity categories, from growing sectors to warnings" },
  { count: "3", text: "3", note: "languages you can ask in: English, Hindi and Hinglish" },
];

export default function Home() {
  return (
    <div className="home">
      <Hero />
      <main className="story">
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
              {STAGES.map((s, i) => (
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
                <div className="acc__big num" data-count="96" data-suffix="%" aria-label="96 percent">96%</div>
                <p className="acc__cap">
                  209 items picked at random from 50 episodes and checked against the episode itself. 199 were correct. Most of the
                  rest credited a guest&apos;s line to the host.
                </p>
              </div>
              <ul className="bars" id="bars">
                {ACCURACY.map(([name, pct]) => (
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
              {TILES.map((t) => (
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
              <Explorer />
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
      </main>
      <StoryEffects />
    </div>
  );
}
