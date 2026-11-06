"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { IconScope, IconX } from "@/components/Icons";
import {
  SCOPE_LANGS, episodeCount, facetCounts, matchEpisodes, scopeIsEmpty, scopeLabel,
  type AskScope, type ScopeFacet, type ScopeIndex,
} from "@/lib/ask/scope-types";

/** Ask within a scope (28d): the four chips under the empty Ask box, the one "Scope" button in the dock, and the sheet
    both open. Choices apply at once; every choice shows how many episodes the scope would then cover, and a choice that
    would leave none is disabled. */

const FACETS: { key: ScopeFacet; title: string }[] = [
  { key: "guest", title: "Guest" },
  { key: "topic", title: "Topic" },
  { key: "year", title: "Year" },
  { key: "lang", title: "Language" },
];

/** The chosen value of one chip, as shown, or null for "Any". */
function valueOf(ix: ScopeIndex, s: AskScope, f: ScopeFacet): string | null {
  if (f === "guest") return s.guest ? ix.guests.find((g) => g.slug === s.guest)?.name ?? s.guest : null;
  if (f === "topic") return s.topic ? ix.topics.find((t) => t.key === s.topic)?.label ?? s.topic : null;
  if (f === "year") return s.year ? String(s.year) : null;
  return s.lang ? SCOPE_LANGS[s.lang] : null;
}

const activeCount = (s: AskScope) => [s.guest, s.topic, s.year, s.lang].filter(Boolean).length;

/** Under the empty Ask box: Guest · Topic · Year · Language, each opening the sheet at its own section. */
export function ScopeChips({ ix, scope, onOpen }: { ix: ScopeIndex; scope: AskScope; onOpen: (focus: ScopeFacet) => void }) {
  const n = useMemo(() => matchEpisodes(ix, scope).length, [ix, scope]);
  return (
    <div className="scopechips" role="group" aria-label="Search only some episodes">
      {FACETS.map((f) => {
        const v = valueOf(ix, scope, f.key);
        return (
          <button key={f.key} type="button" className={`chip scopechip${v ? " on" : ""}`} aria-haspopup="dialog" onClick={() => onOpen(f.key)}>
            <span className="scopechip__k">{f.title}:</span> {v ?? "Any"}
          </button>
        );
      })}
      <span className="scopechips__n" aria-live="polite">{scopeIsEmpty(scope) ? `All ${ix.episodes.length} episodes` : episodeCount(n)}</span>
    </div>
  );
}

/** The one compact "Scope" button in the dock (inside the box on wide screens, beside the length pill on narrow ones). */
export function ScopeButton({ ix, scope, where, onOpen }: { ix: ScopeIndex; scope: AskScope; where: "in" | "above"; onOpen: () => void }) {
  const n = activeCount(scope);
  return (
    <button
      type="button"
      className={`scopebtn scopebtn--${where}${n ? " on" : ""}`}
      aria-haspopup="dialog"
      aria-label={n ? `Scope: ${scopeLabel(ix, scope)}` : "Scope: all episodes"}
      title={n ? scopeLabel(ix, scope) : "Search only some episodes"}
      onClick={onOpen}
    >
      <IconScope /><span>Scope</span>{n > 0 && <b className="scopebtn__n" aria-hidden="true">{n}</b>}
    </button>
  );
}

/** The sheet: one section per chip. A bottom sheet on phones (dialog.sheet). */
export function ScopeDialog({ ix, scope, onChange, open, focus, onClose }: {
  ix: ScopeIndex; scope: AskScope; onChange: (s: AskScope) => void; open: boolean; focus?: ScopeFacet; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [term, setTerm] = useState("");

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // Start at the chip that was pressed: its chosen option, or its first one.
      window.requestAnimationFrame(() => {
        const sec = d.querySelector<HTMLElement>(`[data-facet="${focus ?? "guest"}"]`);
        sec?.scrollIntoView({ block: "nearest" });
        (sec?.querySelector<HTMLElement>("input:checked") ?? sec?.querySelector<HTMLElement>("input"))?.focus();
      });
    } else if (!open && d.open) d.close();
  }, [open, focus]);

  const counts = useMemo(() => facetCounts(ix, scope), [ix, scope]);
  const total = useMemo(() => matchEpisodes(ix, scope).length, [ix, scope]);

  const set = (patch: Partial<AskScope>) => {
    const next: AskScope = { ...scope, ...patch };
    for (const k of Object.keys(next) as (keyof AskScope)[]) if (next[k] === undefined) delete next[k];
    onChange(next);
  };

  // Guests that still have episodes with the other chips, filtered by the search box; the chosen one always shows.
  const q = term.trim().toLowerCase();
  const guestRows = ix.guests
    .map((g, i) => ({ g, n: counts.guest.get(i) ?? 0 }))
    .filter((r) => (r.n > 0 || r.g.slug === scope.guest) && (!q || r.g.name.toLowerCase().includes(q)));
  const shown = guestRows.slice(0, 60);
  const chosen = guestRows.find((r) => r.g.slug === scope.guest);
  if (chosen && !shown.includes(chosen)) shown.unshift(chosen);

  const option = (facet: ScopeFacet, value: string, label: string, n: number | null, checked: boolean, pick: () => void, row = false) => (
    <label key={value || "any"} className={`sc-opt${row ? " sc-opt--row" : ""}`}>
      <input type="radio" name={`scope-${facet}`} value={value} checked={checked} disabled={n === 0 && !checked} onChange={pick} />
      <span>{label}</span>
      {n != null && <small className="num">{n}</small>}
    </label>
  );

  return (
    <dialog
      ref={ref}
      className="sheet scope-sheet"
      aria-labelledby="scope-title"
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}
    >
      <div className="dh">
        <div>
          <h2 id="scope-title">Scope</h2>
          <p>Search only some episodes. Topics are the guests&apos; sectors; the language is the episode&apos;s.</p>
        </div>
        <button className="ib" type="button" onClick={() => ref.current?.close()} aria-label="Close"><IconX /></button>
      </div>
      <div className="sc-body">
        <fieldset className="sc-sec" data-facet="guest">
          <legend>Guest</legend>
          <label htmlFor="scope-guest-q" className="sr">Find a guest</label>
          <input id="scope-guest-q" className="sc-search" type="search" placeholder="Find a guest" value={term} onChange={(e) => setTerm(e.target.value)} autoComplete="off" />
          <div className="sc-guests">
            {option("guest", "", "Any guest", null, !scope.guest, () => set({ guest: undefined }), true)}
            {shown.map((r) => option("guest", r.g.slug, r.g.name, r.n, scope.guest === r.g.slug, () => set({ guest: r.g.slug }), true))}
            {!shown.length && <p className="sc-none">No guest by that name with these filters.</p>}
          </div>
        </fieldset>
        <fieldset className="sc-sec" data-facet="topic">
          <legend>Topic</legend>
          <div className="sc-opts">
            {option("topic", "", "Any topic", null, !scope.topic, () => set({ topic: undefined }))}
            {ix.topics.map((t, i) => option("topic", t.key, t.label, counts.topic.get(i) ?? 0, scope.topic === t.key, () => set({ topic: t.key })))}
          </div>
        </fieldset>
        <fieldset className="sc-sec" data-facet="year">
          <legend>Year</legend>
          <div className="sc-opts">
            {option("year", "", "Any year", null, !scope.year, () => set({ year: undefined }))}
            {ix.years.map((y) => option("year", String(y), String(y), counts.year.get(y) ?? 0, scope.year === y, () => set({ year: y })))}
          </div>
        </fieldset>
        <fieldset className="sc-sec" data-facet="lang">
          <legend>Language</legend>
          <div className="sc-opts">
            {option("lang", "", "Any language", null, !scope.lang, () => set({ lang: undefined }))}
            {(Object.keys(SCOPE_LANGS) as (keyof typeof SCOPE_LANGS)[]).map((l) =>
              option("lang", l, SCOPE_LANGS[l], counts.lang.get(l) ?? 0, scope.lang === l, () => set({ lang: l })))}
          </div>
        </fieldset>
      </div>
      <div className="df">
        <span className="note" aria-live="polite">{scopeIsEmpty(scope) ? `All ${ix.episodes.length} episodes` : `${episodeCount(total)}: ${scopeLabel(ix, scope)}`}</span>
        <button className="pill pill--ghost" type="button" onClick={() => onChange({})} disabled={scopeIsEmpty(scope)}>Clear all</button>
        <button className="pill pill--primary pill--sm" type="button" onClick={() => ref.current?.close()}>Done</button>
      </div>
    </dialog>
  );
}
