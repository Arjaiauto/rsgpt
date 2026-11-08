# Cuepoint multi-tenant audit (read-only)

Audited: 2026-11-08, branch `27-search`, working tree clean. Nothing was modified, run or queried; every finding comes from files in the repo.

**What the repo can and cannot tell us.** There is no `migrations/` or `supabase/` folder. The database is defined by `pipeline/schema.sql` (first tables) plus 21 loose files in `pipeline/sql/`, each run by hand in the Supabase SQL editor. Two of those files say "NOT RUN YET" in their header (`hybrid_search_scoped.sql:2`, `answer_feedback.sql:1`), so the repo cannot prove what the live DB has. The SQL at the end of this file confirms it.

**Headline findings (read these first)**

1. **No table has a `channel_id`.** The whole data model is "one archive". `episodes.video_id` (text, YouTube id) is the primary key and every other table hangs off it (`pipeline/schema.sql:17`).
2. **The site shows only rows from one hard-coded extraction run**: `ARCHIVE_RUN_ID = "extract-haiku-v5-20261023-011718"` (`site/lib/archive-run.ts:3`), filtered in 10 files (area 7). This is the de facto "tenant filter" today, and it is a global constant.
3. **"Raj" is baked into the schema, not just the copy.** `segments.speaker` has `CHECK (speaker in ('raj','guest','unknown'))` (`schema.sql:41`) and `insights.type` has `raj_opinion` / `raj_question` (`schema.sql:131`). Those strings are also in about 25 code files, the extraction prompts and the cost-bearing verification logic.
4. **Auth is one shared password plus a typed first name**, and "who is the user" is that first name, stored as plain text on `saved_items`, `qa_log`, `reports` and `answer_feedback`. There is no user id, no email, no workspace.
5. **All security is in app code.** RLS is on for every table with zero policies, and the site uses the service-role key everywhere (`site/lib/db.ts:12-20`), which bypasses RLS. A missing `channel_id` filter in any query would leak across tenants, so isolation must be added in code *and* in the DB.
6. **The "14 topics" are not a fixed list.** They are the top 14 free-text `sector_tags` that at least 5 guests share (`site/lib/guests.ts:146-147`). That is already data-driven, which is good news for multi-tenancy.

---

## 1. FO / Raj hardcoding

Categories: **(a)** branding/copy, **(b)** LLM prompt, **(c)** data/logic, **(d)** config/ID.

### 1.1 Branding, copy, metadata (a)

| File:line | What it is | Cat | Should become |
|---|---|---|---|
| `site/app/layout.tsx:11` | Meta description "The searchable brain of the Figuring Out podcast…" | a | `channel.tagline` template using `channel.show_name` |
| `site/app/layout.tsx:14` | `metadataBase` fallback `https://cuepoint-two.vercel.app` | d | `PLATFORM_URL` env; per-channel subdomain/custom domain later |
| `site/app/layout.tsx:15-18` | Title `Cuepoint`, siteName, locale `en_IN` | a/d | platform name stays; locale becomes `channel.locale` |
| `site/app/layout.tsx:24` and `site/lib/prep/export.ts:9`, `site/lib/clip-types.ts:112`, `site/components/tour/Tour.tsx:163`, `site/app/global-error.tsx:23`, `site/app/opengraph-image.tsx:43`, `site/lib/future-deck.ts:237`, `pipeline/04_bakeoff.py:406`, `08_transcript_view.py:31`, `09_gate1_report.py:163,275`, `11_search_test.py:99`, `review_app.py:60` | "Unofficial project, not affiliated with Figuring Out. Every answer links to its source." (12 copies, no shared constant) | a | One `disclaimer(channel)` function. **Decide the legal position first**: this line only makes sense while the creator has *not* signed up. Once they connect their own channel it should go, or become "Powered by Cuepoint". |
| `site/app/opengraph-image.tsx:5,26`, `site/app/twitter-image.tsx:5` | OG alt text and "Every Figuring Out episode, searchable" | a | Per-channel OG image route `/c/[slug]/opengraph-image` using channel name and accent colour |
| `site/components/home/Hero.tsx:139` | Headline "500 episodes." (hard-coded, not from DB, breaks rule 9 too) | a/c | `stats.episodesTranscribed` |
| `site/app/page.tsx:15,66,33-35` | `GATE2.episodesSampled: 50` (a one-off audit result), "From 500 episodes to one search box", "(age-restricted)" note | a/c | stats-driven; audit results become per-channel QA record or are removed from public copy |
| `site/lib/site-stats.ts:36-52` | `SNAPSHOT` fallback: 500 listed, 499 transcribed, 1,047,059 lines, 36,797 extracted, 2,705 clips, 428 guests, 35,234 passages, counted 2026-10-27 | c | Remove the fallback or key it per channel; it will show FO's numbers on a new channel whenever the DB read fails |
| `site/lib/ask/config.ts:50` | `HOST_NAME = "Raj Shamani"` used for every speaker chip | c | `channel.host_names[]` (supports co-hosts) |
| `site/lib/ask/config.ts:~66-82` | `COVERED_QUESTIONS` and `EXAMPLE_QUESTIONS` incl. "Raj ka AI ke baare mein kya opinion hai?" (checked against FO archive 2026-10-27) | a | Generated per channel after ingest (top topics → example questions), editable in settings |
| `site/lib/future-deck.ts:34,144,223,232,234,237` | Whole Future page is a pitch to Figuring Out: "Figuring Out's raw studio files", demo episode "Sandeep Das \| FO455 Raj Shamani", "I'm also happy to rebuild this whole demo on Figuring Out's raw files" | a | Delete for creators, or make it a generic roadmap page. Not per-channel data. |
| `site/app/(app)/future/*`, `site/components/future/FutureDeck.tsx` | Renders the above | a | same |
| `site/lib/tour.ts` (slides at 28-130), `site/public/tour/*.webp` (14 screenshots), `site/public/tour/pins.json` | Welcome tour text and **screenshots of the live FO site** (contain FO episode titles, guest names) | a | Generic copy; screenshots regenerated from a demo channel (`site/scripts/tour-capture.mjs`) or dropped |
| `site/components/Logo.tsx`, `site/app/icon.svg`, `site/app/apple-icon.tsx` | Cuepoint logo (platform brand, not FO) | a | Stays platform-level; add optional `channel.logo_url` in header |
| `design/*.html`, `design/FRONTEND_DESIGN.md:44,105,134,298` | Mockups and spec name Raj / Figuring Out | a | Reference only |
| `README.md:3,7,40-43`, `site/README.md:3,5`, `CLAUDE.md:5` | Project docs; rule 1 forbids first-person Raj, photos, branding | a | Rewrite once the product is multi-tenant. **Rule 1 needs a platform-level restatement** ("never impersonate a creator; never use creator branding without their verified connection"). |
| `site/app/robots.ts`, `site/next.config.ts:~25` | Site-wide `X-Robots-Tag: noindex, nofollow` | d | Per-channel `is_public` flag (creators will probably want search indexing off by default, on later) |
| `site/vercel.json` | `regions: ["bom1"]` (Mumbai) | d | Fine for India-first; DB region must match |
| Colours | Violet accent in `site/app/globals.css` / `home.css`, `#101117` background | a | `channel.accent` CSS variable (optional); not hard-coded per FO today, just platform styling |

### 1.2 LLM prompts naming the show or host (b)

| File:line | Prompt | Should become |
|---|---|---|
| `site/lib/ask/answer.ts:31` | Answer system prompt: "You answer questions about the Figuring Out podcast, hosted by Raj Shamani…" | Template: `{show_name}`, `{host_names}`. Keep prompt cache working (`answer.ts:94` uses `cache_control: ephemeral`): one cached prompt **per channel**, not per request. |
| `site/lib/ask/answer.ts:37` | Examples "Raj said…", "Nikhil Kamath said…" (names a real FO guest) | generic example names |
| `site/lib/ask/answer.ts:52,107,112,167` | `t.speaker === "raj" ? "Host"`; name matcher `{name:"Raj Shamani", words:{raj,shamani,host,राज}}` | derive from `channel.host_names`, incl. Devanagari forms; the Hindi spelling is hard-coded |
| `site/lib/ask/answer.ts:238` | Follow-up prompt "…about the Figuring Out podcast archive" | `{show_name}` |
| `site/lib/ask/retrieve.ts:34,41` | Query-rewrite prompt "…transcripts from the Figuring Out podcast, hosted by Raj Shamani"; `host_view` flag = "the host's (Raj's) own opinion" | `{show_name}`, `{host_names}`; rename `host_view` field is fine, it is already generic internally |
| `site/lib/ask/retrieve.ts:214-216`, `config.ts:26` | `host_view` boosts recent episodes with a 730-day half-life | per-channel tunable (default 730) |
| `site/lib/ask/retrieve.ts:281`, `types.ts:13,61` | Speaker type `"raj"\|"guest"\|"unknown"` | `"host"\|"guest"\|"unknown"` |
| `site/lib/prep/build.ts:746,782` | Prep-brief prompts: "…team behind the Figuring Out podcast (host Raj Shamani)…" | `{show_name}`, `{host_names}` |
| `site/lib/prep/build.ts:729-736` | "Describe people in the third person ("Raj said…", "Ananya Rao said…")" | generic examples |
| `site/lib/prep/build.ts:462,686` | Regexes drop texts matching `\b(raj\|the host\|the models?)\b` / `^(raj\|the host\|host)` | build regex from `host_names` |
| `site/lib/prep/build.ts:548,551,556,577` | Speaker/name matching with `{raj, shamani, host}` | same |
| `site/lib/prep/web.ts:40` | `OWN_SHOW = /raj\s*shamani\|figuring\s*out\|\bFO\s?\d{2,4}\b\|rajshamani/i`, used to exclude the show's own pages from "other appearances" | built per channel from show name, handle, host names, episode code pattern |
| `site/lib/prep/web.ts:13` | Prep web research uses `openai/gpt-oss-120b` on Groq, plus Tavily search | stays; cost line per brief |
| `pipeline/06_extract.py:173,176,179,185,188,196,200-209` | Speaker-labelling and extraction system prompts name Raj Shamani, "Figuring Out", use `r = Raj`, and ask for `raj_question` / `raj_opinion` / "Raj's side and the guest's side" | Parameterize with host names. **A new prompt version means a new Gate 1** per the comment at `06_extract.py:109-113`. |
| `pipeline/06_extract.py:9,22,25,29,143,225,521,584-586,617-618,671-672,770,899,1268` | `LETTERS = {"r":"raj"…}`, `RAJ_TURNS_FOR_QUESTIONS`, `raj_turns()`, item kinds `raj_question`/`raj_opinion` | rename kinds to `host_question`/`host_opinion` (needs a DB migration, see area 2) |
| `pipeline/08_ai_precheck.py:56,65,84-89,154` | Verifier prompt: "Raj Shamani is the host", `SPEAKER_LETTERS = {"raj":"R"…}` | same |
| `pipeline/07_check.py:21-22,273-278,408` | Checker rules "cites at least one segment whose speaker is raj" | `speaker == 'host'` |
| `pipeline/09_build_chunks.py:11-16,78,203` | Chunk text is literally `Raj: …` / `Guest: …` and the header "Episode: title \| date \| Guest: …". **The embedded text contains the string "Raj"**, so embeddings carry it. | `SPEAKER_LABELS` from channel host name. Re-embedding is needed only if the label changes for FO; new channels embed once. |
| `pipeline/11_search_test.py:33-41` | Test questions about "Raj" | per-channel test set |
| `pipeline/sql/hybrid_search_scoped.sql:113`, `search_v3.sql:89` | `'raj'` is in the SQL stop-word list for keyword search | remove or pass as a parameter (host words) |

### 1.3 Data and logic (c)

| File:line | What | Should become |
|---|---|---|
| `site/lib/guest-name.ts:9,32-35,48` | Guest-name extraction from titles assumes `"… \| FO439 Raj Shamani"` (name is the part before `FO<number>`); stop-words `raj`, `shamani` | Per-channel **title parsing rule** (regex or LLM-assisted guest extraction); the pipeline already extracts guests from transcripts, so this is a fallback |
| `site/lib/home-explorer.ts:26-29` | Strips `\|?\s*FO\s?\d+.*$` and "raj shamani" from titles for display | `channel.title_strip_pattern` |
| `site/lib/search/normalize.ts:22-35` | `HOST_WORDS = {"raj","shamani"}`; stop-word string includes "raj shamani … figuring" | `channel.host_words` |
| `site/lib/search/entities.ts:24-27,80` | Excludes `HOST_WORDS` and `/^fo\d+$/` from title matching | per-channel episode-code regex |
| `site/lib/search/search.ts:176` | Filters host words from keywords | same |
| `site/lib/ask/snippet.ts:17` | Stop-word list ends "…host raj shamani" | same |
| `site/lib/ask/sentences.ts:94` | Comment/logic example names "Raj ne Mohandas Pai ke episode mein bataya…" | comment only |
| `site/lib/guest-format.ts:102-119` | Splits a disagreement into "Raj asks … and the guest says …" by looking for the words "raj" and "the guest" | depends on how extraction phrases it; use `{host}` token in extraction output instead of parsing prose |
| `pipeline/21_build_search_suggestions.py:8,271` | Episode alias `FO547` / `FO 547` | per-channel episode-code regex |
| `pipeline/romanize_lib.py:106` | Drops caption parts matching `\bF[O0]\s?\d+\|Raj Shamani` | same |
| `pipeline/13_guest_photos.py:69` | `BRANDING = /raj\s*shamani\|shamani\|figuring\s*out\|rajshamani/` rejects Commons photos that mention the show | `{show_name, host_names, handle}` |
| `pipeline/17_thumbnail_features.py:241` | `LOGO` regex hides "FIGURING OUT / WITH RAJ SHAMANI" from OCR'd thumbnail text | per-channel |
| `pipeline/12_guest_links.py:103` | User-agent string names the "Figuring Out podcast archive" | generic |
| `pipeline/12_guest_links.py:119` | `AUTO_YT_KEEP = {"khan-sir--": "https://www.youtube.com/@khanglobalstudies"}`, a hand-fix for one FO guest | move to a per-channel overrides table |
| `pipeline/corrections.json` and `pipeline/14_apply_corrections.py` | Hand corrections to guests/insights/clips of the FO run (org, bio, merged `guest_key`s), keyed by FO ids | per-channel corrections file/table |
| `pipeline/sql/visitors_events.sql:75-80` | `is_test_name()` hard-codes `'arjun','test-script','tester','test-other'` | `profiles.is_internal` flag or platform admin list |
| `pipeline/sql/cleanup_test_rows.sql:4-5` | One-off cleanup of 'Tester' rows | historic, delete |
| `site/lib/guests.ts:146-147` | "14 topics": `n >= 5`, `.slice(0, 14)` | thresholds as settings; works unchanged for any channel with enough guests, but a small channel (10 guests) would show **zero** topics |
| `pipeline/21_build_search_suggestions.py` (topic kind) | Topic suggestion needs ≥3 guests per tag | same small-channel issue |
| `site/lib/guests.ts:59`, `pipeline/15_clip_speakers.py` | Clip belongs to guest only if `guest_share >= 0.5` (host-speaks-most clips hidden) | wrong for **solo creators/monologue channels**: their clips would all be hidden. Needs a `format` setting (interview / solo / panel). |
| `site/lib/ask/config.ts:85-100` | Answer language options "Hindi / Hinglish / English" and the Devanagari detection | `channel.languages`; the Hinglish romanization pipeline is a big India-specific asset, other languages need other handling |
| `site/lib/future-deck.ts`, `site/lib/prep/*` | The Prep brief assumes the user is *the show's team preparing a guest*. | OK for interview creators; not for solo/educational creators |

### 1.4 IDs, handles, config (d)

| File:line | What | Should become |
|---|---|---|
| `pipeline/01_fetch_episodes.py:1,37` | `CHANNEL_HANDLE = "@rajshamani"`, stops at 500 episodes (`--limit 500`), ≥20 min, no Shorts/live | `channels.youtube_handle` / `youtube_channel_id` / `uploads_playlist_id`; limit and min-length as settings |
| `pipeline/load_episodes.py:2` | "Load the 500 candidate episodes from data/candidates.csv" | reads from the fetch step directly into DB |
| `site/lib/archive-run.ts:3` | `ARCHIVE_RUN_ID` constant | per-channel `channels.published_run_id` (or drop run filtering by promoting a run) |
| `pipeline/09_build_chunks.py:89` | `RUN_ID_PATH = data/extractions/haiku/v5/run_id.txt` | per-channel run id from DB |
| No channel ID / playlist ID (`UC…`, `PL…`) appears anywhere in the repo | only the handle in `01_fetch_episodes.py:37` | n/a |
| `data/*`, `audio/*` | Local working files, git-ignored (`episodes.csv`, `candidates.csv`, `captions/`, `transcripts/`, `extractions/`, `review/`, `Guest Images/`) | Move to object storage under `channel_id/` prefix, or a per-channel work dir |

---

## 2. Database: tables and views

RLS: **enabled on every table, no policies anywhere** (`schema.sql:195-206`, and each `sql/*.sql`). Most tables also `revoke all … from anon, authenticated`. Only the service role can read/write, so RLS never evaluates today. "Per-user" means holds data tied to a typed first name.

Source for each: `schema.sql` unless noted. `.from()` usage = files under `site/` that query it.

| Table / view | Purpose | Key columns | Needs `channel_id`? | Per-user data? | Notes / shared-row risk |
|---|---|---|---|---|---|
| `episodes` | One row per YouTube video | `video_id` text **PK**, title, published_at, duration_seconds, view_count, like_count, comment_count, url, caption_language, in_test_set, status | **Yes (add `channel_id`)** | No | PK is the YouTube video id, globally unique, so no collision, but **the same video could be uploaded to two channels** (collabs, clips). Decide: one row per (channel, video). `status` values: listed/transcribed/skipped. Queried: `archive.ts:28`, `ask/scope.ts:24`, `clips.ts:40`, `guests.ts:97,169`, `home-explorer.ts:116`, `insights.ts:87,362`, `prep/build.ts:124,202,412`, `findline.ts:25`, `retrieve.ts:239` |
| `segments` | Timed transcript lines (about 1.05M rows) | id, `video_id`→episodes, seq, start_s, end_s, **speaker** (`raj/guest/unknown` CHECK), text_original, text_roman, source (`youtube_auto/groq/sarvam` CHECK) | Inherit via episode; add denormalized `channel_id` for indexes/RLS | No | Enum values name the host. `source` list needs new transcribers if you add Whisper-on-your-own-audio. Indexes: trigram on text_roman/original (`find_line.sql:17-21`) |
| `translation_segments` | English translation lines for Hindi episodes (about 732k) | id, video_id, start_s, end_s, text | same | No | Hindi-only; becomes "translation of non-English source" |
| `chunks` | ~90 s retrieval chunks (about 35k) with 512-d embedding + tsvector | id, video_id, start_s, end_s, text, published_at, embedding vector(512), text_search tsvector | **Yes, denormalized `channel_id`** (search RPCs read this table directly) | No | `text` starts with "Episode: title \| date \| Guest: …" and `Raj:`/`Guest:` labels. Indexes `chunks_embedding_idx` HNSW (global), `chunks_text_search_idx` GIN, `chunks_video_idx` |
| `guests` | Per-episode guest rows from extraction, merged by `guest_key` | id, name, organisation, role_at_episode, sector_tags text[], bio, video_id, **run_id**, verified, check_notes, guest_key, linkedin_url, linkedin_verified, linkedin_search_url, youtube_channel_url, youtube_verified, wikipedia_url/description/verified, link_source, photo_url/credit/license/source (`sql/guest_photos.sql`) | **Yes** | No (public figures; rule 3 limits contact data) | **Shared-row candidate #1.** The same person appears on many channels (Nikhil Kamath-style guests). `guest_key` (normalised name+org) is a global slug namespace used in URLs (`/guests/[slug]`). Two sensible designs: (A) keep `guests` per channel and duplicate; (B) a global `people` table (name, links, photo, wikipedia) + `channel_guests` (episode appearances, bio, role). Photos/links/Wikipedia/LinkedIn-verification are expensive and channel-independent, so B saves real work and money. B conflicts with rule 3 only if one channel's "manual" verification is shown to others, so keep `link_source` + reviewer on the shared row. |
| `insights` | Takeaways, opportunities, quotes, disagreements, host opinions/questions (about 36k) | id, video_id, guest_id, **type** CHECK (…`raj_opinion`,`raj_question`), category CHECK (13 fixed values), text, start_s, end_s, source_segment_ids int[], translated, verified, check_notes, model, run_id | **Yes** | No | Type enum and the 13 `category` values (growing_sectors, business_ideas, … `schema.sql:134-137`) are tuned to FO's business/startup content; a fitness or comedy channel needs different categories → make `category` a per-channel list (drop the CHECK) |
| `clips` | Model-picked short clips | id, video_id, start_s, end_s, opening_line, topic, score, verified, model, run_id, check_notes, **guest_share** (`clip_speakers.sql:10`) | **Yes** | No | `topic` is free text per clip |
| `reviews` | Manual verdicts (correct/wrong/unsure) on rows in other tables | id, item_table, item_id, verdict, note, created_at | **Yes** (or via item) | Reviewer identity absent | Used only by `pipeline/review_app.py:275,492` and gate reports. Add `reviewer_id` |
| `feedback` | Visitor notes about a page | id, page, item_id, note, visitor_id | Yes | Yes (visitor_id) | **No `.from('feedback')` in `site/`**: probably unused. Verify (SQL below) |
| `qa_log` | Every Ask question, answer, cited chunk ids, timings | id, question, answer, cited_chunk_ids int[], visitor_id, visitor_ref, language, found, first_name, latency_ms, timings jsonb, kind (`ask/brief`), scope jsonb, created_at | **Yes** + `user_id`, `workspace_id` | **Yes** (question text + first name) | Also used as a cost/usage meter (`eta.ts:36`, `insights.ts:264`, `prep/web/route.ts:38-91` counts web-research calls via `question like '[web] %'`). `cited_chunk_ids` is `int[]` while `chunks.id` is bigint |
| `reports` | Error reports | id, item_type CHECK, item_id text, video_id, start_s, reason CHECK, note ≤280, first_name, visitor_id, visitor_ref, page, status | **Yes** (via video) + `user_id` | **Yes** | Review queue becomes per-channel (creator reviews their own) vs platform-wide (you review) |
| `saved_items` | Saved clips, answers, briefs | id, visitor_id, first_name, kind CHECK, item_ref jsonb, folder text, note ≤500, visitor_ref | **Yes** + `workspace_id`, `user_id` | **Yes** | **Folders are a text column on each item** (no folders table), so team-shared folders would need a `folders` table. `item_ref` embeds `videoId` and denormalised titles/guest names. Scoped in code by `first_name` + `visitor_id` (`app/actions/saved.ts:77-207`). Old rows stay private to the typed name. |
| `visitors` (`visitors_events.sql:27`) | One row per typed first name | id, name_key unique, name, first_seen, last_seen, login_count, device_types, is_test, note, tour_seen_at | **Replace** with `profiles` (auth user) | **Yes** | `name_key` unique means two creators called "Rahul" are the **same visitor**. Cannot survive multi-tenant. |
| `events` | login / page_view / find_line / search / play_all log | id, visitor_ref, device_id, event_type CHECK, detail jsonb ≤1000 B, created_at | Yes | Yes | CHECK list changed twice (`events_play_all.sql`, `events_search.sql`) |
| `answer_feedback` (`answer_feedback.sql:20`) | Thumbs up/down on an answer | qa_log_id, rating, note, first_name, name_key (generated), visitor_ref; unique(qa_log_id, name_key) | Yes (via qa_log) | Yes | **NOT RUN YET** per its header |
| `rate_limits` (`rate_limits.sql:6`) | DB-backed fixed-window counters | key, window_start, count | Optional: key prefix by workspace | No | Keys are `login:<ip>`, per-user etc. (`site/lib/rate-limit.ts`) |
| `site_stats` (`site_stats.sql:5`) | Single-row home counts | `id smallint PK check(id=1)`, stats jsonb, counted_at | **Yes: PK is the constant 1** → `channel_id` PK | No | Hard single-row design |
| `thumbnail_features` | Face/text/colour features per thumbnail | episode_id PK→episodes, features jsonb, model_version | via episode | No | Insights page "Thumbnails" section |
| `chunk_terms` (`search_v2.sql:26`) | Word → number of chunks containing it (from `ts_stat`) | word PK, chunk_count | **Yes: PK is `word`** → `(channel_id, word)` | No | Filled once from the **whole** `chunks` table, only "when empty" (`search_v2.sql:44-52`). Used for the "rare word under 5% of chunks" rule in both search RPCs. Must be per channel or rare-word logic breaks. |
| `search_suggestions` (`search_v2.sql:67`) | Autocomplete entries (guest/topic/episode/clip/term) | kind, ref, text, folded, aliases…, weight; unique(kind, ref) | **Yes**: unique becomes `(channel_id, kind, ref)` | No | Loaded into an in-memory index per server (`lib/search/entities.ts`) |
| `visitor_activity` (view, `visitors_events.sql:216`, redefined in `tour_seen.sql:37`) | Admin summary per visitor | joins qa_log/saved_items/reports/events | Rebuild on `profiles` | Yes | `security_invoker = true` |
| `answer_feedback_view` | Admin view of votes | – | Yes | Yes | NOT RUN YET |
| Storage bucket `guest-photos` | Guest photos (400 px webp) | path by guest_key (`13_guest_photos.py:60,322`, `16_manual_photos.py`) | prefix with channel or use the shared `people` design | No | Public bucket |

**Columns on `guests`/`insights`/`clips` that must stay together**: `run_id` is the real publication mechanism. For multi-tenant, replace "run_id equals a constant" with `channel.published_run_id`, or add `is_current` per row.

**Integer overflow watch**: `insights.source_segment_ids integer[]` and `qa_log.cited_chunk_ids integer[]` vs `bigint` primary keys. Fine at 1M rows, becomes a bug past 2.1B; irrelevant for Phase 1 but cheap to fix during the migration.

---

## 3. SQL functions, RPCs and indexes

| Function (file) | Args | Reads / writes | Called from | Change for `channel_id` |
|---|---|---|---|---|
| `hybrid_search` (`sql/search_v3.sql:17`, the live one; v2 replaced) | `query_embedding vector(512), query_text text, match_count int=20` | `chunks`, `chunk_terms`, `pg_class` | `site/lib/ask/retrieve.ts:108`, `site/lib/search/search.ts:67`, `pipeline/11_search_test.py:70` | Add `p_channel_id`; filter `c.channel_id = p_channel_id` in both `semantic_hits` and `keyword` CTEs; read `chunk_terms` for that channel; `total` must count that channel's chunks (it uses `pg_class.reltuples` of the **whole table**, so the "5% of chunks" threshold would be wrong). |
| `hybrid_search_scoped` (`sql/hybrid_search_scoped.sql:21`; **header says NOT RUN YET**) | `query_embedding, query_text, match_count=20, video_ids text[], per_episode=2, exact_scan boolean=true` | `chunks`, `chunk_terms` | `retrieve.ts:104`, `search.ts:63` | Already filters by `video_ids`, so it is *implicitly* tenant-safe if the caller only passes that channel's ids. For the **index path** (`exact_scan=false`) it takes the 200 nearest chunks of the **entire archive** and then filters (`:48-55`), so with many channels, a small channel's results get crowded out by other tenants' chunks. Needs `p_channel_id` in the ANN query (see indexes). Also `set_config('hnsw.ef_search','200')` at `:44`. |
| `find_line` (`sql/find_line.sql:39`) | `query_text text, match_count int=5` | `segments` (trigram) | `site/lib/ask/findline.ts:16`, `app/api/find-line/route.ts` | Add `p_channel_id`, filter `segments`; trigram GIN indexes are global and would scan all channels' lines (about 1M now). Needs a per-channel plan or partitioning if channels get large. |
| `near_words` (`sql/search_v2.sql:100`) | `p_word text, p_limit=5, p_min_similarity=0.4` | `chunk_terms` (trigram) | `site/lib/search/correct.ts:49` | Add `p_channel_id` once `chunk_terms` is per channel. |
| `set_answer_feedback` (`sql/answer_feedback.sql:51`; NOT RUN YET) | rating etc. | `answer_feedback`, `qa_log` | `site/app/actions/feedback.ts:22` | Take `user_id` instead of first name. |
| `take_rate_limit` (`sql/rate_limits.sql:21`) | `p_key text, p_max int, p_window_s int` | `rate_limits` | `site/lib/rate-limit.ts:13` | None structurally; prefix keys with workspace/user. Today's keys: IP and first name. |
| `record_login`, `log_event`, `visitor_for`, `is_test_name`, `set_visitor_ref` (trigger fn) (`sql/visitors_events.sql:75-160`) | first-name based | `visitors`, `events`, triggers on `qa_log`, `saved_items`, `reports` | `site/lib/activity.ts:35,42` | **Replace entirely** by Supabase Auth `auth.users` + `profiles`. Drop the three triggers. |
| `mark_tour_seen` (`sql/tour_seen.sql:18`) | `p_name` | `visitors` | `site/app/actions/tour.ts:17` | Move to `profiles.tour_seen_at`. |
| `set_clip_guest_share` (`sql/clip_speakers.sql:16`) | `ids bigint[], shares double precision[]` | `clips` | `pipeline/15_clip_speakers.py:45` | None; ids are global. |
| Direct REST (not RPC): `site/lib/guest-exists.ts:19` | `GET /rest/v1/guests?select=guest_key&run_id=eq.…` | `guests` | `proxy.ts:31` on **every** guest URL (cached 5 min) | Add channel filter; route lookup by (channel slug, guest slug). |

All functions are `revoke … from public, anon, authenticated; grant … to service_role` and use `set search_path = public, extensions`. A `SET` clause on a function was refused by Supabase ("permission denied to set parameter"), which is why `set_config(..., true)` is used (`hybrid_search_scoped.sql:44`, `find_line.sql`).

**Indexes that need attention**

| Index | Where | Problem for multi-tenant | Fix |
|---|---|---|---|
| `chunks_embedding_idx` HNSW `vector_cosine_ops` (`schema.sql:~68`) | one global index | ANN returns nearest across all tenants, then post-filter drops results; recall collapses for small tenants | Start: `WHERE channel_id = …` with exact scan per channel while channels are small (under about 3,000 chunks, `ASK.scopeExactMaxChunks`, is fast per `config.ts:34-41`). Later: partial HNSW per large channel, or table partitioned by `channel_id` (list partitions), or pgvector ≥0.8 iterative scan (`hnsw.iterative_scan`). Check version (SQL below). |
| `chunks_text_search_idx` GIN on tsvector (`schema.sql:67`) | global | Filters by `channel_id` after the GIN hit; usually OK but add `btree_gin` composite or partition | `create index … using gin (channel_id, text_search)` needs `btree_gin` |
| `chunks_video_idx (video_id, start_s)` | fine | add `(channel_id, video_id)` | |
| `segments_text_roman_trgm_idx`, `segments_text_original_trgm_idx` (`find_line.sql:17-21`) | global GIN trigram, build took minutes on 1M rows | trigram search scans every channel's lines | per-channel partial indexes or partition `segments` by channel; build with `CONCURRENTLY` outside the SQL editor |
| `chunk_terms` PK `word`, `chunk_terms_word_trgm_idx` (`search_v2.sql:61`) | global | PK must become `(channel_id, word)` | rebuild per channel via ts_stat on that channel's chunks (script needed; today it is a one-time `DO` block) |
| `search_suggestions` indexes (`search_v2.sql:85-88`) and unique `(kind, ref)` | global | collide across channels | prefix with `channel_id` |
| `guests_guest_key_idx`, `guests_video_idx` | | guest_key global | `(channel_id, guest_key)` or the `people` design |
| `qa_log_*`, `saved_items_visitor_*`, `reports_*` | by visitor/time | | add `workspace_id` / `user_id` composites |

---

## 4. Auth and login

### 4.1 How it works today

| Step | Where |
|---|---|
| Login form: fields `fname` and `pw` | `site/app/login/LoginForm.tsx`, `site/app/login/page.tsx` |
| Server action checks the shared password: `process.env.SITE_PASSWORD`, SHA-256 + `timingSafeEqual`; IP rate limit via DB (`takeTry`, `LOGIN_LIMIT`) | `site/app/login/actions.ts:15-45` |
| First name is cleaned (first word, letters only, max 40) and **is the identity** | `login/actions.ts:20-24` |
| Cookie `cp_session` = `base64url({n: firstName, exp}) + "." + HMAC-SHA256`, signed with `SESSION_SECRET` (≥32 chars), httpOnly, secure, lax, 30 days | `site/lib/session.ts:6-47`; set at `login/actions.ts:49` |
| Second cookie `visitor_id` (random UUID per browser) | `login/actions.ts:50-51`, `session.ts:7` |
| Login recorded via RPC `record_login` (visitor upsert + event) | `login/actions.ts:54`, `site/lib/activity.ts:35` |
| Logout deletes the cookie | `login/actions.ts:59-62`, `components/app/LogoutButton.tsx` |
| **Middleware**: `site/proxy.ts` (Next 16 proxy). Public paths `/` and `/login`; everything else needs a valid `cp_session`; `/api/*` without it gets `401 JSON`; also does guest-URL canonicalisation and 404 for unknown guests (calls `guestExists`, a DB read) | `proxy.ts:5,26-39` |
| Server pages/actions call `requireSession()` (re-checks cookie, redirects to `/login`) | `site/lib/auth.ts:9-13`; 27 files use it |
| Env vars | `SITE_PASSWORD`, `SESSION_SECRET` (also used to HMAC IPs for rate limits `session.ts:24` and the tour cookie `session.ts:27`), plus `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` |

**How "who is the user" reaches data**: `requireSession()` returns `{firstName}`. It is written as `first_name` (plain text) into `saved_items` (`actions/saved.ts:65`), `qa_log` (`lib/ask/answer.ts:273`, `app/api/prep/web/route.ts`), `reports` (`actions/report.ts:19`), `answer_feedback` (`actions/feedback.ts:22`), `events`, and it keys `visitors.name_key`. Reads filter by `first_name` **and** `visitor_id` (browser) in `saved.ts:77-207`; the Saved page is therefore "this name on this browser". Per-user rate limits use the first name (`takeUser(...)`, `lib/rate-limit.ts`).

Weaknesses that matter for a paid product: anyone with the password can type any name and read that name's saved items (if on the same browser); the password is shared by all FO staff; no email, no recovery, no revocation per person.

### 4.2 Files that change for Supabase Auth + workspaces + invites

**Replace or delete (core)**: `site/lib/session.ts`, `site/lib/auth.ts`, `site/proxy.ts`, `site/app/login/{page.tsx,LoginForm.tsx,actions.ts,login.css}`, `site/components/app/LogoutButton.tsx`, `site/lib/activity.ts`, `site/lib/db.ts` (add a per-request client with the user's JWT, keep service client for admin/pipeline), `site/lib/rate-limit.ts` (keys).

**Server actions / API routes that read the session (change identity from `firstName` to `user.id` + `workspace_id`)**: `site/app/actions/{briefs,clips,feedback,play,report,saved,tour}.ts`, `site/app/api/{ask,event,find-line,prep,search}/route.ts`, `site/app/api/prep/web/route.ts`, `site/app/api/search/suggest/route.ts`.

**Pages/layouts that call `requireSession` or show the name**: `site/app/(app)/layout.tsx`, `site/app/(app)/{clips,insights,search}/page.tsx`, `site/app/(app)/clips/reels/page.tsx`, plus `site/lib/saved-types.ts`, `site/components/saved/SavedView.tsx`, `site/components/tour/TourGate.tsx`, `site/lib/tour.ts`, `site/lib/ask/answer.ts` (logging), `site/lib/prep/build.ts`.

**New**: signup/login (email + Google), invite acceptance, workspace switcher, `profiles`, `workspaces`, `workspace_members(role)`, `channels(workspace_id)`, and an auth callback route. Roles needed at minimum: owner, editor, viewer.

**DB**: replace `visitors`/`events` triggers; migrate `saved_items`/`qa_log`/`reports`/`answer_feedback` from `first_name` to `user_id`; add RLS policies (see Phase 1 notes).

**Cutover**: FO's existing data is keyed by first names (about 30–50 people?). The simplest migration keeps old rows with `user_id null` and `legacy_first_name`, readable only by the platform admin.

---

## 5. Pipeline scripts

All Python in `pipeline/` (venv `.venv`, deps `requirements.txt`). Local state lives in `data/` (git-ignored), not in the DB, for most steps. **Order below is the order they were run.** Everything is run by hand from PowerShell; nothing is scheduled and there is **no orchestrator**: no single command to ingest a channel.

| # | Script | What it does | Reads → writes | External APIs / models | Class |
|---|---|---|---|---|---|
| 1 | `01_fetch_episodes.py` (296 lines) | Lists a channel's uploads, keeps ≥20 min non-Shorts/non-live, stops at 500 | YouTube Data API v3 (`playlistItems` 1 unit/page, `videos.list` 1 unit/call) → `data/episodes.csv`, cache `data/cache/youtube/` | YouTube Data API (`YOUTUBE_API_KEY`) | **NEEDS PARAMETERIZING**: `CHANNEL_HANDLE="@rajshamani"` (`:37`), limit 500 |
| 2 | `02_pick_candidates.py` | Adds year/language guess, shortlist of 40 test episodes | episodes.csv → `data/candidates.csv`, `shortlist.csv` | none | NEEDS PARAMETERIZING (title-based language guess; test-set concept was for the pilot) |
| 3 | `load_episodes.py` | Upserts candidates into `episodes` (status `listed`) | candidates.csv → `episodes` | Supabase | NEEDS PARAMETERIZING (hard-coded to "500", needs `channel_id`) |
| 4 | `03_download_audio.py` | yt-dlp audio → mono 16 kHz MP3, 10-min pieces | → `audio/<video_id>/` | yt-dlp, ffmpeg | REUSABLE (only needed for the Groq/Sarvam fallback) |
| 5 | `04_bakeoff.py`, `06_romanize.py`, `07_translate.py` | Pilot comparisons of transcribers and romanization | → `data/bakeoff*` | Groq `whisper-large-v3(-turbo)`, Sarvam `saaras:v4` (Batch), Haiku | **FO-ONLY / pilot** (keep as research; `romanize_lib.py` is reused) |
| 6 | `05_captions.py` (1,686 lines) | Core transcript step. Lists YouTube caption tracks (yt-dlp), downloads auto captions (json3), detects wrong-language tracks (`foreign` marker, words per minute), **romanizes Hindi with Haiku (Batch)**, **translates Hindi lines to English with Haiku (Batch)**, falls back to audio transcription (Groq `whisper-large-v3` for English, Sarvam `saaras:v4` translit for Hindi), writes `segments` / `translation_segments`, sets episode status | yt-dlp, Supabase → `segments`, `translation_segments`, `episodes` | YouTube (yt-dlp, scraping-style, 429s with 180 s back-off and 20–40 s pauses between episodes `:411-415`), Haiku `claude-haiku-5-5` (Batch), Groq, Sarvam | **NEEDS PARAMETERIZING**: `FALLBACK={"en":"groq","hi":"sarvam"}` (`:426`), language set limited to en/hi, `GROUP_SIZE=25`, `MAX_RUN_INR=2500`, `INR_PER_USD=88`; writes `source` CHECK values. **Biggest wall-clock step; YouTube throttling is the scaling risk.** |
| 7 | `06_extract.py` (1,415 lines) | (a) Speaker labels r/g/u per line (Haiku, low effort, groups of 10 lines, chunks of 150); (b) extraction of guest profile, takeaways (≤7), quotes (5–10), opportunities (13 categories), disagreements, host questions, host opinions, clips (4–8, 30–90 s) in one schema, split into "parts" when over 90k tokens; writes `guests`, `insights`, `clips`, `segments.speaker` | Supabase → same, plus `data/extractions/…` | Haiku `claude-haiku-5-5` via Message Batches (`MODELS` `:116`), `MAX_RUN_USD=25` guard (`:133`) | **FO-ONLY prompts** (Raj named throughout) → needs parameterizing + a new Gate 1. `VERSION="v5"` is **locked** (`:109-113`) |
| 8 | `07_check.py` (442 lines) | Rule-based verification of every row against the transcript (segment ids exist, timing matches, fuzzy quote match with `rapidfuzz`, speaker rules, numbers present in cited lines); sets `verified`, `check_notes` | `insights`, `clips`, `guests`, `segments` → same | none (no model) | NEEDS PARAMETERIZING (`raj` speaker rules `:273-278`); **this is the moat and is cheap, so reuse it** |
| 9 | `08_ai_precheck.py` (354) | Sonnet checks a *sample* of items against cited lines | Gate 1 sample → `data/review/ai_precheck/` | `claude-sonnet-5-5` (Batch) | NEEDS PARAMETERIZING; QA tool for a pilot, per-channel sampling only |
| 10 | `gate1_lib.py`, `gate2_lib.py`, `09_gate1_report.py`, `review_app.py`, `08_transcript_view.py` | Human review UI and reports; writes `reviews` | | none | FO-ONLY tooling (manual); decide whether new channels get a human gate or an automatic sample + report |
| 11 | `09_build_chunks.py` (568) | Builds ~90 s chunks (15 s overlap), embeds with Voyage `voyage-4` 512-d, writes `chunks` | `segments`, `guests` → `chunks` | Voyage (via MongoDB Atlas endpoint `https://ai.mongodb.com/v1`), `USD_PER_MTOK=0.06` | NEEDS PARAMETERIZING (`Raj:` label, run id file, channel_id). Tokenizer fetched from Hugging Face |
| 12 | `10_roman_fix.py` | Re-romanizes Hindi lines with stray non-Latin characters | `segments` | Haiku (Batch), `--max-usd` guard | REUSABLE (Hindi only) |
| 13 | `11_search_test.py` | Smoke test with fixed Raj/Hinglish questions | → `data/search_test.md` | Voyage query embedding, RPC `hybrid_search` | NEEDS PARAMETERIZING (questions) |
| 14 | `12_guest_links.py` (798) | `diagnose / recover / merge` guest_keys, Wikipedia suggestions, YouTube channel links, LinkedIn *search* URL (never scraped), export/import sheet for hand checking | `guests` | Wikipedia API (user agent names FO `:103`), YouTube API | NEEDS PARAMETERIZING (`AUTO_YT_KEEP` `:119`, user agent); cross-channel dedupe must move to a shared `people` table |
| 15 | `13_guest_photos.py` | Wikimedia Commons photos, licence-filtered, crop to 400 px webp, upload to bucket `guest-photos` | `guests` → Storage | Wikipedia/Commons APIs | NEEDS PARAMETERIZING (`BRANDING` regex `:69`) |
| 16 | `16_manual_photos.py` | Photos from `data/Guest Images` | → Storage, `guests` | none | FO-ONLY (manual, per-owner) |
| 17 | `14_apply_corrections.py` + `corrections.json` + `corrections_lib.py` | Applies hand corrections to guests/insights/clips; also re-applied by `06_extract.py` and `site_stats.py` | → `guests`, `insights`, `clips` | none | **FO-ONLY data**; mechanism REUSABLE |
| 18 | `15_clip_speakers.py` | `clips.guest_share` from speaker labels | `segments` → RPC `set_clip_guest_share` | none | REUSABLE once the host label is generic |
| 19 | `17_thumbnail_features.py` (431) | For each episode: download thumbnail, YuNet face detection, k-means colours, brightness/contrast, Haiku **vision** for thumbnail text; keeps only numbers | YouTube thumbnail → `thumbnail_features` (via `data/thumbnails/features.json`) | `claude-haiku-5-5` (Batch, vision), OpenCV | NEEDS PARAMETERIZING (`LOGO` regex `:241`); optional feature |
| 20 | `21_build_search_suggestions.py` (532) | Fills `search_suggestions`; optional `--aliases` one-off Haiku batch for Devanagari/Hinglish spellings | all main tables → `search_suggestions` | `claude-haiku-5-5` (Batch) | NEEDS PARAMETERIZING (FO-number aliases `:271`, curated `term` list) |
| 21 | `site_stats.py` (131) | Counts home numbers and writes `site_stats` row | → `site_stats` | none | NEEDS PARAMETERIZING (single row; `:15,81` host-question count) |
| – | `check_db.py`, `db_lib.py`, `romanize_lib.py`, `corrections_lib.py` | Helpers (retry/backoff, client re-creation) | | | REUSABLE |

**Missing steps (done by hand, not scripted)**: filling `chunk_terms` (a `DO` block in `search_v2.sql:44`); running every `sql/*.sql`; `ANALYZE chunks`; promoting a run id (editing `archive-run.ts`); choosing the test set; Gate 1/2 sign-off; the `search_suggestions` rebuild after data changes; `site_stats.py` after any change.

**Resumability** (CLAUDE.md rule 6) is good: nearly all steps skip finished work, log progress and retry network errors via `db_lib`. The missing piece is a per-channel **job state machine** (what is done for channel X) in the DB instead of CSVs/JSON under `data/`.

---

## 6. Cost drivers (counts only, no prices)

Measured numbers come from comments in the code about the 25-episode test set and the 499-episode run. FO averages: **499 episodes, about 70 chunks each (35,234 / 499), about 2,100 transcript lines each (1,047,059 / 499), 66% Hindi lines (732,026 / 1,047,059)**. All bulk LLM calls use the Message Batches API with `claude-haiku-5-5` unless stated.

### 6.1 Pipeline (per episode, one-time)

| Stage | API / model | Calls per episode | Input per call | Output | Source |
|---|---|---|---|---|---|
| Episode list | YouTube Data API | 1 unit per 50 videos + 1 unit per 50 `videos.list`; cached | – | – | `01_fetch_episodes.py:6-9` |
| Captions | yt-dlp (no key, no direct cost) | 1 list + 1–3 downloads per episode; 20–40 s pause per episode | – | – | `05_captions.py:411-415` |
| Romanize (Hindi episodes only) | Haiku, Batch | `lines / 60` requests (ROMAN_CHUNK_LINES=60), up to 3 rounds per failed chunk, then sub-chunks of 10 | 60 lines + prompt | 60 lines Roman | `05_captions.py:423-426` |
| Translate to English (Hindi only) | Haiku, Batch | at most 40 lines per request (`07_translate.py` doc), retries and one-by-one for length-flagged lines | 40 lines | 40 lines | `07_translate.py:7-14` |
| Fallback transcription (only when YouTube captions are missing or fail the 80% coverage rule `MIN_COVERAGE`, `:402`) | **Groq `whisper-large-v3`** (English) or **Sarvam `saaras:v4` translit** (Hindi, batch jobs ≤20 pieces) | 1 request per 10-min audio piece (≈ minutes / 10) | audio | text + timestamps | `05_captions.py:426-433`, `03_download_audio.py` |
| Speaker labels | Haiku, effort low, Batch | **≈ lines/150 chunk requests** (430 chunk answers for 25 episodes ≈ **17 per episode**), each with 12 context lines; failed 10-line groups re-asked up to 3 times | ~150 lines + context | ≈ **2,500 output tokens per chunk** (≈ 38k per episode: 947,305 / 25) | `06_extract.py:135-143,150-153` |
| Extraction | Haiku, effort medium, Batch | **1 request per "part"**; an episode is split when over 90,000 input tokens: **42 part answers for 25 episodes ≈ 1.7 per episode**; hard errors re-sent up to 2×, up to 3 attempts | whole transcript (Roman, with speaker tags + English lines for Hindi), up to 90k tokens | ≈ **16,000 output tokens per part** (662,077 / 25 ≈ 26k per episode); `max_tokens 64000` | `06_extract.py:118-126,160-163` |
| Verification (`07_check`) | none | 0 | | | |
| Embeddings | Voyage `voyage-4`, 512-d, document | **≈ 70 chunks per episode**, 128 texts or 100,000 tokens per request | chunk ≈ 90 s of speech + header | vector | `09_build_chunks.py:75-88` |
| Thumbnail features (optional) | Haiku vision, Batch | **1 image per episode** | 1 thumbnail | JSON | `17_thumbnail_features.py:57` |
| Search suggestions (optional, one-off) | Haiku, Batch | 1 batch for all guests/topics/terms (not per episode) | names | aliases | `21_build_search_suggestions.py:61` |
| Guest links/photos | Wikipedia / Commons / YouTube APIs | per unique guest, not per episode | | | `12_guest_links.py`, `13_guest_photos.py` |
| Gate 1 AI pre-check (QA only) | `claude-sonnet-5-5`, Batch | 1 per sampled item | item + cited lines | verdict | `08_ai_precheck.py:46` |

Cost-guard constants in code: `MAX_RUN_USD = 25.0` (extraction), `MAX_RUN_INR = 2500` (captions), `BATCH_PRICES` haiku (0.05, 0.25) and sonnet (1.00, 5.00) USD per million tokens (input, output) at `06_extract.py:119-120`, `USD_PER_MTOK=0.06` for Voyage. Those are the code's own price assumptions, not verified here.

**Per archive hour**: to turn the table into a cost, scale by *transcript lines per hour* and *tokens per line*. Convert with FO's averages above: average episode length is not in the repo (`episodes.duration_seconds` has it, see SQL). The number that drives cost most is **output tokens: about 64k per episode (38k speakers + 26k extraction)**, plus Hindi romanize/translate output (roughly the size of the transcript twice). English-only content skips romanize and translate entirely and is far cheaper.

### 6.2 Query time (per user action, ongoing)

| Action | Calls | Models | Source |
|---|---|---|---|
| **Ask** | 1 query-rewrite (Haiku, makes English/Hinglish/Hindi phrasings + language + host_view) → **3 Voyage query embeddings** (one per phrasing, one request) → 3 × `hybrid_search(_scoped)` RPC (20 each) → 1 answer (Haiku, `answerEffort: low`, prompt cache, 10 chunks; 5 for Short, 12 for Detailed) → possibly 1 retry at medium effort → 1 follow-up suggestion call (Haiku) | `claude-haiku-5-5`, `voyage-4` | `lib/ask/retrieve.ts:47,117`, `answer.ts:87,233`, `config.ts:7-31` |
| Search page / quick search | 1 Voyage embedding for the full phase; quick phase uses no model | `voyage-4` | `lib/search/search.ts` |
| **Prep brief** | Embeddings + several RPCs, at least 1 Haiku call, up to 4 more (profile, suggestions, per-section) | Haiku | `lib/prep/build.ts:644,746,782` |
| **Prep "From the web"** | up to 4 Tavily searches + 1 Groq `openai/gpt-oss-120b` call | Tavily, Groq | `lib/prep/web.ts:13,18,30` |
| Find a line | 0 models (trigram SQL) | – | `findline.ts` |
| Login / page views | 0 | – | |

Rate limits that cap cost today: Ask 30 per visitor per 10 min (`config.ts:ASK.rateLimit`), web research cap for everyone in 24 h (`prep/web.ts:30`). These are global or per name, not per workspace/plan.

**Fixed infra**: Supabase (DB with pgvector; 1M segment rows plus 35k vectors today), Vercel (region `bom1`), Voyage free tier note at `09_build_chunks.py:85` ("200M free tokens"), a Tavily plan and a Groq key.

---

## 7. Other single-tenant assumptions

| Area | Finding (file:line) | Fix |
|---|---|---|
| **Run filter constant** | `ARCHIVE_RUN_ID` imported by `lib/archive.ts:24`, `lib/clips.ts`, `lib/guests.ts:68,96,100,166,171,173,253,267,283`, `lib/home-explorer.ts:118`, `lib/guest-exists.ts:19`, `lib/ask/findline.ts:26`, `lib/ask/retrieve.ts:240`, `lib/prep/build.ts:205,415`; the proxy also queries it. Changing the run today needs a code deploy. | `channels.published_run_id` loaded per request (cached) |
| **Env vars** | `SITE_PASSWORD`, `SESSION_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_DB_PASSWORD` (unused), `NEXT_PUBLIC_SITE_URL`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `GROQ_API_KEY`, `TAVILY_API_KEY`, `SARVAM_API_KEY`, `YOUTUBE_API_KEY`, `PREP_DEBUG` (`.env.example`). One key per vendor, shared by everyone. | Add Supabase anon key + JWT secret for Auth; usage metering per workspace (tokens by `workspace_id`); optionally bring-your-own YouTube OAuth |
| **YouTube access** | Only a public API key + yt-dlp (no OAuth). Works for public channel data. "Connect your YouTube channel" implies OAuth (`youtube.readonly` or Analytics) which this codebase has none of; real view-count analytics need it. | New: Google OAuth + token storage (encrypted) |
| **Storage** | Single public bucket `guest-photos` (`13_guest_photos.py:60`). No other buckets. `data/` and `audio/` are on Arjun's PC, not in cloud storage. | Pipeline needs a server/worker (not this PC) and object storage |
| **Caching keys** | Next `"use cache: remote"` with `cacheLife` (stale 300 s, revalidate 3600 s, expire 86400 s) on `getDirectory` etc. (`lib/guests.ts:88-89,154,244,260,274`, `lib/ask/scope.ts:14`, `lib/home-explorer.ts:86`) and `"use cache"` in memory for clips index (`lib/clips.ts:26`, 1.7 MB, near Vercel's 2 MB item limit per its comment `:22`) and `site-stats.ts`. **None take a channel argument**, so a second channel would share cache entries. In-memory per-process caches: `lib/guest-exists.ts:9`, `lib/search/correct.ts:20` (`globalThis.__searchWords`), `lib/search/limit.ts:14` (`globalThis.__searchLimit` rate limiter), `lib/search/entities.ts` (suggestion index). | Make `channelId` a parameter of every cached function (it becomes part of the cache key automatically); move in-memory limiter to the DB (it is the only limiter still in memory) |
| **Hardcoded counts** | Hero "500 episodes." (`components/home/Hero.tsx:139`); "From 500 episodes" (`app/page.tsx:66`); `SNAPSHOT` (`lib/site-stats.ts:36-52`); `GATE2` constants (`app/page.tsx:15`); `lib/search/search.ts:86` comment on "2,700 clips and 500 episodes"; `ASK.scopeExactMaxChunks: 3000` (`config.ts:41`) and measured timings ("2,400 chunks", "3,500 for 2023") derive from FO's size. 425 or 428 guests: only the `SNAPSHOT` (`guests: 428`). | Remove; derive from DB (rule 9 already requires it) |
| **Scope panel / filters** | `lib/ask/scope.ts:11` builds guests/topics/years/language index of the whole archive and caches it; scope filter chooses exact scan vs index by estimated chunk count (`config.ts:41`) | per channel; planner thresholds depend on channel size |
| **Insights** | `lib/insights.ts` compares an episode's views to its year median (`:365-371`) and "typical" groups by length/year; home page says "compared with typical episodes of the same age" (`app/page.tsx:130`); minimum sample sizes `MIN_TOTAL=10`, `MIN_POINT=10`, `SMALL_BELOW=20` (`lib/home-explorer.ts:16-20`). All compare **within one channel's episodes**, which is correct for multi-tenant, but: needs a channel with enough episodes (the thresholds make Insights empty for new/small channels) and views are a stale snapshot from the fetch day (`episodes.view_count`, no refresh job). The "spec's fair score / filters / drill-down not built" per memory notes. | Per-channel minimums; scheduled re-fetch of view counts |
| **Prep brief** | Sections, headings and notes are hard-coded in `lib/prep/export.ts:42-70` ("What the host asked them", "Already asked to them"); the "has already been on the show" logic needs the show's own back-catalogue; `.docx` is written by a hand-rolled zip writer (`lib/prep/docx.ts:4`), plain text export in `export.ts`. No PDF. No template files in the repo (templates are code). | Section config per workspace; wording from `show_name` |
| **Analytics** | No third-party analytics. First-party only: `events` table (`page_view`, `find_line`, `search`, `play_all`, `login`) via `app/api/event/route.ts`, `components/app/PageViewBeacon.tsx`, and `qa_log`. Admin views in Supabase's Table Editor only; **there is no admin UI**. | Platform admin dashboard; per-workspace usage page |
| **Vercel config** | `vercel.json`: region `bom1` only. `next.config.ts`: `cacheComponents: true`, `partialPrefetching: true`, global noindex/frames-deny headers (`:~21-34`); loads `../.env` locally via `process.loadEnvFile`. No cron jobs, no middleware matcher other than `proxy.ts`. Env split: AI keys "Prod only" so previews cannot spend credit (`.env.example:5`). | Routing by channel (`/c/[slug]/…` or subdomains with wildcard domain); cron for ingestion/refresh |
| **URLs** | `/guests/[slug]` is global; `slug = guestSlug(guest_key)` (`lib/guest-slug.ts`), with the redirect logic in `proxy.ts:8-24` and `currentGuestSlug` consulting `corrections.json`. All routes are top-level (`/ask`, `/guests`, `/clips`…). | Prefix with channel slug; `currentGuestSlug` must be per channel |
| **Static data committed** | `pipeline/corrections.json` (FO guest corrections; imported by `corrections_lib.py` and by the site's `guest-slug.ts`), `site/public/tour/*.webp` + `pins.json` (FO screenshots) | move to DB / generate per channel |
| **Thumbnails (rule 1)** | Thumbnail used only as a player poster; `thumbnail_features` stores numbers only. | keep the rule; platform-level wording |
| **Legal/brand posture** | The whole product is framed as an unofficial tool for FO ("private, unofficial… demo for the Figuring Out team", `CLAUDE.md:5`). Rules 1–3 (no first-person impersonation, no logos, contact data limits) are good platform rules. A creator signing up changes the position from "unofficial" to "authorised"; do not display FO or other creators' data to other users. | Terms + verified channel ownership (OAuth proves control of the channel) before processing and before showing the data to anyone but the owner |
| **Tests** | `site/scripts/*.mjs` (search, saved, prep, prep-web) hit the live DB and assert FO facts (e.g. `search-test.mjs:16-17,151` queries "raj shamani", "aghori"; `prep-test.mjs` compares with `raj_question`). | parametrize or fixture-ize |
| **Secrets hygiene** | Service-role key is used for all reads including user-facing pages (`lib/db.ts`). | After Supabase Auth: user-scoped client + RLS for per-user tables; service role only in pipeline/admin |

---

## SUMMARY

Counts are files in the repo that would need an edit (approximate; some overlap between areas).

| Area | # files touched | Size | Risk | Notes |
|---|---|---|---|---|
| 1. FO/Raj hardcoding | about 55 (about 28 site, about 22 pipeline, 5 SQL/data) | **L** | Med | Mostly mechanical. The risk is the **extraction/verifier prompts** (`06_extract.py`, `08_ai_precheck.py`) and the `raj` enum in the DB: touching them forces a new Gate 1 for FO. Strategy: add `host` as an alias, keep FO's old rows readable. |
| 2. Tables | 16 tables + 2 views; about 25 site files with queries | **L** | **High** | `channel_id` on ~12 tables, PK changes on `site_stats`, `chunk_terms`, `search_suggestions`. `guests` needs a design decision (shared `people` vs per-channel). RLS has no policies today. |
| 3. Functions / indexes | 5 search-related functions, 6 identity functions, about 8 call sites, 6 index groups | **M–L** | **High** | Search correctness (rare-word 5% rule, HNSW post-filter recall) is the subtle part. Must keep FO search quality identical (regression test needed). |
| 4. Auth | about 45 files (core 10, actions/API 12, pages 8, components/types 6, new files about 10) | **L** | **High** | Replaces identity in every user-data table. Migration of existing first-name data. Needs RLS design. Needs invite flow. |
| 5. Pipeline | 21 scripts + 4 libs | **L** | Med | No orchestrator. Needs a worker (not Arjun's PC), per-channel job state in DB, and fixed channel parameters. YouTube throttling (yt-dlp 429s) is the throughput limit. |
| 6. Cost drivers | 0 changes (analysis) + metering in about 6 files | S (analysis) / M (metering) | Med | Cost is dominated by output tokens in speaker labelling + extraction (about 64k per episode) and Hindi romanize/translate. English-only content is far cheaper, so price per hour should depend on language. |
| 7. Other | about 25 files | **M** | Med | Cache keys with no channel arg, constants (`ARCHIVE_RUN_ID`, counts), in-memory limiter, tests, tour screenshots, no admin UI, no OAuth. |

---

## Recommended order of work (Phase 1)

Principle: **FO keeps working at every step.** Treat FO as channel #1 and migrate it in place. Don't touch the verified transcripts, embeddings or Gate-1 results.

1. **Decide four things first (a day, no code).**
   a. `guests`: per-channel or shared `people` + per-channel appearances (recommended: shared `people`, per-channel `channel_guests`).
   b. Rename `raj`/`raj_*` to `host`/`host_*` now or add an alias layer (recommended: migrate with a `UPDATE` + new CHECK; FO's data is small enough and old strings are only in code you are changing anyway).
   c. What a "workspace" owns (one channel? many?) and role set (owner/editor/viewer).
   d. Legal wording: replace "Unofficial project, not affiliated with…" with per-state text (demo mode vs connected mode), and rule 1/3 restated at platform level.

2. **Schema migration set (the foundation).** Put all SQL in a real `supabase/migrations/` folder, starting with a *baseline dump of the live DB* (use the SQL in the last section). Then:
   `channels` (id, slug, name, youtube_channel_id, uploads_playlist_id, host_names[], show_name, locale, languages, episode_code_regex, published_run_id, settings jsonb, status); add `channel_id` (nullable, backfill with FO's id, then NOT NULL) to `episodes`, `segments`, `translation_segments`, `chunks`, `guests`, `insights`, `clips`, `thumbnail_features`, `search_suggestions`, `chunk_terms`, `site_stats`; fix PKs/uniques noted in area 2; add composite indexes.

3. **RPCs get `p_channel_id`** (`hybrid_search`, `hybrid_search_scoped`, `find_line`, `near_words`), per-channel `chunk_terms` builder, `total` per channel. Ship behind the same function names with a default so the live FO site keeps working during rollout. Run the existing `site/scripts/search-test.mjs` and `pipeline/11_search_test.py` before/after to prove FO results are unchanged.

4. **Remove FO hardcoding into `channels` settings** (area 1 tables). Do it by introducing one `getChannel()` and `ChannelConfig` type, then replace constants: `HOST_NAME`, `HOST_WORDS`, `OWN_SHOW`, title regexes, example questions, prompts (templated), `ARCHIVE_RUN_ID`, site copy. Make every cached loader take `channelId`. Delete or rewrite the Future page and tour screenshots. Remove hard-coded numbers (`Hero.tsx:139`, `page.tsx:66`, `SNAPSHOT`).

5. **Real accounts and workspaces.** Supabase Auth (email + Google), `profiles`, `workspaces`, `workspace_members`, invites; replace `session.ts`/`proxy.ts`/`login/*`; move `saved_items`/`qa_log`/`reports`/`answer_feedback` to `user_id` + `workspace_id`; add a `folders` table; write **RLS policies** for per-user and per-workspace tables and keep service role only for pipeline/admin. Migrate FO's existing first-name rows to a legacy owner. Add a per-request data client scoped by `channel_id` so a forgotten filter cannot cross tenants.

6. **One pipeline command per channel.** `python pipeline/ingest.py --channel <slug>`: wraps steps 1 → 3 → captions → extract → check → chunks → embeddings → chunk_terms → suggestions → stats, with per-channel job state in a `ingest_jobs` table (stage, counts, last error, cost so far) and the existing cost guards (`MAX_RUN_USD`, `MAX_RUN_INR`) as per-channel budgets. Parameterize `01_fetch_episodes.py`, `05_captions.py`, `06_extract.py` prompts, `07_check.py`, `09_build_chunks.py`. Run on a worker/VM with ffmpeg + yt-dlp (not the PC). Add YouTube OAuth connect (`youtube.readonly`) so channel ownership is proven before ingesting.

7. **Hardening before a second tenant.** Usage metering (tokens and calls per workspace), per-workspace rate limits (move the in-memory search limiter to DB), admin page, end-to-end tenant isolation tests (user A cannot read channel B by any route: `/api/*`, server actions, cached loaders, RPCs), and a bake-off ingest of one small English channel to measure real cost per hour.

---

## SQL for Arjun to run in Supabase

Run each in the Supabase SQL editor (read-only; none changes data). Paste results back so I can finish what the repo can't prove.

```sql
-- 1. Every table/view and row counts (is anything missing from the repo? e.g. feedback unused?)
select c.relname, c.relkind, c.reltuples::bigint as approx_rows, c.relrowsecurity as rls_on
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','v','m','p')
order by c.relname;

-- 2. All columns, types, defaults (confirms live schema vs schema.sql and the sql/*.sql patches)
select table_name, ordinal_position, column_name, data_type, udt_name, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
order by table_name, ordinal_position;

-- 3. Constraints (PKs, uniques, CHECK lists incl. speaker/type/category, FKs)
select conrelid::regclass as table_name, conname, contype, pg_get_constraintdef(oid) as definition
from pg_constraint
where connamespace = 'public'::regnamespace
order by conrelid::regclass::text, contype, conname;

-- 4. Every function with arguments (are hybrid_search_scoped and set_answer_feedback live?)
select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as security_definer, p.proconfig
from pg_proc p where p.pronamespace = 'public'::regnamespace
order by p.proname;

-- 5. Full source of the search functions (verify live == repo, esp. hybrid_search vs search_v3.sql)
select p.proname, pg_get_functiondef(p.oid)
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('hybrid_search','hybrid_search_scoped','find_line','near_words');

-- 6. Indexes (HNSW params, GIN, trigram, sizes)
select schemaname, tablename, indexname, pg_size_pretty(pg_relation_size(quote_ident(schemaname)||'.'||quote_ident(indexname))) as size, indexdef
from pg_indexes where schemaname = 'public'
order by tablename, indexname;

-- 7. RLS: is it on, and are there ANY policies?
select schemaname, tablename, policyname, roles, cmd, qual, with_check from pg_policies where schemaname = 'public';
select relname, relrowsecurity, relforcerowsecurity from pg_class
where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname;

-- 8. Grants to anon/authenticated (should be none)
select table_name, grantee, privilege_type from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon','authenticated') order by table_name, grantee;
select routine_name, grantee from information_schema.routine_privileges
where routine_schema = 'public' and grantee in ('anon','authenticated','PUBLIC');

-- 9. Triggers (set_visitor_ref on qa_log / saved_items / reports)
select event_object_table, trigger_name, action_timing, event_manipulation, action_statement
from information_schema.triggers where trigger_schema = 'public' order by 1, 2;

-- 10. Extension versions (pgvector version decides whether hnsw.iterative_scan exists)
select extname, extversion from pg_extension order by extname;
show hnsw.ef_search;

-- 11. Data shape: scale numbers that drive cost and index choices
select (select count(*) from episodes) episodes,
       (select count(*) from episodes where status='transcribed') transcribed,
       (select round(avg(duration_seconds)/60.0,1) from episodes where status='transcribed') avg_minutes,
       (select round(sum(duration_seconds)/3600.0,0) from episodes where status='transcribed') archive_hours,
       (select count(*) from chunks) chunks,
       (select count(distinct run_id) from guests) guest_runs,
       (select count(distinct run_id) from insights) insight_runs;
select caption_language, count(*) from episodes where status='transcribed' group by 1 order by 2 desc;
select source, count(*) from (select distinct video_id, source from segments) s group by 1;   -- captions vs groq vs sarvam per episode

-- 12. Which run_id is live, and rows per run (confirms ARCHIVE_RUN_ID filtering matters)
select run_id, count(*) filter (where verified) verified, count(*) total from insights group by 1 order by 3 desc;
select run_id, count(*) filter (where verified) verified, count(*) total from guests group by 1 order by 3 desc;
select run_id, count(*) filter (where verified) verified, count(*) total from clips group by 1 order by 3 desc;

-- 13. Same person across several episodes (confirms shared-row risk and size of a future `people` table)
select count(distinct guest_key) people, count(*) guest_rows,
       count(*) filter (where photo_url is not null) with_photo,
       count(*) filter (where link_source = 'manual') manual_links
from guests where verified;

-- 14. Per-user data volume to migrate off first names
select count(*) rows, count(distinct lower(first_name)) names from saved_items;
select count(*) rows, count(distinct lower(first_name)) names, count(*) filter (where kind='brief') briefs from qa_log;
select count(*) from reports;  select count(*) from answer_feedback;   -- errors if answer_feedback.sql was never run
select name, login_count, is_test from visitors order by login_count desc limit 50;

-- 15. Is `feedback` used at all? is `reviews` populated?
select (select count(*) from feedback) feedback_rows, (select count(*) from reviews) review_rows;

-- 16. chunk_terms state and the 5% rule input (it is filled once, from all chunks)
select count(*) words, max(chunk_count) max_count from chunk_terms;
select reltuples::bigint as chunks_stat from pg_class where oid = 'public.chunks'::regclass;

-- 17. Storage buckets and object counts
select id, name, public from storage.buckets;
select bucket_id, count(*) from storage.objects group by 1;

-- 18. Vector index plan check (does HNSW get used, and does a channel-filtered query lose rows?)
explain (analyze, buffers)
select id from chunks order by embedding <=> (select embedding from chunks limit 1) limit 40;

-- 19. Table and index sizes (what a partition-by-channel or per-channel index would cost)
select relname, pg_size_pretty(pg_total_relation_size(oid)) total, pg_size_pretty(pg_relation_size(oid)) heap
from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
order by pg_total_relation_size(oid) desc;

-- 20. Auth readiness: is Supabase Auth in use at all, and which providers are configured? (read the dashboard too)
select count(*) from auth.users;
```

If any query errors (for example `answer_feedback` does not exist), say so: it tells us which "NOT RUN YET" scripts were never applied.

**Things this audit could not determine from the repo**
- Whether `hybrid_search_scoped` and `answer_feedback` exist live (queries 4, 14).
- Real archive hours and average episode length (query 11) → needed to convert the call counts in area 6 into cost per hour.
- Live pgvector version (query 10) → decides the HNSW strategy.
- Whether anything outside this repo (dashboard-created tables, edge functions, cron, webhooks) exists: check the Supabase dashboard under Database → Functions/Triggers, Edge Functions, and Integrations.
- Vercel project settings (env scoping, domains, analytics, cron) are not in the repo; only `vercel.json` is.
- Total cost actually spent on the FO run: check the cost logs in `data/logs/` and `data/progress*.log` on your PC (not in git).
