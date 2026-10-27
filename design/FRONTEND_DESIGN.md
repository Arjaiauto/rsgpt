# Cuepoint — Frontend Design

Oct 27, 2026 · @Arjun Sood

## How this document works

We design RSGPT one page at a time, in a fixed drill, and only build in code once every page here is signed off. The finished document becomes the design input for Tickets 19-25.

1. **Questions:** Claude asks a short set of questions about the page (purpose, layout, content, animation, mobile).
2. **Decisions:** Arjun's answers are written into that page's section.
3. **Mockup:** a mockup is generated for that page (by Claude as an HTML/SVG mockup, or by Gemini as an image) and added to the section.
4. **Review:** Arjun approves or asks for changes; changes go into the decision log.
5. **Next page.** When all pages are approved, the full document is handed to Claude Code to build.

Page order: Login, Ask, Guest directory, Guest profile, Prep brief, Clip finder, Saved, Insights, then global components.

## Design system

The base is the holographic-cloth design Arjun chose, switched to a dark studio wall; every value below is a starting point that the page drill can change.

| Token | Value | Used for |
| --- | --- | --- |
| Background | #101117 | Page background (never pure black) |
| Light centre / edge | #1a1b24 / #08090c | Radial studio-wall light |
| Card surface | #15161e | Cards |
| Raised surface | #1d1e28 | Hover, inputs, popovers |
| Border | white at 8% | 1 px card and input borders |
| Text | #f2f2f5 | Primary text |
| Muted text | white at 55% | Secondary text, second heading line |
| Violet | #5b07fb (hover #4a00d6) | Primary buttons, white text on top |
| Violet text | #a58bff | Violet used as text or icons on dark |
| Citation teal | #4fe3c1 | Timestamps and citations only |

**Fonts:** Inter (400, 500, 600) for everything; Noto Sans Devanagari for Hindi, with taller line height (1.7) so vowel marks never clip.

**Type:** huge display headings with tight letter-spacing (up to 168 px on desktop), H1 36-64 px, H2 24 px, body 16 px.

**Buttons:** rounded pills, 36 px tall; violet for the main action, dark ghost pills for the rest, teal pills for every timestamp.

**Cards:** 18 px corners, 1 px border, lift 2 px on hover.

**Motion:** one easing curve everywhere (fast start, soft stop); elements rise 18 px into place on entry, staggered 80 ms. With "reduce motion" turned on, everything becomes quick fades.

**Fixed rules:** no Raj Shamani photos, logos or show branding (exception: a YouTube thumbnail may be shown only as the poster of a playable video player (reference player, inline chip player, mini player before play), because the YouTube embed shows the same image once loaded; never use thumbnails as guest photos, source-card avatars, logos, backgrounds or decoration); the product is named Cuepoint (domain cuepoint.in) and the wordmark is only lowercase "cuepoint"; every page carries "Unofficial project, not affiliated with Figuring Out. Every answer links to its source."; every claim shows a timestamp.

**Logo:** lowercase "cuepoint" in Inter semibold; the i has no dot, instead a small teal downward cue marker sits above its stem, the way an editor marks the start of a clip. The app icon is a violet rounded square with a white playhead line, the teal cue marker on top and faint waveform bars either side; it sits next to the wordmark in the top bar and above the login heading.

## Page 1A — Home (public)

The public home page opens on the cloth hero and then tells, in four scroll sections, how Cuepoint was built and checked; only the tool itself sits behind the login. It stays hidden from search engines and shows no transcripts or clips.

| Section | Content | Animation |
| --- | --- | --- |
| Hero | Cloth printed "cuepoint"; "500 episodes." / "One search."; violet "Log in" pill; small scroll hint | Cloth hangs and sways; heading rises in |
| How it was built | One line of 6 stages, each with its real number | Stages light up one by one as you scroll; numbers count up |
| How we checked accuracy | 96% on 209 hand-reviewed items, then one bar per item type | Counter rolls up to 96%; bars grow left to right |
| What's inside | Insights, clips, guests, opportunity categories, host questions | Number tiles count up when they enter the screen |
| Insights preview | Patterns explorer: tabs (Title style, Topic, Guest type), a clickable bar chart of average views vs typical, and a line chart of the selected bar by year (2022-2026) with episode count and range; then 1 sample question with its cited answer | Bars grow up on entry and on tab change; clicking a bar turns it teal and redraws the line left to right; the answer types out sentence by sentence with its timestamp chip |
| Footer | Unofficial line, "Log in" again | None |

**Pipeline stages and numbers (from the build logs)**

1. Episodes: 500 listed, 499 transcribed (1 age-restricted episode skipped).
2. Transcripts: YouTube captions first, Sarvam or Groq for the few without; over 1 million timed lines.
3. Hindi: 732,026 lines turned into Roman Hinglish and translated to English.
4. Speakers: every line labelled host or guest; under 1% left unknown.
5. Extraction: 36,797 items pulled out; 36,197 (98.4%) passed the code checks for IDs, timestamps, exact quotes and numbers.
6. Search: 35,234 searchable passages, each answer in about 1-3 seconds.

**Accuracy bars (gate 2, 209 items):** takeaways, opportunities, clips and guest profiles 100%; quotes 96%; host questions 95%; disagreements 88%; host opinions 86%.

**Open:** the insights charts need the analysis step (performance score) first, so the mockup uses clearly labelled sample data. The sample answer will be one real question picked from the beta, written in the third person.

**Gemini image prompt**

```text
A long, dark, premium landing page for a research tool called "cuepoint", shown as a tall full-page website screenshot. Deep charcoal background (#101117) with soft radial light and a faint violet glow. Top: a holographic violet foil cloth hanging from two pins, printed with lowercase "cuepoint" (a teal triangle marker instead of the dot on the i) and thin podcast waveform lines; beside it a huge heading "500 episodes. One search." in Inter (second line in grey) and a violet pill button "Log in". Below: a section "How it was built" with a horizontal line of six glowing stage nodes labelled Episodes, Transcripts, Hindi, Speakers, Extraction, Search, each with a big number. Next: "How we checked accuracy" with a giant "96%" and eight thin horizontal bars in violet and teal. Next: a row of large number tiles (36,197 insights, 2,705 clips, 429 guests). Last: two minimal charts and a chat-style answer card with small teal timestamp chips. Minimal, lots of space, no people, no photos, no logos.
```

**Claude mockup:** [Cuepoint Home Mockup](https://claude.ai/artifact/44enuCwspk4pjawpqsnyzD) (version 3, 27 Oct). Adds cursor glow and cloth ripple, pull-the-cloth-off to reach login, the Cuepoint logo, and the patterns explorer. It includes the new login (first name + password "demo"): clicking Log in drops the cloth, then the login form appears, then a placeholder Ask page greets you by name. Version 4 adds a teal "pull the cloth off to log in" hint pill with a tugging hand icon. Status: approved 27 Oct.

## Page 1B — Login

Login asks for a first name and the shared password; the first name is saved with each question and error report so beta numbers show who used Cuepoint. The cloth hero moved to the public home page (Page 1A); the decisions below were made for the first login mockup and carry over where they still apply.

| Element | Decision |
| --- | --- |
| Theme | Dark studio wall, faint violet glow behind the cloth |
| Heading | "500 episodes." (white) over "One search." (55% white), display size |
| Cloth print | Violet holographic gradient, podcast waveform lines, "RSGPT" wordmark, "500 EPISODES · EVERY ANSWER CITED" |
| Form | Password pill field + violet Enter pill; nothing else |
| Top bar | "RSGPT" top-left only |
| Footer | Unofficial line at the bottom of the screen |
| Grab hint | None; the cursor turns into a hand over the cloth |
| Wrong password | Field shakes 6 px twice, short red-tinted message below it |
| Right password | Both pins release, the cloth falls off the bottom of the screen (about 0.9 s), then the Ask page rises in |
| Phone | Cloth fills the top 55%, heading and password below it, full width |
| Reduce motion | No wind; on success a 0.2 s fade instead of the fall |

**Changes from 27 Oct review:** add a "First name" pill field above the password; one shared password for everyone; store only the first name (no email, no phone); rename the wordmark and cloth print to Cuepoint.

**Gemini image prompt**

```text
A dark, premium website login screen, 16:9, for a private research tool called RSGPT. Deep charcoal studio-wall background (#101117) lit by a soft radial light, with a faint violet glow. On the left half, a square holographic foil cloth hangs from two pins at its top corners, softly creased and slightly rotated clockwise, its surface shifting between violet, pink and blue highlights; printed on it: the word "RSGPT" in large white bold sans-serif, thin white podcast waveform lines across the middle, and small spaced letters "500 EPISODES · EVERY ANSWER CITED". A soft dark shadow falls below the cloth. On the right, a huge two-line heading in Inter: "500 episodes." in white and "One search." in 55% grey. Under it, a rounded pill-shaped password field and a violet (#5b07fb) pill button labelled "Enter". "RSGPT" small in the top-left corner. Tiny grey footer text: "Unofficial project, not affiliated with Figuring Out." Minimal, no people, no photos, no logos. Clean UI design render.
```

**Claude mockup:** [RSGPT Login Mockup](https://claude.ai/artifact/9M3RD8pDT26juYwJaMw83F) (version 1, 27 Oct). Grab the cloth, try a wrong password, then type "demo" to see the drop into the Ask page. Status: superseded by the home page mockup, whose login view was approved 27 Oct.

## Page 2 — Ask

Ask is a chat thread: the first question becomes the big heading at the top, follow-up questions stack underneath, and every answer arrives with its own reference video and timestamp chips.

| Element | Decision |
| --- | --- |
| Empty state | Big heading "Ask anything from 500 episodes", large pill question box, 4 example chips (English, Hinglish, Hindi) |
| Thread | First question shown as the page heading; each follow-up shown as a smaller question line above its answer; follow-up box stays docked at the bottom |
| Thinking | Pulsing violet waveform with live steps: "Searching 500 episodes", "Found 12 moments in 7 episodes", "Writing the answer" |
| Answer | Short third-person sentences, each ending in a teal timestamp chip (guest · date · time) |
| Reference video | A player card at the top of every answer with the best-matching moment: guest, episode, start time, play, Open on YouTube, Save |
| Chip click | The clip opens inline right under that sentence, with Open on YouTube and Save |
| Under each answer | Source episode cards (3-5), 2-3 follow-up suggestion chips, Copy answer, Report an error |
| Not in archive | "I couldn't find this in the episodes." plus 3 suggested questions that are covered |
| Language | Answers in the language asked: English, Hindi or Hinglish |
| Phone | Same thread, full width; player cards 16:9 full width; follow-up box docked above the bottom tab bar |
| Exact line search | "Find a line" mode: a toggle pill inside the question box (and automatic when the text is in quotes) fuzzy-matches it line by line against the transcript (pg\_trgm on text\_roman and text\_original). A strong match jumps the reference video to that exact second, shows a teal "Exact line found · 90% match" label (violet "Closest line" for weaker matches) and the transcript around it with the line highlighted; tapping any transcript line restarts the clip there. No good match shows "I couldn't find that line in the episodes." |

**Gemini image prompt**

```text
A dark, premium web app screen for "cuepoint", a research tool over 500 podcast episodes, 16:9. Deep charcoal background (#101117), Inter font, violet (#5b07fb) accents, teal (#4fe3c1) used only for timestamps. Sticky top bar: small violet app icon and lowercase "cuepoint" wordmark, links Ask (active, violet underline), Guests, Prep brief, Clips, Saved, Insights, and "Hi Arjun". Main column: a big heading question "What have founders said about raising their first round?". Below it an answer card: a 16:9 dark video player card labelled "Guest A · Mar 2025 · starts 41:12" with a round play button, then three short answer sentences each ending in a small teal pill chip like "▶ Guest A · 41:12". Under the answer: a row of three small source episode cards, three follow-up question chips, and small "Copy" and "Report an error" links. Then a smaller follow-up question line and a pulsing violet waveform with the text "Searching 500 episodes". At the bottom, a docked rounded pill input "Ask a follow-up" with a violet arrow button. Minimal, no photos of people, no logos.
```

**Claude mockup:** [Cuepoint Ask Mockup](https://claude.ai/artifact/1pSHNkZ2UjTGYkLNcSBraJ) (version 2, 27 Oct, adds Find a line). Opens with one answered question; try a timestamp chip, a follow-up, a Hinglish question, and "What is the capital of Australia?" for the not-found state. Status: approved 27 Oct; exact line search added to the spec (build in Ticket 21).

## Page 3 — Guest directory

The guest directory is a searchable card grid of all 429 guests, with real photos where a freely licensed one exists and initials otherwise. A guest is one unique guest\_key: a repeat guest has one guests row per episode (456 rows in all), merged under one guest\_key on the directory and profile.

| Element | Decision |
| --- | --- |
| Layout | Card grid: 4 per row on desktop, 2 on tablet, 1 on phone |
| Card | Photo (or initials), name, organisation, 2 sector tags, episode date |
| Photos | Wikimedia Commons only, via its official API; only CC0, public domain, CC BY or CC BY-SA images; photographer and licence stored and credited on the profile; never YouTube thumbnails, news photos, or any image showing the host or show branding |
| No photo | Initials on a gradient generated from the name |
| Hover / tap | Card expands to show the top takeaway with a timestamp chip, plus stats: views, episode length, clips |
| Search | One box for name or organisation |
| Filters | Sector chips, year, language (English, Hindi, Hinglish) |
| Sort | Most viewed, newest, A to Z |
| Click | Opens the guest profile (Page 4) |
| Empty result | "No guests match these filters" with a Clear filters button |

**Data step needed:** add guests.photo\_url, photo\_credit, photo\_license and photo\_source columns, and a script that looks up each guest's Wikipedia page image on Commons and keeps it only when the licence is on the allowed list (build before Ticket 20).

**Claude mockup:** [Cuepoint Guests Mockup](https://claude.ai/artifact/Ue3AjpYC3emDUtDPsKk7fo) (version 1, 27 Oct). Portrait shapes with a licence badge mark where a Commons photo appears; other cards show initials. Hover a card (tap on phones) to see its takeaway and stats. Status: approved 27 Oct. Live site: real data for all 429 guests; Commons photos on cards and profiles (copies kept in Supabase storage, credit line on the profile), initials where none exists.

## Page 4 — Guest profile

A guest profile opens with the photo on the left and who they are on the right, then tabs for everything they said, with a sticky player that keeps playing while you browse.

| Element | Decision |
| --- | --- |
| Header | Photo (or initials) left; name, organisation, role "as of \<episode date>", sector tags, 2-3 line bio, link pills (LinkedIn search, YouTube channel, From Wikipedia) right, and any pill whose link\_source = 'auto' has a small muted "Matched automatically" label next to it (CLAUDE.md rule 3); photo credit under the photo |
| Episode strip | Episode title, date, length, views, "Play episode" |
| Tabs | Takeaways, Opportunities (grouped by category), Quotes, Disagreements (host vs guest side by side), Clips |
| Items | Every item ends in a teal timestamp chip; "Report an error" on hover (always visible on phones) |
| Player | Sticky mini player: right column on desktop, docked bar at the bottom on phones; shows the item it is playing; close button |
| Ask about this guest | Question box that searches only this guest's episodes |
| Other episodes | Shown when the guest appeared more than once |
| Similar guests | 4 cards from the same sector, same style as the directory |
| Empty sections | Hidden rather than shown empty |

**Claude mockup:** [Cuepoint Profile Mockup](https://claude.ai/artifact/WSxz7qBmmTyqU3TVb5y1ks) (version 1, 27 Oct). Click any timestamp: desktop plays it in the right-hand player, phones in a docked bar at the bottom; the playing item is outlined in teal. Status: approved 27 Oct.

## Page 5 — Prep brief

The prep brief turns an upcoming guest's name and one line about them into a one-page research memo built only from past episodes, which the team can edit, copy, download and keep.

| Element | Decision |
| --- | --- |
| Input | Guest name + one-line description (e.g. "Nikhil Kamath, Zerodha co-founder"), or a sector chip; Build brief button |
| Building | Same waveform with steps: "Finding similar guests", "Collecting past questions", "Writing the brief" |
| Layout | One-page document: title, date, who it is for, then numbered sections |
| 1. Similar past guests | Linked profiles, each with one line on why they are similar |
| 2. What the host asked them | Real past questions with teal timestamp chips |
| 3. Topics already covered | Tag list with how many episodes covered each, so the team avoids repeats |
| 4. Suggested new questions | Labelled "Suggestion"; never presented as facts |
| 5. Points to verify | Facts that depend on things outside the archive, to check before recording |
| Editing | Every item can be removed (strike + undo) or edited inline before sharing |
| Actions | Copy as text, Download PDF, Download Word, Save to past briefs |
| Past briefs | List of saved briefs with date and guest; reopen any |
| Phone | Form on top, brief below, same actions in a sticky bar |

**Claude mockup:** [Cuepoint Prep Brief Mockup](https://claude.ai/artifact/8tp9FsWhenNxdDCgGYBFob) (version 1, 27 Oct). Opens on a sample brief; tap any line to edit it, × to remove (↺ to undo), or build a new one from a sector chip. Status: approved 27 Oct.

## Page 6 — Clip finder

The clip finder shows the 2,705 verified clips as vertical reel cards, so editors see what a reel would look like, and plays each one with its transcript highlighted line by line.

| Element | Decision |
| --- | --- |
| Layout | Vertical 9:16 reel cards, 4 per row (2 on phones): opening line as the big caption, guest, length badge, mood tag |
| Search | Keyword or idea ("failure", "first salary", "AI jobs") using the same search as Ask |
| Filters | Topic, guest, length (under 45 s / 45-90 s), year, language, mood (Funny, Emotional, Controversial, Advice) |
| Sort | Best clip score, newest, most viewed episode |
| Repeat guests | Picking a guest who appeared more than once groups their clips by episode ("3 episodes · 14 clips"); each card also shows "More from this guest" |
| Playing | Opens a player panel: the clip plays from start to end, the transcript scrolls with the spoken line highlighted, and it stops at the end time |
| Actions | Save (watch later), Copy timestamp link, Download clip details (.txt), Export clip (team version note) |
| Phone | 2-column reel grid; tapping opens the player full screen |

**Data step needed:** a mood tag for each clip (Funny, Emotional, Controversial, Advice) from one cheap Haiku batch over the clip text, about 2,705 short requests (well under $1).

**Claude mockup:** [Cuepoint Clips Mockup](https://claude.ai/artifact/JWW845bk62du4AV87Ni7ZM) (version 1, 27 Oct). Tap a reel to open the player with the live transcript (sped up 4x in the mockup); pick "Kabir Singh" in the guest filter to see clips grouped by episode. Status: approved 27 Oct.

## Page 7 — Saved

Saved holds everything a person kept, in three tabs, organised into folders with a personal note on each item; it belongs to that browser and is labelled with their first name.

| Element | Decision |
| --- | --- |
| Tabs | Clips, Answers, Prep briefs, each with a count |
| Folders | Sidebar of folders ("All saved" plus their own, e.g. "Reel ideas"); New folder; move items by picking a folder on the item |
| Clip items | Small reel thumbnail, opening line, guest, length; Play opens the clip player; note; folder; Remove |
| Answer items | The question, first sentence of the answer, number of sources; Open goes back to the thread |
| Brief items | Guest name, date, number of sections; Open goes to the brief |
| Note | "Add a note" on every item, e.g. "use for Monday reel"; saved as you type |
| Export | Export all as CSV: every saved clip's episode, guest, start-end, link and note |
| Ownership | Stored per browser with the visitor\_id cookie and their first name: "Arjun's saved items · on this browser" |
| Empty state | Short line and buttons to Clips and Ask |
| Remove | Item collapses away with an Undo toast |

**Data step:** the saved\_clips table from Ticket 23b becomes saved\_items (kind: clip, answer or brief; item id; folder; note; visitor\_id; first\_name; created\_at).

**Claude mockup:** [Cuepoint Saved Mockup](https://claude.ai/artifact/36bngptyoDPt81i3kZCiei) (version 1, 27 Oct). Try a folder, type a note, move an item to another folder, and Remove then Undo. Status: approved 27 Oct.

## Page 8 — Insights

Insights is a story-scroll report of eight findings about what goes with higher views; every chart can be filtered and clicked through to the episodes behind it, and the page says plainly that these are patterns, not proof.

| Section | Chart | Click shows |
| --- | --- | --- |
| 1. Title style | Bars: median score with a 25-75% range whisker | Episodes with that title style |
| 2. Topics | Same bars | Episodes on that topic |
| 3. Guest types | Same bars; first-time vs repeat guests | Episodes with that guest type |
| 4. Host's interview style | Scatter: challenge questions per hour vs score, with a median line | Episodes in that range |
| 5. Length and language | Two bar sets: duration bands; English, Hindi, Hinglish | Episodes in that band or language |
| 6. Publish time | Heatmap: day of week × time of day (IST) | Episodes in that slot |
| 7. Engagement | Bars: comments per 1,000 views by topic | Episodes on that topic |
| 8. Topic fatigue | Two bars: topic repeated within 4 weeks vs fresh topic | Those episodes |

**Fair score:** each episode's views divided by the typical views of channel episodes of the same age; 1.0× = typical.

**Rules:** every group shows its episode count; groups under 20 episodes are hidden; ranges, not single numbers; a "Patterns, not proof" banner at the top.

**Filters (sticky, apply to every chart):** year range, language, guest type.

**Each section:** one headline sentence written from the current numbers, the chart, a short note on sample size.

**Drill-down:** a side panel listing the episodes behind the bar, point or cell, sorted by score, each with views, date and a link to the guest profile.

**Data step:** compute the fair score and features (title style, publish slot, challenge questions per hour, topic repeats, likes and comments per view) in one analysis script before Ticket 19.

**Claude mockup:** [Cuepoint Insights Mockup](https://claude.ai/artifact/N1hKdbk6S8mRpWt6qUNckx) (version 1, 27 Oct). Built on 499 generated sample episodes, so filters really recompute every chart and headline; hover for a tooltip, click any bar, dot column or heatmap cell for its episodes, or "Show as a table". Chart colours checked with the palette validator on the dark surface. Status: approved 27 Oct.

## Page 9 — Future updates

Future updates is a slide deck inside the site: one slide per feature that could be built for the team, each with the problem, a flow diagram, who uses it and the time to build.

| # | Feature | Problem it solves | Who uses it | Time to build |
| --- | --- | --- | --- | --- |
| 1 | Add any podcast or raw footage | Cuepoint only covers 500 YouTube episodes | Whole team | 3-4 weeks |
| 2 | Deep guest research (Claude API) | Guest research takes hours and misses angles | Research | 2-3 weeks |
| 3 | Context guard | Clips reposted by others without their context | Leadership, legal, social | 5-6 weeks |
| 4 | Live recording copilot | Good follow-ups get thought of after the shoot | Host, producers | 4 weeks |
| 5 | Repurpose studio | Writing hooks, captions and titles for every clip | Social, editing | 2 weeks |
| 6 | Fact-check before publish | Wrong names or numbers go live | Research, editing | 3 weeks |
| 7 | Guest ideas from gaps | Choosing next guests without a map of what's covered | Research, leadership | 2 weeks |
| 8 | Audience comment insights | Thousands of comments nobody can read | Content, leadership | 2 weeks |
| 9 | Regional language subtitles | Hindi and English miss most of India | Social, growth | 3 weeks |
| 10 | Sponsor match + brand safety | Matching brands to episodes by hand | Partnerships | 3 weeks |

**Context guard wording:** described as "clips posted without their context"; the slide links the verified archive moment where the host talks about this, found with Find a line, instead of quoting him from memory.

**Deck:** intro slide, 10 feature slides, closing slide ("Built on your raw files, with your team" plus the take-down and rebuild offer). Arrow keys, swipe, dot navigation, slide counter, one-line infographic per slide.

**Claude mockup:** [Cuepoint Future Updates](https://claude.ai/artifact/8jUjRA1kkNczXxgMVKEHjs) (version 1, 27 Oct). 12 slides: intro with all 10 features as tiles, one slide per feature, closing offer. Arrow keys, swipe, dots; "Future" added to the top bar. Status: approved 27 Oct.

## Global components

**Mockup:** [Cuepoint Global Components](https://claude.ai/artifact/VifZkujzY9Sh7yVsSuyzTE) (approved). Shared pieces used on every page after login.

**Decisions**

- Top bar: logo, page links (Ask, Guests, Prep brief, Clips, Saved, Insights, Future, in that order), quick search box, first-name avatar ("Hi Arjun").
- Mini player: a clip keeps playing when you leave its page.
- Report an error: small popup with reasons and an optional note.
- Shared states: loading skeletons, empty states, error state, toasts.
- No full footer: every page (public home, login and every page after login) ends with one slim, muted line, "Unofficial project, not affiliated with Figuring Out. Every answer links to its source." No separate phone tab bar for now (not picked).

**Top bar**

- Sticky, 60px, blurred dark background, active link underlined in violet.
- Quick search opens a command palette: click the box, Ctrl K / ⌘K, or "/". Results grouped as Ask, Pages, Guests, Episodes and clips. The first row is always "Ask Cuepoint: \<query>", which sends the text to Ask. Arrow keys move, Enter opens, Esc closes.
- Under 820px: all seven links fold into a menu button (drop-down list), search becomes an icon, the name label hides and only the avatar shows.

**Mini player**

- One global player state (clip, position, playing). The big player lives on the clip's source page; on any other page the clip continues in a floating mini player (bottom-right, 360px; full width at the bottom on phones).
- Shows thumbnail play/pause, title, teal timestamp, episode, progress bar (click to seek), close, and "Back to source", which returns to the big player at the same position.
- Real site: one youtube-nocookie iframe moved between the two slots (not reloaded), so playback is not interrupted.

**Report an error**

- Opens from the flag button on any answer, clip or brief. Shows the episode, title and timestamp.
- Reasons: Wrong timestamp, Wrong speaker, Wrong fact or quote, Transcript error, Something else. Optional note, up to 280 characters.
- Send stays disabled until a reason is picked. After sending: toast "Reported. Thanks, it goes to the review queue." and the button changes to "Reported". The item stays visible until it is checked.
- Data: a reports table (item type, item id, episode, timestamp, reason, note, first name, created at, status).
- Phone: the popup becomes a bottom sheet.

**Toasts**

- Bottom centre, at most 3 at once, about 3 seconds each (5 with Undo); hovering pauses them. They move up when the mini player is open.
- Used for: saved / removed (with Undo), link copied, download started, reported, clip ended, undone.

**Loading, empty and error states**

- Loading: skeleton shapes that match each page's layout (player, list rows, cards, stat tiles, brief lines), with a shimmer that is off under reduced motion.
- Empty, one per page with a next step: Ask (ask your first question), Guests (no guests match, clear filters), Prep (pick a guest), Clips (no clips match, reset filters), Saved (nothing saved yet, browse clips), Insights (no episodes in this range, show all years).
- Error: "Couldn't reach the archive" with a Try again button; saved items are never lost.
- The mockup's controls strip (Normal / Loading / Empty / Error) is for review only and is not part of the real site.

## Decision log

| Date | Decision |
| --- | --- |
| 27 Oct 2026 | Frontend designed page by page in this document before any code |
| 26 Oct 2026 | Base style: holographic cloth hero, Inter, pill buttons, violet accent, dark studio wall |
| 26 Oct 2026 | Cloth texture is generated by the page (RSGPT wordmark); no outside images |
| 25 Oct 2026 | No video download; clip details file plus "Export clip (team version)" note instead |
| 27 Oct 2026 | Product renamed Recall; public home page with build story; login = first name + one shared password |
| 27 Oct 2026 | Renamed Cuepoint (cuepoint.in); new logo with teal cue marker; cursor gestures; pull the cloth off to log in; clickable patterns explorer |

**Open questions**

- Resolved 27 Oct: dark studio wall for the whole site.
- Resolved 27 Oct: both per page (Gemini image for the look, Claude working mockup for the build).
